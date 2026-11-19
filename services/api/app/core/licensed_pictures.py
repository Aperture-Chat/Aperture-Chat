"""Freely licensed photos for documents, found on Wikimedia Commons.

A paper "with pictures of X's life" needs real photos the firm may reuse.
Commons hosts only freely licensed media and its search API returns each
file's license and author with the result, so one request finds candidates
and the facts needed to credit them. Each picture is downloaded here and
re-encoded as a bounded JPEG data URL: drafts keep only inline JPEG/PNG
pictures, and a browser cannot read most image hosts' bytes itself.
"""

from __future__ import annotations

import base64
import html
import io
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx
from PIL import Image, UnidentifiedImageError

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
# Wikimedia asks automated clients to identify themselves; this names the
# product only, never a person or the firm.
USER_AGENT = "Aperture-Chat/1.0 (document pictures)"
SEARCH_CANDIDATES = 12
MAX_EDGE_PX = 1024
JPEG_QUALITIES = (82, 70, 58)
MAX_PICTURE_BYTES = 280_000
MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024
# Far above any photo Commons scales to MAX_EDGE_PX, far below a decompression bomb.
MAX_SOURCE_PIXELS = 40_000_000
TIMEOUT_SECONDS = 12.0
_RASTER_MIME = frozenset({"image/jpeg", "image/png", "image/webp", "image/tiff", "image/gif"})
# Public domain, CC0, CC BY and CC BY-SA allow reuse with credit. Commons
# should hold nothing else, but a non-commercial or no-derivatives tag, or no
# stated license at all, keeps a file out.
_FREE_LICENSE = re.compile(r"^(public domain|pd\b.*|cc0.*|cc by(-sa)?( [\d.]+.*)?)$", re.IGNORECASE)
_RESTRICTED = re.compile(r"\b(nc|nd)\b|non-?commercial|no ?deriv", re.IGNORECASE)
_TAGS = re.compile(r"<[^>]+>")
# A multilingual description opens with its language's name ("French: ...").
_LANGUAGE_LABEL = re.compile(
    r"^(?:English|French|German|Italian|Spanish|Portuguese|Dutch|Polish|Russian|Ukrainian|Czech|Swedish|"
    r"Danish|Norwegian|Finnish|Hungarian|Romanian|Greek|Turkish|Latin|Catalan|Basque|Galician|Japanese|"
    r"Chinese|Korean|Arabic|Hebrew):\s+"
)
MAX_ALT_CHARS = 120
# An artwork's title template renders its Wikidata labels after the title.
_WIKIDATA_LABELS = re.compile(r"\s(?:title|label) QS:")


class PictureSearchUnavailable(RuntimeError):
    """Commons could not be searched; nothing about the query is known."""


@dataclass(frozen=True)
class LicensedPicture:
    data_url: str
    alt: str
    license: str
    artist: str
    source_url: str

    @property
    def credit(self) -> str:
        return f"{self.artist} · {self.license} · Wikimedia Commons"


@dataclass(frozen=True)
class _Candidate:
    rank: int
    image_url: str
    alt: str
    license: str
    artist: str
    source_url: str


def find_licensed_pictures(
    query: str,
    *,
    limit: int,
    subject: str | None = None,
    transport: httpx.BaseTransport | None = None,
) -> list[LicensedPicture]:
    """Up to ``limit`` freely licensed photos for ``query``, best match first.

    A precise description ("RBG at Columbia Law School") often matches no
    file title; ``subject`` ("Ruth Bader Ginsburg") is then searched instead.
    """

    # No redirects and no proxy settings from the environment: every request
    # goes to the Wikimedia host this module named, and nowhere else.
    with httpx.Client(
        timeout=TIMEOUT_SECONDS,
        transport=transport,
        headers={"User-Agent": USER_AGENT},
        follow_redirects=False,
        trust_env=False,
    ) as client:
        for search in _searches(query, subject):
            pictures = _pictures_for(client, search, limit)
            if pictures:
                return pictures
    return []


def _searches(query: str, subject: str | None) -> list[str]:
    broader = " ".join((subject or "").split())
    return [query] if not broader or broader.lower() == query.lower() else [query, broader]


def _pictures_for(client: httpx.Client, search: str, limit: int) -> list[LicensedPicture]:
    try:
        response = client.get(COMMONS_API, params=_search_params(search))
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise PictureSearchUnavailable("Wikimedia Commons could not be searched right now.") from exc
    pictures: list[LicensedPicture] = []
    for candidate in _free_candidates(payload):
        picture = _download(client, candidate)
        if picture is not None:
            pictures.append(picture)
        if len(pictures) >= limit:
            break
    return pictures


def _search_params(query: str) -> dict[str, str]:
    return {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "generator": "search",
        "gsrsearch": f"{query} filetype:bitmap",
        "gsrnamespace": "6",
        "gsrlimit": str(SEARCH_CANDIDATES),
        "prop": "imageinfo",
        "iiprop": "url|mime|extmetadata",
        "iiurlwidth": str(MAX_EDGE_PX),
    }


def _free_candidates(payload: Any) -> list[_Candidate]:
    pages = ((payload or {}).get("query") or {}).get("pages") or []
    candidates = [candidate for page in pages if (candidate := _candidate(page)) is not None]
    return sorted(candidates, key=lambda candidate: candidate.rank)


def _candidate(page: dict[str, Any]) -> _Candidate | None:
    info = _raster_info(page)
    if info is None:
        return None
    meta = info.get("extmetadata") or {}
    license_name = _meta_text(meta, "LicenseShortName")
    image_url = info.get("thumburl") or info.get("url")
    source_url = info.get("descriptionurl")
    if not (_is_free(license_name) and _on_commons_page(source_url) and _on_wikimedia(image_url)):
        return None
    return _Candidate(
        rank=int(page.get("index") or 0),
        image_url=image_url,
        alt=_alt_text(meta, page),
        license=license_name,
        artist=_meta_text(meta, "Artist") or "Unknown author",
        source_url=source_url,
    )


def _raster_info(page: dict[str, Any]) -> dict[str, Any] | None:
    info = (page.get("imageinfo") or [None])[0]
    return info if isinstance(info, dict) and info.get("mime") in _RASTER_MIME else None


def _alt_text(meta: dict[str, Any], page: dict[str, Any]) -> str:
    title = str(page.get("title") or "").removeprefix("File:").rsplit(".", 1)[0].replace("_", " ")
    name = _WIKIDATA_LABELS.split(_meta_text(meta, "ObjectName"), maxsplit=1)[0].strip()
    return _caption_length(_LANGUAGE_LABEL.sub("", name or _meta_text(meta, "ImageDescription") or title))


def _caption_length(text: str) -> str:
    if len(text) <= MAX_ALT_CHARS:
        return text
    return text[: MAX_ALT_CHARS - 1].rsplit(" ", 1)[0].rstrip(" ,;:") + "…"


def _on_wikimedia(url: str | None) -> bool:
    """Only Wikimedia's own file hosts are downloaded from."""
    parts = urlsplit(url or "")
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and (host == "wikimedia.org" or host.endswith(".wikimedia.org"))


def _on_commons_page(url: str | None) -> bool:
    """The credit's Source link must be the file's own Commons page."""
    parts = urlsplit(url or "")
    return parts.scheme == "https" and (parts.hostname or "").lower() == "commons.wikimedia.org"


def _is_free(license_name: str) -> bool:
    return bool(license_name) and bool(_FREE_LICENSE.match(license_name)) and not _RESTRICTED.search(license_name)


def _meta_text(meta: dict[str, Any], key: str) -> str:
    value = (meta.get(key) or {}).get("value") or ""
    return " ".join(html.unescape(_TAGS.sub(" ", str(value))).split())


def _download(client: httpx.Client, candidate: _Candidate) -> LicensedPicture | None:
    raw = _bounded_body(client, candidate.image_url)
    if raw is None:
        return None
    data_url = _bounded_jpeg(raw)
    if data_url is None:
        return None
    return LicensedPicture(
        data_url=data_url,
        alt=candidate.alt,
        license=candidate.license,
        artist=candidate.artist,
        source_url=candidate.source_url,
    )


def _bounded_body(client: httpx.Client, url: str) -> bytes | None:
    """The response body, read no further than MAX_DOWNLOAD_BYTES; None for a
    redirect, an error status, or a body past the cap."""
    body = bytearray()
    try:
        with client.stream("GET", url) as response:
            if response.status_code != 200:
                return None
            for chunk in response.iter_bytes():
                body += chunk
                if len(body) > MAX_DOWNLOAD_BYTES:
                    return None
    except httpx.HTTPError:
        return None
    return bytes(body)


def _bounded_jpeg(raw: bytes) -> str | None:
    """A JPEG data URL no larger than MAX_EDGE_PX on its long side and
    MAX_PICTURE_BYTES, or None when the bytes are not a readable picture."""

    try:
        with Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > MAX_SOURCE_PIXELS:
                return None
            picture = source.convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return None
    picture.thumbnail((MAX_EDGE_PX, MAX_EDGE_PX))
    for quality in JPEG_QUALITIES:
        buffer = io.BytesIO()
        picture.save(buffer, "JPEG", quality=quality, optimize=True)
        if buffer.tell() <= MAX_PICTURE_BYTES:
            return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
    return None
