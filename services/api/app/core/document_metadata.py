"""Read the properties a file carries about itself, beyond its body text.

Vector indexing keeps only passages of text, so a file's own record -- who wrote
it, when, its title and keywords, custom properties a document system stamped on
it (matter numbers, ethical walls), and sensitivity labels -- would otherwise be
lost. Each reader returns display-ready ``(label, value)`` pairs; callers pass
them through ``bounded_metadata`` so stored metadata stays small and clean.
Image location (GPS) data is deliberately not kept.
"""

from __future__ import annotations

import re
import unicodedata
import zipfile
from collections.abc import Iterable, Mapping
from datetime import date, datetime
from io import BytesIO
from typing import Any, BinaryIO

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

MAX_METADATA_FIELDS = 64
MAX_METADATA_KEY_CHARS = 80
MAX_METADATA_VALUE_CHARS = 500
MAX_SUMMARY_CHARS = 320

Source = bytes | BinaryIO
Pairs = list[tuple[str, Any]]

_OFFICE_CORE_LABELS = {
    "title": "Title",
    "subject": "Subject",
    "creator": "Author",
    "keywords": "Keywords",
    "description": "Description",
    "lastModifiedBy": "Last modified by",
    "revision": "Revision",
    "created": "Created",
    "modified": "Modified",
    "category": "Category",
    "contentStatus": "Status",
    "language": "Language",
    "identifier": "Identifier",
    "version": "Version",
}
_OFFICE_APP_LABELS = {
    "Company": "Company",
    "Manager": "Manager",
    "Pages": "Pages",
    "Words": "Words",
    "Slides": "Slides",
    "Application": "Application",
    "Template": "Template",
}
_MSIP_LABEL_NAME = re.compile(r"^MSIP_Label_[0-9a-fA-F-]+_Name$")
_PDF_STANDARD_KEYS = {
    "/Title",
    "/Author",
    "/Subject",
    "/Keywords",
    "/Creator",
    "/Producer",
    "/CreationDate",
    "/ModDate",
    "/Trapped",
}
# Properties that help a reader place a passage, in the order they are shown.
_SUMMARY_PRIORITY = (
    "Title",
    "Author",
    "From",
    "To",
    "Sent",
    "Subject",
    "Created",
    "Modified",
    "Last modified by",
    "Sensitivity label",
    "Classification",
    "Ethical wall",
)
# Facts about the upload or the file's plumbing. Kept in metadata and shown in
# the Library, but they describe nothing a reader would search for.
_NOT_DESCRIPTIVE = frozenset(
    {
        "Application",
        "Producer",
        "Creator tool",
        "Message ID",
        "Revision",
        "Dimensions",
        "Template",
        "Page count",
        "Pages",
        "Words",
        "Slides",
        "File size",
        "Uploaded by",
        "Uploaded",
    }
)
# Locator of the passage that makes a file's properties searchable.
PROPERTIES_LOCATOR = "Document properties"
_EXIF_DATETIME = 0x0132
_EXIF_DATETIME_ORIGINAL = 0x9003
_EXIF_IFD = 0x8769
_EXIF_TEXT_LABELS = {
    0x013B: "Artist",
    0x8298: "Copyright",
    0x010E: "Description",
    0x0131: "Software",
}


def bounded_metadata(pairs: Iterable[tuple[str, Any]]) -> dict[str, str]:
    """Clean labels and values, drop blanks, keep the first of each label."""

    metadata: dict[str, str] = {}
    for raw_key, raw_value in pairs:
        key = _clean(str(raw_key))[:MAX_METADATA_KEY_CHARS]
        value = _clean(metadata_value(raw_value))
        if not key or not value or key in metadata:
            continue
        if len(value) > MAX_METADATA_VALUE_CHARS:
            value = value[: MAX_METADATA_VALUE_CHARS - 1] + "…"
        metadata[key] = value
        if len(metadata) >= MAX_METADATA_FIELDS:
            break
    return metadata


def metadata_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (list, tuple, set)):
        return ", ".join(metadata_value(item) for item in value if metadata_value(item))
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def descriptive_properties(metadata: Mapping[str, str]) -> list[tuple[str, str]]:
    """Properties that describe the document, most useful first."""

    ordered = [key for key in _SUMMARY_PRIORITY if key in metadata]
    ordered += [key for key in metadata if key not in ordered and key not in _NOT_DESCRIPTIVE]
    return [(key, metadata[key]) for key in ordered]


def metadata_summary(metadata: Mapping[str, str]) -> str | None:
    """One compact line of the most useful properties, for prompts and labels."""

    parts: list[str] = []
    length = 0
    for key, value in descriptive_properties(metadata):
        part = f"{key}: {value}"
        added = len(part) + (3 if parts else 0)
        if length + added > MAX_SUMMARY_CHARS:
            break
        parts.append(part)
        length += added
    return " · ".join(parts) or None


# --------------------------------------------------------------------- formats


def office_metadata(source: Source) -> Pairs:
    """Core, extended, and custom properties of a .docx/.xlsx/.pptx package."""

    try:
        with zipfile.ZipFile(_stream(source)) as archive:
            names = set(archive.namelist())
            parts = {
                name: archive.read(name)
                for name in ("docProps/core.xml", "docProps/app.xml", "docProps/custom.xml")
                if name in names
            }
    except (OSError, zipfile.BadZipFile):
        return []
    pairs: Pairs = []
    pairs += _xml_children(parts.get("docProps/core.xml"), _OFFICE_CORE_LABELS)
    pairs += _xml_children(parts.get("docProps/app.xml"), _OFFICE_APP_LABELS)
    pairs += _office_custom_properties(parts.get("docProps/custom.xml"))
    return pairs


def pdf_metadata(source: Source) -> Pairs:
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError:
        return []
    try:
        reader = PdfReader(_stream(source))
        info = reader.metadata
        pairs: Pairs = []
        if info is not None:
            pairs += [
                ("Title", info.title),
                ("Author", info.author),
                ("Subject", info.subject),
                ("Keywords", info.keywords),
                ("Created", _safe_attribute(info, "creation_date")),
                ("Modified", _safe_attribute(info, "modification_date")),
                ("Creator tool", info.creator),
                ("Producer", info.producer),
            ]
            pairs += [
                (str(key).lstrip("/"), _pdf_text(value))
                for key, value in info.items()
                if str(key) not in _PDF_STANDARD_KEYS
            ]
        pairs.append(("Page count", len(reader.pages)))
        pairs += _xmp_custom_properties(reader)
        return pairs
    except Exception:
        return []


def email_metadata(message: Any) -> Pairs:
    """Header fields and attachment names of a parsed ``email`` message."""

    attachments = [
        part.get_filename()
        for part in _iter_attachments(message)
        if part.get_filename()
    ]
    return [
        ("From", message.get("From")),
        ("To", message.get("To")),
        ("Cc", message.get("Cc")),
        ("Sent", message.get("Date")),
        ("Subject", message.get("Subject")),
        ("Message ID", message.get("Message-ID")),
        ("In reply to", message.get("In-Reply-To")),
        ("Attachments", attachments),
    ]


def outlook_metadata(message: Any) -> Pairs:
    """Header fields and attachment names of an ``oxmsg`` Outlook message."""

    raw_headers = getattr(message, "message_headers", {})
    headers = (
        {str(name).casefold(): value for name, value in raw_headers.items()}
        if isinstance(raw_headers, dict)
        else {}
    )
    attachments = [
        getattr(attachment, "file_name", None)
        for attachment in getattr(message, "attachments", []) or []
    ]
    return [
        ("From", getattr(message, "sender", None) or headers.get("from")),
        ("To", headers.get("to")),
        ("Cc", headers.get("cc")),
        ("Sent", getattr(message, "sent_date", None) or headers.get("date")),
        ("Subject", getattr(message, "subject", None) or headers.get("subject")),
        ("Message ID", headers.get("message-id")),
        ("Attachments", [name for name in attachments if name]),
    ]


def image_metadata(source: Source) -> Pairs:
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError:
        return []
    try:
        with Image.open(_stream(source)) as image:
            exif = image.getexif()
            details = exif.get_ifd(_EXIF_IFD) if exif else {}
            camera = " ".join(
                str(exif.get(tag) or "").strip() for tag in (0x010F, 0x0110)
            ).strip()
            pairs: Pairs = [
                ("Camera", camera),
                ("Taken", details.get(_EXIF_DATETIME_ORIGINAL) or exif.get(_EXIF_DATETIME)),
            ]
            pairs += [(label, exif.get(tag)) for tag, label in _EXIF_TEXT_LABELS.items()]
            pairs.append(("Dimensions", f"{image.width} × {image.height} px"))
            return pairs
    except Exception:
        return []


# --------------------------------------------------------------------- helpers


def _xml_children(xml: bytes | None, labels: Mapping[str, str]) -> Pairs:
    root = parse_xml(xml)
    if root is None:
        return []
    pairs: Pairs = []
    for child in root:
        label = labels.get(_local_name(child.tag))
        if label:
            pairs.append((label, (child.text or "").strip()))
    return pairs


def _office_custom_properties(xml: bytes | None) -> Pairs:
    root = parse_xml(xml)
    if root is None:
        return []
    pairs: Pairs = []
    for prop in root:
        name = str(prop.get("name") or "").strip()
        value = next(((child.text or "").strip() for child in prop), "")
        if _MSIP_LABEL_NAME.match(name):
            pairs.append(("Sensitivity label", value))
        elif name and not name.startswith("MSIP_Label_"):
            pairs.append((name, value))
    return pairs


def _xmp_custom_properties(reader: Any) -> Pairs:
    try:
        xmp = reader.xmp_metadata
        custom = xmp.custom_properties if xmp is not None else {}
    except Exception:
        return []
    return [(str(key), value) for key, value in dict(custom or {}).items()]


def _iter_attachments(message: Any) -> list[Any]:
    iterate = getattr(message, "iter_attachments", None)
    if not callable(iterate):
        return []
    try:
        return list(iterate())
    except Exception:
        return []


def _pdf_text(value: Any) -> str:
    try:
        resolved = value.get_object() if hasattr(value, "get_object") else value
    except Exception:
        return ""
    return metadata_value(resolved)


def _safe_attribute(record: Any, name: str) -> Any:
    try:
        return getattr(record, name)
    except Exception:
        return None


def parse_xml(xml: bytes | None) -> Any:
    """Parse untrusted XML safely; None for missing or malformed input."""
    if not xml:
        return None
    try:
        return ElementTree.fromstring(xml)
    except (ElementTree.ParseError, DefusedXmlException):
        return None


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _stream(source: Source) -> BinaryIO:
    # zipfile, pypdf, and Pillow seek within the stream themselves, so a file
    # left at any position by text extraction is read whole.
    return BytesIO(source) if isinstance(source, bytes) else source


def _clean(text: str) -> str:
    visible = "".join(
        character
        for character in text
        if character.isspace() or unicodedata.category(character)[0] != "C"
    )
    return " ".join(visible.split())
