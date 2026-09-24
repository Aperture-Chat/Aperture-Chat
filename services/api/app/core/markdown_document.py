"""Markdown to draft-document HTML for server-side draft delivery.

Automations can deliver their result as a new draft. Drafts store sanitized
HTML, and the browser normally converts model Markdown with
``markdownToDocumentHtml`` (apps/web/src/lib/markdown.ts). A scheduled run has
no browser, so this mirrors that converter's block mapping for the common
cases: headings, paragraphs, flat lists, tables, quotes, code, and rules.
The output still passes through ``sanitize_draft_html`` on save.
"""

from __future__ import annotations

import html
import re

_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
_ORDERED = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_RULE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_FENCE = re.compile(r"^\s*(`{3,}|~{3,})\s*([^`]*)$")
_TABLE_DIVIDER = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")
_INLINE_CODE = re.compile(r"`([^`]+)`")
_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")
_BOLD = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
_ITALIC = re.compile(r"(?<![*\w])([*_])(?=\S)(.+?)(?<=\S)\1(?![*\w])")
_STRIKE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~")


def _inline(text: str) -> str:
    """Escape, then apply inline Markdown. Code spans are protected first."""
    codes: list[str] = []

    def stash(match: re.Match[str]) -> str:
        codes.append(f"<code>{html.escape(match.group(1), quote=False)}</code>")
        return f"\x00{len(codes) - 1}\x00"

    text = _INLINE_CODE.sub(stash, text)
    text = html.escape(text, quote=False)
    # The text is already entity-escaped, so the URL only needs its quotes
    # escaped for the attribute; escaping again would double-encode "&".
    text = _LINK.sub(
        lambda m: f'<a href="{m.group(2).replace(chr(34), "&quot;")}" '
        f'rel="noopener noreferrer" target="_blank">{m.group(1)}</a>',
        text,
    )
    text = _BOLD.sub(r"<strong>\2</strong>", text)
    text = _ITALIC.sub(r"<em>\2</em>", text)
    text = _STRIKE.sub(r"<del>\1</del>", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], text)


def _table_cells(line: str) -> list[str]:
    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|"):
        stripped = stripped[:-1]
    return [cell.strip() for cell in stripped.split("|")]


def _unwrap_full_fence(source: str) -> str:
    """A reply wrapped entirely in one ```markdown fence is still prose."""
    match = re.fullmatch(r"```([A-Za-z0-9_-]*)\n([\s\S]*)\n```", source.strip())
    if not match or "```" in match.group(2):
        return source
    if match.group(1).lower() in {"", "md", "markdown", "text"}:
        return match.group(2)
    return source


def markdown_to_document_html(source: str) -> str:
    lines = _unwrap_full_fence(source.replace("\r\n", "\n")).split("\n")
    blocks: list[str] = []
    paragraph: list[str] = []
    index = 0

    def flush_paragraph() -> None:
        if paragraph:
            blocks.append("<p>" + "<br>".join(_inline(line) for line in paragraph) + "</p>")
            paragraph.clear()

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
            index += 1
            continue

        fence = _FENCE.match(line)
        if fence:
            flush_paragraph()
            marker = fence.group(1)
            body: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith(marker):
                body.append(lines[index])
                index += 1
            index += 1  # closing fence (or end of input for a truncated reply)
            code = html.escape("\n".join(body), quote=False)
            blocks.append(f'<pre class="document-code-block"><code>{code}</code></pre>')
            continue

        heading = _HEADING.match(stripped)
        if heading:
            flush_paragraph()
            level = len(heading.group(1))
            # Same mapping as the browser: a leading h1/h2 is the title.
            tag = "h1" if not blocks and level <= 2 else "h2" if level <= 3 else "h3"
            blocks.append(f"<{tag}>{_inline(heading.group(2))}</{tag}>")
            index += 1
            continue

        if _RULE.match(stripped):
            flush_paragraph()
            blocks.append('<hr class="document-page-break">')
            index += 1
            continue

        if (
            "|" in stripped
            and index + 1 < len(lines)
            and _TABLE_DIVIDER.match(lines[index + 1])
        ):
            flush_paragraph()
            headers = _table_cells(stripped)
            index += 2
            rows: list[list[str]] = []
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                rows.append(_table_cells(lines[index]))
                index += 1
            head = "".join(f"<th>{_inline(cell)}</th>" for cell in headers)
            body_rows = "".join(
                "<tr>"
                + "".join(
                    f"<td>{_inline(row[i] if i < len(row) else '')}</td>"
                    for i in range(len(headers))
                )
                + "</tr>"
                for row in rows
            )
            blocks.append(
                f'<table class="document-data-table"><thead><tr>{head}</tr></thead>'
                f"<tbody>{body_rows}</tbody></table>"
            )
            continue

        bullet = _BULLET.match(line)
        ordered = _ORDERED.match(line)
        if bullet or ordered:
            flush_paragraph()
            pattern = _ORDERED if ordered else _BULLET
            tag = "ol" if ordered else "ul"
            items: list[str] = []
            while index < len(lines):
                item = pattern.match(lines[index])
                if not item:
                    break
                items.append(f"<li>{_inline(item.group(1))}</li>")
                index += 1
            blocks.append(f"<{tag}>{''.join(items)}</{tag}>")
            continue

        if stripped.startswith(">"):
            flush_paragraph()
            quoted: list[str] = []
            while index < len(lines) and lines[index].strip().startswith(">"):
                quoted.append(_inline(lines[index].strip()[1:].strip()))
                index += 1
            blocks.append("<blockquote>" + "<br>".join(quoted) + "</blockquote>")
            continue

        paragraph.append(stripped)
        index += 1

    flush_paragraph()
    return "".join(blocks) or "<p></p>"
