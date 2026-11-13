from __future__ import annotations

import pytest

from app.core.provider_filter import (
    MAX_FILTER_RETRIES,
    STAND_IN_REPLY,
    after_unshown_turn,
    StandInGate,
    filter_reported,
    is_stand_in,
    withheld,
)


@pytest.mark.parametrize("reason", ["content_filter", " Content_Filter "])
def test_a_content_filter_finish_is_a_withheld_turn(reason: str) -> None:
    assert filter_reported(reason)
    assert withheld(reason, "Half of a real answer")


@pytest.mark.parametrize("reason", ["stop", "length", "", None])
def test_other_finishes_are_not_reported_as_filtered(reason: object) -> None:
    assert not filter_reported(reason)
    assert not withheld(reason, "A real answer.")


@pytest.mark.parametrize(
    "text",
    [
        STAND_IN_REPLY,
        "I’m sorry, but I cannot assist with that request.",
        "  i'm sorry,  but I cannot assist with that request.\n",
    ],
)
def test_the_stand_in_alone_is_a_withheld_turn_whatever_the_finish(text: str) -> None:
    assert is_stand_in(text)
    assert withheld("stop", text)


@pytest.mark.parametrize(
    "text",
    [
        "I'm sorry, but I cannot assist with that request. Here is why: the file is missing.",
        "I'm sorry, but I cannot assist",
        "",
    ],
)
def test_text_that_only_resembles_the_stand_in_is_the_models_own(text: str) -> None:
    assert not is_stand_in(text)


@pytest.mark.parametrize(
    ("pieces", "shown", "opened"),
    [
        # The stand-in is held however it is split.
        (("I'm sorry, ", "but I cannot assist ", "with that request."), ["", "", ""], False),
        # A reply is let through at the first word that differs.
        (
            ("I'm sorry, but I cannot ", "find that file.", " Try another."),
            ["", "I'm sorry, but I cannot find that file.", " Try another."],
            True,
        ),
    ],
)
def test_gate_holds_only_what_could_still_be_the_stand_in(
    pieces: tuple[str, ...], shown: list[str], opened: bool
) -> None:
    gate = StandInGate()

    assert [gate.feed(piece) for piece in pieces] == shown
    assert gate.opened is opened


def test_gate_lets_an_ordinary_reply_through_at_once() -> None:
    gate = StandInGate()

    assert gate.feed("The answer is 4.") == "The answer is 4."
    assert gate.feed(" Next.") == " Next."


def test_release_hands_back_what_was_held_once() -> None:
    gate = StandInGate()
    gate.feed("I'm sorry, but")

    assert gate.release() == "I'm sorry, but"
    assert gate.release() == ""
    assert gate.feed(" more") == " more"


def test_a_turn_that_was_not_withheld_is_delivered() -> None:
    assert after_unshown_turn("stop", "I'm sorry", 0) == "deliver"
    assert after_unshown_turn("stop", "", MAX_FILTER_RETRIES) == "deliver"


@pytest.mark.parametrize("retries", range(MAX_FILTER_RETRIES))
def test_a_withheld_turn_is_asked_again_while_tries_remain(retries: int) -> None:
    assert after_unshown_turn("content_filter", "", retries) == "ask_again"
    assert after_unshown_turn("stop", STAND_IN_REPLY, retries) == "ask_again"


def test_a_turn_reported_filtered_on_the_last_try_fails() -> None:
    assert after_unshown_turn("content_filter", STAND_IN_REPLY, MAX_FILTER_RETRIES) == "fail"
    assert after_unshown_turn("content_filter", "", MAX_FILTER_RETRIES) == "fail"


def test_the_stand_in_words_without_a_filter_report_are_delivered_on_the_last_try() -> None:
    assert after_unshown_turn("stop", STAND_IN_REPLY, MAX_FILTER_RETRIES) == "deliver"
