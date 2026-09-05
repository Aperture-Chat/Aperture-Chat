"""Explicit-requirement tracking for a chat turn.

Models routinely drop a requirement buried in a long request -- "include
images" is the classic one. This module makes those requirements first-class:

1. :func:`extract_directives` reads the user's message (plus their standing
   memory directives) and produces a small checklist.
2. :func:`directive_prompt_block` renders that checklist at the very end of the
   system prompt, where instruction adherence is strongest.
3. :func:`directive_issues` checks the finished answer against the checklist so
   the caller can trigger a bounded revision when something was measurably
   missed.

Only mechanically verifiable requirements can trigger a revision. Asks about
tone or audience are injected into the prompt but never re-run the model, since
a false "you missed this" is worse than a soft miss.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

TARGET_WORDS_PER_REQUESTED_PAGE = 350
MIN_LONG_FORM_WORDS = 1200
# Below this the "outline instead of the deliverable" heuristic is unreliable.
OUTLINE_GUARD_WORD_CEILING = 2500
MAX_DIRECTIVES = 8


@dataclass(frozen=True)
class Directive:
    """One requirement the answer has to satisfy."""

    id: str
    label: str
    instruction: str
    # Standing directives come from memory rather than this turn's message.
    standing: bool = False
    amount: int | None = None

    @property
    def verifiable(self) -> bool:
        return self.id.split(":", 1)[0] in _VERIFIERS


def extract_directives(prompt: str, standing_instructions: list[str] | None = None) -> list[Directive]:
    """Build this turn's requirement checklist."""
    text = str(prompt or "")
    directives: list[Directive] = []
    seen: set[str] = set()

    def add(directive: Directive) -> None:
        if directive.id in seen:
            return
        seen.add(directive.id)
        directives.append(directive)

    if _image_requested(text):
        add(
            Directive(
                id="images",
                label="Include images or diagrams",
                instruction=(
                    "Include real markdown image blocks in the form ![caption](https://...) "
                    "placed next to the section each one illustrates. If no suitable image "
                    "exists, include a labelled diagram instead of silently omitting it."
                ),
            )
        )
    if _table_requested(text):
        add(
            Directive(
                id="table",
                label="Include a markdown table",
                instruction="Present the comparison as a real markdown table with a header row.",
            )
        )
    if _code_requested(text):
        add(
            Directive(
                id="code",
                label="Include a code block",
                instruction="Include the code inside a fenced code block with a language tag.",
            )
        )
    if _citations_requested(text):
        add(
            Directive(
                id="citations",
                label="Cite sources",
                instruction="Cite each claim with a source link or the bracketed source label it came from.",
            )
        )
    if _json_only_requested(text):
        add(
            Directive(
                id="json",
                label="Return JSON only",
                instruction="Return only valid JSON. No prose before or after it.",
            )
        )
    elif _bullets_requested(text):
        add(
            Directive(
                id="bullets",
                label="Use bullet points",
                instruction="Structure the answer as bullet points.",
            )
        )
    if _numbered_requested(text):
        add(
            Directive(
                id="numbered",
                label="Use a numbered list",
                instruction="Structure the answer as a numbered list.",
            )
        )

    requested_items = _requested_item_count(text)
    if requested_items:
        add(
            Directive(
                id=f"count:{requested_items}",
                label=f"Provide {requested_items} items",
                instruction=f"Provide exactly {requested_items} distinct items, each on its own list line.",
                amount=requested_items,
            )
        )

    requested_pages = _requested_page_count(text)
    if requested_pages:
        add(
            Directive(
                id=f"pages:{requested_pages}",
                label=f"Write {requested_pages} pages of content",
                instruction=(
                    f"Write the full {requested_pages}-page deliverable, roughly "
                    f"{requested_pages * TARGET_WORDS_PER_REQUESTED_PAGE} words of drafted body content."
                ),
                amount=requested_pages,
            )
        )
    else:
        requested_words = _requested_word_count(text)
        if requested_words:
            add(
                Directive(
                    id=f"words:{requested_words}",
                    label=f"Write at least {requested_words} words",
                    instruction=f"Write at least {requested_words} words of drafted body content.",
                    amount=requested_words,
                )
            )
        elif _long_form_requested(text):
            add(
                Directive(
                    id="longform",
                    label="Deliver the complete long-form piece",
                    instruction=(
                        "Produce the complete requested deliverable, not an outline or a plan, "
                        "and do not stop to ask whether to continue."
                    ),
                )
            )

    for instruction in standing_instructions or []:
        cleaned = " ".join(str(instruction or "").split())
        if not cleaned:
            continue
        add(
            Directive(
                id=f"standing:{len(directives)}",
                label=cleaned,
                instruction=cleaned,
                standing=True,
            )
        )

    return directives[:MAX_DIRECTIVES]


def extract_draft_directives(prompt: str, standing_instructions: list[str] | None = None) -> list[Directive]:
    # Deck output is validated against its JSON contract in the deck pipeline.
    # The editor adds artwork afterward; prose/image verifiers are inapplicable.
    if prompt.startswith(("You are a presentation writer producing a slide deck", "You are revising an existing slide deck")):
        return []
    match = re.search(r"\AUser request: (.*?)\n\nDraft type:", prompt, re.DOTALL)
    return extract_directives(match.group(1) if match else prompt, standing_instructions)


def directive_prompt_block(directives: list[Directive]) -> str:
    """Render the checklist for the tail of the system prompt."""
    if not directives:
        return ""
    lines = [
        "Requirements for this reply. Every one of these must be satisfied before you finish:",
    ]
    for index, directive in enumerate(directives, start=1):
        suffix = " (standing preference for this user)" if directive.standing else ""
        lines.append(f"{index}. {directive.instruction}{suffix}")
    lines.append(
        "Re-read this list before sending. If a requirement cannot be met, say so explicitly "
        "rather than quietly omitting it."
    )
    return "\n".join(lines)


def directive_issues(directives: list[Directive], text: str) -> list[str]:
    """Describe the verifiable requirements the answer failed to satisfy."""
    issues: list[str] = []
    for directive in directives:
        verifier = _VERIFIERS.get(directive.id.split(":", 1)[0])
        if verifier is None:
            continue
        issue = verifier(directive, text)
        if issue:
            issues.append(issue)
    return issues


def directive_results(directives: list[Directive], text: str) -> list[tuple[str, str, bool]]:
    """(id, label, satisfied) for each directive, for reporting to the client."""
    results: list[tuple[str, str, bool]] = []
    for directive in directives:
        verifier = _VERIFIERS.get(directive.id.split(":", 1)[0])
        satisfied = True if verifier is None else not verifier(directive, text)
        results.append((directive.id, directive.label, satisfied))
    return results


# --- verifiers -------------------------------------------------------------


def _verify_images(directive: Directive, text: str) -> str | None:
    if _contains_markdown_image(text) or _contains_diagram(text):
        return None
    return (
        "The user asked for images or diagrams, but the answer contains no markdown image "
        "block and no diagram."
    )


def _verify_table(directive: Directive, text: str) -> str | None:
    if re.search(r"^\s*\|.*\|\s*$", text, flags=re.MULTILINE) and re.search(
        r"^\s*\|[\s:|-]+\|\s*$", text, flags=re.MULTILINE
    ):
        return None
    return "The user asked for a table, but the answer contains no markdown table."


def _verify_code(directive: Directive, text: str) -> str | None:
    if "```" in text:
        return None
    return "The user asked for code, but the answer contains no fenced code block."


def _verify_citations(directive: Directive, text: str) -> str | None:
    if re.search(r"https?://\S+", text) or re.search(r"\[[KWM]\d+\]", text) or "](" in text:
        return None
    # Academic citations need not be hyperlinks. Require both a bibliography
    # with entries and an author/title parenthetical, not just its heading.
    if re.search(r"(?im)^\s*#{0,3}\s*(?:Works Cited|References)\s*\n+\S.{20,}", text) and re.search(
        r"\([A-Z][^()\n]{2,120}\)", text
    ):
        return None
    return "The user asked for sources, but the answer cites none."


def _verify_json(directive: Directive, text: str) -> str | None:
    stripped = text.strip()
    stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", stripped).strip()
    if stripped.startswith(("{", "[")) and stripped.endswith(("}", "]")):
        return None
    return "The user asked for JSON only, but the answer contains surrounding prose."


def _verify_bullets(directive: Directive, text: str) -> str | None:
    if len(re.findall(r"^\s{0,4}[-*•]\s+\S", text, flags=re.MULTILINE)) >= 2:
        return None
    return "The user asked for bullet points, but the answer is not bulleted."


def _verify_numbered(directive: Directive, text: str) -> str | None:
    if len(re.findall(r"^\s{0,4}\d+[.)]\s+\S", text, flags=re.MULTILINE)) >= 2:
        return None
    return "The user asked for a numbered list, but the answer is not numbered."


def _verify_count(directive: Directive, text: str) -> str | None:
    expected = directive.amount or 0
    if expected <= 0:
        return None
    found = len(re.findall(r"^\s{0,4}(?:[-*•]|\d+[.)])\s+\S", text, flags=re.MULTILINE))
    found = max(found, len(re.findall(r"^\s{0,4}#{2,6}\s+\S", text, flags=re.MULTILINE)))
    if found >= expected:
        return None
    return (
        f"The user asked for {expected} items; the answer contains about {found}. "
        "Provide the full count."
    )


def _verify_pages(directive: Directive, text: str) -> str | None:
    pages = directive.amount or 0
    target_words = pages * TARGET_WORDS_PER_REQUESTED_PAGE
    words = word_count(text)
    issues: list[str] = []
    if words < target_words:
        issues.append(
            f"The user requested {pages} pages; the current answer has about {words} words "
            "and needs materially more drafted body content."
        )
    if _looks_like_outline_only(text):
        issues.append(
            "The current answer appears to be an outline or plan rather than the actual drafted deliverable."
        )
    return " ".join(issues) if issues else None


def _verify_words(directive: Directive, text: str) -> str | None:
    target = directive.amount or 0
    words = word_count(text)
    if words >= target:
        return None
    return (
        f"The user asked for at least {target} words; the current answer has about {words}."
    )


def _verify_longform(directive: Directive, text: str) -> str | None:
    words = word_count(text)
    issues: list[str] = []
    if words < MIN_LONG_FORM_WORDS:
        issues.append(
            "The user requested a complete long-form deliverable; the current answer has "
            f"about {words} words and reads too short."
        )
    if _looks_like_outline_only(text):
        issues.append(
            "The current answer appears to be an outline or plan rather than the actual drafted deliverable."
        )
    return " ".join(issues) if issues else None


_VERIFIERS = {
    "images": _verify_images,
    "table": _verify_table,
    "code": _verify_code,
    "citations": _verify_citations,
    "json": _verify_json,
    "bullets": _verify_bullets,
    "numbered": _verify_numbered,
    "count": _verify_count,
    "pages": _verify_pages,
    "words": _verify_words,
    "longform": _verify_longform,
}


# --- request detection -----------------------------------------------------


def _image_requested(prompt: str) -> bool:
    return bool(
        re.search(
            r"\b(images?|pictures?|photos?|graphics?|visuals?|charts?|diagrams?)\b",
            prompt,
            flags=re.IGNORECASE,
        )
    )


def _table_requested(prompt: str) -> bool:
    return bool(re.search(r"\b(tables?|tabular|side[-\s]by[-\s]side|matrix)\b", prompt, flags=re.IGNORECASE))


def _code_requested(prompt: str) -> bool:
    return bool(
        re.search(
            r"\b(code|snippet|script|function|implementation|pseudo[-\s]?code)\b",
            prompt,
            flags=re.IGNORECASE,
        )
    )


def _citations_requested(prompt: str) -> bool:
    prompt = re.sub(r"\b(?:do not|don't|never)\s+(?:invent|fabricate|make up)\s+(?:citations?|sources?|references?)\b", "", prompt, flags=re.IGNORECASE)
    return bool(
        re.search(r"\b(cite|citations?|sources?|references?|footnotes?)\b", prompt, flags=re.IGNORECASE)
    )


def _json_only_requested(prompt: str) -> bool:
    return bool(re.search(r"\b(json\s+only|only\s+json|as\s+raw\s+json|valid\s+json)\b", prompt, flags=re.IGNORECASE))


def _bullets_requested(prompt: str) -> bool:
    return bool(re.search(r"\b(bullets?|bullet\s+points?|bulleted)\b", prompt, flags=re.IGNORECASE))


def _numbered_requested(prompt: str) -> bool:
    return bool(re.search(r"\b(numbered\s+list|numbered|enumerate)\b", prompt, flags=re.IGNORECASE))


def _requested_item_count(prompt: str) -> int | None:
    match = re.search(
        r"\b(\d{1,2})\s+(?:distinct\s+|different\s+|separate\s+)?"
        r"(examples?|ideas?|options?|bullets?|items?|points?|reasons?|steps?|questions?|recommendations?|strategies?|ways?)\b",
        prompt,
        flags=re.IGNORECASE,
    )
    if not match:
        return None
    count = int(match.group(1))
    return count if 2 <= count <= 50 else None


def _requested_page_count(prompt: str) -> int | None:
    numeric = re.search(r"\b(\d{1,3})\s*[- ]?\s*pages?\b", prompt, flags=re.IGNORECASE)
    if numeric:
        return int(numeric.group(1))
    if re.search(r"\btwenty[- ]five\s+pages?\b", prompt, flags=re.IGNORECASE):
        return 25
    return None


def _requested_word_count(prompt: str) -> int | None:
    match = re.search(r"\b(?:at\s+least\s+)?(\d{2,6})\s*[- ]?\s*words?\b", prompt, flags=re.IGNORECASE)
    if not match:
        return None
    count = int(match.group(1))
    return count if count >= 50 else None


def _long_form_requested(prompt: str) -> bool:
    return bool(
        re.search(
            r"\b(long[-\s]?form|paper|report|memo|brief|draft|pages?|comprehensive|complete)\b",
            prompt,
            flags=re.IGNORECASE,
        )
    )


# --- response inspection ---------------------------------------------------


def word_count(text: str) -> int:
    return len(re.findall(r"\b[\w'-]+\b", text))


def _contains_markdown_image(text: str) -> bool:
    return bool(re.search(r"!\[[^\]]*]\(https?://[^)\s]+", text))


def _contains_diagram(text: str) -> bool:
    """A block counts only when the client can actually render it visually.

    In particular, a generic research-summary JSON fence is visualizable by
    the card renderer, while a malformed block merely labelled
    ``aperture-diagram`` is not allowed to satisfy the directive and trigger a
    raw-code failure in the UI.
    """
    for match in re.finditer(r"```\s*([^\s`]*)[^\n]*\n(.*?)```", text, flags=re.S):
        language = (match.group(1) or "").strip().lower()
        body = (match.group(2) or "").strip()
        if not body:
            continue
        if language in {"mermaid", "mmd", "mermaidjs", "mermaid-js", "graphviz", "dot", "gv", "plantuml", "puml", "uml"}:
            return True
        if language in {
            "aperture-diagram",
            "aperture_diagram",
            "aperturediagram",
            "steward-diagram",
            "steward_diagram",
            "stewarddiagram",
        } and _valid_card_diagram_json(body):
            return True
        if language in {"json", "json5", "", "text", "txt", "plain", "plaintext"} and _visual_summary_json(body):
            return True
    # ASCII/box-drawing art inside a fenced block.
    for block in re.findall(r"```[^\n]*\n(.*?)```", text, flags=re.S):
        if len(re.findall(r"[|+─│┌└├→<>^v]", block)) >= 8:
            return True
    return False


def _json_object(text: str) -> dict[str, object] | None:
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _valid_card_diagram_json(text: str) -> bool:
    value = _json_object(text)
    rows = value.get("rows") if value else None
    if not isinstance(rows, list):
        return False
    for row in rows:
        cards = row if isinstance(row, list) else row.get("cards") if isinstance(row, dict) else None
        if not isinstance(cards, list):
            continue
        if any(
            isinstance(card, dict)
            and isinstance(card.get("id"), str)
            and bool(card["id"].strip())
            and isinstance(card.get("title"), str)
            and bool(card["title"].strip())
            for card in cards
        ):
            return True
    return False


def _visual_summary_json(text: str) -> bool:
    value = _json_object(text)
    if not value:
        return False
    collections = 0
    status_scalars = 0
    detail_count = 0
    status_pattern = re.compile(
        r"\b(?:achieved|active|blocked|complete(?:d)?|failed|false|inactive|missing|not|pending|ready|success|true|unavailable|yes|no)\b",
        flags=re.IGNORECASE,
    )
    for key, item in value.items():
        if str(key).lower() in {"title", "subtitle", "tag", "footnote"}:
            continue
        if isinstance(item, (str, int, float, bool)):
            detail_count += 1
            if status_pattern.search(str(item)):
                status_scalars += 1
            continue
        if isinstance(item, list) and item and all(isinstance(entry, (str, int, float, bool)) for entry in item):
            collections += 1
            detail_count += len(item)
    return detail_count >= 4 and (collections >= 2 or (collections >= 1 and status_scalars >= 1))


def _looks_like_outline_only(text: str) -> bool:
    first_chunk = text[:1800].lower()
    if "outline" in first_chunk and word_count(text) < OUTLINE_GUARD_WORD_CEILING:
        return True
    headings = len(re.findall(r"^\s{0,3}(?:#{1,6}\s+|\d+\.\s+|[-*]\s+)", text, flags=re.MULTILINE))
    paragraphs = len([chunk for chunk in re.split(r"\n\s*\n", text) if word_count(chunk) >= 45])
    return headings >= 8 and paragraphs <= 4 and word_count(text) < OUTLINE_GUARD_WORD_CEILING
