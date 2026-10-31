"""The server reads the bracket forms in the shared list exactly as the web client does.

apps/web/src/lib/citationTargets.test.ts runs the same file, so a form added on
one side fails on the other until both agree.
"""

import json
from pathlib import Path

import pytest

from app.core.citation_use import marker_spans

FORMS = json.loads((Path(__file__).parent / "fixtures" / "citation_marker_forms.json").read_text("utf-8"))["forms"]


def cited(bracket: str) -> set[str]:
    return {
        f"{label}{number}"
        for label in "KWU"
        for first, last in marker_spans(f"A claim {bracket}.", label)
        for number in range(first, last + 1)
    }


@pytest.mark.parametrize("form", FORMS, ids=lambda form: form["bracket"])
def test_marker_form(form: dict) -> None:
    assert cited(form["bracket"]) == set(form["markers"])
