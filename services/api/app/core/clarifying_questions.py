"""Clarifying questions: a reply that pauses to ask the user before going on.

On the chat surface the model may stop before doing the work and ask up to
three multiple-choice questions, when the request can reasonably be read
several ways and a wrong guess would waste the user's time. It does so by
writing one fenced block::

    ```aperture-ask
    {"questions": [{"question": "...", "options": ["...", "..."], "recommended": "..."}]}
    ```

Glossary:

- *ask block*: that fenced block. Any text before it is the *lead-in*,
  shown above the questions.
- *pause*: a reply that ended with a valid ask block. The page shows the
  questions; the user's answers, or a request that the assistant decide,
  continue the same reply as a new run.
- *clarify mode*: what the model is told this turn. ``ask`` lets it pause,
  ``decide`` tells it to choose for the user, and ``answered`` tells it the
  user has replied, so it finishes without asking again.

The block never reaches the reply text. ``AskGate`` holds it back while the
reply streams, releasing everything else as it arrives; a block that does not
parse is released as written, so nothing the model wrote is ever lost.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any, Literal

ClarifyMode = Literal["ask", "decide", "answered"]

ASK_TAG = "aperture-ask"
MAX_QUESTIONS = 3
MAX_OPTIONS = 5
MIN_OPTIONS = 2
QUESTION_CHARS = 300
LABEL_CHARS = 120
DETAIL_CHARS = 200
INTRO_CHARS = 2000

# An opening fence line naming the tag. The newline is required: until it
# arrives, "```aperture-ask" could still turn into "```aperture-asks".
_OPENER = re.compile(
    rf"^[ \t]*(?:`{{3,}}|~{{3,}})[ \t]*{ASK_TAG}(?![\w-])[^\n]*\n", re.MULTILINE | re.IGNORECASE
)
_CLOSER = re.compile(r"^[ \t]*(?:`{3,}|~{3,})[ \t]*$", re.MULTILINE)
_FENCE_START = re.compile(r"(`+|~+)[ \t]*([^\n]*)$")


@dataclass(frozen=True)
class AskOption:
    label: str
    detail: str = ""


@dataclass(frozen=True)
class AskQuestion:
    id: str
    question: str
    options: tuple[AskOption, ...]
    multiple: bool
    # The option the assistant would pick itself, by position.
    recommended: int | None


@dataclass(frozen=True)
class AskBlock:
    intro: str
    questions: tuple[AskQuestion, ...]

    def map_text(self, screen: Callable[[str], str]) -> AskBlock:
        """The same questions with every user-visible text passed through ``screen``."""
        return AskBlock(
            intro=screen(self.intro),
            questions=tuple(
                replace(
                    question,
                    question=screen(question.question),
                    options=tuple(AskOption(screen(o.label), screen(o.detail)) for o in question.options),
                )
                for question in self.questions
            ),
        )

    def payload(self) -> dict[str, Any]:
        """What the stream and the stored reply carry."""
        return {
            "intro": self.intro,
            "questions": [
                {
                    "id": question.id,
                    "question": question.question,
                    "options": [_option_payload(option) for option in question.options],
                    "multiple": question.multiple,
                    "recommended": question.recommended,
                }
                for question in self.questions
            ],
        }


def _option_payload(option: AskOption) -> dict[str, str]:
    return {"label": option.label, "detail": option.detail} if option.detail else {"label": option.label}


def _clip(value: object, limit: int) -> str:
    """One line of plain text, shortened with an ellipsis past ``limit``."""
    text = " ".join(value.split()) if isinstance(value, str) else ""
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _option(raw: object) -> AskOption | None:
    if isinstance(raw, dict):
        label, detail = _clip(raw.get("label"), LABEL_CHARS), _clip(raw.get("detail"), DETAIL_CHARS)
    else:
        label, detail = _clip(raw, LABEL_CHARS), ""
    return AskOption(label, detail) if label else None


def _options(raw: object) -> tuple[AskOption, ...]:
    found: dict[str, AskOption] = {}
    for item in raw if isinstance(raw, list) else []:
        option = _option(item)
        if option is not None:
            found.setdefault(option.label.casefold(), option)
    return tuple(found.values())[:MAX_OPTIONS]


def _recommended(raw: object, options: tuple[AskOption, ...]) -> int | None:
    if isinstance(raw, int) and not isinstance(raw, bool):
        return raw if 0 <= raw < len(options) else None
    wanted = _clip(raw, LABEL_CHARS).casefold()
    return next((index for index, option in enumerate(options) if option.label.casefold() == wanted), None)


def _question(raw: object, number: int) -> AskQuestion | None:
    if not isinstance(raw, dict):
        return None
    text = _clip(raw.get("question"), QUESTION_CHARS)
    options = _options(raw.get("options"))
    if not text or len(options) < MIN_OPTIONS:
        return None
    return AskQuestion(
        id=f"q{number}",
        question=text,
        options=options,
        multiple=raw.get("multiple") is True,
        recommended=_recommended(raw.get("recommended"), options),
    )


def _raw_questions(raw: str) -> list[object]:
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    listed = data.get("questions") if isinstance(data, dict) else data
    return listed if isinstance(listed, list) else []


def parse_ask_block(raw: str, *, intro: str = "") -> AskBlock | None:
    """The questions in an ask block's JSON; None when none is usable."""
    questions: list[AskQuestion] = []
    for item in _raw_questions(raw):
        question = _question(item, len(questions) + 1)
        if question is not None:
            questions.append(question)
    if not questions:
        return None
    return AskBlock(intro=intro.strip()[:INTRO_CHARS], questions=tuple(questions[:MAX_QUESTIONS]))


def _block_body(after_opener: str) -> str:
    closer = _CLOSER.search(after_opener)
    return (after_opener[: closer.start()] if closer else after_opener).strip()


@dataclass(frozen=True)
class AskSplit:
    """A finished reply: its text, and the questions it paused on, if any."""

    text: str
    block: AskBlock | None


def split_reply(text: str) -> AskSplit:
    """Separate a finished reply's lead-in from its ask block.

    A reply with no block, or with one that does not parse, stays as written.
    Anything after a valid block is dropped: the model was told to stop there.
    """
    opener = _OPENER.search(text)
    if opener is None:
        return AskSplit(text, None)
    intro = text[: opener.start()].strip()
    block = parse_ask_block(_block_body(text[opener.end() :]), intro=intro)
    return AskSplit(intro, block) if block is not None else AskSplit(text, None)


def _could_open(line: str) -> bool:
    """Whether a line still being written may turn out to open an ask block."""
    stripped = line.lstrip(" \t")
    if not stripped:
        return True
    match = _FENCE_START.match(stripped)
    if match is None:
        return False
    fence, rest = match.group(1), match.group(2).lower()
    if len(fence) < 3:
        return rest == ""
    return ASK_TAG.startswith(rest) or rest.startswith(ASK_TAG)


class AskGate:
    """Streams a reply while holding back an ask block.

    ``feed`` returns the text that is safe to show now: everything except a
    last line that may be the start of the block, and, once the block has
    begun, nothing more. ``finish`` returns what is still owed: a held line
    that turned out to be ordinary text, or a block that did not parse.
    """

    def __init__(self, *, enabled: bool = True) -> None:
        self._enabled = enabled
        self._text = ""
        self._released = 0
        self._opener: re.Match[str] | None = None
        self.block: AskBlock | None = None

    @property
    def enabled(self) -> bool:
        return self._enabled

    def feed(self, delta: str) -> str:
        self._text += delta
        if not self._enabled:
            return self._release(len(self._text))
        if self._opener is not None:
            return ""
        # Every line that might open a block is held back, so a block never
        # starts before the text already shown.
        self._opener = _OPENER.search(self._text, self._released)
        if self._opener is not None:
            return self._release(self._opener.start())
        return self._release(self._safe_end())

    def finish(self) -> str:
        if self._opener is None:
            return self._release(len(self._text))
        intro = self._text[: self._opener.start()]
        self.block = parse_ask_block(_block_body(self._text[self._opener.end() :]), intro=intro)
        return "" if self.block is not None else self._release(len(self._text))

    def _safe_end(self) -> int:
        line_start = self._text.rfind("\n") + 1
        return line_start if _could_open(self._text[line_start:]) else len(self._text)

    def _release(self, end: int) -> str:
        shown = self._text[self._released : end]
        self._released = max(end, self._released)
        return shown


_ASK_LINE = (
    "- Clarifying questions: if the request can reasonably be read in ways that would "
    "change the answer substantially (facts only the user knows, the scope, audience, "
    "jurisdiction, format, or tone) and a wrong guess would waste the user's time, pause "
    "before doing the work and ask. Write at most one short lead-in sentence, then one "
    f"```{ASK_TAG} fenced block holding only JSON: "
    '{"questions": [{"question": "...", "options": ["...", "..."], "recommended": "...", '
    '"multiple": false}]}. Ask at most 3 questions, each with 2 to 5 short options; name '
    'the option you would choose in "recommended"; set "multiple" to true only when '
    "several options can apply together. The user can also type their own answer or let "
    "you decide, so the options need not cover everything. Write nothing after the block. "
    "Do not ask when the request is clear enough to act on, when a sensible default carries "
    "little risk, for simple factual questions, or only to confirm; then proceed and state "
    "any key assumption in one short line. Never ask after you have started the answer."
)

_DECIDE_LINE = (
    "- Clarifying questions: the user wants you to make the choices. Do not stop to ask "
    "clarifying questions; pick the most sensible reading and defaults, state the key "
    "assumptions in one short line, and complete the work."
)

_ANSWERED_LINE = (
    "- Clarifying questions: you paused this reply to ask, and the latest message holds the "
    "user's answers or asks you to decide. Use them and complete the work now; do not ask again."
)

_PROMPT_LINES: dict[str, str] = {"ask": _ASK_LINE, "decide": _DECIDE_LINE, "answered": _ANSWERED_LINE}


def clarify_prompt_line(mode: ClarifyMode | None) -> str | None:
    """The runtime-prompt line for this turn's clarify mode; None adds nothing."""
    return _PROMPT_LINES.get(mode) if mode else None
