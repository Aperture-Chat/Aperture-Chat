from __future__ import annotations

import json
import random
from hashlib import sha256
from pathlib import Path
from typing import Any

import pytest

from app.models import sheet_document as sheet
from app.models.sheet_document import (
    SheetValidationError,
    canonicalize_sheet_json,
    sheet_content_sha256,
    sheet_plain_text,
)

FIXTURES = Path(__file__).parent / "fixtures" / "sheet-v1"
CASES = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))


def test_limits_match_the_client_fixture() -> None:
    limits = json.loads((FIXTURES / "limits.json").read_text(encoding="utf-8"))
    assert limits == {
        "schema": sheet.SHEET_SCHEMA_VERSION,
        "sanitizer_version": sheet.SHEET_SANITIZER_VERSION,
        "max_content_bytes": sheet.MAX_SHEET_CONTENT_BYTES,
        "max_sheets": sheet.MAX_SHEETS,
        "max_workbook_cells": sheet.MAX_WORKBOOK_CELLS,
        "max_cell_text_chars": sheet.MAX_CELL_TEXT_CHARS,
        "max_formula_chars": sheet.MAX_FORMULA_CHARS,
        "max_note_chars": sheet.MAX_NOTE_CHARS,
        "max_sheet_name_chars": sheet.MAX_SHEET_NAME_CHARS,
        "max_merges_per_sheet": sheet.MAX_MERGES_PER_SHEET,
        "max_objects_per_sheet": sheet.MAX_OBJECTS_PER_SHEET,
        "max_rules_per_sheet": sheet.MAX_RULES_PER_SHEET,
        "max_defined_names": sheet.MAX_DEFINED_NAMES,
        "max_list_items": sheet.MAX_LIST_ITEMS,
        "max_source_chars": sheet.MAX_SOURCE_CHARS,
        "max_sheet_rows": sheet.MAX_SHEET_ROWS,
        "max_sheet_cols": sheet.MAX_SHEET_COLS,
        "min_col_width": sheet.MIN_COL_WIDTH,
        "max_col_width": sheet.MAX_COL_WIDTH,
        "min_row_height": sheet.MIN_ROW_HEIGHT,
        "max_row_height": sheet.MAX_ROW_HEIGHT,
        "border_styles": list(sheet.BORDER_STYLES),
        "table_tones": list(sheet.TABLE_TONES),
        "chart_types": list(sheet.CHART_TYPES),
        "chart_legends": list(sheet.CHART_LEGENDS),
        "pivot_aggregates": list(sheet.PIVOT_AGGREGATES),
        "cell_operators": list(sheet.CELL_OPERATORS),
        "text_operators": list(sheet.TEXT_OPERATORS),
        "validation_kinds": list(sheet.VALIDATION_KINDS),
    }


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_canonical_form_matches_the_client_byte_for_byte(case: dict[str, Any]) -> None:
    source, expected = case["input"], case["output"]
    if expected is None:
        with pytest.raises(SheetValidationError):
            canonicalize_sheet_json(source)
        return
    assert canonicalize_sheet_json(source) == expected
    # Stored revisions are re-validated, so canonical output must be a fixed point.
    assert canonicalize_sheet_json(expected) == expected


def test_fixture_covers_every_rule_family() -> None:
    names = " ".join(case["name"] for case in CASES)
    for topic in ("sheet name", "table", "chart", "pivot", "conditional", "validation", "filter", "defined names", "number", "unicode", "control characters", "rejected", "equals sign", "collide", "upper bound"):
        assert topic in names


def test_storable_output_is_valid_utf8_even_when_a_pair_was_split() -> None:
    title = "a" * 199 + "\U0001F600"
    raw = json.dumps({"sheets": [{"name": "S", "charts": [{"id": "c", "type": "bar", "source": "A1:B2", "at": "A1", "title": title}]}]})
    canonical = canonicalize_sheet_json(raw)
    assert canonical.encode("utf-8")
    assert '"title":"' + "a" * 199 + '\\ud83d"' in canonical


def test_too_many_cells_are_refused() -> None:
    cells = {f"A{row}": {"v": 1} for row in range(1, sheet.MAX_SHEET_ROWS + 1)}
    sheets = [{"name": f"S{index}", "cells": cells} for index in range(10)]
    allowed = json.dumps({"sheets": sheets})
    assert len(json.loads(canonicalize_sheet_json(allowed))["sheets"]) == 10
    sheets.append({"name": "One more", "cells": {"A1": {"v": 1}}})
    with pytest.raises(SheetValidationError, match="200,000 filled cells"):
        canonicalize_sheet_json(json.dumps({"sheets": sheets}))


def test_oversized_and_deeply_nested_content_is_refused() -> None:
    minimal = '{"sheets":[{}]}'
    at_bound = minimal + " " * (sheet.MAX_SHEET_CONTENT_BYTES - len(minimal))
    assert json.loads(canonicalize_sheet_json(at_bound))["sheets"][0]["name"] == "Sheet1"
    with pytest.raises(SheetValidationError, match="8 MB"):
        canonicalize_sheet_json(at_bound + " ")
    nested = '{"sheets":[{}],"junk":' + "[" * 100_000 + "]" * 100_000 + "}"
    with pytest.raises(SheetValidationError, match="not valid JSON"):
        canonicalize_sheet_json(nested)


def test_canonical_output_over_the_byte_bound_is_refused() -> None:
    # String({}) is "[object Object]", so filter values grow about sixfold.
    criteria = {_column(index): {"values": [{}] * sheet.MAX_LIST_ITEMS} for index in range(1000)}
    raw = json.dumps({"sheets": [{"name": "S", "filter": {"ref": "A1:A2", "criteria": criteria}}]})
    assert len(raw.encode("utf-8")) < sheet.MAX_SHEET_CONTENT_BYTES
    with pytest.raises(SheetValidationError, match="8 MB"):
        canonicalize_sheet_json(raw)


def _column(index: int) -> str:
    label = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        label = chr(65 + rem) + label
    return label


def test_content_must_be_a_string() -> None:
    with pytest.raises(TypeError):
        canonicalize_sheet_json(b'{"sheets":[{}]}')  # type: ignore[arg-type]


def test_digest_is_domain_separated_by_sanitizer_version() -> None:
    canonical = canonicalize_sheet_json('{"sheets":[{"name":"Budget"}]}')
    expected = sha256(b"aperture-draft-content:sheet-json-v1:" + canonical.encode("utf-8")).hexdigest()
    assert sheet_content_sha256(canonical) == expected


def test_plain_text_covers_sheet_names_and_literal_cells_only() -> None:
    canonical = canonicalize_sheet_json(
        json.dumps(
            {
                "sheets": [
                    {
                        "name": "Budget 2027",
                        "cells": {
                            "A1": {"v": "Revenue"},
                            "A2": {"v": 1250.5},
                            "A3": {"v": 1e21},
                            "A4": {"f": "SUM(A2:A3)"},
                            "A5": {"v": True},
                            "A6": {"v": "  ", "n": "private note"},
                            "A7": {"v": 0},
                        },
                    },
                    {"name": "Notes", "cells": {"B2": {"v": "Close out Q4"}}},
                ]
            }
        )
    )
    assert sheet_plain_text(canonical).split("\n") == [
        "Budget 2027",
        "Revenue",
        "1250.5",
        "1e+21",
        "0",
        "Notes",
        "Close out Q4",
    ]


def test_plain_text_of_unreadable_content_is_empty() -> None:
    assert sheet_plain_text("not json") == ""
    assert sheet_plain_text("[]") == ""


def test_plain_text_drops_surrogate_halves_left_by_a_bounded_cut() -> None:
    raw = json.dumps({"sheets": [{"name": "S", "cells": {"A1": {"v": "x" * (sheet.MAX_CELL_TEXT_CHARS - 1) + "\U0001F600"}}}]})
    canonical = canonicalize_sheet_json(raw)
    assert canonical.endswith('x\\ud83d"}},"id":"sheet-1","name":"S"}]}')
    text = sheet_plain_text(canonical)
    assert text == "S\n" + "x" * (sheet.MAX_CELL_TEXT_CHARS - 1)
    assert text.encode("utf-8")


# Awkward pieces for random workbooks: every rule that once made the canonical
# form change on a second parse, plus junk of every JSON type.
_TEXT = (
    "", " ", "=", "==", "==A1", "  =A1 ", " = =B2 ", "A1", "a01", " b2 ", "$C$3", "IV20000", "IW1", "\x00", "\x00\x00",
    "General", "Gen\x00eral", "R1C1", "Q1 Data", "O'Brien", "'x'", "\U0001F600", "\ud83d", "History", "Sheet1", "sheet1",
    "B2:A1", "A:C", "2:4", "Plan!A1:B2", "R1C1!A1:B2", "'a!b'!A1", "' Spaced '!A1", "#FFAA00", "between", "notBetween", "gt",
    "contains", "x" * 40, " " * 310 + "A1", "Q1 Data" + " " * 293 + "!A1:B2", "=" + "x" * 8190 + "  y",
)
_NUMBERS = (0.0, -0.0, 1.0, 2.5, -1.5, 0.1 + 0.2, 1e21, 1e-7, 9007199254740993.0, 300.0, 20001.0)
_KEYS = ("A1", "a1", " A1", "A01", "B2", "b02", "$B$2", "IV1", "IW1", "A0", "C3", "1", "x", "AA10")
_FIELDS = (
    "v", "f", "s", "n", "id", "name", "ref", "type", "op", "value", "value2", "source", "at", "formula", "kind", "items",
    "text", "style", "fill", "format", "size", "condition", "values", "criteria", "col", "hidden", "min", "max", "count",
)


def _random_value(rng: random.Random, depth: int) -> object:
    roll = rng.random()
    if roll < 0.45 or depth > 3:
        return rng.choice(_TEXT)
    if roll < 0.65:
        return rng.choice(_NUMBERS)
    if roll < 0.75:
        return rng.choice((True, False, None))
    if roll < 0.85:
        return [_random_value(rng, depth + 1) for _ in range(rng.randrange(4))]
    return _random_bag(rng, depth + 1, _FIELDS)


def _random_bag(rng: random.Random, depth: int, keys: tuple[str, ...]) -> dict[str, object]:
    return {rng.choice(keys): _random_value(rng, depth) for _ in range(rng.randrange(6))}


def _random_sheet(rng: random.Random) -> dict[str, object]:
    def objects(**fixed: tuple[object, ...]) -> list[dict[str, object]]:
        return [
            {**_random_bag(rng, 2, _FIELDS), **{key: rng.choice(options) for key, options in fixed.items()}}
            for _ in range(rng.randrange(4))
        ]

    return {
        "id": rng.choice(("s1", "s2", "bad id", 5)),
        "name": rng.choice(_TEXT),
        "hidden": rng.random() < 0.3,
        "cells": {rng.choice(_KEYS): _random_bag(rng, 1, ("v", "f", "s", "n")) for _ in range(rng.randrange(6))},
        "filter": {
            "ref": rng.choice(("A1:C9", "C9:A1", "nope")),
            "criteria": {
                rng.choice(("A", "b", "C", "1")): {"condition": _random_bag(rng, 2, ("op", "value", "value2"))}
                for _ in range(rng.randrange(3))
            },
        },
        "tables": objects(name=("T", "t", "R1C1", " Pad "), ref=("A1:B4", "A1:B1")),
        "charts": objects(id=("c1", "c2"), type=("bar", "radar"), source=_TEXT, at=_KEYS),
        "pivots": objects(id=("p",), source=_TEXT, at=_KEYS),
        "conditional": objects(id=("r1", "bad id"), ref=("A1:B4", "nope"), type=("cell", "text", "formula", "top", "scale")),
        "validations": objects(id=("v1",), ref=("A1:B4",), kind=("list", "whole", "time"), source=_TEXT),
        "merges": [rng.choice(_TEXT) for _ in range(rng.randrange(4))],
    }


def test_canonical_form_is_a_fixed_point_for_random_workbooks() -> None:
    rng = random.Random(20261029)
    accepted = 0
    for _ in range(300):
        workbook = {
            "sheets": [_random_sheet(rng) for _ in range(1 + rng.randrange(3))],
            "names": [{"name": rng.choice(("Rate", "rate", "A1")), "ref": rng.choice(_TEXT)} for _ in range(rng.randrange(3))],
        }
        canonical = canonicalize_sheet_json(json.dumps(workbook))
        assert canonicalize_sheet_json(canonical) == canonical
        accepted += 1
    assert accepted == 300
