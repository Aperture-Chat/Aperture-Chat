from __future__ import annotations

import html
import mimetypes
import os
import re
import zipfile
from bisect import bisect_right
from collections.abc import Iterable, Iterator
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from email import policy
from email.parser import BytesParser
from io import BytesIO
from typing import Any, BinaryIO

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

MAX_EXTRACTED_TEXT_CHARS = 10_000_000
DEFAULT_CHUNK_CHARS = 1200
DEFAULT_CHUNK_OVERLAP = 160
DEFAULT_OCR_MAX_PAGES = 250
DEFAULT_OCR_PAGE_TIMEOUT_SECONDS = 45.0
MIN_PDF_PAGE_TEXT_CHARS = 40
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


def extract_text(
    filename: str,
    content: bytes,
    mime_type: str | None = None,
    *,
    max_chars: int = MAX_EXTRACTED_TEXT_CHARS,
    ocr_enabled: bool = True,
    ocr_max_pages: int = DEFAULT_OCR_MAX_PAGES,
    ocr_page_timeout_seconds: float = DEFAULT_OCR_PAGE_TIMEOUT_SECONDS,
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
        )
    )


def extract_segments(
    filename: str,
    content: bytes,
    mime_type: str | None = None,
    *,
    max_chars: int = MAX_EXTRACTED_TEXT_CHARS,
    ocr_enabled: bool = True,
    ocr_max_pages: int = DEFAULT_OCR_MAX_PAGES,
    ocr_page_timeout_seconds: float = DEFAULT_OCR_PAGE_TIMEOUT_SECONDS,
) -> list[ExtractedSegment]:
    return _extract_segments_from_source(
        filename,
        content,
        mime_type,
        max_chars=max_chars,
        ocr_enabled=ocr_enabled,
        ocr_max_pages=ocr_max_pages,
        ocr_page_timeout_seconds=ocr_page_timeout_seconds,
    )


def extract_text_from_file(
    filename: str,
    file: BinaryIO,
    mime_type: str | None = None,
    *,
    max_chars: int = MAX_EXTRACTED_TEXT_CHARS,
    ocr_enabled: bool = True,
    ocr_max_pages: int = DEFAULT_OCR_MAX_PAGES,
    ocr_page_timeout_seconds: float = DEFAULT_OCR_PAGE_TIMEOUT_SECONDS,
) -> str | None:
    return _segments_text(
        extract_segments_from_file(
            filename,
            file,
            mime_type,
            max_chars=max_chars,
            ocr_enabled=ocr_enabled,
            ocr_max_pages=ocr_max_pages,
            ocr_page_timeout_seconds=ocr_page_timeout_seconds,
        )
    )


def extract_segments_from_file(
    filename: str,
    file: BinaryIO,
    mime_type: str | None = None,
    *,
    max_chars: int = MAX_EXTRACTED_TEXT_CHARS,
    ocr_enabled: bool = True,
    ocr_max_pages: int = DEFAULT_OCR_MAX_PAGES,
    ocr_page_timeout_seconds: float = DEFAULT_OCR_PAGE_TIMEOUT_SECONDS,
) -> list[ExtractedSegment]:
    return _extract_segments_from_source(
        filename,
        file,
        mime_type,
        max_chars=max_chars,
        ocr_enabled=ocr_enabled,
        ocr_max_pages=ocr_max_pages,
        ocr_page_timeout_seconds=ocr_page_timeout_seconds,
    )


def _extract_segments_from_source(
    filename: str,
    source: BinarySource,
    mime_type: str | None,
    *,
    max_chars: int,
    ocr_enabled: bool,
    ocr_max_pages: int,
    ocr_page_timeout_seconds: float,
) -> list[ExtractedSegment]:
    extension = _extension(filename)
    guessed_mime = (mime_type or mimetypes.guess_type(filename)[0] or "").split(";", 1)[0]
    guessed_mime = guessed_mime.strip().lower()

    segments: list[ExtractedSegment]
    if extension == ".docx" or guessed_mime == _DOCX_MIME_TYPE:
        segments = _extract_docx_segments(source)
    elif extension == ".xlsx" or guessed_mime == _XLSX_MIME_TYPE:
        segments = _extract_xlsx_segments(source)
    elif extension == ".pptx" or guessed_mime == _PPTX_MIME_TYPE:
        segments = _extract_pptx_segments(source)
    elif extension == ".eml" or guessed_mime in _EML_MIME_TYPES:
        segments = _extract_eml_segments(source)
    elif extension == ".msg" or guessed_mime in _MSG_MIME_TYPES:
        segments = _extract_msg_segments(source)
    elif extension in _HTML_EXTENSIONS or guessed_mime == "text/html":
        content = _read_source_bytes(source, max_chars=max_chars)
        text = _extract_html_text(_decode_text(content))
        segments = [ExtractedSegment(text=text)] if text else []
    elif extension == ".pdf" or guessed_mime == "application/pdf":
        segments = _extract_pdf_segments(
            source,
            ocr_enabled=ocr_enabled,
            ocr_max_pages=ocr_max_pages,
            ocr_page_timeout_seconds=ocr_page_timeout_seconds,
        )
    elif extension in _IMAGE_EXTENSIONS or guessed_mime.startswith("image/"):
        if not ocr_enabled:
            segments = []
        else:
            segments = _extract_image_segments(
                source,
                ocr_max_pages=ocr_max_pages,
                ocr_page_timeout_seconds=ocr_page_timeout_seconds,
            )
    elif (
        extension in _TEXT_EXTENSIONS
        or guessed_mime.startswith("text/")
        or guessed_mime in {"application/json", "application/xml"}
    ):
        content = _read_source_bytes(source, max_chars=max_chars)
        text = _decode_text(content)
        if extension == ".rtf":
            text = _extract_rtf_text(text)
        segments = [ExtractedSegment(text=text)] if text else []
    else:
        segments = []
    return _limit_segments(segments, max_chars=max_chars)


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


def _decode_text(content: bytes) -> str:
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("latin-1", errors="replace")


def _extract_docx_segments(source: BinarySource) -> list[ExtractedSegment]:
    try:
        _rewind_source(source)
        archive_source = BytesIO(source) if isinstance(source, bytes) else source
        with zipfile.ZipFile(archive_source) as archive:
            document_xml = archive.read("word/document.xml")
    except (KeyError, OSError, zipfile.BadZipFile):
        return []
    try:
        root = ElementTree.fromstring(document_xml)
    except (ElementTree.ParseError, DefusedXmlException):
        return []

    body = next((element for element in root.iter() if _local_name(element.tag) == "body"), None)
    if body is None:
        return []

    blocks: list[str] = []
    for element in body:
        name = _local_name(element.tag)
        if name == "p":
            text = _word_paragraph_text(element)
            if text:
                blocks.append(text)
        elif name == "tbl":
            table_text = _word_table_text(element)
            if table_text:
                blocks.append(table_text)
    if not blocks:
        return []
    return [ExtractedSegment(text="\n\n".join(blocks))]


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


def _extract_pptx_segments(source: BinarySource) -> list[ExtractedSegment]:
    try:
        from pptx import Presentation  # type: ignore[import-not-found]
    except ImportError:
        return []

    try:
        presentation = Presentation(BytesIO(_read_all_source_bytes(source)))
    except Exception:
        return []

    segments: list[ExtractedSegment] = []
    for index, slide in enumerate(presentation.slides, start=1):
        blocks: list[str] = []
        for shape in slide.shapes:
            blocks.extend(_pptx_shape_blocks(shape))
        text = "\n\n".join(block for block in blocks if block.strip())
        if text:
            segments.append(ExtractedSegment(text=text, locator=f"Slide {index}"))
    return segments


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


def _extract_eml_segments(source: BinarySource) -> list[ExtractedSegment]:
    try:
        message = BytesParser(policy=policy.default).parsebytes(_read_all_source_bytes(source))
    except Exception:
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
    return [ExtractedSegment(text=text)] if text else []


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


def _extract_msg_segments(source: BinarySource) -> list[ExtractedSegment]:
    try:
        from oxmsg import Message  # type: ignore[import-not-found]
    except ImportError:
        return []

    content = _read_all_source_bytes(source)
    if not content:
        return []
    try:
        message = Message.load(content)
    except Exception:
        return []

    raw_headers = getattr(message, "message_headers", {})
    headers_by_name = (
        {str(name).casefold(): value for name, value in raw_headers.items()}
        if isinstance(raw_headers, dict)
        else {}
    )
    sent_date = getattr(message, "sent_date", None)
    headers = _email_header_lines(
        {
            "From": getattr(message, "sender", None) or headers_by_name.get("from"),
            "To": headers_by_name.get("to"),
            "Cc": headers_by_name.get("cc"),
            "Date": sent_date.isoformat() if sent_date is not None else headers_by_name.get("date"),
            "Subject": getattr(message, "subject", None) or headers_by_name.get("subject"),
        }
    )
    plain_body = getattr(message, "body", None)
    if plain_body is not None:
        body = str(plain_body)
    else:
        body = ""
        html_body = getattr(message, "html_body", None)
        if isinstance(html_body, bytes):
            html_body = _decode_text(html_body)
        if isinstance(html_body, str):
            body = _extract_html_text(html_body)
    text = "\n\n".join(part for part in (headers, body) if part)
    return [ExtractedSegment(text=text)] if text else []


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
    without_scripts = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", text)
    without_tags = re.sub(r"(?s)<[^>]+>", " ", without_scripts)
    return html.unescape(without_tags)


def _extract_rtf_text(text: str) -> str:
    text = re.sub(r"\\'[0-9a-fA-F]{2}", " ", text)
    text = re.sub(r"\\[a-zA-Z]+-?\d* ?", " ", text)
    text = text.replace("{", " ").replace("}", " ").replace("\\", " ")
    return text


def _extract_pdf_segments(
    source: BinarySource,
    *,
    ocr_enabled: bool,
    ocr_max_pages: int,
    ocr_page_timeout_seconds: float,
) -> list[ExtractedSegment]:
    try:
        from pypdf import PdfReader  # type: ignore[import-not-found]
    except ImportError:
        return []
    try:
        _rewind_source(source)
        reader_source = BytesIO(source) if isinstance(source, bytes) else source
        reader = PdfReader(reader_source)
        page_texts = [_normalize_text(page.extract_text() or "") for page in reader.pages]
    except Exception:
        return []

    if ocr_enabled:
        pages_needing_ocr = [
            index
            for index, text in enumerate(page_texts[:ocr_max_pages])
            if len(text) < MIN_PDF_PAGE_TEXT_CHARS
        ]
        if pages_needing_ocr:
            ocr_text = _ocr_pdf_pages(
                source,
                pages_needing_ocr,
                timeout_seconds=ocr_page_timeout_seconds,
            )
            for page_index, text in ocr_text.items():
                if text:
                    page_texts[page_index] = text

    return [
        ExtractedSegment(
            text=text,
            page_start=index,
            page_end=index,
            locator=f"Page {index}",
        )
        for index, text in enumerate(page_texts, start=1)
        if text
    ]


def _ocr_pdf_pages(
    source: BinarySource,
    page_indexes: list[int],
    *,
    timeout_seconds: float,
) -> dict[int, str]:
    try:
        import pypdfium2 as pdfium  # type: ignore[import-not-found]
    except ImportError:
        return {}

    _rewind_source(source)
    pdf_source = source if isinstance(source, bytes) else source
    try:
        pdf = pdfium.PdfDocument(pdf_source)
    except Exception:
        return {}

    try:
        page_count = len(pdf)
        indexes = [page_index for page_index in page_indexes if page_index < page_count]
        return _ocr_pages(
            _render_pdf_pages(pdf, indexes),
            workers=min(_ocr_worker_count(), len(indexes)),
            timeout_seconds=timeout_seconds,
        )
    finally:
        pdf.close()


def _render_pdf_pages(pdf: Any, page_indexes: list[int]) -> Iterator[_OcrPage]:
    # pypdfium2 is not thread-safe, so rendering happens here on the consuming
    # thread and _ocr_pages also closes pages and bitmaps on that thread.
    for page_index in page_indexes:
        page = bitmap = image = None
        try:
            page = pdf[page_index]
            bitmap = page.render(scale=2, rotation=0)
            image = bitmap.to_pil()
        except Exception:
            _close_all(image, bitmap, page)
            continue
        yield _OcrPage(page_index, image, (image, bitmap, page))


def _extract_image_segments(
    source: BinarySource,
    *,
    ocr_max_pages: int,
    ocr_page_timeout_seconds: float,
) -> list[ExtractedSegment]:
    try:
        from PIL import Image  # type: ignore[import-not-found]
    except ImportError:
        return []

    _rewind_source(source)
    image_source = BytesIO(source) if isinstance(source, bytes) else source
    try:
        with Image.open(image_source) as image:
            multi_frame = ocr_max_pages > 1 and bool(getattr(image, "is_animated", False))
            texts = _ocr_pages(
                _copy_image_frames(image, ocr_max_pages),
                workers=_ocr_worker_count() if multi_frame else 1,
                timeout_seconds=ocr_page_timeout_seconds,
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


def _ocr_pages(
    pages: Iterable[_OcrPage],
    *,
    workers: int,
    timeout_seconds: float,
) -> dict[int, str]:
    """OCR pages into ``{page index: text}``, skipping any page that fails.

    ``pages`` is consumed, and every page closed, on the calling thread; only
    ``_ocr_image`` runs on worker threads. At most ``2 * workers`` pages are held
    at once so long scanned documents do not accumulate rendered images.
    """

    results: dict[int, str] = {}
    if workers <= 1:
        for page in pages:
            try:
                results[page.index] = _ocr_image(page.image, timeout_seconds=timeout_seconds)
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
                    future = executor.submit(
                        _ocr_image, page.image, timeout_seconds=timeout_seconds
                    )
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
