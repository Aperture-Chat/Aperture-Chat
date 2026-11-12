"""A platform block a model wrote as a tool call in its own markup.

A reply asks the platform for something by writing one fenced block: research
steps (``work_steps``) or questions for the user (``clarifying_questions``).
Some models now and then make that request in the tool-call markup of their
own chat template instead. A provider turns such markup into a tool call only
when the request declared tools, and these requests declare none, so it
arrives as reply text. Kimi K3 on Azure AI Foundry writes::

    <|open|>tools<|sep|><|open|>call tool="aperture-steps" index="1"<|sep|>
    <|open|>argument key="steps" type="array"<|sep|>[{"do": "search_web", ...}]
    <|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|>
    <|close|>message<|sep|>

Left alone, the reader saw that markup and the steps were never taken. This
module rewrites it as the fenced block that was asked for, before the gates
that hold those blocks back read the reply.

Mistral on Azure AI Foundry makes the same request as a real tool call: the
provider parses it although no tools were declared, so the turn arrives with
a ``tool_calls`` entry and no text, and the reply came back empty. Those
calls are turned into the block the same way.

Glossary:

- *envelope*: everything from ``<|open|>tools`` to its closer (or to the end
  of the reply when the model stopped before closing it).
- *call*: one tool call inside an envelope, with its *arguments*.
- *block*: the fenced block a call stands for, named by its *tag*.

The model writes the request in more than one way, all seen live:

- one call carrying the block's own JSON (``steps`` or ``questions``), as an
  argument of that name or as JSON text in some other argument, under any
  tool name (``aperture-steps``, ``undefined``, ``seeevidence``);
- one call per step, named for the step in some spelling (``search_web``,
  ``aperture-search_web``, ``web_search``, ``WebSearch``).

A call for something the platform does not offer, or one with no arguments,
is rewritten too, as a step no runner takes, so the model is told it is not
available and writes its answer. Only an envelope with no call in it stays as
the model wrote it.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable, Iterator
from itertools import permutations
from typing import Any

from app.core.clarifying_questions import ASK_TAG
from app.core.work_steps import STEP_KINDS, STEP_TAG

_OPENER = "<|open|>tools<|sep|>"
_ENVELOPE = re.compile(
    r"<\|open\|>tools<\|sep\|>(.*?)"
    r"(?:<\|close\|>tools<\|sep\|>(?:\s*<\|close\|>message<\|sep\|>)?|\Z)",
    re.DOTALL,
)
_CALL = re.compile(r"<\|open\|>call\b([^<]*)<\|sep\|>(.*?)<\|close\|>call<\|sep\|>", re.DOTALL)
_ARGUMENT = re.compile(
    r"<\|open\|>argument\b([^<]*)<\|sep\|>(.*?)<\|close\|>argument<\|sep\|>", re.DOTALL
)
_ATTRIBUTE = re.compile(r'(\w+)="([^"]*)"')


def as_fenced_blocks(text: str, *, after: str = "") -> str:
    """``text`` with each native call for a platform block written as that block.

    A fence only opens a block at the start of a line, so a call that follows
    other text on its line is moved to a line of its own. ``after`` is the
    reply text that came before ``text``, when there was any.
    """

    def rewrite(envelope: re.Match[str]) -> str:
        blocks = _blocks(envelope.group(1))
        if blocks is None:
            return envelope.group(0)
        before = text[envelope.start() - 1] if envelope.start() else after[-1:]
        return blocks if before in ("", "\n") else f"\n{blocks}"

    return _ENVELOPE.sub(rewrite, text)


def fenced_native_calls(
    deltas: Iterable[str],
    provider_calls: Callable[[], object] | None = None,
) -> Iterator[str]:
    """A streamed reply with its native calls rewritten as fenced blocks.

    Ordinary text passes straight through, upstream keep-alives (empty pieces)
    included. From the start of an envelope the rest of the turn is held and
    rewritten whole once the turn ends: a call ends the model's turn, and its
    last closers can arrive in a later piece.

    ``provider_calls`` is asked once the stream ends for the tool calls the
    provider parsed out of the turn (the gateway's ``usage_sink["tool_calls"]``).
    They end the turn as their block. Leave it out when the caller declared
    tools of its own: those calls are the caller's.
    """
    held = ""
    last = ""
    for delta in deltas:
        if not delta:
            yield delta
            continue
        held += delta
        ready, held = _before_envelope(held)
        if ready:
            last = ready[-1]
            yield ready
    if held:
        held = as_fenced_blocks(held, after=last)
        last = held[-1]
        yield held
    block = _provider_block(provider_calls() if provider_calls else None)
    if block:
        yield block if last in ("", "\n") else f"\n{block}"


def completion_with_fenced_blocks(payload: Any, *, caller_tools: bool = False) -> Any:
    """A whole reply (an OpenAI-shaped completion) with its native calls
    rewritten: markup in the text, and tool calls the provider parsed unless
    the caller declared tools of its own (``caller_tools``)."""
    choices = payload.get("choices") if isinstance(payload, dict) else None
    for choice in choices if isinstance(choices, list) else []:
        message = choice.get("message") if isinstance(choice, dict) else None
        if isinstance(message, dict):
            _fence_message(message, caller_tools=caller_tools)
    return payload


def _fence_message(message: dict[str, Any], *, caller_tools: bool) -> None:
    """One reply message with its native calls written as fenced blocks."""
    if isinstance(message.get("content"), str):
        message["content"] = as_fenced_blocks(message["content"])
    block = None if caller_tools else _provider_block(_openai_calls(message.get("tool_calls")))
    if block:
        text = message.get("content") or ""
        message["content"] = text + (block if text[-1:] in ("", "\n") else f"\n{block}")
        message.pop("tool_calls", None)


def _openai_calls(tool_calls: object) -> list[object]:
    """OpenAI-shaped ``tool_calls`` as the gateway gathers a stream's: name and arguments JSON."""
    return [
        call["function"]
        for call in (tool_calls if isinstance(tool_calls, list) else [])
        if isinstance(call, dict) and isinstance(call.get("function"), dict)
    ]


def _provider_block(calls: object) -> str | None:
    """The fenced block for tool calls a provider parsed; None when there are none."""
    return _block_for(
        [
            (str(call.get("name") or ""), _arguments(call.get("arguments")))
            for call in (calls if isinstance(calls, list) else [])
            if isinstance(call, dict)
        ]
    )


def _arguments(raw: object) -> dict[str, object]:
    """A parsed call's arguments by key. Arguments that are not a JSON object
    are kept as one unnamed value, so the call is refused, never dropped."""
    value = _value(raw) if isinstance(raw, str) else raw
    return value if isinstance(value, dict) else {"": value}


def _before_envelope(text: str) -> tuple[str, str]:
    """Split ``text`` into what is safe to release now and what must wait: an
    envelope, or a last few characters that may be the start of one."""
    start = text.find(_OPENER)
    if start < 0:
        start = len(text) - _partial_opener(text)
    return text[:start], text[start:]


def _partial_opener(text: str) -> int:
    """How many characters at the end of ``text`` could begin the opener."""
    for size in range(min(len(text), len(_OPENER) - 1), 0, -1):
        if _OPENER.startswith(text[-size:]):
            return size
    return 0


Call = tuple[str, dict[str, object]]


def _blocks(envelope: str) -> str | None:
    """The fenced block an envelope's calls stand for; None when it holds no
    call that can be read."""
    return _block_for([_call(call.group(1), call.group(2)) for call in _CALL.finditer(envelope)])


def _block_for(calls: list[Call]) -> str | None:
    return (_ask_block(calls) or _step_block(calls)) if calls else None


def _call(head: str, body: str) -> Call:
    """A call's tool name and its arguments by key."""
    arguments: dict[str, object] = {}
    for argument in _ARGUMENT.finditer(body):
        attributes = dict(_ATTRIBUTE.findall(argument.group(1)))
        arguments[attributes.get("key", "")] = _value(argument.group(2), attributes.get("type"))
    return dict(_ATTRIBUTE.findall(head)).get("tool", ""), arguments


def _value(raw: str, kind: str | None = None) -> object:
    """An argument's value: its text when the model called it a string (a
    search for ``2026`` is a search, not a number), JSON where it is JSON,
    and its text otherwise."""
    if kind == "string":
        return raw.strip()
    try:
        return json.loads(raw)
    except ValueError:
        return raw.strip()


def _ask_block(calls: list[Call]) -> str | None:
    questions = _listed(calls[0][1], "questions") if len(calls) == 1 else None
    return _fenced(ASK_TAG, {"questions": questions}) if questions else None


def _step_block(calls: list[Call]) -> str:
    """One round of steps, from every call in order."""
    steps: list[object] = []
    for tool, arguments in calls:
        steps.extend(_listed(arguments, "steps") or [_one_step(tool, arguments)])
    return _fenced(STEP_TAG, {"steps": steps})


def _listed(arguments: dict[str, object], name: str) -> list[object] | None:
    """A block's own list (``steps`` or ``questions``), given as the argument
    of that name or inside any argument's JSON."""
    for key, value in arguments.items():
        given = _json_text(value)
        found = given.get(name) if isinstance(given, dict) else given if key == name else None
        if isinstance(found, list) and found:
            return found
    return None


def _json_text(value: object) -> object:
    """A block handed over as a string of JSON, read; anything else as it is."""
    if isinstance(value, str) and value.lstrip()[:1] in ("{", "["):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def _one_step(tool: str, arguments: dict[str, object]) -> dict[str, str]:
    """The step one call stands for. A call for something the platform does
    not offer, or one that says nothing to look for, still becomes a step, one
    no runner takes: the model is told it is not available and answers, where
    the reader used to be shown markup."""
    texts = {
        key: str(value)
        for key, value in arguments.items()
        if isinstance(value, (str, int, float)) and not isinstance(value, bool) and str(value)
    }
    looked_for = next((texts[key] for key in _LOOKED_FOR if key in texts), next(iter(texts.values()), None))
    if looked_for is None:
        return {"do": f"{tool.strip() or 'a tool'} with nothing to look for", "query": "nothing"}
    return {"do": _KIND_BY_NAME.get(_letters(tool), tool.strip() or "a tool"), "query": looked_for}


def _letters(tool: str) -> str:
    return re.sub(r"[^a-z]", "", tool.lower()).removeprefix("aperture")


# Every way the words of a step's name can be run together: ``search_web`` is
# also written ``WebSearch``, ``web_search`` and ``aperture-search_web``.
_KIND_BY_NAME = {
    "".join(order): kind for kind in STEP_KINDS for order in permutations(kind.split("_"))
}
# The argument that says what a step looks for, when a call carries several.
_LOOKED_FOR = ("query", "url", "expression")


def _fenced(tag: str, body: dict[str, object]) -> str:
    return f"```{tag}\n{json.dumps(body)}\n```\n"
