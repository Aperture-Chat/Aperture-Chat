"""Which of a turn's sources a finished reply actually used.

Retrieval hands the model several excerpts per turn whether or not they bear on
the question, so "retrieved" never means "used". The prompt numbers each source
and the reply says what it used through those numbers: ``[K#]`` for knowledge
excerpts, ``[W#]`` for platform web results, ``[U#]`` for URLs fetched for the
turn. This module is the one place that reads those markers.

Knowledge fails closed: an excerpt the reply does not cite is never listed, and
a reply with no markers lists none. Web results stay listed as consulted until
the reply cites one, then only the cited ones remain. URLs the person asked to
read stay, marked by whether the reply cited them. Attachments and MCP results
have no marker, so they stay and claim nothing. Numbers are per turn and only
mean something against the citations of that same turn.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from itertools import islice
from typing import Any, get_args

from app.core.citation_passage import SENTENCE_GAP, best_passage
from app.models.schemas import ChatCitation

# No two whitespace runs may touch: a model reply is untrusted text, and adjacent
# whitespace quantifiers turn "[K1" plus a long run of spaces into polynomial
# backtracking.
_LABEL = "[KWUＫＷＵКΚ]"
_FOLD_LABELS = str.maketrans({"Ｋ": "K", "К": "K", "Κ": "K", "Ｗ": "W", "Ｕ": "U"})
_RANGE_JOIN = r"(?:\s*[-–—〜～]\s*|\s+to\s+)"
_ENTRY = rf"{_LABEL}\s*\d{{1,6}}(?:{_RANGE_JOIN}(?:{_LABEL}\s*)?\d{{1,6}})?"
_WORD_JOIN = "(?:and|y|et|und|и)"
_SEPARATOR = rf"(?:\s*[,;/&，；、،]\s*(?:{_WORD_JOIN}\s+)?|\s+{_WORD_JOIN}\s+|\s*和\s*|\s+)"
_PREFIX = r"(?:(?i:sources?|refs?\.?|references?)(?:\s*:\s*|\s+))?"
_BODY = r"[^\[\]［］【】\n]"
# A page word needs its page or sheet after it, so "[K1 sheet]" stays prose.
_PAGE_WORD = r"(?i:pp?\.|pg\.|s\.|pages?\b|slides?\b|sheets?\b|seiten?\b|p[áa]ginas?\b)"
_PAGE = rf"(?:{_PAGE_WORD}\s*(?::\s*)?(?=[\dA-ZÀ-ÖØ-ÞА-Я])|第){_BODY}{{0,60}}"
_FILE_NAME = rf"{_BODY}{{1,80}}?\.(?i:pdf|docx?|pptx?|xlsx?|csv|txt|md|rtf|odt|html?)\b{_BODY}{{0,60}}"
_PUNCTUATED = r"\s*[,;:]\s*|\s*[(（]\s*"
# A file name needs punctuation before it, so "[K1 statement.pdf]" stays prose.
_LOCATOR = rf"(?:(?:{_PUNCTUATED}|\s*[-–—]\s*|\s+){_PAGE}|(?:{_PUNCTUATED}){_FILE_NAME})?"
# The whole bracket must read as markers, plus an optional page, slide, or file
# name, so "[W2 form instructions]" and "[K1 statement]" stay prose. Those are
# tax forms. Full-width brackets matter: the same model that writes "[K1]" here
# writes "【K1】" in or after CJK context.
_MARKER_GROUP = (
    rf"\\?[\[［【]\^?\s*{_PREFIX}({_ENTRY}(?:{_SEPARATOR}{_ENTRY})*){_LOCATOR}"
    r"\s*(?:[.,;]\s*)?\\?[\]］】]"
)
_MARKER = re.compile(_MARKER_GROUP)
_MARKER_ENTRY = re.compile(rf"([KWU])\s*(\d+)(?:{_RANGE_JOIN}(?:\1\s*)?(\d+))?")
# A marker with its leading space and any link target: "See [K1](https://x)".
_STALE_MARKER = re.compile(
    rf"(?:(?<![ \t])[ \t]+)?{_MARKER_GROUP}(?:\(https?://[^\s()]*\))?"
)

_THINKING_BLOCK = re.compile(r"\s*<(think|thinking)>.*?</\1>\s*", re.IGNORECASE | re.DOTALL)
_MAX_THINKING_BLOCKS = 8  # assistantThinking.ts hides this many, and no more.
_FENCE = re.compile(r" {0,3}(`{3,}|~{3,})[ \t]*([\w+.-]*)")
# Diagrams are shown as figures, not code, and carry citations in their labels.
_DIAGRAM_FENCES = frozenset({"aperture-diagram", "mermaid"})
# Fences that hold writing rather than code. A marker here does not cite, but a
# model that lifts the text back out of the fence brings the marker with it.
_PROSE_FENCES = frozenset({"", "text", "txt", "plaintext", "markdown", "md"})
_INLINE_CODE = re.compile(r"(?<!`)(`{1,3})(?!`)[^\n]{1,2000}?(?<!`)\1(?!`)")

_CLAIM_LOOKBACK_CHARS = 600
_MAX_CLAIM_MARKERS = 300
_CLAIM_TRAILING = " \t\n.!?。！？:;,|"


def _closes(line: str, fence: str) -> bool:
    stripped = line.strip()
    return len(stripped) >= len(fence) and set(stripped) == set(fence)


def _fenced_parts(text: str) -> Iterator[tuple[str, str | None]]:
    """Split text into (part, fence language), with None for text outside a fence."""
    part: list[str] = []
    fence: str | None = None
    language: str | None = None
    for line in text.splitlines(keepends=True):
        opening = None if fence else _FENCE.match(line)
        if opening:
            yield "".join(part), None
            part, fence, language = [line], opening[1], opening[2].lower()
        elif fence and _closes(line, fence):
            yield "".join([*part, line]), language
            part, fence, language = [], None, None
        else:
            part.append(line)
    yield "".join(part), language


def _inline_parts(prose: str) -> Iterator[tuple[str, bool]]:
    position = 0
    for code in _INLINE_CODE.finditer(prose):
        yield prose[position : code.start()], True
        yield code[0], False
        position = code.end()
    yield prose[position:], True


def _marked_parts(
    text: str, fences: frozenset[str] = _DIAGRAM_FENCES
) -> Iterator[tuple[str, bool]]:
    """Split text into (part, whether markers in it count), reading only ``fences``.

    Code does not count: ``weights = [K1, K2]`` is a list, and rewriting it would
    hand a follow-up a damaged copy of the code it asks about.
    """
    for part, language in _fenced_parts(text):
        if language is None:
            yield from _inline_parts(part)
        else:
            yield part, language in fences


def _visible_reply(answer: str) -> str:
    """The reply without leading thinking blocks, which the client hides.

    A reasoning model discusses by number why an excerpt is irrelevant. As in
    the client, an unclosed block is ordinary text.
    """
    for _block in range(_MAX_THINKING_BLOCKS):
        thinking = _THINKING_BLOCK.match(answer)
        if thinking is None:
            break
        answer = answer[thinking.end() :]
    return answer


def _citing_groups(answer: str) -> Iterator[tuple[str, re.Match[str]]]:
    for part, can_cite in _marked_parts(_visible_reply(answer)):
        if can_cite:
            for group in _MARKER.finditer(part):
                yield part, group


def _group_spans(group: re.Match[str]) -> Iterator[tuple[str, int, int]]:
    for entry in _MARKER_ENTRY.finditer(group[1].translate(_FOLD_LABELS)):
        first, last = int(entry[2]), int(entry[3] or entry[2])
        yield entry[1], min(first, last), max(first, last)


def marker_spans(answer: str, label: str) -> list[tuple[int, int]]:
    """Every ``label`` number range the answer cites, in order of appearance.

    A lone marker is a one-number range. Ranges stay as bounds so a hallucinated
    ``[K1-K999999]`` costs nothing.
    """
    return [
        (first, last)
        for _part, group in _citing_groups(answer)
        for entry_label, first, last in _group_spans(group)
        if entry_label == label
    ]


def cited_numbers(answer: str, label: str, known: Iterable[int | None]) -> set[int]:
    """The numbers in ``known`` the answer cites. Any other number does not exist."""
    spans = marker_spans(answer, label)
    return {
        number
        for number in known
        if number is not None and any(first <= number <= last for first, last in spans)
    }


def _claim_before(part: str, marker_start: int) -> str:
    """The sentence a marker closes, wherever the marker sits against its period."""
    fragment = part[max(0, marker_start - _CLAIM_LOOKBACK_CHARS) : marker_start]
    fragment = _STALE_MARKER.sub("", fragment).rstrip(_CLAIM_TRAILING)
    return SENTENCE_GAP.split(fragment)[-1]


def _knowledge_claims(answer: str, numbers: Iterable[int]) -> dict[int, list[str]]:
    """The reply sentences carrying each knowledge number's marker."""
    claims: dict[int, list[str]] = {number: [] for number in numbers}
    for part, group in islice(_citing_groups(answer), _MAX_CLAIM_MARKERS):
        claim = _claim_before(part, group.start())
        for label, first, last in _group_spans(group):
            for number in claims:
                if label == "K" and first <= number <= last:
                    claims[number].append(claim)
    return claims


def _with_cited(citation: ChatCitation, cited: bool, passage: str | None = None) -> ChatCitation:
    return citation.model_copy(update={"cited": cited, "passage": passage})


def _knowledge_row(
    citation: ChatCitation, claims: Mapping[int, Sequence[str]], texts: Mapping[str, str]
) -> ChatCitation | None:
    number = citation.k_index
    if number not in claims:
        return None
    chunk = texts.get(citation.chunk_id or "", "")
    return _with_cited(citation, True, best_passage(chunk, claims[number]))


def _web_row(citation: ChatCitation, web: set[int], drop_uncited: bool) -> ChatCitation | None:
    if citation.w_index in web:
        return _with_cited(citation, True)
    return None if drop_uncited else _with_cited(citation, False)


def citations_used(
    answer: str,
    citations: Sequence[ChatCitation],
    *,
    keep_consulted_web: bool = False,
    chunk_texts: Mapping[str, str] | None = None,
) -> list[ChatCitation]:
    """The citations to show for ``answer``, each saying whether it was cited.

    ``keep_consulted_web`` keeps uncited web results listed even when the reply
    cites some, which is what a Drafts document's source list expects.
    ``chunk_texts`` holds this turn's chunk text by id, to find each ``passage``.
    """
    knowledge = cited_numbers(answer, "K", (citation.k_index for citation in citations))
    web = cited_numbers(answer, "W", (citation.w_index for citation in citations))
    fetched = cited_numbers(answer, "U", (citation.u_index for citation in citations))
    drop_uncited_web = bool(web) and not keep_consulted_web
    claims = _knowledge_claims(answer, knowledge)
    texts = chunk_texts or {}

    rows: list[ChatCitation | None] = []
    for citation in citations:
        if citation.k_index is not None:
            rows.append(_knowledge_row(citation, claims, texts))
        elif citation.u_index is not None:
            cited = citation.u_index in fetched or citation.w_index in web
            rows.append(_with_cited(citation, cited))
        elif citation.w_index is not None:
            rows.append(_web_row(citation, web, drop_uncited_web))
        else:
            rows.append(citation)
    return [row for row in rows if row is not None]


def strip_citation_markers(text: str) -> str:
    """``text`` without the markers of the turn that wrote it.

    Numbers are per turn, so a marker left in an earlier reply would point at a
    different source if the model repeated it now. Uses the same grammar as
    detection, and also reads fences that hold prose, because a model can lift
    that text back out. Language-tagged fences and inline code are left whole, so
    a marker a model copies out of real code can still reach a later turn.
    """
    return "".join(
        _STALE_MARKER.sub("", part) if counts else part
        for part, counts in _marked_parts(text, _DIAGRAM_FENCES | _PROSE_FENCES)
    )


def _is_text_field(annotation: object) -> bool:
    return annotation is str or str in get_args(annotation)


# Screened by default, so a text field added later cannot slip through. Only
# identifiers the server minted stay out: they hold no source text, and the
# viewer needs them to open the document.
_CITATION_IDENTIFIERS = frozenset(
    {"id", "source_type", "chunk_id", "document_id", "knowledge_config_id"}
)
CITATION_TEXT_FIELDS = tuple(
    name
    for name, field in ChatCitation.model_fields.items()
    if _is_text_field(field.annotation) and name not in _CITATION_IDENTIFIERS
)


def _address_without_the_value(citation: Mapping[str, Any]) -> str:
    """An address holding no name. Knowledge rows open by id, so they lose nothing."""
    config_id, document_id = citation.get("knowledge_config_id"), citation.get("document_id")
    if config_id and document_id:
        return f"knowledge://{config_id}/{document_id}"
    return f"withheld://{citation.get('id')}"


def screened_fields(citation: Mapping[str, Any], screen: Callable[[str], str]) -> dict[str, Any]:
    """The citation fields ``screen`` changes, ready to apply, on every path.

    A passage must stay verbatim and an address must still resolve, so neither
    can be rewritten in place: a passage goes, and an address is replaced.
    """
    changed: dict[str, Any] = {}
    for name in CITATION_TEXT_FIELDS:
        value = citation.get(name)
        screened = screen(value) if isinstance(value, str) else value
        if screened != value:
            changed[name] = screened
    if "passage" in changed:
        changed["passage"] = None
    if "source_uri" in changed:
        changed["source_uri"] = _address_without_the_value(citation)
    return changed
