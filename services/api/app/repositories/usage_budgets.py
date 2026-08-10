"""Transactional repository for tenant token-budget admission and accounting.

Admissions never reserve or estimate tokens. Every successful upstream call is
settled independently so its completion event, detailed ``UsageRecord``, and
UTC daily aggregate delta commit in one transaction before downstream work.

A7 cleanup contract: retention may delete detailed ``UsageRecord`` rows without
invalidating completion-event replay. Closed permits and their child events may
only be pruned after the product's defined replay/idempotency horizon; daily
aggregates remain authoritative beyond that horizon.
"""

from __future__ import annotations

import hashlib
import json
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from random import random
from time import sleep
from typing import Any, Literal, TypeVar
from uuid import uuid4

from sqlalchemy import and_, case, delete, or_, select, update
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.core.usage_budget import (
    BudgetPeriod,
    ReportedUsage,
    SIGNED_BIGINT_MAX,
    UsageBudgetExceeded,
    UsageBudgetUnavailable,
    UsagePermitConflict,
    hash_internal_accounting_id,
    new_accounting_id,
    normalize_reported_usage,
    require_aware_utc,
    retry_after_usage_period,
    usage_period_bounds,
    utc_usage_date,
)
from app.db.engine import create_session_factory, engine_write_lock
from app.db.orm import (
    PrincipalDailyUsageRow,
    PrincipalUsageBudgetRow,
    TenantDailyUsageRow,
    TenantUsageBudgetRow,
    TenantUsageCompletionEventRow,
    TenantUsagePermitRow,
    UsageRecordRow,
)
from app.models.schemas import (
    PrincipalDailyUsage,
    PrincipalUsageBudget,
    TenantDailyUsage,
    TenantUsageBudget,
    TenantUsageCompletionEvent,
    TenantUsagePermit,
    UsageRecord,
)


T = TypeVar("T")
TerminalPermitStatus = Literal["completed", "failed", "abandoned"]

_LOGGER = logging.getLogger(__name__)
_WRITE_RETRY_ATTEMPTS = 8


@dataclass(frozen=True, slots=True)
class PermitAcquireResult:
    permit: TenantUsagePermit
    acquired: bool


@dataclass(frozen=True, slots=True)
class CompletionSettlement:
    event: TenantUsageCompletionEvent
    usage_record: UsageRecord | None
    daily_usage: TenantDailyUsage
    created: bool


@dataclass(frozen=True, slots=True)
class PeriodUsageSummary:
    period_start: date
    period_end: date
    reported_tokens: int = 0
    reported_tokens_overflowed: bool = False
    reported_cost_nanos: int = 0
    reported_cost_overflowed: bool = False
    metered_completions: int = 0
    unmetered_completions: int = 0
    cost_metered_completions: int = 0
    cost_unmetered_completions: int = 0


class TenantUsageBudgetRepository:
    """Own short SQL transactions for reservation-free budget enforcement."""

    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self._sessions: sessionmaker[Session] = create_session_factory(engine)
        # Shared with every other repository writing this database. A private
        # lock serialized budget writes against each other but still let them
        # collide with identity/matter/state writers, which is what surfaced as
        # "usage accounting is unavailable" under concurrent chat.
        self._lock = engine_write_lock(engine)

    def provision_budget(
        self,
        tenant_id: str,
        *,
        daily_token_limit: int = 0,
        budget_unit: str = "tokens",
        budget_period: str = "day",
        spend_limit_nanos: int = 0,
        updated_by: str | None = None,
        now: datetime | None = None,
    ) -> TenantUsageBudget:
        """Explicitly create a tenant budget without changing an existing row."""

        tenant_id = _required_text(tenant_id, "tenant_id")
        _validate_limit(daily_token_limit)
        _validate_budget_configuration(
            budget_unit=budget_unit,
            budget_period=budget_period,
            spend_limit_nanos=spend_limit_nanos,
        )
        updated_at = require_aware_utc(now or datetime.now(UTC))

        def operation(session: Session) -> TenantUsageBudget:
            statement = _dialect_insert(session, TenantUsageBudgetRow).values(
                tenant_id=tenant_id,
                budget_unit=budget_unit,
                budget_period=budget_period,
                daily_token_limit=daily_token_limit,
                spend_limit_nanos=spend_limit_nanos,
                updated_at=updated_at,
                updated_by=updated_by,
            )
            statement = statement.on_conflict_do_nothing(index_elements=["tenant_id"])
            session.execute(statement)
            row = session.get(TenantUsageBudgetRow, tenant_id)
            if row is None:
                raise UsageBudgetUnavailable("Tenant budget provisioning did not persist.")
            return row.to_model()

        return self._run_write(operation)

    def set_budget(
        self,
        tenant_id: str,
        daily_token_limit: int,
        *,
        budget_unit: str = "tokens",
        budget_period: str = "day",
        spend_limit_nanos: int = 0,
        updated_by: str | None,
        now: datetime | None = None,
    ) -> TenantUsageBudget:
        """Update an explicitly provisioned tenant; missing rows stay fail-closed."""

        tenant_id = _required_text(tenant_id, "tenant_id")
        _validate_limit(daily_token_limit)
        _validate_budget_configuration(
            budget_unit=budget_unit,
            budget_period=budget_period,
            spend_limit_nanos=spend_limit_nanos,
        )
        updated_at = require_aware_utc(now or datetime.now(UTC))

        def operation(session: Session) -> TenantUsageBudget:
            row = session.scalar(
                select(TenantUsageBudgetRow)
                .where(TenantUsageBudgetRow.tenant_id == tenant_id)
                .with_for_update()
            )
            if row is None:
                raise UsageBudgetUnavailable(
                    f"Tenant {tenant_id!r} has no provisioned usage budget."
                )
            row.daily_token_limit = daily_token_limit
            row.budget_unit = budget_unit
            row.budget_period = budget_period
            row.spend_limit_nanos = spend_limit_nanos
            row.updated_at = updated_at
            row.updated_by = updated_by
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def get_budget(self, tenant_id: str) -> TenantUsageBudget | None:
        tenant_id = _required_text(tenant_id, "tenant_id")
        return self._run_read(
            lambda session: _budget_model(session.get(TenantUsageBudgetRow, tenant_id))
        )

    def delete_budget(self, tenant_id: str) -> bool:
        """Delete only the tenant's active configuration, retaining history."""

        tenant_id = _required_text(tenant_id, "tenant_id")

        def operation(session: Session) -> bool:
            result = session.execute(
                delete(TenantUsageBudgetRow).where(TenantUsageBudgetRow.tenant_id == tenant_id)
            )
            return bool(result.rowcount)

        return self._run_write(operation)

    def get_daily_usage(
        self,
        tenant_id: str,
        usage_date: date,
    ) -> TenantDailyUsage | None:
        tenant_id = _required_text(tenant_id, "tenant_id")
        return self._run_read(
            lambda session: _daily_model(
                session.get(
                    TenantDailyUsageRow,
                    {"tenant_id": tenant_id, "usage_date": usage_date},
                )
            )
        )

    def get_period_usage(
        self,
        tenant_id: str,
        period: BudgetPeriod,
        *,
        now: datetime | None = None,
    ) -> PeriodUsageSummary:
        """Sum authoritative daily rows for the current UTC policy period."""

        tenant_id = _required_text(tenant_id, "tenant_id")
        period_start, period_end, _ = usage_period_bounds(
            period,
            now or datetime.now(UTC),
        )

        def operation(session: Session) -> PeriodUsageSummary:
            rows = session.scalars(
                select(TenantDailyUsageRow).where(
                    TenantDailyUsageRow.tenant_id == tenant_id,
                    TenantDailyUsageRow.usage_date >= period_start,
                    TenantDailyUsageRow.usage_date <= period_end,
                )
            ).all()
            return _summarize_period_rows(period_start, period_end, rows)

        return self._run_read(operation)

    def set_principal_budget(
        self,
        *,
        tenant_id: str,
        principal_type: str,
        principal_id: str,
        daily_token_limit: int,
        budget_period: str = "day",
        updated_by: str | None = None,
        now: datetime | None = None,
    ) -> PrincipalUsageBudget:
        """Create or update one user/group daily allocation."""

        tenant_id = _required_text(tenant_id, "tenant_id")
        principal_id = _required_text(principal_id, "principal_id")
        if principal_type not in ("user", "group"):
            raise ValueError("principal_type must be 'user' or 'group'")
        _validate_limit(daily_token_limit)
        _validate_period(budget_period)
        updated_at = require_aware_utc(now or datetime.now(UTC))

        def operation(session: Session) -> PrincipalUsageBudget:
            statement = _dialect_insert(session, PrincipalUsageBudgetRow).values(
                tenant_id=tenant_id,
                principal_type=principal_type,
                principal_id=principal_id,
                budget_period=budget_period,
                daily_token_limit=daily_token_limit,
                updated_at=updated_at,
                updated_by=updated_by,
            )
            statement = statement.on_conflict_do_update(
                index_elements=["tenant_id", "principal_type", "principal_id"],
                set_={
                    "daily_token_limit": daily_token_limit,
                    "budget_period": budget_period,
                    "updated_at": updated_at,
                    "updated_by": updated_by,
                },
            )
            session.execute(statement)
            row = session.get(
                PrincipalUsageBudgetRow,
                {
                    "tenant_id": tenant_id,
                    "principal_type": principal_type,
                    "principal_id": principal_id,
                },
            )
            if row is None:
                raise UsageBudgetUnavailable("Principal budget update did not persist.")
            return row.to_model()

        return self._run_write(operation)

    def delete_principal_budget(
        self,
        *,
        tenant_id: str,
        principal_type: str,
        principal_id: str,
    ) -> bool:
        def operation(session: Session) -> bool:
            result = session.execute(
                delete(PrincipalUsageBudgetRow).where(
                    PrincipalUsageBudgetRow.tenant_id == tenant_id,
                    PrincipalUsageBudgetRow.principal_type == principal_type,
                    PrincipalUsageBudgetRow.principal_id == principal_id,
                )
            )
            return bool(result.rowcount)

        return self._run_write(operation)

    def list_principal_budgets(self, tenant_id: str) -> list[PrincipalUsageBudget]:
        def operation(session: Session) -> list[PrincipalUsageBudget]:
            rows = session.scalars(
                select(PrincipalUsageBudgetRow)
                .where(PrincipalUsageBudgetRow.tenant_id == tenant_id)
                .order_by(
                    PrincipalUsageBudgetRow.principal_type,
                    PrincipalUsageBudgetRow.principal_id,
                )
            )
            return [row.to_model() for row in rows]

        return self._run_read(operation)

    def get_principal_budgets(
        self,
        tenant_id: str,
        principals: Sequence[tuple[str, str]],
    ) -> list[PrincipalUsageBudget]:
        if not principals:
            return []

        def operation(session: Session) -> list[PrincipalUsageBudget]:
            rows = session.scalars(
                select(PrincipalUsageBudgetRow).where(
                    PrincipalUsageBudgetRow.tenant_id == tenant_id,
                    or_(
                        *(
                            and_(
                                PrincipalUsageBudgetRow.principal_type == principal_type,
                                PrincipalUsageBudgetRow.principal_id == principal_id,
                            )
                            for principal_type, principal_id in principals
                        )
                    ),
                )
            )
            return [row.to_model() for row in rows]

        return self._run_read(operation)

    def get_principal_daily_usage(
        self,
        tenant_id: str,
        usage_date: date,
        principals: Sequence[tuple[str, str]] | None = None,
    ) -> list[PrincipalDailyUsage]:
        def operation(session: Session) -> list[PrincipalDailyUsage]:
            statement = select(PrincipalDailyUsageRow).where(
                PrincipalDailyUsageRow.tenant_id == tenant_id,
                PrincipalDailyUsageRow.usage_date == usage_date,
            )
            if principals:
                statement = statement.where(
                    or_(
                        *(
                            and_(
                                PrincipalDailyUsageRow.principal_type == principal_type,
                                PrincipalDailyUsageRow.principal_id == principal_id,
                            )
                            for principal_type, principal_id in principals
                        )
                    )
                )
            return [row.to_model() for row in session.scalars(statement)]

        return self._run_read(operation)

    def get_principal_period_usage(
        self,
        tenant_id: str,
        *,
        principal_type: str,
        principal_id: str,
        budget_period: BudgetPeriod,
        now: datetime | None = None,
    ) -> tuple[int, int, date, date, bool]:
        """Return tokens, metered completions, bounds, and overflow for one cap."""

        period_start, period_end, _ = usage_period_bounds(
            budget_period,
            now or datetime.now(UTC),
        )

        def operation(session: Session) -> tuple[int, int, date, date, bool]:
            rows = session.scalars(
                select(PrincipalDailyUsageRow).where(
                    PrincipalDailyUsageRow.tenant_id == tenant_id,
                    PrincipalDailyUsageRow.principal_type == principal_type,
                    PrincipalDailyUsageRow.principal_id == principal_id,
                    PrincipalDailyUsageRow.usage_date >= period_start,
                    PrincipalDailyUsageRow.usage_date <= period_end,
                )
            ).all()
            tokens, overflowed = _saturated_sum(
                (row.reported_tokens for row in rows),
                any(row.reported_tokens_overflowed for row in rows),
            )
            completions, _ = _saturated_sum(
                (row.metered_completions for row in rows),
                False,
            )
            return tokens, completions, period_start, period_end, overflowed

        return self._run_read(operation)

    def abandon_started_permits(self, *, now: datetime | None = None) -> int:
        """Close permits orphaned by a prior process before accepting new work.

        Aperture runs one API process against this application database. A new
        process therefore owns no live provider calls from the prior process,
        so every still-started permit is stale. This transition deliberately
        creates no completion event, usage record, or daily-usage estimate.
        """

        closed_at = require_aware_utc(now or datetime.now(UTC))

        def operation(session: Session) -> int:
            result = session.execute(
                update(TenantUsagePermitRow)
                .where(TenantUsagePermitRow.status == "started")
                .values(status="abandoned", closed_at=closed_at)
            )
            return max(0, int(result.rowcount or 0))

        return self._run_write(operation)

    def acquire_permit(
        self,
        *,
        tenant_id: str,
        request_id: str | None = None,
        principals: Sequence[tuple[str, str]] | None = None,
        now: datetime | None = None,
    ) -> PermitAcquireResult:
        """Atomically admit and claim one request's provider-execution right.

        ``principals`` are the actor's (type, id) pairs — the user plus each
        group — whose daily allocations, when configured, must also admit the
        request. The most restrictive applicable cap wins.
        """

        tenant_id = _required_text(tenant_id, "tenant_id")
        internal_request_id = request_id if request_id is not None else new_accounting_id()
        request_hash = hash_internal_accounting_id(
            internal_request_id,
            namespace="request",
        )
        acquired_at = require_aware_utc(now or datetime.now(UTC))
        admission_date = utc_usage_date(acquired_at)

        def operation(session: Session) -> PermitAcquireResult:
            existing = session.scalar(
                select(TenantUsagePermitRow).where(
                    TenantUsagePermitRow.tenant_id == tenant_id,
                    TenantUsagePermitRow.request_id_hash == request_hash,
                )
            )
            if existing is not None:
                return PermitAcquireResult(
                    permit=_validate_permit_replay(existing, tenant_id),
                    acquired=False,
                )

            _check_principal_budgets(
                session,
                tenant_id=tenant_id,
                principals=principals,
                admission_date=admission_date,
                acquired_at=acquired_at,
            )

            budget = session.scalar(
                select(TenantUsageBudgetRow)
                .where(TenantUsageBudgetRow.tenant_id == tenant_id)
                .with_for_update()
            )
            if budget is None:
                raise UsageBudgetUnavailable(
                    f"Tenant {tenant_id!r} has no provisioned usage budget."
                )
            period_start, period_end, reset_at = usage_period_bounds(
                budget.budget_period,
                acquired_at,
            )
            usage_rows = session.scalars(
                select(TenantDailyUsageRow).where(
                    TenantDailyUsageRow.tenant_id == tenant_id,
                    TenantDailyUsageRow.usage_date >= period_start,
                    TenantDailyUsageRow.usage_date <= period_end,
                )
            ).all()
            summary = _summarize_period_rows(period_start, period_end, usage_rows)
            if budget.budget_unit == "usd":
                limit_value = budget.spend_limit_nanos
                reported_value = summary.reported_cost_nanos
                accounting_overflowed = summary.reported_cost_overflowed
            else:
                limit_value = budget.daily_token_limit
                reported_value = summary.reported_tokens
                accounting_overflowed = summary.reported_tokens_overflowed
            if accounting_overflowed or (limit_value and reported_value >= limit_value):
                raise UsageBudgetExceeded(
                    tenant_id=tenant_id,
                    daily_token_limit=budget.daily_token_limit,
                    reported_tokens=summary.reported_tokens,
                    reset_at=reset_at,
                    retry_after_seconds=retry_after_usage_period(
                        budget.budget_period,
                        acquired_at,
                    ),
                    accounting_overflowed=accounting_overflowed,
                    budget_unit=budget.budget_unit,
                    budget_period=budget.budget_period,
                    limit_value=limit_value,
                    reported_value=reported_value,
                )
            row = TenantUsagePermitRow(
                permit_id=uuid4().hex,
                request_id_hash=request_hash,
                tenant_id=tenant_id,
                admission_date=admission_date,
                status="started",
                acquired_at=acquired_at,
                closed_at=None,
            )
            session.add(row)
            session.flush()
            return PermitAcquireResult(permit=row.to_model(), acquired=True)

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            # Two callers can race on the same tenant-scoped request hash. The
            # winner's committed permit is the authoritative replay result.
            replay = self._permit_by_request_hash(tenant_id, request_hash)
            if replay is None:
                raise UsageBudgetUnavailable("Usage admission could not be persisted.") from exc
            return PermitAcquireResult(
                permit=_validate_permit_replay_row(replay, tenant_id),
                acquired=False,
            )

    def record_provider_completion(
        self,
        *,
        permit_id: str,
        completion_id: str,
        usage: Mapping[str, Any] | None,
        usage_record: UsageRecord,
        principals: Sequence[tuple[str, str]] | None = None,
        completed_at: datetime | None = None,
    ) -> CompletionSettlement:
        """Commit one provider success, detail row, and aggregate delta atomically."""

        permit_id = _required_text(permit_id, "permit_id")
        completion_hash = hash_internal_accounting_id(
            completion_id,
            namespace="completion",
        )
        normalized = normalize_reported_usage(usage)
        usage_record_binding_hash = _usage_record_binding_hash(usage_record)
        completion_time = require_aware_utc(completed_at or datetime.now(UTC))

        def operation(session: Session) -> CompletionSettlement:
            permit = _locked_permit(session, permit_id)
            existing = session.get(TenantUsageCompletionEventRow, completion_hash)
            if existing is not None:
                _validate_completion_replay(
                    existing,
                    permit_id,
                    normalized,
                    usage_record_binding_hash,
                )
                return _existing_settlement(
                    session,
                    existing,
                    expected_template=usage_record,
                    expected_usage=normalized,
                )
            if permit.status != "started":
                raise UsagePermitConflict(
                    f"Permit {permit_id!r} cannot accept a new completion from {permit.status!r}."
                )
            if completion_time < require_aware_utc(permit.acquired_at):
                raise ValueError("completed_at cannot precede acquired_at")

            completion_date = utc_usage_date(completion_time)
            usage_record_id = _usage_record_id(permit_id, completion_hash)
            persisted_record = _completion_usage_record(
                usage_record,
                record_id=usage_record_id,
                tenant_id=permit.tenant_id,
                completed_at=completion_time,
                usage=normalized,
            )
            event = TenantUsageCompletionEventRow(
                permit_id=permit_id,
                completion_id_hash=completion_hash,
                usage_record_id=usage_record_id,
                usage_record_binding_hash=usage_record_binding_hash,
                completion_date=completion_date,
                completed_at=completion_time,
                metering_status=normalized.metering_status,
                prompt_tokens=normalized.prompt_tokens,
                completion_tokens=normalized.completion_tokens,
                total_tokens=normalized.total_tokens,
                reported_cost_nanos=normalized.reported_cost_nanos,
            )
            session.add(event)
            session.add(UsageRecordRow.from_model(persisted_record))
            session.flush()
            _increment_daily_usage(
                session,
                tenant_id=permit.tenant_id,
                usage_date=completion_date,
                usage=normalized,
                updated_at=completion_time,
            )
            for principal_type, principal_id in principals or ():
                _increment_principal_daily_usage(
                    session,
                    tenant_id=permit.tenant_id,
                    principal_type=principal_type,
                    principal_id=principal_id,
                    usage_date=completion_date,
                    usage=normalized,
                    updated_at=completion_time,
                )
            session.flush()
            daily = session.get(
                TenantDailyUsageRow,
                {"tenant_id": permit.tenant_id, "usage_date": completion_date},
            )
            if daily is None:
                raise UsageBudgetUnavailable("Daily usage increment did not persist.")
            return CompletionSettlement(
                event=event.to_model(),
                usage_record=persisted_record,
                daily_usage=daily.to_model(),
                created=True,
            )

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            replay = self._completion_by_hash(completion_hash)
            if replay is None:
                raise UsageBudgetUnavailable(
                    "Provider completion accounting could not be persisted."
                ) from exc
            _validate_completion_replay_row(
                replay,
                permit_id,
                normalized,
                usage_record_binding_hash,
            )
            return self._run_read(
                lambda session: _existing_settlement(
                    session,
                    session.get(TenantUsageCompletionEventRow, completion_hash),
                    expected_template=usage_record,
                    expected_usage=normalized,
                )
            )

    def complete_permit(
        self,
        permit_id: str,
        *,
        now: datetime | None = None,
    ) -> TenantUsagePermit:
        return self._close_permit(permit_id, status="completed", now=now)

    def fail_permit(
        self,
        permit_id: str,
        *,
        now: datetime | None = None,
    ) -> TenantUsagePermit:
        return self._close_permit(permit_id, status="failed", now=now)

    def abandon_permit(
        self,
        permit_id: str,
        *,
        now: datetime | None = None,
    ) -> TenantUsagePermit:
        return self._close_permit(permit_id, status="abandoned", now=now)

    def _close_permit(
        self,
        permit_id: str,
        *,
        status: TerminalPermitStatus,
        now: datetime | None,
    ) -> TenantUsagePermit:
        permit_id = _required_text(permit_id, "permit_id")
        closed_at = require_aware_utc(now or datetime.now(UTC))

        def operation(session: Session) -> TenantUsagePermit:
            row = _locked_permit(session, permit_id)
            if status == "completed" and not session.scalar(
                select(TenantUsageCompletionEventRow.completion_id_hash)
                .where(TenantUsageCompletionEventRow.permit_id == permit_id)
                .limit(1)
            ):
                raise UsagePermitConflict(
                    "A permit without a provider completion cannot complete successfully."
                )
            if row.status == status:
                return row.to_model()
            if row.status in {"completed", "failed", "abandoned"}:
                raise UsagePermitConflict(f"Permit {permit_id!r} already closed as {row.status!r}.")
            if closed_at < require_aware_utc(row.acquired_at):
                raise ValueError("closed_at cannot precede permit activity")
            row.status = status
            row.closed_at = closed_at
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def _permit_by_request_hash(
        self,
        tenant_id: str,
        request_hash: str,
    ) -> TenantUsagePermitRow | None:
        return self._run_read(
            lambda session: session.scalar(
                select(TenantUsagePermitRow).where(
                    TenantUsagePermitRow.tenant_id == tenant_id,
                    TenantUsagePermitRow.request_id_hash == request_hash,
                )
            )
        )

    def _completion_by_hash(
        self,
        completion_hash: str,
    ) -> TenantUsageCompletionEventRow | None:
        return self._run_read(
            lambda session: session.get(TenantUsageCompletionEventRow, completion_hash)
        )

    def _run_read(self, operation: Callable[[Session], T]) -> T:
        session = self._sessions()
        try:
            return operation(session)
        except SQLAlchemyError as exc:
            raise UsageBudgetUnavailable("Tenant usage accounting is unavailable.") from exc
        finally:
            session.close()

    def _run_write(self, operation: Callable[[Session], T]) -> T:
        # SQLite reports a lost BEGIN-deferred upgrade (SQLITE_BUSY_SNAPSHOT)
        # without honouring busy_timeout, and only replaying the whole
        # transaction can recover. The in-process write lock removes almost all
        # of that contention; these retries cover out-of-process writers such as
        # migrations. Backoff is exponential with jitter so retries from
        # several request threads do not resynchronize into a new collision.
        for attempt in range(_WRITE_RETRY_ATTEMPTS):
            try:
                with self._lock:
                    session = self._sessions()
                    try:
                        with session.begin():
                            return operation(session)
                    finally:
                        session.close()
            except OperationalError as exc:
                sqlite_error_code = getattr(exc.orig, "sqlite_errorcode", None)
                locked_sqlite = (
                    self.engine.dialect.name == "sqlite"
                    and isinstance(sqlite_error_code, int)
                    and (sqlite_error_code & 0xFF) in {5, 6}
                )
                if not locked_sqlite or attempt == _WRITE_RETRY_ATTEMPTS - 1:
                    _LOGGER.warning(
                        "Usage accounting write failed after %d attempt(s): %s",
                        attempt + 1,
                        exc,
                        exc_info=True,
                    )
                    raise UsageBudgetUnavailable("Tenant usage accounting is unavailable.") from exc
                sleep(min(0.02 * (2**attempt), 0.5) * (0.5 + random()))
            except IntegrityError:
                raise
            except SQLAlchemyError as exc:
                _LOGGER.warning("Usage accounting write failed: %s", exc, exc_info=True)
                raise UsageBudgetUnavailable("Tenant usage accounting is unavailable.") from exc
        raise UsageBudgetUnavailable("Tenant usage accounting retry loop exited unexpectedly.")


def _locked_permit(session: Session, permit_id: str) -> TenantUsagePermitRow:
    row = session.scalar(
        select(TenantUsagePermitRow)
        .where(TenantUsagePermitRow.permit_id == permit_id)
        .with_for_update()
    )
    if row is None:
        raise UsagePermitConflict(f"Unknown usage permit {permit_id!r}.")
    return row


def _validate_permit_replay(
    row: TenantUsagePermitRow,
    tenant_id: str,
) -> TenantUsagePermit:
    return _validate_permit_replay_row(row.to_model(), tenant_id)


def _validate_permit_replay_row(
    permit: TenantUsagePermit | TenantUsagePermitRow,
    tenant_id: str,
) -> TenantUsagePermit:
    model = permit.to_model() if isinstance(permit, TenantUsagePermitRow) else permit
    if model.tenant_id != tenant_id:
        raise UsagePermitConflict("The idempotency key is already bound to another tenant.")
    return model


def _validate_completion_replay(
    event: TenantUsageCompletionEventRow,
    permit_id: str,
    usage: ReportedUsage,
    usage_record_binding_hash: str,
) -> None:
    _validate_completion_replay_row(
        event.to_model(),
        permit_id,
        usage,
        usage_record_binding_hash,
    )


def _validate_completion_replay_row(
    event: TenantUsageCompletionEvent | TenantUsageCompletionEventRow,
    permit_id: str,
    usage: ReportedUsage,
    usage_record_binding_hash: str,
) -> None:
    model = event.to_model() if isinstance(event, TenantUsageCompletionEventRow) else event
    if model.permit_id != permit_id:
        raise UsagePermitConflict(
            "The completion identifier is already bound to another usage permit."
        )
    if model.usage_record_binding_hash != usage_record_binding_hash:
        raise UsagePermitConflict(
            "The completion identifier is already bound to different usage-record attribution."
        )
    if (
        model.metering_status != usage.metering_status
        or model.prompt_tokens != usage.prompt_tokens
        or model.completion_tokens != usage.completion_tokens
        or model.total_tokens != usage.total_tokens
        or model.reported_cost_nanos != usage.reported_cost_nanos
    ):
        raise UsagePermitConflict(
            "The completion identifier is already bound to different usage counters."
        )


def _existing_settlement(
    session: Session,
    event: TenantUsageCompletionEventRow | None,
    *,
    expected_template: UsageRecord | None = None,
    expected_usage: ReportedUsage | None = None,
) -> CompletionSettlement:
    if event is None:
        raise UsageBudgetUnavailable("Completion replay disappeared during accounting.")
    usage_row = session.scalar(
        select(UsageRecordRow).where(UsageRecordRow.id == event.usage_record_id)
    )
    tenant_id = _permit_tenant_id(session, event.permit_id)
    daily = session.get(
        TenantDailyUsageRow,
        {
            "tenant_id": tenant_id,
            "usage_date": event.completion_date,
        },
    )
    if daily is None:
        raise UsageBudgetUnavailable("Completion accounting is internally inconsistent.")
    persisted_usage_record = usage_row.to_model() if usage_row is not None else None
    if (
        persisted_usage_record is not None
        and expected_template is not None
        and expected_usage is not None
    ):
        expected_record = _completion_usage_record(
            expected_template,
            record_id=event.usage_record_id,
            tenant_id=tenant_id,
            completed_at=require_aware_utc(event.completed_at),
            usage=expected_usage,
        )
        if persisted_usage_record != expected_record:
            raise UsagePermitConflict(
                "The completion identifier is already bound to different usage-record attribution."
            )
    return CompletionSettlement(
        event=event.to_model(),
        usage_record=persisted_usage_record,
        daily_usage=daily.to_model(),
        created=False,
    )


def _permit_tenant_id(session: Session, permit_id: str) -> str:
    tenant_id = session.scalar(
        select(TenantUsagePermitRow.tenant_id).where(TenantUsagePermitRow.permit_id == permit_id)
    )
    if tenant_id is None:
        raise UsageBudgetUnavailable("Completion permit no longer exists.")
    return tenant_id


def _completion_usage_record(
    template: UsageRecord,
    *,
    record_id: str,
    tenant_id: str,
    completed_at: datetime,
    usage: ReportedUsage,
) -> UsageRecord:
    payload = template.model_dump(mode="python")
    payload.update(
        {
            "id": record_id,
            "tenant_id": tenant_id,
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "total_tokens": usage.total_tokens,
            "source": "live",
            "created_at": completed_at,
        }
    )
    return UsageRecord.model_validate(payload)


def _usage_record_id(permit_id: str, completion_hash: str) -> str:
    digest = hashlib.sha256(f"{permit_id}:{completion_hash}".encode()).hexdigest()
    return f"usage-budget:{digest}"


def _usage_record_binding_hash(template: UsageRecord) -> str:
    """Bind replay to attribution without copying its plaintext into the ledger."""

    overwritten_fields = {
        "id",
        "tenant_id",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "source",
        "created_at",
    }
    canonical = json.dumps(
        template.model_dump(mode="json", exclude=overwritten_fields),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    return hashlib.sha256(b"aperture-usage:usage-record-binding:v1\0" + canonical).hexdigest()


def _increment_daily_usage(
    session: Session,
    *,
    tenant_id: str,
    usage_date: date,
    usage: ReportedUsage,
    updated_at: datetime,
) -> None:
    reported_delta = usage.total_tokens or 0
    reported_cost_delta = usage.reported_cost_nanos or 0
    metered_delta = 1 if usage.is_metered else 0
    unmetered_delta = 0 if usage.is_metered else 1
    cost_metered_delta = 1 if usage.is_cost_metered else 0
    cost_unmetered_delta = 0 if usage.is_cost_metered else 1
    statement = _dialect_insert(session, TenantDailyUsageRow).values(
        tenant_id=tenant_id,
        usage_date=usage_date,
        reported_tokens=reported_delta,
        reported_tokens_overflowed=False,
        reported_cost_nanos=reported_cost_delta,
        reported_cost_overflowed=False,
        metered_completions=metered_delta,
        unmetered_completions=unmetered_delta,
        cost_metered_completions=cost_metered_delta,
        cost_unmetered_completions=cost_unmetered_delta,
        updated_at=updated_at,
    )
    statement = statement.on_conflict_do_update(
        index_elements=["tenant_id", "usage_date"],
        set_={
            "reported_tokens": case(
                (
                    or_(
                        TenantDailyUsageRow.reported_tokens_overflowed.is_(True),
                        reported_delta > SIGNED_BIGINT_MAX - TenantDailyUsageRow.reported_tokens,
                    ),
                    SIGNED_BIGINT_MAX,
                ),
                else_=TenantDailyUsageRow.reported_tokens + reported_delta,
            ),
            "reported_tokens_overflowed": or_(
                TenantDailyUsageRow.reported_tokens_overflowed.is_(True),
                reported_delta > SIGNED_BIGINT_MAX - TenantDailyUsageRow.reported_tokens,
            ),
            "reported_cost_nanos": case(
                (
                    or_(
                        TenantDailyUsageRow.reported_cost_overflowed.is_(True),
                        reported_cost_delta
                        > SIGNED_BIGINT_MAX - TenantDailyUsageRow.reported_cost_nanos,
                    ),
                    SIGNED_BIGINT_MAX,
                ),
                else_=TenantDailyUsageRow.reported_cost_nanos + reported_cost_delta,
            ),
            "reported_cost_overflowed": or_(
                TenantDailyUsageRow.reported_cost_overflowed.is_(True),
                reported_cost_delta
                > SIGNED_BIGINT_MAX - TenantDailyUsageRow.reported_cost_nanos,
            ),
            "metered_completions": (TenantDailyUsageRow.metered_completions + metered_delta),
            "unmetered_completions": (TenantDailyUsageRow.unmetered_completions + unmetered_delta),
            "cost_metered_completions": (
                TenantDailyUsageRow.cost_metered_completions + cost_metered_delta
            ),
            "cost_unmetered_completions": (
                TenantDailyUsageRow.cost_unmetered_completions + cost_unmetered_delta
            ),
            "updated_at": case(
                (
                    TenantDailyUsageRow.updated_at >= updated_at,
                    TenantDailyUsageRow.updated_at,
                ),
                else_=updated_at,
            ),
        },
    )
    session.execute(statement)
    session.expire_all()


def _dialect_insert(session: Session, model: type[Any]) -> Any:
    dialect = session.bind.dialect.name if session.bind is not None else ""
    if dialect == "sqlite":
        return sqlite_insert(model)
    if dialect == "postgresql":
        return postgresql_insert(model)
    raise UsageBudgetUnavailable(f"Unsupported usage-accounting database: {dialect!r}.")


def _budget_model(row: TenantUsageBudgetRow | None) -> TenantUsageBudget | None:
    return row.to_model() if row is not None else None


def _daily_model(row: TenantDailyUsageRow | None) -> TenantDailyUsage | None:
    return row.to_model() if row is not None else None


def _required_text(value: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _validate_limit(value: int) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > SIGNED_BIGINT_MAX
    ):
        raise ValueError("daily_token_limit must be a nonnegative signed-BIGINT integer")


def _validate_period(value: str) -> None:
    if value not in ("day", "week", "month"):
        raise ValueError("budget_period must be 'day', 'week', or 'month'")


def _validate_budget_configuration(
    *,
    budget_unit: str,
    budget_period: str,
    spend_limit_nanos: int,
) -> None:
    if budget_unit not in ("tokens", "usd"):
        raise ValueError("budget_unit must be 'tokens' or 'usd'")
    _validate_period(budget_period)
    _validate_limit(spend_limit_nanos)


def _saturated_sum(values: Any, overflowed: bool) -> tuple[int, bool]:
    total = 0
    saturated = overflowed
    for value in values:
        if saturated or value > SIGNED_BIGINT_MAX - total:
            total = SIGNED_BIGINT_MAX
            saturated = True
        else:
            total += value
    return total, saturated


def _summarize_period_rows(
    period_start: date,
    period_end: date,
    rows: Sequence[TenantDailyUsageRow],
) -> PeriodUsageSummary:
    tokens, token_overflowed = _saturated_sum(
        (row.reported_tokens for row in rows),
        any(row.reported_tokens_overflowed for row in rows),
    )
    cost, cost_overflowed = _saturated_sum(
        (row.reported_cost_nanos for row in rows),
        any(row.reported_cost_overflowed for row in rows),
    )
    metered, _ = _saturated_sum((row.metered_completions for row in rows), False)
    unmetered, _ = _saturated_sum((row.unmetered_completions for row in rows), False)
    cost_metered, _ = _saturated_sum(
        (row.cost_metered_completions for row in rows),
        False,
    )
    cost_unmetered, _ = _saturated_sum(
        (row.cost_unmetered_completions for row in rows),
        False,
    )
    return PeriodUsageSummary(
        period_start=period_start,
        period_end=period_end,
        reported_tokens=tokens,
        reported_tokens_overflowed=token_overflowed,
        reported_cost_nanos=cost,
        reported_cost_overflowed=cost_overflowed,
        metered_completions=metered,
        unmetered_completions=unmetered,
        cost_metered_completions=cost_metered,
        cost_unmetered_completions=cost_unmetered,
    )


def _check_principal_budgets(
    session: Session,
    *,
    tenant_id: str,
    principals: Sequence[tuple[str, str]] | None,
    admission_date: date,
    acquired_at: datetime,
) -> None:
    """Deny admission when any configured user/group allocation is spent.

    Reads committed totals only (same no-reservation contract as the tenant
    ceiling). Principals without a configured cap, or with a cap of zero, do
    not constrain admission.
    """

    if not principals:
        return
    budgets = session.scalars(
        select(PrincipalUsageBudgetRow).where(
            PrincipalUsageBudgetRow.tenant_id == tenant_id,
            or_(
                *(
                    and_(
                        PrincipalUsageBudgetRow.principal_type == principal_type,
                        PrincipalUsageBudgetRow.principal_id == principal_id,
                    )
                    for principal_type, principal_id in principals
                )
            ),
        )
    ).all()
    capped = [row for row in budgets if row.daily_token_limit > 0]
    if not capped:
        return
    for budget in capped:
        period_start, period_end, reset_at = usage_period_bounds(
            budget.budget_period,
            acquired_at,
        )
        usage_rows = session.scalars(
            select(PrincipalDailyUsageRow).where(
                PrincipalDailyUsageRow.tenant_id == tenant_id,
                PrincipalDailyUsageRow.principal_type == budget.principal_type,
                PrincipalDailyUsageRow.principal_id == budget.principal_id,
                PrincipalDailyUsageRow.usage_date >= period_start,
                PrincipalDailyUsageRow.usage_date <= period_end,
            )
        ).all()
        reported, overflowed = _saturated_sum(
            (row.reported_tokens for row in usage_rows),
            any(row.reported_tokens_overflowed for row in usage_rows),
        )
        if overflowed or reported >= budget.daily_token_limit:
            raise UsageBudgetExceeded(
                tenant_id=tenant_id,
                daily_token_limit=budget.daily_token_limit,
                reported_tokens=reported,
                reset_at=reset_at,
                retry_after_seconds=retry_after_usage_period(
                    budget.budget_period,
                    acquired_at,
                ),
                accounting_overflowed=overflowed,
                scope=budget.principal_type,
                budget_unit="tokens",
                budget_period=budget.budget_period,
                limit_value=budget.daily_token_limit,
                reported_value=reported,
            )


def _increment_principal_daily_usage(
    session: Session,
    *,
    tenant_id: str,
    principal_type: str,
    principal_id: str,
    usage_date: date,
    usage: ReportedUsage,
    updated_at: datetime,
) -> None:
    reported_delta = usage.total_tokens or 0
    metered_delta = 1 if usage.is_metered else 0
    unmetered_delta = 0 if usage.is_metered else 1
    statement = _dialect_insert(session, PrincipalDailyUsageRow).values(
        tenant_id=tenant_id,
        principal_type=principal_type,
        principal_id=principal_id,
        usage_date=usage_date,
        reported_tokens=reported_delta,
        reported_tokens_overflowed=False,
        metered_completions=metered_delta,
        unmetered_completions=unmetered_delta,
        updated_at=updated_at,
    )
    statement = statement.on_conflict_do_update(
        index_elements=["tenant_id", "principal_type", "principal_id", "usage_date"],
        set_={
            "reported_tokens": case(
                (
                    or_(
                        PrincipalDailyUsageRow.reported_tokens_overflowed.is_(True),
                        reported_delta
                        > SIGNED_BIGINT_MAX - PrincipalDailyUsageRow.reported_tokens,
                    ),
                    SIGNED_BIGINT_MAX,
                ),
                else_=PrincipalDailyUsageRow.reported_tokens + reported_delta,
            ),
            "reported_tokens_overflowed": or_(
                PrincipalDailyUsageRow.reported_tokens_overflowed.is_(True),
                reported_delta > SIGNED_BIGINT_MAX - PrincipalDailyUsageRow.reported_tokens,
            ),
            "metered_completions": (
                PrincipalDailyUsageRow.metered_completions + metered_delta
            ),
            "unmetered_completions": (
                PrincipalDailyUsageRow.unmetered_completions + unmetered_delta
            ),
            "updated_at": case(
                (
                    PrincipalDailyUsageRow.updated_at >= updated_at,
                    PrincipalDailyUsageRow.updated_at,
                ),
                else_=updated_at,
            ),
        },
    )
    session.execute(statement)
