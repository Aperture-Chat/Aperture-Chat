from urllib.parse import unquote

from app.core.markdown_document import markdown_to_document_html
from app.models.matters import sanitize_draft_html


def test_diagram_fences_become_pending_figures_the_browser_draws() -> None:
    html = markdown_to_document_html(
        "# Report\n\n"
        "```mermaid\nflowchart LR\n  A --> B\n```\n\n"
        "```text\nCore → Vessel → Pump\n```\n\n"
        '```aperture-diagram\n{"rows": [[{"id": "a", "title": "A"}]]}\n```\n\n'
        "```python\nprint('hi')\n```\n\n"
        "```text\nplain notes only\n```\n"
    )
    assert html.count("document-diagram-figure") == 3
    assert 'data-diagram-language="mermaid"' in html
    assert 'data-diagram-language="text"' in html
    assert 'data-diagram-kind="structure"' in html
    assert "<pre class=\"document-code-block\"><code>print('hi')</code></pre>" in html
    assert "<code>plain notes only</code>" in html
    # Sources round-trip exactly through the browser's decodeURIComponent.
    source = html.split('data-diagram-source="', 1)[1].split('"', 1)[0]
    assert unquote(source) == "flowchart LR\n  A --> B"
    # Stored drafts keep the figures verbatim.
    assert sanitize_draft_html(html) == html
