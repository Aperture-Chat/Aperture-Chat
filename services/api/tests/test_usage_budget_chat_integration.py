"""Provider-boundary integration coverage for tenant token budgets."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.model_gateway import ModelGatewayClient
from app.core.usage_budget import new_accounting_id
from app.core.usage_budget_runtime import TenantUsageBudgetOrchestrator
from app.db.orm import TenantUsagePermitRow
from app.main import app
from app.models.schemas import ChatCompletionRequest
from app.repositories.deps import get_store
from app.routes.chat import (
    _resolve_gateway_route,
    _resolve_runtime_context,
    _stream_events,
)


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _headers() -> dict[str, str]:
    return {"x-aperture-user": "user-admin"}


def _activate_openrouter() -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    for model in store.models.values():
        if model.provider_id == provider.id:
            model.group_ids = list(dict.fromkeys([*model.group_ids, "group-litigation"]))
    platform_keys = sorted(
        (
            key
            for key in store.provider_keys.values()
            if key.provider_id == provider.id and key.tenant_id is None
        ),
        key=lambda key: key.id,
    )
    if platform_keys:
        for index, key in enumerate(platform_keys):
            key.status = "Active" if index == 0 else "Inactive"
        store.save_runtime_state(urgent=True)
        return
    store.create_provider_key(
        key_id="key-provider-openrouter-budget-test",
        provider=provider,
        name="OpenRouter Budget Test",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="openrouter-budget-test-key",
    )


def _daily_usage():
    store = get_store()
    return store.usage_budget_repository.get_daily_usage(
        "tenant-example",
        datetime.now(UTC).date(),
    )


def _permit_statuses() -> list[str]:
    repository = get_store().usage_budget_repository
    with Session(repository.engine) as session:
        return list(
            session.scalars(
                select(TenantUsagePermitRow.status).order_by(TenantUsagePermitRow.acquired_at)
            )
        )


def test_nonstream_continuation_settles_each_raw_child_under_one_permit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        request.read()
        if calls == 1:
            content = "First half"
            finish_reason = "length"
            usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        else:
            content = "Second half"
            finish_reason = "stop"
            usage = {"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7}
        return httpx.Response(
            200,
            json={
                "id": f"provider-child-{calls}",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": finish_reason,
                    }
                ],
                "usage": usage,
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )

    response = client.post(
        "/api/chat/complete",
        headers=_headers(),
        json={
            "model": "openrouter-openai-gpt-4o-mini",
            "messages": [{"role": "user", "content": "Finish the answer."}],
        },
    )

    assert response.status_code == 200
    assert response.json()["model"] == "openrouter-openai-gpt-4o-mini"
    assert calls == 2
    daily = _daily_usage()
    assert daily is not None
    assert daily.reported_tokens == 22
    assert daily.metered_completions == 2
    assert _permit_statuses() == ["completed"]
    records = get_store().usage_records_filtered(
        tenant_id="tenant-example",
        newest_first=False,
    )
    assert [record.total_tokens for record in records] == [15, 7]
    assert all(record.message_count == 1 for record in records)


def test_budget_rejection_stops_next_logical_request_before_provider_io(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()
    store = get_store()
    store.usage_budget_repository.set_budget(
        "tenant-example",
        1,
        updated_by="user-owner",
    )
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        request.read()
        return httpx.Response(
            200,
            json={
                "id": f"provider-budget-{calls}",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Done"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 1},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )
    payload = {
        "model": "openrouter-openai-gpt-4o-mini",
        "messages": [{"role": "user", "content": "One token."}],
    }

    assert client.post("/api/chat/complete", headers=_headers(), json=payload).status_code == 200
    rejected = client.post("/api/chat/complete", headers=_headers(), json=payload)

    assert rejected.status_code == 429
    assert int(rejected.headers["retry-after"]) > 0
    assert calls == 1
    assert _permit_statuses() == ["completed"]


@pytest.mark.parametrize(
    ("path", "grant_api_access"),
    [
        ("/api/chat/complete", False),
        ("/v1/chat/completions", True),
    ],
)
def test_stream_accounting_failure_emits_terminal_error_without_done(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    grant_api_access: bool,
) -> None:
    _activate_openrouter()
    if grant_api_access:
        store = get_store()
        store.platform_settings.downstream_api_enabled = True
        store.groups["group-litigation"].permissions["api_access"] = True
    upstream = (
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
        'data: {"choices":[],"usage":{"total_tokens":"not-an-integer"}}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        return httpx.Response(
            200,
            content=upstream.encode(),
            headers={"content-type": "text/event-stream"},
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )
    response = client.post(
        path,
        headers=_headers(),
        json={
            "model": "openrouter-openai-gpt-4o-mini",
            "messages": [{"role": "user", "content": "Stream."}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert "usage_metering_invalid" in response.text
    assert "data: [DONE]" not in response.text
    assert _daily_usage() is None
    assert _permit_statuses() == ["failed"]


def test_malformed_nonstream_usage_fails_closed_after_raw_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        request.read()
        return httpx.Response(
            200,
            json={
                "id": "provider-malformed-usage",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Undeliverable"},
                        "finish_reason": "length",
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 99},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )
    response = client.post(
        "/api/chat/complete",
        headers=_headers(),
        json={
            "model": "openrouter-openai-gpt-4o-mini",
            "messages": [{"role": "user", "content": "Return malformed usage."}],
        },
    )

    assert response.status_code == 503
    assert "could not be recorded exactly" in response.json()["detail"]
    assert _daily_usage() is None
    assert _permit_statuses() == ["failed"]
    assert calls == 1


@pytest.mark.parametrize(
    ("path", "usage", "expected_metered", "expected_surface"),
    [
        (
            "/api/chat/complete",
            {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
            1,
            "chat",
        ),
        ("/api/chat/complete", None, 0, "chat"),
        (
            "/v1/chat/completions",
            {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
            1,
            "gateway",
        ),
        ("/v1/chat/completions", None, 0, "gateway"),
    ],
)
def test_stream_success_records_reported_or_explicit_unmetered_child(
    monkeypatch: pytest.MonkeyPatch,
    path: str,
    usage: dict[str, int] | None,
    expected_metered: int,
    expected_surface: str,
) -> None:
    _activate_openrouter()
    if path.startswith("/v1/"):
        store = get_store()
        store.platform_settings.downstream_api_enabled = True
        store.groups["group-litigation"].permissions["api_access"] = True
    usage_chunk = (
        f"data: {json.dumps({'choices': [], 'usage': usage})}\n\n" if usage is not None else ""
    )
    upstream = (
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
        f"{usage_chunk}"
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        return httpx.Response(
            200,
            content=upstream.encode(),
            headers={"content-type": "text/event-stream"},
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )
    response = client.post(
        path,
        headers=_headers(),
        json={
            "model": "openrouter-openai-gpt-4o-mini",
            "messages": [{"role": "user", "content": "Stream."}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert "data: [DONE]" in response.text
    daily = _daily_usage()
    assert daily is not None
    assert daily.metered_completions == expected_metered
    assert daily.unmetered_completions == 1 - expected_metered
    assert daily.reported_tokens == (5 if expected_metered else 0)
    assert _permit_statuses() == ["completed"]
    records = get_store().usage_records_filtered(
        tenant_id="tenant-example",
        newest_first=False,
    )
    assert len(records) == 1
    assert records[0].model_id == "openrouter-openai-gpt-4o-mini"
    assert records[0].provider_name == "OpenRouter"
    assert records[0].surface == expected_surface


def test_upstream_stream_error_fails_permit_without_inventing_usage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("upstream unavailable", request=request)

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )
    response = client.post(
        "/api/chat/complete",
        headers=_headers(),
        json={
            "model": "openrouter-openai-gpt-4o-mini",
            "messages": [{"role": "user", "content": "Stream."}],
            "stream": True,
        },
    )

    assert response.status_code == 200
    assert "did not return a completion" in response.text
    assert "data: [DONE]" in response.text
    assert _daily_usage() is None
    assert _permit_statuses() == ["failed"]
    assert get_store().usage_records_filtered(tenant_id="tenant-example") == []


def test_sync_gateway_factory_failure_closes_started_permit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()

    def fail_factory():
        raise RuntimeError("gateway factory failed")

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", fail_factory)

    with pytest.raises(RuntimeError, match="gateway factory failed"):
        client.post(
            "/api/chat/complete",
            headers=_headers(),
            json={
                "model": "openrouter-openai-gpt-4o-mini",
                "messages": [{"role": "user", "content": "Do not leak a permit."}],
            },
        )

    assert _permit_statuses() == ["failed"]
    assert _daily_usage() is None


def test_stream_gateway_factory_failure_closes_started_permit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()
    store = get_store()
    actor = store.users["user-admin"]
    model = store.models["openrouter-openai-gpt-4o-mini"]
    request = ChatCompletionRequest(
        model=model.id,
        messages=[{"role": "user", "content": "Do not leak a stream permit."}],
        stream=True,
    )
    usage_context = TenantUsageBudgetOrchestrator(store.usage_budget_repository).begin_request(
        actor=actor,
        request_id=new_accounting_id(),
        known_tenant_ids=store.tenants.keys(),
    )

    def fail_factory():
        raise RuntimeError("stream gateway factory failed")

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", fail_factory)
    events = _stream_events(
        request,
        model,
        _resolve_gateway_route(store, model, tenant_id="tenant-example"),
        _resolve_runtime_context(store, actor, request, model),
        store=store,
        actor=actor,
        usage_context=usage_context,
    )

    with pytest.raises(RuntimeError, match="stream gateway factory failed"):
        next(events)

    assert _permit_statuses() == ["failed"]
    assert _daily_usage() is None


def test_client_abandon_settles_started_round_as_unmetered_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()
    store = get_store()
    actor = store.users["user-admin"]
    model = store.models["openrouter-openai-gpt-4o-mini"]
    request = ChatCompletionRequest(
        model=model.id,
        messages=[{"role": "user", "content": "Disconnect."}],
        stream=True,
    )
    runtime_context = _resolve_runtime_context(store, actor, request, model)
    route = _resolve_gateway_route(store, model, tenant_id="tenant-example")
    usage_context = TenantUsageBudgetOrchestrator(store.usage_budget_repository).begin_request(
        actor=actor,
        request_id=new_accounting_id(),
        known_tenant_ids=store.tenants.keys(),
    )

    class FakeStreamingClient:
        def stream(self, **_kwargs):
            yield "first"
            yield "second"

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: FakeStreamingClient(),
    )
    events = _stream_events(
        request,
        model,
        route,
        runtime_context,
        store=store,
        actor=actor,
        usage_context=usage_context,
    )

    assert '"delta": "first"' in next(events)
    events.close()

    # Provider work started, so the disconnect must not bypass accounting:
    # the in-flight round settles as an explicit unmetered child (no token
    # estimate is ever invented) and only then is the permit abandoned.
    assert _permit_statuses() == ["abandoned"]
    daily = _daily_usage()
    assert daily is not None
    assert daily.metered_completions == 0
    assert daily.unmetered_completions == 1
    assert daily.reported_tokens == 0
    records = store.usage_records_filtered(tenant_id="tenant-example")
    assert len(records) == 1
    assert records[0].model_id == "openrouter-openai-gpt-4o-mini"


def test_client_abandon_after_provider_settlement_preserves_usage_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()
    store = get_store()
    actor = store.users["user-admin"]
    model = store.models["openrouter-openai-gpt-4o-mini"]
    request = ChatCompletionRequest(
        model=model.id,
        messages=[{"role": "user", "content": "Disconnect after upstream completes."}],
        stream=True,
    )
    runtime_context = _resolve_runtime_context(store, actor, request, model)
    route = _resolve_gateway_route(store, model, tenant_id="tenant-example")
    usage_context = TenantUsageBudgetOrchestrator(store.usage_budget_repository).begin_request(
        actor=actor,
        request_id=new_accounting_id(),
        known_tenant_ids=store.tenants.keys(),
    )

    class FakeStreamingClient:
        def stream(self, **kwargs):
            kwargs["usage_sink"].update(
                {
                    "prompt_tokens": 2,
                    "completion_tokens": 3,
                    "total_tokens": 5,
                    "finish_reason": "stop",
                }
            )
            yield "settled before delivery"

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: FakeStreamingClient(),
    )
    # Force whole-response buffering so the first user-visible event is yielded
    # after the raw provider child has been settled but before permit completion.
    monkeypatch.setattr("app.routes.chat.filters_have_output_rules", lambda _rules: True)
    events = _stream_events(
        request,
        model,
        route,
        runtime_context,
        store=store,
        actor=actor,
        usage_context=usage_context,
    )

    assert '"delta": "settled before delivery"' in next(events)
    events.close()

    assert _permit_statuses() == ["abandoned"]
    daily = _daily_usage()
    assert daily is not None
    assert daily.reported_tokens == 5
    assert daily.metered_completions == 1
    records = store.usage_records_filtered(tenant_id="tenant-example")
    assert len(records) == 1
    assert records[0].total_tokens == 5


def test_later_continuation_error_keeps_first_event_and_fails_permit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        request.read()
        if calls == 2:
            return httpx.Response(500, json={"error": "continuation failed"})
        return httpx.Response(
            200,
            json={
                "id": "provider-first-child",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Partial"},
                        "finish_reason": "length",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 4, "total_tokens": 9},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )
    response = client.post(
        "/api/chat/complete",
        headers=_headers(),
        json={
            "model": "openrouter-openai-gpt-4o-mini",
            "messages": [{"role": "user", "content": "Continue."}],
        },
    )

    assert response.status_code == 503
    assert calls == 2
    daily = _daily_usage()
    assert daily is not None
    assert daily.reported_tokens == 9
    assert daily.metered_completions == 1
    assert _permit_statuses() == ["failed"]
    records = get_store().usage_records_filtered(tenant_id="tenant-example")
    assert len(records) == 1
    assert records[0].total_tokens == 9


def test_missing_budget_fails_before_provider_io(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()
    get_store().usage_budget_repository.delete_budget("tenant-example")
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        request.read()
        return httpx.Response(500)

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )
    response = client.post(
        "/api/chat/complete",
        headers=_headers(),
        json={
            "model": "openrouter-openai-gpt-4o-mini",
            "messages": [{"role": "user", "content": "Do not run."}],
        },
    )

    assert response.status_code == 503
    assert "accounting is unavailable" in response.json()["detail"]
    assert calls == 0
    assert _permit_statuses() == []


def test_openai_compatible_nonstream_has_one_budget_record_and_no_legacy_duplicate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate_openrouter()
    store = get_store()
    store.platform_settings.downstream_api_enabled = True
    store.groups["group-litigation"].permissions["api_access"] = True
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.read().decode())
        return httpx.Response(
            200,
            json={
                "id": "provider-openai-compatible-child",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Gateway answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 6, "completion_tokens": 2, "total_tokens": 8},
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )
    response = client.post(
        "/v1/chat/completions",
        headers=_headers(),
        json={
            "model": "openrouter-openai-gpt-4o-mini",
            "messages": [{"role": "user", "content": "Gateway."}],
        },
    )

    assert response.status_code == 200
    assert response.json()["model"] == "openrouter-openai-gpt-4o-mini"
    assert captured["body"]["model"] == "openai/gpt-4o-mini"
    records = get_store().usage_records_filtered(tenant_id="tenant-example")
    assert len(records) == 1
    assert records[0].model_id == "openrouter-openai-gpt-4o-mini"
    assert records[0].provider_name == "OpenRouter"
    assert records[0].surface == "gateway"
    assert records[0].total_tokens == 8
    assert _permit_statuses() == ["completed"]
