"""Exact arithmetic for replies that must get a figure right."""

from __future__ import annotations

import pytest

from app.core.calculator import CalculationError, calculate


@pytest.mark.parametrize(
    ("expression", "answer"),
    [
        ("1250000 * 0.065 / 12", "6,770.8333333333"),
        ("2 + 3 * 4", "14"),
        ("(2 + 3) * 4", "20"),
        ("0.1 + 0.2", "0.3"),
        ("10 / 4", "2.5"),
        ("7 // 2", "3"),
        ("7 % 4", "3"),
        ("-5 + 2", "-3"),
        ("+5", "5"),
        ("2 ** 10", "1,024"),
        ("1_000_000 * 3", "3,000,000"),
        ("1.50 * 2", "3"),
        ("1e3 + 1", "1,001"),
        ("10 % 4", "2"),
        ("-7 % 4", "1"),
        ("-7 // 2", "-4"),
        ("0 ** 0.5", "0"),
        ("0.25 ** 0.5", "0.5"),
        ("(-2) ** 3", "-8"),
        ("10 ** 29", "100,000,000,000,000,000,000,000,000,000"),
    ],
)
def test_arithmetic_is_exact_and_grouped_for_reading(expression: str, answer: str) -> None:
    assert calculate(expression) == answer


@pytest.mark.parametrize(
    ("expression", "answer"),
    [
        ("round(2.675, 2)", "2.68"),
        ("round(1234.5)", "1,235"),
        ("abs(-12.5)", "12.5"),
        ("min(3, 1, 2)", "1"),
        ("max(3, 1, 2)", "3"),
        ("sum(1.1, 2.2, 3.3)", "6.6"),
        ("avg(10, 20, 60)", "30"),
        ("sqrt(144)", "12"),
        ("sqrt(0)", "0"),
        ("sqrt(0.25)", "0.5"),
        ("round(1234.5, -2)", "1,200"),
        ("pow(2, 8)", "256"),
        ("(1500000 / 1000000) ** (1 / 5) - 1", "0.0844717712"),
    ],
)
def test_the_named_functions_work_on_figures(expression: str, answer: str) -> None:
    assert calculate(expression) == answer


def test_a_fractional_power_keeps_ten_decimal_places() -> None:
    assert calculate("2 ** 0.5") == "1.4142135624"


@pytest.mark.parametrize(
    ("expression", "reason"),
    [
        ("", "empty"),
        ("   ", "empty"),
        ("1 / 0", "divide by zero"),
        ("7 % 0", "divide by zero"),
        ("7 // 0", "divide by zero"),
        ("2 +", "not a calculation"),
        ("__import__('os').system('id')", "not allowed"),
        ("x * 2", "not allowed"),
        ("'a' * 3", "not allowed"),
        ("[1, 2]", "not allowed"),
        ("(1).real", "not allowed"),
        ("15%", "not a calculation"),
        ("sqrt(-1)", "negative"),
        ("round(1.5, 2.5)", "whole number"),
        ("unknown(3)", "not allowed"),
        ("abs()", "needs"),
        ("sqrt(1, 2)", "needs"),
        ("avg()", "needs"),
        ("min()", "needs"),
        ("max(key=1)", "not allowed"),
        ("1 if 2 else 3", "not allowed"),
        ("True + 1", "not allowed"),
        ("9 ** 9 ** 9", "too large"),
        ("10 ** 5000", "too large"),
        ("(-8) ** 0.5", "negative"),
        ("1" + " + 1" * 200, "too long"),
    ],
)
def test_anything_that_is_not_plain_arithmetic_is_refused_with_the_reason(expression: str, reason: str) -> None:
    with pytest.raises(CalculationError, match=reason):
        calculate(expression)


@pytest.mark.parametrize(
    ("expression", "message"),
    [
        ("unknown(3)", "'unknown' is not allowed."),
        ("max(key=1)", "That call is not allowed."),
        ("(1)(2)", "That call is not allowed."),
        ("abs()", "abs needs exactly 1 value."),
        ("pow(2)", "pow needs exactly 2 values."),
        ("round(1, 2, 3)", "round needs 1 or 2 values."),
        ("avg()", "avg needs at least 1 value."),
    ],
)
def test_a_refused_call_says_exactly_what_is_wrong(expression: str, message: str) -> None:
    with pytest.raises(CalculationError) as refused:
        calculate(expression)

    assert str(refused.value).startswith(message)


def test_the_deepest_nesting_the_length_limit_allows_is_still_worked_out() -> None:
    assert calculate("(" * 120 + "1" + ")" * 120) == "1"
    assert calculate("-" * 299 + "1") == "-1"


def test_spacing_does_not_count_toward_the_length_limit_or_change_the_answer() -> None:
    assert calculate("  2   +\n 2  ") == "4"


def test_a_result_that_rounds_to_zero_is_shown_as_zero() -> None:
    assert calculate("-0.00000000001") == "0"
    assert calculate("0 * -1") == "0"
