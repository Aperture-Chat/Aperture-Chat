"""A chat reply can pause to ask the user multiple-choice questions."""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest

from tests.test_chat_run_routes import (  # noqa: F401 - reset_state is an autouse fixture
    RUN_ID,
    _events,
    _headers,
    _route,
    _save_pending_thread,
    _stored_reply,
    _wait_for_run,
    client,
    reset_state,
)

ASK_JSON = {"questions": [{"question": "Which state's law applies?", "options": ["California", "New York"], "recommended": "California"}]}
ASKING_REPLY = f"One question first.\n\n```aperture-ask\n{json.dumps(ASK_JSON)}\n```\n"
QUESTIONS = {
    "intro": "One question first.",
    "questions": [
        {
            "id": "q1",
            "question": "Which state's law applies?",
            "options": [{"label": "California"}, {"label": "New York"}],
            "multiple": False,
            "recommended": 0,
        }
    ],
}


@pytest.fixture
def asking_provider(monkeypatch: pytest.MonkeyPatch) -> list[list[dict]]:
    """A provider that pauses to ask, streamed in small pieces."""
    calls: list[list[dict]] = []

    def stream(*_args, **kwargs) -> Iterator[str]:
        calls.append(kwargs["messages"])
        for index in range(0, len(ASKING_REPLY), 4):
            yield ASKING_REPLY[index : index + 4]

    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _route)
    monkeypatch.setattr("app.routes.chat._gateway_stream", stream)
    return calls


def _ask(mode: str | None = "ask", *, surface: str = "chat", messages: list[dict] | None = None):
    body = {
        "model": "gpt-4o-mini",
        "messages": messages or [{"role": "user", "content": "Draft the clause"}],
        "stream": True,
        "surface": surface,
        "thread_id": "thread-durable",
        "run_id": RUN_ID,
    }
    if mode is not None:
        body["clarify_mode"] = mode
    return client.post("/api/chat/complete", json=body, headers=_headers())


def _system_prompt(calls: list[list[dict]]) -> str:
    return next(message["content"] for message in calls[-1] if message["role"] == "system")


def _streamed_text(events: list[object]) -> str:
    return "".join(event["delta"] for event in events if isinstance(event, dict) and "delta" in event)


def test_a_reply_that_asks_streams_its_lead_in_then_the_questions_and_never_the_block(asking_provider) -> None:
    _save_pending_thread()

    response = _ask()
    _wait_for_run()

    events = _events(response.text)
    assert _streamed_text(events) == "One question first.\n\n"
    assert {"activity": {"kind": "ask", "questions": 1}} in events
    assert {"questions": QUESTIONS} in events
    done = next(event for event in events if isinstance(event, dict) and event.get("done"))
    assert done["citations"] == []
    assert events[-1] == "[DONE]"
    assert "```aperture-ask" in _system_prompt(asking_provider)


def test_the_chat_keeps_the_paused_reply_with_its_questions(asking_provider) -> None:
    _save_pending_thread()

    _ask()
    _wait_for_run()

    reply = _stored_reply()
    assert reply["status"] == "ok"
    assert reply["content"] == ""
    clarify = reply["metadata"]["clarify"]
    assert {key: clarify[key] for key in ("state", "intro", "questions")} == {"state": "waiting", **QUESTIONS}
    assert clarify["pausedAt"]
    assert {"kind": "ask", "questions": 1} in reply["metadata"]["serverSettled"]["activities"]


def test_a_page_that_comes_back_receives_the_questions_in_its_snapshot(asking_provider) -> None:
    _save_pending_thread()
    _ask()
    _wait_for_run()

    response = client.get(f"/api/chat/runs/{RUN_ID}/events", headers=_headers())

    snapshot = _events(response.text)[0]["snapshot"]
    assert snapshot["questions"] == QUESTIONS
    assert snapshot["text"] == "One question first.\n\n"


def test_when_the_user_lets_the_assistant_decide_it_is_told_not_to_ask(asking_provider) -> None:
    _save_pending_thread()

    response = _ask("decide")
    _wait_for_run()

    prompt = _system_prompt(asking_provider)
    assert "Do not stop to ask" in prompt
    assert "```aperture-ask fenced block" not in prompt
    # Nothing is held back when asking is off: what the model wrote is the reply.
    assert _streamed_text(_events(response.text)) == ASKING_REPLY
    assert _stored_reply()["content"] == ASKING_REPLY


def test_after_the_user_answers_the_model_is_told_to_finish_without_asking_again(asking_provider) -> None:
    _save_pending_thread()
    answered = [
        {"role": "user", "content": "Draft the clause"},
        {"role": "assistant", "content": "One question first.\n\nWhich state's law applies?"},
        {"role": "user", "content": "Which state's law applies? California"},
    ]

    _ask("answered", messages=answered)
    _wait_for_run()

    prompt = _system_prompt(asking_provider)
    assert "do not ask again" in prompt
    assert "```aperture-ask fenced block" not in prompt


def test_without_a_clarify_mode_the_prompt_is_unchanged(asking_provider) -> None:
    _save_pending_thread()

    _ask(None)
    _wait_for_run()

    assert "Clarifying questions" not in _system_prompt(asking_provider)


def test_drafts_never_pause_to_ask(asking_provider) -> None:
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Draft the clause"}],
            "stream": True,
            "surface": "draft",
            "clarify_mode": "ask",
        },
        headers=_headers(),
    )

    assert "Clarifying questions" not in _system_prompt(asking_provider)
    assert not any(isinstance(event, dict) and "questions" in event for event in _events(response.text))


def test_screened_replies_screen_the_questions_too(asking_provider, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.routes.chat.filters_have_output_rules", lambda _filters: True)
    monkeypatch.setattr(
        "app.routes.chat._filtered_output_text",
        lambda _store, _actor, _request, _model, _filters, text: text.replace("California", "[withheld]"),
    )
    _save_pending_thread()

    response = _ask()
    _wait_for_run()

    events = _events(response.text)
    questions = next(event["questions"] for event in events if isinstance(event, dict) and "questions" in event)
    assert questions["questions"][0]["options"][0] == {"label": "[withheld]"}
    assert _streamed_text(events) == "One question first."


ANSWERED_TURN = [
    {"role": "user", "content": "Write it in exactly 3 bullet points"},
    {"role": "assistant", "content": "One question first.\n\nWhich state's law applies?"},
    {"role": "user", "content": "Which state's law applies? California"},
]


def test_after_answers_the_search_looks_for_the_question_and_the_answers_together() -> None:
    from app.routes.chat import CONTINUATION_PROMPT, _retrieval_question

    resumed = [*ANSWERED_TURN, {"role": "assistant", "content": "- One"}, {"role": "user", "content": CONTINUATION_PROMPT}]
    expected = "Write it in exactly 3 bullet points\nWhich state's law applies? California"

    assert _retrieval_question(ANSWERED_TURN, answered=True) == expected
    assert _retrieval_question(resumed, answered=True) == expected
    assert _retrieval_question(ANSWERED_TURN) == "Which state's law applies? California"
    assert _retrieval_question(ANSWERED_TURN[-1:], answered=True) == "Which state's law applies? California"


def test_after_answers_the_original_requirements_are_still_checked(asking_provider) -> None:
    _save_pending_thread()

    response = _ask("answered", messages=ANSWERED_TURN)
    _wait_for_run()

    assert {"activity": {"kind": "requirements", "phase": "noted", "count": 2}} in _events(response.text)
