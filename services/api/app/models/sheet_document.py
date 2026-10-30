"""Server-side canonical form for spreadsheets stored as drafts.

Mirrors ``apps/web/src/lib/sheet/sheetModel.ts`` (``parseWorkbook`` +
``serializeWorkbook``) byte for byte: the browser parses for a good editing
experience, this module is the authority for what may be persisted. Unknown
keys are dropped, every string is bounded, and formulas are stored as text
only; nothing here ever evaluates them.

Byte parity means JavaScript semantics rather than Python's: lengths and slices
count UTF-16 code units, ``trim`` uses the ECMAScript whitespace set, numbers
print like ``Number.prototype.toString``, and keys that read as array indices
(row numbers) serialize first in numeric order, exactly as ``JSON.stringify``
writes them. The shared fixture under ``tests/fixtures/sheet-v1`` pins every
rule on both sides.

Glossary: a workbook holds sheets; a sheet holds cells keyed by A1 address. A
cell stores what the author typed, a literal (``v``) or a formula (``f``,
without the leading "="). Ranges are inclusive rectangles of 0-based rows and
columns; only their A1 text is 1-based.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable
from functools import partial
from typing import Any, NamedTuple

from app.models.draft_digest import draft_content_digest

SHEET_SCHEMA_VERSION = "aperture-sheet-v1"
SHEET_SANITIZER_VERSION = "sheet-json-v1"
MAX_SHEET_CONTENT_BYTES = 8_000_000
MAX_SHEETS = 40
MAX_WORKBOOK_CELLS = 200_000
MAX_CELL_TEXT_CHARS = 32_767
MAX_FORMULA_CHARS = 8_192
MAX_NOTE_CHARS = 2_000
MAX_SHEET_NAME_CHARS = 31
MAX_MERGES_PER_SHEET = 2_000
MAX_OBJECTS_PER_SHEET = 50  # tables, charts, pivots each
MAX_RULES_PER_SHEET = 100  # conditional formats, validations each
MAX_DEFINED_NAMES = 200
MAX_LIST_ITEMS = 500
MAX_SHEET_ROWS = 20_000
MAX_SHEET_COLS = 256  # A..IV
MIN_COL_WIDTH = 24
MAX_COL_WIDTH = 2_000
MIN_ROW_HEIGHT = 18
MAX_ROW_HEIGHT = 1_000
MAX_CONDITIONAL_FORMULA_CHARS = 1_000
MAX_LABEL_CHARS = 255
MAX_SOURCE_CHARS = 300  # stored length of a range that may name another sheet, quotes included

BORDER_STYLES = ("thin", "medium", "thick", "dashed", "dotted", "double")
TABLE_TONES = ("light", "medium", "dark")
CHART_TYPES = ("column", "bar", "line", "area", "pie", "doughnut", "scatter")
CHART_LEGENDS = ("right", "bottom", "top", "none")
PIVOT_AGGREGATES = ("sum", "count", "average", "min", "max", "countDistinct")
CELL_OPERATORS = ("gt", "gte", "lt", "lte", "eq", "neq", "between", "notBetween")
TEXT_OPERATORS = ("contains", "notContains", "begins", "ends")
VALIDATION_KINDS = ("list", "whole", "decimal", "date", "textLength")

_RANGE_OPERATORS = ("between", "notBetween")
_FILTER_OPERATORS = CELL_OPERATORS + TEXT_OPERATORS
_HORIZONTAL_ALIGN = ("left", "center", "right")
_VERTICAL_ALIGN = ("top", "middle", "bottom")
_BORDER_SIDES = ("top", "right", "bottom", "left")
_STYLE_FLAGS = ("bold", "italic", "underline", "strike", "wrap")
_DEFAULT_RULE_STYLE = "#f8d7da"
_DEFAULT_BAR_COLOR = "#087d8b"

# ECMAScript WhiteSpace plus LineTerminator: what String.prototype.trim removes.
_JS_WHITESPACE = (
    "\t\n\v\f\r          "
    "        　﻿"
)
# re.ASCII keeps [a-z] with IGNORECASE from matching "ſ" or the Kelvin sign.
_HEX_COLOR = re.compile(r"#[0-9a-f]{6}", re.IGNORECASE | re.ASCII)
_OBJECT_ID = re.compile(r"[A-Za-z0-9_-]{1,60}")
_FONT_NAME = re.compile(r"[a-z0-9][a-z0-9 \-]{0,58}", re.IGNORECASE | re.ASCII)
_TABLE_NAME = re.compile(r"[A-Za-z_\\][A-Za-z0-9_.]{0,254}")
_R1C1_NAME = re.compile(r"[Rr][0-9]*[Cc][0-9]*")
_SHEET_NAME_FORBIDDEN = re.compile(r"[:\\/?*\[\]]")
_PLAIN_SHEET_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")
_CELL = re.compile(r"\$?([A-Za-z]{1,3})\$?([0-9]{1,7})")
_LETTERS = re.compile(r"[A-Za-z]{1,3}")
_DIGITS = re.compile(r"[0-9]{1,7}")
_ROW_KEY = re.compile(r"[1-9][0-9]{0,6}")
# Canonical keys that read as integers are row numbers, far below 2**32 - 1.
_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*")
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")

Bag = dict[str, Any]


class SheetValidationError(ValueError):
    """The submitted workbook is not storable; the message is safe to show."""


def sheet_content_sha256(content: str) -> str:
    return draft_content_digest(SHEET_SANITIZER_VERSION, content)


def canonicalize_sheet_json(value: str) -> str:
    """Validate a workbook JSON string and return its canonical serialization.

    The result is the client's ``serializeWorkbook(parseWorkbook(value))``
    byte for byte, and it parses back to itself, as every stored revision must.
    """

    if not isinstance(value, str):
        raise TypeError("Spreadsheet content must be a string.")
    _require_storable_size(value)
    serialized = _serialize(_parse_workbook(_decode(value)))
    _require_storable_size(serialized)
    return serialized


def sheet_plain_text(canonical: str) -> str:
    """Searchable text of a canonical workbook: sheet names and literal cells."""

    try:
        workbook = json.loads(canonical, parse_int=float)
    except ValueError:
        return ""
    if not isinstance(workbook, dict):
        return ""
    parts: list[str] = []
    for sheet in workbook.get("sheets") or []:
        parts.append(sheet["name"].strip())
        parts.extend(_cell_search_text(cell.get("v")) for cell in sheet["cells"].values())
    # Canonical JSON escapes a surrogate half left by a bounded cut; it is not
    # searchable text and cannot be stored as UTF-8.
    return _LONE_SURROGATE.sub("", "\n".join(part for part in parts if part))


def _cell_search_text(literal: object) -> str:
    if isinstance(literal, str):
        return literal.strip()
    if isinstance(literal, float):
        return _js_number(literal)
    return ""


def _require_storable_size(value: str) -> None:
    # surrogatepass: a lone surrogate costs three bytes, as TextEncoder's U+FFFD would.
    if len(value.encode("utf-8", "surrogatepass")) > MAX_SHEET_CONTENT_BYTES:
        raise SheetValidationError(
            f"Spreadsheet exceeds the {MAX_SHEET_CONTENT_BYTES // 1_000_000} MB content limit."
        )


# --- JavaScript value semantics -------------------------------------------


def _reject_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


def _decode(value: str) -> object:
    """``JSON.parse``: doubles for every number, no NaN or Infinity literals."""

    try:
        return _utf16_strings(json.loads(value, parse_int=float, parse_constant=_reject_constant))
    except (ValueError, RecursionError) as exc:
        raise SheetValidationError("The workbook is not valid JSON.") from exc


def _utf16_strings(value: object) -> object:
    """Rejoin surrogate halves the way a JavaScript string already holds them."""

    if isinstance(value, str):
        return _well_formed(value)
    if isinstance(value, list):
        return [_utf16_strings(item) for item in value]
    if isinstance(value, dict):
        return {_well_formed(key): _utf16_strings(item) for key, item in value.items()}
    return value


def _units(value: str) -> bytes:
    return value.encode("utf-16-le", "surrogatepass")


def _well_formed(value: str) -> str:
    return _units(value).decode("utf-16-le", "surrogatepass")


def _length(value: str) -> int:
    return len(_units(value)) // 2


def _clip(value: str, limit: int) -> str:
    """``value.slice(0, limit)`` in UTF-16 units; may end on a lone surrogate."""

    return _units(value)[: limit * 2].decode("utf-16-le", "surrogatepass")


def _trim(value: str) -> str:
    return value.strip(_JS_WHITESPACE)


def _js_round(value: float) -> int:
    """``Math.round``: halves go toward positive infinity."""

    whole = math.floor(value)
    return whole + 1 if value - whole >= 0.5 else whole


def _js_number(value: float) -> str:
    """``Number.prototype.toString`` for a double."""

    if value < 0:
        return "-" + _js_number(-value)
    if value == 0:
        return "0"  # -0 is not below zero, so it lands here too
    if math.isinf(value):
        return "Infinity"
    mantissa, _, exponent = repr(value).partition("e")
    whole, _, fraction = mantissa.partition(".")
    figures = (whole + fraction).lstrip("0")
    point = len(whole) + int(exponent or 0) - (len(whole + fraction) - len(figures))
    return _place_point(figures.rstrip("0"), point)


def _place_point(digits: str, point: int) -> str:
    """Digits ``d1..dk`` worth ``0.d1..dk * 10**point``, written as ECMAScript does."""

    if point > 21 or point <= -6:
        head = digits if len(digits) == 1 else f"{digits[0]}.{digits[1:]}"
        return f"{head}e{point - 1:+d}"
    if point >= len(digits):
        return digits + "0" * (point - len(digits))
    if point > 0:
        return f"{digits[:point]}.{digits[point:]}"
    return "0." + "0" * -point + digits


def _js_string(value: object) -> str:
    """``String(value)`` for a parsed JSON value."""

    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return _js_number(value)
    if isinstance(value, list):
        return ",".join("" if item is None else _js_string(item) for item in value)
    return "null" if value is None else "[object Object]"


def _serialize(value: object) -> str:
    """``JSON.stringify`` of the parsed workbook, keys sorted at every depth."""

    if isinstance(value, dict):
        members = (f"{_quote(key)}:{_serialize(value[key])}" for key in _key_order(value))
        return "{" + ",".join(members) + "}"
    if isinstance(value, list):
        return "[" + ",".join(_serialize(item) for item in value) + "]"
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    assert isinstance(value, float)
    return _js_number(value)


def _key_order(value: Bag) -> list[str]:
    # Every canonical key is in the Basic Multilingual Plane, where code point
    # order and JavaScript's UTF-16 order agree.
    indices = sorted((key for key in value if _ARRAY_INDEX.fullmatch(key)), key=int)
    return indices + sorted(key for key in value if not _ARRAY_INDEX.fullmatch(key))


def _quote(value: str) -> str:
    quoted = json.dumps(_well_formed(value), ensure_ascii=False)
    return _LONE_SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", quoted)


# --- field readers ----------------------------------------------------------


def _is_bag(value: object) -> bool:
    return isinstance(value, dict)


def _text(value: object, limit: int) -> str | None:
    return _clip(value.replace("\x00", ""), limit) if isinstance(value, str) else None


def _label(value: object, limit: int) -> str | None:
    """Bounded, trimmed text; blank is absent."""

    return _trim(_text(value, limit) or "") or None


def _string_text(value: object) -> str:
    """``text(String(value), 255)``."""

    return _clip(_js_string(value).replace("\x00", ""), MAX_LABEL_CHARS)


def _operand(value: object) -> str:
    """``text(String(value ?? ""), 255)``."""

    return _string_text("" if value is None else value)


def _one_of(value: object, allowed: tuple[str, ...]) -> str | None:
    return value if isinstance(value, str) and value in allowed else None


def _bool(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _true(value: object) -> bool | None:
    return True if value is True else None


def _or(value: Any, default: Any) -> Any:
    """JavaScript ``??``."""

    return default if value is None else value


def _color(value: object) -> str | None:
    return value.lower() if isinstance(value, str) and _HEX_COLOR.fullmatch(value) else None


def _object_id(value: object) -> str | None:
    return value if isinstance(value, str) and _OBJECT_ID.fullmatch(value) else None


def _clamp_int(value: object, low: int, high: int) -> int | None:
    if not isinstance(value, float) or not math.isfinite(value):
        return None
    return min(high, max(low, _js_round(value)))


def _present(fields: Bag) -> Bag:
    """Drop absent (None) fields, as ``JSON.stringify`` drops undefined."""

    return {key: item for key, item in fields.items() if item is not None}


def _compact(fields: Bag) -> Bag | None:
    return _present(fields) or None


def _parsed(values: list[Any], parse: Callable[[Any], Any]) -> list[Any]:
    """Parse every entry (parsers may reserve names) and keep the valid ones."""

    return [item for item in map(parse, values) if item is not None]


def _list(value: object, parse: Callable[[Any], Any], limit: int) -> list[Any] | None:
    if not isinstance(value, list):
        return None
    return _parsed(value, parse)[:limit] or None


def _unique_ids(items: list[Bag] | None) -> list[Bag] | None:
    if items is None:
        return None
    first = {}
    for item in items:
        first.setdefault(item["id"], item)
    return list(first.values())


# --- A1 addressing ----------------------------------------------------------


class _Range(NamedTuple):
    r1: int
    c1: int
    r2: int
    c2: int


def _column_index(label: str) -> int:
    if not _LETTERS.fullmatch(label):
        return -1
    index = 0
    for letter in label.upper():
        index = index * 26 + ord(letter) - 64
    return index - 1


def _column_label(col: int) -> str:
    label = ""
    remaining = col + 1
    while remaining > 0:
        remaining, rem = divmod(remaining - 1, 26)
        label = chr(65 + rem) + label
    return label


def _cell_key(row: int, col: int) -> str:
    return f"{_column_label(col)}{row + 1}"


def _cell_point(text: str) -> tuple[int, int] | None:
    match = _CELL.fullmatch(_trim(text))
    if match is None:
        return None
    row = int(match[2]) - 1
    col = _column_index(match[1])
    if col >= MAX_SHEET_COLS or not 0 <= row < MAX_SHEET_ROWS:
        return None
    return row, col


def _span(text: str) -> _Range | None:
    """Parses "A1:C5", "C5:A1", "B2", "A:C" (whole columns), or "2:4" (whole rows)."""

    parts = _trim(text).split(":")
    if len(parts) == 1:
        point = _cell_point(parts[0])
        return None if point is None else _Range(*point, *point)
    if len(parts) != 2:
        return None
    return _pair_span(*(part.replace("$", "") for part in parts))


def _pair_span(left: str, right: str) -> _Range | None:
    if _LETTERS.fullmatch(left) and _LETTERS.fullmatch(right):
        return _column_span(_column_index(left), _column_index(right))
    if _DIGITS.fullmatch(left) and _DIGITS.fullmatch(right):
        return _row_span(int(left) - 1, int(right) - 1)
    start, end = _cell_point(left), _cell_point(right)
    if start is None or end is None:
        return None
    return _Range(min(start[0], end[0]), min(start[1], end[1]), max(start[0], end[0]), max(start[1], end[1]))


def _column_span(a: int, b: int) -> _Range | None:
    if max(a, b) >= MAX_SHEET_COLS:
        return None
    return _Range(0, min(a, b), MAX_SHEET_ROWS - 1, max(a, b))


def _row_span(a: int, b: int) -> _Range | None:
    if min(a, b) < 0 or max(a, b) >= MAX_SHEET_ROWS:
        return None
    return _Range(min(a, b), 0, max(a, b), MAX_SHEET_COLS - 1)


def _format_range(span: _Range) -> str:
    start = _cell_key(span.r1, span.c1)
    if span.r1 == span.r2 and span.c1 == span.c2:
        return start
    if span.r1 == 0 and span.r2 == MAX_SHEET_ROWS - 1:
        return f"{_column_label(span.c1)}:{_column_label(span.c2)}"
    if span.c1 == 0 and span.c2 == MAX_SHEET_COLS - 1:
        return f"{span.r1 + 1}:{span.r2 + 1}"
    return f"{start}:{_cell_key(span.r2, span.c2)}"


def _local_span(value: object) -> _Range | None:
    return _span(value) if isinstance(value, str) else None


def _local_range(value: object) -> str | None:
    """A1 range text on one sheet, normalized."""

    span = _local_span(value)
    return None if span is None else _format_range(span)


def _local_cell(value: object) -> str | None:
    """A single cell in its canonical spelling ("$h$02 " -> "H2")."""

    point = _cell_point(value) if isinstance(value, str) else None
    return None if point is None else _cell_key(*point)


def _split_qualified(text: str) -> tuple[str | None, str]:
    """Splits "'Q1 Sales'!B2:D9" into its sheet name and range text."""

    sheet, bang, ref = _trim(text).rpartition("!")
    if not bang:
        return None, ref
    # The client also requires two characters; a lone "'" is refused either way.
    if sheet.startswith("'") and sheet.endswith("'"):
        sheet = sheet[1:-1].replace("''", "'")
    return sheet, ref


def _qualified_range(value: object) -> str | None:
    """Range text that may name another sheet ("'Q1 Data'!A1:F90"). The length
    limit applies to the stored form, so quoting cannot push it over next time."""

    if not isinstance(value, str):
        return None
    sheet, ref = _split_qualified(value)
    local = _local_range(ref)
    if local is None or (sheet is not None and _sheet_name_problem(sheet)):
        return None
    source = local if sheet is None else f"{_quote_sheet_name(sheet)}!{local}"
    return source if _length(source) <= MAX_SOURCE_CHARS else None


def _quote_sheet_name(name: str) -> str:
    """Quotes a sheet name unless it reads plainly: not a cell or R1C1 address."""

    plain = (
        _PLAIN_SHEET_NAME.fullmatch(name) is not None
        and _cell_point(name) is None
        and _R1C1_NAME.fullmatch(name) is None
    )
    return name if plain else "'" + name.replace("'", "''") + "'"


# --- names ------------------------------------------------------------------


def _sheet_name_problem(name: str) -> bool:
    """Excel sheet-name rules; uniqueness is checked by the caller."""

    trimmed = _trim(name)
    return (
        not trimmed
        or _length(trimmed) > MAX_SHEET_NAME_CHARS
        or _SHEET_NAME_FORBIDDEN.search(trimmed) is not None
        or trimmed[0] == "'"
        or trimmed[-1] == "'"
        or trimmed.lower() == "history"
    )


def _table_name_problem(name: str) -> bool:
    """Excel table and defined-name rules, including names that read as addresses."""

    return (
        _TABLE_NAME.fullmatch(name) is None
        or _cell_point(name) is not None
        or _R1C1_NAME.fullmatch(name) is not None
        or name in ("R", "r", "C", "c")
    )


def _unique_sheet_name(base: str, taken: set[str]) -> str:
    # The client's stem cleanup never changes a base that reaches here: it is
    # either a valid trimmed name or "SheetN".
    if base.lower() not in taken:
        return base
    number = 2
    while True:
        suffix = f" ({number})"
        candidate = _clip(base, MAX_SHEET_NAME_CHARS - len(suffix)) + suffix
        if candidate.lower() not in taken:
            return candidate
        number += 1


def _sheet_name(value: object, index: int, taken: set[str]) -> str:
    name = _trim(value) if isinstance(value, str) else ""
    valid = bool(name) and not _sheet_name_problem(name)
    if not valid or name.lower() in taken:
        name = _unique_sheet_name(name if valid else f"Sheet{index + 1}", taken)
    taken.add(name.lower())
    return name


# --- cells and styles ---------------------------------------------------------


def _formula(value: object, limit: int) -> str:
    """Formula text without the "=" signs and spaces that lead it, bounded and
    trimmed so it reads back the same ("  ==A1" -> "A1"; "==" -> none)."""

    if not isinstance(value, str):
        return ""
    return _clip(value.lstrip("=" + _JS_WHITESPACE), limit).rstrip(_JS_WHITESPACE)


def _literal(value: object) -> str | float | bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    # Text that is empty once NUL is removed is dropped like any empty value.
    return _text(value, MAX_CELL_TEXT_CHARS) or None


def _parse_cell(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    formula = _formula(value.get("f"), MAX_FORMULA_CHARS)
    return _compact(
        {
            "v": None if formula else _literal(value.get("v")),
            "f": formula or None,
            "s": _parse_cell_style(value.get("s")),
            "n": _label(value.get("n"), MAX_NOTE_CHARS),
        }
    )


def _parse_border(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    style = _one_of(value.get("style"), BORDER_STYLES)
    if style is None:
        return None
    return _present({"style": style, "color": _color(value.get("color"))})


def _font(value: object) -> str | None:
    return value if isinstance(value, str) and _FONT_NAME.fullmatch(value) else None


def _number_format(value: object) -> str | None:
    """A format code judged after NUL removal; "General" is the default and is not stored."""

    code = value.replace("\x00", "") if isinstance(value, str) else ""
    return None if _length(code) > 255 or code == "General" else code or None


def _parse_cell_style(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    border = value.get("border")
    return _compact(
        {
            **{flag: _bool(value.get(flag)) for flag in _STYLE_FLAGS},
            "font": _font(value.get("font")),
            "size": _clamp_int(value.get("size"), 6, 72),
            "color": _color(value.get("color")),
            "fill": _color(value.get("fill")),
            "align": _one_of(value.get("align"), _HORIZONTAL_ALIGN),
            "valign": _one_of(value.get("valign"), _VERTICAL_ALIGN),
            "indent": _clamp_int(value.get("indent"), 0, 10) or None,
            "format": _number_format(value.get("format")),
            "border": _compact({side: _parse_border(border.get(side)) for side in _BORDER_SIDES})
            if isinstance(border, dict)
            else None,
        }
    )


def _parse_cells(value: object) -> Bag:
    cells: Bag = {}
    if not isinstance(value, dict):
        return cells
    # Keys take their canonical spelling (" b02 " -> "B2"); when two spell the
    # same cell, the one parsed last wins, as a repeated JSON key would.
    for key, raw in value.items():
        point = None if "$" in key else _cell_point(key)
        cell = None if point is None else _parse_cell(raw)
        if cell is not None:
            cells[_cell_key(*point)] = cell
    return cells


def _parse_dimension(
    value: object, key_ok: Callable[[str], bool], size_key: str, low: int, high: int
) -> Bag | None:
    if not isinstance(value, dict):
        return None
    out: Bag = {}
    for key, raw in value.items():
        if not key_ok(key) or not isinstance(raw, dict):
            continue
        entry = _compact(
            {
                size_key: _clamp_int(raw.get(size_key), low, high),
                "hidden": _true(raw.get("hidden")),
                "s": _parse_cell_style(raw.get("s")),
            }
        )
        if entry is not None:
            out[key.upper()] = entry
    return out or None


def _column_key(key: str) -> bool:
    return 0 <= _column_index(key) < MAX_SHEET_COLS


def _row_key(key: str) -> bool:
    return _ROW_KEY.fullmatch(key) is not None and int(key) <= MAX_SHEET_ROWS


def _merges(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    ranges = (_local_range(item) for item in value)
    unique = dict.fromkeys(item for item in ranges if item and ":" in item)
    return list(unique)[:MAX_MERGES_PER_SHEET] or None


def _freeze(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    rows = _or(_clamp_int(value.get("rows"), 0, 100), 0)
    cols = _or(_clamp_int(value.get("cols"), 0, 30), 0)
    return {"rows": rows, "cols": cols} if rows or cols else None


# --- filter -------------------------------------------------------------------


def _filter_condition(value: object) -> Bag | None:
    """A filter condition; between and notBetween keep only with an upper bound."""

    op = _one_of(value.get("op"), _FILTER_OPERATORS) if isinstance(value, dict) else None
    if op is None:
        return None
    assert isinstance(value, dict)
    upper = _operand(value.get("value2")) if op in _RANGE_OPERATORS else None
    if op in _RANGE_OPERATORS and not upper:
        return None
    return _present({"op": op, "value": _operand(value.get("value")), "value2": upper})


def _filter_values(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return [_string_text(item) for item in value[:MAX_LIST_ITEMS]]


def _filter_criteria(value: object) -> Bag:
    criteria: Bag = {}
    if not isinstance(value, dict):
        return criteria
    for letter, raw in value.items():
        if _column_index(letter) < 0 or not isinstance(raw, dict):
            continue
        entry = _compact(
            {"values": _filter_values(raw.get("values")), "condition": _filter_condition(raw.get("condition"))}
        )
        if entry is not None:
            criteria[letter.upper()] = entry
    return criteria


def _filter_sort(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    col = _js_string(value.get("col"))
    if _column_index(col) < 0:
        return None
    return {"col": col.upper(), "desc": value.get("desc") is True}


def _parse_filter(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    ref = _local_range(value.get("ref"))
    if ref is None:
        return None
    return _present(
        {"ref": ref, "criteria": _filter_criteria(value.get("criteria")), "sort": _filter_sort(value.get("sort"))}
    )


# --- tables, charts, pivots ---------------------------------------------------


def _parse_table(value: object, taken: set[str]) -> Bag | None:
    if not isinstance(value, dict):
        return None
    span = _local_span(value.get("ref"))
    raw_name = value.get("name")
    name = _trim(raw_name) if isinstance(raw_name, str) else ""
    if span is None or not name or _table_name_problem(name) or name.lower() in taken:
        return None
    if span.r2 - span.r1 < 1:
        return None  # a table needs a header row and a data row
    taken.add(name.lower())
    table: Bag = {
        "id": _or(_object_id(value.get("id")), name),
        "name": name,
        "ref": _format_range(span),
        "accent": _or(_clamp_int(value.get("accent"), 1, 6), 1),
        "tone": _or(_one_of(value.get("tone"), TABLE_TONES), "medium"),
        "banded": _or(_bool(value.get("banded")), True),
        "totals": _or(_bool(value.get("totals")), False),
        "filterButtons": _or(_bool(value.get("filterButtons")), True),
    }
    return _present({**table, "firstColumn": _true(value.get("firstColumn"))})


def _parse_chart(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    kind = _one_of(value.get("type"), CHART_TYPES)
    source = _qualified_range(value.get("source"))
    at = _local_cell(value.get("at"))
    chart_id = _object_id(value.get("id"))
    if kind is None or source is None or at is None or chart_id is None:
        return None
    return _present(
        {
            "id": chart_id,
            "type": kind,
            "title": _label(value.get("title"), 200),
            "source": source,
            "seriesBy": "rows" if value.get("seriesBy") == "rows" else "columns",
            "stacked": _true(value.get("stacked")),
            "legend": _or(_one_of(value.get("legend"), CHART_LEGENDS), "bottom"),
            "showValues": _true(value.get("showValues")),
            "xTitle": _label(value.get("xTitle"), 120),
            "yTitle": _label(value.get("yTitle"), 120),
            "at": at,
            "w": _or(_clamp_int(value.get("w"), 200, 1600), 480),
            "h": _or(_clamp_int(value.get("h"), 140, 1200), 300),
        }
    )


def _field_name(value: object) -> str | None:
    return _label(value, MAX_LABEL_CHARS)


def _field_names(value: object) -> list[str]:
    return _parsed(value if isinstance(value, list) else [], _field_name)[:8]


def _pivot_value(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    field = _field_name(value.get("field"))
    if field is None:
        return None
    return _present(
        {
            "field": field,
            "agg": _or(_one_of(value.get("agg"), PIVOT_AGGREGATES), "sum"),
            "label": _label(value.get("label"), MAX_LABEL_CHARS),
        }
    )


def _pivot_filter(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    field = _field_name(value.get("field"))
    include = value.get("include")
    if field is None or not isinstance(include, list):
        return None
    entries = _parsed(include, partial(_text, limit=MAX_LABEL_CHARS))
    return {"field": field, "include": entries[:MAX_LIST_ITEMS]}


def _parse_pivot(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    source = _qualified_range(value.get("source"))
    at = _local_cell(value.get("at"))
    pivot_id = _object_id(value.get("id"))
    if source is None or at is None or pivot_id is None:
        return None
    values = value.get("values")
    filters = value.get("filters")
    return {
        "id": pivot_id,
        "name": _label(value.get("name"), MAX_LABEL_CHARS) or "PivotTable",
        "source": source,
        "at": at,
        "rows": _field_names(value.get("rows")),
        "columns": _field_names(value.get("columns")),
        "values": _parsed(values if isinstance(values, list) else [], _pivot_value)[:8],
        "filters": _parsed(filters if isinstance(filters, list) else [], _pivot_filter)[:8],
        "rowTotals": _or(_bool(value.get("rowTotals")), True),
        "columnTotals": _or(_bool(value.get("columnTotals")), True),
    }


# --- conditional formats and validations ---------------------------------------


def _rule_style(value: object) -> Bag:
    style = None
    if isinstance(value, dict):
        style = _compact(
            {"fill": _color(value.get("fill")), "color": _color(value.get("color")), "bold": _true(value.get("bold"))}
        )
    return style or {"fill": _DEFAULT_RULE_STYLE}


def _operands(op: str, value: Bag) -> tuple[str, str | None] | None:
    """First operand, and the second for range operators; None when one is missing."""

    first = _operand(value.get("value"))
    if not first:
        return None
    if op not in _RANGE_OPERATORS:
        return first, None
    second = _operand(value.get("value2"))
    return (first, second) if second else None


def _scale_rule(value: Bag) -> Bag | None:
    low, high = _color(value.get("min")), _color(value.get("max"))
    if low is None or high is None:
        return None
    return _present({"type": "scale", "min": low, "mid": _color(value.get("mid")), "max": high})


def _bar_rule(value: Bag) -> Bag:
    return {"type": "bar", "color": _or(_color(value.get("color")), _DEFAULT_BAR_COLOR)}


def _cell_rule(value: Bag) -> Bag | None:
    op = _one_of(value.get("op"), CELL_OPERATORS)
    operands = None if op is None else _operands(op, value)
    if operands is None:
        return None
    first, second = operands
    return _present({"type": "cell", "op": op, "value": first, "value2": second, "style": _rule_style(value.get("style"))})


def _text_rule(value: Bag) -> Bag | None:
    op = _one_of(value.get("op"), TEXT_OPERATORS)
    needle = _text(value.get("text"), MAX_LABEL_CHARS)
    if op is None or not needle:
        return None
    return {"type": "text", "op": op, "text": needle, "style": _rule_style(value.get("style"))}


def _rank_rule(value: Bag) -> Bag:
    return _present(
        {
            "type": value["type"],
            "count": _or(_clamp_int(value.get("count"), 1, 1000), 10),
            "percent": _true(value.get("percent")),
            "style": _rule_style(value.get("style")),
        }
    )


def _simple_rule(value: Bag) -> Bag:
    return {"type": value["type"], "style": _rule_style(value.get("style"))}


def _formula_rule(value: Bag) -> Bag | None:
    formula = _formula(value.get("formula"), MAX_CONDITIONAL_FORMULA_CHARS)
    if not formula:
        return None
    return {"type": "formula", "formula": formula, "style": _rule_style(value.get("style"))}


_RULE_PARSERS: dict[str, Callable[[Bag], Bag | None]] = {
    "scale": _scale_rule,
    "bar": _bar_rule,
    "cell": _cell_rule,
    "text": _text_rule,
    "top": _rank_rule,
    "bottom": _rank_rule,
    **dict.fromkeys(("duplicate", "unique", "above", "below", "blank", "notBlank"), _simple_rule),
    "formula": _formula_rule,
}


def _parse_conditional(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    rule_id = _object_id(value.get("id"))
    ref = _local_range(value.get("ref"))
    kind = value.get("type")
    parse = _RULE_PARSERS.get(kind) if isinstance(kind, str) else None
    if rule_id is None or ref is None or parse is None:
        return None
    body = parse(value)
    return None if body is None else {"id": rule_id, "ref": ref, **body}


def _list_items(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    items = (_trim(_string_text(item)) for item in value)
    return list(dict.fromkeys(item for item in items if item))[:MAX_LIST_ITEMS]


def _list_rule(value: Bag) -> Bag | None:
    source = _qualified_range(value.get("source"))
    items = _list_items(value.get("items"))
    if source is None and not items:
        return None
    return {"items": None if source else items, "source": source}


def _bounded_rule(value: Bag) -> Bag | None:
    op = _or(_one_of(value.get("op"), CELL_OPERATORS), "between")
    operands = _operands(op, value)
    if operands is None:
        return None
    return {"op": op, "value": operands[0], "value2": operands[1]}


def _parse_validation(value: object) -> Bag | None:
    if not isinstance(value, dict):
        return None
    rule_id = _object_id(value.get("id"))
    ref = _local_range(value.get("ref"))
    kind = _one_of(value.get("kind"), VALIDATION_KINDS)
    if rule_id is None or ref is None or kind is None:
        return None
    rule = _list_rule(value) if kind == "list" else _bounded_rule(value)
    if rule is None:
        return None
    return _present(
        {
            "id": rule_id,
            "ref": ref,
            "kind": kind,
            **rule,
            "strict": _or(_bool(value.get("strict")), True),
            "message": _label(value.get("message"), MAX_LABEL_CHARS),
        }
    )


# --- sheets and workbook ------------------------------------------------------


def _parse_sheet(value: object, index: int, taken_names: set[str], taken_tables: set[str]) -> Bag | None:
    if not isinstance(value, dict):
        return None
    sheet_id = _or(_object_id(value.get("id")), f"sheet-{index + 1}")
    name = _sheet_name(value.get("name"), index, taken_names)
    return _present(
        {
            "id": sheet_id,
            "name": name,
            "color": _color(value.get("color")),
            "hidden": _true(value.get("hidden")),
            "cells": _parse_cells(value.get("cells")),
            "cols": _parse_dimension(value.get("cols"), _column_key, "w", MIN_COL_WIDTH, MAX_COL_WIDTH),
            "rows": _parse_dimension(value.get("rows"), _row_key, "h", MIN_ROW_HEIGHT, MAX_ROW_HEIGHT),
            "merges": _merges(value.get("merges")),
            "freeze": _freeze(value.get("freeze")),
            "gridlines": False if value.get("gridlines") is False else None,
            "filter": _parse_filter(value.get("filter")),
            "tables": _unique_ids(
                _list(value.get("tables"), partial(_parse_table, taken=taken_tables), MAX_OBJECTS_PER_SHEET)
            ),
            "charts": _unique_ids(_list(value.get("charts"), _parse_chart, MAX_OBJECTS_PER_SHEET)),
            "pivots": _unique_ids(_list(value.get("pivots"), _parse_pivot, MAX_OBJECTS_PER_SHEET)),
            "conditional": _unique_ids(_list(value.get("conditional"), _parse_conditional, MAX_RULES_PER_SHEET)),
            "validations": _unique_ids(_list(value.get("validations"), _parse_validation, MAX_RULES_PER_SHEET)),
        }
    )


def _next_sheet_id(taken: set[str]) -> str:
    number = 1
    while f"sheet-{number}" in taken:
        number += 1
    return f"sheet-{number}"


def _parse_sheets(values: list[Any], taken_tables: set[str]) -> list[Bag]:
    taken_names: set[str] = set()
    taken_ids: set[str] = set()
    sheets: list[Bag] = []
    for index, raw in enumerate(values[:MAX_SHEETS]):
        sheet = _parse_sheet(raw, index, taken_names, taken_tables)
        if sheet is None:
            continue
        if sheet["id"] in taken_ids:
            sheet["id"] = _next_sheet_id(taken_ids)
        taken_ids.add(sheet["id"])
        sheets.append(sheet)
    return sheets


def _parse_defined_name(value: object, taken: set[str]) -> Bag | None:
    if not isinstance(value, dict) or not isinstance(value.get("name"), str):
        return None
    name = _trim(value["name"])
    if _table_name_problem(name) or name.lower() in taken:
        return None
    ref = _qualified_range(value.get("ref"))
    if ref is None:
        return None
    taken.add(name.lower())
    return {"name": name, "ref": ref}


def _parse_workbook(candidate: object) -> Bag:
    if not isinstance(candidate, dict):
        raise SheetValidationError("The workbook is not an object.")
    if "schema" in candidate and candidate["schema"] != SHEET_SCHEMA_VERSION:
        raise SheetValidationError("This workbook was saved by a newer version of Aperture.")
    raw_sheets = candidate.get("sheets")
    if not isinstance(raw_sheets, list):
        raise SheetValidationError("A workbook needs at least one sheet.")
    taken_tables: set[str] = set()
    sheets = _parse_sheets(raw_sheets, taken_tables)
    if not sheets:
        raise SheetValidationError("A workbook needs at least one sheet.")
    if all(sheet.get("hidden") for sheet in sheets):
        del sheets[0]["hidden"]
    if sum(len(sheet["cells"]) for sheet in sheets) > MAX_WORKBOOK_CELLS:
        raise SheetValidationError(f"Workbooks can hold up to {MAX_WORKBOOK_CELLS:,} filled cells.")
    names = _list(candidate.get("names"), partial(_parse_defined_name, taken=set(taken_tables)), MAX_DEFINED_NAMES)
    return _present({"schema": SHEET_SCHEMA_VERSION, "sheets": sheets, "names": names})
