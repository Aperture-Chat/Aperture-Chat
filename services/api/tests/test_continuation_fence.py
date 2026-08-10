"""A reply that stops with an open code fence is not finished, whatever the
provider's finish reason claims — the continuation loop must treat it like a
length stop (bounded by MAX_CONTINUATION_CALLS)."""

from app.routes.chat import _ends_inside_code_fence


def test_open_fence_detected() -> None:
    truncated = 'Intro prose.\n\n```steward-diagram\n{"rows": [[{"id": "a", "title": "Box'
    assert _ends_inside_code_fence(truncated) is True


def test_closed_fences_and_plain_text_do_not_trigger() -> None:
    assert _ends_inside_code_fence("no fences at all") is False
    assert _ends_inside_code_fence("```mermaid\nflowchart LR\n  A --> B\n```\ndone") is False
    assert (
        _ends_inside_code_fence("```json\n{}\n```\nmiddle\n```python\nprint()\n```")
        is False
    )


def test_indented_fence_lines_count() -> None:
    assert _ends_inside_code_fence("text\n   ```python\ncode") is True
