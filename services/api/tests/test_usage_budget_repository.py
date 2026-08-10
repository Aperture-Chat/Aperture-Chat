from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select

from app.core.usage_budget import (
    SIGNED_BIGINT_MAX,
    UsageBudgetExceeded,
    UsageBudgetUnavailable,
    UsageMeteringInvalid,
    UsagePermitConflict,
    new_accounting_id,
    normalize_reported_usage,
    retry_after_utc_midnight,
    usage_period_bounds,
)
from app.db import (
    TenantDailyUsageRow,
    TenantUsageCompletionEventRow,
    UsageRecordRow,
    create_application_engine,
    create_session_factory,
    session_scope,
    upgrade_database,
)
from app.models.schemas import (
    TenantDailyUsage,
    TenantUsageBudget,
    TenantUsageCompletionEvent,
    TenantUsagePermit,
    UsageRecord,
)
from app.repositories import usage_budgets as usage_budget_module
from app.repositories.usage_budgets import TenantUsageBudgetRepository


def _sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _usage_record(*, suffix: str = "one", message_count: int = 1) -> UsageRecord:
    return UsageRecord(
        id=f"ignored-{suffix}",
        tenant_id=None,
        user_id=f"user-{suffix}",
        user_name=f"User {suffix}",
        user_role="USER",
        model_id=f"model-{suffix}",
        provider_name="Provider",
        surface="chat",
        message_count=message_count,
        thread_id=f"thread-{suffix}",
    )


def _repo(tmp_path: Path) -> tuple[object, TenantUsageBudgetRepository]:
    engine = create_application_engine(_sqlite_url(tmp_path / "usage-budget.sqlite3"))
    upgrade_database(engine)
    return engine, TenantUsageBudgetRepository(engine)


def _acquire_new_permit(
    repository: TenantUsageBudgetRepository,
    *,
    tenant_id: str,
    now: datetime,
    request_id: str | None = None,
) -> TenantUsagePermit:
    result = repository.acquire_permit(
        tenant_id=tenant_id,
        request_id=request_id,
        now=now,
    )
    assert result.acquired
    return result.permit


@pytest.mark.parametrize(
    ("raw", "status", "prompt", "completion", "total"),
    [
        ({"total_tokens": 0}, "reported", None, None, 0),
        (
            {"prompt_tokens": 7, "completion_tokens": 5},
            "reported",
            7,
            5,
            12,
        ),
        (
            {"input_tokens": 8, "output_tokens": 2},
            "reported",
            8,
            2,
            10,
        ),
        ({"prompt_tokens": 7}, "unmetered", 7, None, None),
        (None, "unmetered", None, None, None),
    ],
)
def test_normalize_reported_usage_is_exact_and_never_estimates(
    raw: dict[str, object] | None,
    status: str,
    prompt: int | None,
    completion: int | None,
    total: int | None,
) -> None:
    result = normalize_reported_usage(raw)
    assert result.metering_status == status
    assert result.prompt_tokens == prompt
    assert result.completion_tokens == completion
    assert result.total_tokens == total


@pytest.mark.parametrize(
    "raw",
    [
        {"total_tokens": True},
        {"total_tokens": -1},
        {"total_tokens": 1.0},
        {"total_tokens": "1"},
        {"total_tokens": SIGNED_BIGINT_MAX + 1},
        {"prompt_tokens": 1, "input_tokens": 2, "completion_tokens": 3},
        {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 4},
        {"prompt_tokens": SIGNED_BIGINT_MAX, "completion_tokens": 1},
    ],
)
def test_normalize_reported_usage_rejects_malformed_conflicting_or_overflowing_counters(
    raw: dict[str, object],
) -> None:
    with pytest.raises(UsageMeteringInvalid):
        normalize_reported_usage(raw)


def test_normalize_reported_usage_preserves_exact_provider_cost() -> None:
    reported = normalize_reported_usage({"total_tokens": 7, "cost": 0.000001234})
    assert reported.reported_cost_nanos == 1_234
    assert reported.is_cost_metered

    unreported = normalize_reported_usage({"total_tokens": 7})
    assert unreported.reported_cost_nanos is None
    assert not unreported.is_cost_metered


def test_normalize_reported_usage_quantizes_sub_nanodollar_float_artifacts() -> None:
    """Binary float noise must not fail a real run closed.

    Providers sum inference and server-side tool charges in floating point, so
    a cost arrives as 0.30000000000000004 rather than 0.3. Those digits are
    representation error below the nanodollar storage precision, not reported
    precision, so they are quantized instead of rejected.
    """
    artifact = normalize_reported_usage({"total_tokens": 7, "cost": 0.1 + 0.2})
    assert artifact.reported_cost_nanos == 300_000_000
    assert artifact.is_cost_metered

    # Smaller than half a nanodollar: quantizes to zero, still not an error.
    assert normalize_reported_usage({"total_tokens": 7, "cost": "0.0000000001"}).reported_cost_nanos == 0

    # Genuinely invalid costs are still rejected rather than coerced.
    for bad in (-0.5, float("inf"), "not-a-number"):
        with pytest.raises(UsageMeteringInvalid):
            normalize_reported_usage({"total_tokens": 7, "cost": bad})


def test_usage_period_bounds_follow_utc_calendar_boundaries() -> None:
    now = datetime(2026, 7, 22, 14, 30, tzinfo=UTC)
    assert usage_period_bounds("day", now)[:2] == (date(2026, 7, 22), date(2026, 7, 22))
    assert usage_period_bounds("week", now)[:2] == (date(2026, 7, 20), date(2026, 7, 26))
    assert usage_period_bounds("month", now)[:2] == (date(2026, 7, 1), date(2026, 7, 31))


def test_daily_budget_counts_only_today_and_releases_at_the_utc_boundary(tmp_path: Path) -> None:
    """Yesterday's spend must not be charged against today's daily cap."""
    engine, repository = _repo(tmp_path)
    yesterday = datetime(2026, 7, 20, 23, 30, tzinfo=UTC)
    today = datetime(2026, 7, 21, 0, 30, tzinfo=UTC)
    try:
        repository.provision_budget(
            "tenant-a",
            daily_token_limit=100,
            budget_period="day",
            updated_by="owner",
            now=yesterday,
        )
        permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=yesterday)
        repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=new_accounting_id(),
            usage={"total_tokens": 100},
            usage_record=_usage_record(),
            completed_at=yesterday,
        )
        repository.complete_permit(permit.permit_id, now=yesterday)

        exhausted = repository.get_period_usage("tenant-a", "day", now=yesterday)
        assert exhausted.reported_tokens == 100

        # One hour later, across the UTC midnight boundary, the ledger row for
        # the new day starts empty and the cap admits work again.
        fresh = repository.get_period_usage("tenant-a", "day", now=today)
        assert fresh.reported_tokens == 0
        assert fresh.period_start == fresh.period_end == today.date()
        repository.acquire_permit(
            tenant_id="tenant-a",
            request_id=new_accounting_id(),
            now=today,
        )
    finally:
        engine.dispose()


def test_weekly_token_budget_accumulates_daily_rows_until_next_monday(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    monday = datetime(2026, 7, 20, 10, tzinfo=UTC)
    try:
        repository.provision_budget(
            "tenant-a",
            daily_token_limit=100,
            budget_period="week",
            updated_by="owner",
            now=monday,
        )
        permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=monday)
        repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=new_accounting_id(),
            usage={"total_tokens": 100},
            usage_record=_usage_record(),
            completed_at=monday,
        )
        repository.complete_permit(permit.permit_id, now=monday)

        with pytest.raises(UsageBudgetExceeded) as raised:
            repository.acquire_permit(
                tenant_id="tenant-a",
                request_id=new_accounting_id(),
                now=monday + timedelta(days=3),
            )
        assert raised.value.budget_period == "week"

        next_period = repository.acquire_permit(
            tenant_id="tenant-a",
            request_id=new_accounting_id(),
            now=monday + timedelta(days=7),
        )
        assert next_period.acquired
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_usd_budget_enforces_exact_provider_reported_spend(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 10, tzinfo=UTC)
    try:
        repository.provision_budget(
            "tenant-a",
            budget_unit="usd",
            budget_period="month",
            spend_limit_nanos=500_000_000,
            updated_by="owner",
            now=now,
        )
        permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=now)
        settlement = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=new_accounting_id(),
            usage={"total_tokens": 10, "cost": "0.50"},
            usage_record=_usage_record(),
            completed_at=now,
        )
        repository.complete_permit(permit.permit_id, now=now)
        assert settlement.event.reported_cost_nanos == 500_000_000
        summary = repository.get_period_usage("tenant-a", "month", now=now)
        assert summary.reported_cost_nanos == 500_000_000
        assert summary.cost_metered_completions == 1

        with pytest.raises(UsageBudgetExceeded) as raised:
            repository.acquire_permit(
                tenant_id="tenant-a",
                request_id=new_accounting_id(),
                now=now + timedelta(days=1),
            )
        assert raised.value.budget_unit == "usd"
        assert raised.value.budget_period == "month"
        assert raised.value.reported_value == 500_000_000
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_usage_budget_models_require_strict_signed_bigint_counters() -> None:
    now = datetime(2026, 7, 20, 12, tzinfo=UTC)
    with pytest.raises(ValidationError):
        TenantUsageBudget(
            tenant_id="tenant-a",
            daily_token_limit="1",  # type: ignore[arg-type]
            updated_at=now,
        )
    with pytest.raises(ValidationError):
        TenantDailyUsage(
            tenant_id="tenant-a",
            usage_date=date(2026, 7, 20),
            reported_tokens=1.0,  # type: ignore[arg-type]
            updated_at=now,
        )
    with pytest.raises(ValidationError):
        TenantDailyUsage(
            tenant_id="tenant-a",
            usage_date=date(2026, 7, 20),
            reported_tokens=1,
            reported_tokens_overflowed=1,  # type: ignore[arg-type]
            updated_at=now,
        )
    with pytest.raises(ValidationError, match="saturated"):
        TenantDailyUsage(
            tenant_id="tenant-a",
            usage_date=date(2026, 7, 20),
            reported_tokens=1,
            reported_tokens_overflowed=True,
            updated_at=now,
        )
    with pytest.raises(ValidationError):
        TenantUsageCompletionEvent(
            permit_id="permit",
            completion_id_hash="a" * 64,
            usage_record_id="usage",
            usage_record_binding_hash="b" * 64,
            completion_date=date(2026, 7, 20),
            completed_at=now,
            metering_status="reported",
            total_tokens=SIGNED_BIGINT_MAX + 1,
        )


def test_retry_after_uses_next_utc_midnight_and_rejects_naive_time() -> None:
    now = datetime(2026, 7, 20, 23, 59, 59, 100_000, tzinfo=UTC)
    assert retry_after_utc_midnight(now) == 1
    with pytest.raises(ValueError, match="timezone-aware"):
        retry_after_utc_midnight(now.replace(tzinfo=None))


def test_missing_budget_fails_closed_and_provisioning_is_explicit(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 12, tzinfo=UTC)
    try:
        with pytest.raises(UsageBudgetUnavailable, match="no provisioned"):
            repository.acquire_permit(tenant_id="tenant-a", now=now)
        with pytest.raises(UsageBudgetUnavailable, match="no provisioned"):
            repository.set_budget("tenant-a", 100, updated_by="owner", now=now)

        budget = repository.provision_budget(
            "tenant-a",
            daily_token_limit=0,
            updated_by="owner",
            now=now,
        )
        assert budget.daily_token_limit == 0
        acquired = repository.acquire_permit(tenant_id="tenant-a", now=now)
        assert acquired.acquired
        assert acquired.permit.status == "started"
        assert not hasattr(repository, "start_permit")
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_request_replay_is_tenant_scoped_and_does_not_recheck_spend(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 12, tzinfo=UTC)
    request_id = new_accounting_id()
    try:
        for tenant_id in ("tenant-a", "tenant-b"):
            repository.provision_budget(
                tenant_id,
                daily_token_limit=10,
                updated_by="owner",
                now=now,
            )
        first = repository.acquire_permit(
            tenant_id="tenant-a",
            request_id=request_id,
            now=now,
        )
        replay = repository.acquire_permit(
            tenant_id="tenant-a",
            request_id=request_id,
            now=now + timedelta(days=1, seconds=1),
        )
        other_tenant = repository.acquire_permit(
            tenant_id="tenant-b",
            request_id=request_id,
            now=now,
        )
        assert first.acquired
        assert not replay.acquired
        assert other_tenant.acquired
        assert replay.permit.permit_id == first.permit.permit_id
        assert replay.permit.admission_date == first.permit.admission_date == now.date()
        assert replay.permit.acquired_at == first.permit.acquired_at
        assert other_tenant.permit.permit_id != first.permit.permit_id
        assert other_tenant.permit.request_id_hash == first.permit.request_id_hash
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_concurrent_same_request_has_exactly_one_execution_right(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    second_repository = TenantUsageBudgetRepository(engine)  # type: ignore[arg-type]
    now = datetime(2026, 7, 20, 12, 30, tzinfo=UTC)
    request_id = new_accounting_id()
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)

        def acquire(target: TenantUsageBudgetRepository):
            return target.acquire_permit(
                tenant_id="tenant-a",
                request_id=request_id,
                now=now,
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(acquire, (repository, second_repository)))

        assert sum(result.acquired for result in results) == 1
        assert len({result.permit.permit_id for result in results}) == 1
        assert {result.permit.status for result in results} == {"started"}
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_restart_abandons_started_permit_without_inventing_usage(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    restarted_repository = TenantUsageBudgetRepository(engine)  # type: ignore[arg-type]
    started_at = datetime(2026, 7, 20, 12, 30, tzinfo=UTC)
    restarted_at = started_at + timedelta(minutes=5)
    request_id = new_accounting_id()
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=started_at)
        permit = _acquire_new_permit(
            repository,
            tenant_id="tenant-a",
            request_id=request_id,
            now=started_at,
        )

        assert restarted_repository.abandon_started_permits(now=restarted_at) == 1
        assert restarted_repository.abandon_started_permits(now=restarted_at) == 0
        replay = restarted_repository.acquire_permit(
            tenant_id="tenant-a",
            request_id=request_id,
            now=restarted_at,
        )

        assert not replay.acquired
        assert replay.permit.permit_id == permit.permit_id
        assert replay.permit.status == "abandoned"
        assert replay.permit.closed_at == restarted_at
        assert restarted_repository.get_daily_usage("tenant-a", started_at.date()) is None
        sessions = create_session_factory(engine)  # type: ignore[arg-type]
        with session_scope(sessions) as session:
            assert session.scalar(select(func.count()).select_from(UsageRecordRow)) == 0
            assert (
                session.scalar(select(func.count()).select_from(TenantUsageCompletionEventRow)) == 0
            )
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_success_can_cross_limit_then_next_new_admission_is_blocked(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    issued_at = datetime(2026, 7, 20, 10, tzinfo=UTC)
    try:
        repository.provision_budget(
            "tenant-a",
            daily_token_limit=100,
            updated_by="owner",
            now=issued_at,
        )
        request_id = new_accounting_id()
        permit = _acquire_new_permit(
            repository,
            tenant_id="tenant-a",
            request_id=request_id,
            now=issued_at,
        )
        settlement = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=new_accounting_id(),
            usage={"prompt_tokens": 80, "completion_tokens": 40},
            usage_record=_usage_record(),
            completed_at=issued_at + timedelta(seconds=2),
        )
        assert settlement.daily_usage.reported_tokens == 120
        assert (
            repository.complete_permit(
                permit.permit_id,
                now=issued_at + timedelta(seconds=3),
            ).status
            == "completed"
        )

        # A replay returns the already admitted request even after the crossing.
        replay = repository.acquire_permit(
            tenant_id="tenant-a",
            request_id=request_id,
            now=issued_at + timedelta(seconds=4),
        )
        assert not replay.acquired
        assert replay.permit.permit_id == permit.permit_id
        with pytest.raises(UsageBudgetExceeded) as raised:
            repository.acquire_permit(
                tenant_id="tenant-a",
                request_id=new_accounting_id(),
                now=issued_at + timedelta(seconds=4),
            )
        assert raised.value.reported_tokens == 120
        assert raised.value.daily_token_limit == 100
        assert raised.value.retry_after_seconds == 50_396
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_multiple_success_events_survive_later_request_failure(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 13, tzinfo=UTC)
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=now)

        first = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=new_accounting_id(),
            usage={"total_tokens": 15},
            usage_record=_usage_record(suffix="image-1"),
            completed_at=now + timedelta(seconds=2),
        )
        second = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=new_accounting_id(),
            usage=None,
            usage_record=_usage_record(suffix="image-2"),
            completed_at=now + timedelta(seconds=3),
        )
        assert first.daily_usage.reported_tokens == 15
        assert second.daily_usage.reported_tokens == 15
        assert second.daily_usage.metered_completions == 1
        assert second.daily_usage.unmetered_completions == 1
        assert (
            repository.fail_permit(
                permit.permit_id,
                now=now + timedelta(seconds=4),
            ).status
            == "failed"
        )

        with pytest.raises(UsagePermitConflict, match="cannot accept"):
            repository.record_provider_completion(
                permit_id=permit.permit_id,
                completion_id=new_accounting_id(),
                usage={"total_tokens": 1},
                usage_record=_usage_record(suffix="late"),
                completed_at=now + timedelta(seconds=5),
            )
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_completion_replay_is_exactly_once_and_conflicts_on_different_usage(
    tmp_path: Path,
) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 14, tzinfo=UTC)
    completion_id = new_accounting_id()
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=now)
        first = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=completion_id,
            usage={"total_tokens": 9},
            usage_record=_usage_record(),
            completed_at=now + timedelta(seconds=2),
        )
        replay = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=completion_id,
            usage={"total_tokens": 9},
            usage_record=_usage_record(),
            completed_at=now + timedelta(minutes=1),
        )
        assert first.created
        assert not replay.created
        assert replay.event == first.event
        assert replay.daily_usage.reported_tokens == 9

        with pytest.raises(UsagePermitConflict, match="different usage"):
            repository.record_provider_completion(
                permit_id=permit.permit_id,
                completion_id=completion_id,
                usage={"total_tokens": 10},
                usage_record=_usage_record(),
                completed_at=now + timedelta(minutes=2),
            )
        with pytest.raises(UsagePermitConflict, match="different usage-record"):
            repository.record_provider_completion(
                permit_id=permit.permit_id,
                completion_id=completion_id,
                usage={"total_tokens": 9},
                usage_record=_usage_record(suffix="different-attribution"),
                completed_at=now + timedelta(minutes=2),
            )

        factory = create_session_factory(engine)  # type: ignore[arg-type]
        with session_scope(factory) as session:
            assert session.scalar(select(func.count()).select_from(UsageRecordRow)) == 1
            assert (
                session.scalar(select(func.count()).select_from(TenantUsageCompletionEventRow)) == 1
            )
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_completion_identifier_is_globally_bound_to_one_permit(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 14, 30, tzinfo=UTC)
    completion_id = new_accounting_id()
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        first_permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=now)
        second_permit = _acquire_new_permit(
            repository,
            tenant_id="tenant-a",
            now=now + timedelta(seconds=1),
        )
        repository.record_provider_completion(
            permit_id=first_permit.permit_id,
            completion_id=completion_id,
            usage={"total_tokens": 7},
            usage_record=_usage_record(suffix="first-permit"),
            completed_at=now + timedelta(seconds=2),
        )

        with pytest.raises(UsagePermitConflict, match="another usage permit"):
            repository.record_provider_completion(
                permit_id=second_permit.permit_id,
                completion_id=completion_id,
                usage={"total_tokens": 7},
                usage_record=_usage_record(suffix="second-permit"),
                completed_at=now + timedelta(seconds=3),
            )

        daily = repository.get_daily_usage("tenant-a", now.date())
        assert daily is not None
        assert daily.reported_tokens == 7
        assert daily.metered_completions == 1
        factory = create_session_factory(engine)  # type: ignore[arg-type]
        with session_scope(factory) as session:
            assert session.scalar(select(func.count()).select_from(UsageRecordRow)) == 1
            assert (
                session.scalar(select(func.count()).select_from(TenantUsageCompletionEventRow)) == 1
            )
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_completion_event_replay_survives_usage_detail_retention(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 14, 45, tzinfo=UTC)
    completion_id = new_accounting_id()
    template = _usage_record(suffix="retained-event")
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=now)
        first = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=completion_id,
            usage={"total_tokens": 6},
            usage_record=template,
            completed_at=now + timedelta(seconds=1),
        )
        assert first.usage_record is not None

        factory = create_session_factory(engine)  # type: ignore[arg-type]
        with session_scope(factory) as session:
            detail = session.scalar(
                select(UsageRecordRow).where(UsageRecordRow.id == first.usage_record.id)
            )
            assert detail is not None
            session.delete(detail)

        replay = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=completion_id,
            usage={"total_tokens": 6},
            usage_record=template,
            completed_at=now + timedelta(minutes=1),
        )
        assert not replay.created
        assert replay.event == first.event
        assert replay.usage_record is None
        assert replay.daily_usage.reported_tokens == 6
        assert replay.daily_usage.metered_completions == 1
        with pytest.raises(UsagePermitConflict, match="different usage-record"):
            repository.record_provider_completion(
                permit_id=permit.permit_id,
                completion_id=completion_id,
                usage={"total_tokens": 6},
                usage_record=_usage_record(suffix="retained-event-conflict"),
                completed_at=now + timedelta(minutes=2),
            )
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_completion_transaction_rolls_back_all_three_accounting_writes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 15, tzinfo=UTC)
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=now)

        def fail_increment(*args: object, **kwargs: object) -> None:
            del args, kwargs
            raise RuntimeError("injected aggregate failure")

        monkeypatch.setattr(usage_budget_module, "_increment_daily_usage", fail_increment)
        with pytest.raises(RuntimeError, match="injected"):
            repository.record_provider_completion(
                permit_id=permit.permit_id,
                completion_id=new_accounting_id(),
                usage={"total_tokens": 8},
                usage_record=_usage_record(),
                completed_at=now + timedelta(seconds=2),
            )

        factory = create_session_factory(engine)  # type: ignore[arg-type]
        with session_scope(factory) as session:
            assert session.scalar(select(func.count()).select_from(UsageRecordRow)) == 0
            assert (
                session.scalar(select(func.count()).select_from(TenantUsageCompletionEventRow)) == 0
            )
        assert repository.get_daily_usage("tenant-a", now.date()) is None
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_zero_event_permit_can_fail_or_abandon_but_cannot_complete(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 15, 30, tzinfo=UTC)
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        failed = _acquire_new_permit(repository, tenant_id="tenant-a", now=now)
        with pytest.raises(UsagePermitConflict, match="without a provider completion"):
            repository.complete_permit(
                failed.permit_id,
                now=now + timedelta(seconds=1),
            )
        assert (
            repository.fail_permit(
                failed.permit_id,
                now=now + timedelta(seconds=2),
            ).status
            == "failed"
        )

        abandoned = _acquire_new_permit(
            repository,
            tenant_id="tenant-a",
            now=now + timedelta(seconds=3),
        )
        assert (
            repository.abandon_permit(
                abandoned.permit_id,
                now=now + timedelta(seconds=4),
            ).status
            == "abandoned"
        )
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_daily_reported_token_overflow_saturates_and_blocks_unlimited_budget(
    tmp_path: Path,
) -> None:
    engine, repository = _repo(tmp_path)
    now = datetime(2026, 7, 20, 15, 45, tzinfo=UTC)
    try:
        repository.provision_budget(
            "tenant-a",
            daily_token_limit=0,
            updated_by="owner",
            now=now,
        )
        factory = create_session_factory(engine)  # type: ignore[arg-type]
        with session_scope(factory) as session:
            session.add(
                TenantDailyUsageRow(
                    tenant_id="tenant-a",
                    usage_date=now.date(),
                    reported_tokens=SIGNED_BIGINT_MAX - 1,
                    reported_tokens_overflowed=False,
                    metered_completions=1,
                    unmetered_completions=0,
                    updated_at=now,
                )
            )

        permit = _acquire_new_permit(
            repository,
            tenant_id="tenant-a",
            now=now + timedelta(seconds=1),
        )
        settlement = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=new_accounting_id(),
            usage={"total_tokens": 2},
            usage_record=_usage_record(suffix="overflow"),
            completed_at=now + timedelta(seconds=2),
        )
        assert settlement.created
        assert settlement.usage_record is not None
        assert settlement.event.total_tokens == 2
        assert settlement.daily_usage.reported_tokens == SIGNED_BIGINT_MAX
        assert settlement.daily_usage.reported_tokens_overflowed
        assert settlement.daily_usage.metered_completions == 2

        with pytest.raises(UsageBudgetExceeded) as raised:
            repository.acquire_permit(
                tenant_id="tenant-a",
                now=now + timedelta(seconds=3),
            )
        assert raised.value.daily_token_limit == 0
        assert raised.value.reported_tokens == SIGNED_BIGINT_MAX
        assert raised.value.accounting_overflowed
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_completion_uses_its_utc_day_when_request_crosses_midnight(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    issued_at = datetime(2026, 7, 20, 23, 59, 58, tzinfo=UTC)
    completed_at = datetime(2026, 7, 21, 0, 0, 1, tzinfo=UTC)
    try:
        repository.provision_budget(
            "tenant-a",
            daily_token_limit=10,
            updated_by="owner",
            now=issued_at,
        )
        permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=issued_at)
        settlement = repository.record_provider_completion(
            permit_id=permit.permit_id,
            completion_id=new_accounting_id(),
            usage={"total_tokens": 11},
            usage_record=_usage_record(),
            completed_at=completed_at,
        )
        assert permit.admission_date.isoformat() == "2026-07-20"
        assert settlement.event.completion_date.isoformat() == "2026-07-21"
        assert repository.get_daily_usage("tenant-a", issued_at.date()) is None
        assert repository.get_daily_usage("tenant-a", completed_at.date()) == (
            settlement.daily_usage
        )

        # The new UTC day is now blocked by the just-completed crossing.
        with pytest.raises(UsageBudgetExceeded):
            repository.acquire_permit(
                tenant_id="tenant-a",
                request_id=new_accounting_id(),
                now=completed_at + timedelta(seconds=1),
            )
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_concurrent_distinct_completions_do_not_lose_aggregate_updates(tmp_path: Path) -> None:
    engine, repository = _repo(tmp_path)
    second_repository = TenantUsageBudgetRepository(engine)  # type: ignore[arg-type]
    now = datetime(2026, 7, 20, 16, tzinfo=UTC)
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        permit = _acquire_new_permit(repository, tenant_id="tenant-a", now=now)
        completion_ids = [new_accounting_id() for _ in range(12)]

        def settle(index: int) -> int:
            target = repository if index % 2 == 0 else second_repository
            result = target.record_provider_completion(
                permit_id=permit.permit_id,
                completion_id=completion_ids[index],
                usage={"total_tokens": index + 1},
                usage_record=_usage_record(suffix=str(index)),
                completed_at=now + timedelta(seconds=2 + index),
            )
            return result.event.total_tokens or 0

        with ThreadPoolExecutor(max_workers=6) as executor:
            assert sorted(executor.map(settle, range(12))) == list(range(1, 13))

        daily = repository.get_daily_usage("tenant-a", now.date())
        assert daily is not None
        assert daily.reported_tokens == sum(range(1, 13))
        assert daily.metered_completions == 12
        assert daily.unmetered_completions == 0
    finally:
        engine.dispose()  # type: ignore[union-attr]
