from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayError, ModelGatewayRoute
from app.main import app
from app.models.schemas import ModelConfig
from app.repositories.deps import get_store


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _headers() -> dict[str, str]:
    return {"x-aperture-user": "user-jane"}


def _configured_route(upstream_model: str = "openai/gpt-4o-mini") -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id="provider-test",
        provider_name="Test Provider",
        provider_kind="openai-compatible",
        auth_type="bearer",
        upstream_model=upstream_model,
        base_url="https://provider.invalid/v1",
        configured=True,
        status_message="Configured",
        secret_value="test-only-secret",
    )


def _configured_tenant_route(_store, _model, *, tenant_id: str | None) -> ModelGatewayRoute:
    assert tenant_id == "tenant-example"
    return _configured_route()


def _events(response_text: str) -> list[object]:
    events: list[object] = []
    for line in response_text.splitlines():
        if not line.startswith("data: "):
            continue
        data = line.removeprefix("data: ")
        events.append(data if data == "[DONE]" else json.loads(data))
    return events


def test_stream_emits_deltas_metadata_then_done(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _configured_tenant_route)
    monkeypatch.setattr(
        "app.routes.chat._resolve_runtime_context",
        lambda store, actor, request, model: {
            "citations": [
                {
                    "id": "citation-1",
                    "source_name": "Matter policy",
                    "source_type": "knowledge",
                    "source_uri": "knowledge://matter-policy",
                    "snippet": "Retention is seven years.",
                }
            ],
            "citations_enabled": True,
        },
    )
    monkeypatch.setattr(
        "app.routes.chat._gateway_stream",
        lambda *args, **kwargs: iter(["Hello", " world"]),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": True,
        },
        headers=_headers(),
    )

    assert response.status_code == 200
    events = _events(response.text)
    assert events[0] == {"delta": "Hello"}
    assert events[1] == {"delta": " world"}
    assert events[2]["done"] is True
    assert events[2]["citations"][0]["source_name"] == "Matter policy"
    assert events[2]["usage"] is None
    assert events[3] == "[DONE]"


def test_stream_error_is_honest_and_has_no_success_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _configured_tenant_route)

    def failing_stream(*args, **kwargs):
        yield "Partial"
        raise ModelGatewayError("upstream disconnected")

    monkeypatch.setattr("app.routes.chat._gateway_stream", failing_stream)
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": True,
        },
        headers=_headers(),
    )

    assert response.status_code == 200
    events = _events(response.text)
    assert events[0] == {"delta": "Partial"}
    assert "upstream disconnected" in events[1]["error"]
    assert events[2] == "[DONE]"
    assert not any(isinstance(event, dict) and event.get("done") for event in events)


def test_image_model_rejects_streaming_before_provider_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    store.models["image-test"] = ModelConfig(
        id="image-test",
        provider_id="provider-test",
        provider_name="Test Provider",
        name="Image Test",
        upstream_model_id="google/gemini-3.1-flash-image-preview",
        group_ids=["group-litigation"],
    )

    def image_route(_store, model, *, tenant_id: str | None):
        assert tenant_id == "tenant-example"
        return _configured_route(model.upstream_model_id)

    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", image_route)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "image-test",
            "messages": [{"role": "user", "content": "Draw a lighthouse"}],
            "stream": True,
        },
        headers=_headers(),
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Image models return complete responses; retry without streaming."
    )


def test_stream_continues_in_place_when_provider_stops_at_token_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _configured_tenant_route)
    calls: list[dict] = []

    def fake_stream(*args, **kwargs):
        calls.append(kwargs)
        usage_sink = kwargs.get("usage_sink")
        if len(calls) == 1:
            if usage_sink is not None:
                usage_sink.update(
                    {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
                )
                usage_sink["finish_reason"] = "length"
            return iter(["First half."])
        if usage_sink is not None:
            usage_sink.update({"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20})
            usage_sink["finish_reason"] = "stop"
        return iter(["Second half."])

    monkeypatch.setattr("app.routes.chat._gateway_stream", fake_stream)

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Write everything."}],
            "stream": True,
        },
        headers=_headers(),
    )

    assert response.status_code == 200
    events = _events(response.text)
    deltas = [event["delta"] for event in events if isinstance(event, dict) and "delta" in event]
    # The continuation round is joined the same way the non-stream path joins
    # segments: a new paragraph when the partial ends mid-line.
    assert deltas == ["First half.", "\n\nSecond half."]
    done_event = next(event for event in events if isinstance(event, dict) and event.get("done"))
    # Usage is summed across continuation rounds, never estimated.
    assert done_event["usage"] == {"prompt_tokens": 22, "completion_tokens": 28, "total_tokens": 50}
    # The continuation request replays the conversation plus the partial answer.
    assert len(calls) == 2
    continuation_messages = calls[1]["messages"]
    assert continuation_messages[-2] == {"role": "assistant", "content": "First half."}
    assert (
        "Continue exactly where the previous answer stopped" in continuation_messages[-1]["content"]
    )


def test_stream_forwards_upstream_keepalives_as_sse_comments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _configured_tenant_route)
    # The gateway yields an empty sentinel when the upstream sends a
    # keep-alive comment while the model is still thinking.
    monkeypatch.setattr(
        "app.routes.chat._gateway_stream",
        lambda *args, **kwargs: iter(["", "", "Hello"]),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": True,
        },
        headers=_headers(),
    )

    assert response.status_code == 200
    assert response.text.count(": keep-alive") == 2
    events = _events(response.text)
    assert {"delta": "Hello"} in events
    # Keep-alives are comments, not data events; they never reach the parser.
    assert not any(isinstance(event, dict) and event.get("delta") == "" for event in events)


def test_stream_error_events_carry_honest_retryable_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _configured_tenant_route)

    def overloaded_stream(*args, **kwargs):
        raise ModelGatewayError("Test Provider returned HTTP 529", status_code=529)
        yield  # pragma: no cover - makes this a generator

    monkeypatch.setattr("app.routes.chat._gateway_stream", overloaded_stream)
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": True,
        },
        headers=_headers(),
    )
    events = _events(response.text)
    assert events[0]["retryable"] is True

    from app.core.model_gateway import ModelGatewayConfigurationError

    def misconfigured_stream(*args, **kwargs):
        raise ModelGatewayConfigurationError(
            "Provider key is not configured in the platform vault."
        )
        yield  # pragma: no cover - makes this a generator

    monkeypatch.setattr("app.routes.chat._gateway_stream", misconfigured_stream)
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": True,
        },
        headers=_headers(),
    )
    events = _events(response.text)
    assert events[0]["retryable"] is False


def test_continuation_failure_closes_with_streamed_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A provider failure while extending a budget-cut reply must not erase
    the content the user already received; the stream closes as complete."""

    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _configured_tenant_route)
    calls = {"count": 0}

    def continuation_stream(*args, **kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            usage_sink = kwargs.get("usage_sink")

            def first_round():
                yield "First half of the reply"
                if usage_sink is not None:
                    usage_sink["finish_reason"] = "length"

            return first_round()
        raise ModelGatewayError(
            "OpenRouter returned HTTP 400: invalid continuation request", status_code=400
        )

    monkeypatch.setattr("app.routes.chat._gateway_stream", continuation_stream)
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": True,
        },
        headers=_headers(),
    )

    assert response.status_code == 200
    events = _events(response.text)
    assert calls["count"] == 2
    assert events[0] == {"delta": "First half of the reply"}
    assert not any(isinstance(event, dict) and "error" in event for event in events)
    done_events = [
        event for event in events if isinstance(event, dict) and event.get("done") is True
    ]
    assert len(done_events) == 1
    assert events[-1] == "[DONE]"
