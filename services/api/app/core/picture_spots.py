"""Picture spots in a streamed chat reply.

When a person asks for pictures, the model marks each place one belongs with
a line of its own, ``[[Picture: who or what, where, when]]`` (the
``images:spots`` directive in app.core.directives asks for exactly this).
:class:`PictureSpots` sits on the reply's stream: ordinary text passes
straight through, a spot line starts finding its picture at once, and the
text after a spot waits until that picture is ready, so the reply reads in
the order it was written and the saved message holds the pictures.
"""

from __future__ import annotations

import logging
import re
from collections import deque
from collections.abc import Callable, Iterator
from concurrent.futures import Future, wait
from typing import Generic, TypeVar

T = TypeVar("T")
logger = logging.getLogger(__name__)

# The directive asks for at most six; each spot may cost an image-model call.
MAX_PICTURE_SPOTS = 6
_HEAD = "[[picture:"
# Longer than any description a model writes on one line.
_MAX_SPOT_CHARS = 400
# Models often write a spot as a list item, a quote, or in bold or italics.
_LEAD = r"[ \t]*(?:(?:[-*+]|\d{1,3}[.)])[ \t]+|>[ \t]*)*(?:\*\*|__|\*|_)?"
_END = r"(?:\*\*|__|\*|_)?[ \t]*[.,;:!]?[ \t]*\r?"
_LEAD_RE = re.compile(_LEAD)
# What a line holding only its decoration so far may still grow into ("1", "1.", "*").
_PARTIAL_LEAD = re.compile(r"\d{1,3}[.)]?|[-*+>_]|\*\*|__")
_SPOT_LINE = re.compile(_LEAD + r"\[\[Picture:\s*([^\]\n]{3,}?)\s*\]\]" + _END + r"\n?", re.IGNORECASE)
_SPOT_TAIL = re.compile(r"[^\]\n]*(?:\](?:\]" + _END + r")?)?")


def _may_be_spot(line: str) -> bool:
    """Whether an unfinished line could still turn out to be a spot."""
    text = line[_LEAD_RE.match(line).end() :].lower()  # type: ignore[union-attr]  # _LEAD matches empty
    if not text or _PARTIAL_LEAD.fullmatch(text):
        return len(line) < len(_HEAD)
    if len(text) <= len(_HEAD):
        return _HEAD.startswith(text)
    return text.startswith(_HEAD) and len(text) < _MAX_SPOT_CHARS and bool(_SPOT_TAIL.fullmatch(text[len(_HEAD) :]))


class _Spot(Generic[T]):
    def __init__(self, description: str, found: Future[T] | None) -> None:
        self.description = description
        # None: past the cap, nothing is looked up.
        self.found = found

    def ready(self) -> bool:
        return self.found is None or self.found.done()


class PictureSpots(Generic[T]):
    """Replaces each spot line in a stream with what ``render`` makes of it.

    ``start`` begins finding one picture and returns its future; it runs on
    the stream's own thread, so it may record what is about to be searched.
    ``render`` turns a finished search (``None`` when it raised) into the
    Markdown shown in its place, also on the stream's thread.
    """

    def __init__(self, start: Callable[[str], Future[T]], render: Callable[[str, T | None], str]) -> None:
        self._start = start
        self._render = render
        self._queue: deque[str | _Spot[T]] = deque()
        # The start of a line that may still be a spot.
        self._line = ""
        # The current line already showed it is not a spot.
        self._plain = False
        self._started = 0
        # Everything the reader has been sent, pictures in place of spots.
        self.shown = ""

    def feed(self, text: str) -> str:
        """Takes more of the reply; returns what may be shown now."""
        for part in text.splitlines(keepends=True):
            self._take(part)
        return self._ready()

    def close(self, *, tick_seconds: float) -> Iterator[str | None]:
        """Ends the reply: yields what is left to show, and ``None`` each
        ``tick_seconds`` a picture is still being found."""
        if self._line:
            self._end_line(self._line)
            self._line = ""
        while self._queue:
            head = self._queue[0]
            if isinstance(head, _Spot) and head.found is not None and not head.found.done():
                if not wait([head.found], timeout=tick_seconds).done:
                    yield None
                    continue
            yield self._ready()

    def abandon(self) -> str:
        """Ends a reply that stopped early: everything still waiting is
        released at once, a picture still being found is said to be left out,
        and nothing is waited on."""
        # An unfinished spot line is an instruction to Aperture, not text for the reader.
        if self._line and not _may_be_spot(self._line) and not _SPOT_LINE.fullmatch(self._line):
            self._queue.append(self._line)
        self._line = ""
        shown: list[str] = []
        while self._queue:
            head = self._queue.popleft()
            if isinstance(head, str) or head.ready():
                shown.append(head if isinstance(head, str) else self._shown(head))
            else:
                shown.append(f"\n*Picture not added (the reply ended before it was found): {head.description}.*\n\n")
        return self._sent("".join(shown))

    def _sent(self, text: str) -> str:
        self.shown += text
        return text

    def _take(self, part: str) -> None:
        ends_line = part.endswith("\n")
        if self._plain:
            self._queue.append(part)
            self._plain = not ends_line
            return
        line = self._line + part
        self._line = ""
        if ends_line:
            self._end_line(line)
        elif _may_be_spot(line):
            self._line = line
        else:
            self._queue.append(line)
            self._plain = True

    def _end_line(self, line: str) -> None:
        match = _SPOT_LINE.fullmatch(line)
        if match is None:
            self._queue.append(line)
            return
        description = match.group(1).strip()
        found = self._start(description) if self._started < MAX_PICTURE_SPOTS else None
        self._started += 1
        self._queue.append(_Spot(description, found))

    def _ready(self) -> str:
        shown: list[str] = []
        while self._queue and (isinstance(self._queue[0], str) or self._queue[0].ready()):
            head = self._queue.popleft()
            shown.append(head if isinstance(head, str) else self._shown(head))
        return self._sent("".join(shown))

    def _shown(self, spot: _Spot[T]) -> str:
        if spot.found is None:
            return f"\n*Picture left out (this reply already has {MAX_PICTURE_SPOTS}): {spot.description}.*\n\n"
        try:
            found: T | None = spot.found.result()
        except Exception:
            logger.warning("Finding a picture for %r failed", spot.description, exc_info=True)
            found = None
        return f"\n{self._render(spot.description, found)}\n\n"
