"""A provider's safety filter that answers in the model's place is asked
again, and its stand-in text is never delivered as the reply."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayClient, ModelGatewayRoute
from app.core.provider_filter import MAX_FILTER_RETRIES, STAND_IN_REPLY
from app.main import app
from app.repositories.deps import get_store


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _route(_store, model, *, tenant_id: str | None) -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id="provider-test",
        provider_name="Test Router",
        provider_kind="openai-compatible",
        auth_type="bearer",
        upstream_model=model.upstream_model_id or model.id,
        base_url="https://provider.invalid/v1",
        configured=True,
        status_message="Configured",
        secret_value="test-only-secret",
    )


def _events(response_text: str) -> list[dict]:
    events = []
    for line in response_text.splitlines():
        if line.startswith("data: ") and line != "data: [DONE]":
            events.append(json.loads(line.removeprefix("data: ")))
    return events


def _only_models(*model_ids: str) -> None:
    """Leave only these models switched on, so the fallback is known."""
    for model in get_store().models.values():
        model.platform_enabled = model.id in model_ids


def _turns(
    monkeypatch: pytest.MonkeyPatch,
    turns: list[tuple[list[str], str]],
    by_model: dict[str, list[tuple[list[str], str]]] | None = None,
) -> list[dict]:
    """Serve these provider turns in order (the last one repeats): each is
    the pieces it streams and how it finishes. ``by_model`` serves another
    upstream model its own turns. Returns the calls made."""
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)
    calls: list[dict] = []
    served: dict[str, int] = {}

    def fake_stream(*args, **kwargs):
        upstream = kwargs["route"].upstream_model
        script = (by_model or {}).get(upstream, turns)
        count = served.get(upstream, 0)
        served[upstream] = count + 1
        pieces, finish = script[min(count, len(script) - 1)]
        calls.append(kwargs)
        sink = kwargs.get("usage_sink")
        if sink is not None:
            sink.update({"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
            sink["finish_reason"] = finish
            sink["served_by"] = "Azure"
        return iter(pieces)

    monkeypatch.setattr("app.routes.chat._gateway_stream", fake_stream)
    return calls


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


def _filter_steps(events: list[dict]) -> list[dict]:
    return [event["activity"] for event in events if event.get("activity", {}).get("kind") == "provider-filter"]


def test_a_withheld_turn_is_asked_again_and_the_real_reply_is_delivered(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _turns(monkeypatch, [([STAND_IN_REPLY], "content_filter"), (["May it please the court."], "stop")])

    events = _ask()

    assert _text(events) == "May it please the court."
    assert _filter_steps(events) == [{"kind": "provider-filter", "attempt": 1, "served_by": "Azure"}]
    assert len(calls) == 2
    # The same request goes out again, unchanged.
    assert calls[1]["messages"] == calls[0]["messages"]
    done = next(event for event in events if event.get("done"))
    assert done["usage"] == {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30}


def test_the_stand_in_is_held_back_even_when_it_arrives_in_pieces(monkeypatch: pytest.MonkeyPatch) -> None:
    _turns(
        monkeypatch,
        [(["I'm sorry, ", "but I cannot assist with that request."], "content_filter"), (["Here it is."], "stop")],
    )

    assert _text(_ask()) == "Here it is."


def test_a_reply_the_filter_keeps_withholding_is_answered_by_another_vendors_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4o", "gpt-4.1")
    calls = _turns(
        monkeypatch,
        [([STAND_IN_REPLY], "content_filter")],
        by_model={"gpt-4.1": [(["May it please the court."], "stop")]},
    )

    events = _ask()

    assert _text(events) == "May it please the court."
    # The same model is asked three times, then a model served elsewhere
    # (gpt-4o is served by the same upstream) answers the same request.
    assert [call["route"].upstream_model for call in calls] == ["gpt-4o-mini"] * (1 + MAX_FILTER_RETRIES) + ["gpt-4.1"]
    switch = [event["activity"] for event in events if event.get("activity", {}).get("kind") == "model-fallback"]
    assert switch == [{"kind": "model-fallback", "from": "gpt-4o-mini", "to": "gpt-4.1", "served_by": "Azure"}]
    assert any(event.get("done") for event in events)
    audit = [event for event in get_store().audit_events if event.action == "chat.completion_fallback"]
    assert len(audit) == 1
    assert audit[0].target_name == "gpt-4.1"


def test_the_model_that_answers_instead_gets_the_same_conversation(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    calls = _turns(
        monkeypatch,
        [([STAND_IN_REPLY], "content_filter")],
        by_model={"gpt-4.1": [(["Here it is."], "stop")]},
    )

    _ask()

    asked = [message for message in calls[-1]["messages"] if message["role"] != "system"]
    assert asked == [message for message in calls[0]["messages"] if message["role"] != "system"]


def test_a_reply_filtered_on_every_model_ends_with_the_reason_not_the_stand_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    calls = _turns(monkeypatch, [([STAND_IN_REPLY], "content_filter")])

    events = _ask()

    assert _text(events) == ""
    # Each of the two models is asked, then asked again twice.
    assert len(calls) == 2 * (1 + MAX_FILTER_RETRIES)
    error = next(event for event in events if "error" in event)
    assert "Azure's content filter withheld the model's reply" in error["error"]
    assert "Choose a different model or try again." in error["error"]
    assert error["retryable"] is False
    assert not any(event.get("done") for event in events)


def test_without_another_model_the_reply_ends_with_the_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini")
    calls = _turns(monkeypatch, [([STAND_IN_REPLY], "content_filter")])

    events = _ask()

    assert len(calls) == 1 + MAX_FILTER_RETRIES
    assert _filter_steps(events) and not any(event.get("activity", {}).get("kind") == "model-fallback" for event in events)
    assert "Azure's content filter withheld" in next(event for event in events if "error" in event)["error"]


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        (lambda model: setattr(model, "content_filter_ids", ["cf-preset-pii-hipaa"]), "other content rules"),
        (lambda model: setattr(model, "group_ids", ["group-hr"]), "not the person's to use"),
        (lambda model: setattr(model, "is_custom", True), "a workspace agent"),
        (lambda model: setattr(model, "tenant_id", "tenant-example"), "another tenant's"),
    ],
)
def test_a_model_the_reply_may_not_switch_to_is_never_used(
    monkeypatch: pytest.MonkeyPatch, change, reason: str
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    change(get_store().models["gpt-4.1"])
    calls = _turns(monkeypatch, [([STAND_IN_REPLY], "content_filter")])

    _ask()

    assert {call["route"].upstream_model for call in calls} == {"gpt-4o-mini"}, reason


def test_the_stand_in_without_a_filter_finish_is_asked_again(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _turns(monkeypatch, [([STAND_IN_REPLY], "stop"), (["Here it is."], "stop")])

    events = _ask()

    assert _text(events) == "Here it is."
    assert len(calls) == 2


def test_the_models_own_refusal_is_delivered_when_it_keeps_saying_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without the provider reporting its filter, the words may be the
    model's: after the retries they are delivered, not turned into an error."""
    calls = _turns(monkeypatch, [([STAND_IN_REPLY], "stop")])

    events = _ask()

    assert _text(events) == STAND_IN_REPLY
    assert len(calls) == 1 + MAX_FILTER_RETRIES
    assert any(event.get("done") for event in events)
    assert not any("error" in event for event in events)


def test_a_reply_that_only_starts_like_the_stand_in_is_delivered_whole(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _turns(monkeypatch, [(["I'm sorry, but I cannot ", "find that exhibit."], "stop")])

    events = _ask()

    assert _text(events) == "I'm sorry, but I cannot find that exhibit."
    assert len(calls) == 1
    assert _filter_steps(events) == []


def test_a_reply_the_filter_cut_short_keeps_going(monkeypatch: pytest.MonkeyPatch) -> None:
    """Text already read is kept, and the reply goes on after it instead of
    ending mid-sentence."""
    calls = _turns(
        monkeypatch,
        [(["May it please the court. Acme sold"], "content_filter"), (["the skates."], "stop")],
    )

    events = _ask()

    assert _text(events) == "May it please the court. Acme sold\n\nthe skates."
    assert len(calls) == 2
    assert calls[1]["messages"][-2] == {"role": "assistant", "content": "May it please the court. Acme sold"}
    assert "Continue exactly where the previous answer stopped" in calls[1]["messages"][-1]["content"]
    assert _filter_steps(events) == [{"kind": "provider-filter", "attempt": 1, "served_by": "Azure"}]
    assert any(event.get("done") for event in events)


def test_a_reply_cut_short_whose_rest_stays_withheld_is_finished_by_another_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    calls = _turns(
        monkeypatch,
        [(["May it please the court. Acme sold"], "content_filter"), ([""], "content_filter")],
        by_model={"gpt-4.1": [(["the skates."], "stop")]},
    )

    events = _ask()

    assert _text(events) == "May it please the court. Acme sold\n\nthe skates."
    assert calls[-1]["route"].upstream_model == "gpt-4.1"
    assert calls[-1]["messages"][-2] == {"role": "assistant", "content": "May it please the court. Acme sold"}
    assert any(event.get("done") for event in events)


def test_a_reply_cut_short_whose_rest_is_withheld_everywhere_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    """The shown text stays, and the reply ends with the reason instead of
    passing for a finished answer."""
    _only_models("gpt-4o-mini")
    _turns(monkeypatch, [(["May it please the court. Acme sold"], "content_filter"), ([""], "content_filter")])

    events = _ask()

    assert _text(events) == "May it please the court. Acme sold"
    error = next(event for event in events if "error" in event)
    assert "content filter withheld" in error["error"]
    assert error["retryable"] is False
    assert not any(event.get("done") for event in events)


def _draft_turns(monkeypatch: pytest.MonkeyPatch, by_model: dict[str, list[tuple[str, str]]]) -> list[str]:
    """Non-streamed calls through the real gateway: each upstream model
    answers with its own turns (the last repeats). Returns the upstream
    models called, in order."""
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)
    asked: list[str] = []
    served: dict[str, int] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        upstream = json.loads(request.read().decode())["model"]
        script = by_model[upstream]
        count = served.get(upstream, 0)
        served[upstream] = count + 1
        asked.append(upstream)
        content, finish = script[min(count, len(script) - 1)]
        return httpx.Response(
            200,
            json={
                "id": "gen",
                "model": upstream,
                "provider": "Azure",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": finish}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            },
        )

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)
    return asked


def _draft() -> object:
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


def test_a_draft_the_filter_keeps_withholding_is_written_by_another_vendors_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _draft_turns(
        monkeypatch,
        {
            "gpt-4o-mini": [(STAND_IN_REPLY, "content_filter")],
            "gpt-4.1": [("<h1>The Hundred Years' War</h1><p>It began in 1337.</p>", "stop")],
        },
    )

    response = _draft()

    assert response.status_code == 200
    body = response.json()
    assert "It began in 1337." in body["choices"][0]["message"]["content"]
    assert asked[: 1 + MAX_FILTER_RETRIES] == ["gpt-4o-mini"] * (1 + MAX_FILTER_RETRIES)
    assert asked[1 + MAX_FILTER_RETRIES] == "gpt-4.1"
    assert body["activity"][0] == {"kind": "model-fallback", "from": "gpt-4o-mini", "to": "gpt-4.1", "served_by": "Azure"}
    assert [event.target_name for event in get_store().audit_events if event.action == "chat.completion_fallback"] == ["gpt-4.1"]


def test_a_draft_with_no_model_to_switch_to_fails_with_the_reason(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini")
    asked = _draft_turns(monkeypatch, {"gpt-4o-mini": [(STAND_IN_REPLY, "content_filter")]})

    response = _draft()

    assert response.status_code == 502
    assert "content filter withheld" in response.json()["detail"]
    assert asked == ["gpt-4o-mini"] * (1 + MAX_FILTER_RETRIES)
