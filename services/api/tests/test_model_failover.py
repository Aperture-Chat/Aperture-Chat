"""A model that fails to answer is answered for by another: a dropped
connection, an error from the provider, or a reply with nothing in it. The
reply says which model stood in, and why."""

from __future__ import annotations

import json
from collections.abc import Iterator

import httpx
import pytest

from app.core.model_gateway import ModelGatewayClient
from app.repositories.deps import get_store
from app.routes.chat import CONTINUATION_PROMPT
from tests.test_upstream_unavailable import (  # noqa: F401 - reset_store is an autouse fixture
    _ask,
    _draft,
    _fallback_audit,
    _only_models,
    _route,
    _serve,
    _sse,
    _switches,
    _text,
    _whole,
    _words,
    reset_store,
)

DROPPED = httpx.ConnectError("All connection attempts failed")
SERVER_ERROR = httpx.Response(500, content=b"upstream exploded")
IN_STREAM_ERROR = {"choices": [], "error": {"code": 500, "message": "The model crashed."}}
ANSWER = _sse(_words("May it please "), _words("the court.", "stop"))


def _failed(to: str = "gpt-4.1", **more: object) -> dict:
    return {"kind": "model-fallback", "from": "gpt-4o-mini", "to": to, "reason": "failed", **more}


# --- A chat reply ---------------------------------------------------------


@pytest.mark.parametrize(
    "failure",
    [
        DROPPED,
        httpx.ReadTimeout("The read operation timed out"),
        SERVER_ERROR,
        httpx.Response(429, content=b"slow down"),
        httpx.Response(404, content=b"no such model"),
        _sse(IN_STREAM_ERROR),
        _sse({"choices": [], "error": {"code": 429, "message": "Rate limit exceeded."}}),
    ],
    ids=["dropped", "timed-out", "http-500", "http-429", "http-404", "error-in-stream", "limit-in-stream"],
)
def test_a_reply_its_model_fails_to_give_is_answered_by_another(
    monkeypatch: pytest.MonkeyPatch, failure: httpx.Response | Exception
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [failure], "gpt-4.1": [ANSWER]})

    events = _ask()

    assert _text(events) == "May it please the court."
    # The first model is not asked again: the other answers at once.
    assert asked == ["gpt-4o-mini", "gpt-4.1"]
    assert _switches(events) == [_failed()]
    assert any(event.get("done") for event in events)
    assert not any("error" in event for event in events)
    audit = _fallback_audit()
    assert [event.target_name for event in audit] == ["gpt-4.1"]
    assert audit[0].metadata["fallback_from"] == "gpt-4o-mini"
    assert audit[0].metadata["reason"] == "model_failed"


def _usage_models() -> list[str]:
    """The model each recorded call is billed to, oldest first."""
    store = get_store()
    tenant_id = store.users["user-jane"].tenant_id
    return sorted(record.model_id for record in store.usage_records_filtered(tenant_id=tenant_id))


@pytest.mark.parametrize("failure", [DROPPED, _sse(IN_STREAM_ERROR)], ids=["dropped", "error-in-stream"])
def test_a_turn_that_failed_is_not_recorded_as_a_call_the_model_completed(
    monkeypatch: pytest.MonkeyPatch, failure: httpx.Response | Exception
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    _serve(monkeypatch, {"gpt-4o-mini": [failure], "gpt-4.1": [ANSWER]})

    _ask()

    assert _usage_models() == ["gpt-4.1"]


def test_the_stand_in_is_the_nearest_in_ability_not_the_first_listed(monkeypatch: pytest.MonkeyPatch) -> None:
    # gpt-4o is the full-size model; gpt-4o-mini comes first in the catalog.
    _only_models("gpt-4o", "gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4.1": [DROPPED], "gpt-4o-mini": [ANSWER], "gpt-4o": [ANSWER]})

    events = _ask(model="gpt-4.1")

    assert asked == ["gpt-4.1", "gpt-4o"]
    assert _switches(events) == [{"kind": "model-fallback", "from": "gpt-4.1", "to": "gpt-4o", "reason": "failed"}]


def test_a_rejected_key_is_reported_and_no_other_model_answers(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [httpx.Response(401, content=b"bad key")], "gpt-4.1": [ANSWER]})

    events = _ask()

    assert asked == ["gpt-4o-mini"]
    assert _switches(events) == []
    assert _fallback_audit() == []
    assert next(event for event in events if "error" in event)["retryable"] is False


def test_a_failure_with_no_other_model_ends_as_it_did_before(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini")
    _serve(monkeypatch, {"gpt-4o-mini": [SERVER_ERROR]})

    events = _ask()

    assert _switches(events) == []
    error = next(event for event in events if "error" in event)
    assert error["error"] == "Test Router did not return a completion: Test Router returned HTTP 500: upstream exploded"
    assert error["retryable"] is True
    assert not any(event.get("done") for event in events)


def test_a_reply_that_fails_on_both_models_switches_once_and_ends_with_the_second_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1", "gpt-4o")
    asked = _serve(
        monkeypatch,
        {"gpt-4o-mini": [DROPPED], "gpt-4.1": [SERVER_ERROR], "gpt-4o": [httpx.Response(503, content=b"down too")]},
    )

    events = _ask()

    assert len(asked) == 2
    assert len(_switches(events)) == 1
    stood_in = _switches(events)[0]["to"]
    error = next(event for event in events if "error" in event)
    assert asked[1] == stood_in and "returned HTTP 50" in error["error"]
    assert error["retryable"] is True
    assert not any(event.get("done") for event in events)


# --- A reply with nothing in it -------------------------------------------

SILENCE = _sse({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})


@pytest.mark.parametrize("silence", [SILENCE, _sse(_words("", "stop")), _sse()], ids=["finish-only", "blank", "nothing"])
def test_a_reply_with_nothing_in_it_is_answered_by_another_model(
    monkeypatch: pytest.MonkeyPatch, silence: httpx.Response
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [silence], "gpt-4.1": [ANSWER]})

    events = _ask()

    assert _text(events) == "May it please the court."
    assert asked == ["gpt-4o-mini", "gpt-4.1"]
    assert _switches(events) == [{"kind": "model-fallback", "from": "gpt-4o-mini", "to": "gpt-4.1", "reason": "empty"}]
    assert _fallback_audit()[0].metadata["reason"] == "empty_reply"


def test_an_empty_reply_with_no_other_model_ends_as_it_did_before(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [SILENCE]})

    events = _ask()

    assert asked == ["gpt-4o-mini"]
    assert _text(events) == ""
    assert _switches(events) == []
    assert any(event.get("done") for event in events)
    assert not any("error" in event for event in events)


def test_two_empty_replies_switch_once(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [SILENCE], "gpt-4.1": [SILENCE]})

    events = _ask()

    assert asked == ["gpt-4o-mini", "gpt-4.1"]
    assert len(_switches(events)) == 1
    assert _text(events) == ""
    assert any(event.get("done") for event in events)


def test_a_resumed_reply_with_nothing_left_to_add_is_not_an_empty_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [SILENCE], "gpt-4.1": [ANSWER]})

    # The browser re-sends what it was shown before the stream dropped.
    events = _ask(
        messages=[
            {"role": "user", "content": "Draft the oral argument."},
            {"role": "assistant", "content": "May it please the court."},
            {"role": "user", "content": CONTINUATION_PROMPT},
        ]
    )

    assert asked == ["gpt-4o-mini"]
    assert _switches(events) == []
    assert any(event.get("done") for event in events)


def test_a_turn_that_answers_with_a_tool_call_is_not_an_empty_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    call = {"index": 0, "id": "call_1", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}
    tool_turn = _sse({"choices": [{"index": 0, "delta": {"tool_calls": [call]}, "finish_reason": "tool_calls"}]})
    asked = _serve(monkeypatch, {"gpt-4o-mini": [tool_turn], "gpt-4.1": [ANSWER]})

    events = _ask(
        tools=[{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object", "properties": {}}}}]
    )

    assert asked == ["gpt-4o-mini"]
    assert _switches(events) == []


# --- A reply that fails after some of it is shown -------------------------


def _cut_short(*words: str) -> httpx.Response:
    """A stream that sends these words and then loses its connection."""

    def body() -> Iterator[bytes]:
        for word in words:
            yield f"data: {json.dumps(_words(word))}\n\n".encode()
        raise httpx.ReadError("Connection reset by peer")

    return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body())


def _conversations(monkeypatch: pytest.MonkeyPatch, by_model: dict[str, httpx.Response]) -> list[tuple[str, list[dict]]]:
    """Serve each model its reply; returns who was asked and with what turns."""
    sent: list[tuple[str, list[dict]]] = []
    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.read().decode())
        sent.append((payload["model"], [message for message in payload["messages"] if message["role"] != "system"]))
        return by_model[payload["model"]]

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: gateway)
    return sent


@pytest.mark.parametrize(
    "cut", [_cut_short("May it please "), _sse(_words("May it please "), IN_STREAM_ERROR)], ids=["dropped", "error"]
)
def test_a_reply_that_fails_part_way_is_finished_by_another_model(
    monkeypatch: pytest.MonkeyPatch, cut: httpx.Response
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    sent = _conversations(monkeypatch, {"gpt-4o-mini": cut, "gpt-4.1": _sse(_words("the court.", "stop"))})

    events = _ask()

    # What was shown stays; the other model goes on from it.
    assert _text(events) == "May it please the court."
    assert _switches(events) == [_failed(continued=True)]
    assert any(event.get("done") for event in events)
    assert not any("error" in event for event in events)
    assert [model for model, _turns in sent] == ["gpt-4o-mini", "gpt-4.1"]
    first, second = sent[0][1], sent[1][1]
    assert second == [
        *first,
        {"role": "assistant", "content": "May it please"},
        {"role": "user", "content": CONTINUATION_PROMPT},
    ]


def test_a_sentence_cut_mid_word_is_joined_to_what_follows_like_any_continued_reply(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    _conversations(
        monkeypatch, {"gpt-4o-mini": _cut_short("First point."), "gpt-4.1": _sse(_words("Second point.", "stop"))}
    )

    assert _text(_ask()) == "First point.\n\nSecond point."


def test_a_reply_cut_before_any_word_of_substance_is_asked_afresh(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    sent = _conversations(monkeypatch, {"gpt-4o-mini": _cut_short("\n\n"), "gpt-4.1": ANSWER})

    events = _ask()

    # Nothing to continue from: the stand-in gets the request as it was.
    assert sent[1][1] == sent[0][1]
    assert _switches(events) == [_failed()]
    assert _text(events).strip() == "May it please the court."


def test_a_reply_that_fails_part_way_with_no_other_model_is_resumed_by_the_browser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini")
    _conversations(monkeypatch, {"gpt-4o-mini": _cut_short("May it please ")})

    events = _ask()

    assert _text(events) == "May it please "
    assert _switches(events) == []
    error = next(event for event in events if "error" in event)
    assert error["retryable"] is True
    assert not any(event.get("done") for event in events)


def test_a_reply_both_models_cut_short_keeps_its_words_and_is_resumed_by_the_browser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    sent = _conversations(
        monkeypatch, {"gpt-4o-mini": _cut_short("May it please "), "gpt-4.1": _cut_short("the ")}
    )

    events = _ask()

    assert [model for model, _turns in sent] == ["gpt-4o-mini", "gpt-4.1"]
    assert _text(events) == "May it please the "
    assert len(_switches(events)) == 1
    assert next(event for event in events if "error" in event)["retryable"] is True
    assert not any(event.get("done") for event in events)


# --- A reply that does not stream (Drafts) --------------------------------

DRAFT = "<h1>The Hundred Years' War</h1><p>It began in 1337.</p>"


def _empty_whole(finish: str = "stop", **message: object) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "gen",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "", **message}, "finish_reason": finish}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10},
        },
    )


@pytest.mark.parametrize(
    "failure",
    [DROPPED, SERVER_ERROR, httpx.Response(429, content=b"slow down"), httpx.Response(400, content=b"bad parameter")],
    ids=["dropped", "http-500", "http-429", "http-400"],
)
def test_a_draft_its_model_fails_to_write_is_written_by_another(
    monkeypatch: pytest.MonkeyPatch, failure: httpx.Response | Exception
) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [failure], "gpt-4.1": [_whole(DRAFT)]})

    response = _draft()

    assert response.status_code == 200
    body = response.json()
    assert "It began in 1337." in body["choices"][0]["message"]["content"]
    assert asked[:2] == ["gpt-4o-mini", "gpt-4.1"]
    assert "gpt-4o-mini" not in asked[1:]
    assert body["activity"][0] == _failed()
    audit = _fallback_audit()
    assert [event.target_name for event in audit] == ["gpt-4.1"]
    assert audit[0].metadata["reason"] == "model_failed"
    assert audit[0].metadata["stream"] is False


@pytest.mark.parametrize("blank", ["", "  \n"])
def test_a_draft_that_comes_back_empty_is_written_by_another_model(monkeypatch: pytest.MonkeyPatch, blank: str) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [_whole(blank)], "gpt-4.1": [_whole(DRAFT)]})

    response = _draft()

    assert response.status_code == 200
    body = response.json()
    assert "It began in 1337." in body["choices"][0]["message"]["content"]
    assert asked[:2] == ["gpt-4o-mini", "gpt-4.1"]
    assert body["activity"][0] == {"kind": "model-fallback", "from": "gpt-4o-mini", "to": "gpt-4.1", "reason": "empty"}
    assert _fallback_audit()[0].metadata["reason"] == "empty_reply"


@pytest.mark.parametrize(
    "call",
    [
        {"tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "lookup", "arguments": "{}"}}]},
        {"function_call": {"name": "lookup", "arguments": "{}"}},
    ],
    ids=["tool-call", "function-call"],
)
def test_a_whole_reply_that_is_a_tool_call_is_not_an_empty_reply(monkeypatch: pytest.MonkeyPatch, call: dict) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(
        monkeypatch,
        {"gpt-4o-mini": [_empty_whole("tool_calls", **call)], "gpt-4.1": [_whole(DRAFT)]},
    )

    response = _draft()

    assert response.status_code == 200
    assert set(asked) == {"gpt-4o-mini"}
    assert response.json()["activity"] == []


def test_a_draft_cut_at_its_token_budget_before_a_word_is_not_an_empty_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [_empty_whole("length"), _whole(DRAFT)], "gpt-4.1": [_whole(DRAFT)]})

    response = _draft()

    # Thinking used the budget: the same model is asked again with more room.
    assert response.status_code == 200
    assert set(asked) == {"gpt-4o-mini"}
    assert response.json()["activity"] == []


def test_a_draft_both_models_fail_to_write_fails_with_the_second_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [DROPPED], "gpt-4.1": [SERVER_ERROR]})

    response = _draft()

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "Test Router did not return a completion: Test Router returned HTTP 500: upstream exploded"
    )
    assert asked == ["gpt-4o-mini", "gpt-4.1"]
    assert len(_fallback_audit()) == 1


def test_a_draft_that_fails_with_no_other_model_fails_as_it_did_before(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [SERVER_ERROR]})

    response = _draft()

    assert response.status_code == 503
    assert response.json()["detail"] == (
        "Test Router did not return a completion: Test Router returned HTTP 500: upstream exploded"
    )
    assert asked == ["gpt-4o-mini"]


def test_a_draft_on_a_rejected_key_is_reported_and_no_other_model_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    asked = _serve(monkeypatch, {"gpt-4o-mini": [httpx.Response(401, content=b"bad key")], "gpt-4.1": [_whole(DRAFT)]})

    response = _draft()

    assert response.status_code == 503
    assert asked == ["gpt-4o-mini"]
    assert _fallback_audit() == []


def test_a_draft_whose_later_call_fails_is_written_whole_by_another_model(monkeypatch: pytest.MonkeyPatch) -> None:
    _only_models("gpt-4o-mini", "gpt-4.1")
    cut = httpx.Response(
        200,
        json={
            "id": "gen",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "<h1>The Hundred"}, "finish_reason": "length"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        },
    )
    asked = _serve(monkeypatch, {"gpt-4o-mini": [cut, SERVER_ERROR], "gpt-4.1": [_whole(DRAFT)]})

    response = _draft()

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"].count("The Hundred") == 1
    assert asked[:3] == ["gpt-4o-mini", "gpt-4o-mini", "gpt-4.1"]
    assert response.json()["activity"][0] == _failed()

