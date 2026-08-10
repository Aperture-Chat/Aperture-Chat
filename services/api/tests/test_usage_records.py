"""Durable usage records: recording hooks, honesty rules, retention, persistence."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.automation_runner import execute_chain
from app.core.model_gateway import ModelGatewayClient
from app.core.security import SecretVault
from app.main import app
from app.models.schemas import Automation, AutomationStep
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _activate_provider(provider_id: str) -> None:
    store = get_store()
    provider = store.providers[provider_id]
    provider.connected = True
    platform_keys = sorted(
        (
            key
            for key in store.provider_keys.values()
            if key.provider_id == provider_id and key.tenant_id is None
        ),
        key=lambda key: key.id,
    )
    if platform_keys:
        for index, key in enumerate(platform_keys):
            key.status = "Active" if index == 0 else "Inactive"
        store.save_runtime_state(urgent=True)
    else:
        store.create_provider_key(
            key_id=f"key-{provider_id}-test",
            provider=provider,
            name=f"{provider.name} Test Key",
            environment="Test",
            status="Active",
            expires="Not set",
            secret_value=f"{provider.kind}-test-key",
        )


def _completion_handler(usage: dict[str, int] | None):
    def handler(request: httpx.Request) -> httpx.Response:
        body: dict[str, object] = {
            "id": "gen-usage",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Done."},
                    "finish_reason": "stop",
                }
            ],
        }
        if usage is not None:
            body["usage"] = usage
        return httpx.Response(200, json=body)

    return handler


def _mock_gateway(monkeypatch, usage: dict[str, int] | None) -> None:
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(_completion_handler(usage))),
    )


def test_non_stream_completion_records_provider_tokens(monkeypatch) -> None:
    _activate_provider("provider-azure")
    _mock_gateway(monkeypatch, {"prompt_tokens": 20, "completion_tokens": 30, "total_tokens": 50})

    response = client.post(
        "/api/chat/complete",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
        headers=headers(),
    )

    assert response.status_code == 200
    records = get_store().usage_records
    assert len(records) == 1
    record = records[0]
    assert record.user_id == "user-admin"
    assert record.model_id == "gpt-4o-mini"
    assert record.surface == "chat"
    assert record.source == "live"
    assert (record.prompt_tokens, record.completion_tokens, record.total_tokens) == (20, 30, 50)


def test_unreported_usage_stays_none_not_zero(monkeypatch) -> None:
    _activate_provider("provider-azure")
    _mock_gateway(monkeypatch, None)

    response = client.post(
        "/api/chat/complete",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
        headers=headers(),
    )

    assert response.status_code == 200
    record = get_store().usage_records[-1]
    # The gateway zero-fills missing usage; the record must not fabricate zeros.
    assert record.prompt_tokens is None
    assert record.completion_tokens is None
    assert record.total_tokens is None
    assert record.message_count == 1


def test_draft_surface_is_recorded(monkeypatch) -> None:
    _activate_provider("provider-azure")
    _mock_gateway(monkeypatch, {"prompt_tokens": 5, "completion_tokens": 7, "total_tokens": 12})

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "draft"}],
            "surface": "draft",
        },
        headers=headers(),
    )

    assert response.status_code == 200
    assert get_store().usage_records[-1].surface == "draft"


def test_stream_completion_records_summed_usage(monkeypatch) -> None:
    from app.core.model_gateway import ModelGatewayRoute

    def configured_route(_store, _model, *, tenant_id: str | None) -> ModelGatewayRoute:
        assert tenant_id == "tenant-example"
        return ModelGatewayRoute(
            provider_id="provider-test",
            provider_name="Test Provider",
            provider_kind="openai-compatible",
            auth_type="bearer",
            upstream_model="openai/gpt-4o-mini",
            base_url="https://provider.invalid/v1",
            configured=True,
            status_message="Configured",
            secret_value="test-only-secret",
        )

    monkeypatch.setattr(
        "app.routes.chat._resolve_gateway_route",
        configured_route,
    )

    def fake_stream(*args, **kwargs):
        usage_sink = kwargs.get("usage_sink")

        def gen():
            yield "Hello"
            yield " world"
            if usage_sink is not None:
                usage_sink.update({"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20})
                usage_sink["finish_reason"] = "stop"

        return gen()

    monkeypatch.setattr("app.routes.chat._gateway_stream", fake_stream)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "hi"}],
            "stream": True,
        },
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    assert "[DONE]" in response.text
    record = get_store().usage_records[-1]
    assert record.user_id == "user-jane"
    assert record.surface == "chat"
    assert (record.prompt_tokens, record.completion_tokens, record.total_tokens) == (12, 8, 20)


def test_automation_steps_record_usage(monkeypatch) -> None:
    _activate_provider("provider-azure")
    store = get_store()
    actor = store.users["user-admin"]
    automation = Automation(
        id="automation-usage-test",
        tenant_id="tenant-example",
        name="Usage test",
        trigger_type="once",
        prompt="Summarize the week.",
        steps=[AutomationStep(model_id="gpt-4o-mini", instruction="Summarize.")],
        enabled=True,
        created_by=actor.id,
    )
    gateway = ModelGatewayClient(
        transport=httpx.MockTransport(
            _completion_handler({"prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13})
        )
    )

    transcript, final_text = execute_chain(store, automation, actor, gateway)

    assert transcript and final_text == "Done."
    record = store.usage_records[-1]
    assert record.surface == "automation"
    assert record.model_id == "gpt-4o-mini"
    assert record.total_tokens == 13


def test_retention_trims_oldest(monkeypatch) -> None:
    monkeypatch.setattr("app.repositories.seed.USAGE_RECORDS_MAX", 5)
    store = get_store()
    actor = store.users["user-admin"]
    for index in range(7):
        store.record_usage(
            actor=actor,
            model_id=f"model-{index}",
            usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        )
    assert len(store.usage_records) == 5
    assert store.usage_records[0].model_id == "model-2"
    assert store.usage_records[-1].model_id == "model-6"


def _fresh_store(tmp_path, state_payload: dict | None = None) -> SeedStore:
    state_path = tmp_path / "runtime_state.json"
    if state_payload is not None:
        state_path.write_text(json.dumps(state_payload), encoding="utf-8")
    return SeedStore(SecretVault("test-secret"), runtime_state_path=str(state_path))


def test_persistence_round_trip(tmp_path) -> None:
    store = _fresh_store(tmp_path)
    actor = store.users["user-admin"]
    store.record_usage(
        actor=actor,
        model_id="gpt-4o-mini",
        provider_name="Azure OpenAI",
        usage={"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7},
        thread_id="thread-1",
    )
    store.flush_now()

    reloaded = _fresh_store(tmp_path)
    assert len(reloaded.usage_records) == 1
    record = reloaded.usage_records[0]
    assert record.model_id == "gpt-4o-mini"
    assert record.total_tokens == 7
    assert record.thread_id == "thread-1"


_PRE_UPGRADE_STATE = {
    "version": 2,
    "tenants": [
        {
            "id": "tenant-example",
            "name": "Example Tenant",
            "slug": "example-tenant",
        }
    ],
    "users": [
        {
            "id": "user-admin",
            "tenant_id": "tenant-example",
            "email": "admin@example.test",
            "display_name": "Admin User",
            "role": "TENANT_ADMIN",
        }
    ],
    "chat_threads": [
        {
            "id": "thread-legacy",
            "tenant_id": "tenant-example",
            "owner_user_id": "user-admin",
            "title": "Legacy thread",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "updated_at": "Jul 1, 2026",
            "messages": [
                {
                    "id": "msg-user",
                    "role": "user",
                    "content": "hello",
                    "createdAt": "9:00 AM",
                    "createdAtIso": "2026-07-01T09:00:00+00:00",
                },
                {
                    "id": "msg-reply",
                    "role": "assistant",
                    "content": "hi",
                    "createdAt": "9:01 AM",
                    "createdAtIso": "2026-07-01T09:01:00+00:00",
                    "usage": {"prompt_tokens": 4, "completion_tokens": 6, "total_tokens": 10},
                },
                {
                    "id": "msg-no-iso",
                    "role": "assistant",
                    "content": "no timestamp",
                    "createdAt": "9:02 AM",
                },
            ],
        }
    ],
    "chat_sessions": [
        {
            "id": "thread-legacy",
            "tenant_id": "tenant-example",
            "owner_user_id": "user-admin",
            "title": "Legacy thread",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "updated_at": "Jul 1, 2026",
        }
    ],
}


def test_state_without_usage_key_backfills_from_threads(tmp_path) -> None:
    # A version-2 payload written before usage records existed must load and
    # backfill from its chat threads: message counts always, tokens only when
    # the message carried provider-reported usage, and no invented timestamps.
    store = _fresh_store(tmp_path, _PRE_UPGRADE_STATE)
    assert store._usage_records_loaded is True
    assert len(store.usage_records) == 1  # the no-ISO assistant message is skipped
    record = store.usage_records[0]
    assert record.source == "backfill"
    assert record.user_id == "user-admin"
    assert record.thread_id == "thread-legacy"
    assert record.total_tokens == 10
    assert record.created_at.isoformat() == "2026-07-01T09:01:00+00:00"


def test_backfill_runs_once_and_does_not_duplicate(tmp_path) -> None:
    first = _fresh_store(tmp_path, _PRE_UPGRADE_STATE)
    assert len(first.usage_records) == 1
    # Trigger a save so the reloaded store finds the usage_records key present.
    first.save_runtime_state()
    first.flush_now()

    second = _fresh_store(tmp_path)
    assert len(second.usage_records) == 1
    payload = json.loads((tmp_path / "runtime_state.json").read_text(encoding="utf-8"))
    # Identity/config authority now lives in SQL; the retired JSON file is a
    # receipt-only v5 tombstone and must not carry relational usage rows.
    assert payload["version"] == 5
    assert "usage_records" not in payload


def test_blank_state_without_threads_loads_with_no_records(tmp_path) -> None:
    store = _fresh_store(tmp_path, {"version": 2})
    assert list(store.usage_records) == []
