"""Drafts can ask before it writes, and research while it writes.

A Drafts request is two kinds of model call. The *intake turn* reads the
request before anything is written and may pause to ask the user. The
*writing call* returns the document, deck, or workbook whole, and may take
research steps first; the steps it took come back with the reply.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from io import BytesIO

import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayRoute
from app.main import app
from app.repositories.deps import get_store
from app.routes import chat as chat_route

client = TestClient(app)
_ADMIN = {"x-aperture-user": "user-admin"}
_BASE = "knowledge-box-matters"
_INTAKE = (
    "You are the intake step of the drafting assistant. Decide whether the request is clear.\n\n"
    "User request:\nDraft a memo"
)
_ASK = '```aperture-ask\n{"questions": [{"question": "Who is it for?", "options": ["The client", "The partner"]}]}\n```\n'


@pytest.fixture(autouse=True)
def reset_store() -> Iterator[None]:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _route(*_args: object, tenant_id: str | None) -> ModelGatewayRoute:
    return ModelGatewayRoute(
        provider_id="provider-test",
        provider_name="Test Provider",
        provider_kind="openai-compatible",
        auth_type="bearer",
        upstream_model="test/model",
        base_url="https://provider.invalid/v1",
        configured=True,
        status_message="Configured",
        secret_value="test-only-secret",
    )


def _steps(*steps: dict[str, str]) -> str:
    return f"```aperture-steps\n{json.dumps({'steps': list(steps)})}\n```\n"


Turn = str | Callable[[list[dict[str, object]]], str]


class _Scripted:
    """A model that says each scripted turn in order, whole or in pieces. A
    turn may be worked out from the conversation it answers."""

    def __init__(self, turns: list[Turn]) -> None:
        self.turns = turns
        self.calls: list[list[dict[str, object]]] = []

    def _next(self, messages: object) -> str:
        self.calls.append(list(messages))  # type: ignore[call-overload]
        turn = self.turns[min(len(self.calls), len(self.turns)) - 1]
        return turn if isinstance(turn, str) else turn(self.calls[-1])

    def complete(self, **kwargs: object) -> dict[str, object]:
        return {
            "id": f"completion-{len(self.calls) + 1}",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": self._next(kwargs["messages"])},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
        }

    def stream(self, _client: object, **kwargs: object) -> Iterator[str]:
        kwargs["usage_sink"]["finish_reason"] = "stop"  # type: ignore[index]
        text = self._next(kwargs["messages"])
        return iter([text[index : index + 5] for index in range(0, len(text), 5)])


@pytest.fixture
def scripted(monkeypatch: pytest.MonkeyPatch) -> Callable[..., _Scripted]:
    def install(*turns: Turn) -> _Scripted:
        model = _Scripted(list(turns))
        monkeypatch.setattr(chat_route, "_resolve_gateway_route", _route)
        monkeypatch.setattr(chat_route, "get_model_gateway_client", lambda: model)
        monkeypatch.setattr(chat_route, "_gateway_stream", model.stream)
        return model

    return install


def _write(**body: object) -> dict[str, object]:
    """One writing call, as Drafts sends it: the whole reply in one response."""
    response = client.post(
        "/api/chat/complete",
        headers=_ADMIN,
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "What is the monthly interest?"}],
            "stream": False,
            "surface": "draft",
            "work_steps": True,
            **body,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _reply(data: dict[str, object]) -> str:
    return str(data["choices"][0]["message"]["content"])  # type: ignore[index]


def _intake(**body: object) -> list[dict[str, object]]:
    """The intake turn, as Drafts sends it: streamed, and allowed to ask."""
    response = client.post(
        "/api/chat/complete",
        headers=_ADMIN,
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": _INTAKE}],
            "stream": True,
            "surface": "draft",
            "clarify_mode": "ask",
            **body,
        },
    )
    assert response.status_code == 200, response.text
    lines = [line.removeprefix("data: ") for line in response.text.splitlines() if line.startswith("data: ")]
    return [json.loads(line) for line in lines if line != "[DONE]"]


def _text(events: list[dict[str, object]]) -> str:
    return "".join(str(event["delta"]) for event in events if "delta" in event)


def _facts(events: list[dict[str, object]]) -> list[str]:
    return [str(event["activity"]["kind"]) for event in events if isinstance(event.get("activity"), dict)]  # type: ignore[index]


def _system(call: list[dict[str, object]]) -> str:
    return str(next(message["content"] for message in call if message["role"] == "system"))


# --- The writing call takes research steps -----------------------------------


def test_a_draft_works_a_figure_out_first_and_only_the_draft_comes_back(scripted) -> None:
    model = scripted(
        _steps({"do": "calculate", "expression": "1250000 * 0.065 / 12"}),
        "The monthly interest is $6,770.83.",
    )

    data = _write()

    assert _reply(data) == "The monthly interest is $6,770.83."
    assert data["activity"] == [
        {"kind": "step", "number": 1, "do": "calculate", "ok": True, "found": 1, "about": "1250000 * 0.065 / 12"}
    ]
    assert len(model.calls) == 2
    asked, results = model.calls[1][-2:]
    assert asked == {"role": "assistant", "content": _steps({"do": "calculate", "expression": "1250000 * 0.065 / 12"}).rstrip()}
    assert results["role"] == "user"
    assert "1250000 * 0.065 / 12 = 6,770.8333333333" in str(results["content"])


def test_the_drafting_model_is_told_which_steps_it_may_take(scripted) -> None:
    model = scripted("The memo.")

    data = _write()

    prompt = _system(model.calls[0])
    assert "- Research steps:" in prompt
    assert 'calculate ("expression")' in prompt
    assert data["activity"] == []


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"work_steps": False}, id="a draft that does not ask for steps"),
        pytest.param({"reasoning_effort": "minimal"}, id="a draft the user asked to be fast"),
        pytest.param({"surface": "chat"}, id="a chat reply that arrives whole"),
    ],
)
def test_a_whole_reply_that_may_not_take_steps_comes_back_as_written(scripted, body: dict[str, object]) -> None:
    block = _steps({"do": "calculate", "expression": "2 + 2"})
    model = scripted(block)

    data = _write(**body)

    assert "Research steps" not in _system(model.calls[0])
    assert _reply(data) == block
    assert data["activity"] == []
    assert len(model.calls) == 1


def test_words_written_around_a_step_block_never_reach_the_draft(scripted) -> None:
    scripted(
        f"Let me check the figure.\n{_steps({'do': 'calculate', 'expression': '2 + 2'})}",
        "# Memo\n\nThe total is 4.",
    )

    assert _reply(_write()) == "# Memo\n\nThe total is 4."


def test_a_draft_takes_several_rounds_and_numbers_every_step_in_order(scripted) -> None:
    model = scripted(
        _steps({"do": "calculate", "expression": "1 + 1"}, {"do": "calculate", "expression": "2 + 2"}),
        _steps({"do": "calculate", "expression": "3 + 3"}),
        "Done.",
    )

    data = _write()

    assert _reply(data) == "Done."
    assert [(fact["number"], fact["about"]) for fact in data["activity"]] == [  # type: ignore[union-attr]
        (1, "1 + 1"),
        (2, "2 + 2"),
        (3, "3 + 3"),
    ]
    assert len(model.calls) == 3
    # The second round still sees the first round's results.
    assert "1 + 1 = 2" in str(model.calls[2][-3]["content"])


def test_after_the_last_round_the_model_must_write_and_a_further_block_is_not_run(scripted) -> None:
    block = _steps({"do": "calculate", "expression": "9 * 9"})
    model = scripted(block, block, block, block)

    data = _write()

    assert len(data["activity"]) == 3  # type: ignore[arg-type]
    assert len(model.calls) == 4
    assert "No more steps can be taken" in str(model.calls[3][-1]["content"])
    assert _reply(data) == block


def test_a_step_that_fails_is_reported_and_the_draft_is_still_written(scripted) -> None:
    scripted(_steps({"do": "calculate", "expression": "1 / 0"}), "Written anyway.")

    data = _write()

    assert _reply(data) == "Written anyway."
    assert [(fact["do"], fact["ok"]) for fact in data["activity"]] == [("calculate", False)]  # type: ignore[union-attr]


def test_a_knowledge_search_in_the_models_own_words_finds_a_passage_the_draft_can_cite(scripted) -> None:
    response = client.post(
        f"/api/knowledge/{_BASE}/documents",
        headers=_ADMIN,
        files=[("files", ("lease.txt", BytesIO(b"The Harbor lease renews on 1 March 2031 for ten years."), "text/plain"))],
    )
    assert response.status_code == 200, response.text

    def cite_what_was_found(conversation: list[dict[str, object]]) -> str:
        found = next(line for line in str(conversation[-1]["content"]).splitlines() if "1 March 2031" in line)
        marker = found.split("]")[0].removeprefix("- [")
        return f"The lease renews on 1 March 2031 [{marker}]."

    scripted(_steps({"do": "search_knowledge", "query": "Harbor lease renews"}), cite_what_was_found)

    data = _write(knowledge_config_ids=[_BASE], messages=[{"role": "user", "content": "Summarise the unrelated topic."}])

    assert [fact["do"] for fact in data["activity"]] == ["search_knowledge"]  # type: ignore[union-attr]
    cited = [citation["source_name"] for citation in data["citations"] if citation.get("cited")]  # type: ignore[union-attr]
    assert cited == ["lease.txt"]


def test_a_block_by_block_edit_takes_no_steps(scripted) -> None:
    patch_prompt = (
        "You are changing an existing document block by block.\n"
        "User instruction:\nTighten the wording\n\nDocument blocks:\n[1] Hello there."
    )
    model = scripted('{"changes": []}')

    data = _write(messages=[{"role": "user", "content": patch_prompt}])

    assert "Research steps" not in _system(model.calls[0])
    assert data["activity"] == []


def test_steps_a_draft_took_are_audited_without_what_was_searched_for(scripted) -> None:
    scripted(_steps({"do": "calculate", "expression": "41 + 1"}), "Done.")

    _write()

    audits = [
        event.metadata for event in get_store().audit_events_newest_first() if event.action == "chat.research_steps"
    ]
    assert len(audits) == 1
    assert "41 + 1" not in json.dumps(audits)


# --- The intake turn may ask --------------------------------------------------


def test_the_intake_turn_pauses_with_questions_and_no_text(scripted) -> None:
    model = scripted(_ASK)

    events = _intake()

    assert "- Clarifying questions:" in _system(model.calls[0])
    assert _text(events) == ""
    questions = next(event["questions"] for event in events if "questions" in event)
    assert [question["question"] for question in questions["questions"]] == ["Who is it for?"]  # type: ignore[index]
    assert "ask" in _facts(events)


def test_an_intake_turn_that_finds_the_request_clear_just_says_so(scripted) -> None:
    scripted("READY")

    events = _intake()

    assert _text(events) == "READY"
    assert not any("questions" in event for event in events)


def test_only_the_intake_turn_may_ask_on_drafts(scripted) -> None:
    model = scripted(_ASK)

    events = _intake(messages=[{"role": "user", "content": "Write the memo now."}])

    assert "Clarifying questions" not in _system(model.calls[0])
    assert _text(events) == _ASK
    assert not any("questions" in event for event in events)


def test_the_intake_turn_takes_no_research_steps(scripted) -> None:
    block = _steps({"do": "calculate", "expression": "2 + 2"})
    model = scripted(block)

    events = _intake(work_steps=True)

    assert "Research steps" not in _system(model.calls[0])
    assert _text(events) == block


def test_the_intake_turn_is_not_held_to_the_length_the_request_names(scripted) -> None:
    scripted("READY")
    request = _INTAKE.replace("Draft a memo", "Draft a memo of at least 900 words")

    events = _intake(messages=[{"role": "user", "content": request}])

    assert "requirements" not in _facts(events)


# --- Who may ask, and who may take steps, outside Drafts ----------------------


def test_a_surface_that_is_neither_chat_nor_drafts_takes_no_steps(scripted) -> None:
    block = _steps({"do": "calculate", "expression": "2 + 2"})
    model = scripted(block)

    events = _intake(
        surface="automation",
        clarify_mode=None,
        work_steps=True,
        messages=[{"role": "user", "content": "What is the monthly interest?"}],
    )

    assert "Research steps" not in _system(model.calls[0])
    assert _text(events) == block


@pytest.mark.parametrize(
    ("mode", "told"),
    [
        pytest.param("ask", None, id="cannot pause to ask, with no stream to carry the questions"),
        pytest.param("decide", "the user wants you to make the choices", id="is still told to decide"),
    ],
)
def test_a_chat_reply_that_arrives_whole(scripted, mode: str, told: str | None) -> None:
    model = scripted("A plain answer.")

    _write(surface="chat", clarify_mode=mode, work_steps=False)

    line = next((line for line in _system(model.calls[0]).splitlines() if line.startswith("- Clarifying questions:")), None)
    assert (told in line) if told else line is None


def test_a_draft_takes_steps_the_model_asked_for_in_its_own_tool_call_markup(scripted) -> None:
    native_call = (
        'Checking the figure.<|open|>tools<|sep|><|open|>call tool="undefined" index="1"<|sep|>'
        '<|open|>argument key="steps" type="array"<|sep|>[{"do":"calculate","expression":"2 + 2"}]'
        "<|close|>argument<|sep|><|close|>call<|sep|><|close|>tools<|sep|><|close|>message<|sep|>"
    )
    model = scripted(native_call, "# Memo\n\nThe total is 4.")

    data = _write()

    assert _reply(data) == "# Memo\n\nThe total is 4."
    assert len(model.calls) == 2
    assert "2 + 2 = 4" in str(model.calls[1][-1]["content"])
