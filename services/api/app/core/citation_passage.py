"""Find the words of a chunk that a reply's claim rests on.

The viewer marks this passage strongly and the Sources panel quotes it, so a
wrong one reads as the source contradicting the answer. Word overlap alone
cannot choose: table rows share nearly all their words and differ by one figure.
So the claim's figures and names are required rather than counted, a passage
stops before a neighbouring cell's figure, and anything uncertain returns None,
which leaves the viewer showing the whole chunk. Pure, lexical, and verbatim.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass

from app.core.sparse_vectors import normalize_search_token

MAX_PASSAGE_CHARS = 400
_MAX_WINDOW_SPANS = 3
_MAX_CLAIMS = 5
_MIN_TABLE_LINES = 3

SENTENCE_GAP = re.compile(r"(?<=[。！？])\s*|(?<=[.!?])\s+|\n\s*")
_ROW_GAP = re.compile(r"\n\s*")
_SENTENCE_ENDS = (".", "!", "?", "。", "！", "？")
_LIST_PREFIX = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")
_TERM = re.compile(r"[^\W\d_]+|\d+")
_WORD = re.compile(r"[^\W_]+")
_CODE = re.compile(r"(?=.*\d)(?=.*[^\W\d_]).+")

_NUMBER_WORDS = {
    word: str(number)
    for number, word in enumerate(
        "one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
        "fifteen sixteen seventeen eighteen nineteen twenty".split(),
        start=1,
    )
} | {"thirty": "30", "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70", "eighty": "80", "ninety": "90"}
# "First" and "second" are ordinary words far more often than they are figures.
_ORDINALS = {
    word: str(number)
    for number, word in enumerate(
        "third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth "
        "fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth".split(),
        start=3,
    )
} | {
    "thirtieth": "30",
    "fortieth": "40",
    "fiftieth": "50",
    "sixtieth": "60",
    "seventieth": "70",
    "eightieth": "80",
    "ninetieth": "90",
}
_UNIT = r"%|(?i:percent|per cent|days?|weeks?|months?|years?)\b"
# A number word only counts before a unit: "one of the parties" is not a figure.
_VALUE = re.compile(
    r"(?P<money>[$€£]\s?)?"
    r"(?:(?<![\w.,])(?P<number>\d+(?:,\d{3})*(?:\.\d+)?)(?!\d)"
    rf"|(?<!\w)(?i:(?P<word>{'|'.join(_NUMBER_WORDS)}))(?=\s+(?:{_UNIT}))"
    rf"|(?<!\w)(?i:(?P<ordinal>{'|'.join(_ORDINALS)}))\b)"
    rf"(?:\s?(?P<unit>{_UNIT}))?"
)


_MONTH_NUMBERS = {
    month: str(number)
    for number, month in enumerate(
        "jan feb mar apr may jun jul aug sep oct nov dec".split(), start=1
    )
}
_MONTH = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?"
    r"|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\.?"
)
_DAY = r"\d{1,2}(?:st|nd|rd|th)?"
# A month alone is a word: it needs its day or year beside it to be a date.
_DATE = re.compile(
    rf"(?<![\w.,])(?P<day>{_DAY})\s+(?P<month>{_MONTH})(?:,?\s+(?P<year>\d{{4}})\b)?"
    rf"|\b(?P<month_first>{_MONTH})\s+"
    rf"(?:(?P<day_after>{_DAY})\b(?:,?\s+(?P<year_after>\d{{4}})\b)?|(?P<year_only>\d{{4}})\b)"
)
_DATE_KIND = "date"


@dataclass(frozen=True, slots=True)
class _Value:
    start: int
    end: int
    number: str  # A plain number, or "year-month-day" with unstated parts empty.
    kind: str  # "%", "$", "date", a unit such as "day", or "" for a bare number.

    def same_figure(self, other: _Value) -> bool:
        if self.kind == other.kind == _DATE_KIND:
            parts = zip(self.number.split("-"), other.number.split("-"))
            return all(mine == theirs or not mine or not theirs for mine, theirs in parts)
        return self.number == other.number and (
            self.kind == other.kind or not self.kind or not other.kind
        )


@dataclass(frozen=True, slots=True)
class _Word:
    start: int
    end: int
    text: str


@dataclass(frozen=True, slots=True)
class _Chunk:
    text: str
    values: tuple[_Value, ...]
    words: tuple[_Word, ...]
    tabular: bool


@dataclass(frozen=True, slots=True)
class _Claim:
    """What a passage has to show: every figure, and every name the chunk has."""

    values: tuple[_Value, ...]
    names: frozenset[str]
    terms: frozenset[str]

    @property
    def required(self) -> set[str]:
        return {f"#{value.number}" for value in self.values} | self.names

    def states(self, value: _Value) -> bool:
        return any(value.same_figure(stated) for stated in self.values)


def _plain_number(digits: str) -> str:
    plain = digits.replace(",", "")
    if "." in plain:
        plain = plain.rstrip("0").rstrip(".")
    return plain.lstrip("0") or "0"


def _value_kind(match: re.Match[str]) -> str:
    unit = (match["unit"] or "").lower()
    if unit in {"%", "percent", "per cent"}:
        return "%"
    return unit.removesuffix("s") or ("$" if match["money"] else "")


def _value_number(match: re.Match[str]) -> str:
    if match["word"]:
        return _NUMBER_WORDS[match["word"].lower()]
    if match["ordinal"]:
        return _ORDINALS[match["ordinal"].lower()]
    return _plain_number(match["number"])


def _date_number(match: re.Match[str]) -> str:
    month = (match["month"] or match["month_first"])[:3].lower()
    year = match["year"] or match["year_after"] or match["year_only"] or ""
    day = re.sub(r"\D", "", match["day"] or match["day_after"] or "")
    return f"{year}-{_MONTH_NUMBERS[month]}-{day}"


def _values(text: str) -> tuple[_Value, ...]:
    dates = [
        _Value(match.start(), match.end(), _date_number(match), _DATE_KIND)
        for match in _DATE.finditer(text)
    ]
    numbers = [
        _Value(match.start(), match.end(), _value_number(match), _value_kind(match))
        for match in _VALUE.finditer(text)
        if not any(date.start <= match.start() < date.end for date in dates)
    ]
    return tuple(sorted([*dates, *numbers], key=lambda value: value.start))


def _terms(text: str) -> frozenset[str]:
    """Lexical terms. Text without spaces between words matches by character pairs."""
    terms: set[str] = set()
    for word in _TERM.findall(text.lower()):
        if word.isdigit():
            terms.add(word)
        elif word.isascii():
            token = normalize_search_token(word)
            terms.update({token} if token else ())
        else:
            terms.update(first + second for first, second in zip(word, word[1:]))
    return frozenset(terms)


def _name_words(claim: str) -> Iterator[str]:
    """Names and codes: capitalized past the first word, or letters with digits."""
    for position, match in enumerate(_WORD.finditer(claim)):
        word = match[0]
        capitalized = position > 0 and word[0].isupper() and normalize_search_token(word.lower())
        if _CODE.fullmatch(word) or capitalized:
            yield word.lower()


def _read_claims(claims: Sequence[str], chunk: _Chunk) -> _Claim:
    known_words = {word.text.lower() for word in chunk.words}
    names = {name for claim in claims for name in _name_words(claim)}
    joined = " ".join(claims)
    return _Claim(_values(joined), frozenset(names & known_words), _terms(joined))


def _is_tabular(text: str) -> bool:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    open_lines = sum(not line.endswith(_SENTENCE_ENDS) for line in lines)
    return len(lines) >= _MIN_TABLE_LINES and open_lines * 2 >= len(lines)


def _spans(text: str, gap: re.Pattern[str]) -> Iterator[tuple[int, int]]:
    """Bounds of the pieces between gaps, none longer than a passage."""
    start = 0
    for found in [*gap.finditer(text), None]:
        end = found.start() if found else len(text)
        while end - start > MAX_PASSAGE_CHARS:
            cut = text.rfind(" ", start, start + MAX_PASSAGE_CHARS)
            cut = cut if cut > start else start + MAX_PASSAGE_CHARS
            yield start, cut
            start = cut
        yield start, end
        start = found.end() if found else end


def _windows(chunk: _Chunk, size: int) -> Iterator[tuple[int, int]]:
    """Runs of up to ``size`` sentences. In a table a window is one row."""
    text = chunk.text
    spans = [*_spans(text, _ROW_GAP if chunk.tabular else SENTENCE_GAP)]
    size = 1 if chunk.tabular else size
    for first, (start, _end) in enumerate(spans):
        for _last, end in spans[first : first + size]:
            if end - start <= MAX_PASSAGE_CHARS:
                yield start, end


def _required_hits(chunk: _Chunk, window: tuple[int, int], claim: _Claim) -> list[tuple[int, int, str]]:
    start, end = window
    hits = [
        (value.start, value.end, f"#{stated.number}")
        for value in chunk.values
        if start <= value.start and value.end <= end
        for stated in claim.values
        if value.same_figure(stated)
    ]
    hits += [
        (word.start, word.end, word.text.lower())
        for word in chunk.words
        if start <= word.start and word.end <= end and word.text.lower() in claim.names
    ]
    return sorted(hits)


def _covers(hits: list[tuple[int, int, str]], required: set[str]) -> list[tuple[int, int]]:
    """Every run of hits, from each hit, that shows everything required."""
    covers: list[tuple[int, int]] = []
    for first, (start, _end, _key) in enumerate(hits):
        seen: set[str] = set()
        furthest = start
        for _start, end, key in hits[first:]:
            seen.add(key)
            furthest = max(furthest, end)
            if seen == required:
                covers.append((start, furthest))
                break
    return covers


def _term_covers(chunk: _Chunk, window: tuple[int, int], claim: _Claim) -> list[tuple[int, int]]:
    start, end = window
    hits = [
        word
        for word in chunk.words
        if start <= word.start and word.end <= end and _terms(word.text) & claim.terms
    ]
    return [(hits[0].start, hits[-1].end)] if hits else []


def _reach(
    chunk: _Chunk, cover: tuple[int, int], window: tuple[int, int], claim: _Claim
) -> tuple[int, int]:
    """How far the cover can spread before a figure the claim did not make."""
    foreign = [value for value in chunk.values if not claim.states(value)]
    low = max([window[0], *(value.end for value in foreign if value.end <= cover[0])])
    high = min([window[1], *(value.start for value in foreign if value.start >= cover[1])])
    return low, high


def _echoes(word: _Word, claim: _Claim) -> frozenset[str]:
    """The claim terms a word repeats. Digits belong to figures, not to labels."""
    return frozenset() if word.text.isdigit() else _terms(word.text) & claim.terms


def _trailing_edge(words: Iterable[_Word], claim: _Claim, shown: set[str], cover_end: int) -> int:
    """Where echoes after the cover end. A term seen again is the next row's label."""
    end = cover_end
    for word in words:
        fresh = _echoes(word, claim) - shown
        if fresh:
            shown |= fresh
            end = word.end
    return end


def _grown(
    chunk: _Chunk, cover: tuple[int, int], window: tuple[int, int], claim: _Claim
) -> tuple[int, int]:
    """Grow to the window's edges, stopping at a figure the claim did not make.

    Flattened PDF text glues one row's last cell to the next row's first, so a
    sentence edge is not a row edge, and such a figure is the only reliable sign
    of having crossed one. Short of an edge, keep what still echoes the claim.
    """
    low, high = _reach(chunk, cover, window, claim)
    after = [word for word in chunk.words if cover[1] <= word.start and word.end <= high]
    leading = [word.start for word in chunk.words if low <= word.start and _echoes(word, claim)]
    start = low if low == window[0] else min([cover[0], *leading])
    shown = set(_terms(chunk.text[start : cover[1]]))
    end = high if high == window[1] else _trailing_edge(after, claim, shown, cover[1])
    return start, end


def _contradicts(text: str, claim: _Claim) -> bool:
    """A figure of a kind the claim states, but not one it states."""
    kinds = {value.kind for value in claim.values}
    return any(value.kind in kinds and not claim.states(value) for value in _values(text))


def _spans_for(
    chunk: _Chunk, window: tuple[int, int], claim: _Claim
) -> Iterator[tuple[int, int]]:
    """The places in a window the claim could rest on, none contradicting it."""
    required = claim.required
    covers = (
        _covers(_required_hits(chunk, window, claim), required)
        if required
        else _term_covers(chunk, window, claim)
    )
    if chunk.tabular:
        # A row's other cells are the same row, so only loose text needs trimming.
        yield from [window] if covers else []
        return
    for cover in covers:
        start, end = _grown(chunk, cover, window, claim)
        if not _contradicts(chunk.text[start:end], claim):
            yield start, end


def _rank(chunk: _Chunk, span: tuple[int, int]) -> tuple[bool, int, int]:
    """Shortest, then earliest. A flattened row opens with its label, not a figure."""
    start, end = span
    opens_with_figure = any(value.start == start for value in chunk.values)
    return opens_with_figure, end - start, start


def _candidate(
    chunk: _Chunk, window: tuple[int, int], claim: _Claim
) -> tuple[int, int, int, int] | None:
    """(-shared terms, window length, start, end), when the window can hold the claim.

    Shorter windows rank first: a longer one may share as much only because it
    ran into a figure and could not grow to its own sentence end.
    """
    spans = [*_spans_for(chunk, window, claim)]
    if not spans:
        return None
    start, end = min(spans, key=lambda span: _rank(chunk, span))
    return -len(_terms(chunk.text[start:end]) & claim.terms), window[1] - window[0], start, end


def _is_rival(
    best: tuple[int, int, int, int], other: tuple[int, int, int, int], text: str
) -> bool:
    """Another place that fits as well, with different words: a coin toss."""
    _shared, _length, start, end = best
    other_shared, _other_length, other_start, other_end = other
    overlaps = other_start < end and start < other_end
    return (
        other_shared == best[0]
        and not overlaps
        and text[start:end].strip() not in text[other_start:other_end]
    )


def _pick(chunk: _Chunk, claims: Sequence[str]) -> str | None:
    claim = _read_claims(claims, chunk)
    # With nothing distinctive to look for, one claim's words must sit together.
    size = _MAX_WINDOW_SPANS if claim.required or len(claims) > 1 else 1
    found = (_candidate(chunk, window, claim) for window in _windows(chunk, size))
    candidates = sorted(candidate for candidate in found if candidate is not None)
    if not candidates:
        return None
    best = candidates[0]
    most_of_the_claim = len(claim.terms) // 2 + 1
    if not claim.required and -best[0] < most_of_the_claim:
        return None
    if any(_is_rival(best, other, chunk.text) for other in candidates):
        return None
    return chunk.text[best[2] : best[3]].strip()


def best_passage(text: str, claims: Sequence[str]) -> str | None:
    """The part of ``text`` the claims rest on, verbatim, or None if unsure."""
    chunk = _Chunk(
        text,
        _values(text),
        tuple(_Word(word.start(), word.end(), word[0]) for word in _WORD.finditer(text)),
        _is_tabular(text),
    )
    distinct = [_LIST_PREFIX.sub("", claim) for claim in dict.fromkeys(claims)][:_MAX_CLAIMS]
    together = _pick(chunk, distinct)
    if together is not None or len(distinct) < 2:
        return together
    return next(filter(None, (_pick(chunk, [claim]) for claim in distinct)), None)
