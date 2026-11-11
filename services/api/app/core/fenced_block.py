"""A fenced block the reply stream keeps to itself.

A reply can carry one fenced block meant for the platform, not the reader:
the questions it pauses to ask, or the research steps it wants run. This
module finds that block by its tag and holds it back while the reply streams,
so the reader never sees it.

Glossary:

- *tag*: the info string that names the block, such as ``aperture-ask``.
- *opener*: the opening fence line naming the tag.
- *body*: what sits between the opener and the closing fence.
- *gate*: the stream filter that releases everything except the block.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Generic, TypeVar

Block = TypeVar("Block")

_CLOSER = re.compile(r"^[ \t]*(?:`{3,}|~{3,})[ \t]*$", re.MULTILINE)
_FENCE_START = re.compile(r"(`+|~+)[ \t]*([^\n]*)$")


class FenceTag:
    """How to recognise a block by the tag on its opening fence."""

    def __init__(self, tag: str) -> None:
        self.tag = tag
        # The newline is required: until it arrives, "```aperture-ask" could
        # still turn into "```aperture-asks".
        self.opener = re.compile(
            rf"^[ \t]*(?:`{{3,}}|~{{3,}})[ \t]*{re.escape(tag)}(?![\w-])[^\n]*\n",
            re.MULTILINE | re.IGNORECASE,
        )

    def could_open(self, line: str) -> bool:
        """Whether a line still being written may turn out to open the block."""
        stripped = line.lstrip(" \t")
        if not stripped:
            return True
        match = _FENCE_START.match(stripped)
        if match is None:
            return False
        fence, rest = match.group(1), match.group(2).lower()
        if len(fence) < 3:
            return rest == ""
        return self.tag.startswith(rest) or rest.startswith(self.tag)


def block_body(after_opener: str) -> str:
    """The text of a block whose opener has just ended; an unclosed block runs to the end."""
    closer = _CLOSER.search(after_opener)
    return (after_opener[: closer.start()] if closer else after_opener).strip()


class BlockGate(Generic[Block]):
    """Streams a reply while holding back one tagged block.

    ``feed`` returns the text that is safe to show now: everything except a
    last line that may be the start of the block, and, once the block has
    begun, nothing more. ``finish`` returns what is still owed: a held line
    that turned out to be ordinary text, or a block that did not parse.
    ``parse`` receives the block's body and the text written before it.
    """

    def __init__(
        self,
        tag: FenceTag,
        parse: Callable[[str, str], Block | None],
        *,
        enabled: bool,
    ) -> None:
        self._tag = tag
        self._parse = parse
        self._enabled = enabled
        self._text = ""
        self._released = 0
        self._opener: re.Match[str] | None = None
        self.block: Block | None = None

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def text(self) -> str:
        """Everything fed so far, the block included."""
        return self._text

    def feed(self, delta: str) -> str:
        self._text += delta
        if not self._enabled:
            return self._release(len(self._text))
        if self._opener is not None:
            return ""
        # Every line that might open a block is held back, so a block never
        # starts before the text already shown.
        self._opener = self._tag.opener.search(self._text, self._released)
        if self._opener is not None:
            return self._release(self._opener.start())
        return self._release(self._safe_end())

    def finish(self) -> str:
        if self._opener is None:
            return self._release(len(self._text))
        intro = self._text[: self._opener.start()]
        self.block = self._parse(block_body(self._text[self._opener.end() :]), intro)
        return "" if self.block is not None else self._release(len(self._text))

    def _safe_end(self) -> int:
        line_start = self._text.rfind("\n") + 1
        return line_start if self._tag.could_open(self._text[line_start:]) else len(self._text)

    def _release(self, end: int) -> str:
        shown = self._text[self._released : end]
        self._released = max(end, self._released)
        return shown
