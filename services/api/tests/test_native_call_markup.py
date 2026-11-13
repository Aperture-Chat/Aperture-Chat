"""A platform block a model wrote in its own tool-call markup is read as that block."""

from __future__ import annotations

import json

import pytest

from app.core.clarifying_questions import split_reply
from app.core.native_call_markup import as_fenced_blocks, fenced_native_calls
from app.core.work_steps import Step, whole_turn_steps

# What Kimi-K3.1-Pro on Azure AI Foundry sent, about once in eighteen replies.
KIMI_STEPS = (
    '<|open|>tools<|sep|><|open|>call tool="aperture-steps" index="1"<|sep|>'
    '<|open|>argument key="steps" type="array"<|sep|>'
    '[{"do":"search_web","query":"Missouri written contract limitations"},'
    '{"do":"search_web","query":"Kansas written contract limitations"}]'
    "<|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|><|close|>message<|sep|>"
)
EXPECTED_STEPS = (
    Step("search_web", "Missouri written contract limitations"),
    Step("search_web", "Kansas written contract limitations"),
)


def test_a_native_call_naming_the_block_is_read_as_that_block() -> None:
    steps, asked = whole_turn_steps(as_fenced_blocks(KIMI_STEPS))

    assert steps == EXPECTED_STEPS
    assert "<|" not in asked


def test_a_call_with_no_usable_tool_name_is_recognised_by_its_argument() -> None:
    unnamed = KIMI_STEPS.replace('tool="aperture-steps"', 'tool="undefined"')

    steps, _asked = whole_turn_steps(as_fenced_blocks(unnamed))

    assert steps == EXPECTED_STEPS


def test_text_written_before_the_call_stays_in_front_of_the_block() -> None:
    rewritten = as_fenced_blocks("I am checking the statutes." + KIMI_STEPS)

    assert rewritten.startswith("I am checking the statutes.\n```aperture-steps\n")
    assert whole_turn_steps(rewritten)[0] == EXPECTED_STEPS


def test_questions_asked_as_a_native_call_become_an_ask_block() -> None:
    questions = [{"question": "Who is the letter to?", "options": [{"label": "Client"}, {"label": "Opposing counsel"}]}]
    call = (
        'I need one detail.<|open|>tools<|sep|><|open|>call tool="aperture-ask" index="1"<|sep|>'
        f'<|open|>argument key="questions" type="array"<|sep|>{json.dumps(questions)}'
        "<|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|>"
    )

    split = split_reply(as_fenced_blocks(call))

    assert split.text == "I need one detail."
    assert split.block is not None
    assert [question.question for question in split.block.questions] == ["Who is the letter to?"]


def test_a_call_cut_off_before_its_last_closers_is_still_read() -> None:
    cut = KIMI_STEPS[: KIMI_STEPS.index("<|close|>tools")]

    assert whole_turn_steps(as_fenced_blocks(cut))[0] == EXPECTED_STEPS


@pytest.mark.parametrize(
    "text",
    [
        "An ordinary answer with no markup at all.",
        "Kimi writes calls as <|open|>tools<|sep|> in its template.",
    ],
)
def test_text_with_no_call_that_can_be_read_is_left_as_written(text: str) -> None:
    assert as_fenced_blocks(text) == text


@pytest.mark.parametrize("size", [1, 2, 3, 7, 16, 61])
def test_a_streamed_reply_reads_the_same_however_it_is_cut_into_pieces(size: int) -> None:
    reply = "I am checking the statutes." + KIMI_STEPS + " Then the answer."
    pieces = [reply[index : index + size] for index in range(0, len(reply), size)]

    assert "".join(fenced_native_calls(pieces)) == as_fenced_blocks(reply)


def test_ordinary_text_streams_through_without_waiting() -> None:
    released = list(fenced_native_calls(["Hello ", "there", "", " friend."]))

    # Nothing is held back, and an upstream keep-alive (an empty piece) passes through.
    assert released == ["Hello ", "there", "", " friend."]


def test_a_piece_that_only_looked_like_the_start_of_a_call_is_released() -> None:
    released = "".join(fenced_native_calls(["a <|op", "en|>door and <", "|open|>tools"]))

    assert released == "a <|open|>door and <|open|>tools"


def _call(tool: str, key: str, value: str) -> str:
    return (
        f'<|open|>call tool="{tool}" index="1"<|sep|><|open|>argument key="{key}" type="string"<|sep|>'
        f"{value}<|close|>argument<|sep|><|close|>call<|sep|>"
    )


def _envelope(*calls: str) -> str:
    return "<|open|>tools<|sep|>" + "".join(calls) + "<|close|>tools<|sep|><|close|>message<|sep|>"


# Kimi also calls a step as if it were a tool of its own, under several names.
@pytest.mark.parametrize("tool", ["search_web", "aperture-search_web", "web_search", "Search_Web"])
def test_a_step_called_as_its_own_tool_is_read_as_that_step(tool: str) -> None:
    reply = _envelope(_call(tool, "query", "Missouri Revisor 516.110 official"))

    assert whole_turn_steps(as_fenced_blocks(reply))[0] == (Step("search_web", "Missouri Revisor 516.110 official"),)


def test_several_calls_in_one_envelope_become_one_round_of_steps_in_order() -> None:
    reply = _envelope(
        _call("aperture-search_web", "query", "Kansas 60-511"),
        _call("aperture-read_page", "url", "https://www.ksrevisor.gov/statutes/chapters/ch84/084_002_0725.html"),
        _call("calculate", "expression", "2450000 * 0.18"),
    )

    assert whole_turn_steps(as_fenced_blocks(reply))[0] == (
        Step("search_web", "Kansas 60-511"),
        Step("read_page", "https://www.ksrevisor.gov/statutes/chapters/ch84/084_002_0725.html"),
        Step("calculate", "2450000 * 0.18"),
    )


def test_a_call_the_platform_does_not_know_becomes_a_step_it_can_refuse() -> None:
    """The reader is never shown the markup: the model is told the step is not
    available and goes on to answer."""
    reply = _envelope(_call("search_web", "query", "Kansas 60-511"), _call("get_weather", "city", "Paris"))

    assert whole_turn_steps(as_fenced_blocks(reply))[0] == (
        Step("search_web", "Kansas 60-511"),
        Step("get_weather", "Paris"),
    )


def test_steps_handed_over_as_text_under_a_made_up_tool_name_are_still_read() -> None:
    steps = json.dumps({"steps": [{"do": "search_web", "query": "Missouri Supreme Court judges"}]})
    reply = _envelope(_call("seeevidence", "content", steps))

    assert whole_turn_steps(as_fenced_blocks(reply))[0] == (Step("search_web", "Missouri Supreme Court judges"),)


def test_a_step_named_in_one_word_with_extra_arguments_is_read_by_what_it_looks_for() -> None:
    reply = _envelope(
        '<|open|>call tool="WebSearch" index="1"<|sep|>'
        '<|open|>argument key="type" type="string"<|sep|>search<|close|>argument<|sep|>'
        '<|open|>argument key="query" type="string"<|sep|>Missouri Supreme Court judges<|close|>argument<|sep|>'
        "<|close|>call<|sep|>"
    )

    assert whole_turn_steps(as_fenced_blocks(reply))[0] == (Step("search_web", "Missouri Supreme Court judges"),)


def test_a_list_of_steps_that_is_not_valid_json_is_refused_rather_than_shown() -> None:
    reply = _envelope(
        '<|open|>call tool="aperture-steps" index="1"<|sep|><|open|>argument key="steps" type="array"<|sep|>'
        '[{"do": "search_web", <|close|>argument<|sep|><|close|>call<|sep|>'
    )

    steps = whole_turn_steps(as_fenced_blocks(reply))[0]

    assert steps is not None
    assert [step.kind for step in steps] == ["aperture-steps"]


@pytest.mark.parametrize("tool", ["aperture-steps", "search_web"])
def test_a_call_that_gives_nothing_to_look_for_is_refused_rather_than_shown_or_run(tool: str) -> None:
    reply = _envelope(f'<|open|>call tool="{tool}" index="1"<|sep|><|close|>call<|sep|>')

    steps = whole_turn_steps(as_fenced_blocks(reply))[0]

    assert steps is not None
    assert [step.kind for step in steps] == [f"{tool} with nothing to look for"]


# Mistral on Azure AI Foundry makes the same request as a real tool call: the
# provider parses it, so it arrives beside the reply text, not in it.
def _provider_call(name: str, arguments: object) -> dict[str, str]:
    return {"name": name, "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments)}


def test_a_tool_call_the_provider_parsed_ends_the_streamed_turn_as_its_block() -> None:
    calls = [_provider_call("aperture-steps", {"steps": [{"do": "search_web", "query": "Kansas 60-511"}]})]

    turn = "".join(fenced_native_calls(["Checking the statutes."], provider_calls=lambda: calls))

    assert turn.startswith("Checking the statutes.\n```aperture-steps\n")
    assert whole_turn_steps(turn)[0] == (Step("search_web", "Kansas 60-511"),)


def test_a_turn_that_is_only_a_parsed_tool_call_is_only_its_block() -> None:
    calls = [_provider_call("web_search", {"query": "Kansas 60-511"}), _provider_call("calculate", {"expression": "2 + 2"})]

    turn = "".join(fenced_native_calls([], provider_calls=lambda: calls))

    assert turn.startswith("```aperture-steps\n")
    assert whole_turn_steps(turn)[0] == (Step("search_web", "Kansas 60-511"), Step("calculate", "2 + 2"))


def test_a_parsed_tool_call_with_arguments_that_are_not_json_is_refused_rather_than_dropped() -> None:
    calls = [_provider_call("aperture-steps", '{"steps": [')]

    steps = whole_turn_steps("".join(fenced_native_calls([], provider_calls=lambda: calls)))[0]

    assert steps is not None
    assert [step.kind for step in steps] == ["aperture-steps"]


def test_a_stream_with_no_parsed_tool_calls_is_unchanged() -> None:
    assert list(fenced_native_calls(["The answer."], provider_calls=lambda: None)) == ["The answer."]


def test_a_whole_reply_that_is_a_parsed_tool_call_reads_as_its_block() -> None:
    from app.core.native_call_markup import completion_with_fenced_blocks

    call = {"id": "a", "type": "function", "function": {"name": "aperture-steps", "arguments": json.dumps({"steps": [{"do": "calculate", "expression": "2 + 2"}]})}}
    payload = {"choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [call]}, "finish_reason": "tool_calls"}]}

    message = completion_with_fenced_blocks(payload)["choices"][0]["message"]

    assert whole_turn_steps(message["content"])[0] == (Step("calculate", "2 + 2"),)


def test_tool_calls_a_caller_asked_for_are_left_for_the_caller() -> None:
    from app.core.native_call_markup import completion_with_fenced_blocks

    call = {"id": "a", "type": "function", "function": {"name": "get_weather", "arguments": '{"city": "Paris"}'}}
    payload = {"choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [call]}}]}

    message = completion_with_fenced_blocks(payload, caller_tools=True)["choices"][0]["message"]

    assert message["content"] is None
    assert message["tool_calls"] == [call]


# What a step looks for is text, whatever it looks like.
@pytest.mark.parametrize("looked_for", ["2026", "true", "42", '"quoted"'])
def test_a_search_for_something_that_reads_as_json_is_still_a_search(looked_for: str) -> None:
    reply = _envelope(_call("search_web", "query", looked_for))

    assert whole_turn_steps(as_fenced_blocks(reply))[0] == (Step("search_web", looked_for),)


def test_a_parsed_call_with_a_number_to_work_out_is_taken() -> None:
    calls = [_provider_call("calculate", {"expression": 42})]

    assert whole_turn_steps("".join(fenced_native_calls([], provider_calls=lambda: calls)))[0] == (
        Step("calculate", "42"),
    )


def test_a_parsed_call_that_hands_its_steps_over_as_text_is_read() -> None:
    steps = json.dumps([{"do": "search_web", "query": "Kansas 60-511"}])
    calls = [_provider_call("aperture-steps", {"steps": steps})]

    assert whole_turn_steps("".join(fenced_native_calls([], provider_calls=lambda: calls)))[0] == (
        Step("search_web", "Kansas 60-511"),
    )


# A fence opens a block only at the start of a line, and a blank line before it
# is noise in the reply, so each rewrite puts the block on a line of its own
# exactly once.
def test_a_call_already_on_a_line_of_its_own_gets_no_blank_line_before_it() -> None:
    assert as_fenced_blocks("Checking the statutes.\n" + KIMI_STEPS).startswith(
        "Checking the statutes.\n```aperture-steps\n"
    )


def test_a_call_at_the_start_of_a_piece_looks_at_the_reply_before_it() -> None:
    assert as_fenced_blocks(KIMI_STEPS, after="Checking.\n").startswith("```aperture-steps\n")
    assert as_fenced_blocks(KIMI_STEPS, after="Checking.").startswith("\n```aperture-steps\n")


def test_a_streamed_call_after_a_finished_line_gets_no_blank_line_before_it() -> None:
    turn = "".join(fenced_native_calls(["Checking the statutes.\n", KIMI_STEPS]))

    assert turn.startswith("Checking the statutes.\n```aperture-steps\n")


def test_a_parsed_call_after_a_rewritten_block_starts_on_the_next_line() -> None:
    calls = [_provider_call("calculate", {"expression": "2 + 2"})]

    turn = "".join(fenced_native_calls([KIMI_STEPS], provider_calls=lambda: calls))

    assert turn.count("```aperture-steps\n") == 2
    assert "\n\n```aperture-steps" not in turn


@pytest.mark.parametrize(
    ("content", "expected_start"),
    [("Checking.\n", "Checking.\n```aperture-steps\n"), ("Checking.", "Checking.\n```aperture-steps\n")],
)
def test_a_whole_reply_puts_a_parsed_call_on_a_line_of_its_own(content: str, expected_start: str) -> None:
    from app.core.native_call_markup import completion_with_fenced_blocks

    call = {"id": "a", "type": "function", "function": {"name": "calculate", "arguments": '{"expression": "2 + 2"}'}}
    payload = {"choices": [{"message": {"role": "assistant", "content": content, "tool_calls": [call]}}]}

    message = completion_with_fenced_blocks(payload)["choices"][0]["message"]

    assert message["content"].startswith(expected_start)
    assert "tool_calls" not in message


def test_a_whole_reply_skips_tool_call_entries_that_are_not_calls() -> None:
    from app.core.native_call_markup import completion_with_fenced_blocks

    call = {"id": "a", "type": "function", "function": {"name": "calculate", "arguments": '{"expression": "2 + 2"}'}}
    junk: list[object] = ["not a call", {"id": "b", "function": "not a function"}, call]
    payload = {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": junk}}]}

    message = completion_with_fenced_blocks(payload)["choices"][0]["message"]

    assert whole_turn_steps(message["content"])[0] == (Step("calculate", "2 + 2"),)


@pytest.mark.parametrize("arguments", [{"verbose": True}, {"query": ""}])
def test_a_call_whose_only_argument_is_a_switch_or_empty_has_nothing_to_look_for(arguments: dict[str, object]) -> None:
    calls = [_provider_call("search_web", arguments)]

    steps = whole_turn_steps("".join(fenced_native_calls([], provider_calls=lambda: calls)))[0]

    assert steps is not None
    assert [step.kind for step in steps] == ["search_web with nothing to look for"]
