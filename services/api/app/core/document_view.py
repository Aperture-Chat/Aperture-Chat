"""What the document viewer shows for one knowledge document.

Pure functions over indexed chunks: the text fallback with its overlap removed,
and the place a cited passage lives. Nothing here reads a file.

Word files record no pages, so a rendition's page comes from matching the
chunk's text against the text on each page. Extraction and layout disagree about
spacing, line-end hyphens, ligatures, and how numbers are punctuated, so both
sides are reduced to a key of letters and digits first. A chunk's text can also
be interrupted by a running header, so when the whole chunk is not found,
evenly spaced anchors from it vote for a page.
"""

from __future__ import annotations

import math
import re
import unicodedata
from bisect import bisect_right
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from itertools import accumulate

from app.core.document_metadata import PROPERTIES_LOCATOR
from app.models.schemas import (
    KnowledgeChunk,
    KnowledgeDocumentViewSegment,
    KnowledgeDocumentViewTarget,
)

_SLIDE_LOCATOR = re.compile(r"Slide (\d+)")
# Chunks repeat the tail of the one before. Past this, text is not overlap, and
# below it an accidental match (a shared word) would eat real text.
_MAX_OVERLAP_CHARS = 400
_MIN_OVERLAP_CHARS = 12
_SHEET_PREFIX = "Sheet: "
_ANCHOR_COUNT = 9
_ANCHOR_CHARS = 32
# A sheet clips its cells and a header splits a passage, so most of a chunk can
# fail to match. A few long anchors landing together, and none elsewhere, is
# still certain.
_CONFIDENT_ANCHORS = 3
_MAX_OCCURRENCES = 64


def chunk_page(chunk: KnowledgeChunk) -> int | None:
    """The page a chunk records: a page number, or a slide, which is one page."""
    if chunk.page_start is not None:
        return chunk.page_start
    slide = _SLIDE_LOCATOR.fullmatch(chunk.locator or "")
    return int(slide.group(1)) if slide else None


def _body_chunks(chunks: Iterable[KnowledgeChunk]) -> list[KnowledgeChunk]:
    """The document's own text, in reading order, without its properties passage."""
    return sorted(
        (chunk for chunk in chunks if chunk.locator != PROPERTIES_LOCATOR),
        key=lambda chunk: chunk.ordinal,
    )


def _overlap_length(previous: str, following: str) -> int:
    longest = min(len(previous), len(following), _MAX_OVERLAP_CHARS)
    for length in range(longest, _MIN_OVERLAP_CHARS - 1, -1):
        if previous.endswith(following[:length]):
            return length
    return 0


def text_segments(chunks: Iterable[KnowledgeChunk]) -> list[KnowledgeDocumentViewSegment]:
    """Chunks in reading order, each without the overlap it repeats."""
    segments: list[KnowledgeDocumentViewSegment] = []
    previous: KnowledgeChunk | None = None
    for chunk in _body_chunks(chunks):
        repeated = _repeated_prefix(previous, chunk)
        segments.append(
            KnowledgeDocumentViewSegment(
                id=chunk.id,
                page=chunk_page(chunk),
                locator=chunk.locator,
                text=chunk.text[repeated:].lstrip(),
            )
        )
        previous = chunk
    return segments


def _repeated_prefix(previous: KnowledgeChunk | None, chunk: KnowledgeChunk) -> int:
    """Overlap exists only inside one extracted segment, so only where the
    location did not change."""
    if previous is None or previous.locator != chunk.locator:
        return 0
    return _overlap_length(previous.text, chunk.text)


def match_key(text: str) -> str:
    """Text reduced to what extraction and layout agree on."""
    folded = unicodedata.normalize("NFKC", text).casefold()
    return "".join(character for character in folded if character.isalnum())


@dataclass(frozen=True, slots=True)
class PageSpan:
    page: int | None
    page_end: int | None
    exact: bool


_NOWHERE = PageSpan(None, None, False)


class _PageCorpus:
    """Every page's key run together, so a passage can cross a page break."""

    def __init__(self, pages: Sequence[str]) -> None:
        self.text = "".join(pages)
        self._ends = list(accumulate(len(page) for page in pages))

    def page_at(self, offset: int) -> int:
        return bisect_right(self._ends, offset) + 1

    def occurrences(self, needle: str) -> list[int]:
        found: list[int] = []
        start = self.text.find(needle)
        while start != -1 and len(found) < _MAX_OCCURRENCES:
            found.append(start)
            start = self.text.find(needle, start + 1)
        return found


def _nearest(offsets: list[int], expected: float) -> int:
    return min(offsets, key=lambda offset: abs(offset - expected))


def _anchors(needle: str) -> list[str]:
    if len(needle) <= _ANCHOR_CHARS:
        return []
    step = (len(needle) - _ANCHOR_CHARS) / (_ANCHOR_COUNT - 1)
    starts = (round(index * step) for index in range(_ANCHOR_COUNT))
    return list(dict.fromkeys(needle[start : start + _ANCHOR_CHARS] for start in starts))


def _from_anchors(needle: str, corpus: _PageCorpus, expected: float) -> PageSpan | None:
    anchors = _anchors(needle)
    votes: Counter[int] = Counter()
    for anchor in anchors:
        found = corpus.occurrences(anchor)
        if found:
            votes[corpus.page_at(_nearest(found, expected))] += 1
    if not votes:
        return None
    first = last = votes.most_common(1)[0][0]
    while first - 1 in votes:
        first -= 1
    while last + 1 in votes:
        last += 1
    agreeing = sum(votes[page] for page in range(first, last + 1))
    return PageSpan(first, last, agreeing >= _CONFIDENT_ANCHORS and agreeing == votes.total())


def _guessed_page(position: float, page_count: int) -> PageSpan:
    page = max(1, min(page_count, math.ceil(position * page_count)))
    return PageSpan(page, page, False)


def find_passage(text: str, pages: Sequence[str], position: float) -> PageSpan:
    """The page or pages ``text`` is on, given each page's ``match_key``.

    ``position`` is how far through the document the passage should be, from 0
    to 1. It picks between repeated copies, and it is the guess when nothing
    matches. ``exact`` is False whenever the answer could be wrong.
    """
    needle = match_key(text)
    if not needle or not pages:
        return _NOWHERE
    corpus = _PageCorpus(pages)
    expected = position * len(corpus.text)
    whole = corpus.occurrences(needle)
    if whole:
        start = _nearest(whole, expected)
        pages_found = {corpus.page_at(offset) for offset in whole}
        return PageSpan(
            corpus.page_at(start), corpus.page_at(start + len(needle) - 1), len(pages_found) == 1
        )
    return _from_anchors(needle, corpus, expected) or _guessed_page(position, len(pages))


def _position(chunk: KnowledgeChunk, ordered: list[KnowledgeChunk]) -> float:
    index = [item.id for item in ordered].index(chunk.id)
    return index / max(1, len(ordered) - 1)


def _find_on_sheet(
    chunk: KnowledgeChunk, body: list[KnowledgeChunk], pages: Sequence[str]
) -> PageSpan | None:
    """A rendition prints each sheet's name on its pages, so a ``Sheet: name``
    passage only has to be searched for there."""
    name = match_key((chunk.locator or "").removeprefix(_SHEET_PREFIX))
    numbers = [number for number, page in enumerate(pages, start=1) if page.startswith(name)]
    if not name or not numbers:
        return None
    siblings = [item for item in body if item.locator == chunk.locator]
    span = find_passage(chunk.text, [pages[number - 1] for number in numbers], _position(chunk, siblings))
    if span.page is None or span.page_end is None:
        return PageSpan(numbers[0], numbers[0], False)
    return PageSpan(numbers[span.page - 1], numbers[span.page_end - 1], span.exact)


def locate_passage(
    chunk: KnowledgeChunk,
    chunks: Iterable[KnowledgeChunk],
    load_pages: Callable[[], Sequence[str]],
) -> PageSpan:
    """Where a chunk is in a PDF. The page ingestion recorded wins; otherwise
    the text is searched for, on pages loaded only when that is needed."""
    if chunk.locator == PROPERTIES_LOCATOR:
        return _NOWHERE
    recorded = chunk_page(chunk)
    if recorded is not None:
        return PageSpan(recorded, chunk.page_end or recorded, True)
    pages = load_pages()
    body = _body_chunks(chunks)
    if (chunk.locator or "").startswith(_SHEET_PREFIX):
        on_sheet = _find_on_sheet(chunk, body, pages)
        if on_sheet is not None:
            return on_sheet
    return find_passage(chunk.text, pages, _position(chunk, body))


def target_for(chunk: KnowledgeChunk, span: PageSpan) -> KnowledgeDocumentViewTarget:
    label = chunk.locator or (f"Page {span.page}" if span.page is not None else None)
    return KnowledgeDocumentViewTarget(
        page=span.page,
        page_end=span.page_end,
        locator=label,
        excerpt=chunk.text,
        chunk_id=chunk.id,
        exact=span.exact,
    )


def recorded_span(chunk: KnowledgeChunk) -> PageSpan:
    """The location ingestion recorded. A chunk with none is still exact in a
    text view, where the passage is found by its id rather than by page."""
    page = chunk_page(chunk)
    return PageSpan(page, chunk.page_end or page, True)
