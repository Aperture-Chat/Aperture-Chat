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
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any, Literal

from app.core.fenced_block import BlockGate, FenceTag, block_body

ClarifyMode = Literal["ask", "decide", "answered"]

ASK_TAG = "aperture-ask"
MAX_QUESTIONS = 3
MAX_OPTIONS = 5
MIN_OPTIONS = 2
QUESTION_CHARS = 300
LABEL_CHARS = 120
DETAIL_CHARS = 200
INTRO_CHARS = 2000

_ASK_FENCE = FenceTag(ASK_TAG)


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
    opener = _ASK_FENCE.opener.search(text)
    if opener is None:
        return AskSplit(text, None)
    intro = text[: opener.start()].strip()
    block = parse_ask_block(block_body(text[opener.end() :]), intro=intro)
    return AskSplit(intro, block) if block is not None else AskSplit(text, None)


class AskGate(BlockGate[AskBlock]):
    """Streams a reply while holding back an ask block; see ``BlockGate``."""

    def __init__(self, *, enabled: bool = True) -> None:
        super().__init__(
            _ASK_FENCE, lambda body, intro: parse_ask_block(body, intro=intro), enabled=enabled
        )


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
