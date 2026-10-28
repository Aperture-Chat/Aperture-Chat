from __future__ import annotations

import logging
import mimetypes
import os
import re
import zipfile
from bisect import bisect_right
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, replace
from email import policy
from email.parser import BytesParser
from io import BytesIO
from typing import Any, BinaryIO, Protocol

from defusedxml import ElementTree

from app.core.document_metadata import (
    bounded_metadata,
    email_metadata,
    image_metadata,
    office_metadata,
    outlook_metadata,
    pdf_metadata,
)
from app.core.document_metadata import parse_xml as _parse_xml
from app.core.html_extract import parse_html
from app.core.pdfium_lock import PDFIUM_LOCK

logger = logging.getLogger("aperture.knowledge_ingestion")

MAX_EXTRACTED_TEXT_CHARS = 10_000_000
DEFAULT_CHUNK_CHARS = 1200
DEFAULT_CHUNK_OVERLAP = 160
DEFAULT_OCR_MAX_PAGES = 250
DEFAULT_OCR_PAGE_TIMEOUT_SECONDS = 45.0
MIN_PDF_PAGE_TEXT_CHARS = 40
# Pictures smaller than this are logos, icons, and signature-block decoration.
MIN_VISION_IMAGE_BYTES = 12_000
MAX_VISION_IMAGES_PER_FILE = 12
# Typed pages whose images cover this share of the page get a vision pass.
MIN_IMAGE_COVERAGE = 0.12
MAX_ATTACHMENTS = 20
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENT_DEPTH = 2
_OCR_WORKERS_ENV = "APERTURE_KNOWLEDGE_OCR_WORKERS"
_DEFAULT_MAX_OCR_WORKERS = 4
_MAX_OCR_WORKERS = 16

_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")

_TEXT_EXTENSIONS = {
    ".csv",
    ".json",
    ".log",
    ".md",
    ".rtf",
    ".txt",
    ".xml",
}
_HTML_EXTENSIONS = {".htm", ".html"}
_IMAGE_EXTENSIONS = {".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
_VISION_IMAGE_EXTENSIONS = _IMAGE_EXTENSIONS

_DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
_XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_EML_MIME_TYPES = {"message/rfc822", "application/eml"}
_MSG_MIME_TYPES = {"application/vnd.ms-outlook", "application/x-msg"}

BinarySource = bytes | BinaryIO


@dataclass(frozen=True, slots=True)
class ExtractedSegment:
    """One ordered, independently locatable unit of extracted source text.

    ``page_start`` and ``page_end`` are one-based physical PDF/image page
    numbers. ``locator`` carries other honest source positions such as a slide
    or worksheet name. Callers must leave fields empty when the source format
    does not expose a reliable location.
    """

    text: str
    page_start: int | None = None
    page_end: int | None = None
    locator: str | None = None


class PageReader(Protocol):
    """Reads a rendered page or picture with a vision model.

    ``mode`` is ``"full"`` (transcribe everything on a scanned page),
    ``"extras"`` (the typed text is already captured; return only handwriting,
    stamps, signatures, and image content), or ``"image"`` (a picture embedded
    in a document). Returns None or "" when there is nothing, the model is
    unavailable, or its page budget is spent, so callers fall back.
    """

    concurrency: int

    def read_page(self, image: Any, *, mode: str, label: str) -> str | None: ...


@dataclass(frozen=True, slots=True)
class ExtractedDocument:
    """Extracted passages plus the properties the file carries about itself."""

    segments: list[ExtractedSegment]
    metadata: dict[str, str]


@dataclass(frozen=True, slots=True)
class _Options:
    max_chars: int
    ocr_enabled: bool
    ocr_max_pages: int
    ocr_page_timeout_seconds: float
    vision: PageReader | None = None
    depth: int = 0


def extract_text(
    filename: str,
    content: BinarySource,
    mime_type: str | None = None,
    *,
    max_chars: int = MAX_EXTRACTED_TEXT_CHARS,
    ocr_enabled: bool = True,
    ocr_max_pages: int = DEFAULT_OCR_MAX_PAGES,
    ocr_page_timeout_seconds: float = DEFAULT_OCR_PAGE_TIMEOUT_SECONDS,
    vision: PageReader | None = None,
) -> str | None:
    return _segments_text(
        extract_segments(
            filename,
            content,
            mime_type,
            max_chars=max_chars,
            ocr_enabled=ocr_enabled,
            ocr_max_pages=ocr_max_pages,
            ocr_page_timeout_seconds=ocr_page_timeout_seconds,
            vision=vision,
        )
    )


def extract_segments(
    filename: str,
    content: BinarySource,
    mime_type: str | None = None,
    *,
    max_chars: int = MAX_EXTRACTED_TEXT_CHARS,
    ocr_enabled: bool = True,
    ocr_max_pages: int = DEFAULT_OCR_MAX_PAGES,
    ocr_page_timeout_seconds: float = DEFAULT_OCR_PAGE_TIMEOUT_SECONDS,
    vision: PageReader | None = None,
) -> list[ExtractedSegment]:
    """Extract ordered segments from bytes or a seekable binary file."""
    return _extract_segments_from_source(
        filename,
        content,
        mime_type,
        _Options(max_chars, ocr_enabled, ocr_max_pages, ocr_page_timeout_seconds, vision),
    )


# Spooled uploads are read in place; both entry points accept bytes or a file.
extract_text_from_file = extract_text
extract_segments_from_file = extract_segments


def extract_document(
    filename: str,
    source: BinarySource,
    mime_type: str | None = None,
    *,
    max_chars: int = MAX_EXTRACTED_TEXT_CHARS,
    ocr_enabled: bool = True,
    ocr_max_pages: int = DEFAULT_OCR_MAX_PAGES,
    ocr_page_timeout_seconds: float = DEFAULT_OCR_PAGE_TIMEOUT_SECONDS,
    vision: PageReader | None = None,
) -> ExtractedDocument:
    """Extract passages and the file's own properties in one pass per format."""

    options = _Options(max_chars, ocr_enabled, ocr_max_pages, ocr_page_timeout_seconds, vision)
    segments = _extract_segments_from_source(filename, source, mime_type, options)
    reader = _METADATA_READERS.get(_source_kind(filename, mime_type))
    pairs = reader(source) if reader is not None else []
    return ExtractedDocument(segments=segments, metadata=bounded_metadata(pairs))


def _extract_segments_from_source(
    filename: str,
    source: BinarySource,
    mime_type: str | None,
    options: _Options,
) -> list[ExtractedSegment]:
    reader = _SEGMENT_READERS.get(_source_kind(filename, mime_type))
    segments = reader(source, options) if reader is not None else []
    return _limit_segments(segments, max_chars=options.max_chars)


# Checked in order; a file matches by extension or by declared MIME type.
_KIND_RULES: tuple[tuple[str, frozenset[str], frozenset[str]], ...] = (
    ("docx", frozenset({".docx"}), frozenset({_DOCX_MIME_TYPE})),
    ("xlsx", frozenset({".xlsx"}), frozenset({_XLSX_MIME_TYPE})),
    ("pptx", frozenset({".pptx"}), frozenset({_PPTX_MIME_TYPE})),
    ("eml", frozenset({".eml"}), frozenset(_EML_MIME_TYPES)),
    ("msg", frozenset({".msg"}), frozenset(_MSG_MIME_TYPES)),
    ("html", frozenset(_HTML_EXTENSIONS), frozenset({"text/html"})),
    ("pdf", frozenset({".pdf"}), frozenset({"application/pdf"})),
    ("rtf", frozenset({".rtf"}), frozenset()),
)


def _source_kind(filename: str, mime_type: str | None) -> str:
    extension = _extension(filename)
    mime = (mime_type or mimetypes.guess_type(filename)[0] or "").split(";", 1)[0]
    mime = mime.strip().lower()
    for kind, extensions, mime_types in _KIND_RULES:
        if extension in extensions or mime in mime_types:
            return kind
    if extension in _IMAGE_EXTENSIONS or mime.startswith("image/"):
        return "image"
    return "text" if _is_plain_text(extension, mime) else "unknown"


def is_html_source(filename: str, mime_type: str | None) -> bool:
    """True when extraction treats this source as an HTML page."""

    return _source_kind(filename, mime_type) == "html"


def _is_plain_text(extension: str, mime: str) -> bool:
    return (
        extension in _TEXT_EXTENSIONS
        or mime.startswith("text/")
        or mime in {"application/json", "application/xml"}
    )


def _read_text(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    text = decode_text(_read_source_bytes(source, max_chars=options.max_chars))
    return [ExtractedSegment(text=text)] if text else []


def _read_rtf(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    text = decode_text(_read_source_bytes(source, max_chars=options.max_chars))
    text = _extract_rtf_text(text)
    return [ExtractedSegment(text=text)] if text else []


def _read_html(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    content = _read_source_bytes(source, max_chars=options.max_chars)
    text = _extract_html_text(decode_text(content))
    return [ExtractedSegment(text=text)] if text else []


def _read_xlsx(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    del options
    return _extract_xlsx_segments(source)


def _read_image(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    if not options.ocr_enabled and options.vision is None:
        return []
    return _extract_image_segments(source, options)


def chunk_text(
    text: str,
    *,
    max_chars: int = DEFAULT_CHUNK_CHARS,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[str]:
    """Greedily pack normalized text into chunks of at most ``max(200, max_chars)``.

    Whole paragraphs are preferred. When the next paragraph does not fit and the
    chunk still has meaningful room, the room is filled with whole sentences
    (then words, then a hard slice for a single oversized token) and the rest of
    the paragraph continues in the next chunk. Every chunk after the first
    starts with the previous chunk's overlap tail, and that tail counts toward
    the size limit.
    """

    normalized = _normalize_text(text)
    if not normalized:
        return []
    safe_max = max(200, max_chars)
    safe_overlap = max(0, min(overlap, safe_max // 3))
    builder = _ChunkBuilder(safe_max, safe_overlap)
    for paragraph in re.split(r"\n{2,}", normalized):
        paragraph = paragraph.strip()
        if paragraph:
            _pack_paragraph(builder, paragraph)
    builder.flush()
    return builder.chunks


def chunk_segments(
    segments: list[ExtractedSegment],
    *,
    max_chars: int = DEFAULT_CHUNK_CHARS,
    overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[ExtractedSegment]:
    """Chunk each locator boundary independently while preserving provenance.

    Text from different pages, slides, or sheets is never merged into one chunk;
    doing so would make a citation point at a location containing only part of
    the retrieved passage. Long individual segments retain the usual overlap.
    """

    chunks: list[ExtractedSegment] = []
    for segment in segments:
        for text in chunk_text(segment.text, max_chars=max_chars, overlap=overlap):
            chunks.append(
                ExtractedSegment(
                    text=text,
                    page_start=segment.page_start,
                    page_end=segment.page_end,
                    locator=segment.locator,
                )
            )
    return chunks


def _extension(filename: str) -> str:
    if "." not in filename:
        return ""
    return f".{filename.rsplit('.', 1)[-1].lower()}"


def decode_text(content: bytes) -> str:
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("latin-1", errors="replace")


def _read_docx(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    parts = _zip_parts(source, _is_docx_text_part)
    body = _docx_body_segments(parts.get("word/document.xml") if parts else None)
    if not body:
        return []
    segments = body + _docx_extra_segments(parts or {})
    if options.vision is not None:
        segments += _office_image_segments(source, "word/media/", options.vision)
    return segments


def _docx_body_segments(document_xml: bytes | None) -> list[ExtractedSegment]:
    root = _parse_xml(document_xml)
    if root is None:
        return []
    body = next((element for element in root.iter() if _local_name(element.tag) == "body"), None)
    blocks = [text for element in (body if body is not None else []) if (text := _word_block(element))]
    return [ExtractedSegment(text="\n\n".join(blocks))] if blocks else []


def _word_block(element: ElementTree.Element) -> str:
    """Text of one top-level body element: a paragraph or a table."""

    name = _local_name(element.tag)
    if name == "p":
        return _word_paragraph_text(element)
    if name == "tbl":
        return _word_table_text(element)
    return ""


_DOCX_HEADER_FOOTER = re.compile(r"word/(header|footer)(\d*)\.xml")
_DOCX_NOTE_PARTS = (("word/footnotes.xml", "Footnotes"), ("word/endnotes.xml", "Endnotes"))


def _is_docx_text_part(name: str) -> bool:
    return (
        name in {"word/document.xml", "word/comments.xml"}
        or name in dict(_DOCX_NOTE_PARTS)
        or _DOCX_HEADER_FOOTER.fullmatch(name) is not None
    )


def _docx_extra_segments(parts: dict[str, bytes]) -> list[ExtractedSegment]:
    """Headers, footers, notes, and reviewer comments live outside document.xml."""

    def header_order(name: str) -> tuple[int, int]:
        match = _DOCX_HEADER_FOOTER.fullmatch(name)
        assert match is not None
        return (0 if match.group(1) == "header" else 1, int(match.group(2) or 0))

    header_names = sorted(
        (name for name in parts if _DOCX_HEADER_FOOTER.fullmatch(name)), key=header_order
    )
    sections = [("Headers and footers", _unique(_paragraphs(parts[name]) for name in header_names))]
    sections += [
        (label, _unique([_paragraphs(parts.get(name))])) for name, label in _DOCX_NOTE_PARTS
    ]
    sections.append(("Comments", _word_comments(parts.get("word/comments.xml"))))
    return [
        ExtractedSegment(text="\n\n".join(lines), locator=label)
        for label, lines in sections
        if lines
    ]


def _paragraphs(xml: bytes | None) -> list[str]:
    root = _parse_xml(xml)
    if root is None:
        return []
    return [
        text
        for element in root.iter()
        if _local_name(element.tag) == "p" and (text := _word_paragraph_text(element))
    ]


def _unique(groups: Iterable[list[str]]) -> list[str]:
    seen: dict[str, None] = {}
    for group in groups:
        for line in group:
            seen.setdefault(line, None)
    return list(seen)


def _word_comments(xml: bytes | None) -> list[str]:
    root = _parse_xml(xml)
    if root is None:
        return []
    comments: list[str] = []
    for element in root.iter():
        if _local_name(element.tag) != "comment":
            continue
        text = " ".join(
            line
            for paragraph in element.iter()
            if _local_name(paragraph.tag) == "p" and (line := _word_paragraph_text(paragraph))
        )
        author = _local_attribute(element, "author")
        if text:
            comments.append(f"{author}: {text}" if author else text)
    return comments


def _local_attribute(element: ElementTree.Element, name: str) -> str:
    for key, value in element.attrib.items():
        if _local_name(key) == name:
            return str(value).strip()
    return ""


def _zip_parts(source: BinarySource, wanted: Callable[[str], bool]) -> dict[str, bytes] | None:
    try:
        _rewind_source(source)
        archive_source = BytesIO(source) if isinstance(source, bytes) else source
        with zipfile.ZipFile(archive_source) as archive:
            return {name: archive.read(name) for name in archive.namelist() if wanted(name)}
    except (KeyError, OSError, zipfile.BadZipFile):
        return None


def _office_image_segments(
    source: BinarySource, prefix: str, vision: PageReader
) -> list[ExtractedSegment]:
    """Read pictures embedded in a Word file (scanned exhibits, signatures)."""

    media = _zip_parts(
        source, lambda name: name.startswith(prefix) and _extension(name) in _VISION_IMAGE_EXTENSIONS
    )
    blobs = [
        blob
        for _name, blob in sorted((media or {}).items(), key=lambda item: _natural_key(item[0]))
        if len(blob) >= MIN_VISION_IMAGE_BYTES
    ][:MAX_VISION_IMAGES_PER_FILE]
    labels = [f"Embedded image {index}" for index in range(1, len(blobs) + 1)]
    texts = _read_pictures(blobs, labels, vision)
    return [
        ExtractedSegment(text=texts[index], locator=label)
        for index, label in enumerate(labels)
        if texts.get(index)
    ]


def _read_pictures(
    blobs: list[bytes], labels: list[str], vision: PageReader
) -> dict[int, str]:
    if not blobs:
        return {}

    def read(index: int, image: Any) -> str:
        return _vision_text(vision, image, mode="image", label=labels[index])

    return _read_page_images(
        _picture_pages(blobs), workers=min(vision.concurrency, len(blobs)), read=read
    )


def _picture_pages(blobs: list[bytes]) -> Iterator[_OcrPage]:
    from PIL import Image  # type: ignore[import-not-found]

    for index, blob in enumerate(blobs):
        try:
            with Image.open(BytesIO(blob)) as opened:
                image = opened.convert("RGB")
        except Exception:
            continue
        yield _OcrPage(index, image, (image,))


def _vision_text(vision: PageReader, image: Any, *, mode: str, label: str) -> str:
    try:
        text = vision.read_page(image, mode=mode, label=label)
    except Exception:
        # A reader failure must never fail extraction, but it must not vanish.
        logger.warning("Vision page reader failed on %s", label, exc_info=True)
        return ""
    return _normalize_text(text or "")


def _natural_key(name: str) -> tuple[object, ...]:
    return tuple(int(part) if part.isdigit() else part for part in re.split(r"(\d+)", name))


def _word_paragraph_text(paragraph: ElementTree.Element) -> str:
    parts: list[str] = []
    for node in paragraph.iter():
        name = _local_name(node.tag)
        if name == "t":
            parts.append(node.text or "")
        elif name == "tab":
            parts.append("\t")
        elif name in {"br", "cr"}:
            parts.append("\n")
    return "".join(parts).strip()


def _word_table_text(table: ElementTree.Element) -> str:
    rows: list[str] = []
    for row in table:
        if _local_name(row.tag) != "tr":
            continue
        cells: list[str] = []
        for cell in row:
            if _local_name(cell.tag) != "tc":
                continue
            paragraphs = [
                _word_paragraph_text(paragraph)
                for paragraph in cell.iter()
                if _local_name(paragraph.tag) == "p"
            ]
            cells.append(" / ".join(text for text in paragraphs if text))
        while cells and not cells[-1]:
            cells.pop()
        if cells:
            rows.append(" | ".join(cells))
    return "\n\n".join(rows)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _extract_xlsx_segments(source: BinarySource) -> list[ExtractedSegment]:
    try:
        from openpyxl import load_workbook  # type: ignore[import-not-found]
    except ImportError:
        return []

    workbook = None
    try:
        # data_only reads the values Excel cached for formula cells, so search
        # sees "1,250,000" rather than "=SUM(B2:B9)". Workbooks written by
        # scripts without cached values leave those cells blank instead.
        workbook = load_workbook(
            BytesIO(_read_all_source_bytes(source)),
            read_only=True,
            data_only=True,
            keep_links=False,
        )
        segments: list[ExtractedSegment] = []
        for worksheet in workbook.worksheets:
            rows: list[str] = []
            for values in worksheet.iter_rows(values_only=True):
                cells = [_spreadsheet_cell_text(value) for value in values]
                while cells and not cells[-1]:
                    cells.pop()
                if cells:
                    rows.append(" | ".join(cells))
            text = "\n\n".join(rows)
            if text:
                segments.append(ExtractedSegment(text=text, locator=f"Sheet: {worksheet.title}"))
        return segments
    except Exception:
        return []
    finally:
        if workbook is not None:
            workbook.close()


def _spreadsheet_cell_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value).strip()


def _read_pptx(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    try:
        from pptx import Presentation  # type: ignore[import-not-found]
    except ImportError:
        return []

    try:
        presentation = Presentation(BytesIO(_read_all_source_bytes(source)))
        slides = list(presentation.slides)
    except Exception:
        return []

    images = _slide_image_texts(slides, options.vision)
    segments: list[ExtractedSegment] = []
    for index, slide in enumerate(slides, start=1):
        blocks = [block for shape in slide.shapes for block in _pptx_shape_blocks(shape)]
        blocks += [f"Image: {text}" for text in images.get(index, [])]
        notes = _pptx_notes(slide)
        if notes:
            blocks.append(f"Speaker notes: {notes}")
        text = "\n\n".join(block for block in blocks if block.strip())
        if text:
            segments.append(ExtractedSegment(text=text, locator=f"Slide {index}"))
    return segments


def _slide_image_texts(slides: list[Any], vision: PageReader | None) -> dict[int, list[str]]:
    """What the vision reader saw in each slide's pictures, keyed by slide number."""

    if vision is None:
        return {}
    pictures = _slide_pictures(slides)
    texts = _read_pictures(
        [blob for _slide, blob in pictures],
        [f"Slide {slide} image" for slide, _blob in pictures],
        vision,
    )
    by_slide: dict[int, list[str]] = {}
    for position, (slide_number, _blob) in enumerate(pictures):
        if texts.get(position):
            by_slide.setdefault(slide_number, []).append(texts[position])
    return by_slide


def _pptx_notes(slide: Any) -> str:
    try:
        if not slide.has_notes_slide:
            return ""
        frame = slide.notes_slide.notes_text_frame
        return str(frame.text or "").strip() if frame is not None else ""
    except Exception:
        return ""


def _slide_pictures(slides: list[Any]) -> list[tuple[int, bytes]]:
    pictures: list[tuple[int, bytes]] = []
    for index, slide in enumerate(slides, start=1):
        for shape in slide.shapes:
            pictures += [(index, blob) for blob in _shape_pictures(shape)]
    return [item for item in pictures if len(item[1]) >= MIN_VISION_IMAGE_BYTES][
        :MAX_VISION_IMAGES_PER_FILE
    ]


def _shape_pictures(shape: Any) -> list[bytes]:
    blobs: list[bytes] = []
    try:
        image = getattr(shape, "image", None)
        if image is not None and f".{image.ext}".lower() in _VISION_IMAGE_EXTENSIONS:
            blobs.append(image.blob)
    except Exception:
        pass
    for nested in getattr(shape, "shapes", None) or []:
        blobs += _shape_pictures(nested)
    return blobs


def _pptx_shape_blocks(shape: object) -> list[str]:
    blocks: list[str] = []
    if bool(getattr(shape, "has_table", False)):
        table = getattr(shape, "table", None)
        rows = getattr(table, "rows", []) if table is not None else []
        rendered_rows: list[str] = []
        for row in rows:
            cells = [str(getattr(cell, "text", "") or "").strip() for cell in row.cells]
            while cells and not cells[-1]:
                cells.pop()
            if cells:
                rendered_rows.append(" | ".join(cells))
        if rendered_rows:
            blocks.append("\n\n".join(rendered_rows))
    elif bool(getattr(shape, "has_text_frame", False)):
        text = str(getattr(shape, "text", "") or "").strip()
        if text:
            blocks.append(text)

    nested_shapes = getattr(shape, "shapes", None)
    if nested_shapes is not None:
        for nested in nested_shapes:
            blocks.extend(_pptx_shape_blocks(nested))
    return blocks


def _read_eml(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    message = _parse_eml(source)
    if message is None:
        return []

    headers = _email_header_lines(
        {
            "From": message.get("From"),
            "To": message.get("To"),
            "Cc": message.get("Cc"),
            "Date": message.get("Date"),
            "Subject": message.get("Subject"),
        }
    )
    body = _email_message_body(message)
    text = "\n\n".join(part for part in (headers, body) if part)
    segments = [ExtractedSegment(text=text)] if text else []
    return segments + _attachment_segments(_eml_attachments(message), options)


def _parse_eml(source: BinarySource) -> Any:
    try:
        return BytesParser(policy=policy.default).parsebytes(_read_all_source_bytes(source))
    except Exception:
        return None


def _eml_metadata(source: BinarySource) -> list[tuple[str, Any]]:
    message = _parse_eml(source)
    return email_metadata(message) if message is not None else []


def _eml_attachments(message: Any) -> list[tuple[str, bytes, str | None]]:
    attachments: list[tuple[str, bytes, str | None]] = []
    try:
        parts = list(message.iter_attachments())
    except Exception:
        return []
    for part in parts:
        content_type = part.get_content_type()
        if content_type == "message/rfc822":
            nested = part.get_payload()
            payload = nested[0].as_bytes() if isinstance(nested, list) and nested else None
            name = part.get_filename() or "attached-message.eml"
        else:
            payload = part.get_payload(decode=True)
            name = part.get_filename()
        if name and isinstance(payload, bytes):
            attachments.append((name, payload, content_type))
    return attachments


def _attachment_segments(
    attachments: list[tuple[str, bytes, str | None]], options: _Options
) -> list[ExtractedSegment]:
    """Extract attached files, each passage located as "Attachment: name, Page n".

    Page numbers belong to the attachment rather than the message, so they
    stay in the locator text instead of the email's page fields.
    """

    if options.depth >= MAX_ATTACHMENT_DEPTH:
        return []
    nested_options = replace(options, depth=options.depth + 1)
    segments: list[ExtractedSegment] = []
    for name, payload, mime_type in attachments[:MAX_ATTACHMENTS]:
        if len(payload) > MAX_ATTACHMENT_BYTES or _is_decoration(name, mime_type, payload):
            continue
        for segment in _extract_segments_from_source(name, payload, mime_type, nested_options):
            locator = f"Attachment: {name}"
            if segment.locator:
                locator = f"{locator}, {segment.locator}"
            segments.append(ExtractedSegment(text=segment.text, locator=locator))
    return segments


def _is_decoration(name: str, mime_type: str | None, payload: bytes) -> bool:
    """Signature logos and inline icons are images too small to carry content."""

    return _source_kind(name, mime_type) == "image" and len(payload) < MIN_VISION_IMAGE_BYTES


def _email_message_body(message: object) -> str:
    get_body = getattr(message, "get_body", None)
    body_part = get_body(preferencelist=("plain", "html")) if callable(get_body) else None
    if body_part is not None:
        try:
            body = body_part.get_content()
        except (KeyError, LookupError, UnicodeError):
            body = ""
        if not isinstance(body, str):
            return ""
        if body_part.get_content_type() == "text/html":
            return _extract_html_text(body)
        return body

    if not bool(getattr(message, "is_multipart", lambda: False)()):
        try:
            body = message.get_content()
        except (AttributeError, KeyError, LookupError, UnicodeError):
            return ""
        return body if isinstance(body, str) else ""
    return ""


def _read_msg(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    message = _parse_msg(source)
    if message is None:
        return []

    text = "\n\n".join(part for part in (_msg_headers(message), _msg_body(message)) if part)
    segments = [ExtractedSegment(text=text)] if text else []
    return segments + _attachment_segments(_msg_attachments(message), options)


def _msg_headers(message: Any) -> str:
    raw_headers = getattr(message, "message_headers", {})
    headers_by_name = (
        {str(name).casefold(): value for name, value in raw_headers.items()}
        if isinstance(raw_headers, dict)
        else {}
    )
    sent_date = getattr(message, "sent_date", None)
    return _email_header_lines(
        {
            "From": getattr(message, "sender", None) or headers_by_name.get("from"),
            "To": headers_by_name.get("to"),
            "Cc": headers_by_name.get("cc"),
            "Date": sent_date.isoformat() if sent_date is not None else headers_by_name.get("date"),
            "Subject": getattr(message, "subject", None) or headers_by_name.get("subject"),
        }
    )


def _msg_body(message: Any) -> str:
    plain_body = getattr(message, "body", None)
    if plain_body is not None:
        return str(plain_body)
    html_body = getattr(message, "html_body", None)
    if isinstance(html_body, bytes):
        html_body = decode_text(html_body)
    return _extract_html_text(html_body) if isinstance(html_body, str) else ""


def _parse_msg(source: BinarySource) -> Any:
    try:
        from oxmsg import Message  # type: ignore[import-not-found]
    except ImportError:
        return None

    content = _read_all_source_bytes(source)
    if not content:
        return None
    try:
        return Message.load(content)
    except Exception:
        return None


def _msg_metadata(source: BinarySource) -> list[tuple[str, Any]]:
    message = _parse_msg(source)
    return outlook_metadata(message) if message is not None else []


def _msg_attachments(message: Any) -> list[tuple[str, bytes, str | None]]:
    attachments: list[tuple[str, bytes, str | None]] = []
    try:
        items = list(getattr(message, "attachments", []) or [])
    except Exception:
        return []
    for attachment in items:
        name = getattr(attachment, "file_name", None)
        payload = getattr(attachment, "file_bytes", None)
        if name and isinstance(payload, bytes):
            attachments.append((str(name), payload, getattr(attachment, "mime_type", None)))
    return attachments


def _email_header_lines(values: dict[str, object]) -> str:
    lines: list[str] = []
    for label, raw_value in values.items():
        if raw_value is None:
            continue
        if isinstance(raw_value, (list, tuple, set)):
            value = ", ".join(str(item).strip() for item in raw_value if str(item).strip())
        else:
            value = str(raw_value).strip()
        if value:
            lines.append(f"{label}: {value}")
    return "\n".join(lines)


def _extract_html_text(text: str) -> str:
    return parse_html(text).text


def _extract_rtf_text(text: str) -> str:
    text = re.sub(r"\\'[0-9a-fA-F]{2}", " ", text)
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?", " ", text)
    text = text.replace("{", " ").replace("}", " ").replace("\\", " ")
    return text


def _read_pdf(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError:
        return []
    try:
        _rewind_source(source)
        reader = PdfReader(BytesIO(source) if isinstance(source, bytes) else source)
        typed = [_normalize_text(page.extract_text() or "") for page in reader.pages]
        annotations = [_pdf_page_annotations(page) for page in reader.pages]
    except Exception:
        return []

    page_texts = _read_scanned_pages(source, typed, options)
    visual_notes = _read_page_markings(source, typed, annotations, options)
    segments = [
        ExtractedSegment(
            text=_pdf_page_text(text, visual_notes.get(index - 1), annotations[index - 1]),
            page_start=index,
            page_end=index,
            locator=f"Page {index}",
        )
        for index, text in enumerate(page_texts, start=1)
    ]
    segments = [segment for segment in segments if segment.text]
    form = _pdf_form_segment(reader)
    return segments + ([form] if form is not None else [])


@dataclass(frozen=True, slots=True)
class _PageAnnotations:
    comments: tuple[str, ...] = ()
    # Ink drawings and stamps carry no text, only marks a vision model can read.
    marked: bool = False


_PDF_SKIPPED_ANNOTATIONS = {"/Link", "/Widget", "/Popup"}
_PDF_MARKING_ANNOTATIONS = {"/Ink", "/Stamp"}


def _pdf_page_annotations(page: Any) -> _PageAnnotations:
    comments: list[str] = []
    marked = False
    try:
        annotations = [item.get_object() for item in page.get("/Annots") or []]
    except Exception:
        return _PageAnnotations()
    for annotation in annotations:
        subtype = str(annotation.get("/Subtype") or "")
        marked = marked or subtype in _PDF_MARKING_ANNOTATIONS
        if subtype in _PDF_SKIPPED_ANNOTATIONS:
            continue
        contents = _pdf_string(annotation.get("/Contents"))
        author = _pdf_string(annotation.get("/T"))
        if contents:
            comments.append(f"{author}: {contents}" if author else contents)
    return _PageAnnotations(tuple(comments), marked)


def _pdf_page_text(text: str, visual_notes: str | None, annotations: _PageAnnotations) -> str:
    parts = [text] if text else []
    if visual_notes:
        parts.append(f"Handwriting, stamps, and images on this page:\n\n{visual_notes}")
    if annotations.comments:
        bullets = "\n\n".join(f"- {comment}" for comment in annotations.comments)
        parts.append(f"Comments on this page:\n\n{bullets}")
    return "\n\n".join(parts)


def _pdf_form_segment(reader: Any) -> ExtractedSegment | None:
    """Filled-in form values live in fields, not in the page text."""

    try:
        fields = reader.get_fields() or {}
    except Exception:
        return None
    lines: list[str] = []
    for name, field in fields.items():
        value = _pdf_string(field.get("/V")).lstrip("/")
        if not value or value == "Off":
            continue
        label = _pdf_string(field.get("/TU")) or str(name)
        lines.append(f"{label}: {value}")
    if not lines:
        return None
    return ExtractedSegment(text="\n\n".join(lines), locator="Form fields")


def _pdf_string(value: Any) -> str:
    if value is None:
        return ""
    try:
        resolved = value.get_object() if hasattr(value, "get_object") else value
    except Exception:
        return ""
    if isinstance(resolved, (list, tuple)):
        return ", ".join(_pdf_string(item) for item in resolved if _pdf_string(item))
    return " ".join(str(resolved).split())


def _read_scanned_pages(
    source: BinarySource, typed: list[str], options: _Options
) -> list[str]:
    """Fill pages with no text layer from the vision reader, then Tesseract."""

    scanned = [
        index
        for index, text in enumerate(typed[: options.ocr_max_pages])
        if len(text) < MIN_PDF_PAGE_TEXT_CHARS
    ]
    page_texts = list(typed)
    if not scanned:
        return page_texts
    if options.vision is not None:
        results = _read_pdf_page_images(
            source,
            scanned,
            read=_page_reader(options, mode="full"),
            workers=options.vision.concurrency,
        )
    elif options.ocr_enabled:
        results = _ocr_pdf_pages(
            source, scanned, timeout_seconds=options.ocr_page_timeout_seconds
        )
    else:
        results = {}
    for page_index, text in results.items():
        if text:
            page_texts[page_index] = text
    return page_texts


def _read_page_markings(
    source: BinarySource,
    typed: list[str],
    annotations: list[_PageAnnotations],
    options: _Options,
) -> dict[int, str]:
    """Ask the vision reader about handwriting and images on typed pages."""

    if options.vision is None:
        return {}
    typed_pages = [
        index
        for index, text in enumerate(typed[: options.ocr_max_pages])
        if len(text) >= MIN_PDF_PAGE_TEXT_CHARS
    ]
    marked = {index for index in typed_pages if annotations[index].marked}
    candidates = sorted(marked | set(_image_heavy_pages(source, typed_pages)))
    if not candidates:
        return {}
    results = _read_pdf_page_images(
        source,
        candidates,
        read=_page_reader(options, mode="extras"),
        workers=options.vision.concurrency,
    )
    return {index: text for index, text in results.items() if text}


def _page_reader(options: _Options, *, mode: str) -> Callable[[int, Any], str]:
    vision = options.vision

    def read(index: int, image: Any) -> str:
        if vision is not None:
            text = _vision_text(vision, image, mode=mode, label=f"Page {index + 1}")
            if text:
                return text
        if mode == "full" and options.ocr_enabled:
            return _ocr_image(image, timeout_seconds=options.ocr_page_timeout_seconds)
        return ""

    return read


def _image_heavy_pages(source: BinarySource, page_indexes: list[int]) -> list[int]:
    """Pages where pictures cover enough area to hold handwriting or scans."""

    if not page_indexes:
        return []
    try:
        import pypdfium2 as pdfium  # type: ignore[import-not-found]
        import pypdfium2.raw as pdfium_c  # type: ignore[import-not-found]
    except ImportError:
        return []
    _rewind_source(source)
    try:
        with PDFIUM_LOCK:
            pdf = pdfium.PdfDocument(source)
    except Exception:
        return []
    heavy: list[int] = []
    try:
        with PDFIUM_LOCK:
            page_count = len(pdf)
            for index in page_indexes:
                if index < page_count and _image_coverage(pdf[index], pdfium_c) >= MIN_IMAGE_COVERAGE:
                    heavy.append(index)
    except Exception:
        return heavy
    finally:
        with PDFIUM_LOCK:
            pdf.close()
    return heavy


def _image_coverage(page: Any, pdfium_c: Any) -> float:
    """Share of the page area covered by image objects (caller holds the lock)."""

    try:
        width, height = page.get_size()
        area = 0.0
        for item in page.get_objects(filter=(pdfium_c.FPDF_PAGEOBJ_IMAGE,), max_depth=3):
            left, bottom, right, top = item.get_bounds()
            area += max(0.0, right - left) * max(0.0, top - bottom)
        return min(1.0, area / (width * height)) if width and height else 0.0
    finally:
        page.close()


def _ocr_pdf_pages(
    source: BinarySource,
    page_indexes: list[int],
    *,
    timeout_seconds: float,
) -> dict[int, str]:
    return _read_pdf_page_images(
        source,
        page_indexes,
        read=lambda _index, image: _ocr_image(image, timeout_seconds=timeout_seconds),
        workers=_ocr_worker_count(),
    )


def _read_pdf_page_images(
    source: BinarySource,
    page_indexes: list[int],
    *,
    read: Callable[[int, Any], str],
    workers: int,
) -> dict[int, str]:
    try:
        import pypdfium2 as pdfium  # type: ignore[import-not-found]
    except ImportError:
        return {}

    _rewind_source(source)
    pdf_source = source if isinstance(source, bytes) else source
    try:
        with PDFIUM_LOCK:
            pdf = pdfium.PdfDocument(pdf_source)
    except Exception:
        return {}

    try:
        with PDFIUM_LOCK:
            page_count = len(pdf)
        indexes = [page_index for page_index in page_indexes if page_index < page_count]
        return _read_page_images(
            _render_pdf_pages(pdf, indexes),
            workers=min(workers, len(indexes)),
            read=read,
        )
    finally:
        with PDFIUM_LOCK:
            pdf.close()


def _render_pdf_pages(pdf: Any, page_indexes: list[int]) -> Iterator[_OcrPage]:
    # pypdfium2 is not thread-safe, so rendering happens here on the consuming
    # thread and _ocr_pages also closes pages and bitmaps on that thread.
    for page_index in page_indexes:
        page = bitmap = image = None
        try:
            with PDFIUM_LOCK:
                page = pdf[page_index]
                bitmap = page.render(scale=2, rotation=0)
                image = bitmap.to_pil()
        except Exception:
            _close_all(image, bitmap, page)
            continue
        yield _OcrPage(page_index, image, (image, bitmap, page))


def _extract_image_segments(source: BinarySource, options: _Options) -> list[ExtractedSegment]:
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError:
        return []

    _rewind_source(source)
    image_source = BytesIO(source) if isinstance(source, bytes) else source
    max_frames = options.ocr_max_pages
    try:
        with Image.open(image_source) as image:
            multi_frame = max_frames > 1 and bool(getattr(image, "is_animated", False))
            concurrency = (
                options.vision.concurrency if options.vision is not None else _ocr_worker_count()
            )
            texts = _read_page_images(
                _copy_image_frames(image, max_frames),
                workers=concurrency if multi_frame else 1,
                read=_page_reader(options, mode="full"),
            )
    except Exception:
        return []

    segments: list[ExtractedSegment] = []
    for index in sorted(texts):
        if texts[index]:
            page_number = index + 1
            segments.append(
                ExtractedSegment(
                    text=texts[index],
                    page_start=page_number,
                    page_end=page_number,
                    locator=f"Page {page_number}",
                )
            )
    return segments


def _copy_image_frames(image: Any, max_frames: int) -> Iterator[_OcrPage]:
    from PIL import ImageSequence  # type: ignore[import-not-found]

    # Frame iteration seeks the shared image object, so copies are made in order
    # on the consuming thread.
    for index, frame in enumerate(ImageSequence.Iterator(image)):
        if index >= max_frames:
            break
        frame_copy = frame.copy()
        yield _OcrPage(index, frame_copy, (frame_copy,))


@dataclass(frozen=True, slots=True)
class _OcrPage:
    """A rendered page image plus the resources to close once its OCR ends."""

    index: int
    image: Any
    resources: tuple[Any, ...]

    def close(self) -> None:
        _close_all(*self.resources)


def _close_all(*resources: Any) -> None:
    # Pages and bitmaps are PDFium objects; closing them is a PDFium call.
    with PDFIUM_LOCK:
        _close_each(resources)


def _close_each(resources: tuple[Any, ...]) -> None:
    for resource in resources:
        if resource is not None:
            resource.close()


def _ocr_worker_count() -> int:
    """Pages to OCR concurrently; ``APERTURE_KNOWLEDGE_OCR_WORKERS`` overrides."""

    configured = os.environ.get(_OCR_WORKERS_ENV, "").strip()
    if configured:
        try:
            workers = int(configured)
        except ValueError:
            workers = 0
        if workers > 0:
            return min(workers, _MAX_OCR_WORKERS)
    return max(1, min(_DEFAULT_MAX_OCR_WORKERS, (os.cpu_count() or 2) - 1))


def _read_page_images(
    pages: Iterable[_OcrPage],
    *,
    workers: int,
    read: Callable[[int, Any], str],
) -> dict[int, str]:
    """Read page images into ``{page index: text}``, skipping any page that fails.

    ``pages`` is consumed, and every page closed, on the calling thread; only
    ``read`` runs on worker threads. At most ``2 * workers`` pages are held at
    once so long scanned documents do not accumulate rendered images.
    """

    results: dict[int, str] = {}
    if workers <= 1:
        for page in pages:
            try:
                results[page.index] = read(page.index, page.image)
            except Exception:
                continue
            finally:
                page.close()
        return results

    # Tesseract also parallelizes each page with OpenMP threads; with pages
    # already running in parallel that oversubscribes the CPU. pytesseract's
    # subprocesses inherit this environment, so cap them at one thread each.
    os.environ.setdefault("OMP_THREAD_LIMIT", "1")
    in_flight: dict[Future[str], _OcrPage] = {}
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="knowledge-ocr") as executor:
        try:
            for page in pages:
                try:
                    future = executor.submit(read, page.index, page.image)
                except BaseException:
                    page.close()
                    raise
                in_flight[future] = page
                if len(in_flight) >= workers * 2:
                    done, _pending = wait(in_flight, return_when=FIRST_COMPLETED)
                    for finished in done:
                        _collect_ocr_result(results, in_flight.pop(finished), finished)
        finally:
            # Wait for every submitted page before closing it, even on error:
            # a worker may still be reading the image's memory.
            for future, page in list(in_flight.items()):
                _collect_ocr_result(results, page, future)
    return dict(sorted(results.items()))


def _collect_ocr_result(results: dict[int, str], page: _OcrPage, future: Future[str]) -> None:
    try:
        results[page.index] = future.result()
    except Exception:
        pass
    finally:
        page.close()


def _ocr_image(image: object, *, timeout_seconds: float) -> str:
    try:
        import pytesseract  # type: ignore[import-not-found]
        from PIL import ImageOps  # type: ignore[import-not-found]
    except ImportError:
        return ""

    try:
        prepared = ImageOps.exif_transpose(image).convert("L")
        prepared = ImageOps.autocontrast(prepared)
        try:
            return _normalize_text(
                pytesseract.image_to_string(
                    prepared,
                    lang="eng",
                    config="--oem 1 --psm 3",
                    timeout=timeout_seconds,
                )
            )
        finally:
            prepared.close()
    except Exception:
        return ""


def _read_source_bytes(source: BinarySource, *, max_chars: int) -> bytes:
    if isinstance(source, bytes):
        return source[: max_chars * 4 + 4]
    _rewind_source(source)
    return source.read(max_chars * 4 + 4)


def _read_all_source_bytes(source: BinarySource) -> bytes:
    if isinstance(source, bytes):
        return source
    _rewind_source(source)
    return source.read()


def _rewind_source(source: BinarySource) -> None:
    if not isinstance(source, bytes):
        source.seek(0)


def _limit_segments(
    segments: list[ExtractedSegment],
    *,
    max_chars: int = MAX_EXTRACTED_TEXT_CHARS,
) -> list[ExtractedSegment]:
    """Normalize segments under one global joined-text character budget."""

    remaining = max(0, max_chars)
    limited: list[ExtractedSegment] = []
    for segment in segments:
        normalized = _normalize_text(segment.text)
        if not normalized:
            continue
        separator_chars = 2 if limited else 0
        if remaining <= separator_chars:
            break
        remaining -= separator_chars
        text = normalized[:remaining].rstrip()
        if not text:
            break
        limited.append(
            ExtractedSegment(
                text=text,
                page_start=segment.page_start,
                page_end=segment.page_end,
                locator=segment.locator,
            )
        )
        remaining -= len(text)
        if remaining <= 0:
            break
    return limited


def _segments_text(segments: list[ExtractedSegment]) -> str | None:
    text = "\n\n".join(segment.text for segment in segments if segment.text)
    return text or None


def _normalize_text(text: str) -> str:
    lines = [" ".join(line.replace("\x00", " ").split()) for line in text.splitlines()]
    paragraphs: list[str] = []
    current: list[str] = []
    for line in lines:
        if line:
            current.append(line)
        elif current:
            paragraphs.append(" ".join(current))
            current = []
    if current:
        paragraphs.append(" ".join(current))
    return "\n\n".join(paragraphs).strip()


class _ChunkBuilder:
    """Build chunks one at a time, counting the overlap prefix toward the limit."""

    __slots__ = (
        "chunks",
        "fresh_room",
        "has_content",
        "max_chars",
        "min_fill_room",
        "overlap",
        "_pieces",
        "_size",
    )

    def __init__(self, max_chars: int, overlap: int) -> None:
        self.chunks: list[str] = []
        self.max_chars = max_chars
        self.overlap = overlap
        # With less room than this left, start a new chunk rather than split a paragraph.
        self.min_fill_room = max_chars // 4
        # Room every new chunk is guaranteed after its overlap prefix and separator.
        self.fresh_room = max_chars - overlap - 2 if overlap else max_chars
        # False while the chunk holds nothing but the previous chunk's overlap tail.
        self.has_content = False
        self._pieces: list[str] = []
        self._size = 0

    def room(self) -> int:
        """Characters available for the next piece after its separator."""

        if not self._pieces:
            return self.max_chars
        return self.max_chars - self._size - 2

    def add(self, piece: str) -> None:
        if self._pieces:
            self._size += 2
        self._pieces.append(piece)
        self._size += len(piece)
        self.has_content = True

    def flush(self) -> None:
        if not self.has_content:
            return
        chunk = "\n\n".join(self._pieces)
        self.chunks.append(chunk)
        prefix = chunk[-self.overlap :].strip() if self.overlap > 0 else ""
        self._pieces = [prefix] if prefix else []
        self._size = len(prefix)
        self.has_content = False


def _pack_paragraph(builder: _ChunkBuilder, paragraph: str) -> None:
    length = len(paragraph)
    if length <= builder.room():
        builder.add(paragraph)
        return

    breaks: tuple[list[int], list[int]] | None = None
    start = 0
    while start < length:
        room = builder.room()
        if length - start <= room:
            builder.add(paragraph[start:])
            return
        if builder.has_content and room < builder.min_fill_room:
            builder.flush()
            continue
        if breaks is None:
            breaks = _sentence_breaks(paragraph)
        end, next_start = _fill_cut(
            paragraph,
            start,
            room,
            breaks,
            defer_room=builder.fresh_room if builder.has_content else None,
        )
        if end > start:
            builder.add(paragraph[start:end])
            start = next_start
        # Either the chunk is now full or the next piece was deferred to a new
        # chunk. A deferral only happens while the chunk has content, so the
        # following pass always makes progress.
        builder.flush()


def _sentence_breaks(paragraph: str) -> tuple[list[int], list[int]]:
    """Return sentence end offsets and the matching next-sentence start offsets."""

    ends: list[int] = []
    starts: list[int] = []
    for match in _SENTENCE_BREAK.finditer(paragraph):
        ends.append(match.start())
        starts.append(match.end())
    ends.append(len(paragraph))
    starts.append(len(paragraph))
    return ends, starts


def _fill_cut(
    paragraph: str,
    start: int,
    room: int,
    breaks: tuple[list[int], list[int]],
    *,
    defer_room: int | None,
) -> tuple[int, int]:
    """Choose where to cut ``paragraph[start:]`` so the head fits in ``room``.

    Returns ``(end, next_start)``. Whole sentences are preferred, then whole
    words; only a single token longer than the room is sliced mid-token. With
    ``defer_room`` set (the chunk already has content), a sentence or token that
    would fit intact in a fresh chunk is deferred by returning ``end == start``.
    """

    ends, starts = breaks
    limit = start + room
    index = bisect_right(ends, limit) - 1
    if index >= 0 and ends[index] > start:
        return ends[index], starts[index]
    sentence_end = ends[bisect_right(ends, start)]
    if defer_room is not None and sentence_end - start <= defer_room:
        return start, start
    space = paragraph.rfind(" ", start, limit + 1)
    if space > start:
        return space, space + 1
    if defer_room is not None and paragraph.find(" ", start, start + defer_room + 1) != -1:
        return start, start
    end = start + max(1, room)
    return end, end


_SEGMENT_READERS: dict[str, Callable[[BinarySource, _Options], list[ExtractedSegment]]] = {
    "docx": _read_docx,
    "xlsx": _read_xlsx,
    "pptx": _read_pptx,
    "eml": _read_eml,
    "msg": _read_msg,
    "html": _read_html,
    "pdf": _read_pdf,
    "rtf": _read_rtf,
    "image": _read_image,
    "text": _read_text,
}
_METADATA_READERS: dict[str, Callable[[BinarySource], list[tuple[str, Any]]]] = {
    "docx": office_metadata,
    "xlsx": office_metadata,
    "pptx": office_metadata,
    "pdf": pdf_metadata,
    "image": image_metadata,
    "eml": _eml_metadata,
    "msg": _msg_metadata,
}
