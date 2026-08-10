from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.core.usage_budget import (
    UsageBudgetExceeded,
    UsageBudgetUnavailable,
    UsageMeteringInvalid,
    UsagePermitConflict,
    new_accounting_id,
)
from app.core.usage_budget_runtime import (
    ProviderUsageAttribution,
    TenantUsageBudgetOrchestrator,
    UsageProviderExecutionRefused,
    UsageBudgetRequestContext,
    UsageRequestStateError,
    UsageTenantScopeError,
    map_usage_budget_error,
    require_provider_execution,
    resolve_usage_tenant_id,
)
from app.db import (
    TenantUsageCompletionEventRow,
    UsageRecordRow,
    create_application_engine,
    create_session_factory,
    session_scope,
    upgrade_database,
)
from app.models.schemas import Role, User
from app.repositories.usage_budgets import TenantUsageBudgetRepository


def _sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _actor(
    *,
    role: Role = Role.USER,
    tenant_id: str | None = "tenant-a",
) -> User:
    return User(
        id="user-a",
        tenant_id=tenant_id,
        email="user-a@example.test",
        display_name="Exact User",
        role=role,
    )


def _runtime(
    tmp_path: Path,
) -> tuple[
    object,
    TenantUsageBudgetRepository,
    TenantUsageBudgetOrchestrator,
]:
    engine = create_application_engine(_sqlite_url(tmp_path / "usage-runtime.sqlite3"))
    upgrade_database(engine)
    repository = TenantUsageBudgetRepository(engine)
    return engine, repository, TenantUsageBudgetOrchestrator(repository)


def test_pure_tenant_resolution_binds_ordinary_actor_and_rejects_overrides() -> None:
    actor = _actor()
    assert resolve_usage_tenant_id(actor) == "tenant-a"
    assert (
        resolve_usage_tenant_id(
            actor,
            explicit_tenant_id="tenant-a",
            resource_tenant_id="tenant-a",
            known_tenant_ids={"tenant-a"},
        )
        == "tenant-a"
    )

    for kwargs in (
        {"explicit_tenant_id": "tenant-b"},
        {"resource_tenant_id": "tenant-b"},
    ):
        with pytest.raises(UsageTenantScopeError) as raised:
            resolve_usage_tenant_id(actor, **kwargs)
        assert raised.value.status_code == 403
        assert raised.value.code == "tenant_scope_mismatch"

    with pytest.raises(UsageTenantScopeError) as raised:
        resolve_usage_tenant_id(_actor(tenant_id=None))
    assert raised.value.status_code == 403
    assert raised.value.code == "actor_tenant_required"


def test_platform_owner_requires_explicit_or_resource_scope_without_fallback() -> None:
    owner = _actor(role=Role.PLATFORM_OWNER, tenant_id="owner-account-tenant")

    with pytest.raises(UsageTenantScopeError) as raised:
        resolve_usage_tenant_id(owner, known_tenant_ids={"only-tenant"})
    assert raised.value.status_code == 400
    assert raised.value.code == "tenant_scope_required"

    assert (
        resolve_usage_tenant_id(
            owner,
            explicit_tenant_id="tenant-explicit",
            known_tenant_ids={"tenant-explicit"},
        )
        == "tenant-explicit"
    )
    assert (
        resolve_usage_tenant_id(
            owner,
            resource_tenant_id="tenant-resource",
            known_tenant_ids={"tenant-resource"},
        )
        == "tenant-resource"
    )

    with pytest.raises(UsageTenantScopeError) as raised:
        resolve_usage_tenant_id(
            owner,
            explicit_tenant_id="tenant-a",
            resource_tenant_id="tenant-b",
        )
    assert raised.value.status_code == 403
    assert raised.value.code == "tenant_scope_mismatch"

    with pytest.raises(UsageTenantScopeError) as raised:
        resolve_usage_tenant_id(
            owner,
            explicit_tenant_id="missing-tenant",
            known_tenant_ids={"tenant-a"},
        )
    assert raised.value.status_code == 404
    assert raised.value.code == "unknown_tenant"


def test_budget_errors_map_to_honest_http_ready_fail_closed_data() -> None:
    now = datetime(2026, 7, 20, 23, tzinfo=UTC)
    exceeded = map_usage_budget_error(
        UsageBudgetExceeded(
            tenant_id="tenant-a",
            daily_token_limit=100,
            reported_tokens=120,
            reset_at=now + timedelta(hours=1),
            retry_after_seconds=3600,
        )
    )
    assert exceeded.status_code == 429
    assert exceeded.code == "daily_token_budget_exceeded"
    assert exceeded.headers == {"Retry-After": "3600"}
    assert exceeded.retry_after_seconds == 3600
    assert exceeded.reset_at == now + timedelta(hours=1)
    assert exceeded.daily_token_limit == 100
    assert exceeded.reported_tokens == 120

    overflowed = map_usage_budget_error(
        UsageBudgetExceeded(
            tenant_id="tenant-a",
            daily_token_limit=0,
            reported_tokens=9_223_372_036_854_775_807,
            reset_at=now + timedelta(hours=1),
            retry_after_seconds=3600,
            accounting_overflowed=True,
        )
    )
    assert overflowed.status_code == 429
    assert overflowed.code == "usage_accounting_overflowed"
    assert "safe numeric limit" in overflowed.detail

    cases = [
        (
            UsageBudgetUnavailable("database password and host must not leak"),
            "usage_accounting_unavailable",
        ),
        (
            UsagePermitConflict("internal hash conflict must not leak"),
            "usage_accounting_conflict",
        ),
        (
            UsageMeteringInvalid("provider payload internals must not leak"),
            "usage_metering_invalid",
        ),
    ]
    for error, code in cases:
        mapped = map_usage_budget_error(error)
        assert mapped.status_code == 503
        assert mapped.code == code
        assert mapped.headers == {}
        assert mapped.retry_after_seconds is None
        assert str(error) not in mapped.detail


def test_orchestrator_settles_multiple_children_with_exact_attribution_and_no_estimates(
    tmp_path: Path,
) -> None:
    engine, repository, orchestrator = _runtime(tmp_path)
    actor = _actor()
    now = datetime(2026, 7, 20, 12, tzinfo=UTC)
    request_id = new_accounting_id()
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        context = orchestrator.begin_request(
            actor=actor,
            request_id=request_id,
            known_tenant_ids={"tenant-a"},
            now=now,
        )
        first = context.settle_provider_child(
            completion_id=new_accounting_id(),
            usage={"prompt_tokens": 4, "completion_tokens": 3},
            attribution=ProviderUsageAttribution(
                model_id="provider/model-one",
                provider_name="Provider One",
                surface="chat",
                message_count=2,
                thread_id="thread-one",
            ),
            completed_at=now + timedelta(seconds=1),
        )
        second = context.settle_provider_child(
            completion_id=new_accounting_id(),
            usage=None,
            attribution=ProviderUsageAttribution(
                model_id="provider/model-two",
                provider_name="Provider Two",
                surface="image",
                message_count=1,
            ),
            completed_at=now + timedelta(seconds=2),
        )

        assert context.settled_child_count == 2
        assert first.usage_record is not None
        assert first.usage_record.tenant_id == "tenant-a"
        assert first.usage_record.user_id == actor.id
        assert first.usage_record.user_name == actor.display_name
        assert first.usage_record.user_role == Role.USER.value
        assert first.usage_record.model_id == "provider/model-one"
        assert first.usage_record.provider_name == "Provider One"
        assert first.usage_record.surface == "chat"
        assert first.usage_record.message_count == 2
        assert first.usage_record.thread_id == "thread-one"
        assert first.usage_record.prompt_tokens == 4
        assert first.usage_record.completion_tokens == 3
        assert first.usage_record.total_tokens == 7

        assert second.usage_record is not None
        assert second.event.metering_status == "unmetered"
        assert second.usage_record.prompt_tokens is None
        assert second.usage_record.completion_tokens is None
        assert second.usage_record.total_tokens is None

        completed = context.complete_success(now=now + timedelta(seconds=3))
        assert completed.status == context.status == "completed"
        daily = repository.get_daily_usage("tenant-a", now.date())
        assert daily is not None
        assert daily.reported_tokens == 7
        assert daily.metered_completions == 1
        assert daily.unmetered_completions == 1

        with pytest.raises(UsageProviderExecutionRefused) as replayed:
            orchestrator.begin_request(
                actor=actor,
                request_id=request_id,
                now=now + timedelta(seconds=4),
            )
        assert replayed.value.permit.permit_id == context.permit.permit_id
    finally:
        engine.dispose()  # type: ignore[union-attr]


@pytest.mark.parametrize(
    ("terminal_method", "expected_status"),
    [("fail", "failed"), ("abandon", "abandoned")],
)
def test_failure_and_abandon_preserve_already_settled_child_events(
    tmp_path: Path,
    terminal_method: str,
    expected_status: str,
) -> None:
    engine, repository, orchestrator = _runtime(tmp_path)
    now = datetime(2026, 7, 20, 13, tzinfo=UTC)
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        context = orchestrator.begin_request(
            actor=_actor(),
            request_id=new_accounting_id(),
            now=now,
        )
        settlement = context.settle_provider_child(
            completion_id=new_accounting_id(),
            usage={"total_tokens": 5},
            attribution=ProviderUsageAttribution(
                model_id="provider/model",
                provider_name="Provider",
                surface="automation",
            ),
            completed_at=now + timedelta(seconds=1),
        )
        terminal = getattr(context, terminal_method)(now=now + timedelta(seconds=2))
        assert terminal.status == expected_status
        assert context.status == expected_status
        assert settlement.usage_record is not None

        daily = repository.get_daily_usage("tenant-a", now.date())
        assert daily is not None
        assert daily.reported_tokens == 5
        assert daily.metered_completions == 1
        factory = create_session_factory(engine)  # type: ignore[arg-type]
        with session_scope(factory) as session:
            assert session.scalar(select(func.count()).select_from(UsageRecordRow)) == 1
            assert (
                session.scalar(select(func.count()).select_from(TenantUsageCompletionEventRow)) == 1
            )

        with pytest.raises(UsageRequestStateError, match="already terminal"):
            context.settle_provider_child(
                completion_id=new_accounting_id(),
                usage={"total_tokens": 1},
                attribution=ProviderUsageAttribution(
                    model_id="provider/model",
                    provider_name="Provider",
                    surface="automation",
                ),
                completed_at=now + timedelta(seconds=3),
            )
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_success_requires_child_event_and_malformed_usage_is_never_estimated(
    tmp_path: Path,
) -> None:
    engine, repository, orchestrator = _runtime(tmp_path)
    now = datetime(2026, 7, 20, 14, tzinfo=UTC)
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        context = orchestrator.begin_request(
            actor=_actor(),
            request_id=new_accounting_id(),
            now=now,
        )
        with pytest.raises(UsageRequestStateError, match="without a settled provider child"):
            context.complete_success(now=now + timedelta(seconds=1))
        with pytest.raises(UsageMeteringInvalid):
            context.settle_provider_child(
                completion_id=new_accounting_id(),
                usage={"total_tokens": 1.5},
                attribution=ProviderUsageAttribution(
                    model_id="provider/model",
                    provider_name="Provider",
                    surface="review",
                ),
                completed_at=now + timedelta(seconds=2),
            )
        assert context.settled_child_count == 0
        assert repository.get_daily_usage("tenant-a", now.date()) is None
        assert context.fail(now=now + timedelta(seconds=3)).status == "failed"
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_one_permit_allows_bounded_children_to_finish_after_limit_crossing(
    tmp_path: Path,
) -> None:
    engine, repository, orchestrator = _runtime(tmp_path)
    now = datetime(2026, 7, 20, 15, tzinfo=UTC)
    try:
        repository.provision_budget(
            "tenant-a",
            daily_token_limit=5,
            updated_by="owner",
            now=now,
        )
        context = orchestrator.begin_request(
            actor=_actor(),
            request_id=new_accounting_id(),
            now=now,
        )
        attribution = ProviderUsageAttribution(
            model_id="provider/model",
            provider_name="Provider",
            surface="chat",
        )
        context.settle_provider_child(
            completion_id=new_accounting_id(),
            usage={"total_tokens": 6},
            attribution=attribution,
            completed_at=now + timedelta(seconds=1),
        )
        context.settle_provider_child(
            completion_id=new_accounting_id(),
            usage={"total_tokens": 1},
            attribution=attribution,
            completed_at=now + timedelta(seconds=2),
        )
        assert context.complete_success(now=now + timedelta(seconds=3)).status == "completed"
        assert repository.get_daily_usage("tenant-a", now.date()).reported_tokens == 7  # type: ignore[union-attr]

        with pytest.raises(UsageBudgetExceeded):
            orchestrator.begin_request(
                actor=_actor(),
                request_id=new_accounting_id(),
                now=now + timedelta(seconds=4),
            )
    finally:
        engine.dispose()  # type: ignore[union-attr]


def test_require_provider_execution_exposes_only_unique_acquirer(tmp_path: Path) -> None:
    engine, repository, _ = _runtime(tmp_path)
    now = datetime(2026, 7, 20, 16, tzinfo=UTC)
    request_id = new_accounting_id()
    try:
        repository.provision_budget("tenant-a", updated_by="owner", now=now)
        first = repository.acquire_permit(
            tenant_id="tenant-a",
            request_id=request_id,
            now=now,
        )
        replay = repository.acquire_permit(
            tenant_id="tenant-a",
            request_id=request_id,
            now=now + timedelta(seconds=1),
        )
        assert require_provider_execution(first).permit_id == first.permit.permit_id
        with pytest.raises(UsageProviderExecutionRefused):
            require_provider_execution(replay)
        with pytest.raises(UsageProviderExecutionRefused):
            UsageBudgetRequestContext(
                repository=repository,
                acquisition=replay,
                actor=_actor(),
                tenant_id="tenant-a",
            )
    finally:
        engine.dispose()  # type: ignore[union-attr]
