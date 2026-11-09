"""The assistant can pause a reply to ask the user multiple-choice questions."""

from __future__ import annotations

import json

import pytest

from app.core.clarifying_questions import (
    AskGate,
    AskOption,
    AskQuestion,
    clarify_prompt_line,
    parse_ask_block,
    split_reply,
)

BLOCK = {
    "questions": [
        {
            "question": "Which state's law applies?",
            "options": ["California", {"label": "New York", "detail": "Where the contract was signed"}],
            "recommended": "New York",
        },
        {"question": "Who will read it?", "options": ["The client", "Opposing counsel", "A judge"], "multiple": True},
    ]
}


def _fenced(payload: object, lead: str = "Two quick questions first.\n\n") -> str:
    return f"{lead}```aperture-ask\n{json.dumps(payload)}\n```\n"


def test_a_block_parses_into_questions_with_options_and_a_recommendation() -> None:
    block = parse_ask_block(json.dumps(BLOCK))

    assert block is not None
    assert block.questions == (
        AskQuestion(
            id="q1",
            question="Which state's law applies?",
            options=(AskOption("California"), AskOption("New York", "Where the contract was signed")),
            multiple=False,
            recommended=1,
        ),
        AskQuestion(
            id="q2",
            question="Who will read it?",
            options=(AskOption("The client"), AskOption("Opposing counsel"), AskOption("A judge")),
            multiple=True,
            recommended=None,
        ),
    )


def test_the_wire_payload_carries_the_lead_in_and_each_question() -> None:
    block = parse_ask_block(json.dumps(BLOCK), intro="Two quick questions first.")

    assert block is not None
    assert block.payload() == {
        "intro": "Two quick questions first.",
        "questions": [
            {
                "id": "q1",
                "question": "Which state's law applies?",
                "options": [{"label": "California"}, {"label": "New York", "detail": "Where the contract was signed"}],
                "multiple": False,
                "recommended": 1,
            },
            {
                "id": "q2",
                "question": "Who will read it?",
                "options": [{"label": "The client"}, {"label": "Opposing counsel"}, {"label": "A judge"}],
                "multiple": True,
                "recommended": None,
            },
        ],
    }


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        "[]",
        json.dumps({"questions": []}),
        json.dumps({"questions": [{"question": "Pick one", "options": ["Only choice"]}]}),
        json.dumps({"questions": [{"question": "  ", "options": ["A", "B"]}]}),
        json.dumps({"questions": "Which one?"}),
        json.dumps({"questions": ["Which one?"]}),
    ],
)
def test_a_block_without_a_usable_question_is_not_a_pause(raw: str) -> None:
    assert parse_ask_block(raw) is None


def test_a_bare_list_of_questions_is_accepted() -> None:
    block = parse_ask_block(json.dumps(BLOCK["questions"]))

    assert block is not None
    assert [question.id for question in block.questions] == ["q1", "q2"]


def test_questions_and_options_are_capped_deduplicated_and_trimmed() -> None:
    many = {
        "questions": [
            {"question": f"Question {n}?", "options": ["A", "a ", "B", "C", "D", "E", "F", "", 7]} for n in range(5)
        ]
    }
    block = parse_ask_block(json.dumps(many))

    assert block is not None
    assert len(block.questions) == 3
    assert [option.label for option in block.questions[0].options] == ["A", "B", "C", "D", "E"]


def test_long_text_is_shortened_with_an_ellipsis() -> None:
    long = {"questions": [{"question": "Q" * 400, "options": ["x" * 300, "B"]}]}
    block = parse_ask_block(json.dumps(long))

    assert block is not None
    assert len(block.questions[0].question) == 300
    assert block.questions[0].question.endswith("…")
    assert len(block.questions[0].options[0].label) == 120


def test_a_recommendation_may_be_an_index_and_a_bad_one_is_ignored() -> None:
    by_index = parse_ask_block(json.dumps({"questions": [{"question": "Q?", "options": ["A", "B"], "recommended": 1}]}))
    unknown = parse_ask_block(json.dumps({"questions": [{"question": "Q?", "options": ["A", "B"], "recommended": "Z"}]}))
    out_of_range = parse_ask_block(json.dumps({"questions": [{"question": "Q?", "options": ["A", "B"], "recommended": 9}]}))

    assert by_index is not None and by_index.questions[0].recommended == 1
    assert unknown is not None and unknown.questions[0].recommended is None
    assert out_of_range is not None and out_of_range.questions[0].recommended is None


def test_every_text_can_be_screened_in_one_pass() -> None:
    block = parse_ask_block(json.dumps(BLOCK), intro="Before I start")

    assert block is not None
    screened = block.map_text(str.upper)
    assert screened.intro == "BEFORE I START"
    assert screened.questions[0].question == "WHICH STATE'S LAW APPLIES?"
    assert screened.questions[0].options[1] == AskOption("NEW YORK", "WHERE THE CONTRACT WAS SIGNED")


def test_a_finished_reply_splits_into_its_lead_in_and_the_questions() -> None:
    split = split_reply(_fenced(BLOCK) + "Let me know!")

    assert split.block is not None
    assert split.block.intro == "Two quick questions first."
    assert split.text == "Two quick questions first."
    assert [question.id for question in split.block.questions] == ["q1", "q2"]


def test_a_reply_without_a_block_or_with_a_broken_one_stays_as_written() -> None:
    plain = "Here is the answer.\n\n```python\nprint(1)\n```\n"
    broken = "Hmm.\n\n```aperture-ask\n{not json\n```\n"

    assert split_reply(plain).text == plain
    assert split_reply(plain).block is None
    assert split_reply(broken).text == broken
    assert split_reply(broken).block is None


def test_a_block_cut_off_before_its_closing_fence_still_parses() -> None:
    split = split_reply(f"```aperture-ask\n{json.dumps(BLOCK)}")

    assert split.block is not None
    assert split.text == ""


def _stream(gate: AskGate, chunks: list[str]) -> str:
    shown = "".join(gate.feed(chunk) for chunk in chunks)
    return shown + gate.finish()


def test_the_stream_shows_the_lead_in_and_holds_back_the_block() -> None:
    gate = AskGate()
    reply = _fenced(BLOCK)
    chunks = [reply[index : index + 3] for index in range(0, len(reply), 3)]

    shown = _stream(gate, chunks)

    assert shown == "Two quick questions first.\n\n"
    assert gate.block is not None
    assert gate.block.intro == "Two quick questions first."


def test_ordinary_code_fences_and_inline_code_stream_through_untouched() -> None:
    gate = AskGate()
    reply = "Use `x` here.\n\n```python\nprint('``')\n```\n~~~\nplain\n~~~\nDone."
    chunks = [reply[index : index + 2] for index in range(0, len(reply), 2)]

    assert _stream(gate, chunks) == reply
    assert gate.block is None


def test_text_that_only_looks_like_the_start_of_a_block_is_released_when_it_turns_out_not_to_be() -> None:
    gate = AskGate()

    assert gate.feed("Intro\n```aper") == "Intro\n"
    assert gate.feed("ture-diagram\n{}") == "```aperture-diagram\n{}"
    assert gate.finish() == ""


def test_a_held_partial_line_is_released_when_the_stream_ends() -> None:
    gate = AskGate()

    assert gate.feed("Answer\n``") == "Answer\n"
    assert gate.finish() == "``"


def test_a_broken_block_falls_back_to_showing_what_was_held() -> None:
    gate = AskGate()

    shown = _stream(gate, ["Intro\n\n```aperture-ask\n", "{oops\n", "```\n"])

    assert shown == "Intro\n\n```aperture-ask\n{oops\n```\n"
    assert gate.block is None


def test_a_disabled_gate_passes_everything_straight_through() -> None:
    gate = AskGate(enabled=False)
    reply = _fenced(BLOCK)

    assert _stream(gate, [reply]) == reply
    assert gate.block is None


def test_the_prompt_explains_how_and_when_to_ask() -> None:
    line = clarify_prompt_line("ask")

    assert line is not None
    assert "```aperture-ask" in line
    assert "at most 3" in line


def test_the_prompt_tells_the_model_to_decide_or_to_finish_after_answers() -> None:
    decide = clarify_prompt_line("decide")
    answered = clarify_prompt_line("answered")

    assert decide is not None and "Do not stop to ask" in decide
    assert answered is not None and "do not ask again" in answered
    assert clarify_prompt_line(None) is None


def test_text_at_the_limit_is_kept_whole() -> None:
    exact = {"questions": [{"question": "Q" * 300, "options": ["x" * 120, "B"]}]}
    block = parse_ask_block(json.dumps(exact))

    assert block is not None
    assert block.questions[0].question == "Q" * 300
    assert block.questions[0].options[0].label == "x" * 120


@pytest.mark.parametrize(("recommended", "expected"), [(0, 0), (2, None), (-1, None), (True, None)])
def test_a_recommendation_by_position_must_name_one_of_the_options(recommended: object, expected: int | None) -> None:
    raw = {"questions": [{"question": "Q?", "options": ["A", "B"], "recommended": recommended}]}
    block = parse_ask_block(json.dumps(raw))

    assert block is not None
    assert block.questions[0].recommended == expected


def test_the_indentation_before_a_block_is_never_shown() -> None:
    gate = AskGate()

    assert gate.feed("Intro\n  ") == "Intro\n"
    assert gate.feed(f"```aperture-ask\n{json.dumps(BLOCK)}\n```\n") == ""
    assert gate.finish() == ""
    assert gate.block is not None


def test_two_backticks_and_more_text_cannot_open_a_block() -> None:
    gate = AskGate()

    assert gate.feed("Use\n``a") == "Use\n``a"
