"""AI chat names arrive as model text; a model that ignores "no markdown"
must not leave Markdown syntax in the name shown across the workspace."""

import pytest

from app.routes.chat import _clean_ai_title


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("## Engagement summary\n\nHere is a synthetic reply.", "Engagement summary"),
        ("# Q3 Budget Review", "Q3 Budget Review"),
        ("**Vendor NDA Checklist**", "Vendor NDA Checklist"),
        ("__Vendor NDA Checklist__", "Vendor NDA Checklist"),
        ("*Matter intake plan*", "Matter intake plan"),
        ("Title: Vendor NDA Checklist", "Vendor NDA Checklist"),
        ("**Title:** Vendor NDA Checklist", "Vendor NDA Checklist"),
        ("- Matter intake plan", "Matter intake plan"),
        ("> ## Contract renewal notes", "Contract renewal notes"),
        ("`Q3` budget review", "Q3 budget review"),
        ("[Vendor NDA](https://example.test/nda) checklist", "Vendor NDA checklist"),
        (' "Vendor NDA Checklist Drafting." ', "Vendor NDA Checklist Drafting"),
    ],
)
def test_ai_titles_lose_markdown_syntax(raw: str, expected: str) -> None:
    assert _clean_ai_title(raw) == expected


@pytest.mark.parametrize(
    "plain",
    ["C# migration plan", "Issue #42 triage", "Rate * volume model", "snake_case naming rules"],
)
def test_ai_titles_keep_symbols_that_are_not_markdown(plain: str) -> None:
    assert _clean_ai_title(plain) == plain


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("## ", ""), ("-", ""), (">", ""), ("##\nEngagement summary", "Engagement summary")],
)
def test_ai_titles_skip_lines_that_are_only_a_marker(raw: str, expected: str) -> None:
    assert _clean_ai_title(raw) == expected
