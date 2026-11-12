"""Chat replies keep going on the server when the page that asked goes away."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.core.chat_runs import get_chat_run_registry
from app.core.model_gateway import ModelGatewayRoute
from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)
RUN_ID = "run-durable-1"


@pytest.fixture(autouse=True)
def reset_state() -> Iterator[None]:
    get_store.cache_clear()
    get_chat_run_registry.cache_clear()
    yield
    get_store.cache_clear()
    get_chat_run_registry.cache_clear()


def _headers(user_id: str = "user-jane") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _route(_store, _model, *, tenant_id: str | None) -> ModelGatewayRoute:
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


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> list[list[dict]]:
    """A provider that answers "Hello world" and records each call's messages."""
    calls: list[list[dict]] = []

    def stream(*_args, **kwargs):
        calls.append(kwargs["messages"])
        yield "Hello"
        yield " world"

    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)
    monkeypatch.setattr("app.routes.chat._gateway_stream", stream)
    return calls


def _save_pending_thread(run_id: str = RUN_ID, content: str = "") -> None:
    response = client.put(
        "/api/chat/threads/thread-durable",
        json={
            "tenant_id": "tenant-example",
            "title": "Durable reply",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {"id": "msg-user", "role": "user", "content": "Say hello", "createdAt": "3:00 PM", "status": "ok"},
                {
                    "id": "msg-reply",
                    "role": "assistant",
                    "content": content,
                    "createdAt": "3:00 PM",
                    "executedAt": "2026-11-05T15:00:00+00:00",
                    "status": "pending",
                    "metadata": {"runId": run_id},
                    "activityTrace": [{"id": "route:model", "label": "Routed to GPT-4o mini"}],
                },
            ],
        },
        headers=_headers(),
    )
    assert response.status_code == 200


def _complete(run_id: str = RUN_ID, user_id: str = "user-jane", messages: list[dict] | None = None):
    return client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": messages or [{"role": "user", "content": "Say hello"}],
            "stream": True,
            "surface": "chat",
            "thread_id": "thread-durable",
            "run_id": run_id,
        },
        headers=_headers(user_id),
    )


def _events(text: str) -> list[object]:
    events: list[object] = []
    for line in text.splitlines():
        if line.startswith("data: "):
            data = line.removeprefix("data: ")
            events.append(data if data == "[DONE]" else json.loads(data))
    return events


def _ids(text: str) -> list[int]:
    return [int(line.removeprefix("id: ")) for line in text.splitlines() if line.startswith("id: ")]


def _wait_for_run(run_id: str = RUN_ID, user_id: str = "user-jane") -> None:
    run = get_chat_run_registry().find(run_id, user_id)
    assert run is not None
    assert run.wait(5)


def _stored_reply() -> dict:
    threads = client.get("/api/chat/threads", headers=_headers()).json()
    thread = next(thread for thread in threads if thread["id"] == "thread-durable")
    return next(message for message in thread["messages"] if message["id"] == "msg-reply")


def test_the_server_saves_the_finished_reply_into_the_chat(provider) -> None:
    _save_pending_thread()

    response = _complete()
    _wait_for_run()

    assert response.status_code == 200
    events = _events(response.text)
    assert events[:2] == [{"delta": "Hello"}, {"delta": " world"}]
    assert events[-1] == "[DONE]"
    assert _ids(response.text) == list(range(1, len(events) + 1))
    reply = _stored_reply()
    assert reply["status"] == "ok"
    assert reply["content"] == "Hello world"
    assert reply["completedAt"]
    assert reply["metadata"]["runId"] == RUN_ID
    assert reply["metadata"]["serverSettled"]["activities"] == []
    assert reply["activityTrace"] == [{"id": "route:model", "label": "Routed to GPT-4o mini", "detail": None}]


def test_a_returning_page_reattaches_and_gets_the_reply_so_far_then_the_ending(provider) -> None:
    _save_pending_thread()
    _complete()
    _wait_for_run()

    response = client.get(f"/api/chat/runs/{RUN_ID}/events", headers=_headers())

    assert response.status_code == 200
    events = _events(response.text)
    assert events[0] == {"snapshot": {"base": "", "text": "Hello world", "activities": [], "concealed_prompt": None}}
    assert events[1]["done"] is True
    assert events[-1] == "[DONE]"


def test_a_dropped_connection_resumes_after_the_last_frame_it_saw(provider) -> None:
    _save_pending_thread()
    _complete()
    _wait_for_run()

    response = client.get(f"/api/chat/runs/{RUN_ID}/events?after=1", headers=_headers())

    assert _events(response.text)[0] == {"delta": " world"}
    assert _ids(response.text)[0] == 2


def test_sending_the_same_run_twice_generates_once(provider) -> None:
    _save_pending_thread()

    first = _complete()
    _wait_for_run()
    second = _complete()

    assert len(provider) == 1
    assert _events(second.text) == _events(first.text)


def test_a_continued_reply_is_saved_with_the_text_it_already_had(provider) -> None:
    _save_pending_thread(content="Hel")
    continuation = [
        {"role": "user", "content": "Say hello"},
        {"role": "assistant", "content": "Hel"},
        {
            "role": "user",
            "content": (
                "Continue exactly where the previous answer stopped. Do not restart, summarize, "
                "or apologize. Keep the same structure and continue until the requested work is complete."
            ),
        },
    ]

    _complete(messages=continuation)
    _wait_for_run()

    assert _stored_reply()["content"] == "Hel\n\nHello world"


def test_someone_else_cannot_see_stop_or_reuse_a_run(provider) -> None:
    _save_pending_thread()
    _complete()
    _wait_for_run()

    assert client.get(f"/api/chat/runs/{RUN_ID}/events", headers=_headers("user-casey")).status_code == 404
    stop = client.post(f"/api/chat/runs/{RUN_ID}/cancel", headers=_headers("user-casey"))
    assert stop.json() == {"id": RUN_ID, "status": "stopped"}
    reused = _complete(user_id="user-casey")
    assert reused.status_code == 409
    assert len(provider) == 1
    jane_run = get_chat_run_registry().find(RUN_ID, "user-jane")
    assert jane_run is not None and jane_run.cancel_requested is False


@pytest.mark.parametrize("run_id", ["run.with.dots", "r" * 129, "run%20with%20space"])
def test_a_run_id_no_page_could_have_sent_is_refused_before_anything_is_kept(run_id: str) -> None:
    """A reply's id comes from the page that started it, in one fixed shape.
    Anything else is not a stop to remember or an event to audit."""
    assert client.get(f"/api/chat/runs/{run_id}/events", headers=_headers()).status_code == 422
    assert client.post(f"/api/chat/runs/{run_id}/cancel", headers=_headers()).status_code == 422
    assert [e for e in get_store().audit_events_newest_first() if e.action == "chat.reply_stopped"] == []


def test_an_unknown_run_says_it_is_no_longer_running() -> None:
    response = client.get("/api/chat/runs/run-missing/events", headers=_headers())

    assert response.status_code == 404
    assert response.json()["detail"] == "This reply is no longer running."


def test_stop_ends_a_running_reply_and_the_chat_records_that_it_was_stopped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()

    def endless(*_args, **_kwargs):
        yield "Partial"
        started.set()
        while True:
            yield ""

    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)
    monkeypatch.setattr("app.routes.chat._gateway_stream", endless)
    _save_pending_thread()
    watcher = threading.Thread(target=_complete, daemon=True)
    watcher.start()
    assert started.wait(5)

    stopped = client.post(f"/api/chat/runs/{RUN_ID}/cancel", headers=_headers())
    _wait_for_run()
    watcher.join(5)

    assert stopped.status_code == 200
    assert stopped.json() == {"id": RUN_ID, "status": "stopping"}
    reply = _stored_reply()
    assert reply["status"] == "error"
    assert reply["content"] == "Partial"
    assert reply["metadata"]["failureNotice"].startswith("You stopped this response")


def test_a_late_save_from_a_closed_page_does_not_reopen_the_finished_reply(provider) -> None:
    _save_pending_thread()
    _complete()
    _wait_for_run()

    _save_pending_thread(content="Hel")

    reply = _stored_reply()
    assert reply["status"] == "ok"
    assert reply["content"] == "Hello world"


def test_a_reply_for_another_chat_never_lands_in_this_one(provider) -> None:
    _save_pending_thread()
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Say hello"}],
            "stream": True,
            "surface": "chat",
            "thread_id": "thread-durable",
            "run_id": RUN_ID,
        },
        headers=_headers("user-casey"),
    )
    assert response.status_code == 200
    _wait_for_run(user_id="user-casey")

    assert _stored_reply()["status"] == "pending"


def test_requests_without_a_run_still_stream_directly(provider) -> None:
    response = client.post(
        "/api/chat/complete",
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hi"}], "stream": True},
        headers=_headers(),
    )

    assert response.status_code == 200
    assert "id: " not in response.text
    assert _events(response.text)[0] == {"delta": "Hello"}


def test_stop_pressed_while_the_reply_was_still_gathering_context_prevents_it(provider) -> None:
    _save_pending_thread()

    stop = client.post(f"/api/chat/runs/{RUN_ID}/cancel", headers=_headers())
    _complete()
    _wait_for_run()

    assert stop.json() == {"id": RUN_ID, "status": "stopped"}
    assert provider == []
    reply = _stored_reply()
    assert reply["status"] == "error"
    assert reply["content"].startswith("You stopped this response")


def test_a_run_stopped_before_it_started_releases_its_usage_reservation(
    provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.routes import chat as chat_routes

    contexts: list[object] = []
    begin = chat_routes._begin_chat_usage_request

    def recording_begin(*args, **kwargs):
        context = begin(*args, **kwargs)
        contexts.append(context)
        return context

    monkeypatch.setattr("app.routes.chat._begin_chat_usage_request", recording_begin)
    _save_pending_thread()
    client.post(f"/api/chat/runs/{RUN_ID}/cancel", headers=_headers())

    _complete()
    _wait_for_run()

    assert len(contexts) == 1
    assert contexts[0].status != "active"


def test_a_chat_first_saved_after_its_run_finished_arrives_with_the_reply(provider) -> None:
    _complete()
    _wait_for_run()

    _save_pending_thread(content="Hel")

    reply = _stored_reply()
    assert reply["status"] == "ok"
    assert reply["content"] == "Hello world"
    assert reply["metadata"]["serverSettled"]["activities"] == []


def test_a_save_never_takes_someone_elses_run_result(provider) -> None:
    _complete(user_id="user-casey")
    _wait_for_run(user_id="user-casey")

    _save_pending_thread(content="Hel")

    assert _stored_reply()["status"] == "pending"
