"""PDF → editable document HTML that keeps the page as it looked.

The Drafts editor opens a PDF as a normal, flowing, editable document, and the
rule for opened documents is that the formatting must not change. PDFium
reports every character with its box, baseline, font, size, and color, plus
the pictures and ruled lines on the page; this module rebuilds paragraphs
from that geometry and writes them in the shared contract the editor, the
storage sanitizers, the Word export, and print all understand (see
``apps/web/src/lib/documentPageSetup.ts``):

* a leading ``document-page-setup`` marker with the page size, margins
  measured from the body text, the dominant body font, and running
  headers/footers (page numbers become live fields), then
* paragraphs whose inline styles reproduce alignment, indents, first-line and
  hanging indents, line pitch, paragraph spacing, fonts, sizes, colors,
  bold/italic/underline, superscripts, links, list markers, and column gaps
  (fixed-width tab spacers), with pictures and drawn rules in reading order.

Lengths are written in the editor's preview px (1pt = 728/493.9 px) so the
canvas, the toolbar, and the Word export agree; page geometry is in points.
Nothing is stored: the endpoint is a stateless transform.
"""

from __future__ import annotations

import base64
import bisect
import ctypes
import html
import io
import math
import re
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from statistics import median
from typing import Any

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

from app.core.config import get_settings
from app.core.pdfium_lock import PDFIUM_LOCK
from app.models.document_import import DocumentImportResponse

PREVIEW_PX_PER_PT = 728 / 493.9
MAX_PAGES = 500
# The draft store holds 2 MB of HTML; pictures share most of that budget.
HTML_IMAGE_BUDGET_BYTES = 1_400_000
DEFAULT_FONT_SIZE_PT = 12.0
DEFAULT_COLOR = "#000000"
DEFAULT_MARGIN_PT = 72.0
MIN_MARGIN_PT = 18.0
MAX_MARGIN_PT = 216.0
# Running heads sit in the outer band of the page (0.7in of Letter); body
# text at a 1in margin starts below it.
HEADER_FOOTER_ZONE = 0.09

DOCUMENT_PAGE_SETUP_CLASS = "document-page-setup"
DOCUMENT_PAGE_NORMAL_CLASS = "document-page-normal"
DOCUMENT_PAGE_HEADER_CLASS = "document-page-header"
DOCUMENT_PAGE_FOOTER_CLASS = "document-page-footer"
DOCUMENT_PAGE_HEADER_FIRST_CLASS = "document-page-header-first"
DOCUMENT_PAGE_FOOTER_FIRST_CLASS = "document-page-footer-first"
DOCUMENT_FIELD_PAGE_CLASS = "document-field-page"
DOCUMENT_FIELD_PAGES_CLASS = "document-field-pages"
DOCUMENT_TAB_CLASS = "document-tab"
DOCUMENT_LIST_MARKER_CLASS = "document-list-marker"

# Mirrored from apps/web/src/lib/documentPageSetup.ts (FONT_LINE_FACTORS,
# FONT_FALLBACKS, SERIF_NAME, MONO_NAME, cssFontFamilyStack): imports and
# exports must agree on these numbers and names.
FONT_LINE_FACTORS: dict[str, float] = {
    "aptos": 1.2,
    "arial": 1.15,
    "arial narrow": 1.15,
    "book antiqua": 1.17,
    "bookman old style": 1.17,
    "calibri": 1.22,
    "calibri light": 1.22,
    "cambria": 1.17,
    "candara": 1.22,
    "century gothic": 1.23,
    "century schoolbook": 1.2,
    "consolas": 1.17,
    "constantia": 1.22,
    "corbel": 1.22,
    "courier new": 1.13,
    "franklin gothic book": 1.13,
    "garamond": 1.12,
    "georgia": 1.14,
    "helvetica": 1.15,
    "palatino linotype": 1.33,
    "segoe ui": 1.33,
    "tahoma": 1.21,
    "times new roman": 1.15,
    "times": 1.15,
    "trebuchet ms": 1.16,
    "verdana": 1.22,
}
DEFAULT_FONT_LINE_FACTOR = 1.17
FONT_FALLBACKS: dict[str, str] = {
    "aptos": "Carlito, Arial, sans-serif",
    "arial": "Liberation Sans, Arimo, Helvetica, sans-serif",
    "calibri": "Carlito, Arial, sans-serif",
    "calibri light": "Carlito, Arial, sans-serif",
    "cambria": "Caladea, Georgia, serif",
    "candara": "Carlito, Arial, sans-serif",
    "consolas": "Courier New, monospace",
    "constantia": "Caladea, Georgia, serif",
    "corbel": "Carlito, Arial, sans-serif",
    "courier new": "Liberation Mono, Cousine, monospace",
    "courier": "Courier New, monospace",
    "garamond": "EB Garamond, Georgia, serif",
    "georgia": "serif",
    "helvetica": "Arial, sans-serif",
    "times new roman": "Liberation Serif, Tinos, Times, serif",
    "times": "Times New Roman, serif",
    "verdana": "sans-serif",
    "tahoma": "Verdana, sans-serif",
    "segoe ui": "Arial, sans-serif",
}
SERIF_NAME = re.compile(
    r"(times|serif|georgia|garamond|cambria|antiqua|bookman|palatino|minion|"
    r"baskerville|caslon|century|bodoni|didot|goudy|janson|sabon|constantia)",
    re.I,
)
SANS_NAME = re.compile(r"\bsans\b|gothic|grotesk|helvetica|arial|univers", re.I)
MONO_NAME = re.compile(r"(mono|courier|consolas|code|typewriter)", re.I)
GENERIC_FAMILIES = {"serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"}

_SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")
_STYLE_WORDS = re.compile(
    r"(BoldItalic|BoldOblique|SemiboldItalic|Semibold|SemiBold|Demibold|Demi|Bold|"
    r"Italic|Oblique|Regular|Light|Medium|Black|Heavy|Condensed)$",
    re.I,
)
_VENDOR_SUFFIX = re.compile(r"(PSMT|PS|MT)$")
_CAMEL_BREAK = re.compile(r"(?<=[a-z])(?=[A-Z])")
_DIGITS = re.compile(r"\d+")
_PAGE_NUMBER_ONLY = re.compile(
    r"^\s*(?:page\s+)?[-–—]?\s*\d+\s*[-–—]?(?:\s+of\s+\d+)?\s*$", re.I
)
_BULLETS = "•◦▪▫‣⁃∙●○■□➢–—-*·"
_LIST_MARKER = re.compile(
    rf"^(?:[{re.escape(_BULLETS)}]|\(?[0-9]{{1,3}}(?:\.[0-9]{{1,3}})*[.)]?|"
    r"\(?[a-zA-Z][.)]|\([a-zA-Z]{1,2}\)|\(?(?:[ivxlcdm]{1,6}|[IVXLCDM]{1,6})[.)]|"
    r"(?:Section|SECTION|Article|ARTICLE)\s+[0-9IVXLC]+(?:\.[0-9]+)*\.?)$"
)
_SENTENCE_END = re.compile(r"[.!?:;\"”)\]]$")
# A dot leader running to a short trailing label: a table-of-contents line.
_LEADER = re.compile(r"(?:\.\s?){5,}\s*\S{1,8}$|(?:\u2026){2,}\s*\S{1,8}$")


class PdfReadError(ValueError):
    """Raised when a PDF cannot be opened or decrypted by PDFium."""


class PdfImportBusyError(RuntimeError):
    """Raised when the server is already converting its limit of PDFs."""


# Conversions run in the shared request threadpool: at most two at once, and
# each one is bounded in time; PDFium itself is guarded by the process-wide
# lock, taken page by page.
_IMPORT_SLOTS = threading.BoundedSemaphore(2)
IMPORT_TIME_BUDGET_SECONDS = 150.0
# Per-page work caps for pathological pages (maps, scatter plots, patterns).
MAX_ART_SHAPES_PER_PAGE = 3000
MAX_RULES_PER_PAGE = 2000
MAX_FILLS_PER_PAGE = 600
# XML 1.0 forbids these even as character references; Word rejects files
# that contain them, so they never enter the document.
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


# ------------------------------------------------------------------ units


def px_from_pt(pt: float) -> float:
    return pt * PREVIEW_PX_PER_PT


def pt_from_px(px: float) -> float:
    return px / PREVIEW_PX_PER_PT


def _num(value: float, digits: int = 2) -> str:
    rounded = round(value, digits)
    if rounded == int(rounded):
        return str(int(rounded))
    return f"{rounded:.{digits}f}".rstrip("0").rstrip(".")


def _px(pt: float) -> str:
    return f"{_num(px_from_pt(pt))}px"


def _pt(pt: float) -> str:
    return f"{_num(pt)}pt"


# ------------------------------------------------------------------ fonts


def css_family_name(name: str) -> str:
    clean = re.sub(r"\s+", " ", re.sub(r"""["'\\;<>]""", "", name)).strip()
    if clean.lower() in GENERIC_FAMILIES:
        return clean.lower()
    return clean if re.fullmatch(r"[A-Za-z][A-Za-z-]*", clean) else f"'{clean}'"


def css_font_family_stack(name: str, *, serif: bool = False, mono: bool = False) -> str:
    clean = re.sub(r"\s+", " ", re.sub(r"""["'\\;<>]""", "", name)).strip()
    generic = (
        "monospace"
        if mono or MONO_NAME.search(clean)
        else "serif"
        if serif or (SERIF_NAME.search(clean) and not SANS_NAME.search(clean))
        else "sans-serif"
    )
    if not clean or not re.fullmatch(r"[a-z0-9][a-z0-9 \-]{0,58}", clean, re.I):
        return generic
    fallbacks = [part.strip() for part in FONT_FALLBACKS.get(clean.lower(), generic).split(",")]
    names = [clean, *[part for part in fallbacks if part.lower() != clean.lower()]]
    if names[-1].lower() not in GENERIC_FAMILIES:
        names.append(generic)
    stack = [css_family_name(part) for part in names]
    while len(", ".join(stack)) > 118 and len(stack) > 2:
        stack = [*stack[:-2], stack[-1]]
    return ", ".join(stack)


def font_line_factor(family: str) -> float:
    return FONT_LINE_FACTORS.get(family.strip().lower(), DEFAULT_FONT_LINE_FACTOR)


_FAMILY_ALIASES = {
    "times": "Times New Roman",
    "times roman": "Times New Roman",
    "timesnewroman": "Times New Roman",
    "courier": "Courier New",
    "couriernew": "Courier New",
    "arial": "Arial",
    "helvetica": "Helvetica",
    "symbol": "Symbol",
    "zapfdingbats": "ZapfDingbats",
}


def clean_font_name(raw_name: str) -> str:
    """Family name from a PDF base font name: subset prefix, style words, and
    vendor suffixes dropped; CamelCase spaced (``TimesNewRomanPS-BoldMT`` →
    ``Times New Roman``)."""

    name = _SUBSET_PREFIX.sub("", (raw_name or "").strip())
    name = re.split(r"[,-]", name, maxsplit=1)[0]
    name = name.replace("_", " ").strip()
    for _ in range(3):
        stripped = _VENDOR_SUFFIX.sub("", _STYLE_WORDS.sub("", name)).strip()
        if stripped == name or not stripped:
            break
        name = stripped
    alias = _FAMILY_ALIASES.get(name.lower().replace(" ", ""))
    if alias:
        return alias
    spaced = re.sub(r"\s+", " ", _CAMEL_BREAK.sub(" ", name)).strip()
    return spaced or "Times New Roman"


# ------------------------------------------------------------------ model


@dataclass(frozen=True, slots=True)
class TextStyle:
    family: str
    stack: str
    size_pt: float
    color: str
    bold: bool
    italic: bool
    # CSS weight when the font is neither regular nor bold (500, 600, 800…).
    weight: int = 0
    # Font ascent and descent as fractions of the size, for line-box math.
    ascent: float = 0.89
    descent: float = 0.22

    @property
    def line_factor(self) -> float:
        return font_line_factor(self.family)


@dataclass(slots=True)
class Glyph:
    text: str
    x0: float
    x1: float
    bottom: float
    top: float
    baseline: float
    style: TextStyle
    index: int = -1
    href: str | None = None
    underline: bool = False
    raised: bool = False
    soft_hyphen: bool = False
    invisible: bool = False
    background: str | None = None
    order: int = -1
    rotated: bool = False

    @property
    def is_space(self) -> bool:
        return not self.text.strip()


@dataclass(slots=True)
class Line:
    page: int
    glyphs: list[Glyph]
    segments: list[list[Glyph]]
    x0: float
    x1: float
    top: float
    bottom: float
    baseline: float
    style: TextStyle
    text: str
    is_header: bool = False
    is_footer: bool = False

    @property
    def size(self) -> float:
        return self.style.size_pt


@dataclass(slots=True)
class Rule:
    page: int
    x0: float
    x1: float
    y: float
    thickness: float
    color: str


@dataclass(slots=True)
class VRule:
    page: int
    x: float
    y0: float
    y1: float
    thickness: float
    color: str


@dataclass(slots=True)
class Picture:
    page: int
    x0: float
    x1: float
    bottom: float
    top: float
    data_url: str
    running: str | None = None


@dataclass(slots=True)
class Fill:
    """A filled shape: highlight, cell shading, or a colored band."""

    x0: float
    bottom: float
    x1: float
    top: float
    color: str


@dataclass(slots=True)
class Art:
    """Bounds of a vector shape that is neither a rule nor text."""

    x0: float
    bottom: float
    x1: float
    top: float


@dataclass(slots=True)
class PageContent:
    number: int
    width: float
    height: float
    lines: list[Line] = field(default_factory=list)
    pictures: list[Picture] = field(default_factory=list)
    rules: list[Rule] = field(default_factory=list)
    vrules: list[VRule] = field(default_factory=list)
    fills: list[Fill] = field(default_factory=list)
    art: list[Art] = field(default_factory=list)
    scanned: bool = False


@dataclass(slots=True)
class Paragraph:
    lines: list[Line]
    page: int
    column_left: float
    column_right: float
    list_marker: tuple[list[Glyph], float] | None = None

    @property
    def first(self) -> Line:
        return self.lines[0]

    @property
    def last(self) -> Line:
        return self.lines[-1]


@dataclass(slots=True)
class PageSetup:
    width_pt: float
    height_pt: float
    margin_top_pt: float
    margin_right_pt: float
    margin_bottom_pt: float
    margin_left_pt: float
    header_distance_pt: float
    footer_distance_pt: float
    style: TextStyle
    line_height: float
    paragraph_after_pt: float = 0.0
    header_html: str = ""
    footer_html: str = ""
    first_header_html: str | None = None
    first_footer_html: str | None = None


# ------------------------------------------------------------------ PDFium access


def _font_name(font: Any) -> str:
    for getter in (pdfium_c.FPDFFont_GetBaseFontName, pdfium_c.FPDFFont_GetFamilyName):
        try:
            size = getter(font, None, 0)
            if not size:
                continue
            buffer = ctypes.create_string_buffer(size)
            getter(font, buffer, size)
            value = buffer.raw.rstrip(b"\x00").decode("utf-8", errors="ignore").strip()
            if value:
                return value
        except Exception:  # pragma: no cover - defensive against PDFium builds
            continue
    return ""


@dataclass(slots=True)
class _ObjectInfo:
    raw_name: str
    family: str
    flags: int
    weight: int
    italic_angle: int
    color: str
    invisible: bool
    ascent: float
    descent: float


def _object_info(obj: Any, cache: dict[int, _ObjectInfo]) -> _ObjectInfo | None:
    key = ctypes.cast(obj, ctypes.c_void_p).value or 0
    cached = cache.get(key)
    if cached is not None:
        return cached
    if not key:
        return None
    font = pdfium_c.FPDFTextObj_GetFont(obj)
    raw_name = _font_name(font) if font else ""
    flags = int(pdfium_c.FPDFFont_GetFlags(font)) if font else 0
    weight = int(pdfium_c.FPDFFont_GetWeight(font)) if font else 400
    angle = ctypes.c_int(0)
    if font:
        pdfium_c.FPDFFont_GetItalicAngle(font, ctypes.byref(angle))
    red, green, blue, alpha = (ctypes.c_uint() for _ in range(4))
    has_fill = pdfium_c.FPDFPageObj_GetFillColor(
        obj, ctypes.byref(red), ctypes.byref(green), ctypes.byref(blue), ctypes.byref(alpha)
    )
    color = (
        f"#{red.value:02x}{green.value:02x}{blue.value:02x}" if has_fill else DEFAULT_COLOR
    )
    mode = int(pdfium_c.FPDFTextObj_GetTextRenderMode(obj))
    ascent = ctypes.c_float(0.0)
    descent = ctypes.c_float(0.0)
    ascent_ratio, descent_ratio = 0.89, 0.22
    if font:
        try:
            if pdfium_c.FPDFFont_GetAscent(font, ctypes.c_float(1.0), ctypes.byref(ascent)):
                ascent_ratio = min(1.3, max(0.5, float(ascent.value)))
            if pdfium_c.FPDFFont_GetDescent(font, ctypes.c_float(1.0), ctypes.byref(descent)):
                descent_ratio = min(0.6, max(0.05, abs(float(descent.value))))
        except Exception:  # pragma: no cover
            pass
    info = _ObjectInfo(
        raw_name=raw_name,
        family=clean_font_name(raw_name),
        flags=flags,
        weight=weight,
        italic_angle=int(angle.value),
        color=color,
        invisible=mode == 3 or (has_fill and alpha.value == 0),
        ascent=ascent_ratio,
        descent=descent_ratio,
    )
    cache[key] = info
    return info


_STYLE_CACHE: dict[tuple[Any, ...], TextStyle] = {}


def _style(info: _ObjectInfo | None, size_pt: float) -> TextStyle:
    raw = info.raw_name if info else ""
    family = info.family if info else "Times New Roman"
    flags = info.flags if info else 0
    bold = bool(
        re.search(r"(bold|black|heavy|semibold|demi)", raw, re.I)
        or (info and info.weight >= 600)
        or flags & (1 << 18)
    )
    italic = bool(
        re.search(r"(italic|oblique)", raw, re.I) or flags & (1 << 6) or (info and info.italic_angle)
    )
    serif = bool(flags & 2)
    mono = bool(flags & 1)
    size = round(max(1.0, size_pt) * 4) / 4
    color = info.color if info else DEFAULT_COLOR
    # Semibold/medium faces keep their own weight: drawn as bold (700) they
    # run wider than the source and push tab-aligned text to a new line.
    weight = 0
    if re.search(r"semi ?bold|demi", raw, re.I) or (info and 550 <= info.weight < 650):
        weight = 600
    elif re.search(r"medium", raw, re.I) or (info and 450 <= info.weight < 550 and not bold):
        weight = 500
    elif re.search(r"extra ?bold|ultra ?bold|black|heavy", raw, re.I) or (info and info.weight >= 750):
        weight = 800
    if weight:
        bold = False
    key = (family, size, color, bold, italic, serif, mono, weight)
    cached = _STYLE_CACHE.get(key)
    if cached is not None:
        return cached
    style = TextStyle(
        family=family,
        stack=css_font_family_stack(family, serif=serif, mono=mono),
        size_pt=size,
        color=color,
        bold=bold,
        italic=italic,
        ascent=info.ascent if info else 0.89,
        descent=info.descent if info else 0.22,
        weight=weight,
    )
    if len(_STYLE_CACHE) > 4096:
        _STYLE_CACHE.clear()
    _STYLE_CACHE[key] = style
    return style


class _Transform:
    """Maps PDF user space to the displayed page (origin bottom-left, y up),
    honoring the crop box offset and /Rotate."""

    def __init__(self, page: pdfium.PdfPage) -> None:
        left, bottom, right, top = page.get_cropbox()
        self.left, self.bottom = float(left), float(bottom)
        self.w, self.h = float(right - left), float(top - bottom)
        self.rotation = int(page.get_rotation() or 0) % 360
        self.width, self.height = (self.h, self.w) if self.rotation in (90, 270) else (self.w, self.h)

    def point(self, x: float, y: float) -> tuple[float, float]:
        u, v = x - self.left, y - self.bottom
        if self.rotation == 90:
            return v, self.w - u
        if self.rotation == 180:
            return self.w - u, self.h - v
        if self.rotation == 270:
            return self.h - v, u
        return u, v

    def box(self, x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
        a = self.point(x0, y0)
        b = self.point(x1, y1)
        return min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])


# ------------------------------------------------------------------ extraction


def _object_key(obj: Any) -> int:
    return ctypes.cast(obj, ctypes.c_void_p).value or 0


def _extract_glyphs(
    textpage: pdfium.PdfTextPage,
    transform: _Transform,
    text_order: dict[int, int] | None = None,
) -> list[Glyph]:
    raw = textpage.raw
    count = textpage.count_chars()
    cache: dict[int, _ObjectInfo] = {}
    glyphs: list[Glyph] = []
    rect = pdfium_c.FS_RECTF()
    ox, oy = ctypes.c_double(), ctypes.c_double()
    for index in range(count):
        code = pdfium_c.FPDFText_GetUnicode(raw, index)
        if code <= 0:
            continue
        char = chr(code)
        if char in "\r\n\x02" or _CONTROL_CHARACTERS.match(char):
            continue
        obj = pdfium_c.FPDFText_GetTextObject(raw, index)
        info = _object_info(obj, cache) if obj else None
        if not pdfium_c.FPDFText_GetLooseCharBox(raw, index, ctypes.byref(rect)):
            continue
        size = float(pdfium_c.FPDFText_GetFontSize(raw, index) or DEFAULT_FONT_SIZE_PT)
        # Design tools often set a 1pt font and scale it with the text matrix;
        # the loose box (ascent to descent) carries the size actually drawn.
        extent = (info.ascent + info.descent) if info else 1.11
        drawn = abs(rect.top - rect.bottom) / extent if extent > 0 else 0.0
        if drawn > 1 and not (0.75 <= size / drawn <= 1.33):
            size = drawn
        style = _style(info, size)
        if 0xF000 <= code <= 0xF0FF or (
            info and re.search(r"(symbol|wingding|dingbat)", info.raw_name, re.I) and not char.isspace()
        ):
            char = "\u2022"
        box = transform.box(rect.left, rect.bottom, rect.right, rect.top)
        if not pdfium_c.FPDFText_GetCharOrigin(raw, index, ctypes.byref(ox), ctypes.byref(oy)):
            ox.value, oy.value = rect.left, rect.bottom
        origin = transform.point(ox.value, oy.value)
        if not all(math.isfinite(value) for value in box) or box[2] < box[0]:
            continue
        # Text placed off the page is never seen in the source.
        if box[2] < -1 or box[0] > transform.width + 1 or box[3] < -1 or box[1] > transform.height + 1:
            continue
        x0 = origin[0] if transform.rotation == 0 else box[0]
        glyphs.append(
            Glyph(
                text=char,
                x0=min(x0, box[2]),
                x1=max(box[2], x0),
                bottom=box[1],
                top=box[3],
                baseline=origin[1] if transform.rotation in (0, 180) else box[1] + (box[3] - box[1]) * 0.22,
                style=style,
                index=index,
                soft_hyphen=bool(pdfium_c.FPDFText_IsHyphen(raw, index) == 1),
                invisible=bool(info and info.invisible),
                order=(text_order or {}).get(_object_key(obj), -1) if obj else -1,
                rotated=abs(math.remainder(float(pdfium_c.FPDFText_GetCharAngle(raw, index)), math.pi * 2)) > 0.05
                and transform.rotation == 0,
            )
        )
    return glyphs


def _mark_links(
    pdf: pdfium.PdfDocument,
    textpage: pdfium.PdfTextPage,
    page: pdfium.PdfPage,
    glyphs: list[Glyph],
    transform: _Transform,
) -> None:
    by_index = {glyph.index: glyph for glyph in glyphs}
    links = pdfium_c.FPDFLink_LoadWebLinks(textpage.raw)
    if links:
        try:
            for link_index in range(pdfium_c.FPDFLink_CountWebLinks(links)):
                size = pdfium_c.FPDFLink_GetURL(links, link_index, None, 0)
                if size <= 1:
                    continue
                buffer = (ctypes.c_ushort * size)()
                pdfium_c.FPDFLink_GetURL(links, link_index, buffer, size)
                url = "".join(chr(value) for value in buffer[: size - 1])
                href = _safe_href(url)
                if not href:
                    continue
                start, count = ctypes.c_int(), ctypes.c_int()
                if pdfium_c.FPDFLink_GetTextRange(links, link_index, ctypes.byref(start), ctypes.byref(count)):
                    for char_index in range(start.value, start.value + count.value):
                        if char_index in by_index:
                            by_index[char_index].href = href
        finally:
            pdfium_c.FPDFLink_CloseWebLinks(links)
    # Link annotations (a word that links somewhere without showing the URL).
    position = ctypes.c_int(0)
    link = pdfium_c.FPDF_LINK()
    while pdfium_c.FPDFLink_Enumerate(page.raw, ctypes.byref(position), ctypes.byref(link)):
        action = pdfium_c.FPDFLink_GetAction(link)
        if not action or pdfium_c.FPDFAction_GetType(action) != pdfium_c.PDFACTION_URI:
            continue
        size = pdfium_c.FPDFAction_GetURIPath(pdf.raw, action, None, 0)
        if size <= 1:
            continue
        buffer = ctypes.create_string_buffer(size)
        pdfium_c.FPDFAction_GetURIPath(pdf.raw, action, buffer, size)
        href = _safe_href(buffer.raw.rstrip(b"\x00").decode("utf-8", errors="ignore"))
        rect = pdfium_c.FS_RECTF()
        if not href or not pdfium_c.FPDFLink_GetAnnotRect(link, ctypes.byref(rect)):
            continue
        x0, y0, x1, y1 = transform.box(rect.left, rect.bottom, rect.right, rect.top)
        for glyph in glyphs:
            center_x = (glyph.x0 + glyph.x1) / 2
            if x0 - 1 <= center_x <= x1 + 1 and y0 - 1 <= glyph.baseline <= y1 + 1:
                glyph.href = glyph.href or href


def _safe_href(value: str) -> str | None:
    trimmed = value.strip()
    if re.match(r"^(https?://|mailto:)\S+$", trimmed, re.I) and len(trimmed) <= 2000:
        return trimmed
    if re.match(r"^www\.\S+\.\S+$", trimmed, re.I):
        return f"https://{trimmed}"
    return None


def _matrix(obj: Any) -> tuple[float, float, float, float, float, float]:
    matrix = pdfium_c.FS_MATRIX()
    if not pdfium_c.FPDFPageObj_GetMatrix(obj, ctypes.byref(matrix)):
        return (1, 0, 0, 1, 0, 0)
    return (matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)


def _apply(m: tuple[float, ...], x: float, y: float) -> tuple[float, float]:
    return m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]


def _compose(outer: tuple[float, ...], inner: tuple[float, ...]) -> tuple[float, float, float, float, float, float]:
    a, b, c, d, e, f = inner
    oa, ob, oc, od, oe, of = outer
    return (
        a * oa + b * oc,
        a * ob + b * od,
        c * oa + d * oc,
        c * ob + d * od,
        e * oa + f * oc + oe,
        e * ob + f * od + of,
    )


def _object_bounds(obj: Any, parent: tuple[float, ...]) -> tuple[float, float, float, float] | None:
    left, bottom, right, top = (ctypes.c_float() for _ in range(4))
    if not pdfium_c.FPDFPageObj_GetBounds(
        obj, ctypes.byref(left), ctypes.byref(bottom), ctypes.byref(right), ctypes.byref(top)
    ):
        return None
    corners = [
        _apply(parent, left.value, bottom.value),
        _apply(parent, right.value, top.value),
        _apply(parent, left.value, top.value),
        _apply(parent, right.value, bottom.value),
    ]
    xs = [point[0] for point in corners]
    ys = [point[1] for point in corners]
    return min(xs), min(ys), max(xs), max(ys)


def _walk_objects(container: Any, *, form: bool, parent: tuple[float, ...], depth: int = 0):
    """Yields (object, type, parent matrix) for page and nested form objects."""

    if depth > 12:
        return
    count = pdfium_c.FPDFFormObj_CountObjects(container) if form else pdfium_c.FPDFPage_CountObjects(container)
    for index in range(max(0, count)):
        obj = pdfium_c.FPDFFormObj_GetObject(container, index) if form else pdfium_c.FPDFPage_GetObject(container, index)
        if not obj:
            continue
        kind = pdfium_c.FPDFPageObj_GetType(obj)
        if kind == pdfium_c.FPDF_PAGEOBJ_FORM:
            yield from _walk_objects(obj, form=True, parent=_compose(parent, _matrix(obj)), depth=depth + 1)
        else:
            yield obj, kind, parent


def _stroke_segments(obj: Any, parent: tuple[float, ...], transform: _Transform) -> list[tuple[float, float, float, float]]:
    """Straight segments of a stroked path, in display space."""

    matrix = _compose(parent, _matrix(obj))
    points: list[tuple[float, float, int, bool]] = []
    x, y = ctypes.c_float(), ctypes.c_float()
    for index in range(max(0, pdfium_c.FPDFPath_CountSegments(obj))):
        segment = pdfium_c.FPDFPath_GetPathSegment(obj, index)
        if not segment or not pdfium_c.FPDFPathSegment_GetPoint(segment, ctypes.byref(x), ctypes.byref(y)):
            continue
        page_x, page_y = _apply(matrix, x.value, y.value)
        points.append((*transform.point(page_x, page_y), pdfium_c.FPDFPathSegment_GetType(segment), bool(pdfium_c.FPDFPathSegment_GetClose(segment))))
    lines: list[tuple[float, float, float, float]] = []
    start: tuple[float, float] | None = None
    previous: tuple[float, float] | None = None
    for px, py, kind, closes in points:
        if kind == pdfium_c.FPDF_SEGMENT_MOVETO or previous is None:
            start = previous = (px, py)
            continue
        if kind == pdfium_c.FPDF_SEGMENT_LINETO:
            lines.append((previous[0], previous[1], px, py))
        previous = (px, py)
        if closes and start is not None:
            lines.append((px, py, start[0], start[1]))
    return lines


@dataclass(slots=True)
class _Graphics:
    pictures: list[Picture]
    rules: list[Rule]
    vrules: list[VRule]
    fills: list[Fill]
    art: list[Art]
    # Opaque pictures with their paint order, for text they cover.
    occluders: list[tuple[float, float, float, float, int]]
    # Shapes whose reported fill is white or a pattern: sampled from a render.
    unsure_fills: list[Fill]


def _extract_graphics(
    pdf: pdfium.PdfDocument,
    page: pdfium.PdfPage,
    number: int,
    transform: _Transform,
    warnings: list[str],
    objects: list[tuple[Any, int, tuple[float, ...]]],
    budget: _Budget | None = None,
) -> _Graphics:
    pictures: list[Picture] = []
    rules: list[Rule] = []
    vrules: list[VRule] = []
    fills: list[Fill] = []
    art: list[Art] = []
    occluders: list[tuple[float, float, float, float, int]] = []
    unsure: list[Fill] = []
    page_area = transform.width * transform.height
    for order, (obj, kind, parent) in enumerate(objects):
        if kind == pdfium_c.FPDF_PAGEOBJ_TEXT:
            continue
        bounds = _object_bounds(obj, parent)
        if bounds is None:
            continue
        x0, y0, x1, y1 = transform.box(*bounds)
        # Content drawn off the page is never seen; clip what overhangs it.
        if x1 < 0 or y1 < 0 or x0 > transform.width or y0 > transform.height:
            continue
        x0, y0 = max(0.0, x0), max(0.0, y0)
        x1, y1 = min(transform.width, x1), min(transform.height, y1)
        if kind == pdfium_c.FPDF_PAGEOBJ_PATH:
            width, height = x1 - x0, y1 - y0
            fill_mode, stroke = ctypes.c_int(0), ctypes.c_int(0)
            pdfium_c.FPDFPath_GetDrawMode(obj, ctypes.byref(fill_mode), ctypes.byref(stroke))
            # Thin shapes are rules: underlines, signature lines, separators,
            # and table borders. Other vector art is not reconstructed.
            if width >= 6 and height <= 2.5:
                rules.append(Rule(number, x0, x1, (y0 + y1) / 2, max(0.5, height), _path_color(obj)))
                continue
            if height >= 6 and width <= 2.5:
                vrules.append(VRule(number, (x0 + x1) / 2, y0, y1, max(0.5, width), _path_color(obj)))
                continue
            if width >= 1 and height >= 1 and width * height <= page_area * 0.6:
                art.append(Art(x0, y0, x1, y1))
            if stroke.value and not fill_mode.value:
                # Stroked boxes and lines (cell borders drawn as rectangles).
                stroke_width = ctypes.c_float(1.0)
                pdfium_c.FPDFPageObj_GetStrokeWidth(obj, ctypes.byref(stroke_width))
                thickness = max(0.5, float(stroke_width.value))
                color = _path_color(obj)
                for ax, ay, bx, by in _stroke_segments(obj, parent, transform):
                    if abs(ay - by) <= 0.6 and abs(ax - bx) >= 6:
                        rules.append(Rule(number, min(ax, bx), max(ax, bx), (ay + by) / 2, thickness, color))
                    elif abs(ax - bx) <= 0.6 and abs(ay - by) >= 6:
                        vrules.append(VRule(number, (ax + bx) / 2, min(ay, by), max(ay, by), thickness, color))
                continue
            if (
                width >= 4
                and height > 2.5
                and width * height <= page_area * 0.3
                and pdfium_c.FPDFPath_GetDrawMode(obj, ctypes.byref(fill_mode), ctypes.byref(stroke))
                and fill_mode.value
            ):
                color = _fill_color(obj)
                if color is not None:
                    fills.append(Fill(x0, y0, x1, y1, color))
                elif width * height >= 400:
                    unsure.append(Fill(x0, y0, x1, y1, "#ffffff"))
            continue
        if kind != pdfium_c.FPDF_PAGEOBJ_IMAGE:
            continue
        if x1 - x0 < 3 or y1 - y0 < 3:
            continue
        if budget is not None and budget.over_pictures:
            # Past the size budget nothing more is kept; skip the encoding.
            if not pdfium_c.FPDFPageObj_HasTransparency(obj):
                occluders.append((x0, y0, x1, y1, order))
            continue
        try:
            raw_bitmap = pdfium_c.FPDFImageObj_GetRenderedBitmap(pdf.raw, page.raw, obj)
            if not raw_bitmap:
                continue
            bitmap = pdfium.PdfBitmap.from_raw(raw_bitmap)
            try:
                image = bitmap.to_pil()
                data_url = _image_data_url(image, display_width_pt=x1 - x0)
            finally:
                bitmap.close()
        except Exception:
            warnings.append(f"A picture on page {number} could not be read and was left out.")
            continue
        pictures.append(Picture(number, x0, x1, y0, y1, data_url))
        if not pdfium_c.FPDFPageObj_HasTransparency(obj):
            occluders.append((x0, y0, x1, y1, order))
    # Pathological pages (maps, plots, patterns) keep their text; their
    # thousands of shapes are not reconstructed.
    if len(rules) + len(vrules) > MAX_RULES_PER_PAGE:
        rules, vrules = [], []
    if len(art) > MAX_ART_SHAPES_PER_PAGE:
        art = []
        warnings.append(f"The drawing on page {number} is too detailed to rebuild and was left out.")
    fills = sorted(fills, key=lambda fill: (fill.x1 - fill.x0) * (fill.top - fill.bottom))[:MAX_FILLS_PER_PAGE]
    unsure = sorted(unsure, key=lambda fill: -(fill.x1 - fill.x0) * (fill.top - fill.bottom))[:40]
    return _Graphics(pictures, _merge_rules(rules), _merge_vrules(vrules), fills, art, occluders, unsure)


def _merge_vrules(rules: list[VRule]) -> list[VRule]:
    merged: list[VRule] = []
    for rule in sorted(rules, key=lambda item: (round(item.x, 1), item.y0)):
        last = merged[-1] if merged else None
        if last and abs(last.x - rule.x) <= 0.6 and rule.y0 <= last.y1 + 1.5:
            last.y1 = max(last.y1, rule.y1)
            last.thickness = max(last.thickness, rule.thickness)
        else:
            merged.append(VRule(rule.page, rule.x, rule.y0, rule.y1, rule.thickness, rule.color))
    return merged


def _fill_color(obj: Any) -> str | None:
    """A shape's visible fill color; white and transparent fills are paper."""

    red, green, blue, alpha = (ctypes.c_uint() for _ in range(4))
    if not pdfium_c.FPDFPageObj_GetFillColor(obj, ctypes.byref(red), ctypes.byref(green), ctypes.byref(blue), ctypes.byref(alpha)):
        return None
    if alpha.value < 128 or min(red.value, green.value, blue.value) >= 250:
        return None
    return f"#{red.value:02x}{green.value:02x}{blue.value:02x}"


def _mark_backgrounds(glyphs: list[Glyph], fills: list[Fill]) -> None:
    """Text over a filled shape (a highlight or shaded cell) keeps that
    shading behind it; the smallest shape under a glyph wins."""

    if not fills:
        return
    ordered = sorted(fills, key=lambda fill: (fill.x1 - fill.x0) * (fill.top - fill.bottom))
    for glyph in glyphs:
        x = (glyph.x0 + glyph.x1) / 2
        y = glyph.baseline + glyph.style.size_pt * 0.3
        for fill in ordered:
            if fill.x0 <= x <= fill.x1 and fill.bottom <= y <= fill.top:
                glyph.background = fill.color
                break


def _path_color(obj: Any) -> str:
    red, green, blue, alpha = (ctypes.c_uint() for _ in range(4))
    for getter in (pdfium_c.FPDFPageObj_GetStrokeColor, pdfium_c.FPDFPageObj_GetFillColor):
        if getter(obj, ctypes.byref(red), ctypes.byref(green), ctypes.byref(blue), ctypes.byref(alpha)) and alpha.value:
            return f"#{red.value:02x}{green.value:02x}{blue.value:02x}"
    return DEFAULT_COLOR


def _merge_rules(rules: list[Rule]) -> list[Rule]:
    merged: list[Rule] = []
    for rule in sorted(rules, key=lambda item: (round(item.y, 1), item.x0)):
        last = merged[-1] if merged else None
        if last and abs(last.y - rule.y) <= 0.6 and rule.x0 <= last.x1 + 1.5:
            last.x1 = max(last.x1, rule.x1)
            last.thickness = max(last.thickness, rule.thickness)
        else:
            merged.append(Rule(rule.page, rule.x0, rule.x1, rule.y, rule.thickness, rule.color))
    return merged


def _image_data_url(image: Any, *, display_width_pt: float) -> str:
    # Twice the displayed size keeps small art crisp; large photos need less.
    density = 2.0 if px_from_pt(display_width_pt) <= 320 else 1.5
    max_pixel_width = max(1, int(math.ceil(px_from_pt(display_width_pt) * density)))
    if image.width > max_pixel_width:
        height = max(1, int(round(image.height * (max_pixel_width / image.width))))
        image = image.resize((max_pixel_width, height))
    has_alpha = image.mode in {"RGBA", "LA"} and image.getextrema()[-1][0] < 255
    buffer = io.BytesIO()
    if has_alpha or (image.mode in {"1", "L", "P"} and image.width * image.height < 250_000):
        image.save(buffer, format="PNG", optimize=True)
        return f"data:image/png;base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"
    image.convert("RGB").save(buffer, format="JPEG", quality=80, optimize=True)
    return f"data:image/jpeg;base64,{base64.b64encode(buffer.getvalue()).decode('ascii')}"


# ------------------------------------------------------------------ lines


def _dominant_style(glyphs: list[Glyph]) -> TextStyle:
    weights: Counter[TextStyle] = Counter()
    for glyph in glyphs:
        if not glyph.is_space and not glyph.raised:
            weights[glyph.style] += len(glyph.text)
    if not weights:
        return glyphs[0].style
    return weights.most_common(1)[0][0]


def _build_lines(glyphs: list[Glyph], page: int) -> list[Line]:
    """Clusters glyphs into visual lines by baseline, folds raised small text
    into the line below as superscript, and splits each line into segments at
    wide gaps (columns, tab-aligned text)."""

    visible = [glyph for glyph in glyphs if not glyph.invisible] or glyphs
    ordered = sorted(visible, key=lambda glyph: (-round(glyph.baseline, 1), glyph.x0))
    clusters: list[list[Glyph]] = []
    anchor = None
    for glyph in ordered:
        tolerance = max(1.5, glyph.style.size_pt * 0.3)
        if clusters and anchor is not None and abs(anchor - glyph.baseline) <= tolerance:
            clusters[-1].append(glyph)
        else:
            clusters.append([glyph])
            anchor = glyph.baseline
    # Superscripts: a cluster of small text sitting just above a line.
    merged: list[list[Glyph]] = []
    for index, cluster in enumerate(clusters):
        solid = [glyph for glyph in cluster if not glyph.is_space]
        if not solid:
            continue
        size = max(glyph.style.size_pt for glyph in solid)
        below = clusters[index + 1] if index + 1 < len(clusters) else None
        if below:
            below_solid = [glyph for glyph in below if not glyph.is_space]
            if below_solid:
                below_size = max(glyph.style.size_pt for glyph in below_solid)
                rise = median(glyph.baseline for glyph in solid) - median(glyph.baseline for glyph in below_solid)
                # Footnote marks sit just after (or before) the text they mark.
                reach = below_size * 2
                overlaps = (
                    min(g.x0 for g in solid) <= max(g.x1 for g in below_solid) + reach
                    and max(g.x1 for g in solid) >= min(g.x0 for g in below_solid) - reach
                )
                if size <= below_size * 0.8 and 0 < rise <= below_size * 0.7 and overlaps:
                    for glyph in cluster:
                        glyph.raised = True
                    below.extend(cluster)
                    continue
        merged.append(cluster)
    lines: list[Line] = []
    for raw_cluster in merged:
        cluster = _ordered_with_spaces(raw_cluster)
        solid = [glyph for glyph in cluster if not glyph.is_space]
        if not solid:
            continue
        style = _dominant_style(cluster)
        segments: list[list[Glyph]] = [[]]
        last_solid: Glyph | None = None
        for glyph in cluster:
            if glyph.is_space:
                if segments[-1]:
                    segments[-1].append(glyph)
                continue
            if last_solid is not None:
                gap = glyph.x0 - last_solid.x1
                size = max(glyph.style.size_pt, last_solid.style.size_pt)
                if gap > max(2.2 * size, 16.0):
                    while segments[-1] and segments[-1][-1].is_space:
                        segments[-1].pop()
                    segments.append([])
            segments[-1].append(glyph)
            last_solid = glyph
        segments = [segment for segment in segments if any(not glyph.is_space for glyph in segment)]
        baseline = median(glyph.baseline for glyph in solid if not glyph.raised) if any(
            not glyph.raised for glyph in solid
        ) else median(glyph.baseline for glyph in solid)
        lines.append(
            Line(
                page=page,
                glyphs=cluster,
                segments=segments,
                x0=solid[0].x0,
                x1=max(glyph.x1 for glyph in solid),
                top=max(glyph.top for glyph in solid),
                bottom=min(glyph.bottom for glyph in solid),
                baseline=baseline,
                style=style,
                text=_plain_text(cluster),
            )
        )
    return sorted(lines, key=lambda line: (-line.baseline, line.x0))


def _ordered_with_spaces(cluster: list[Glyph]) -> list[Glyph]:
    """Visible glyphs left to right, with a space kept between two of them
    only where a space glyph actually sits between them. Space glyphs can be
    zero-width or misplaced, so they are never sorted with the letters."""

    solids = sorted((glyph for glyph in cluster if not glyph.is_space), key=lambda glyph: (glyph.x0, glyph.x1))
    spaces = sorted(((glyph.x0 + glyph.x1) / 2, glyph) for glyph in cluster if glyph.is_space)
    centers = [center for center, _glyph in spaces]
    ordered: list[Glyph] = []
    for index, glyph in enumerate(solids):
        if index:
            previous = solids[index - 1]
            low = (previous.x0 + previous.x1) / 2
            high = (glyph.x0 + glyph.x1) / 2
            position = bisect.bisect_right(centers, low)
            if position < len(centers) and centers[position] < high:
                ordered.append(spaces[position][1])
        ordered.append(glyph)
    return ordered


def _word_gap(glyphs: list[Glyph]) -> float:
    """Smallest gap between two glyphs that reads as a word space: clearly
    wider than this line's own letter spacing (tracked capitals included)."""

    solids = [glyph for glyph in glyphs if not glyph.is_space]
    if len(solids) < 2:
        return solids[0].style.size_pt * 0.15 if solids else 2.0
    gaps = sorted(max(0.0, b.x0 - a.x1) for a, b in zip(solids, solids[1:], strict=False))
    letter = gaps[len(gaps) // 3]
    size = median(glyph.style.size_pt for glyph in solids)
    return max(size * 0.12, letter + size * 0.08)


def _plain_text(glyphs: list[Glyph]) -> str:
    out: list[str] = []
    previous: Glyph | None = None
    threshold = _word_gap(glyphs)
    for glyph in glyphs:
        if glyph.is_space:
            if out and out[-1] != " ":
                out.append(" ")
        else:
            if previous is not None and out and out[-1] != " ":
                if glyph.x0 - previous.x1 > threshold:
                    out.append(" ")
            out.append(glyph.text)
            previous = glyph
    return "".join(out).strip()


def _mark_underlines(lines: list[Line], rules: list[Rule]) -> list[Rule]:
    """Rules just under a run of text underline it; the rest stay rules."""

    used: set[int] = set()
    for line in lines:
        size = line.size
        for rule_index, rule in enumerate(rules):
            if not (line.baseline - size * 0.22 <= rule.y <= line.baseline + size * 0.02):
                continue
            covered = [
                glyph
                for glyph in line.glyphs
                if not glyph.is_space and rule.x0 - 0.5 <= (glyph.x0 + glyph.x1) / 2 <= rule.x1 + 0.5
            ]
            if not covered:
                continue
            # An underline is as long as its words; a table border is not.
            span = max(glyph.x1 for glyph in covered) - min(glyph.x0 for glyph in covered)
            if rule.x1 - rule.x0 > span + 2 * size:
                continue
            for glyph in line.glyphs:
                if rule.x0 - 0.5 <= (glyph.x0 + glyph.x1) / 2 <= rule.x1 + 0.5:
                    glyph.underline = True
            used.add(rule_index)
    return [rule for index, rule in enumerate(rules) if index not in used]


# ------------------------------------------------------------------ scanned pages


def _ocr_glyphs(page: pdfium.PdfPage, height: float, timeout: float = 45.0) -> list[Glyph] | None:
    try:
        import pytesseract  # type: ignore[import-not-found]
    except ImportError:
        return None
    bitmap = image = None
    try:
        bitmap = page.render(scale=2, rotation=0)
        image = bitmap.to_pil()
        data = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT, timeout=timeout)
    except Exception:
        return None
    finally:
        if image is not None:
            image.close()
        if bitmap is not None:
            bitmap.close()
    glyphs: list[Glyph] = []
    for index, raw_text in enumerate(data.get("text", [])):
        text = str(raw_text).strip()
        try:
            confidence = float(data["conf"][index])
        except (KeyError, ValueError, IndexError):
            confidence = -1
        text = _CONTROL_CHARACTERS.sub("", text)
        if not text or confidence < 0:
            continue
        left = float(data["left"][index]) / 2
        top = float(data["top"][index]) / 2
        width = float(data["width"][index]) / 2
        box_height = float(data["height"][index]) / 2
        size = max(6.0, round(box_height * 1.35 * 2) / 2)
        style = _style(None, size)
        upper = height - top
        lower = upper - box_height
        glyphs.append(
            Glyph(text=text, x0=left, x1=left + width, bottom=lower, top=upper, baseline=lower + box_height * 0.18, style=style)
        )
    return glyphs or None


def _page_render_picture(page: pdfium.PdfPage, content: PageContent) -> Picture:
    bitmap = page.render(scale=2, rotation=0)
    try:
        image = bitmap.to_pil()
        data_url = _image_data_url(image, display_width_pt=content.width)
    finally:
        bitmap.close()
    return Picture(content.number, 0, content.width, 0, content.height, data_url)


class _PageRender:
    """One 2x render of the page, made only when something needs pixels."""

    scale = 2.0

    def __init__(self, page: pdfium.PdfPage) -> None:
        self.page = page
        self.image: Any = None

    def get(self) -> Any:
        if self.image is None:
            bitmap = self.page.render(scale=self.scale, rotation=0)
            try:
                self.image = bitmap.to_pil().convert("RGB").copy()
            finally:
                bitmap.close()
        return self.image

    def crop(self, x0: float, y0: float, x1: float, y1: float, height: float) -> Any:
        image = self.get()
        left = max(0, int(math.floor(x0 * self.scale)))
        right = min(image.width, int(math.ceil(x1 * self.scale)))
        upper = max(0, int(math.floor((height - y1) * self.scale)))
        lower = min(image.height, int(math.ceil((height - y0) * self.scale)))
        if right - left < 2 or lower - upper < 2:
            return None
        return image.crop((left, upper, right, lower))


def _text_art(glyphs: list[Glyph]) -> tuple[list[Glyph], list[Art]]:
    """Lettering used as artwork: rotated text, and wordmarks whose letters
    are placed one by one at varying heights. Laid out as lines it would
    scatter, so it is captured as a picture with the rest of the artwork."""

    art: list[Art] = []
    rotated = [glyph for glyph in glyphs if glyph.rotated and not glyph.is_space]
    if rotated:
        art.append(
            Art(
                min(glyph.x0 for glyph in rotated),
                min(glyph.bottom for glyph in rotated),
                max(glyph.x1 for glyph in rotated),
                max(glyph.top for glyph in rotated),
            )
        )
    remaining = [glyph for glyph in glyphs if not glyph.rotated]
    # Scattered display lettering: many one- or two-glyph clusters of large
    # text crowded into a small area.
    solids = [glyph for glyph in remaining if not glyph.is_space and glyph.style.size_pt >= 14]
    lines = _build_lines(solids, 0) if solids else []
    for glyph in solids:
        glyph.raised = False  # the real line pass decides superscripts
    fragments = [line for line in lines if len([g for g in line.glyphs if not g.is_space]) <= 2]
    groups: list[list[Line]] = []
    for line in fragments:
        reach = line.size * 2.5
        group = next(
            (
                existing
                for existing in groups
                if any(abs(other.baseline - line.baseline) <= reach and other.x0 - reach <= line.x1 and line.x0 <= other.x1 + reach for other in existing)
            ),
            None,
        )
        if group is None:
            groups.append([line])
        else:
            group.append(line)
    dropped: set[int] = set()
    for group in groups:
        if len(group) < 3:
            continue
        members = [glyph for line in group for glyph in line.glyphs]
        art.append(
            Art(
                min(glyph.x0 for glyph in members),
                min(glyph.bottom for glyph in members),
                max(glyph.x1 for glyph in members),
                max(glyph.top for glyph in members),
            )
        )
        dropped |= {id(glyph) for glyph in members}
    return [glyph for glyph in remaining if id(glyph) not in dropped], art


def _sampled_fills(render: _PageRender, unsure: list[Fill], glyphs: list[Glyph], height: float) -> list[Fill]:
    """Gradient or pattern fills report no usable color; the rendered page
    shows the color a reader saw. Points next to text are not sampled."""

    found: list[Fill] = []
    if not unsure:
        return found
    image = render.get()
    for fill in unsure:
        samples = []
        for fx, fy in ((0.25, 0.25), (0.75, 0.25), (0.5, 0.5), (0.25, 0.75), (0.75, 0.75), (0.1, 0.5), (0.9, 0.5)):
            x = fill.x0 + (fill.x1 - fill.x0) * fx
            y = fill.bottom + (fill.top - fill.bottom) * fy
            if any(g.x0 - 1 <= x <= g.x1 + 1 and g.bottom - 1 <= y <= g.top + 1 for g in glyphs if not g.is_space):
                continue
            px = min(image.width - 1, max(0, int(x * render.scale)))
            py = min(image.height - 1, max(0, int((height - y) * render.scale)))
            samples.append(image.getpixel((px, py)))
        if not samples:
            continue
        red, green, blue = (int(median(sample[channel] for sample in samples)) for channel in range(3))
        if min(red, green, blue) >= 248:
            continue
        found.append(Fill(fill.x0, fill.bottom, fill.x1, fill.top, f"#{red:02x}{green:02x}{blue:02x}"))
    return found


def _luminance(color: str) -> float:
    red, green, blue = (int(color[index : index + 2], 16) / 255 for index in (1, 3, 5))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def _extract_page(
    pdf: pdfium.PdfDocument,
    page: pdfium.PdfPage,
    number: int,
    warnings: list[str],
    budget: _Budget | None = None,
) -> PageContent:
    budget = budget or _Budget(deadline=time.monotonic() + IMPORT_TIME_BUDGET_SECONDS)
    transform = _Transform(page)
    content = PageContent(number=number, width=transform.width, height=transform.height)
    render = _PageRender(page)
    identity = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    objects = list(_walk_objects(page.raw, form=False, parent=identity))
    text_order = {
        _object_key(obj): order for order, (obj, kind, _parent) in enumerate(objects) if kind == pdfium_c.FPDF_PAGEOBJ_TEXT
    }
    textpage = page.get_textpage()
    try:
        glyphs = _extract_glyphs(textpage, transform, text_order)
        _mark_links(pdf, textpage, page, glyphs, transform)
    finally:
        textpage.close()
    graphics = _extract_graphics(pdf, page, number, transform, warnings, objects, budget)
    pictures, rules, vrules, art = graphics.pictures, graphics.rules, graphics.vrules, graphics.art
    # Text painted over by an opaque picture is not part of the page.
    if graphics.occluders:
        glyphs = [
            glyph
            for glyph in glyphs
            if not any(
                order > glyph.order >= 0
                and x0 <= (glyph.x0 + glyph.x1) / 2 <= x1
                and y0 <= glyph.baseline + glyph.style.size_pt * 0.3 <= y1
                for x0, y0, x1, y1, order in graphics.occluders
            )
        ]
    fills = graphics.fills + _sampled_fills(render, graphics.unsure_fills, glyphs, content.height)
    _mark_backgrounds(glyphs, fills)
    page_area = content.width * content.height
    full_page = [picture for picture in pictures if (picture.x1 - picture.x0) * (picture.top - picture.bottom) >= page_area * 0.6]
    visible = [glyph for glyph in glyphs if not glyph.invisible]
    if full_page and not visible:
        content.scanned = True
        pictures = [picture for picture in pictures if picture not in full_page]
        if glyphs:
            # A scan with a recognized-text layer: the text is the document.
            warnings.append(
                f"Page {number} is a scanned image with recognized text; its layout is rebuilt from that text. Check it against the original."
            )
        else:
            recognized = None
            if budget.ocr_enabled and budget.ocr_pages < budget.ocr_max_pages and time.monotonic() < budget.deadline:
                budget.ocr_pages += 1
                recognized = _ocr_glyphs(page, content.height, budget.ocr_timeout)
            if recognized:
                glyphs = recognized
                warnings.append(
                    f"Page {number} is a scanned image; its text was recognized automatically. Check it against the original."
                )
            else:
                pictures = [_page_render_picture(page, content)]
                warnings.append(
                    f"Page {number} is a scanned image and was added as a picture; its text is not editable."
                )
    elif full_page and visible:
        solid = [glyph for glyph in visible if not glyph.is_space]
        light = sum(1 for glyph in solid if _luminance(glyph.style.color) > 0.75)
        if solid and light / len(solid) >= 0.3:
            # Light text over a full-page photo is a designed page (a cover):
            # without its picture the text would vanish, so the page itself
            # becomes the picture.
            rendered = _page_render_picture(page, content)
            content.pictures = [rendered] if budget.take_picture(rendered.data_url, number, warnings) else []
            warnings.append(
                f"Page {number} is a designed page (text over a full-page picture) and was added as a picture; its text is not editable."
            )
            return content
        # A full-page picture under dark text is a background or letterhead
        # design; drawing it in the flow would push the text off the page.
        pictures = [picture for picture in pictures if picture not in full_page]
        warnings.append(f"The full-page background picture on page {number} was left out.")
    glyphs, text_art = _text_art(glyphs)
    art = art + text_art
    content.lines = _build_lines(glyphs, number) if glyphs else []
    content.rules = _mark_underlines(content.lines, rules)
    content.vrules = vrules
    content.fills = fills
    kept = pictures + _vector_pictures(
        render, content, art, [glyph for glyph in glyphs if not glyph.invisible], warnings, budget
    )
    # The size budget pays only for pictures that stay in the document.
    content.pictures = [picture for picture in kept if budget.take_picture(picture.data_url, number, warnings)]
    return content


def _vector_pictures(
    render: _PageRender,
    content: PageContent,
    art: list[Art],
    glyphs: list[Glyph],
    warnings: list[str],
    budget: _Budget | None = None,
) -> list[Picture]:
    """Vector artwork with no text inside it (logos, icons, decorative
    shapes, charts drawn as paths) is kept as a picture cropped from a render
    of the page, so it appears where the source drew it."""

    if not art:
        return []
    boxes = [[item.x0, item.bottom, item.x1, item.top] for item in art]
    merged: list[list[float]] = []
    for box in sorted(boxes, key=lambda item: (item[0], item[1])):
        for target in merged:
            if box[0] <= target[2] + 3 and box[2] >= target[0] - 3 and box[1] <= target[3] + 3 and box[3] >= target[1] - 3:
                target[0], target[1] = min(target[0], box[0]), min(target[1], box[1])
                target[2], target[3] = max(target[2], box[2]), max(target[3], box[3])
                break
        else:
            merged.append(list(box))
    # Merging can chain; a few passes settle it (bounded: each pass is one
    # sweep over the regions found so far).
    for _pass in range(4):
        settled: list[list[float]] = []
        for box in merged:
            for target in settled:
                if box[0] <= target[2] + 3 and box[2] >= target[0] - 3 and box[1] <= target[3] + 3 and box[3] >= target[1] - 3:
                    target[0], target[1] = min(target[0], box[0]), min(target[1], box[1])
                    target[2], target[3] = max(target[2], box[2]), max(target[3], box[3])
                    break
            else:
                settled.append(list(box))
        if len(settled) == len(merged):
            break
        merged = settled
    page_area = content.width * content.height
    regions = []
    for x0, y0, x1, y1 in merged:
        width, height = x1 - x0, y1 - y0
        if width < 4 or height < 4 or width * height < 40 or width * height > page_area * 0.6:
            continue
        if any(
            x0 <= (glyph.x0 + glyph.x1) / 2 <= x1 and y0 <= glyph.baseline + glyph.style.size_pt * 0.3 <= y1
            for glyph in glyphs
            if not glyph.is_space
        ):
            continue
        regions.append((x0, y0, x1, y1))
    if not regions:
        return []
    pictures: list[Picture] = []
    try:
        for x0, y0, x1, y1 in regions:
            x0, y0 = max(0.0, x0 - 1), max(0.0, y0 - 1)
            x1, y1 = min(content.width, x1 + 1), min(content.height, y1 + 1)
            crop = render.crop(x0, y0, x1, y1, content.height)
            if crop is None:
                continue
            if budget is not None and budget.over_pictures:
                break
            pictures.append(Picture(content.number, x0, x1, y0, y1, _image_data_url(crop, display_width_pt=x1 - x0)))
    except Exception:
        warnings.append(f"Drawn artwork on page {content.number} could not be captured and was left out.")
    return pictures


# ------------------------------------------------------------------ headers and footers


def _normalized(text: str) -> str:
    return _DIGITS.sub("#", re.sub(r"\s+", " ", text).strip().lower())


RUNNING_ZONE = 0.085


def _detect_running_content(pages: list[PageContent]) -> None:
    """Marks running headers and footers. Text in the top/bottom band counts
    when it repeats across pages, or when it is set apart from the page's
    body by a clear gap, no larger than body text, and sits where other pages
    have running text too (or on the first or last page: a letterhead, a
    closing footer). Pictures in those bands (a letterhead logo) the same."""

    if len(pages) == 1:
        page = pages[0]
        for line in page.lines:
            if line.top <= page.height * RUNNING_ZONE and _PAGE_NUMBER_ONLY.match(line.text):
                line.is_footer = True
        return
    threshold = max(2, math.ceil(len(pages) * 0.5))
    top: defaultdict[str, set[int]] = defaultdict(set)
    bottom: defaultdict[str, set[int]] = defaultdict(set)
    for page in pages:
        for line in page.lines:
            key = _normalized(line.text)
            if not key:
                continue
            if line.bottom >= page.height * (1 - HEADER_FOOTER_ZONE):
                top[key].add(page.number)
            if line.top <= page.height * HEADER_FOOTER_ZONE:
                bottom[key].add(page.number)
    for page in pages:
        for line in page.lines:
            key = _normalized(line.text)
            if line.bottom >= page.height * (1 - HEADER_FOOTER_ZONE) and len(top.get(key, ())) >= threshold:
                line.is_header = True
            elif line.top <= page.height * HEADER_FOOTER_ZONE and len(bottom.get(key, ())) >= threshold:
                line.is_footer = True

    sizes = [line.size for page in pages for line in page.lines for _ in range(max(1, len(line.text)))]
    body_size = Counter(sizes).most_common(1)[0][0] if sizes else DEFAULT_FONT_SIZE_PT
    gap_needed = max(16.0, body_size * 1.6)

    def candidates(kind: str) -> dict[int, list[Line]]:
        found: dict[int, list[Line]] = {}
        for page in pages:
            ordered = sorted(page.lines, key=lambda line: -line.baseline)
            if kind == "footer":
                ordered = ordered[::-1]
            picked: list[Line] = []
            for index, line in enumerate(ordered):
                in_band = (
                    line.bottom >= page.height * (1 - RUNNING_ZONE)
                    if kind == "header"
                    else line.top <= page.height * RUNNING_ZONE
                )
                if not in_band or line.size > body_size + 0.5:
                    break
                following = ordered[index + 1] if index + 1 < len(ordered) else None
                picked.append(line)
                gap = (
                    (line.bottom - following.top if kind == "header" else following.bottom - line.top)
                    if following is not None
                    else gap_needed
                )
                if gap >= gap_needed:
                    found[page.number] = picked
                    break
            # Lines already marked by repetition are not candidates again.
        return found

    last = pages[-1].number
    for kind in ("header", "footer"):
        found = candidates(kind)
        positions = Counter(round(min(line.bottom for line in lines)) for lines in found.values())
        for number, lines in found.items():
            position = round(min(line.bottom for line in lines))
            shared = sum(count for value, count in positions.items() if abs(value - position) <= 3) >= 2
            if shared or number in (1, last):
                for line in lines:
                    if kind == "header":
                        line.is_header = True
                    else:
                        line.is_footer = True

    for page in pages:
        text_lines = [line for line in page.lines if not (line.is_header or line.is_footer)]
        for picture in page.pictures:
            beside = any(line.bottom < picture.top and line.top > picture.bottom for line in text_lines)
            if beside:
                continue
            if picture.bottom >= page.height * 0.8:
                below = [line.top for line in text_lines if line.top <= picture.bottom]
                if (not below or picture.bottom - max(below) >= 12) and page.number in (1, last):
                    picture.running = "header"
            elif picture.top <= page.height * 0.2:
                above = [line.bottom for line in text_lines if line.bottom >= picture.top]
                if (not above or min(above) - picture.top >= 12) and page.number in (1, last):
                    picture.running = "footer"


def _unmark_running(page: PageContent, kind: str) -> None:
    """Puts lines (and pictures) back into the page body."""

    for line in page.lines:
        if kind == "header":
            line.is_header = False
        else:
            line.is_footer = False
    for picture in page.pictures:
        if picture.running == kind:
            picture.running = None


def _running_items(page: PageContent, kind: str) -> tuple[list[Line], list[Picture]]:
    attribute = "is_header" if kind == "header" else "is_footer"
    return (
        [line for line in page.lines if getattr(line, attribute)],
        [picture for picture in page.pictures if picture.running == kind],
    )


def _running_signature(page: PageContent, kind: str) -> tuple[Any, ...]:
    lines, pictures = _running_items(page, kind)
    return (
        tuple(_normalized(line.text) for line in lines),
        tuple((round(picture.x1 - picture.x0), round(picture.top - picture.bottom)) for picture in pictures),
    )


# ------------------------------------------------------------------ paragraphs


def _pitch_table(pages: list[PageContent]) -> dict[float, float]:
    """Most common baseline pitch per font size, from adjacent lines that
    share a left edge — the document's own line spacing."""

    samples: defaultdict[float, list[float]] = defaultdict(list)
    for page in pages:
        body = [line for line in page.lines if not line.is_header and not line.is_footer]
        for upper, lower in zip(body, body[1:], strict=False):
            if abs(upper.size - lower.size) > 0.3:
                continue
            pitch = upper.baseline - lower.baseline
            if upper.size * 0.9 <= pitch <= upper.size * 2.6 and abs(upper.x0 - lower.x0) <= max(40, upper.size * 4):
                samples[upper.size].append(round(pitch * 4) / 4)
    table: dict[float, float] = {}
    for size, values in samples.items():
        common = Counter(values).most_common(1)[0][0]
        table[size] = common
    return table


def _expected_pitch(size: float, style: TextStyle, pitches: dict[float, float]) -> float:
    return pitches.get(size) or size * style.line_factor


def _list_marker(line: Line) -> tuple[list[Glyph], float] | None:
    """Leading bullet or enumerator and the x where the item's text starts."""

    first_segment = line.segments[0]
    solid = [glyph for glyph in first_segment if not glyph.is_space]
    if not solid:
        return None
    if len(line.segments) > 1:
        marker_text = _plain_text(first_segment)
        if _LIST_MARKER.match(marker_text) and len(marker_text) <= 14:
            body = [glyph for glyph in line.segments[1] if not glyph.is_space]
            return first_segment, body[0].x0
    # Marker followed by an ordinary space inside the first segment.
    words: list[list[Glyph]] = [[]]
    for glyph in first_segment:
        if glyph.is_space:
            if words[-1]:
                words.append([])
            continue
        if words[-1] and glyph.x0 - words[-1][-1].x1 > glyph.style.size_pt * 0.18:
            words.append([])
        words[-1].append(glyph)
    words = [word for word in words if word]
    if len(words) < 2:
        return None
    marker_text = "".join(glyph.text for glyph in words[0])
    if not _LIST_MARKER.match(marker_text):
        return None
    # Word-style lists put a real gap after the marker; ordinary prose that
    # happens to start with "a." or "1." has a single space.
    gap = words[1][0].x0 - words[0][-1].x1
    if marker_text[0] not in _BULLETS and gap < line.size * 0.6:
        return None
    end = next(index for index, glyph in enumerate(first_segment) if glyph is words[0][-1])
    return first_segment[: end + 1], words[1][0].x0


def _is_full(line: Line, right: float, width: float) -> bool:
    return line.x1 >= right - max(5 * line.size, width * 0.15)


def _continues(paragraph: Paragraph, line: Line, pitches: dict[float, float]) -> bool:
    previous = paragraph.last
    if line.page != previous.page or line.is_header or line.is_footer:
        return False
    if abs(line.size - previous.size) > 0.75:
        return False
    if _list_marker(line) is not None:
        return False
    pitch = previous.baseline - line.baseline
    expected = _expected_pitch(previous.size, previous.style, pitches)
    if len(paragraph.lines) > 1:
        expected = paragraph.lines[-2].baseline - previous.baseline
    if pitch <= 0 or pitch > expected * 1.25 + 0.75:
        return False
    width = paragraph.column_right - paragraph.column_left
    if not _is_full(previous, paragraph.column_right, width):
        return False
    # Rows of a table or form (text in separate columns) and table-of-contents
    # entries are lines in their own right, never wrapped prose.
    if len(previous.segments) > 1 or len(line.segments) > 1:
        return False
    if _LEADER.search(previous.text) or _LEADER.search(line.text):
        return False
    if paragraph.list_marker is not None and len(paragraph.lines) == 1:
        return abs(line.x0 - paragraph.list_marker[1]) <= 2.5
    if len(paragraph.lines) > 1:
        return abs(line.x0 - paragraph.lines[1].x0) <= 2.5
    # Second line: at the first line's left edge, or left of it (the first
    # line was indented).
    return previous.x0 - 108 <= line.x0 <= previous.x0 + 2.5


def _columns(lines: list[Line], left: float, right: float) -> list[tuple[float, float, list[Line]]]:
    """Splits a two-column page (a steady gutter that most lines respect)."""

    width = right - left
    if len(lines) < 8:
        return [(left, right, lines)]
    gaps: Counter[int] = Counter()
    for line in lines:
        if len(line.segments) == 2:
            first_end = max(glyph.x1 for glyph in line.segments[0] if not glyph.is_space)
            second_start = min(glyph.x0 for glyph in line.segments[1] if not glyph.is_space)
            # Text columns are wide; table cells and tab-aligned labels are not.
            if second_start - first_end >= 12 and first_end - line.x0 >= width * 0.3 and line.x1 - second_start >= width * 0.3:
                gaps[int((first_end + second_start) / 2 / 6)] += 1
    if not gaps:
        return [(left, right, lines)]
    bucket, count = gaps.most_common(1)[0]
    gutter = bucket * 6 + 3
    if count < max(6, len(lines) * 0.4) or not (left + width * 0.3 <= gutter <= left + width * 0.7):
        return [(left, right, lines)]
    left_lines: list[Line] = []
    right_lines: list[Line] = []
    spanning: list[Line] = []
    for line in lines:
        if line.x1 <= gutter + 2:
            left_lines.append(line)
        elif line.x0 >= gutter - 2:
            right_lines.append(line)
        elif len(line.segments) >= 2:
            first, second = _split_line(line, gutter)
            left_lines.append(first)
            right_lines.append(second)
        else:
            spanning.append(line)
    if len(spanning) > len(lines) * 0.25:
        return [(left, right, lines)]
    columns = [(left, gutter - 6, left_lines), (gutter + 6, right, right_lines)]
    if spanning:
        columns.insert(0, (left, right, spanning))
    return columns


def _split_line(line: Line, gutter: float) -> tuple[Line, Line]:
    parts = ([], [])
    for segment in line.segments:
        solid = [glyph for glyph in segment if not glyph.is_space]
        center = (solid[0].x0 + solid[-1].x1) / 2 if solid else gutter
        (parts[0] if center < gutter else parts[1]).append(segment)

    def build(segments: list[list[Glyph]]) -> Line:
        glyphs = [glyph for segment in segments for glyph in segment]
        solid = [glyph for glyph in glyphs if not glyph.is_space] or glyphs
        return Line(
            page=line.page,
            glyphs=glyphs,
            segments=segments,
            x0=solid[0].x0,
            x1=max(glyph.x1 for glyph in solid),
            top=max(glyph.top for glyph in solid),
            bottom=min(glyph.bottom for glyph in solid),
            baseline=line.baseline,
            style=_dominant_style(glyphs),
            text=_plain_text(glyphs),
        )

    return build(parts[0]), build(parts[1])


def _paragraphs(lines: list[Line], left: float, right: float, pitches: dict[float, float]) -> list[Paragraph]:
    result: list[Paragraph] = []
    for line in lines:
        if result and _continues(result[-1], line, pitches):
            result[-1].lines.append(line)
            continue
        result.append(Paragraph([line], line.page, left, right, _list_marker(line)))
    return result


# ------------------------------------------------------------------ tables


@dataclass(slots=True)
class _Cell:
    row: int
    column: int
    rowspan: int
    colspan: int
    x0: float
    x1: float
    top: float
    bottom: float
    lines: list[Line] = field(default_factory=list)


@dataclass(slots=True)
class _Table:
    xs: list[float]
    ys: list[float]
    cells: list[_Cell]
    hrules: list[Rule]
    vrules: list[VRule]

    @property
    def left(self) -> float:
        return self.xs[0]

    @property
    def right(self) -> float:
        return self.xs[-1]

    @property
    def top(self) -> float:
        return self.ys[0]

    @property
    def bottom(self) -> float:
        return self.ys[-1]


def _merge_close(values: list[float], tolerance: float) -> list[float]:
    merged: list[list[float]] = []
    for value in sorted(values):
        if merged and value - merged[-1][-1] <= tolerance:
            merged[-1].append(value)
        else:
            merged.append([value])
    return [sum(group) / len(group) for group in merged]


def _find_tables(page: PageContent) -> list[_Table]:
    """Ruled tables: connected horizontal and vertical rules forming a grid.
    Cells without a dividing rule between them are merged cells."""

    hrules = [rule for rule in page.rules if rule.x1 - rule.x0 >= 8]
    vrules = page.vrules
    if len(hrules) < 2 or len(vrules) < 2:
        return []
    count = len(hrules) + len(vrules)
    parent = list(range(count))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for h_index, h in enumerate(hrules):
        for v_index, v in enumerate(vrules):
            if h.x0 - 2.5 <= v.x <= h.x1 + 2.5 and v.y0 - 2.5 <= h.y <= v.y1 + 2.5:
                parent[find(h_index)] = find(len(hrules) + v_index)
    groups: defaultdict[int, list[int]] = defaultdict(list)
    for index in range(count):
        groups[find(index)].append(index)
    tables: list[_Table] = []
    for members in groups.values():
        hs = [hrules[index] for index in members if index < len(hrules)]
        vs = [vrules[index - len(hrules)] for index in members if index >= len(hrules)]
        if len(hs) < 2 or len(vs) < 2:
            continue
        xs = _merge_close([v.x for v in vs], 2.0)
        if min(h.x0 for h in hs) < xs[0] - 3:
            xs.insert(0, min(h.x0 for h in hs))
        if max(h.x1 for h in hs) > xs[-1] + 3:
            xs.append(max(h.x1 for h in hs))
        ys = sorted(_merge_close([h.y for h in hs], 1.5), reverse=True)
        if max(v.y1 for v in vs) > ys[0] + 3:
            ys.insert(0, max(v.y1 for v in vs))
        if min(v.y0 for v in vs) < ys[-1] - 3:
            ys.append(min(v.y0 for v in vs))
        if len(xs) < 2 or len(ys) < 2 or xs[-1] - xs[0] < 24 or ys[0] - ys[-1] < 8:
            continue

        def has_h(y_index: int, x_mid: float) -> Rule | None:
            return next((h for h in hs if abs(h.y - ys[y_index]) <= 1.5 and h.x0 - 1 <= x_mid <= h.x1 + 1), None)

        def has_v(x_index: int, y_mid: float) -> VRule | None:
            return next((v for v in vs if abs(v.x - xs[x_index]) <= 2 and v.y0 - 1 <= y_mid <= v.y1 + 1), None)

        rows, columns = len(ys) - 1, len(xs) - 1
        owner: list[list[_Cell | None]] = [[None] * columns for _ in range(rows)]
        cells: list[_Cell] = []
        for row in range(rows):
            for column in range(columns):
                if owner[row][column] is not None:
                    continue
                y_mid = (ys[row] + ys[row + 1]) / 2
                span = 1
                while column + span < columns and owner[row][column + span] is None and has_v(column + span, y_mid) is None:
                    span += 1
                rowspan = 1
                while row + rowspan < rows and all(
                    owner[row + rowspan][k] is None and has_h(row + rowspan, (xs[k] + xs[k + 1]) / 2) is None
                    for k in range(column, column + span)
                ):
                    rowspan += 1
                cell = _Cell(row, column, rowspan, span, xs[column], xs[column + span], ys[row], ys[row + rowspan])
                for r in range(row, row + rowspan):
                    for k in range(column, column + span):
                        owner[r][k] = cell
                cells.append(cell)
        tables.append(_Table(xs, ys, cells, hs, vs))
    return tables


def _find_boxes(page: PageContent, lines: list[Line], tables: list[_Table]) -> list[_Table]:
    """Shaded boxes around text (callouts, banners): one-cell tables whose
    background is the shape's fill."""

    boxes: list[_Table] = []
    for fill in sorted(page.fills, key=lambda item: -(item.x1 - item.x0) * (item.top - item.bottom)):
        if fill.x1 - fill.x0 < 72 or fill.top - fill.bottom < 14:
            continue
        if any(
            fill.x0 < table.right and fill.x1 > table.left and fill.bottom < table.top and fill.top > table.bottom
            for table in [*tables, *boxes]
        ):
            continue
        inside = [
            line
            for line in lines
            if fill.x0 - 1 <= line.x0 and line.x1 <= fill.x1 + 1 and fill.bottom - 1 <= line.bottom and line.top <= fill.top + 1
        ]
        if not inside or fill.top - fill.bottom < max(line.size for line in inside) * 1.6:
            continue
        cell = _Cell(0, 0, 1, 1, fill.x0, fill.x1, fill.top, fill.bottom)
        # The box's own outline (often drawn as a separate stroked shape).
        edges = [
            rule
            for rule in page.rules
            if min(abs(rule.y - fill.top), abs(rule.y - fill.bottom)) <= 2.5
            and rule.x0 >= fill.x0 - 4
            and rule.x1 <= fill.x1 + 4
        ]
        sides = [
            rule
            for rule in page.vrules
            if min(abs(rule.x - fill.x0), abs(rule.x - fill.x1)) <= 2.5
            and rule.y0 >= fill.bottom - 4
            and rule.y1 <= fill.top + 4
        ]
        boxes.append(_Table([fill.x0, fill.x1], [fill.top, fill.bottom], [cell], edges, sides))
    return boxes


def _find_open_tables(page: PageContent, lines: list[Line], taken: list[_Table]) -> list[_Table]:
    """Tables drawn with horizontal rules only: rules of one width stacked
    down the page, with text in columns between them. Columns come from where
    the rows' text segments start."""

    used = {id(rule) for table in taken for rule in table.hrules}
    candidates = [rule for rule in page.rules if id(rule) not in used and rule.x1 - rule.x0 >= 120]
    groups: list[list[Rule]] = []
    for rule in sorted(candidates, key=lambda item: -item.y):
        group = next(
            (
                existing
                for existing in groups
                if abs(existing[0].x0 - rule.x0) <= 2.5
                and abs(existing[0].x1 - rule.x1) <= 2.5
                and existing[-1].y - rule.y <= 160
            ),
            None,
        )
        if group is None:
            groups.append([rule])
        else:
            group.append(rule)
    tables: list[_Table] = []
    for group in groups:
        if len(group) < 2:
            continue
        x0, x1 = group[0].x0, group[0].x1
        ys = sorted(_merge_close([rule.y for rule in group], 1.5), reverse=True)
        # A shaded header row sitting directly on the first rule belongs to it.
        header = next(
            (
                fill
                for fill in page.fills
                if abs(fill.bottom - ys[0]) <= 2.5 and fill.x0 >= x0 - 3 and fill.x1 <= x1 + 3 and fill.top - fill.bottom >= 8
            ),
            None,
        )
        if header is not None:
            ys.insert(0, max(fill.top for fill in page.fills if abs(fill.bottom - ys[0]) <= 2.5 and fill.x0 >= x0 - 3 and fill.x1 <= x1 + 3))
        rows: list[list[Line]] = [[] for _ in range(len(ys) - 1)]
        for line in lines:
            if line.x0 < x0 - 2 or line.x1 > x1 + 2:
                continue
            for index in range(len(ys) - 1):
                if ys[index + 1] < line.baseline < ys[index]:
                    rows[index].append(line)
                    break
        filled = [row for row in rows if row]
        if len(filled) < 2:
            continue
        starts: list[float] = []
        for row in filled:
            for line in row:
                for segment in line.segments:
                    solid = [glyph for glyph in segment if not glyph.is_space]
                    if solid:
                        starts.append(solid[0].x0)
        clusters = _merge_close(starts, 3.0)
        counts = [sum(1 for row in filled if any(abs(line_start - center) <= 3.5 for line in row for line_start in _segment_starts(line))) for center in clusters]
        columns = [center for center, count in zip(clusters, counts, strict=False) if count >= max(2, len(filled) * 0.5)]
        if len(columns) < 2:
            continue
        inset = max(0.0, min(columns[0] - x0, 12.0))
        xs = [x0, *[column - inset for column in columns[1:]], x1]
        if any(b - a < 12 for a, b in zip(xs, xs[1:], strict=False)):
            continue
        cells = [
            _Cell(row, column, 1, 1, xs[column], xs[column + 1], ys[row], ys[row + 1])
            for row in range(len(ys) - 1)
            for column in range(len(xs) - 1)
        ]
        tables.append(_Table(xs, ys, cells, [rule for rule in group], []))
    return tables


def _segment_starts(line: Line) -> list[float]:
    starts: list[float] = []
    for segment in line.segments:
        solid = [glyph for glyph in segment if not glyph.is_space]
        if solid:
            starts.append(solid[0].x0)
    return starts


def _claim_table_lines(table: _Table, lines: list[Line]) -> list[Line]:
    """Moves each line's glyphs inside the table into its cells; returns the
    lines (or parts of lines) that stay outside."""

    outside: list[Line] = []
    for line in lines:
        if not (table.bottom - 1 <= line.baseline <= table.top + 1 and line.x1 >= table.left - 1 and line.x0 <= table.right + 1):
            outside.append(line)
            continue
        by_cell: defaultdict[int, list[Glyph]] = defaultdict(list)
        stray: list[Glyph] = []
        for glyph in line.glyphs:
            x = (glyph.x0 + glyph.x1) / 2
            target = next(
                (index for index, cell in enumerate(table.cells) if cell.x0 <= x <= cell.x1 and cell.bottom <= line.baseline <= cell.top),
                None,
            )
            if target is None:
                stray.append(glyph)
            else:
                by_cell[target].append(glyph)
        for index, glyphs in by_cell.items():
            part = _line_from(glyphs, line)
            if part is not None:
                table.cells[index].lines.append(part)
        leftover = _line_from(stray, line)
        if leftover is not None:
            outside.append(leftover)
    for cell in table.cells:
        cell.lines.sort(key=lambda item: (-item.baseline, item.x0))
    return outside


def _line_from(glyphs: list[Glyph], source: Line) -> Line | None:
    solid = [glyph for glyph in glyphs if not glyph.is_space]
    if not solid:
        return None
    keep = {id(glyph) for glyph in glyphs}
    segments = [[glyph for glyph in segment if id(glyph) in keep] for segment in source.segments]
    segments = [segment for segment in segments if any(not glyph.is_space for glyph in segment)]
    return Line(
        page=source.page,
        glyphs=glyphs,
        segments=segments,
        x0=solid[0].x0,
        x1=max(glyph.x1 for glyph in solid),
        top=max(glyph.top for glyph in solid),
        bottom=min(glyph.bottom for glyph in solid),
        baseline=source.baseline,
        style=_dominant_style(glyphs),
        text=_plain_text(glyphs),
    )


def _border_css(rule: Rule | VRule | None) -> str | None:
    if rule is None:
        return None
    return f"{_num(max(0.75, px_from_pt(rule.thickness)))}px solid {rule.color}"


def _table_box(
    table: _Table,
    page: PageContent,
    setup_style: TextStyle,
    pitches: dict[float, float],
    content_left: float,
) -> _Box:
    xs, ys = table.xs, table.ys
    fills = sorted(page.fills, key=lambda fill: (fill.x1 - fill.x0) * (fill.top - fill.bottom))

    def h_rule(y_index: int, x_mid: float) -> Rule | None:
        return next((h for h in table.hrules if abs(h.y - ys[y_index]) <= 1.5 and h.x0 - 1 <= x_mid <= h.x1 + 1), None)

    def v_rule(x_index: int, y_mid: float) -> VRule | None:
        return next((v for v in table.vrules if abs(v.x - xs[x_index]) <= 2 and v.y0 - 1 <= y_mid <= v.y1 + 1), None)

    rows: defaultdict[int, list[_Cell]] = defaultdict(list)
    for cell in table.cells:
        rows[cell.row].append(cell)
    # One cell margin for the table (Word's default is 0.075in): the closest
    # any text comes to its cell's left edge.
    insets = [min(line.x0 for line in cell.lines) - cell.x0 for cell in table.cells if cell.lines]
    pad = min(18.0, max(0.0, min(insets))) if insets else 5.4
    row_html: list[str] = []
    for row in range(len(ys) - 1):
        cells_html: list[str] = []
        for cell in sorted(rows.get(row, []), key=lambda item: item.column):
            x_mid = (cell.x0 + cell.x1) / 2
            y_mid = (cell.top + cell.bottom) / 2
            styles: list[str] = []
            for side, rule in (
                ("top", h_rule(cell.row, x_mid)),
                ("right", v_rule(cell.column + cell.colspan, y_mid)),
                ("bottom", h_rule(cell.row + cell.rowspan, x_mid)),
                ("left", v_rule(cell.column, y_mid)),
            ):
                css = _border_css(rule)
                if css:
                    styles.append(f"border-{side}: {css}")
            background = next(
                (fill.color for fill in fills if fill.x0 - 1 <= x_mid <= fill.x1 + 1 and fill.bottom - 1 <= y_mid <= fill.top + 1),
                None,
            )
            if background:
                styles.append(f"background-color: {background}")
            styles.append(f"padding: 0px {_px(pad)} 0px {_px(pad)}")
            styles.append("vertical-align: top")
            inner_left, inner_right = cell.x0 + pad, cell.x1 - pad
            parts: list[str] = []
            previous: _Box | None = None
            for paragraph in _paragraphs(cell.lines, inner_left, inner_right, pitches):
                box = _paragraph_box(paragraph, setup_style, {}, {}, None, background)
                margin = (cell.top - box.top) if previous is None else previous.bottom - box.top
                parts.append(_box_html(box, margin))
                previous = box
            spans = (f' colspan="{cell.colspan}"' if cell.colspan > 1 else "") + (
                f' rowspan="{cell.rowspan}"' if cell.rowspan > 1 else ""
            )
            body = "".join(parts) or '<p style="margin-top: 0px; margin-bottom: 0px"><br></p>'
            cells_html.append(f'<td{spans} style="{html.escape("; ".join(styles), quote=True)}">{body}</td>')
        height = ys[row] - ys[row + 1]
        row_html.append(f'<tr style="height: {_px(height)}">{"".join(cells_html)}</tr>')
    colgroup = "".join(f'<col style="width: {_px(xs[index + 1] - xs[index])}">' for index in range(len(xs) - 1))
    styles = [
        f"width: {_px(xs[-1] - xs[0])}",
        "border-collapse: collapse",
        "table-layout: fixed",
    ]
    if abs(xs[0] - content_left) >= 0.5:
        styles.insert(0, f"margin-left: {_px(xs[0] - content_left)}")
    return _Box(
        top=ys[0],
        bottom=ys[-1],
        tag="table",
        body=f"<colgroup>{colgroup}</colgroup><tbody>{''.join(row_html)}</tbody>",
        styles=styles,
    )


# ------------------------------------------------------------------ rendering


@dataclass(slots=True)
class _Box:
    """A rendered flow item: its vertical extent in page space (y up) and the
    HTML it becomes once its margin-top is known."""

    top: float
    bottom: float
    tag: str
    body: str
    styles: list[str]


def _line_box_offset(style: TextStyle, line_height_pt: float) -> float:
    """Distance from a CSS line box's top to its baseline."""

    size = style.size_pt
    content = (style.ascent + style.descent) * size
    return (line_height_pt - content) / 2 + style.ascent * size


def _segment_pieces(glyphs: list[Glyph]) -> list[tuple[str, Glyph]]:
    """Segment text as (text, formatting glyph) pieces, with the word spaces
    PDFs often leave implicit put back."""

    pieces: list[tuple[str, Glyph]] = []
    previous: Glyph | None = None
    pending_space = False
    threshold = _word_gap(glyphs)
    for glyph in glyphs:
        if glyph.is_space:
            pending_space = previous is not None
            continue
        if previous is not None and (pending_space or glyph.x0 - previous.x1 > threshold):
            pieces.append((" ", previous))
        pieces.append((glyph.text, glyph))
        previous = glyph
        pending_space = False
    return pieces


@dataclass(slots=True)
class _PageFields:
    """Page-number digits in a running header/footer become live fields: a
    number after "of" or "/" that equals the page count is the total, one
    equal to the page number is the page."""

    page: int
    total: int
    # True when this running text's digits change from page to page; when
    # false only an explicit page-number pattern ("Page 3", "3 of 9", "- 3 -")
    # counts, so a constant "Schedule 2" header is never turned into a field.
    varies: bool = True

    def mark(self, escaped: str, preceding: str) -> str:
        def replace(match: re.Match[str]) -> str:
            value = int(match.group(0))
            before = (preceding + escaped[: match.start()])[-12:]
            after = escaped[match.end() : match.end() + 8]
            total_context = re.search(r"(?:\bof|/)\s*$", before, re.I)
            alone = re.fullmatch(r"\s*[-\u2013\u2014]?\s*", before) and re.fullmatch(
                r"\s*[-\u2013\u2014]?\s*", after
            )
            page_context = (
                re.search(r"(?:\bpage|\bp\.)\s*$", before, re.I)
                or re.match(r"\s*(?:of\b|/)", after, re.I)
                or alone
            )
            if value == self.total and total_context:
                name = DOCUMENT_FIELD_PAGES_CLASS
            elif value == self.page and (self.varies or page_context):
                name = DOCUMENT_FIELD_PAGE_CLASS
            elif value == self.total and self.varies:
                name = DOCUMENT_FIELD_PAGES_CLASS
            else:
                return match.group(0)
            return f'<span class="{name}">{match.group(0)}</span>'

        return _DIGITS.sub(replace, escaped)


def _run_key(glyph: Glyph) -> tuple[Any, ...]:
    return (glyph.style, glyph.href, glyph.underline, glyph.raised, glyph.background)


def _runs_html(
    glyphs: list[Glyph],
    base: TextStyle,
    fields: _PageFields | None,
    cell_background: str | None = None,
) -> str:
    pieces = _segment_pieces(glyphs)
    out: list[str] = []
    consumed = ""
    index = 0
    while index < len(pieces):
        key = _run_key(pieces[index][1])
        end = index
        while end < len(pieces) and _run_key(pieces[end][1]) == key:
            end += 1
        text = "".join(piece[0] for piece in pieces[index:end])
        glyph = pieces[index][1]
        escaped = html.escape(text, quote=False)
        if fields is not None:
            escaped = fields.mark(escaped, consumed)
        consumed += text
        style = glyph.style
        if glyph.raised:
            escaped = f"<sup>{escaped}</sup>"
        if glyph.underline and text.strip():
            escaped = f"<u>{escaped}</u>"
        if style.italic:
            escaped = f"<em>{escaped}</em>"
        if style.bold:
            escaped = f"<strong>{escaped}</strong>"
        declarations: list[str] = []
        if style.stack != base.stack:
            declarations.append(f"font-family: {style.stack}")
        if style.weight:
            declarations.append(f"font-weight: {style.weight}")
        if abs(style.size_pt - base.size_pt) >= 0.25 and not glyph.raised:
            declarations.append(f"font-size: {_px(style.size_pt)}")
        if style.color != base.color:
            declarations.append(f"color: {style.color}")
        if glyph.background and glyph.background != cell_background and text.strip():
            declarations.append(f"background-color: {glyph.background}")
        if declarations:
            escaped = f'<span style="{html.escape("; ".join(declarations), quote=True)}">{escaped}</span>'
        if glyph.href:
            escaped = f'<a href="{html.escape(glyph.href, quote=True)}">{escaped}</a>'
        out.append(escaped)
        index = end
    return "".join(out)


def _tab_html(width_pt: float, stop_pt: float, kind: str = "left") -> str:
    """A spacer to where the next text starts; the classes record that
    position as a tab stop, which the editor re-measures with the fonts it
    actually has and the Word export writes back as a real tab."""

    twips = max(0, round(stop_pt * 20))
    return (
        f'<span class="{DOCUMENT_TAB_CLASS} {DOCUMENT_TAB_CLASS}-{kind} {DOCUMENT_TAB_CLASS}-at-{twips}" '
        f'style="display: inline-block; width: {_px(max(0.0, width_pt))}">\t</span>'
    )


_LEADER_CHARS = {".", "\u2026", "\u00b7"}


def _split_leader(segment: list[Glyph]) -> tuple[list[Glyph], list[Glyph]] | None:
    """A segment ending "text ........ 12": the text and the trailing label,
    with the dots between them."""

    solid = [glyph for glyph in segment if not glyph.is_space]
    end = len(solid)
    label_start = end
    while label_start > 0 and solid[label_start - 1].text not in _LEADER_CHARS:
        label_start -= 1
    if label_start == 0 or end - label_start > 8 or end == label_start:
        return None
    dots_start = label_start
    while dots_start > 0 and solid[dots_start - 1].text in _LEADER_CHARS:
        dots_start -= 1
    dots = label_start - dots_start
    if dots < 5 and not (dots >= 2 and solid[dots_start].text == "\u2026"):
        return None
    before_ids = {id(glyph) for glyph in solid[:dots_start]}
    label_ids = {id(glyph) for glyph in solid[label_start:]}
    before = [glyph for glyph in segment if id(glyph) in before_ids or (glyph.is_space and before_ids and glyph.x0 < solid[dots_start].x0)]
    label = [glyph for glyph in segment if id(glyph) in label_ids]
    return before, label


def _leader_html(width_pt: float, stop_pt: float) -> str:
    twips = max(0, round(stop_pt * 20))
    return (
        f'<span class="{DOCUMENT_TAB_CLASS} {DOCUMENT_TAB_CLASS}-right {DOCUMENT_TAB_CLASS}-at-{twips}" '
        f'style="display: inline-block; width: {_px(max(0.0, width_pt))}; border-bottom: 1.5px dotted currentcolor">\t</span>'
    )


def _segments_html(
    segments: list[list[Glyph]],
    base: TextStyle,
    column_left: float,
    fields: _PageFields | None,
    cell_background: str | None = None,
    column_right: float | None = None,
) -> str:
    parts: list[str] = []
    previous_end: float | None = None
    last_index = max((index for index, segment in enumerate(segments) if any(not glyph.is_space for glyph in segment)), default=-1)
    for index, segment in enumerate(segments):
        solid = [glyph for glyph in segment if not glyph.is_space]
        if not solid:
            continue
        if previous_end is not None:
            end = max(glyph.x1 for glyph in solid)
            # Text closing a line flush with the right edge is right-aligned
            # (page numbers, dates): its tab stop is where it ends.
            if index == last_index and column_right is not None and abs(end - column_right) <= 3:
                parts.append(_tab_html(solid[0].x0 - previous_end, end - column_left, "right"))
            else:
                parts.append(_tab_html(solid[0].x0 - previous_end, solid[0].x0 - column_left))
        leader = _split_leader(segment)
        if leader is not None:
            before, label = leader
            before_solid = [glyph for glyph in before if not glyph.is_space]
            leader_start = solid[0].x0 if not before_solid else max(glyph.x1 for glyph in before_solid)
            before_end = previous_end if not before_solid and previous_end is not None else leader_start
            label_solid = [glyph for glyph in label if not glyph.is_space]
            if before:
                parts.append(_runs_html(before, base, fields, cell_background))
            # A dotted spacer to a right-aligned label: Word's TOC leader tab.
            parts.append(_leader_html(label_solid[0].x0 - before_end, label_solid[-1].x1 - column_left))
            parts.append(_runs_html(label, base, fields, cell_background))
        else:
            parts.append(_runs_html(segment, base, fields, cell_background))
        previous_end = max(glyph.x1 for glyph in solid)
    return "".join(parts)


def _alignment(paragraph: Paragraph) -> str:
    left, right = paragraph.column_left, paragraph.column_right
    width = right - left
    center = (left + right) / 2
    lines = paragraph.lines
    if paragraph.list_marker is not None:
        return "left"
    # Centered text is centered to well under a point; a long line that only
    # happens to sit near the middle is not.
    tolerance = max(1.5, lines[0].size * 0.15)
    if all(
        abs((line.x0 + line.x1) / 2 - center) <= tolerance and line.x0 > left + max(6, line.size)
        for line in lines
    ):
        return "center"
    if all(abs(line.x1 - right) <= 3 for line in lines) and lines[0].x0 > left + width * 0.3:
        return "right"
    if len(lines) >= 2:
        # Justified lines end exactly at the edge; ragged lines stop short by
        # varying amounts. Two lines need the edge to be the column's.
        edge = max(line.x1 for line in lines)
        body = lines[:-1]
        reaches = all(abs(line.x1 - edge) <= 1.2 for line in body)
        if reaches and (len(body) >= 2 or abs(edge - right) <= 1.5) and lines[-1].x1 < edge - 3:
            return "justify"
        if reaches and len(body) >= 2 and abs(lines[-1].x1 - edge) <= 1.2:
            return "justify"
    return "left"


def _paragraph_pitch(paragraph: Paragraph, style: TextStyle, pitches: dict[float, float]) -> float:
    same_page = [
        upper.baseline - lower.baseline
        for upper, lower in zip(paragraph.lines, paragraph.lines[1:], strict=False)
        if upper.page == lower.page and upper.baseline > lower.baseline
    ]
    if same_page:
        pitch = median(same_page)
    elif pitches:
        pitch = _expected_pitch(style.size_pt, style, pitches)
    else:
        # Table cells and running text: the font's own single spacing.
        pitch = style.size_pt * style.line_factor
    return max(style.size_pt * 0.8, pitch)


def _paragraph_box(
    paragraph: Paragraph,
    setup_style: TextStyle,
    pitches: dict[float, float],
    heading_levels: dict[float, int],
    fields: _PageFields | None = None,
    cell_background: str | None = None,
) -> _Box:
    lines = paragraph.lines
    style = _dominant_style([glyph for line in lines for glyph in line.glyphs])
    alignment = _alignment(paragraph)
    left, right = paragraph.column_left, paragraph.column_right
    line_pitch = _paragraph_pitch(paragraph, style, pitches)
    marker = paragraph.list_marker
    styles: list[str] = []
    if alignment in {"left", "justify"}:
        if marker is not None:
            body_x = marker[1]
            styles.append(f"margin-left: {_px(max(0.0, body_x - left))}")
            styles.append(f"text-indent: {_px(lines[0].x0 - body_x)}")
        else:
            continuation = lines[1].x0 if len(lines) > 1 else lines[0].x0
            # Text that hangs left of the column keeps its place (negative).
            if abs(continuation - left) >= 1:
                styles.append(f"margin-left: {_px(continuation - left)}")
            if abs(lines[0].x0 - continuation) >= 1:
                styles.append(f"text-indent: {_px(lines[0].x0 - continuation)}")
        edge = max(line.x1 for line in lines)
        if edge > right + 0.5:
            # Wider than the column (a right-aligned page number in the
            # margin): widen the block instead of wrapping its last word.
            styles.append(f"margin-right: {_px(right - edge - 1)}")
        elif len(lines) > 1 and right - edge > max(2 * style.size_pt, 18):
            styles.append(f"margin-right: {_px(max(0.0, right - edge - 2))}")
    if alignment != "left":
        styles.append(f"text-align: {alignment}")
    styles.append(f"line-height: {_px(line_pitch)}")
    if style.stack != setup_style.stack:
        styles.append(f"font-family: {style.stack}")
    level = heading_levels.get(style.size_pt) if len(lines) <= 3 else None
    if level or abs(style.size_pt - setup_style.size_pt) >= 0.25:
        styles.append(f"font-size: {_px(style.size_pt)}")
    if style.color != setup_style.color:
        styles.append(f"color: {style.color}")
    if level:
        styles.append("font-weight: normal")
    base = TextStyle(style.family, style.stack, style.size_pt, style.color, False, False, style.ascent, style.descent, 0)

    parts: list[str] = []
    for index, line in enumerate(lines):
        segments = line.segments
        if index:
            previous_line = lines[index - 1]
            last = next((glyph for glyph in reversed(previous_line.glyphs) if not glyph.is_space), None)
            if last is not None and last.text == "-" and last.soft_hyphen and parts:
                parts[-1] = re.sub(r"-(</[^>]+>)*$", r"\1", parts[-1])
            elif not previous_line.text.endswith("-"):
                parts.append(" ")
        if index == 0 and marker is not None:
            marker_glyphs, body_x = marker
            marker_ids = {id(glyph) for glyph in marker_glyphs}
            marker_html = f'<span class="{DOCUMENT_LIST_MARKER_CLASS}">{html.escape(_plain_text(marker_glyphs), quote=False)}</span>'
            if _dominant_style(marker_glyphs).bold:
                marker_html = f"<strong>{marker_html}</strong>"
            marker_end = max(glyph.x1 for glyph in marker_glyphs if not glyph.is_space)
            parts.append(marker_html)
            parts.append(_tab_html(body_x - marker_end, body_x - left))
            segments = [
                [glyph for glyph in segment if id(glyph) not in marker_ids and glyph.x0 >= body_x - 0.5]
                for segment in segments
            ]
            segments = [segment for segment in segments if any(not glyph.is_space for glyph in segment)]
        parts.append(_segments_html(segments, base, left, fields, cell_background, right))
    offset = _line_box_offset(style, line_pitch)
    return _Box(
        top=lines[0].baseline + offset,
        bottom=lines[-1].baseline - (line_pitch - offset),
        tag=f"h{level}" if level else "p",
        body="".join(parts).strip() or "<br>",
        styles=styles,
    )


def _picture_box(picture: Picture, left: float, right: float, max_height: float | None = None) -> _Box:
    width = picture.x1 - picture.x0
    height = picture.top - picture.bottom
    styles = ["line-height: normal"]
    center = (left + right) / 2
    # A picture larger than the text area (a full-page scan or design page)
    # is scaled to fit it, centered, keeping its proportions.
    fit = min(1.0, (right - left) / width if width else 1.0, (max_height / height) if max_height and height else 1.0)
    if fit < 0.999:
        width, height = width * fit, height * fit
        styles.append("text-align: center")
    elif abs((picture.x0 + picture.x1) / 2 - center) <= 4 and picture.x0 > left + 4:
        styles.append("text-align: center")
    elif picture.x0 - left >= 1:
        styles.append(f"margin-left: {_px(picture.x0 - left)}")
    # vertical-align: top keeps the line box exactly the picture's height.
    body = (
        f'<img src="{html.escape(picture.data_url, quote=True)}" alt="" '
        f'style="width: {_px(width)}; height: {_px(height)}; vertical-align: top">'
    )
    return _Box(top=picture.top, bottom=picture.top - height, tag="p", body=body, styles=styles)


def _rule_box(rule: Rule, left: float) -> _Box:
    styles = [
        "line-height: 0",
        "font-size: 1px",
        f"width: {_px(rule.x1 - rule.x0)}",
        f"border-bottom: {_num(max(0.75, px_from_pt(rule.thickness)))}px solid {rule.color}",
    ]
    if rule.x0 - left >= 1:
        styles.insert(0, f"margin-left: {_px(rule.x0 - left)}")
    half = rule.thickness / 2
    return _Box(top=rule.y + half, bottom=rule.y - half, tag="p", body="<br>", styles=styles)


def _box_html(box: _Box, margin_top: float) -> str:
    styles = [f"margin-top: {_px(max(0.0, margin_top))}", "margin-bottom: 0px", *box.styles]
    return f'<{box.tag} style="{html.escape("; ".join(styles), quote=True)}">{box.body}</{box.tag}>'


# ------------------------------------------------------------------ document


def import_pdf_document(filename: str, content: bytes) -> DocumentImportResponse:
    """Convert one PDF payload into the Drafts editable HTML contract."""

    if not _IMPORT_SLOTS.acquire(blocking=False):
        raise PdfImportBusyError(
            "Other PDFs are being converted right now. Try again in a moment."
        )
    try:
        return _import(filename, content)
    finally:
        _IMPORT_SLOTS.release()


@dataclass(slots=True)
class _Budget:
    """Limits shared by every page of one conversion."""

    deadline: float
    picture_bytes: int = 0
    over_pictures: bool = False
    ocr_pages: int = 0
    ocr_enabled: bool = True
    ocr_max_pages: int = 250
    ocr_timeout: float = 45.0

    def take_picture(self, data_url: str, page: int, warnings: list[str]) -> bool:
        if self.picture_bytes + len(data_url) > HTML_IMAGE_BUDGET_BYTES:
            if not self.over_pictures:
                warnings.append(
                    f"Some pictures from page {page} on were left out to keep the draft within its size limit."
                )
            self.over_pictures = True
            return False
        self.picture_bytes += len(data_url)
        return True


def _import(filename: str, content: bytes) -> DocumentImportResponse:
    settings = get_settings()
    budget = _Budget(
        deadline=time.monotonic() + IMPORT_TIME_BUDGET_SECONDS,
        ocr_enabled=settings.knowledge_ocr_enabled,
        ocr_max_pages=settings.knowledge_ocr_max_pages,
        ocr_timeout=settings.knowledge_ocr_page_timeout_seconds,
    )
    try:
        with PDFIUM_LOCK:
            pdf = pdfium.PdfDocument(content)
            total = len(pdf)
    except Exception as exc:
        message = str(exc).lower()
        if "password" in message or "decrypt" in message or "security" in message:
            raise PdfReadError(
                "This PDF is password-protected. Remove the password and try again."
            ) from exc
        raise PdfReadError("The PDF could not be read.") from exc

    warnings: list[str] = []
    pages: list[PageContent] = []
    try:
        if total > MAX_PAGES:
            warnings.append(f"Only the first {MAX_PAGES} pages were imported.")
        for index in range(min(total, MAX_PAGES)):
            if time.monotonic() > budget.deadline:
                warnings.append(
                    f"Only the first {index} pages were imported; the rest would take too long to convert."
                )
                break
            page = None
            # One page at a time under the PDFium lock, so other PDF work in
            # the process (knowledge OCR, another import) interleaves.
            with PDFIUM_LOCK:
                try:
                    page = pdf[index]
                    pages.append(_extract_page(pdf, page, index + 1, warnings, budget))
                except Exception:
                    warnings.append(f"Page {index + 1} could not be read and was left out.")
                finally:
                    if page is not None:
                        page.close()
    finally:
        with PDFIUM_LOCK:
            pdf.close()
    if not pages:
        raise PdfReadError("The PDF could not be read.")
    if any(abs(page.width - pages[0].width) > 1 or abs(page.height - pages[0].height) > 1 for page in pages[1:]):
        warnings.append("Pages use different sizes; the editor uses the first page's size.")

    _detect_running_content(pages)
    plans = _settle_running(pages)
    body_lines = [line for page in pages for line in page.lines if not line.is_header and not line.is_footer]
    setup_style = _body_style(body_lines)
    pitches = _pitch_table(pages)
    setup = _page_setup(pages, body_lines, setup_style, pitches)
    heading_levels = _heading_levels(body_lines, setup_style)
    body_html, paragraph_gap = _body_html(pages, setup, pitches, heading_levels, warnings)
    setup.paragraph_after_pt = paragraph_gap
    _running_html(pages, setup, pitches, plans)
    return DocumentImportResponse(
        filename=filename,
        html=f"{_marker_html(setup)}{body_html or '<p><br></p>'}",
        page_count=len(pages),
        warnings=list(dict.fromkeys(warnings)),
    )


def _body_style(lines: list[Line]) -> TextStyle:
    glyphs = [glyph for line in lines for glyph in line.glyphs if not glyph.is_space]
    if glyphs:
        style = _dominant_style(glyphs)
        return TextStyle(style.family, style.stack, style.size_pt, style.color, False, False, style.ascent, style.descent)
    family = "Times New Roman"
    return TextStyle(family, css_font_family_stack(family, serif=True), DEFAULT_FONT_SIZE_PT, DEFAULT_COLOR, False, False)


def _percentile(values: list[float], fraction: float, default: float) -> float:
    if not values:
        return default
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))]


def _page_setup(
    pages: list[PageContent],
    body_lines: list[Line],
    style: TextStyle,
    pitches: dict[float, float],
) -> PageSetup:
    first = pages[0]
    width, height = first.width, first.height
    pictures = [picture for page in pages for picture in page.pictures if picture.running is None]
    lefts = [line.x0 for line in body_lines] + [picture.x0 for picture in pictures]
    rights = [line.x1 for line in body_lines] + [picture.x1 for picture in pictures]
    tops = [line.top for line in body_lines] + [picture.top for picture in pictures]
    bottoms = [line.bottom for line in body_lines] + [picture.bottom for picture in pictures]

    def clamp(value: float) -> float:
        return min(MAX_MARGIN_PT, max(MIN_MARGIN_PT, value))

    margin_left = clamp(_percentile(lefts, 0.02, DEFAULT_MARGIN_PT))
    margin_right = clamp(width - _percentile(rights, 0.98, width - DEFAULT_MARGIN_PT))
    # The page whose text starts highest and the one that runs lowest set
    # the top and bottom margins; short pages (a signature page) do not.
    margin_top = clamp(height - max(tops)) if tops else DEFAULT_MARGIN_PT
    margin_bottom = clamp(min(bottoms)) if bottoms else DEFAULT_MARGIN_PT
    margin_bottom = min(margin_bottom, max(margin_top, DEFAULT_MARGIN_PT))
    # Ragged-right text ends short of the margin; when the right side
    # measures only a little wider, the symmetric layout is the truth.
    if margin_left < margin_right < margin_left + 36:
        margin_right = margin_left
    pitch = pitches.get(style.size_pt) or style.size_pt * style.line_factor
    line_height = round(pitch / style.size_pt, 3)
    return PageSetup(
        width_pt=width,
        height_pt=height,
        margin_top_pt=margin_top,
        margin_right_pt=margin_right,
        margin_bottom_pt=margin_bottom,
        margin_left_pt=margin_left,
        header_distance_pt=min(36.0, margin_top),
        footer_distance_pt=min(36.0, margin_bottom),
        style=style,
        line_height=line_height if 0.8 <= line_height <= 4 else style.line_factor,
    )


def _heading_levels(lines: list[Line], body: TextStyle) -> dict[float, int]:
    sizes = sorted(
        {line.size for line in lines if line.size >= body.size_pt * 1.25 and len(line.text) <= 160},
        reverse=True,
    )
    return {size: min(3, index + 1) for index, size in enumerate(sizes)}


@dataclass(slots=True)
class _Flow:
    page: int
    column: int
    top: float
    paragraph: Paragraph | None = None
    box: _Box | None = None
    first_on_page: bool = False
    last_on_page: bool = False
    break_after: bool = False

    def bottom(self) -> float:
        if self.box is not None:
            return self.box.bottom
        assert self.paragraph is not None
        return self.paragraph.last.bottom


def _continues_across_pages(previous: Paragraph, following: Paragraph) -> bool:
    last = previous.last
    first = following.first
    if previous.list_marker is not None and len(previous.lines) == 1:
        expected_left = previous.list_marker[1]
    elif len(previous.lines) > 1:
        expected_left = previous.lines[1].x0
    else:
        expected_left = last.x0
    width = previous.column_right - previous.column_left
    return (
        abs(last.size - first.size) <= 0.5
        and _is_full(last, previous.column_right, width)
        and not _SENTENCE_END.search(last.text)
        and following.list_marker is None
        and abs(first.x0 - expected_left) <= 2.5
    )


def _body_html(
    pages: list[PageContent],
    setup: PageSetup,
    pitches: dict[float, float],
    heading_levels: dict[float, int],
    warnings: list[str],
) -> tuple[str, float]:
    content_left = setup.margin_left_pt
    content_right = setup.width_pt - setup.margin_right_pt
    body_pitch = pitches.get(setup.style.size_pt) or setup.style.size_pt * setup.style.line_factor

    # 1. Flow items per page, in reading order.
    flows: list[_Flow] = []
    for page in pages:
        body = [line for line in page.lines if not line.is_header and not line.is_footer]
        items: list[_Flow] = []
        tables = _find_tables(page)
        tables += _find_open_tables(page, body, tables)
        tables += _find_boxes(page, body, tables)
        for table in tables:
            body = _claim_table_lines(table, body)
            items.append(_Flow(page.number, 0, table.top, box=_table_box(table, page, setup.style, pitches, content_left)))
        table_rules = {id(rule) for table in tables for rule in table.hrules}
        table_rules |= {
            id(rule)
            for table in tables
            for rule in page.rules
            if table.left - 3 <= rule.x0 and rule.x1 <= table.right + 3 and table.bottom - 2 <= rule.y <= table.top + 2
        }
        columns = _columns(body, content_left, content_right)
        for column_index, (left, right, lines) in enumerate(columns):
            for paragraph in _paragraphs(lines, left, right, pitches):
                items.append(_Flow(page.number, column_index, paragraph.first.top, paragraph=paragraph))
        for picture in page.pictures:
            if picture.running is not None:
                continue
            column_index = 0
            for index, (left, right, _lines) in enumerate(columns):
                if left - 2 <= (picture.x0 + picture.x1) / 2 <= right + 2:
                    column_index = index
            content_height = page.height - setup.margin_top_pt - setup.margin_bottom_pt
            box = _picture_box(picture, content_left, content_right, content_height)
            if picture.top - picture.bottom > content_height or picture.x1 - picture.x0 > content_right - content_left:
                # A fitted page-size picture starts at the top of the text area.
                shift = box.top - (page.height - setup.margin_top_pt)
                box.top -= shift
                box.bottom -= shift
            items.append(_Flow(page.number, column_index, box.top, box=box))
        for rule in page.rules:
            if rule.x1 - rule.x0 >= 20 and id(rule) not in table_rules:
                items.append(_Flow(page.number, 0, rule.y, box=_rule_box(rule, content_left)))
        items.sort(key=lambda item: (item.column, -item.top))
        if items:
            items[0].first_on_page = True
            items[-1].last_on_page = True
            lowest = min(item.bottom() for item in items)
            # Content that stops well above the bottom margin was broken to the
            # next page on purpose.
            content_height = page.height - setup.margin_top_pt - setup.margin_bottom_pt
            if page.number < len(pages) and lowest > setup.margin_bottom_pt + max(body_pitch * 3, content_height * 0.2):
                items[-1].break_after = True
        flows.extend(items)

    # 2. A paragraph cut by a page boundary continues as one paragraph.
    merged: list[_Flow] = []
    for flow in flows:
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and previous.paragraph is not None
            and flow.paragraph is not None
            and previous.last_on_page
            and flow.first_on_page
            and not previous.break_after
            and flow.page == previous.paragraph.last.page + 1
            and _continues_across_pages(previous.paragraph, flow.paragraph)
        ):
            previous.paragraph = Paragraph(
                [*previous.paragraph.lines, *flow.paragraph.lines],
                previous.paragraph.page,
                previous.paragraph.column_left,
                previous.paragraph.column_right,
                previous.paragraph.list_marker,
            )
            previous.last_on_page = flow.last_on_page
            previous.break_after = flow.break_after
            continue
        merged.append(flow)

    # 3. Render with paragraph spacing measured from the page.
    output: list[str] = []
    gaps: list[float] = []
    image_bytes = 0
    over_budget = False
    previous_box: _Box | None = None
    previous_page = 0
    previous_column = -1
    for flow in merged:
        box = flow.box or _paragraph_box(flow.paragraph, setup.style, pitches, heading_levels)  # type: ignore[arg-type]
        if box.body.startswith("<img"):
            # Pictures were budgeted as they were read; this is a backstop.
            if image_bytes + len(box.body) > HTML_IMAGE_BUDGET_BYTES * 1.1:
                if not over_budget:
                    warnings.append(
                        f"Some pictures from page {flow.page} on were left out to keep the draft within its size limit."
                    )
                over_budget = True
                continue
            image_bytes += len(box.body)
        page = pages[flow.page - 1]
        if previous_box is None or flow.page != previous_page or flow.column != previous_column:
            margin = (page.height - setup.margin_top_pt) - box.top
        else:
            margin = previous_box.bottom - box.top
            if margin > 0.5 and flow.paragraph is not None:
                gaps.append(margin)
        output.append(_box_html(box, margin))
        if flow.break_after:
            output.append('<hr class="document-page-break">')
        previous_box = box
        previous_page = flow.paragraph.last.page if flow.paragraph is not None else flow.page
        previous_column = flow.column
    paragraph_gap = Counter(round(gap * 2) / 2 for gap in gaps).most_common(1)[0][0] if gaps else 0.0
    return "".join(output), paragraph_gap


@dataclass(slots=True)
class _RunningPlan:
    """Which page's running text is the template, and whether page one
    shows its own (or none)."""

    source: PageContent | None = None
    first: PageContent | None = None
    first_differs: bool = False
    # Whether the template's text changes between the pages that share it
    # (page numbers do; a constant "Schedule 2" does not).
    varies: bool = False


def _settle_running(pages: list[PageContent]) -> dict[str, _RunningPlan]:
    """Keeps only running text that recurs (the template, on at least half
    of the later pages) or that belongs to page one; everything else goes
    back into its page's body before the body is laid out."""

    plans: dict[str, _RunningPlan] = {}
    for kind in ("header", "footer"):
        plan = _RunningPlan()
        plans[kind] = plan
        signatures = {page.number: _running_signature(page, kind) for page in pages}
        later = [page for page in pages[1:] if signatures[page.number] != ((), ())]
        common, count = Counter(signatures[page.number] for page in later).most_common(1)[0] if later else (None, 0)
        if common is None or count < max(1, math.ceil((len(pages) - 1) * 0.5)):
            for page in later:
                _unmark_running(page, kind)
            common = None
        else:
            for page in later:
                if signatures[page.number] != common:
                    _unmark_running(page, kind)
            plan.source = next(page for page in later if signatures[page.number] == common)
            texts = {
                tuple(line.text for line in _running_items(page, kind)[0])
                for page in later
                if signatures[page.number] == common
            }
            plan.varies = len(texts) > 1
        first_signature = signatures[pages[0].number]
        if len(pages) == 1:
            if first_signature != ((), ()):
                plan.source = pages[0]
            continue
        if first_signature != ((), ()) and first_signature != common:
            plan.first = pages[0]
            plan.first_differs = True
        elif first_signature == ((), ()) and common is not None:
            plan.first_differs = True
    return plans


def _running_html(
    pages: list[PageContent],
    setup: PageSetup,
    pitches: dict[float, float],
    plans: dict[str, _RunningPlan],
) -> None:
    left = setup.margin_left_pt
    right = setup.width_pt - setup.margin_right_pt
    total = len(pages)

    def render(page: PageContent, kind: str, varies: bool) -> str:
        lines, pictures = _running_items(page, kind)
        fields = _PageFields(page.number, total, varies)
        boxes = [
            _paragraph_box(paragraph, setup.style, pitches, {}, fields)
            for paragraph in _paragraphs(lines, left, right, pitches)
        ] + [_picture_box(picture, left, right) for picture in pictures]
        boxes.sort(key=lambda box: -box.top)
        parts: list[str] = []
        previous: _Box | None = None
        for box in boxes:
            parts.append(_box_html(box, 0 if previous is None else previous.bottom - box.top))
            previous = box
        return "".join(parts)

    def distance(page: PageContent, kind: str) -> float:
        lines, pictures = _running_items(page, kind)
        if kind == "header":
            return max(0.0, page.height - max([line.top for line in lines] + [picture.top for picture in pictures]))
        return max(0.0, min([line.bottom for line in lines] + [picture.bottom for picture in pictures]))

    for kind in ("header", "footer"):
        plan = plans.get(kind) or _RunningPlan()
        main = render(plan.source, kind, plan.varies) if plan.source is not None else ""
        first = render(plan.first, kind, False) if plan.first is not None else ""
        anchor = plan.source or plan.first
        if kind == "header":
            setup.header_html = main
            if plan.first_differs:
                setup.first_header_html = first
            if anchor is not None:
                setup.header_distance_pt = distance(anchor, kind)
        else:
            setup.footer_html = main
            if plan.first_differs:
                setup.first_footer_html = first
            if anchor is not None:
                setup.footer_distance_pt = distance(anchor, kind)


def _marker_html(setup: PageSetup) -> str:
    style = "; ".join(
        [
            f"width: {_pt(setup.width_pt)}",
            f"height: {_pt(setup.height_pt)}",
            f"padding-top: {_pt(setup.margin_top_pt)}",
            f"padding-right: {_pt(setup.margin_right_pt)}",
            f"padding-bottom: {_pt(setup.margin_bottom_pt)}",
            f"padding-left: {_pt(setup.margin_left_pt)}",
            f"margin-top: {_pt(setup.header_distance_pt)}",
            f"margin-bottom: {_pt(setup.footer_distance_pt)}",
            f"font-family: {setup.style.stack}",
            f"font-size: {_px(setup.style.size_pt)}",
            f"line-height: {_num(setup.line_height, 3)}",
            f"color: {setup.style.color}",
        ]
    )
    parts = [
        f'<p class="{DOCUMENT_PAGE_NORMAL_CLASS}" style="margin-top: 0px; margin-bottom: {_px(setup.paragraph_after_pt)}"><br></p>',
        f'<div class="{DOCUMENT_PAGE_HEADER_CLASS}">{setup.header_html}</div>' if setup.header_html else "",
        f'<div class="{DOCUMENT_PAGE_FOOTER_CLASS}">{setup.footer_html}</div>' if setup.footer_html else "",
        f'<div class="{DOCUMENT_PAGE_HEADER_FIRST_CLASS}">{setup.first_header_html}</div>'
        if setup.first_header_html is not None
        else "",
        f'<div class="{DOCUMENT_PAGE_FOOTER_FIRST_CLASS}">{setup.first_footer_html}</div>'
        if setup.first_footer_html is not None
        else "",
    ]
    return f'<div class="{DOCUMENT_PAGE_SETUP_CLASS}" style="{html.escape(style, quote=True)}">{"".join(parts)}</div>'
