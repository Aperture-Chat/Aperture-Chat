"""Exact, provider-reported accounting primitives for tenant token budgets."""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from typing import Any, Literal
from uuid import UUID, uuid4


MeteringStatus = Literal["reported", "unmetered"]
BudgetUnit = Literal["tokens", "usd"]
BudgetPeriod = Literal["day", "week", "month"]
SIGNED_BIGINT_MAX = 9_223_372_036_854_775_807
NANODOLLARS_PER_DOLLAR = 1_000_000_000


class UsageBudgetError(RuntimeError):
    """Base error for fail-closed tenant usage accounting."""


class UsageBudgetUnavailable(UsageBudgetError):
    """The tenant has no authoritative budget row or accounting is unavailable."""


class UsagePermitConflict(UsageBudgetError):
    """An idempotency key or completion identifier was replayed inconsistently."""


class UsageMeteringInvalid(UsageBudgetError):
    """Provider usage counters were present but malformed or contradictory."""


class UsageBudgetExceeded(UsageBudgetError):
    """The request cannot be admitted again before the active UTC reset.

    ``scope`` identifies which cap denied admission: the tenant-wide ceiling
    ("tenant") or a per-principal allocation ("user" / "group").
    """

    def __init__(
        self,
        *,
        tenant_id: str,
        daily_token_limit: int,
        reported_tokens: int,
        reset_at: datetime,
        retry_after_seconds: int,
        accounting_overflowed: bool = False,
        scope: str = "tenant",
        budget_unit: BudgetUnit = "tokens",
        budget_period: BudgetPeriod = "day",
        limit_value: int | None = None,
        reported_value: int | None = None,
    ) -> None:
        self.tenant_id = tenant_id
        self.daily_token_limit = daily_token_limit
        self.reported_tokens = reported_tokens
        self.reset_at = reset_at
        self.retry_after_seconds = retry_after_seconds
        self.accounting_overflowed = accounting_overflowed
        self.scope = scope if scope in ("tenant", "user", "group") else "tenant"
        self.budget_unit = budget_unit
        self.budget_period = budget_period
        self.limit_value = daily_token_limit if limit_value is None else limit_value
        self.reported_value = reported_tokens if reported_value is None else reported_value
        reason = (
            "exhausted the signed-BIGINT accounting range"
            if accounting_overflowed
            else f"reached its UTC {budget_period} {budget_unit} limit"
        )
        subject = {
            "tenant": f"Tenant {tenant_id!r}",
            "user": "The requesting user",
            "group": "The requesting user's group",
        }[self.scope]
        super().__init__(f"{subject} {reason}; retry after {retry_after_seconds} seconds.")


@dataclass(frozen=True, slots=True)
class ReportedUsage:
    """Normalized exact usage without synthesis from text or model metadata."""

    metering_status: MeteringStatus
    prompt_tokens: int | None
    completion_tokens: int | None
    total_tokens: int | None
    reported_cost_nanos: int | None

    @property
    def is_metered(self) -> bool:
        return self.metering_status == "reported"

    @property
    def is_cost_metered(self) -> bool:
        return self.reported_cost_nanos is not None


def normalize_reported_usage(raw_usage: Mapping[str, Any] | None) -> ReportedUsage:
    """Normalize exact provider counters, retaining explicit zero as reported.

    ``total_tokens`` is accepted only as an exact nonnegative integer. When it
    is absent, exact prompt/input and completion/output counters may be added
    arithmetically. Partial reports remain unmetered. Malformed, conflicting, or
    overflowing counters fail explicitly; no tokenizer estimate is introduced.
    """

    if raw_usage is not None and not isinstance(raw_usage, Mapping):
        raise UsageMeteringInvalid("Provider usage must be an object when present.")
    usage = raw_usage or {}
    prompt = _exact_alias_counter(usage, "prompt_tokens", "input_tokens")
    completion = _exact_alias_counter(
        usage,
        "completion_tokens",
        "output_tokens",
    )
    total = _exact_alias_counter(usage, "total_tokens")
    reported_cost_nanos = _exact_reported_cost_nanos(
        usage,
        "cost",
        "total_cost",
        "cost_usd",
    )
    component_total: int | None = None
    if prompt is not None and completion is not None:
        component_total = prompt + completion
        if component_total > SIGNED_BIGINT_MAX:
            raise UsageMeteringInvalid("Provider token counters overflow signed BIGINT.")
    if total is None and prompt is not None and completion is not None:
        total = component_total
    elif total is not None and component_total is not None and total != component_total:
        raise UsageMeteringInvalid(
            "Provider total_tokens contradicts prompt/input plus completion/output tokens."
        )
    status: MeteringStatus = "reported" if total is not None else "unmetered"
    return ReportedUsage(
        metering_status=status,
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=total,
        reported_cost_nanos=reported_cost_nanos,
    )


def utc_usage_date(value: datetime) -> date:
    return require_aware_utc(value).date()


def next_utc_midnight(value: datetime) -> datetime:
    current = require_aware_utc(value)
    return datetime.combine(current.date() + timedelta(days=1), time.min, tzinfo=UTC)


def retry_after_utc_midnight(value: datetime) -> int:
    current = require_aware_utc(value)
    return max(1, math.ceil((next_utc_midnight(current) - current).total_seconds()))


def usage_period_bounds(
    period: BudgetPeriod,
    value: datetime,
) -> tuple[date, date, datetime]:
    """Return the inclusive UTC ledger dates and exclusive reset instant.

    Weeks begin Monday at 00:00 UTC. Months follow UTC calendar months. Daily
    usage rows stay authoritative, so changing a policy period never discards
    or re-labels historical usage.
    """

    current = require_aware_utc(value)
    current_date = current.date()
    if period == "day":
        start = current_date
        reset_at = datetime.combine(start + timedelta(days=1), time.min, tzinfo=UTC)
    elif period == "week":
        start = current_date - timedelta(days=current_date.weekday())
        reset_at = datetime.combine(start + timedelta(days=7), time.min, tzinfo=UTC)
    elif period == "month":
        start = current_date.replace(day=1)
        next_month = (
            start.replace(year=start.year + 1, month=1)
            if start.month == 12
            else start.replace(month=start.month + 1)
        )
        reset_at = datetime.combine(next_month, time.min, tzinfo=UTC)
    else:
        raise ValueError(f"Unsupported usage budget period: {period!r}")
    return start, reset_at.date() - timedelta(days=1), reset_at


def retry_after_usage_period(period: BudgetPeriod, value: datetime) -> int:
    current = require_aware_utc(value)
    _, _, reset_at = usage_period_bounds(period, current)
    return max(1, math.ceil((reset_at - current).total_seconds()))


def require_aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("usage accounting timestamps must be timezone-aware")
    return value.astimezone(UTC)


def new_accounting_id() -> str:
    """Return an opaque, server-generated identifier for request/call replay."""

    return str(uuid4())


def hash_internal_accounting_id(value: str, *, namespace: str) -> str:
    """Domain-separate and hash a server-generated UUIDv4 ledger identifier.

    External idempotency keys must never be passed here. A future external-key
    adapter must first use a deployment-secret HMAC and define rotation rules.
    """

    if not isinstance(value, str):
        raise ValueError("accounting identifiers must be UUIDv4 strings")
    try:
        parsed = UUID(value)
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("accounting identifiers must be UUIDv4 strings") from exc
    if parsed.version != 4:
        raise ValueError("accounting identifiers must be UUIDv4 strings")
    encoded = f"aperture-usage:{namespace}:{parsed.hex}".encode()
    return hashlib.sha256(encoded).hexdigest()


def _exact_alias_counter(usage: Mapping[str, Any], *names: str) -> int | None:
    found: list[tuple[str, int]] = []
    for name in names:
        if name not in usage:
            continue
        value = usage[name]
        if value is None:
            continue
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            or value > SIGNED_BIGINT_MAX
        ):
            raise UsageMeteringInvalid(
                f"Provider {name} must be a nonnegative signed-BIGINT integer."
            )
        found.append((name, value))
    if not found:
        return None
    first_name, first_value = found[0]
    for name, value in found[1:]:
        if value != first_value:
            raise UsageMeteringInvalid(
                f"Provider token aliases {first_name} and {name} contradict each other."
            )
    return first_value


def _exact_reported_cost_nanos(
    usage: Mapping[str, Any],
    *names: str,
) -> int | None:
    """Normalize explicit provider-reported USD cost without estimating.

    Integer nanodollars are the storage precision. Providers compute cost in
    binary floating point, so summed charges (inference plus server-side tool
    use) routinely carry artifacts far below a nanodollar — the familiar
    ``0.1 + 0.2 == 0.30000000000000004``. Those extra digits are representation
    noise, not reported precision, so the value is quantized to nanodollars
    rather than failing the request closed. Nothing is estimated: a genuinely
    absent cost stays absent, and negative, non-finite, contradictory, or
    overflowing values are still rejected.
    """

    found: list[tuple[str, int]] = []
    for name in names:
        if name not in usage or usage[name] is None:
            continue
        value = usage[name]
        if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
            raise UsageMeteringInvalid(f"Provider {name} must be a nonnegative USD number.")
        try:
            decimal_value = Decimal(str(value))
        except (InvalidOperation, ValueError) as exc:
            raise UsageMeteringInvalid(
                f"Provider {name} must be a nonnegative USD number."
            ) from exc
        if not decimal_value.is_finite() or decimal_value < 0:
            raise UsageMeteringInvalid(f"Provider {name} must be a nonnegative USD number.")
        nanos = decimal_value * NANODOLLARS_PER_DOLLAR
        if nanos != nanos.to_integral_value():
            nanos = nanos.quantize(Decimal(1), rounding=ROUND_HALF_EVEN)
        normalized = int(nanos)
        if normalized > SIGNED_BIGINT_MAX:
            raise UsageMeteringInvalid(f"Provider {name} overflows signed BIGINT.")
        found.append((name, normalized))
    if not found:
        return None
    first_name, first_value = found[0]
    for name, value in found[1:]:
        if value != first_value:
            raise UsageMeteringInvalid(
                f"Provider cost aliases {first_name} and {name} contradict each other."
            )
    return first_value
