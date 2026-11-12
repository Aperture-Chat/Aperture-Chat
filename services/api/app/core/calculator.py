"""Exact arithmetic for a reply that has to get a figure right.

Language models are unreliable at arithmetic, and a wrong figure in a
settlement memo or a budget is costly. A reply can ask for a calculation as a
research step; this module works it out with decimal arithmetic, so
``0.1 + 0.2`` is ``0.3``.

Only plain arithmetic is accepted: numbers, ``+ - * / // % **``, parentheses,
and a short list of named functions. The expression is parsed, never
executed, so names, attributes, strings, and calls to anything else are
refused.
"""

from __future__ import annotations

import ast
import operator
from collections.abc import Callable, Mapping, Sequence
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Context, Decimal, DecimalException, localcontext
from typing import NoReturn

MAX_EXPRESSION_CHARS = 300
# Enough digits for money at any scale; answers are shown to ten places.
_PRECISION = 40
_SHOWN_PLACES = Decimal("1e-10")
_EXAMPLE = "1250000 * 0.065 / 12"


class CalculationError(ValueError):
    """The expression cannot be worked out; the message says why, in plain words."""


def _refuse(reason: str) -> NoReturn:
    raise CalculationError(reason)


def _not_allowed(what: str) -> NoReturn:
    _refuse(
        f"{what} is not allowed. Use only numbers, + - * / // % **, parentheses, and "
        f"{', '.join(sorted(_FUNCTIONS))}."
    )


def _divisor(value: Decimal) -> Decimal:
    return value if value != 0 else _refuse("Cannot divide by zero.")


def _floor_divide(left: Decimal, right: Decimal) -> Decimal:
    return (left / _divisor(right)).to_integral_value(rounding=ROUND_FLOOR)


def _modulo(left: Decimal, right: Decimal) -> Decimal:
    return left - right * _floor_divide(left, right)


def _is_whole(value: Decimal) -> bool:
    return value == value.to_integral_value()


def _power(base: Decimal, exponent: Decimal) -> Decimal:
    # Working precision is fixed, so a huge power costs little: it overflows
    # or fails to show, and either way is reported as too large.
    if base < 0 and not _is_whole(exponent):
        _refuse("A negative number cannot be raised to a fractional power.")
    return base**exponent


def _round(value: Decimal, places: Decimal = Decimal(0)) -> Decimal:
    # Infinity equals its own integral value, so it has to be ruled out by name.
    if not places.is_finite() or not _is_whole(places):
        _refuse("round needs a whole number of decimal places.")
    return value.quantize(Decimal(f"1e{-int(places)}"), rounding=ROUND_HALF_UP)


def _sqrt(value: Decimal) -> Decimal:
    if value < 0:
        _refuse("The square root of a negative number is not a real number.")
    return value.sqrt()


def _average(*values: Decimal) -> Decimal:
    return sum(values, Decimal(0)) / len(values)


# name -> (fewest values, most values or None for any number, the function)
_FUNCTIONS: dict[str, tuple[int, int | None, Callable[..., Decimal]]] = {
    "abs": (1, 1, abs),
    "avg": (1, None, _average),
    "max": (1, None, max),
    "min": (1, None, min),
    "pow": (2, 2, _power),
    "round": (1, 2, _round),
    "sqrt": (1, 1, _sqrt),
    "sum": (1, None, lambda *values: sum(values, Decimal(0))),
}

_BINARY: dict[type[ast.operator], Callable[[Decimal, Decimal], Decimal]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: lambda left, right: left / _divisor(right),
    ast.FloorDiv: _floor_divide,
    ast.Mod: _modulo,
    ast.Pow: _power,
}

_UNARY: dict[type[ast.unaryop], Callable[[Decimal], Decimal]] = {
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _number(node: ast.Constant) -> Decimal:
    value = node.value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _not_allowed(f"{value!r}")
    # str() of a float is its shortest exact spelling, so 0.065 stays 0.065.
    return Decimal(str(value))


def _operation(table: Mapping[type, Callable[..., Decimal]], operator_node: ast.AST) -> Callable[..., Decimal]:
    apply = table.get(type(operator_node))
    if apply is None:
        _not_allowed("That operator")
    return apply


def _binary(node: ast.BinOp) -> Decimal:
    return _operation(_BINARY, node.op)(_value(node.left), _value(node.right))


def _unary(node: ast.UnaryOp) -> Decimal:
    return _operation(_UNARY, node.op)(_value(node.operand))


def _argument_count(fewest: int, most: int | None) -> str:
    if most is None:
        return f"at least {fewest} value"
    return f"exactly {fewest} value{'s' if fewest != 1 else ''}" if fewest == most else f"{fewest} or {most} values"


def _call(node: ast.Call) -> Decimal:
    name = node.func.id if isinstance(node.func, ast.Name) else ""
    if name not in _FUNCTIONS or node.keywords:
        _not_allowed(f"'{name}'" if name and not node.keywords else "That call")
    fewest, most, function = _FUNCTIONS[name]
    if len(node.args) < fewest or (most is not None and len(node.args) > most):
        _refuse(f"{name} needs {_argument_count(fewest, most)}.")
    return function(*(_value(argument) for argument in node.args))


def _named(node: ast.Name) -> NoReturn:
    _not_allowed(f"'{node.id}'")


_EVALUATORS: dict[type[ast.expr], Callable[..., Decimal]] = {
    ast.Constant: _number,
    ast.BinOp: _binary,
    ast.UnaryOp: _unary,
    ast.Call: _call,
    ast.Name: _named,
}


def _value(node: ast.expr) -> Decimal:
    evaluate = _EVALUATORS.get(type(node))
    if evaluate is None:
        _not_allowed("That")
    return evaluate(node)


def _parsed(expression: str) -> ast.expr:
    try:
        return ast.parse(expression, mode="eval").body
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        _refuse(f"That is not a calculation. Write plain arithmetic such as {_EXAMPLE}, and write 15% as 0.15.")


def _shown(value: Decimal) -> str:
    """Ten decimal places at most, no trailing zeros, thousands grouped."""
    rounded = value.quantize(_SHOWN_PLACES, rounding=ROUND_HALF_UP)
    whole, _, fraction = f"{rounded:,f}".partition(".")
    fraction = fraction.rstrip("0")
    text = f"{whole}.{fraction}" if fraction else whole
    return "0" if text in {"-0", ""} else text


def _within_limits(parts: Sequence[str]) -> str:
    expression = " ".join(parts)
    if not expression:
        _refuse("The expression is empty.")
    if len(expression) > MAX_EXPRESSION_CHARS:
        _refuse(f"The expression is too long; keep it under {MAX_EXPRESSION_CHARS} characters.")
    return expression


def calculate(expression: str) -> str:
    """The value of an arithmetic expression, as text ready to quote.

    Raises ``CalculationError`` with a plain reason when the expression is not
    arithmetic this module accepts, or cannot be worked out.
    """
    tree = _parsed(_within_limits(expression.split()))
    try:
        with localcontext(Context(prec=_PRECISION)):
            return _shown(_value(tree))
    except (DecimalException, RecursionError) as exc:
        raise CalculationError("The result is too large to work out.") from exc
