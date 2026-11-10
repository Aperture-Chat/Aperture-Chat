"""A chat reply can ask the platform for more research before it answers."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from dataclasses import replace
from io import BytesIO

import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayRoute
from app.core.web_fetch import FetchedWebSource, WebFetchError
from app.core.web_search import WebSearchError
from app.main import app
from app.repositories.deps import get_store
from app.routes import chat as chat_route

client = TestClient(app)
_ADMIN = {"x-aperture-user": "user-admin"}
_BASE = "knowledge-box-matters"


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


class _Scripted:
    """A model that says each scripted turn in order, in small pieces."""

    def __init__(self, turns: list[str]) -> None:
        self.turns = turns
        self.calls: list[list[dict[str, object]]] = []

    def stream(self, _client: object, **kwargs: object) -> Iterator[str]:
        self.calls.append(list(kwargs["messages"]))  # type: ignore[arg-type]
        kwargs["usage_sink"]["finish_reason"] = "stop"  # type: ignore[index]
        text = self.turns[min(len(self.calls), len(self.turns)) - 1]
        return iter([text[index : index + 5] for index in range(0, len(text), 5)])


@pytest.fixture
def scripted(monkeypatch: pytest.MonkeyPatch) -> Callable[..., _Scripted]:
    def install(*turns: str) -> _Scripted:
        model = _Scripted(list(turns))
        monkeypatch.setattr(chat_route, "_resolve_gateway_route", _route)
        monkeypatch.setattr(chat_route, "_gateway_stream", model.stream)
        return model

    return install


def _send(**body: object) -> list[object]:
    response = client.post(
        "/api/chat/complete",
        headers=_ADMIN,
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "What is the monthly interest?"}],
            "stream": True,
            "surface": "chat",
            "work_steps": True,
            **body,
        },
    )
    assert response.status_code == 200, response.text
    events: list[object] = []
    for line in response.text.splitlines():
        if line.startswith("data: "):
            data = line.removeprefix("data: ")
            events.append(data if data == "[DONE]" else json.loads(data))
    return events


def _text(events: list[object]) -> str:
    return "".join(event["delta"] for event in events if isinstance(event, dict) and "delta" in event)


def _step_facts(events: list[object]) -> list[dict[str, object]]:
    return [
        event["activity"]
        for event in events
        if isinstance(event, dict) and isinstance(event.get("activity"), dict) and event["activity"]["kind"] == "step"
    ]


def _done(events: list[object]) -> dict[str, object]:
    return next(event for event in events if isinstance(event, dict) and event.get("done"))


def _system(call: list[dict[str, object]]) -> str:
    return str(next(message["content"] for message in call if message["role"] == "system"))


def _upload(name: str, text: str) -> None:
    response = client.post(
        f"/api/knowledge/{_BASE}/documents",
        headers=_ADMIN,
        files=[("files", (name, BytesIO(text.encode()), "text/plain"))],
    )
    assert response.status_code == 200, response.text


def _step_audits() -> list[dict[str, object]]:
    return [
        event.metadata
        for event in get_store().audit_events_newest_first()
        if event.action == "chat.research_steps"
    ]


def test_the_reply_works_a_figure_out_before_answering_and_the_block_never_shows(scripted) -> None:
    model = scripted(
        _steps({"do": "calculate", "expression": "1250000 * 0.065 / 12"}),
        "The monthly interest is $6,770.83.",
    )

    events = _send()

    assert _text(events) == "The monthly interest is $6,770.83."
    assert _step_facts(events) == [
        {"kind": "step", "number": 1, "do": "calculate", "ok": True, "found": 1, "about": "1250000 * 0.065 / 12"}
    ]
    assert events[-1] == "[DONE]"
    assert len(model.calls) == 2
    asked, results = model.calls[1][-2:]
    assert asked == {"role": "assistant", "content": _steps({"do": "calculate", "expression": "1250000 * 0.065 / 12"}).rstrip()}
    assert results["role"] == "user"
    assert "1250000 * 0.065 / 12 = 6,770.8333333333" in str(results["content"])
    assert "write one more aperture-steps block" in str(results["content"])


def test_the_model_is_told_which_steps_it_may_take_this_turn(scripted) -> None:
    model = scripted("Plain answer.")

    _send()

    prompt = _system(model.calls[0])
    assert "- Research steps:" in prompt
    assert 'calculate ("expression")' in prompt
    assert "search_knowledge" not in prompt
    assert "search_web" not in prompt
    assert "read_page" not in prompt


def test_a_client_that_does_not_ask_for_steps_gets_the_reply_exactly_as_written(scripted) -> None:
    block = _steps({"do": "calculate", "expression": "2 + 2"})
    model = scripted(block)

    events = _send(work_steps=False)

    assert "Research steps" not in _system(model.calls[0])
    assert _text(events) == block
    assert _step_facts(events) == []
    assert len(model.calls) == 1


def test_a_draft_that_asks_for_steps_takes_them_like_a_chat_reply(scripted) -> None:
    model = scripted(_steps({"do": "calculate", "expression": "2 + 2"}), "The total is 4.")

    events = _send(surface="draft")

    assert "- Research steps:" in _system(model.calls[0])
    assert _text(events) == "The total is 4."
    assert [fact["about"] for fact in _step_facts(events)] == ["2 + 2"]


def test_a_reply_the_user_asked_to_be_fast_takes_no_steps(scripted) -> None:
    block = _steps({"do": "calculate", "expression": "2 + 2"})
    model = scripted(block)

    events = _send(reasoning_effort="minimal")

    assert "Research steps" not in _system(model.calls[0])
    assert _text(events) == block
    assert len(model.calls) == 1


def test_text_written_before_the_block_stays_and_the_answer_follows_it(scripted) -> None:
    scripted("Let me work that out." + "\n\n" + _steps({"do": "calculate", "expression": "2 + 2"}), "It is 4.")

    events = _send()

    assert _text(events) == "Let me work that out.\n\nIt is 4."


def test_a_reply_can_take_several_rounds_and_each_step_is_numbered_in_order(scripted) -> None:
    model = scripted(
        _steps({"do": "calculate", "expression": "2 + 2"}, {"do": "calculate", "expression": "3 * 3"}),
        _steps({"do": "calculate", "expression": "4 + 9"}),
        "Thirteen.",
    )

    events = _send()

    assert [(fact["number"], fact["about"]) for fact in _step_facts(events)] == [(1, "2 + 2"), (2, "3 * 3"), (3, "4 + 9")]
    assert _text(events) == "Thirteen."
    assert [message["role"] for message in model.calls[2][-4:]] == ["assistant", "user", "assistant", "user"]


def test_after_the_last_round_the_model_is_told_to_answer_and_a_further_block_is_not_run(scripted) -> None:
    block = _steps({"do": "calculate", "expression": "1 + 1"})
    model = scripted(block, block, block, block)

    events = _send()

    assert len(model.calls) == 4
    assert len(_step_facts(events)) == 3
    assert "No more steps can be taken" in str(model.calls[3][-1]["content"])
    # Nothing the model wrote is lost: the fourth block arrives as text.
    assert _text(events) == block


def test_a_step_the_turn_does_not_allow_is_reported_and_the_reply_goes_on(scripted) -> None:
    model = scripted(_steps({"do": "search_web", "query": "prime rate today"}), "I could not check the web.")

    events = _send()

    assert _step_facts(events) == [
        {"kind": "step", "number": 1, "do": "search_web", "ok": False, "found": 0, "about": "prime rate today"}
    ]
    assert "This step is not available for this reply." in str(model.calls[1][-1]["content"])
    assert _text(events) == "I could not check the web."


def test_a_calculation_that_cannot_be_done_tells_the_model_why(scripted) -> None:
    model = scripted(_steps({"do": "calculate", "expression": "1 / 0"}), "That cannot be computed.")

    events = _send()

    assert _step_facts(events)[0]["ok"] is False
    assert "Cannot divide by zero." in str(model.calls[1][-1]["content"])


@pytest.fixture
def base_with_two_documents() -> None:
    _upload(
        "escrow-terms.txt",
        "The Harborview purchase agreement sets an escrow holdback of twelve percent, "
        "released to the seller eighteen months after closing.",
    )
    _upload(
        "indemnity-terms.txt",
        "The Harborview purchase agreement caps seller indemnity at two million dollars "
        "and excludes fraud from the cap.",
    )


@pytest.mark.usefixtures("base_with_two_documents")
def test_a_knowledge_search_in_the_models_own_words_finds_passages_it_can_cite(scripted) -> None:
    model = scripted(
        _steps({"do": "search_knowledge", "query": "seller indemnity cap fraud"}),
        "placeholder",
    )

    def reply(_client: object, **kwargs: object) -> Iterator[str]:
        messages = list(kwargs["messages"])  # type: ignore[arg-type]
        model.calls.append(messages)
        kwargs["usage_sink"]["finish_reason"] = "stop"  # type: ignore[index]
        if len(model.calls) == 1:
            return iter([model.turns[0]])
        line = next(line for line in str(messages[-1]["content"]).splitlines() if "caps seller indemnity" in line)
        marker = line.split("]")[0].removeprefix("- [")
        return iter([f"Indemnity is capped at two million dollars [{marker}]."])

    chat_route._gateway_stream = reply  # the scripted fixture's monkeypatch restores it

    events = _send(
        messages=[{"role": "user", "content": "Summarize the Harborview agreement."}],
        knowledge_config_ids=[_BASE],
        citations_enabled=True,
    )

    fact = _step_facts(events)[0]
    assert (fact["do"], fact["ok"]) == ("search_knowledge", True)
    assert fact["found"] >= 1
    cited = [citation for citation in _done(events)["citations"] if citation.get("cited")]
    assert [citation["source_name"] for citation in cited] == ["indemnity-terms.txt"]
    assert 'search_knowledge ("query")' in _system(model.calls[0])


@pytest.mark.usefixtures("base_with_two_documents")
def test_a_passage_found_again_keeps_the_number_it_already_has(scripted, monkeypatch: pytest.MonkeyPatch) -> None:
    model = scripted(_steps({"do": "search_knowledge", "query": "escrow holdback"}), "Done.")

    _send(
        messages=[{"role": "user", "content": "What is the escrow holdback in the Harborview agreement?"}],
        knowledge_config_ids=[_BASE],
        citations_enabled=True,
    )

    first_labels = {
        line.split("]")[0] + "]": line
        for line in _system(model.calls[0]).splitlines()
        if line.startswith("- [K")
    }
    again = [line for line in str(model.calls[1][-1]["content"]).splitlines() if line.startswith("- [K")]
    assert again, "the search must return passages"
    for line in again:
        label = line.split("]")[0] + "]"
        if "escrow holdback of twelve percent" in line:
            assert "escrow holdback of twelve percent" in first_labels[label]


class _Result:
    def __init__(self, index: int) -> None:
        self.title = f"Result {index}"
        self.url = f"https://example.com/{index}"
        self.snippet = f"Snippet {index}."


@pytest.fixture
def web_search(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    queries: list[str] = []

    class Search:
        engine = "duckduckgo"
        api_key = None

        def search(self, query: str) -> list[_Result]:
            queries.append(query)
            if "broken" in query:
                raise WebSearchError("The engine timed out.")
            return [_Result(1), _Result(2)] if len(queries) == 1 else [_Result(2), _Result(7)]

    monkeypatch.setattr(chat_route, "web_search_client_from_config", lambda _settings: Search())
    return queries


def test_a_second_web_search_adds_new_results_after_the_first_ones(scripted, web_search: list[str]) -> None:
    model = scripted(_steps({"do": "search_web", "query": "prime rate history"}), "The rate rose [W3].")

    events = _send(web_enabled=True, citations_enabled=True)

    assert web_search[1] == "prime rate history"
    results = str(model.calls[1][-1]["content"])
    assert "- [W2] Result 2 (https://example.com/2): Snippet 2." in results
    assert "- [W3] Result 7 (https://example.com/7): Snippet 7." in results
    assert _step_facts(events)[0] == {
        "kind": "step", "number": 1, "do": "search_web", "ok": True, "found": 2, "about": "prime rate history",
    }
    cited = [citation for citation in _done(events)["citations"] if citation.get("cited")]
    assert [(citation["source_uri"], citation["w_index"]) for citation in cited] == [("https://example.com/7", 3)]


def test_a_web_search_that_fails_tells_the_model_and_the_reply_goes_on(scripted, web_search: list[str]) -> None:
    model = scripted(_steps({"do": "search_web", "query": "broken"}), "I could not search further.")

    events = _send(web_enabled=True)

    assert _step_facts(events)[0]["ok"] is False
    assert "Web search is unavailable: The engine timed out." in str(model.calls[1][-1]["content"])
    assert _text(events) == "I could not search further."


def _page(url: str, text: str) -> FetchedWebSource:
    return FetchedWebSource(
        requested_url=url,
        final_url=url,
        filename="Rates page",
        text=text,
        byte_count=len(text),
        content_type="text/html",
    )


def test_reading_a_page_gives_the_model_its_text_under_a_number_it_can_cite(
    scripted, web_search: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    fetched: list[str] = []

    def fetch(url: str, **_kwargs: object) -> FetchedWebSource:
        fetched.append(url)
        return _page(url, "The prime rate is 7.5 percent. " + "Detail. " * 2000)

    monkeypatch.setattr(chat_route, "fetch_web_source", fetch)
    model = scripted(_steps({"do": "read_page", "url": "https://example.com/1"}), "It is 7.5 percent [U1].")

    events = _send(web_enabled=True, citations_enabled=True)

    assert fetched == ["https://example.com/1"]
    results = str(model.calls[1][-1]["content"])
    assert "- [U1] Rates page (https://example.com/1): The prime rate is 7.5 percent." in results
    assert len(results) < 8_000, "a long page is cut to a readable excerpt"
    assert _step_facts(events)[0]["found"] == 1
    cited = [citation for citation in _done(events)["citations"] if citation.get("cited")]
    assert [(citation["source_uri"], citation["u_index"]) for citation in cited] == [("https://example.com/1", 1)]


def test_a_page_that_cannot_be_read_tells_the_model_why(
    scripted, web_search: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def fetch(url: str, **_kwargs: object) -> FetchedWebSource:
        raise WebFetchError(502, "Web source fetch failed for example.com: HTTP 404.")

    monkeypatch.setattr(chat_route, "fetch_web_source", fetch)
    model = scripted(_steps({"do": "read_page", "url": "https://example.com/gone"}), "The page is gone.")

    events = _send(web_enabled=True)

    assert _step_facts(events)[0]["ok"] is False
    assert "Web source fetch failed for example.com: HTTP 404." in str(model.calls[1][-1]["content"])


def test_pages_are_read_only_when_the_user_turned_web_on(scripted, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        chat_route, "fetch_web_source", lambda *_args, **_kwargs: pytest.fail("no page may be fetched")
    )
    model = scripted(_steps({"do": "read_page", "url": "https://example.com/1"}), "Not available.")

    events = _send()

    assert _step_facts(events)[0]["ok"] is False
    assert "read_page" not in _system(model.calls[0])


def test_the_audit_trail_records_the_steps_taken_but_never_what_was_searched_for(scripted, web_search: list[str]) -> None:
    scripted(
        _steps(
            {"do": "search_web", "query": "confidential merger target"},
            {"do": "calculate", "expression": "2 + 2"},
        ),
        "Done.",
    )

    _send(web_enabled=True, thread_id="thread-steps")

    audits = _step_audits()
    assert len(audits) == 1
    assert audits[0]["thread_id"] == "thread-steps"
    assert audits[0]["round"] == 1
    assert audits[0]["steps"] == [
        {"do": "search_web", "ok": True, "found": 2},
        {"do": "calculate", "ok": True, "found": 1},
    ]
    assert audits[0]["web_result_urls"] == ["https://example.com/7"]
    assert "confidential merger target" not in json.dumps(audits)


def test_the_first_audit_record_says_which_steps_were_offered(scripted, web_search: list[str]) -> None:
    scripted("Plain answer.")

    _send(web_enabled=True)

    completion = next(
        event.metadata for event in get_store().audit_events_newest_first() if event.action == "chat.completion"
    )
    assert completion["runtime_context"]["work_step_kinds"] == ["calculate", "read_page", "search_web"]


# --- Bookkeeping: markers, source rows, and what is reused ----------------------


def _chunk(chunk_id: str, name: str, text: str):
    from app.models.schemas import KnowledgeChunk

    return KnowledgeChunk(
        id=chunk_id,
        knowledge_config_id=_BASE,
        document_id=f"document-{chunk_id}",
        tenant_id="tenant-example",
        source_name=name,
        source_uri=f"box://files/{chunk_id}",
        source_type="box",
        text=text,
        ordinal=0,
        acl_group_ids=["group-default-users"],
        updated_at="2026-07-20T12:00:00Z",
    )


@pytest.fixture
def staged_knowledge(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The first search finds one passage; a search for "indemnity" finds it
    again plus two new ones."""
    queries: list[str] = []
    escrow = _chunk("escrow", "escrow.txt", "The escrow holdback is twelve percent.")
    cap = _chunk("cap", "indemnity.txt", "Seller indemnity is capped at two million dollars.")
    fraud = _chunk("fraud", "fraud.txt", "Fraud is excluded from the indemnity cap.")

    def retrieve(_store, _actor, _config_ids, query: str, *, limit: int = 4):
        queries.append(query)
        return [escrow, cap, fraud] if "indemnity" in query else [escrow]

    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", retrieve)
    return queries


def _result_lines(model: _Scripted, call: int = 1) -> list[str]:
    return [line for line in str(model.calls[call][-1]["content"]).splitlines() if line.startswith("- [")]


def test_new_passages_take_the_next_numbers_and_a_known_one_keeps_its_own(scripted, staged_knowledge) -> None:
    model = scripted(_steps({"do": "search_knowledge", "query": "indemnity cap"}), "Capped at two million [K2], fraud aside [K3].")

    events = _send(knowledge_config_ids=[_BASE], citations_enabled=True)

    assert staged_knowledge[1] == "indemnity cap"
    assert [line.split(" ")[1] for line in _result_lines(model)] == ["[K1]", "[K2]", "[K3]"]
    assert _step_facts(events)[0]["found"] == 3
    cited = [(c["source_name"], c["k_index"]) for c in _done(events)["citations"] if c.get("cited")]
    assert cited == [("indemnity.txt", 2), ("fraud.txt", 3)]
    passages = {c["source_name"]: c["passage"] for c in _done(events)["citations"] if c.get("cited")}
    assert passages["indemnity.txt"].startswith("Seller indemnity is capped")


def test_a_second_search_does_not_renumber_what_the_first_one_found(scripted, staged_knowledge) -> None:
    model = scripted(
        _steps({"do": "search_knowledge", "query": "indemnity cap"}),
        _steps({"do": "search_knowledge", "query": "indemnity again"}),
        "Done.",
    )

    _send(knowledge_config_ids=[_BASE], citations_enabled=True)

    assert [line.split(" ")[1] for line in _result_lines(model, 2)] == ["[K1]", "[K2]", "[K3]"]


def test_with_citations_off_steps_add_no_source_rows(scripted, staged_knowledge, web_search: list[str], monkeypatch) -> None:
    monkeypatch.setattr(chat_route, "fetch_web_source", lambda url, **_kwargs: _page(url, "Page text."))
    scripted(
        _steps(
            {"do": "search_knowledge", "query": "indemnity cap"},
            {"do": "search_web", "query": "prime rate history"},
            {"do": "read_page", "url": "https://example.com/9"},
        ),
        "Capped [K2], per the web [W3] and the page [U1].",
    )

    events = _send(knowledge_config_ids=[_BASE], web_enabled=True, citations_enabled=False)

    assert _done(events)["citations"] == []


def test_a_page_read_twice_keeps_one_number_and_another_page_takes_the_next(
    scripted, web_search: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(chat_route, "fetch_web_source", lambda url, **_kwargs: _page(url, f"Text of {url}."))
    model = scripted(
        _steps(
            {"do": "read_page", "url": "https://example.com/a"},
            {"do": "read_page", "url": "https://example.com/a"},
            {"do": "read_page", "url": "https://example.com/b"},
        ),
        "From the second page [U2].",
    )

    events = _send(web_enabled=True, citations_enabled=True)

    assert [line.split(" ")[1] for line in _result_lines(model)] == ["[U1]", "[U1]", "[U2]"]
    cited = [c for c in _done(events)["citations"] if c.get("cited")]
    assert [(c["source_name"], c["source_uri"], c["u_index"]) for c in cited] == [
        ("Rates page", "https://example.com/b", 2)
    ]
    assert cited[0]["snippet"].startswith("Text of https://example.com/b")
    assert _step_audits()[0]["fetched_urls"] == ["https://example.com/a", "https://example.com/b"]


def test_reading_the_page_behind_a_search_result_cites_that_results_row(
    scripted, web_search: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(chat_route, "fetch_web_source", lambda url, **_kwargs: _page(url, "The full page."))
    scripted(_steps({"do": "read_page", "url": "https://example.com/2"}), "As the page says [U1].")

    events = _send(web_enabled=True, citations_enabled=True)

    rows = [(c["source_uri"], c.get("w_index"), c.get("u_index")) for c in _done(events)["citations"] if c.get("cited")]
    assert rows == [("https://example.com/2", 2, 1)]


def test_a_search_engine_that_needs_a_key_uses_the_workspace_key_for_steps_too(
    scripted, monkeypatch: pytest.MonkeyPatch
) -> None:
    keys_seen: list[str | None] = []

    class Keyed:
        engine = "openai"

        def __init__(self, api_key: str | None) -> None:
            self.api_key = api_key

        def search(self, _query: str) -> list[_Result]:
            keys_seen.append(self.api_key)
            return [_Result(1)]

    clients = iter([Keyed(None), Keyed(None), Keyed("already-set")])
    monkeypatch.setattr(chat_route, "web_search_client_from_config", lambda _settings: next(clients))
    monkeypatch.setattr(chat_route, "resolve_search_provider_key", lambda *_args, **_kwargs: "workspace-key")
    scripted(
        _steps({"do": "search_web", "query": "one"}),
        _steps({"do": "search_web", "query": "two"}),
        "Done.",
    )

    _send(web_enabled=True)

    assert keys_seen == ["workspace-key", "workspace-key", "already-set"]


def test_taking_steps_writes_audit_rows_without_rewriting_the_runtime_state(
    scripted, monkeypatch: pytest.MonkeyPatch
) -> None:
    saves: list[int] = []
    original = type(get_store()).save_runtime_state

    def counting(self, *args, **kwargs):
        saves.append(1)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(type(get_store()), "save_runtime_state", counting)
    scripted("Plain answer.")
    _send()
    plain = len(saves)
    scripted(_steps({"do": "calculate", "expression": "2 + 2"}), "Four.")

    _send()

    assert len(saves) - plain == plain
    assert len(_step_audits()) == 1


@pytest.mark.parametrize(
    ("k_index", "label"),
    [(7, "[K7]"), (1, "[K1]"), (None, "[K2]"), (0, "[K2]"), (-3, "[K2]"), (True, "[K2]"), ("5", "[K2]")],
)
def test_a_passage_is_labelled_by_its_own_number_or_failing_that_by_its_place(k_index: object, label: str) -> None:
    from app.models.schemas import ModelConfig

    model = ModelConfig(id="m", provider_id="p", provider_name="P", name="M")
    hits = [
        {"k_index": 1, "source_name": "first.txt", "text": "First passage."},
        {"k_index": k_index, "source_name": "second.txt", "text": "Second passage."},
    ]

    prompt = chat_route._runtime_prompt(model, {"knowledge_hits": hits})

    assert f"- {label} second.txt: Second passage." in prompt


def test_when_the_first_search_found_nothing_a_step_starts_numbering_at_one(
    scripted, monkeypatch: pytest.MonkeyPatch
) -> None:
    cap = _chunk("cap", "indemnity.txt", "Seller indemnity is capped at two million dollars.")
    monkeypatch.setattr(
        type(get_store()),
        "retrieve_knowledge",
        lambda _store, _actor, _ids, query, *, limit=4: [cap] if "indemnity" in query else [],
    )
    model = scripted(_steps({"do": "search_knowledge", "query": "indemnity cap"}), "Capped [K1].")

    events = _send(knowledge_config_ids=[_BASE], citations_enabled=True)

    assert [line.split(" ")[1] for line in _result_lines(model)] == ["[K1]"]
    assert [(c["source_name"], c["k_index"]) for c in _done(events)["citations"] if c.get("cited")] == [
        ("indemnity.txt", 1)
    ]


def test_a_page_whose_address_cannot_be_kept_is_read_but_never_listed_as_a_source(
    scripted, web_search: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def fetch(url: str, **_kwargs: object) -> FetchedWebSource:
        return replace(_page(url, "Readable text."), final_url="file:///not-a-web-address")

    monkeypatch.setattr(chat_route, "fetch_web_source", fetch)
    model = scripted(_steps({"do": "read_page", "url": "https://example.com/redirects"}), "As read [U1].")

    events = _send(web_enabled=True, citations_enabled=True)

    assert _result_lines(model) == ["- [U1] Rates page: Readable text."]
    assert [c for c in _done(events)["citations"] if not c["source_uri"]] == []
    assert [c for c in _done(events)["citations"] if c.get("u_index")] == []
