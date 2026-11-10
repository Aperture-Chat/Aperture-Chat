"""A word count in a request is a floor or a ceiling, and the two are not the same."""

from __future__ import annotations

import pytest

from app.core.directives import Directive, directive_prompt_block, directive_results, extract_directives


def _word_rules(prompt: str) -> list[tuple[str, str]]:
    return [
        (directive.id, directive.label)
        for directive in extract_directives(prompt)
        if directive.id.startswith(("words:", "maxwords:"))
    ]


@pytest.mark.parametrize(
    "prompt",
    [
        "Summarize the lease in under 50 words.",
        "Summarize the lease in fewer than 50 words.",
        "Summarize the lease in less than 50 words.",
        "Summarize the lease in no more than 50 words.",
        "Summarize the lease in not more than 50 words.",
        "Summarize the lease in at most 50 words.",
        "Summarize the lease, maximum 50 words.",
        "Summarize the lease, max of 50 words.",
        "Summarize the lease in up to 50 words.",
        "Summarize the lease within 50 words.",
        "Keep the summary to 50 words.",
        "Keep it under 50 words please.",
        "Summarize the lease in 50 words or less.",
        "Summarize the lease in 50 words or fewer.",
        "Summarize the lease: 50 words max.",
        "Summarize the lease in 50 words at most.",
        "Limit the summary to 50 words.",
        "A 50-word maximum applies to the summary.",
    ],
)
def test_a_ceiling_is_read_as_a_ceiling(prompt: str) -> None:
    assert _word_rules(prompt) == [("maxwords:50", "Use no more than 50 words")]


@pytest.mark.parametrize(
    ("prompt", "rule"),
    [
        ("Write at least 500 words on force majeure.", ("words:500", "Write at least 500 words")),
        ("Write a 500-word memo on force majeure.", ("words:500", "Write at least 500 words")),
        ("Write 500 words on force majeure.", ("words:500", "Write at least 500 words")),
        ("Write no fewer than 500 words on force majeure.", ("words:500", "Write at least 500 words")),
        ("Write not less than 500 words on force majeure.", ("words:500", "Write at least 500 words")),
    ],
)
def test_a_floor_is_still_read_as_a_floor(prompt: str, rule: tuple[str, str]) -> None:
    assert _word_rules(prompt) == [rule]


def test_a_short_ceiling_counts_even_though_a_floor_that_small_would_not() -> None:
    assert _word_rules("Answer in under 20 words.") == [("maxwords:20", "Use no more than 20 words")]
    assert _word_rules("Answer in 20 words.") == []


def test_a_single_digit_is_not_a_word_limit() -> None:
    assert _word_rules("Answer in under 5 words.") == []


def test_a_reply_within_the_ceiling_meets_it_and_a_longer_one_does_not() -> None:
    directives = extract_directives("Summarize the lease in under 10 words.")

    short = directive_results(directives, "Tenant may renew once on ninety days notice.")
    exact = directive_results(directives, "one two three four five six seven eight nine ten")
    long = directive_results(directives, "one two three four five six seven eight nine ten eleven")

    assert short == [("maxwords:10", "Use no more than 10 words", True)]
    assert exact == [("maxwords:10", "Use no more than 10 words", True)]
    assert long == [("maxwords:10", "Use no more than 10 words", False)]


def test_the_model_is_told_the_ceiling_not_a_floor() -> None:
    block = directive_prompt_block(extract_directives("Summarize the lease in under 50 words."))

    assert "no more than 50 words" in block
    assert "at least 50 words" not in block


def test_a_page_count_tells_the_model_roughly_how_many_words_that_is() -> None:
    directive = next(d for d in extract_directives("Write a 3-page memo on force majeure.") if d.id == "pages:3")

    assert directive.label == "Write 3 pages of content"
    assert "roughly 1050 words" in directive.instruction


def test_a_ceiling_with_no_number_allows_no_words_at_all() -> None:
    unnumbered = Directive(id="maxwords:unknown", label="Use no more than ? words", instruction="")

    assert directive_results([unnumbered], "one") == [("maxwords:unknown", "Use no more than ? words", False)]
    assert directive_results([unnumbered], "") == [("maxwords:unknown", "Use no more than ? words", True)]
