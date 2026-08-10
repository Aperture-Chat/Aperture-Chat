"""Usage-budget enforcement for automation workflow provider calls."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.core import automation_runner
from app.core.automation_runner import execute_chain
from app.core.model_gateway import ModelGatewayError, ModelGatewayRoute
from app.core.security import SecretVault
from app.core.usage_budget_runtime import TenantUsageBudgetOrchestrator
from app.db.orm import TenantUsagePermitRow
from app.models.schemas import Automation, AutomationStep
from app.repositories.seed import SeedStore


class SequenceGateway:
    def __init__(self, responses: list[object]) -> None:
        self.responses = list(responses)
        self.calls = 0
        self.upstream_models: list[str] = []

    # Mirrors ModelGatewayClient.complete's keyword interface so a new
    # pass-through argument surfaces as a real failure, not a stub mismatch.
    def complete(self, *, route, messages, max_tokens, tools=None):
        self.calls += 1
        self.tools_seen = tools
        self.upstream_models.append(route.upstream_model)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


@pytest.fixture
def workflow_store(monkeypatch):
    store = SeedStore(SecretVault("workflow-budget-test-secret"))
    route = ModelGatewayRoute(
        provider_id="provider-test",
        provider_name="Selected Provider",
        provider_kind="openai-compatible",
        auth_type="bearer",
        upstream_model="selected-upstream-model",
        base_url="https://provider.invalid/v1",
        configured=True,
        status_message="Configured",
        secret_value="test-secret",
    )

    def selected_route(_store, _model, *, tenant_id):
        assert tenant_id == "tenant-example"
        return route

    monkeypatch.setattr(automation_runner, "resolve_model_route", selected_route)
    yield store
    store.close()


def _automation(*, steps: int = 1) -> Automation:
    return Automation(
        id="automation-budget-test",
        tenant_id="tenant-example",
        name="Budget workflow",
        trigger_type="once",
        prompt="Begin.",
        steps=[
            AutomationStep(model_id="gpt-4o-mini", instruction=f"Step {index}")
            for index in range(1, steps + 1)
        ],
        created_by="user-admin",
    )


def _payload(total_tokens: int, content: str = "Done") -> dict[str, object]:
    return {
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "usage": {
            "prompt_tokens": total_tokens - 1,
            "completion_tokens": 1,
            "total_tokens": total_tokens,
        },
    }


def _permit_statuses(store: SeedStore) -> list[str]:
    with store.application_state_repository.engine.connect() as connection:
        return list(connection.execute(select(TenantUsagePermitRow.status)).scalars())


def test_automation_acquires_and_settles_one_permit_per_step(workflow_store) -> None:
    gateway = SequenceGateway([_payload(5, "First"), _payload(7, "Second")])
    actor = workflow_store.users["user-admin"]

    transcript, final_output = execute_chain(
        workflow_store,
        _automation(steps=2),
        actor,
        gateway,
        TenantUsageBudgetOrchestrator(workflow_store.usage_budget_repository),
    )

    assert final_output == "Second"
    assert [entry["output"] for entry in transcript] == ["First", "Second"]
    assert gateway.upstream_models == ["selected-upstream-model", "selected-upstream-model"]
    records = list(workflow_store.usage_records)
    assert [record.total_tokens for record in records] == [5, 7]
    assert [record.surface for record in records] == ["automation", "automation"]
    assert [record.message_count for record in records] == [1, 1]
    daily = workflow_store.usage_budget_repository.get_daily_usage(
        "tenant-example",
        datetime.now(UTC).date(),
    )
    assert daily is not None
    assert daily.reported_tokens == 12
    assert daily.metered_completions == 2
    assert _permit_statuses(workflow_store) == ["completed", "completed"]


def test_automation_rechecks_model_tenant_before_permit_or_provider_io(
    workflow_store,
) -> None:
    model = workflow_store.models["gpt-4o-mini"]
    workflow_store.models[model.id] = model.model_copy(update={"tenant_id": "tenant-other"})
    gateway = SequenceGateway([_payload(3)])

    with pytest.raises(HTTPException) as captured:
        execute_chain(
            workflow_store,
            _automation(),
            workflow_store.users["user-admin"],
            gateway,
        )

    assert captured.value.status_code == 403
    assert "outside the automation tenant" in str(captured.value.detail)
    assert gateway.calls == 0
    assert _permit_statuses(workflow_store) == []
    assert list(workflow_store.usage_records) == []


def test_automation_completion_id_allocation_failure_closes_started_permit(
    workflow_store,
    monkeypatch,
) -> None:
    request_id = str(uuid4())
    allocation_calls = 0

    def allocate_identifier() -> str:
        nonlocal allocation_calls
        allocation_calls += 1
        if allocation_calls == 1:
            return request_id
        raise RuntimeError("completion identifier allocation failed")

    monkeypatch.setattr(automation_runner, "new_accounting_id", allocate_identifier)
    gateway = SequenceGateway([_payload(3)])

    with pytest.raises(RuntimeError, match="completion identifier allocation failed"):
        execute_chain(
            workflow_store,
            _automation(),
            workflow_store.users["user-admin"],
            gateway,
        )

    assert allocation_calls == 2
    assert gateway.calls == 0
    assert _permit_statuses(workflow_store) == ["failed"]
    assert list(workflow_store.usage_records) == []


def test_automation_replayed_request_refuses_second_provider_call(
    workflow_store,
    monkeypatch,
) -> None:
    request_id = str(uuid4())
    completion_id = str(uuid4())
    identifiers = iter([request_id, completion_id, request_id])
    issued: list[str] = []

    def next_identifier() -> str:
        value = next(identifiers)
        issued.append(value)
        return value

    class AllocationCheckingGateway(SequenceGateway):
        def complete(self, *, route, messages, max_tokens, tools=None):
            assert issued == [request_id, completion_id]
            return super().complete(
                route=route, messages=messages, max_tokens=max_tokens, tools=tools
            )

    monkeypatch.setattr(automation_runner, "new_accounting_id", next_identifier)
    gateway = AllocationCheckingGateway([_payload(3)])
    actor = workflow_store.users["user-admin"]
    orchestrator = TenantUsageBudgetOrchestrator(workflow_store.usage_budget_repository)

    execute_chain(workflow_store, _automation(), actor, gateway, orchestrator)
    with pytest.raises(HTTPException) as captured:
        execute_chain(workflow_store, _automation(), actor, gateway, orchestrator)

    assert captured.value.status_code == 503
    assert gateway.calls == 1
    assert len(workflow_store.usage_records) == 1


def test_automation_completion_id_collision_fails_closed_without_misattribution(
    workflow_store,
    monkeypatch,
) -> None:
    shared_completion_id = str(uuid4())
    identifiers = iter(
        [
            str(uuid4()),
            shared_completion_id,
            str(uuid4()),
            shared_completion_id,
        ]
    )
    monkeypatch.setattr(automation_runner, "new_accounting_id", lambda: next(identifiers))
    gateway = SequenceGateway([_payload(3, "First"), _payload(5, "Second")])

    with pytest.raises(HTTPException) as captured:
        execute_chain(
            workflow_store,
            _automation(steps=2),
            workflow_store.users["user-admin"],
            gateway,
        )

    assert captured.value.status_code == 503
    assert gateway.calls == 2
    records = list(workflow_store.usage_records)
    assert len(records) == 1
    assert records[0].total_tokens == 3
    assert sorted(_permit_statuses(workflow_store)) == ["completed", "failed"]


def test_automation_budget_exhaustion_returns_429_with_retry_after(
    workflow_store,
) -> None:
    actor = workflow_store.users["user-admin"]
    workflow_store.usage_budget_repository.set_budget(
        "tenant-example",
        1,
        updated_by=actor.id,
    )
    gateway = SequenceGateway([_payload(1)])
    orchestrator = TenantUsageBudgetOrchestrator(workflow_store.usage_budget_repository)

    execute_chain(workflow_store, _automation(), actor, gateway, orchestrator)
    with pytest.raises(HTTPException) as captured:
        execute_chain(workflow_store, _automation(), actor, gateway, orchestrator)

    assert captured.value.status_code == 429
    assert int(captured.value.headers["Retry-After"]) > 0
    assert gateway.calls == 1


def test_automation_malformed_usage_fails_closed_without_estimation(workflow_store) -> None:
    gateway = SequenceGateway(
        [
            {
                "choices": [{"message": {"role": "assistant", "content": "Done"}}],
                "usage": ["not", "an", "object"],
            }
        ]
    )

    with pytest.raises(HTTPException) as captured:
        execute_chain(
            workflow_store,
            _automation(),
            workflow_store.users["user-admin"],
            gateway,
        )

    assert captured.value.status_code == 503
    assert gateway.calls == 1
    assert list(workflow_store.usage_records) == []
    assert _permit_statuses(workflow_store) == ["failed"]


def test_automation_non_object_success_is_settled_unmetered_before_parse_failure(
    workflow_store,
) -> None:
    gateway = SequenceGateway([["valid", "json", "but", "not", "an", "object"]])

    with pytest.raises(AttributeError, match="has no attribute 'get'"):
        execute_chain(
            workflow_store,
            _automation(),
            workflow_store.users["user-admin"],
            gateway,
        )

    records = list(workflow_store.usage_records)
    assert gateway.calls == 1
    assert len(records) == 1
    assert records[0].surface == "automation"
    assert records[0].total_tokens is None
    daily = workflow_store.usage_budget_repository.get_daily_usage(
        "tenant-example",
        datetime.now(UTC).date(),
    )
    assert daily is not None
    assert daily.reported_tokens == 0
    assert daily.unmetered_completions == 1
    assert _permit_statuses(workflow_store) == ["failed"]


def test_later_automation_provider_failure_preserves_prior_step_event(workflow_store) -> None:
    gateway = SequenceGateway([_payload(4, "First"), ModelGatewayError("upstream failed")])

    with pytest.raises(ModelGatewayError, match="upstream failed"):
        execute_chain(
            workflow_store,
            _automation(steps=2),
            workflow_store.users["user-admin"],
            gateway,
        )

    records = list(workflow_store.usage_records)
    assert gateway.calls == 2
    assert len(records) == 1
    assert records[0].total_tokens == 4
    assert sorted(_permit_statuses(workflow_store)) == ["completed", "failed"]
