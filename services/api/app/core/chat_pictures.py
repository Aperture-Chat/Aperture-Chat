"""Finding the picture for one spot in a chat reply.

A spot (see app.core.picture_spots) gets a freely licensed photo from
Wikimedia Commons when one matches, otherwise an AI illustration from the
person's image model, otherwise an honest line saying nothing was found. The
picture is stored like a generated image, so the saved chat links to a file
Aperture serves itself rather than to an outside host.

:func:`find_picture` does the slow network work and may run off the stream's
thread; billing, audit, and signing the link stay with the caller.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote

from app.core.generated_images import GeneratedImageError, save_generated_image
from app.core.licensed_pictures import LicensedPicture, PictureSearchUnavailable, find_licensed_pictures
from app.core.model_gateway import ModelGatewayError

logger = logging.getLogger(__name__)

# Same wording the Drafts editor uses for an illustration (apps/web
# DocumentAssistantWorkspace generateSlideImageDataUrl, kind "illustration").
ILLUSTRATION_PROMPT = (
    "Generate one painterly editorial illustration, clearly an illustration and not a photograph, "
    "for a document: {description}. Show the place, objects, or period; do not depict a realistic "
    "likeness of any real person. No embedded text, no watermarks, no logos."
)


@dataclass(frozen=True)
class Photo:
    picture: LicensedPicture
    image_name: str


@dataclass(frozen=True)
class Illustration:
    image_name: str
    # The image-model call, for its usage to be billed.
    provider_payload: dict[str, Any]


@dataclass(frozen=True)
class Missing:
    # An image-model call that returned nothing usable is still billed.
    provider_payload: dict[str, Any] | None
    # False when no photo was looked for, because Web is off for the message.
    searched: bool = True


Placement = Photo | Illustration | Missing
Illustrate = Callable[[str], dict[str, Any]]
Search = Callable[[str], list[LicensedPicture]]


_CLAUSE_BREAK = re.compile(r"[,;:()]| [-–—] ")
_POSSESSIVE = re.compile(r"['’]s$", re.IGNORECASE)
_STOP_WORDS = frozenset(
    "a an the of in on at to for and with as by from during into after before his her their its".split()
)
_SHORT_QUERY_WORDS = 3


def search_queries(description: str) -> list[str]:
    """Commons matches every word of a query, so a precise description
    ("Napoleon's childhood home in Ajaccio, Corsica") often finds nothing;
    the key words of its first clause, then the first few of them, often do."""
    full = " ".join(description.split())
    words = _key_words(description)
    queries: list[str] = []
    for query in (full, " ".join(words), " ".join(words[:_SHORT_QUERY_WORDS])):
        if query and query.lower() not in (known.lower() for known in queries):
            queries.append(query)
    return queries


# Photos fetched per query, so one that names nothing asked for can be passed over.
_CANDIDATES_PER_QUERY = 3


def _folded(text: str) -> str:
    """Lowercase without accents, so "Napoléon" matches "Napoleon"."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(char for char in decomposed if not unicodedata.combining(char)).lower()


def _key_words(description: str) -> list[str]:
    clause = _CLAUSE_BREAK.split(" ".join(description.split()), maxsplit=1)[0]
    return [_POSSESSIVE.sub("", word) for word in clause.split() if word.lower() not in _STOP_WORDS]


def key_terms(description: str) -> set[str]:
    """The meaningful words of a description, folded, that a matching photo
    should mention: people, places, events, and what is happening."""
    words = re.findall(r"[^\W\d_][\w'’-]*", description)
    return {_folded(_POSSESSIVE.sub("", word)) for word in words if len(word) > 2 and word.lower() not in _STOP_WORDS}


# A word matches another form of itself ("retreating", "retreat") by its stem.
_STEM_CHARS = 5
# One shared word ("Bonaparte") also matches unrelated files about the same family.
_REQUIRED_MATCHES = 2


def _mentions(picture: LicensedPicture, terms: set[str]) -> int:
    """How many of the terms the photo's title or file name mentions."""
    said = _folded(f"{picture.alt} {unquote(picture.source_url).replace('_', ' ')}")
    return sum(1 for term in terms if re.search(_term_pattern(term), said))


def _term_pattern(term: str) -> str:
    """A long word matches its other forms by its stem; a short one ("war")
    matches only itself, never a longer word it begins ("Warsaw")."""
    if len(term) < _STEM_CHARS:
        return rf"\b{re.escape(term)}\b"
    return rf"\b{re.escape(term[:_STEM_CHARS])}"


def search_commons(description: str) -> list[LicensedPicture]:
    """The best licensed photo for a spot, from the narrowest query that
    finds one naming what the spot describes. A loose search can match an
    unrelated file; a wrong picture is worse than an illustration."""
    terms = key_terms(description)
    for query in search_queries(description):
        photos = find_licensed_pictures(query, limit=_CANDIDATES_PER_QUERY)
        named = [(_mentions(photo, terms), photo) for photo in photos]
        # Commons' own order breaks a tie.
        best = max(named, key=lambda pair: pair[0], default=(0, None))
        # A description with no meaningful words ("1815") can confirm no photo.
        if best[1] is not None and best[0] >= max(1, min(_REQUIRED_MATCHES, len(terms))):
            return [best[1]]
    return []


def find_picture(description: str, illustrate: Illustrate | None, *, search: Search | None = search_commons) -> Placement:
    """The picture for one spot: a licensed photo, else an illustration.
    Without ``search`` (Web off) no photo is looked for outside the deployment."""
    searched = search is not None
    photos: list[LicensedPicture] = []
    if search is not None:
        try:
            photos = search(description)
        except PictureSearchUnavailable:
            photos = []
    if photos:
        return Photo(photos[0], save_generated_image(photos[0].data_url))
    if illustrate is None:
        return Missing(None, searched)
    try:
        payload = illustrate(ILLUSTRATION_PROMPT.format(description=description))
    except ModelGatewayError as exc:
        logger.warning("Illustrating a chat picture of %r failed: %s", description, exc)
        return Missing(None, searched)
    data_url = _first_image(payload)
    if data_url is None:
        return Missing(payload, searched)
    try:
        return Illustration(save_generated_image(data_url), payload)
    except GeneratedImageError:
        return Missing(payload, searched)


def _first_image(payload: dict[str, Any]) -> str | None:
    message = ((payload.get("choices") or [{}])[0] or {}).get("message") or {}
    return next((url for image in message.get("images") or [] if (url := _image_url(image))), None)


def _image_url(image: object) -> str:
    return str((image.get("image_url") or {}).get("url") or "") if isinstance(image, dict) else ""


_MARKDOWN_SPECIAL = re.compile(r"([\\`*_\[\]<>])")


def _plain(text: str) -> str:
    """Text that stays text inside Markdown (no links, emphasis, or HTML)."""
    return _MARKDOWN_SPECIAL.sub(r"\\\1", " ".join(text.split()))


def _link_target(url: str) -> str:
    """A URL that cannot end the Markdown link early."""
    return url.replace(" ", "%20").replace("(", "%28").replace(")", "%29")


def _sentence(text: str) -> str:
    return text if text.endswith((".", "!", "?")) else f"{text}."


def picture_markdown(description: str, placement: Placement, image_url: str | None) -> str:
    """What the reader sees in the spot's place."""
    if isinstance(placement, Photo):
        picture = placement.picture
        alt = _plain(picture.alt)
        # Chat captions an image with its alt text, so the line under it is the credit.
        return (
            f"![{alt}]({image_url})\n\n"
            f"*Image: {_sentence(_plain(picture.credit))} [Source]({_link_target(picture.source_url)})*"
        )
    if isinstance(placement, Illustration):
        return f"![AI-generated illustration: {_plain(description)}]({image_url})"
    if not placement.searched:
        return (
            f"*No picture added for: {_sentence(_plain(description))} Freely licensed photos are "
            "looked up only when Web is on for the message.*"
        )
    return f"*No freely licensed photo or AI illustration could be found for: {_sentence(_plain(description))}*"
