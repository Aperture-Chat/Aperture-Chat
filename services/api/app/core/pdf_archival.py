"""Finish a Chromium-printed PDF as an archival PDF/A-2b file.

Chromium already embeds every font, keeps text as real Unicode-mapped text,
tags the logical structure, and writes bookmarks from the headings. What it
leaves out is what ISO 19005-2 (PDF/A-2) asks of an archive: an XMP packet
that identifies the conformance level, an output intent that pins the color
space, and annotations that print. This module adds those, plus the details
that make a long document comfortable to open: the document language, the
title shown in the viewer's window, the bookmarks panel opened by default,
and a linearized ("fast web view") file that shows page one before the rest
has downloaded.

Only part 2 level B is claimed. It depends on structure this module writes
itself, not on what a user put in the document; the stricter levels (U, A,
and PDF/UA) can fail on content such as a picture without alt text.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, Pdf
from PIL import ImageCms

PDFA_CONFORMANCE = "PDF/A-2b"
PRODUCER = "Aperture Chat"
CREATOR_TOOL = "Aperture Chat Drafts"

# Annotation flag bits (ISO 32000-1, 12.5.3).
_INVISIBLE = 1
_HIDDEN = 2
_PRINT = 4
_NO_VIEW = 32


@dataclass(frozen=True, slots=True)
class ArchivalMetadata:
    title: str
    author: str
    lang: str
    created: datetime
    # The document's headings in order, as written. Chromium drops the space
    # at each line wrap when it titles a bookmark, so a wrapped heading's
    # bookmark is matched back to its heading.
    headings: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ArchivalSummary:
    page_count: int
    bookmark_count: int
    size_bytes: int


@lru_cache(maxsize=1)
def _srgb_profile() -> bytes:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def _set_srgb_output_intent(pdf: Pdf) -> None:
    profile = pdf.make_stream(_srgb_profile())
    profile.N = 3
    pdf.Root.OutputIntents = Array(
        [
            Dictionary(
                Type=Name.OutputIntent,
                S=Name.GTS_PDFA1,
                OutputConditionIdentifier="sRGB IEC61966-2.1",
                RegistryName="http://www.color.org",
                Info="sRGB IEC61966-2.1",
                DestOutputProfile=profile,
            )
        ]
    )


def _link_description(annotation: Dictionary) -> str:
    action = annotation.get("/A")
    if isinstance(action, Dictionary) and action.get("/S") == Name.URI:
        return f"Link to {action.URI}"
    return "Link within this document"


def _make_annotations_archival(pdf: Pdf) -> None:
    """Every annotation prints and none hides (PDF/A-2, 6.3.2); links carry a
    text description a screen reader can announce."""
    for page in pdf.pages:
        for annotation in page.obj.get("/Annots", Array()):
            flags = int(annotation.get("/F", 0))
            annotation.F = (flags | _PRINT) & ~(_INVISIBLE | _HIDDEN | _NO_VIEW)
            if annotation.get("/Subtype") == Name.Link and "/Contents" not in annotation:
                annotation.Contents = _link_description(annotation)


def _compact(text: str) -> str:
    return "".join(text.split())


def restored_bookmark_titles(titles: Sequence[str], headings: Sequence[str]) -> list[str]:
    """Each title that matches the next unmatched heading, ignoring spaces,
    takes that heading's text. Both lists are in document order."""
    restored = []
    cursor = 0
    for title in titles:
        key = _compact(title)
        match = next((index for index in range(cursor, len(headings)) if _compact(headings[index]) == key), None)
        if match is None:
            restored.append(title)
            continue
        restored.append(headings[match])
        cursor = match + 1
    return restored


def _tidy_bookmarks(pdf: Pdf, headings: Sequence[str]) -> int:
    """Restores wrapped bookmark titles and returns how many bookmarks there are."""
    with pdf.open_outline() as outline:
        items = []
        pending = list(reversed(outline.root))
        while pending:
            item = pending.pop()
            items.append(item)
            pending.extend(reversed(item.children))
        for item, title in zip(items, restored_bookmark_titles([item.title for item in items], headings)):
            if item.title != title:
                item.title = title
        return len(items)


def _set_document_details(pdf: Pdf, metadata: ArchivalMetadata, bookmark_count: int) -> None:
    pdf.Root.Lang = metadata.lang
    pdf.Root.ViewerPreferences = Dictionary(DisplayDocTitle=True)
    if bookmark_count:
        pdf.Root.PageMode = Name.UseOutlines
    with pdf.open_metadata(set_pikepdf_as_editor=False) as meta:
        meta.load_from_docinfo(pdf.docinfo)
        meta["dc:title"] = metadata.title
        meta["dc:creator"] = [metadata.author]
        meta["xmp:CreateDate"] = metadata.created.isoformat()
        meta["xmp:CreatorTool"] = CREATOR_TOOL
        meta["pdf:Producer"] = PRODUCER
        meta["pdfaid:part"] = "2"
        meta["pdfaid:conformance"] = "B"


def finish_archival_pdf(source: Path, destination: Path, metadata: ArchivalMetadata) -> ArchivalSummary:
    """Write `source` to `destination` as PDF/A-2b and describe the result.

    Runs in memory proportional to the document's object count (about 0.7 GB
    for a 6,700-page tagged document), not to its rendered size.
    """
    with pikepdf.open(source) as pdf:
        _set_srgb_output_intent(pdf)
        _make_annotations_archival(pdf)
        bookmark_count = _tidy_bookmarks(pdf, metadata.headings)
        _set_document_details(pdf, metadata, bookmark_count)
        page_count = len(pdf.pages)
        pdf.save(
            destination,
            linearize=True,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
        )
    return ArchivalSummary(
        page_count=page_count,
        bookmark_count=bookmark_count,
        size_bytes=destination.stat().st_size,
    )
