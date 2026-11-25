"""A router that reports its upstream would not serve a model says so, and
another model answers; the failure is never delivered as an empty reply."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import (
    ModelGatewayClient,
    ModelGatewayError,
    ModelGatewayRoute,
    ModelUpstreamUnavailable,
)
from app.main import app
from app.repositories.deps import get_store


client = TestClient(app)

BLOCKED = (
    "Your resource has been temporarily blocked because we detected behavior that may violate our content policy."
)
# What OpenRouter sent, inside an HTTP 200 stream, when Azure blocked the resource.
IN_STREAM_REFUSAL = {
    "id": "gen-1",
    "object": "chat.completion.chunk",
    "model": "openai/gpt-6-astra",
    "provider": "Azure",
    "choices": [],
    "error": {"code": 502, "message": BLOCKED, "metadata": {"error_type": "provider_unavailable"}},
}
# The same refusal on a call that does not stream: the status carries it.
HTTP_REFUSAL = {"error": {"message": BLOCKED, "code": 502, "metadata": {"provider_name": "Azure"}}, "user_id": "org_1"}


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _route(_store=None, model=None, *, tenant_id: str | None = None, upstream: str = "openai/gpt-6-astra") -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id="provider-test",
        provider_name="Test Router",
        provider_kind="openai-compatible",
        auth_type="bearer",
        upstream_model=(model.upstream_model_id or model.id) if model is not None else upstream,
        base_url="https://provider.invalid/v1",
        configured=True,
        status_message="Configured",
        secret_value="test-only-secret",
    )


def _sse(*chunks: dict) -> httpx.Response:
    body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body.encode())


def _words(text: str, finish: str | None = None) -> dict:
    return {"choices": [{"index": 0, "delta": {"content": text}, "finish_reason": finish}]}


def _gateway(reply: httpx.Response) -> ModelGatewayClient:
    return ModelGatewayClient(transport=httpx.MockTransport(lambda _request: reply))


def _stream(reply: httpx.Response) -> list[str]:
    return list(_gateway(reply).stream(route=_route(), messages=[{"role": "user", "content": "hi"}]))


def test_an_upstream_refusal_inside_a_stream_is_raised_with_who_refused_and_why() -> None:
    with pytest.raises(ModelUpstreamUnavailable) as raised:
        _stream(_sse(IN_STREAM_REFUSAL))

    assert raised.value.served_by == "Azure"
    assert raised.value.status_code == 502
    assert str(raised.value) == f"Azure could not serve openai/gpt-6-astra: {BLOCKED}"


def test_an_upstream_refusal_that_names_no_upstream_still_says_what_happened() -> None:
    unnamed = {key: value for key, value in IN_STREAM_REFUSAL.items() if key != "provider"}

    with pytest.raises(ModelUpstreamUnavailable) as raised:
        _stream(_sse(unnamed))

    assert raised.value.served_by is None
    assert str(raised.value) == f"The upstream provider could not serve openai/gpt-6-astra: {BLOCKED}"


@pytest.mark.parametrize("code", [502, 503])
def test_either_gateway_status_from_a_named_upstream_is_an_upstream_refusal(code: int) -> None:
    chunk = {"provider": "Azure", "choices": [], "error": {"code": code, "message": "Upstream is down."}}

    with pytest.raises(ModelUpstreamUnavailable) as raised:
        _stream(_sse(chunk))

    assert raised.value.status_code == code


@pytest.mark.parametrize(
    ("error", "status_code", "retryable"),
    [
        ({"code": 429, "message": "Rate limit exceeded."}, 429, True),
        ({"code": 400, "message": "Rate limit exceeded."}, 400, False),
        # A code that is not an HTTP status is kept out of the status.
        ({"code": "rate_limit_exceeded", "message": "Rate limit exceeded."}, None, True),
        ({"code": True, "message": "Rate limit exceeded."}, None, True),
        # A gateway status with no upstream named is not known to be the upstream's doing.
        ({"code": 502, "message": "Rate limit exceeded."}, 502, True),
    ],
)
def test_any_other_error_inside_a_stream_is_raised_as_the_providers_own(
    error: dict, status_code: int | None, retryable: bool
) -> None:
    with pytest.raises(ModelGatewayError) as raised:
        _stream(_sse({"choices": [], "error": error}))

    assert not isinstance(raised.value, ModelUpstreamUnavailable)
    assert raised.value.status_code == status_code
    assert raised.value.retryable is retryable
    assert str(raised.value) == "Test Router reported an error: Rate limit exceeded."


def test_a_long_upstream_reason_is_cut_to_a_readable_length() -> None:
    chunk = {"choices": [], "error": {"code": 429, "message": "x" * 400}}

    with pytest.raises(ModelGatewayError) as raised:
        _stream(_sse(chunk))

    assert str(raised.value) == f"Test Router reported an error: {'x' * 300}"


def test_text_streamed_before_an_error_arrives_first() -> None:
    received: list[str] = []
    stream = _gateway(_sse(_words("May it "), IN_STREAM_REFUSAL)).stream(
        route=_route(), messages=[{"role": "user", "content": "hi"}]
    )

    with pytest.raises(ModelUpstreamUnavailable):
        for piece in stream:
            received.append(piece)

    assert received == ["May it "]


@pytest.mark.parametrize("error", [None, "", {}, []])
def test_a_stream_without_an_error_is_read_as_before(error: object) -> None:
    assert _stream(_sse({**_words("All "), "error": error}, _words("fine.", "stop"))) == ["All ", "fine."]


def _complete(reply: httpx.Response) -> dict:
    return _gateway(reply).complete(route=_route(), messages=[{"role": "user", "content": "hi"}])


def test_an_upstream_refusal_on_a_plain_call_is_raised_with_who_refused_and_why() -> None:
    with pytest.raises(ModelUpstreamUnavailable) as raised:
        _complete(httpx.Response(502, json=HTTP_REFUSAL))

    assert raised.value.served_by == "Azure"
    assert raised.value.status_code == 502
    assert str(raised.value) == f"Azure could not serve openai/gpt-6-astra: {BLOCKED}"


def test_the_status_decides_when_the_body_carries_no_code() -> None:
    body = {"error": {"message": BLOCKED, "metadata": {"provider_name": "Azure"}}}

    with pytest.raises(ModelUpstreamUnavailable) as raised:
        _complete(httpx.Response(503, json=body))

    assert raised.value.status_code == 503


@pytest.mark.parametrize(
    ("status_code", "body"),
    [
        (502, "Bad Gateway"),
        (502, '["Bad Gateway"]'),
        (502, json.dumps({"error": "Bad Gateway"})),
        (502, json.dumps({"error": {"message": "Bad Gateway"}})),
        # Only a gateway status speaks for the upstream.
        (429, json.dumps(HTTP_REFUSAL)),
    ],
)
def test_a_failed_call_that_names_no_refusing_upstream_stays_a_plain_failure(status_code: int, body: str) -> None:
    with pytest.raises(ModelGatewayError) as raised:
        _complete(httpx.Response(status_code, content=body.encode()))

    assert not isinstance(raised.value, ModelUpstreamUnavailable)
    assert str(raised.value) == f"Test Router returned HTTP {status_code}: {body[:300]}"


# --- The chat reply -------------------------------------------------------


def _only_models(*model_ids: str) -> None:
    """Leave only these models switched on, so the fallback is known."""
    for model in get_store().models.values():
        model.platform_enabled = model.id in model_ids


def _serve(monkeypatch: pytest.MonkeyPatch, by_model: dict[str, list[httpx.Response]]) -> list[str]:
    """Answer each upstream model through the real gateway with its own
    replies, in order (the last repeats). Returns the models asked, in order."""
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)
    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        upstream = json.loads(request.read().decode())["model"]
        replies = by_model[upstream]
        reply = replies[min(asked.count(upstream), len(replies) - 1)]
        asked.append(upstream)
        return reply

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)
    return asked


def _events(response_text: str) -> list[dict]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in response_text.splitlines()
        if line.startswith("data: ") and line != "data: [DONE]"
    ]


def _ask() -> list[dict]:
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Draft the oral argument."}],
            "stream": True,
        },
        headers={"x-aperture-user": "user-jane"},
    )
    assert response.status_code == 200
    return _events(response.text)


def _text(events: list[dict]) -> str:
    return "".join(event["delta"] for event in events if "delta" in event)


def _switches(events: list[dict]) -> list[dict]:
    return [event["activity"] for event in events if event.get("activity", {}).get("kind") == "model-fallback"]


def _fallback_audit() -> list:
    return [event for event in get_store().audit_events if event.action == "chat.completion_fallback"]


def test_a_reply_the_upstream_will_not_serve_is_answered_by_another_vendors_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4o", "gpt-4.1")
    asked = _serve(
        monkeypatch,
        {
            "gpt-4o-mini": [_sse(IN_STREAM_REFUSAL)],
            "gpt-4.1": [_sse(_words("May it please "), _words("the court.", "stop"))],
        },
    )

    events = _ask()

    assert _text(events) == "May it please the court."
    # Asking the same upstream again would only be refused again.
    assert asked == ["gpt-4o-mini", "gpt-4.1"]
    assert _switches(events) == [
        {"kind": "model-fallback", "from": "gpt-4o-mini", "to": "gpt-4.1", "served_by": "Azure", "reason": "unavailable"}
    ]
    assert any(event.get("done") for event in events)
    assert not any("error" in event for event in events)
    audit = _fallback_audit()
    assert [event.target_name for event in audit] == ["gpt-4.1"]
    assert audit[0].metadata["fallback_from"] == "gpt-4o-mini"
    assert audit[0].metadata["reason"] == "provider_unavailable"


def test_a_switch_from_an_upstream_nobody_named_names_none(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    unnamed = {key: value for key, value in IN_STREAM_REFUSAL.items() if key != "provider"}
    _serve(monkeypatch, {"gpt-4o-mini": [_sse(unnamed)], "gpt-4.1": [_sse(_words("Here it is.", "stop"))]})

    events = _ask()

    assert _text(events) == "Here it is."
    assert _switches(events) == [
        {"kind": "model-fallback", "from": "gpt-4o-mini", "to": "gpt-4.1", "reason": "unavailable"}
    ]


def test_the_model_that_answers_an_unserved_reply_gets_the_same_conversation(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    sent: list[list[dict]] = []
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.read().decode())
        sent.append([message for message in payload["messages"] if message["role"] != "system"])
        return _sse(IN_STREAM_REFUSAL) if payload["model"] == "gpt-4o-mini" else _sse(_words("Here it is.", "stop"))

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)

    _ask()

    assert len(sent) == 2
    assert sent[1] == sent[0]


def test_without_another_model_an_unserved_reply_ends_with_the_upstreams_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini")
    _serve(monkeypatch, {"gpt-4o-mini": [_sse(IN_STREAM_REFUSAL)]})

    events = _ask()

    assert _text(events) == ""
    assert _switches(events) == []
    error = next(event for event in events if "error" in event)
    assert error["error"] == f"Test Router did not return a completion: Azure could not serve gpt-4o-mini: {BLOCKED}"
    assert error["retryable"] is True
    assert not any(event.get("done") for event in events)


def test_a_reply_unserved_on_every_model_switches_once_and_ends_with_the_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [_sse(IN_STREAM_REFUSAL)], "gpt-4.1": [_sse(IN_STREAM_REFUSAL)]})

    events = _ask()

    assert asked == ["gpt-4o-mini", "gpt-4.1"]
    assert len(_switches(events)) == 1
    assert "Azure could not serve gpt-4.1" in next(event for event in events if "error" in event)["error"]
    assert not any(event.get("done") for event in events)


def test_a_reply_cut_by_the_upstream_after_it_began_keeps_its_model(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(
        monkeypatch,
        {"gpt-4o-mini": [_sse(_words("May it please "), IN_STREAM_REFUSAL)], "gpt-4.1": [_sse(_words("Other.", "stop"))]},
    )

    events = _ask()

    # The words already shown are this model's; the browser resumes from them.
    assert asked == ["gpt-4o-mini"]
    assert _text(events) == "May it please "
    assert _switches(events) == []
    error = next(event for event in events if "error" in event)
    assert "Azure could not serve gpt-4o-mini" in error["error"]
    assert error["retryable"] is True


def test_another_failure_inside_the_stream_is_shown_and_no_model_is_switched(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    limited = {"choices": [], "error": {"code": 429, "message": "Rate limit exceeded."}}
    asked = _serve(monkeypatch, {"gpt-4o-mini": [_sse(limited)], "gpt-4.1": [_sse(_words("Other.", "stop"))]})

    events = _ask()

    assert asked == ["gpt-4o-mini"]
    assert _switches(events) == []
    error = next(event for event in events if "error" in event)
    assert error["error"] == "Test Router did not return a completion: Test Router reported an error: Rate limit exceeded."


# --- A reply that does not stream (Drafts) --------------------------------


def _whole(content: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "gen",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        },
    )


def _draft() -> httpx.Response:
    return client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "surface": "draft",
            "work_steps": False,
            "messages": [{"role": "user", "content": "Write a short history of the Hundred Years' War."}],
        },
        headers={"x-aperture-user": "user-jane"},
    )


def test_a_draft_the_upstream_will_not_serve_is_written_by_another_vendors_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(
        monkeypatch,
        {
            "gpt-4o-mini": [httpx.Response(502, json=HTTP_REFUSAL)],
            "gpt-4.1": [_whole("<h1>The Hundred Years' War</h1><p>It began in 1337.</p>")],
        },
    )

    response = _draft()

    assert response.status_code == 200
    body = response.json()
    assert "It began in 1337." in body["choices"][0]["message"]["content"]
    assert asked[:2] == ["gpt-4o-mini", "gpt-4.1"]
    assert "gpt-4o-mini" not in asked[1:]
    assert body["activity"][0] == {
        "kind": "model-fallback",
        "from": "gpt-4o-mini",
        "to": "gpt-4.1",
        "served_by": "Azure",
        "reason": "unavailable",
    }
    audit = _fallback_audit()
    assert [event.target_name for event in audit] == ["gpt-4.1"]
    assert audit[0].metadata["reason"] == "provider_unavailable"
    assert audit[0].metadata["stream"] is False


def test_a_draft_its_own_model_writes_is_not_handed_to_another(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(
        monkeypatch,
        {
            "gpt-4o-mini": [_whole("<h1>The Hundred Years' War</h1><p>It began in 1337.</p>")],
            "gpt-4.1": [_whole("<p>Another model's draft.</p>")],
        },
    )

    response = _draft()

    assert response.status_code == 200
    assert "It began in 1337." in response.json()["choices"][0]["message"]["content"]
    assert set(asked) == {"gpt-4o-mini"}
    assert response.json()["activity"] == []
    assert _fallback_audit() == []


def test_a_draft_with_no_model_to_switch_to_fails_with_the_upstreams_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [httpx.Response(502, json=HTTP_REFUSAL)]})

    response = _draft()

    assert response.status_code == 503
    assert response.json()["detail"] == (
        f"Test Router did not return a completion: Azure could not serve gpt-4o-mini: {BLOCKED}"
    )
    assert asked == ["gpt-4o-mini"]
    assert _fallback_audit() == []
