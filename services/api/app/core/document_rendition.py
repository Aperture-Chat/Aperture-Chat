"""Turn a stored knowledge file into something a browser can show.

PDFs and images are shown as they are, except TIFF scans, which no browser draws
and which become a PDF here. Office, RTF, and OpenDocument files become a PDF
through headless LibreOffice, lazily on first view, cached beside the original.

Converting a stranger's document on the server is a known way to read local
files and reach internal hosts: a document can link images, embed OLE links,
pull in text through fields, nest other documents, and refer to other workbooks.
Parsers are what fail here, so the wall that has to hold is not a parser:

1. The operating system. When the API is root, LibreOffice runs as a dedicated
   account with no extra groups, in scratch space outside the data volume. That
   account cannot read the originals, the databases, or the API's environment,
   so a read this module never thought of still finds nothing. The API refuses
   to convert at all if it cannot drop to that account, except when
   ``APERTURE_ENV=local``.
2. What goes in. The format comes from the bytes and picks the import filter.
   LibreOffice never sees the file, only a package rebuilt from an allowlist:
   parts a rendition needs, relationships of known kinds pointing at those parts,
   and pictures whose headers really are pictures. Only an image relationship can
   reach a part not named as XML, so a picture cannot play a document. Nothing
   external survives, whatever it calls itself. A document that nests another
   document, or an OpenDocument file naming an outside resource, is refused by its
   structure, not its labels.
3. The profile. Each run gets a fresh one with macros, active content, and link
   updates off, every link from the document blocked, and a proxy that goes
   nowhere. The SVG, EPS, and HTML importers are removed outright: they read
   local files past every setting above. Pictures Office saved with a PNG
   fallback still show. Active content goes on for one case: a document with
   charts, which are embedded objects, and nothing active beside them. A document
   with both loses the chart, which is the safe way to lose.
4. The process. Its own group, a minimal environment, resource limits, one at a
   time, and a hard deadline. Scans go the same way: Pillow never decodes a
   stranger's TIFF in the API process.

Any failure at any step means the text view, never a 500.
"""

from __future__ import annotations

import json
import logging
import math
import mimetypes
import os
import posixpath
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
import zlib
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Final
from urllib.parse import unquote
from xml.etree import ElementTree
from xml.parsers import expat

from defusedxml import ElementTree as SafeElementTree
from defusedxml.common import DefusedXmlException
import pypdfium2

from app.core.document_view import match_key
from app.core.knowledge_originals import DocumentRef, KnowledgeOriginalStore
from app.core.pdfium_lock import PDFIUM_LOCK
from app.models.schemas import KnowledgeDocumentViewMode, KnowledgeDocumentViewNotice

logger = logging.getLogger("aperture.knowledge.rendition")

_SNIFF_BYTES = 4096
_PDF_SIGNATURE = b"%PDF-"
# Readers tolerate a little junk before the header, so real files have some.
_PDF_HEADER_WINDOW = 1024
PDF_CONTENT_TYPE = "application/pdf"
RENDITION_NAME = "rendition.pdf"
_PAGES_NAME = "pages.json"
_FAILURE_NAME = "rendition.failed"
# A failure is remembered so a hostile file cannot cost a full timeout on every
# click, and forgotten so a transient one (memory, a kill) gets another try.
_FAILURE_RETRY_SECONDS = 60 * 60
# Beyond these a package is a bomb or not a document anyone meant to view.
_MAX_PACKAGE_ENTRIES = 20_000
_MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
_MAX_RELATIONSHIPS_BYTES = 4 * 1024 * 1024
_MAX_PATCHED_SHEET_BYTES = 64 * 1024 * 1024
_MAX_TYPES_BYTES = 4 * 1024 * 1024
# Requests that may wait for the converter. More than this is told to come back
# rather than holding threads the whole API shares.
_MAX_WAITING_CONVERSIONS = 3
_MAX_OUTPUT_BYTES = 1024 * 1024 * 1024
_MAX_SCAN_PAGES = 1000
# A thousand letter pages at 300 dpi, plus room for larger sheets.
_MAX_SCAN_PIXELS = 12_000_000_000
_SCAN_WORKER = Path(__file__).with_name("scan_worker.py")
_SCRATCH_PREFIX = "aperture-render-"
RENDITION_ACCOUNT = "aperture-render"
_MAX_OPEN_FILES = 4096
_FILE_SIZE_BLOCK_BYTES = 512
_CLOSED_PROXY_HOST = "127.0.0.1"
_CLOSED_PROXY_PORT = 9
_CLOSED_PROXY_URL = f"http://{_CLOSED_PROXY_HOST}:{_CLOSED_PROXY_PORT}"
_MAC_SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice"

_IMAGE_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)
# "BM" alone is also how a lot of text starts, so the header size must be real.
_BMP_HEADER_SIZES = frozenset({12, 40, 52, 56, 64, 108, 124})
_TIFF_SIGNATURES = (b"II*\x00", b"MM\x00*")
TIFF_CONTENT_TYPE = "image/tiff"


class ConversionError(Exception):
    """This file cannot be turned into a PDF. The reason stays in the server log."""


@dataclass(frozen=True, slots=True)
class OfficeFormat:
    extension: str
    content_type: str
    input_filter: str
    output_filter: str


_WORD: Final = OfficeFormat(
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "MS Word 2007 XML",
    "pdf:writer_pdf_Export",
)
_EXCEL: Final = OfficeFormat(
    "xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Calc MS Excel 2007 XML",
    "pdf:calc_pdf_Export",
)
# Hidden slides stay in, so "Slide 7" from the index is page 7 of the PDF.
_IMPRESS_EXPORT: Final = (
    'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'
)
_POWERPOINT: Final = OfficeFormat(
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "Impress MS PowerPoint 2007 XML",
    _IMPRESS_EXPORT,
)
_RTF: Final = OfficeFormat("rtf", "application/rtf", "Rich Text Format", "pdf:writer_pdf_Export")
_ODF_FORMATS: Final[dict[str, OfficeFormat]] = {
    "application/vnd.oasis.opendocument.text": OfficeFormat(
        "odt", "application/vnd.oasis.opendocument.text", "writer8", "pdf:writer_pdf_Export"
    ),
    "application/vnd.oasis.opendocument.spreadsheet": OfficeFormat(
        "ods", "application/vnd.oasis.opendocument.spreadsheet", "calc8", "pdf:calc_pdf_Export"
    ),
    "application/vnd.oasis.opendocument.presentation": OfficeFormat(
        "odp",
        "application/vnd.oasis.opendocument.presentation",
        "impress8",
        _IMPRESS_EXPORT,
    ),
}
_OOXML_MAIN_PARTS: Final[dict[str, OfficeFormat]] = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml": _WORD,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml": _WORD,
    "application/vnd.ms-word.document.macroenabled.main+xml": _WORD,
    "application/vnd.ms-word.template.macroenabledtemplate.main+xml": _WORD,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml": _EXCEL,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml": _EXCEL,
    "application/vnd.ms-excel.sheet.macroenabled.main+xml": _EXCEL,
    "application/vnd.ms-excel.template.macroenabled.main+xml": _EXCEL,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml": _POWERPOINT,
    "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml": _POWERPOINT,
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml": _POWERPOINT,
    "application/vnd.ms-powerpoint.presentation.macroenabled.main+xml": _POWERPOINT,
    "application/vnd.ms-powerpoint.template.macroenabled.main+xml": _POWERPOINT,
    "application/vnd.ms-powerpoint.slideshow.macroenabled.main+xml": _POWERPOINT,
}

_SCRIPTING = "/org.openoffice.Office.Common/Security/Scripting"
_WRITER_UPDATE = "/org.openoffice.Office.Writer/Content/Update"
_CALC_UPDATE = "/org.openoffice.Office.Calc/Content/Update"
_CALC_LOAD = "/org.openoffice.Office.Calc/Formula/Load"
_INTERNET = "/org.openoffice.Inet/Settings"
_NEVER_UPDATE_WRITER = "0"
_NEVER_UPDATE_CALC = "1"
_NEVER_RECALCULATE = "1"
_MANUAL_PROXY = "2"
_PROFILE_SETTINGS: Final[tuple[tuple[str, str, str], ...]] = (
    (_SCRIPTING, "DisableMacrosExecution", "true"),
    (_SCRIPTING, "MacroSecurityLevel", "3"),
    (_SCRIPTING, "BlockUntrustedRefererLinks", "true"),
    (_SCRIPTING, "SecureURL", ""),
    (_WRITER_UPDATE, "Link", _NEVER_UPDATE_WRITER),
    (_WRITER_UPDATE, "Field", "false"),
    (_CALC_UPDATE, "Link", _NEVER_UPDATE_CALC),
    (_CALC_LOAD, "OOXMLRecalcMode", _NEVER_RECALCULATE),
    (_CALC_LOAD, "ODFRecalcMode", _NEVER_RECALCULATE),
    (_INTERNET, "ooInetProxyType", _MANUAL_PROXY),
    (_INTERNET, "ooInetNoProxy", ""),
    (_INTERNET, "ooInetHTTPProxyName", _CLOSED_PROXY_HOST),
    (_INTERNET, "ooInetHTTPProxyPort", str(_CLOSED_PROXY_PORT)),
    (_INTERNET, "ooInetHTTPSProxyName", _CLOSED_PROXY_HOST),
    (_INTERNET, "ooInetHTTPSProxyPort", str(_CLOSED_PROXY_PORT)),
    (_INTERNET, "ooInetFTPProxyName", _CLOSED_PROXY_HOST),
    (_INTERNET, "ooInetFTPProxyPort", str(_CLOSED_PROXY_PORT)),
)
_GRAPHIC_FILTERS = "/org.openoffice.TypeDetection.GraphicFilter/Filters"
# EPS goes too: its importer shells out to Ghostscript and friends when present.
_REMOVED_GRAPHIC_FILTERS: Final[tuple[str, ...]] = ("svg_Import", "svgz_Import", "eps_Import")
_DOCUMENT_FILTERS = "/org.openoffice.TypeDetection.Filter/Filters"
# The HTML import reads <img> sources from any local path past every setting here.
_REMOVED_DOCUMENT_FILTERS: Final[tuple[str, ...]] = (
    "HTML (StarWriter)",
    "writerglobal8_HTML",
    "writerweb8_writer",
    "HTML",
    "HTML (StarCalc)",
    "impress_html_Export",
    "writer_web_HTML_help",
)
_LIMITS_SCRIPT = (
    'ulimit -c 0; ulimit -t "$1"; ulimit -f "$2"; ulimit -n "$3"; '
    'ulimit -v "$4" 2>/dev/null || :; shift 4; exec "$@"'
)


@dataclass(frozen=True, slots=True)
class RenditionOptions:
    soffice: str | None
    timeout_seconds: float
    memory_mb: int
    # False only for APERTURE_ENV=local: a laptop has no account to drop to.
    require_isolation: bool = True
    # What the account is walled from. If any of these can be entered, it is not.
    private_directories: tuple[Path, ...] = ()


@dataclass(frozen=True, slots=True)
class SandboxAccount:
    uid: int
    gid: int


Converter = Callable[[Path, Path], Path]


@dataclass(frozen=True, slots=True)
class PreparedDocument:
    mode: KnowledgeDocumentViewMode
    content_type: str
    original_available: bool
    file_path: Path | None = None
    page_count: int | None = None
    notice: KnowledgeDocumentViewNotice | None = None


_conversion_lock = threading.Lock()
_conversion_queue = threading.BoundedSemaphore(_MAX_WAITING_CONVERSIONS)


def find_soffice(configured: str | None = None) -> str | None:
    """The first runnable LibreOffice: the configured path, PATH, the Mac app."""
    candidates = (
        configured,
        shutil.which("soffice"),
        shutil.which("libreoffice"),
        _MAC_SOFFICE,
    )
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


# ------------------------------------------------------------------- sniffing


def rendition_account() -> SandboxAccount | None:
    """The account conversions drop to, or None if this process cannot drop."""
    if os.geteuid() != 0:
        return None
    try:
        entry = pwd.getpwnam(RENDITION_ACCOUNT)
    except KeyError:
        return None
    return SandboxAccount(entry.pw_uid, entry.pw_gid)


def _is_private(directory: Path) -> bool:
    """Only this process's user can enter it. Startup sets that and only logs a
    failure, so the wall is checked here, where a failure can still refuse."""
    try:
        details = directory.stat()
    except OSError:
        return False
    return details.st_uid == os.geteuid() and stat.S_IMODE(details.st_mode) & 0o077 == 0


def _may_convert(options: RenditionOptions) -> bool:
    if not options.require_isolation:
        return True
    return rendition_account() is not None and all(
        _is_private(directory) for directory in options.private_directories
    )


def _sniff_image(head: bytes) -> str | None:
    for signature, content_type in _IMAGE_SIGNATURES:
        if head.startswith(signature):
            return content_type
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:2] == b"BM" and int.from_bytes(head[14:18], "little") in _BMP_HEADER_SIZES:
        return "image/bmp"
    return None


def _odf_format(archive: zipfile.ZipFile) -> OfficeFormat | None:
    try:
        info = archive.getinfo("mimetype")
    except KeyError:
        return None
    if info.file_size > 256:
        return None
    return _ODF_FORMATS.get(archive.read(info).decode("ascii", "replace").strip())


def _ooxml_format(archive: zipfile.ZipFile) -> OfficeFormat | None:
    try:
        info = archive.getinfo("[Content_Types].xml")
    except KeyError:
        return None
    if info.file_size > _MAX_TYPES_BYTES:
        return None
    root = SafeElementTree.fromstring(archive.read(info))
    for element in root.iter():
        declared = element.get("ContentType", "").lower()
        if declared in _OOXML_MAIN_PARTS:
            return _OOXML_MAIN_PARTS[declared]
    return None


# ``zipfile`` raises RuntimeError for a password-protected entry and
# NotImplementedError for a compression method it does not know.
_UNREADABLE_PACKAGE = (
    zipfile.BadZipFile,
    ElementTree.ParseError,
    DefusedXmlException,
    RuntimeError,
    NotImplementedError,
    EOFError,
    OSError,
    zlib.error,
)


def sniff_office_format(path: Path) -> OfficeFormat | None:
    """The allowlisted format these bytes really are, whatever the file is called."""
    with path.open("rb") as handle:
        head = handle.read(8)
    if head.startswith(b"{\\rtf"):
        return _RTF
    if not head.startswith(b"PK\x03\x04"):
        return None
    try:
        with zipfile.ZipFile(path) as archive:
            return _odf_format(archive) or _ooxml_format(archive)
    except _UNREADABLE_PACKAGE:
        return None


# ----------------------------------------------------- the copy LibreOffice sees


_RTF_FIELD_INSTRUCTION = re.compile(rb"(?:\\\*\s*)?\\fldinst(?![a-zA-Z])", re.IGNORECASE)
_RTF_LINKED_OBJECT = re.compile(rb"\\(?:objlink|objautlink|objupdate)(?![a-zA-Z])", re.IGNORECASE)


def _sanitize_rtf(source: Path, target: Path) -> None:
    """Fields are the way out of an RTF file, and its importer follows some of
    them without asking any setting. Removing every instruction leaves each
    field's saved result on the page, and a control word cannot be disguised:
    RTF has no escape for one."""
    data = source.read_bytes()
    data = _RTF_FIELD_INSTRUCTION.sub(rb"\\*\\aperturefieldremoved", data)
    target.write_bytes(_RTF_LINKED_OBJECT.sub(rb"\\aperturelinkremoved", data))


def _check_package_shape(archive: zipfile.ZipFile) -> None:
    entries = archive.infolist()
    if len(entries) > _MAX_PACKAGE_ENTRIES:
        raise ConversionError("Package has too many entries.")
    if sum(entry.file_size for entry in entries) > _MAX_PACKAGE_BYTES:
        raise ConversionError("Package expands too far.")
    names = [entry.filename for entry in entries]
    if len(set(names)) != len(names):
        raise ConversionError("Package repeats a part name.")


_PNG_HEADER = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
_GZIP_SIGNATURE = b"\x1f\x8b"
_EMF_SIGNATURE = b" EMF"
_EMF_VERSION = 0x10000
_EMF_MINIMUM_HEADER = 88
_WMF_PLACEABLE_KEY = b"\xd7\xcd\xc6\x9a"
_WMF_PLACEABLE_HEADER = 22
_WMF_HEADER_WORDS = 9
_WMF_VERSIONS = frozenset({0x0100, 0x0300})
_JPEG_FIRST_MARKER = b"\xc0"
_JPEG_LAST_MARKER = b"\xfe"
_WEBP_CHUNKS = (b"VP8 ", b"VP8L", b"VP8X")
_ODF_PREVIEW_SIGNATURE = b"VCLMTF"


def _little(head: bytes, start: int, width: int = 4) -> int:
    return int.from_bytes(head[start : start + width], "little")


def _is_png(head: bytes, _size: int) -> bool:
    return head.startswith(_PNG_HEADER)


def _is_jpeg(head: bytes, _size: int) -> bool:
    return head[:3] == b"\xff\xd8\xff" and _JPEG_FIRST_MARKER <= head[3:4] <= _JPEG_LAST_MARKER


def _is_gif(head: bytes, _size: int) -> bool:
    return head[:6] in (b"GIF87a", b"GIF89a") and _little(head, 6, 2) > 0 and _little(head, 8, 2) > 0


def _is_webp(head: bytes, _size: int) -> bool:
    return head[:4] == b"RIFF" and head[8:12] == b"WEBP" and head[12:16] in _WEBP_CHUNKS


def _is_bmp(head: bytes, _size: int) -> bool:
    return _sniff_image(head) == "image/bmp"


def _is_tiff(head: bytes, size: int) -> bool:
    if head[:4] == b"II*\x00":
        directory = _little(head, 4)
    elif head[:4] == b"MM\x00*":
        directory = int.from_bytes(head[4:8], "big")
    else:
        return False
    return 8 <= directory < size


def _is_emf(head: bytes, size: int) -> bool:
    """The whole header, because the signature alone sits at offset 40 and the
    bytes before it are free: XML can open with a comment that reaches it."""
    record_size = _little(head, 4)
    return (
        _little(head, 0) == 1
        and record_size >= _EMF_MINIMUM_HEADER
        and record_size % 4 == 0
        and head[40:44] == _EMF_SIGNATURE
        and _little(head, 44) == _EMF_VERSION
        and 0 < _little(head, 48) <= size
    )


def _is_wmf(head: bytes, _size: int) -> bool:
    start = _WMF_PLACEABLE_HEADER if head.startswith(_WMF_PLACEABLE_KEY) else 0
    return (
        _little(head, start, 2) in (1, 2)
        and _little(head, start + 2, 2) == _WMF_HEADER_WORDS
        and _little(head, start + 4, 2) in _WMF_VERSIONS
    )


# A picture by its header, not a signature: a real header cannot open an XML, HTML,
# or OLE part, and a zip with one in front is still only ever drawn.
_PICTURE_HEADERS: Final = (_is_png, _is_jpeg, _is_gif, _is_webp, _is_bmp, _is_tiff, _is_emf, _is_wmf)


def _is_plain_picture(head: bytes, size: int) -> bool:
    return any(is_this_format(head, size) for is_this_format in _PICTURE_HEADERS)


def _is_picture(head: bytes, size: int) -> bool:
    """Gzip is allowed only around a metafile, which is what an .emz or .wmz is;
    an .svgz is not. The inflated size is not known, so it is not the bound."""
    if not head.startswith(_GZIP_SIGNATURE):
        return _is_plain_picture(head, size)
    try:
        inflated = zlib.decompressobj(_GZIP_WINDOW).decompress(head, _SNIFF_BYTES)
    except zlib.error:
        return False
    return _is_emf(inflated, _MAX_PACKAGE_BYTES) or _is_wmf(inflated, _MAX_PACKAGE_BYTES)


_GZIP_WINDOW = zlib.MAX_WBITS | 16
_NESTING_ELEMENTS = frozenset({"altChunk", "subDoc"})
_ACTIVE_ELEMENTS = frozenset({"OLEObject", "oleObj", "oleObject", "control", "ddeLink"})
_SIMPLE_FIELD = "fldSimple"
_FIELD_INSTRUCTION = "instrText"
_ACTIVE_FIELD = re.compile(r"\b(?:DDE|DDEAUTO|LINK|INCLUDETEXT|INCLUDEPICTURE|IMPORT)\b", re.IGNORECASE)
_CHART_ROOT = "chartSpace"
_FOREIGN_ROOTS = frozenset({"svg", "html"})
_XML_PART_SUFFIXES = (".xml", ".vml")
# Readable XML with nothing to draw: properties, and custom data whose bindings
# LibreOffice would otherwise follow.
_UNDRAWN_FOLDERS = ("customXml/", "docProps/")


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _refuse_entities(*_details: object) -> None:
    raise ConversionError("Document declares an entity.")


@dataclass(frozen=True, slots=True)
class _XmlPart:
    root: str
    active: bool


def _read_xml_part(part: BinaryIO) -> _XmlPart:
    """What a part is and whether it carries anything active, refusing a part that
    nests a document.

    Parsed by expat directly: it reads any encoding a part declares, it finds an
    element wherever markup compatibility wrapped it, and no tree is built, so a
    huge part costs no memory. LibreOffice finds a nested document by relationship
    id and never reads the relationship's Type, so the element is what counts.
    """
    roots: list[str] = []
    active: list[str] = []
    field_text: list[str] = []
    parser = expat.ParserCreate(namespace_separator="}")

    def start_element(tag: str, attributes: dict[str, str]) -> None:
        name = _local_name(tag)
        if name in _NESTING_ELEMENTS:
            raise ConversionError("Document nests another document.")
        if not roots:
            roots.append(name)
        if name in _ACTIVE_ELEMENTS:
            active.append(name)
        elif name == _SIMPLE_FIELD:
            field_text.extend(value for key, value in attributes.items() if _local_name(key) == "instr")
        elif name == _FIELD_INSTRUCTION:
            parser.CharacterDataHandler = field_text.append

    def end_element(tag: str) -> None:
        if _local_name(tag) == _FIELD_INSTRUCTION:
            parser.CharacterDataHandler = None

    parser.StartElementHandler = start_element
    parser.EndElementHandler = end_element
    parser.EntityDeclHandler = _refuse_entities
    parser.ParseFile(part)
    return _XmlPart(roots[0], bool(active or _ACTIVE_FIELD.search("".join(field_text))))


@dataclass(frozen=True, slots=True)
class _PartReview:
    stays: bool
    active: bool = False
    chart: bool = False


def _review_part(archive: zipfile.ZipFile, entry: zipfile.ZipInfo) -> _PartReview:
    name = entry.filename
    if name.startswith(_UNDRAWN_FOLDERS):
        return _PartReview(False)
    with archive.open(entry) as part:
        if not name.lower().endswith(_XML_PART_SUFFIXES):
            return _PartReview(_is_picture(part.read(_SNIFF_BYTES), entry.file_size))
        xml = _read_xml_part(part)
    return _PartReview(xml.root not in _FOREIGN_ROOTS, xml.active, xml.root == _CHART_ROOT)


# The last segment of every relationship Type a rendition can use. A Type is only
# a label, so this is not what stops a hostile part: the target must also be a
# kept part. It is what stops a kind nobody thought about from coming along.
_RENDITION_RELATIONSHIPS: Final = frozenset(
    {
        "calcChain",
        "chart",
        "chartColorStyle",
        "chartStyle",
        "chartUserShapes",
        "chartsheet",
        "commentAuthors",
        "comments",
        "diagramColors",
        "diagramData",
        "diagramDrawing",
        "diagramLayout",
        "diagramQuickStyle",
        "dialogsheet",
        "drawing",
        "endnotes",
        "externalLink",
        "fontTable",
        "footer",
        "footnotes",
        "handoutMaster",
        "header",
        "image",
        "notesMaster",
        "notesSlide",
        "numbering",
        "officeDocument",
        "pivotCacheDefinition",
        "pivotCacheRecords",
        "pivotTable",
        "presProps",
        "settings",
        "sharedStrings",
        "sheetMetadata",
        "slide",
        "slideLayout",
        "slideMaster",
        "slideUpdateInfo",
        "styles",
        "stylesWithEffects",
        "table",
        "tableStyles",
        "tags",
        "theme",
        "themeOverride",
        "viewProps",
        "vmlDrawing",
        "webSettings",
        "worksheet",
    }
)


def _part_name(relationships_part: str, target: str) -> str:
    """The package part a relationship points at, as OPC resolves it."""
    folder = posixpath.dirname(posixpath.dirname(relationships_part))
    path = unquote(target).replace("\\", "/")
    joined = path.lstrip("/") if path.startswith("/") else posixpath.join(folder, path)
    return posixpath.normpath(joined)


def _relationship_stays(relationship: Any, relationships_part: str, kept_parts: set[str]) -> bool:
    """Internal, of a known kind, and pointing at a kept part. A part not named as
    XML was never scanned as XML, so only a picture relationship may reach it."""
    kind = relationship.get("Type", "").rsplit("/", 1)[-1]
    target = _part_name(relationships_part, relationship.get("Target", ""))
    return (
        relationship.get("TargetMode") != "External"
        and kind in _RENDITION_RELATIONSHIPS
        and target in kept_parts
        and (kind == "image" or target.lower().endswith(_XML_PART_SUFFIXES))
    )


def _kept_relationships(content: bytes, relationships_part: str, kept_parts: set[str]) -> bytes:
    root = SafeElementTree.fromstring(content)
    for relationship in list(root):
        if not _relationship_stays(relationship, relationships_part, kept_parts):
            root.remove(relationship)
    ElementTree.register_namespace("", _RELATIONSHIPS_NAMESPACE)
    return ElementTree.tostring(root, encoding="utf-8")


_RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
_WORKSHEET_PART = re.compile(r"xl/worksheets/[^/]+\.xml")
_SHEET_ROOT = re.compile(rb"<worksheet\b[^>]*>")
_SHEET_PROPERTIES = re.compile(rb"<sheetPr\b[^>]*?(/?)>")
_SHEET_PROPERTIES_END = b"</sheetPr>"
_FIT_TO_PAGE = re.compile(rb"<pageSetUpPr\b[^>]*/>")
_PAGE_SETUP = re.compile(rb"<pageSetup\b[^>]*/>")
_SCALE_ATTRIBUTES = re.compile(rb"""\s(?:scale|fitToWidth|fitToHeight)=(?:"[^"]*"|'[^']*')""")
_FIT_ELEMENT = b'<pageSetUpPr fitToPage="1"/>'
_FIT_ATTRIBUTES = b' fitToWidth="1" fitToHeight="0"'
_WORKSHEET_END = b"</worksheet>"
_HEADER_FOOTER = b"<headerFooter"
_SHEET_NAME_HEADER = b"<headerFooter><oddHeader>&amp;A</oddHeader></headerFooter>"


def _with_fit_flag(sheet: bytes) -> bytes:
    if _FIT_TO_PAGE.search(sheet):
        return _FIT_TO_PAGE.sub(_FIT_ELEMENT, sheet)
    match = _SHEET_PROPERTIES.search(sheet)
    if match is None:
        root = _SHEET_ROOT.search(sheet)
        if root is None:
            return sheet
        return sheet[: root.end()] + b"<sheetPr>" + _FIT_ELEMENT + b"</sheetPr>" + sheet[root.end() :]
    if match.group(1):
        opened = match.group(0)[:-2] + b">" + _FIT_ELEMENT + _SHEET_PROPERTIES_END
        return sheet[: match.start()] + opened + sheet[match.end() :]
    return sheet.replace(_SHEET_PROPERTIES_END, _FIT_ELEMENT + _SHEET_PROPERTIES_END, 1)


def _with_page_setup(sheet: bytes) -> bytes:
    match = _PAGE_SETUP.search(sheet)
    if match is None:
        setup = b'<pageSetup orientation="landscape"' + _FIT_ATTRIBUTES + b"/>"
        return sheet.replace(_WORKSHEET_END, setup + _WORKSHEET_END, 1)
    kept = _SCALE_ATTRIBUTES.sub(b"", match.group(0)[:-2])
    if b"orientation=" not in kept:
        kept += b' orientation="landscape"'
    return sheet.replace(match.group(0), kept + _FIT_ATTRIBUTES + b"/>", 1)


def fit_sheet_to_width(sheet: bytes) -> bytes:
    """Rewrite one worksheet so a wide sheet shrinks onto the page instead of
    spilling across dozens, and print its name on each page, which is also how
    a ``Sheet: name`` citation finds its page."""
    patched = _with_page_setup(_with_fit_flag(sheet))
    if _HEADER_FOOTER not in patched:
        patched = patched.replace(_WORKSHEET_END, _SHEET_NAME_HEADER + _WORKSHEET_END, 1)
    return patched


def _copy_entry(archive: zipfile.ZipFile, entry: zipfile.ZipInfo, copy: zipfile.ZipFile) -> None:
    with archive.open(entry) as reader, copy.open(entry.filename, "w") as writer:
        shutil.copyfileobj(reader, writer, 1024 * 1024)


def _relationships(archive: zipfile.ZipFile, entry: zipfile.ZipInfo, kept_parts: set[str]) -> bytes:
    if entry.file_size > _MAX_RELATIONSHIPS_BYTES:
        raise ConversionError("Relationship part is too large.")
    return _kept_relationships(archive.read(entry), entry.filename, kept_parts)


def _fits_in_memory(entry: zipfile.ZipInfo) -> bool:
    return entry.file_size <= _MAX_PATCHED_SHEET_BYTES


def _review_package(archive: zipfile.ZipFile) -> dict[str, _PartReview]:
    return {
        entry.filename: _review_part(archive, entry)
        for entry in archive.infolist()
        if not entry.filename.endswith(".rels")
    }


def _write_part(
    archive: zipfile.ZipFile,
    entry: zipfile.ZipInfo,
    copy: zipfile.ZipFile,
    *,
    fit_sheets: bool,
) -> None:
    if fit_sheets and _WORKSHEET_PART.fullmatch(entry.filename) and _fits_in_memory(entry):
        copy.writestr(entry.filename, fit_sheet_to_width(archive.read(entry)))
    else:
        _copy_entry(archive, entry, copy)


def _charts_alone(reviews: dict[str, _PartReview]) -> bool:
    """Charts with nothing active beside them, the one case that may turn active
    content on. With both, the chart goes blank, which is the safe way to lose."""
    has_chart = any(review.chart and review.stays for review in reviews.values())
    return has_chart and not any(review.active for review in reviews.values())


def _copy_ooxml(source: Path, target: Path, *, fit_sheets: bool) -> bool:
    """Rebuild a package from the parts and relationships a rendition needs. True
    when this document may turn active content on for its charts."""
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(
        target, "w", zipfile.ZIP_DEFLATED
    ) as copy:
        _check_package_shape(archive)
        reviews = _review_package(archive)
        kept_parts = {name for name, review in reviews.items() if review.stays}
        for entry in archive.infolist():
            if entry.filename.endswith(".rels"):
                copy.writestr(entry.filename, _relationships(archive, entry, kept_parts))
            elif entry.filename in kept_parts:
                _write_part(archive, entry, copy, fit_sheets=fit_sheets)
    return _charts_alone(reviews)


_XLINK_HREF = "http://www.w3.org/1999/xlink}href"
_XFORMS_ELEMENT = "http://www.w3.org/2002/xforms}"
_XFORMS_LINKS = ("src", "action", "resource")
_ODF_HYPERLINKS = frozenset(
    {
        "urn:oasis:names:tc:opendocument:xmlns:text:1.0}a",
        "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}a",
    }
)
_ODF_MIMETYPE = "mimetype"
_ODF_MANIFEST = "META-INF/manifest.xml"
_ODF_THUMBNAILS = "Thumbnails/"
_ODF_PREVIEW_FOLDER = "ObjectReplacements/"
_ODF_DOCUMENT_PART = re.compile(r"(?:.*/)?(?:content|styles)\.xml")
_URL_SCHEME = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*:")


def _names_outside_resource(href: str) -> bool:
    path = unquote(href)
    return bool(_URL_SCHEME.match(path)) or path.startswith(("/", "\\")) or ".." in path


def _odf_links(tag: str, attributes: dict[str, str]) -> list[str]:
    links = [attributes.get(_XLINK_HREF, "")] if tag not in _ODF_HYPERLINKS else []
    if tag.startswith(_XFORMS_ELEMENT):
        links += [attributes.get(name, "") for name in _XFORMS_LINKS]
    return links


def _refuse_outside_references(part: BinaryIO) -> None:
    """Parsed by expat directly: no tree is built, so a huge part costs no memory."""

    def start_element(tag: str, attributes: dict[str, str]) -> None:
        if any(_names_outside_resource(link) for link in _odf_links(tag, attributes)):
            raise ConversionError("OpenDocument file refers to an outside resource.")

    parser = expat.ParserCreate(namespace_separator="}")
    parser.StartElementHandler = start_element
    parser.EntityDeclHandler = _refuse_entities
    parser.ParseFile(part)


def _odf_part_stays(archive: zipfile.ZipFile, entry: zipfile.ZipInfo) -> bool:
    name = entry.filename
    with archive.open(entry) as part:
        if name == _ODF_MANIFEST:
            _read_xml_part(part)
            return True
        if _ODF_DOCUMENT_PART.fullmatch(name):
            _refuse_outside_references(part)
            return True
        if name.endswith(".xml") or name.startswith(_ODF_THUMBNAILS):
            return False
        head = part.read(_SNIFF_BYTES)
    if name.startswith(_ODF_PREVIEW_FOLDER) and head.startswith(_ODF_PREVIEW_SIGNATURE):
        return True
    return _is_picture(head, entry.file_size)


def _copy_odf(source: Path, target: Path) -> None:
    """Rebuild a package, mimetype first and stored, from the document's own XML,
    which must not reach outside, and pictures. Metadata, settings, scripts, and
    anything else stay behind. The XML itself is copied, not rewritten: its
    attribute values depend on namespace prefixes that re-serializing would lose."""
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(
        target, "w", zipfile.ZIP_DEFLATED
    ) as copy:
        _check_package_shape(archive)
        copy.writestr(_ODF_MIMETYPE, archive.read(_ODF_MIMETYPE), zipfile.ZIP_STORED)
        for entry in archive.infolist():
            if entry.filename != _ODF_MIMETYPE and _odf_part_stays(archive, entry):
                _copy_entry(archive, entry, copy)


def prepare_input(source: Path, office_format: OfficeFormat, target: Path) -> bool:
    """Write the copy LibreOffice will open. True if it may turn active content on
    for this document's charts."""
    if office_format is _RTF:
        _sanitize_rtf(source, target)
        return False
    if office_format in _ODF_FORMATS.values():
        _copy_odf(source, target)
        return False
    return _copy_ooxml(source, target, fit_sheets=office_format is _EXCEL)


# ------------------------------------------------------------------ the process


def profile_settings_xml(*, draws_embedded_charts: bool = False) -> str:
    active_content_off = "false" if draws_embedded_charts else "true"
    settings = (*_PROFILE_SETTINGS, (_SCRIPTING, "DisableActiveContent", active_content_off))
    items = "".join(
        f'<item oor:path="{path}"><prop oor:name="{name}" oor:op="fuse">'
        f"<value>{value}</value></prop></item>"
        for path, name, value in settings
    )
    items += "".join(
        f'<item oor:path="{_GRAPHIC_FILTERS}"><node oor:name="{name}" oor:op="remove"/></item>'
        for name in _REMOVED_GRAPHIC_FILTERS
    )
    items += "".join(
        f'<item oor:path="{_DOCUMENT_FILTERS}"><node oor:name="{name}" oor:op="remove"/></item>'
        for name in _REMOVED_DOCUMENT_FILTERS
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry" '
        'xmlns:xs="http://www.w3.org/2001/XMLSchema" '
        f'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">{items}</oor:items>\n'
    )


def write_profile(profile: Path, settings_xml: str) -> None:
    user = profile / "user"
    user.mkdir(parents=True)
    (user / "registrymodifications.xcu").write_text(settings_xml, encoding="utf-8")


def soffice_environment(work: Path) -> dict[str, str]:
    """Nothing of the API's: no key, token, or database URL reaches this process.
    libcurl reads these proxy variables, so they cover it apart from the profile."""
    closed = _CLOSED_PROXY_URL
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": str(work),
        "TMPDIR": str(work / "tmp"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "SAL_USE_VCLPLUGIN": "svp",
        "http_proxy": closed,
        "https_proxy": closed,
        "ftp_proxy": closed,
        "all_proxy": closed,
        "HTTP_PROXY": closed,
        "HTTPS_PROXY": closed,
        "ALL_PROXY": closed,
        "no_proxy": "",
        "NO_PROXY": "",
    }


def limited_command(options: RenditionOptions) -> list[str]:
    """Runs what follows under resource limits. They are set by a shell that then
    execs it, because ``preexec_fn`` can deadlock in a threaded server, and after
    the drop, so the child cannot raise them back."""
    return [
        "/bin/sh",
        "-c",
        _LIMITS_SCRIPT,
        "soffice-limits",
        str(math.ceil(options.timeout_seconds)),
        str(_MAX_OUTPUT_BYTES // _FILE_SIZE_BLOCK_BYTES),
        str(_MAX_OPEN_FILES),
        str(options.memory_mb * 1024),
    ]


def soffice_command(
    soffice: str, input_path: Path, office_format: OfficeFormat, work: Path, options: RenditionOptions
) -> list[str]:
    return [
        *limited_command(options),
        soffice,
        f"-env:UserInstallation={(work / 'profile').as_uri()}",
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--nologo",
        "--nofirststartwizard",
        f"--infilter={office_format.input_filter}",
        "--convert-to",
        office_format.output_filter,
        "--outdir",
        str(work / "out"),
        str(input_path),
    ]


def _kill_group(process: subprocess.Popen[bytes]) -> None:
    """Also after a clean exit: the launcher can leave ``soffice.bin`` behind."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    process.wait()


def _account_arguments(account: SandboxAccount | None) -> dict[str, Any]:
    """Set in C by ``subprocess``, so it avoids the ``preexec_fn`` deadlock."""
    if account is None:
        return {}
    return {"user": account.uid, "group": account.gid, "extra_groups": []}


def _end_stragglers(account: SandboxAccount | None) -> None:
    """A process that called setsid escaped the group kill. ``kill(-1)`` as the
    account reaches every process of that uid, so nothing is left to read the next
    run's input. One conversion runs at a time, so nothing else of that uid exists."""
    if account is None:
        return
    subprocess.run(
        [sys.executable, "-I", "-S", "-c", "import os,signal; os.kill(-1, signal.SIGKILL)"],
        env={},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        **_account_arguments(account),
    )


def run_sandboxed(
    command: list[str], scratch: Path, timeout_seconds: float, account: SandboxAccount | None
) -> None:
    process = subprocess.Popen(
        command,
        cwd=scratch,
        env=soffice_environment(scratch),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        **_account_arguments(account),
    )
    try:
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        raise ConversionError("Conversion ran out of time.") from exc
    finally:
        _kill_group(process)
        _end_stragglers(account)


@contextmanager
def _scratch_directory() -> Iterator[Path]:
    """Outside the data volume, whose 0700 tree the account must not be able to enter."""
    scratch = Path(tempfile.mkdtemp(prefix=_SCRATCH_PREFIX))
    try:
        (scratch / "tmp").mkdir()
        (scratch / "out").mkdir()
        yield scratch
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def clear_scratch() -> None:
    """Startup, with nothing in flight: a crash leaves a full copy of a document."""
    for leftover in Path(tempfile.gettempdir()).glob(f"{_SCRATCH_PREFIX}*"):
        shutil.rmtree(leftover, ignore_errors=True)


def _hand_over(scratch: Path, account: SandboxAccount | None) -> None:
    if account is None:
        return
    os.chown(scratch, account.uid, account.gid)
    for path in scratch.rglob("*"):
        os.chown(path, account.uid, account.gid, follow_symlinks=False)


def _take_output(scratch: Path, name: str, target: Path) -> Path:
    """Copy the result out. The sandbox owned everything in ``scratch``, so nothing
    there is trusted: neither the file nor its folder may be a link, and it must be
    a regular file of a sane size that really is a PDF. Its processes are gone by
    now, so nothing can be swapped in behind these checks."""
    try:
        folder = os.open(scratch / "out", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
        finally:
            os.close(folder)
    except OSError as exc:
        raise ConversionError("The conversion produced no PDF.") from exc
    with os.fdopen(descriptor, "rb") as reader:
        details = os.fstat(reader.fileno())
        if not stat.S_ISREG(details.st_mode) or details.st_size > _MAX_OUTPUT_BYTES:
            raise ConversionError("The conversion produced something other than a PDF.")
        if not reader.read(len(_PDF_SIGNATURE)).startswith(_PDF_SIGNATURE):
            raise ConversionError("The conversion produced something other than a PDF.")
        reader.seek(0)
        with target.open("xb") as writer:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
    return target


def convert_to_pdf(
    source: Path,
    office_format: OfficeFormat,
    work: Path,
    *,
    soffice: str,
    options: RenditionOptions,
) -> Path:
    """Convert a rebuilt copy of ``source`` and return the PDF, safe inside ``work``."""
    account = rendition_account()
    with _scratch_directory() as scratch:
        input_path = scratch / f"input.{office_format.extension}"
        draws_charts = prepare_input(source, office_format, input_path)
        write_profile(scratch / "profile", profile_settings_xml(draws_embedded_charts=draws_charts))
        _hand_over(scratch, account)
        command = soffice_command(soffice, input_path, office_format, scratch, options)
        run_sandboxed(command, scratch, options.timeout_seconds, account)
        return _take_output(scratch, "input.pdf", work / RENDITION_NAME)


def convert_scan_to_pdf(source: Path, work: Path, *, options: RenditionOptions) -> Path:
    """A scan gets the same sandbox as LibreOffice, in a worker of its own: this is
    a stranger's file through an image decoder, and only a process can be killed."""
    account = rendition_account()
    with _scratch_directory() as scratch:
        input_path = scratch / "input.tiff"
        shutil.copyfile(source, input_path)
        _hand_over(scratch, account)
        command = [
            *limited_command(options),
            sys.executable,
            "-I",
            str(_SCAN_WORKER),
            str(input_path),
            str(scratch / "out" / "scan.pdf"),
            str(_MAX_SCAN_PAGES),
            str(_MAX_SCAN_PIXELS),
        ]
        run_sandboxed(command, scratch, options.timeout_seconds, account)
        return _take_output(scratch, "scan.pdf", work / RENDITION_NAME)


# ------------------------------------------------------------------ the cache


def _failed_recently(originals: KnowledgeOriginalStore, ref: DocumentRef) -> bool:
    marker = originals.derived(ref, _FAILURE_NAME)
    return marker is not None and time.time() - marker.stat().st_mtime < _FAILURE_RETRY_SECONDS


def _record_failure(
    originals: KnowledgeOriginalStore, ref: DocumentRef, work: Path, fingerprint: str
) -> None:
    marker = work / "failed"
    marker.touch()
    originals.publish(ref, _FAILURE_NAME, marker, fingerprint=fingerprint)


def _convert_and_publish(
    originals: KnowledgeOriginalStore, ref: DocumentRef, convert: Converter
) -> KnowledgeDocumentViewNotice | None:
    source = originals.path(ref)
    fingerprint = originals.fingerprint(ref)
    if source is None or fingerprint is None:
        return "original_missing"
    try:
        with originals.work_directory() as work:
            try:
                produced = convert(source, work)
            except Exception as exc:  # noqa: BLE001 - hostile input must not reach the reader as a 500
                # The type only: an exception's text can quote the document.
                logger.warning("Rendition of %s failed: %s", ref.document_id, type(exc).__name__)
                _record_failure(originals, ref, work, fingerprint)
                return "conversion_failed"
            originals.publish(ref, RENDITION_NAME, produced, fingerprint=fingerprint)
    except OSError as exc:
        logger.warning("Rendition of %s failed: %s", ref.document_id, type(exc).__name__)
        return "conversion_failed"
    return None


def _ensure_rendition(
    originals: KnowledgeOriginalStore, ref: DocumentRef, convert: Converter | None
) -> KnowledgeDocumentViewNotice | None:
    """Make the rendition exist, or say why it cannot, without ever waiting long."""
    if originals.derived(ref, RENDITION_NAME) is not None:
        return None
    if convert is None:
        return "conversion_unavailable"
    if _failed_recently(originals, ref):
        return "conversion_failed"
    if not _conversion_queue.acquire(blocking=False):
        return "conversion_unavailable"
    try:
        with _conversion_lock:
            if originals.derived(ref, RENDITION_NAME) is not None:
                return None
            return _convert_and_publish(originals, ref, convert)
    finally:
        _conversion_queue.release()


def _office_converter(
    office_format: OfficeFormat, options: RenditionOptions
) -> Converter | None:
    soffice = find_soffice(options.soffice)
    if soffice is None or not _may_convert(options):
        return None

    def convert(source: Path, work: Path) -> Path:
        return convert_to_pdf(source, office_format, work, soffice=soffice, options=options)

    return convert


def _scan_converter(options: RenditionOptions) -> Converter | None:
    if not _may_convert(options):
        return None

    def convert(source: Path, work: Path) -> Path:
        return convert_scan_to_pdf(source, work, options=options)

    return convert


# -------------------------------------------------------------------- the view


def _pdf_page_count(path: Path) -> int | None:
    """Pages PDFium can open; None for a corrupt or password-protected file."""
    with PDFIUM_LOCK:
        try:
            pdf = pypdfium2.PdfDocument(path)
        except pypdfium2.PdfiumError:
            return None
        try:
            return len(pdf) or None
        finally:
            pdf.close()


def _page_keys(path: Path) -> list[str]:
    """Each page's text as a match key. The lock is taken per page."""
    with PDFIUM_LOCK:
        pdf = pypdfium2.PdfDocument(path)
        page_count = len(pdf)
    keys: list[str] = []
    try:
        for index in range(page_count):
            with PDFIUM_LOCK:
                page = pdf[index]
                text_page = page.get_textpage()
                text = text_page.get_text_bounded()
                text_page.close()
                page.close()
            keys.append(match_key(text))
    finally:
        with PDFIUM_LOCK:
            pdf.close()
    return keys


def page_index(originals: KnowledgeOriginalStore, ref: DocumentRef, pdf: Path) -> list[str]:
    """Every page's match key, built once for a given version of the file."""
    cached = originals.derived(ref, _PAGES_NAME)
    if cached is not None:
        return json.loads(cached.read_text(encoding="utf-8"))
    fingerprint = originals.fingerprint(ref)
    try:
        keys = _page_keys(pdf)
    except pypdfium2.PdfiumError:
        return []
    try:
        with originals.work_directory() as work:
            built = work / _PAGES_NAME
            built.write_text(json.dumps(keys), encoding="utf-8")
            originals.publish(ref, _PAGES_NAME, built, fingerprint=fingerprint)
    except OSError:
        logger.warning("Could not cache the page index of %s", ref.document_id)
    return keys


def _guessed_content_type(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def _rendition_view(
    originals: KnowledgeOriginalStore,
    ref: DocumentRef,
    content_type: str,
    convert: Converter | None,
) -> PreparedDocument:
    notice = _ensure_rendition(originals, ref, convert)
    rendition = originals.derived(ref, RENDITION_NAME)
    if rendition is None:
        return PreparedDocument("text", content_type, True, notice=notice)
    page_count = _pdf_page_count(rendition)
    if page_count is None:
        return PreparedDocument("text", content_type, True, notice="conversion_failed")
    return PreparedDocument("pdf", content_type, True, rendition, page_count)


def prepare_document(
    originals: KnowledgeOriginalStore,
    ref: DocumentRef,
    *,
    name: str,
    options: RenditionOptions,
) -> PreparedDocument:
    """Decide how to present a document, from its bytes and never from its name."""
    path = originals.path(ref)
    if path is None:
        return PreparedDocument(
            "text", _guessed_content_type(name), False, notice="original_missing"
        )
    with path.open("rb") as handle:
        head = handle.read(_SNIFF_BYTES)
    if _PDF_SIGNATURE in head[:_PDF_HEADER_WINDOW]:
        page_count = _pdf_page_count(path)
        if page_count is None:
            return PreparedDocument("text", PDF_CONTENT_TYPE, True, notice="conversion_failed")
        return PreparedDocument("pdf", PDF_CONTENT_TYPE, True, path, page_count)
    image_type = _sniff_image(head)
    if image_type is not None:
        return PreparedDocument("image", image_type, True, path, 1)
    if head.startswith(_TIFF_SIGNATURES):
        return _rendition_view(originals, ref, TIFF_CONTENT_TYPE, _scan_converter(options))
    office_format = sniff_office_format(path)
    if office_format is not None:
        converter = _office_converter(office_format, options)
        return _rendition_view(originals, ref, office_format.content_type, converter)
    notice = "conversion_unavailable" if b"\x00" in head else None
    return PreparedDocument("text", _guessed_content_type(name), True, notice=notice)

