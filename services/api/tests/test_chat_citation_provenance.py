from __future__ import annotations

import json
import logging
import re
import signal
from collections.abc import Callable, Iterator
from io import BytesIO

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.dialects import sqlite

from app.core.citation_use import (
    CITATION_TEXT_FIELDS,
    citations_used,
    screened_fields,
    strip_citation_markers,
)
from app.core.directives import Directive, directive_results
from app.core.model_gateway import ModelGatewayClient, ModelGatewayRoute
from app.core.web_fetch import FetchedWebSource
from app.db.orm import StrictChatMessagesJSON
from app.main import app
from app.models.schemas import ChatCitation, KnowledgeChunk, ModelConfig
from app.repositories.deps import get_store
from app.routes import chat as chat_route
from tests.test_privacy_protection import enable_privacy


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _chunk(
    chunk_id: str,
    text: str,
    *,
    ordinal: int,
    page_start: int | None = None,
    page_end: int | None = None,
    locator: str | None = None,
) -> KnowledgeChunk:
    return KnowledgeChunk(
        id=chunk_id,
        knowledge_config_id="knowledge-shared",
        document_id="document-shared",
        tenant_id="tenant-example",
        source_name="Shared diligence source",
        source_uri="box://files/shared-source",
        source_type="box",
        text=text,
        ordinal=ordinal,
        page_start=page_start,
        page_end=page_end,
        locator=locator,
        acl_group_ids=["group-default-users"],
        updated_at="2026-07-20T12:00:00Z",
    )


def _model() -> ModelConfig:
    return ModelConfig(
        id="model-citation-test",
        provider_id="provider-test",
        provider_name="Test Provider",
        name="Citation Test",
    )


def _route() -> ModelGatewayRoute:
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


def test_runtime_prompt_requires_every_diagram_block_to_render_on_first_delivery() -> None:
    prompt = chat_route._runtime_prompt(_model(), {})

    assert "every block intended as a diagram must render as a visual on first delivery" in prompt
    assert "Never substitute a generic ```json or ```yaml status object" in prompt
    assert "non-empty rows array" in prompt


def _sse_events(response_text: str) -> list[object]:
    events: list[object] = []
    for line in response_text.splitlines():
        if not line.startswith("data: "):
            continue
        payload = line.removeprefix("data: ")
        events.append(payload if payload == "[DONE]" else json.loads(payload))
    return events


def test_same_source_chunks_keep_distinct_citations_k_indexes_and_prompt_locators() -> None:
    chunks = [
        _chunk(
            "chunk-page-2",
            "Page-specific obligation.",
            ordinal=0,
            page_start=2,
            page_end=2,
            locator="Page 2",
        ),
        _chunk(
            "chunk-page-9",
            "Later-page exception.",
            ordinal=1,
            page_start=9,
            page_end=9,
            locator="Page 9",
        ),
        _chunk(
            "chunk-sheet",
            "Spreadsheet assumption.",
            ordinal=2,
            locator="Sheet: Summary",
        ),
        _chunk(
            "chunk-slide",
            "Presentation risk.",
            ordinal=3,
            locator="Slide 4",
        ),
    ]

    citations = chat_route._runtime_citations(chunks, [], [], [], True)
    runtime_hits = [
        chat_route._runtime_knowledge_hit(chunk, k_index=index)
        for index, chunk in enumerate(chunks, start=1)
    ]
    prompt = chat_route._runtime_prompt(
        _model(),
        {
            "citations_enabled": True,
            "knowledge_hits": runtime_hits,
        },
    )
    audit = chat_route._audit_runtime_context(
        {
            "knowledge_hits": runtime_hits,
            "citations": [citation.model_dump(mode="json") for citation in citations],
        }
    )

    assert [citation.chunk_id for citation in citations] == [
        "chunk-page-2",
        "chunk-page-9",
        "chunk-sheet",
        "chunk-slide",
    ]
    assert [citation.k_index for citation in citations] == [1, 2, 3, 4]
    assert [citation.source_uri for citation in citations] == [
        "box://files/shared-source",
        "box://files/shared-source",
        "box://files/shared-source",
        "box://files/shared-source",
    ]
    assert citations[0].page_start == 2
    assert citations[0].page_end == 2
    assert citations[0].locator == "Page 2"
    assert "cite grounded claims inline with the exact [K#] label" in prompt
    assert "[K1] (p. 2) Shared diligence source" in prompt
    assert "[K2] (p. 9) Shared diligence source" in prompt
    assert "[K3] (Sheet: Summary) Shared diligence source" in prompt
    assert "[K4] (Slide 4) Shared diligence source" in prompt
    assert [reference["k_index"] for reference in audit["knowledge_hit_refs"]] == [1, 2, 3, 4]
    assert audit["knowledge_hit_refs"][0]["chunk_id"] == "chunk-page-2"
    assert audit["knowledge_hit_refs"][0]["page_start"] == 2
    assert audit["knowledge_hit_refs"][2]["locator"] == "Sheet: Summary"
    assert audit["citations"][1]["chunk_id"] == "chunk-page-9"
    assert audit["citations"][1]["page_start"] == 9
    assert "text" not in audit["knowledge_hit_refs"][0]


def test_duplicate_chunk_is_removed_before_k_index_assignment() -> None:
    first = _chunk("chunk-first", "First excerpt.", ordinal=0, locator="Page 1")
    second = _chunk("chunk-second", "Second excerpt.", ordinal=1, locator="Page 2")

    unique = chat_route._dedupe_knowledge_hits([first, first, second])
    citations = chat_route._runtime_citations([first, first, second], [], [], [], True)
    runtime_hits = [
        chat_route._runtime_knowledge_hit(chunk, k_index=index)
        for index, chunk in enumerate(unique, start=1)
    ]
    prompt = chat_route._runtime_prompt(
        _model(),
        {"citations_enabled": True, "knowledge_hits": runtime_hits},
    )

    assert [chunk.id for chunk in unique] == ["chunk-first", "chunk-second"]
    assert [(citation.chunk_id, citation.k_index) for citation in citations] == [
        ("chunk-first", 1),
        ("chunk-second", 2),
    ]
    assert "[K1] (Page 1)" in prompt
    assert "[K2] (Page 2)" in prompt
    assert "[K3]" not in prompt


def test_legacy_chunk_keeps_null_location_without_fabricated_page() -> None:
    legacy = _chunk("chunk-legacy", "Legacy source excerpt.", ordinal=0)
    citation = chat_route._runtime_citations([legacy], [], [], [], True)[0]
    runtime_hit = chat_route._runtime_knowledge_hit(legacy, k_index=1)
    prompt = chat_route._runtime_prompt(
        _model(),
        {"citations_enabled": True, "knowledge_hits": [runtime_hit]},
    )

    assert citation.page_start is None
    assert citation.page_end is None
    assert citation.locator is None
    assert runtime_hit["page_start"] is None
    assert runtime_hit["page_end"] is None
    assert runtime_hit["locator"] is None
    assert "[K1] Shared diligence source (box://files/shared-source)" in prompt
    assert "[K1] (p." not in prompt


def test_merge_uses_chunk_identity_but_still_collapses_duplicate_web_urls() -> None:
    knowledge_one = ChatCitation(
        id="cite-one",
        source_name="Shared source",
        source_type="box",
        source_uri="box://files/shared",
        snippet="Page one.",
        chunk_id="chunk-one",
        k_index=1,
    )
    knowledge_two = knowledge_one.model_copy(
        update={"id": "cite-two", "snippet": "Page two.", "chunk_id": "chunk-two", "k_index": 2}
    )
    duplicate_chunk = knowledge_one.model_copy(update={"id": "cite-one-again"})
    web_one = ChatCitation(
        id="cite-web-1",
        source_name="Example",
        source_type="web",
        source_uri="https://example.com/source",
        snippet="Original web result.",
    )
    web_duplicate = web_one.model_copy(update={"id": "cite-web-2", "snippet": "Duplicate."})

    merged = chat_route._merge_citations(
        [knowledge_one, knowledge_two, web_one],
        [duplicate_chunk, web_duplicate],
    )

    assert [citation.id for citation in merged] == ["cite-one", "cite-two", "cite-web-1"]


def test_stream_and_non_stream_return_identical_grounded_citation_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    knowledge_citation = ChatCitation(
        id="cite-chunk-page-8",
        source_name="Matter policy",
        source_type="knowledge",
        source_uri="knowledge://matter-policy",
        snippet="Retention is seven years.",
        page_start=8,
        page_end=8,
        locator="Page 8",
        chunk_id="chunk-page-8",
        k_index=1,
    ).model_dump(mode="json")
    annotation = {
        "type": "url_citation",
        "url_citation": {
            "url": "https://example.com/current",
            "title": "Current source",
            "content": "Current public information.",
        },
    }

    def runtime_context(*_args: object, **_kwargs: object) -> dict[str, object]:
        return {
            "citations": [dict(knowledge_citation)],
            "citations_enabled": True,
        }

    def complete(*_args: object, **_kwargs: object) -> dict[str, object]:
        return {
            "id": "citation-parity",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Grounded answer [K1].",
                        "annotations": [annotation],
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {},
        }

    class CitationGateway:
        def complete(self, **kwargs: object) -> dict[str, object]:
            return complete(**kwargs)

    def stream(*_args: object, **kwargs: object):
        usage_sink = kwargs.get("usage_sink")
        if isinstance(usage_sink, dict):
            usage_sink["annotations"] = [annotation]
            usage_sink["finish_reason"] = "stop"
        return iter(["Grounded answer [K1]."])

    def tenant_route(*_args: object, tenant_id: str | None) -> ModelGatewayRoute:
        assert tenant_id == "tenant-example"
        return _route()

    monkeypatch.setattr(chat_route, "_resolve_gateway_route", tenant_route)
    monkeypatch.setattr(chat_route, "_resolve_runtime_context", runtime_context)
    monkeypatch.setattr(chat_route, "get_model_gateway_client", lambda: CitationGateway())
    monkeypatch.setattr(chat_route, "_gateway_stream", stream)

    request = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "Answer with sources."}],
    }
    non_stream = client.post(
        "/api/chat/complete",
        json=request,
        headers={"x-aperture-user": "user-jane"},
    )
    streamed = client.post(
        "/api/chat/complete",
        json={**request, "stream": True},
        headers={"x-aperture-user": "user-jane"},
    )

    assert non_stream.status_code == 200
    assert streamed.status_code == 200
    done = next(
        event
        for event in _sse_events(streamed.text)
        if isinstance(event, dict) and event.get("done")
    )
    assert done["citations"] == non_stream.json()["citations"]
    assert done["citations"][0]["page_start"] == 8
    assert done["citations"][0]["chunk_id"] == "chunk-page-8"
    assert done["citations"][0]["k_index"] == 1
    assert done["citations"][1]["source_type"] == "web"


def test_gateway_collects_streamed_web_annotations_for_completion_metadata() -> None:
    annotation = {
        "type": "url_citation",
        "url_citation": {
            "url": "https://example.com/live",
            "title": "Live result",
            "content": "Live result context.",
        },
    }
    sse = (
        "data: "
        + json.dumps(
            {
                "choices": [
                    {
                        "delta": {"content": "Answer", "annotations": [annotation]},
                        "finish_reason": None,
                    }
                ]
            }
        )
        + "\n\n"
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + "data: [DONE]\n\n"
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=sse, headers={"content-type": "text/event-stream"})

    gateway = ModelGatewayClient(transport=httpx.MockTransport(handler))
    usage_sink: dict[str, object] = {}
    pieces = list(
        gateway.stream(
            route=_route(),
            messages=[{"role": "user", "content": "Search."}],
            usage_sink=usage_sink,
        )
    )

    assert pieces == ["Answer"]
    assert usage_sink["annotations"] == [annotation]
    assert usage_sink["finish_reason"] == "stop"


def test_document_properties_travel_with_each_knowledge_passage_in_the_prompt() -> None:
    chunk = _chunk("chunk-memo", "Price is 42 million.", ordinal=0, locator="Page 1").model_copy(
        update={"source_details": "Title: Falcon memo · Author: Avery Example"}
    )
    plain = _chunk("chunk-plain", "No properties here.", ordinal=1)
    prompt = chat_route._runtime_prompt(
        _model(),
        {
            "citations_enabled": True,
            "knowledge_hits": [
                chat_route._runtime_knowledge_hit(chunk, k_index=1),
                chat_route._runtime_knowledge_hit(plain, k_index=2),
            ],
        },
    )
    assert (
        "[K1] (Page 1) Shared diligence source (box://files/shared-source) "
        "[Title: Falcon memo · Author: Avery Example]: Price is 42 million." in prompt
    )
    assert "[K2] Shared diligence source (box://files/shared-source): No properties here." in prompt


def test_knowledge_citation_names_the_document_and_base_it_came_from() -> None:
    chunk = _chunk("chunk-memo", "Price is 42 million.", ordinal=0, page_start=3, page_end=3)

    citation = chat_route._runtime_citations([chunk], [], [], [], True)[0]

    assert citation.document_id == "document-shared"
    assert citation.knowledge_config_id == "knowledge-shared"


def test_a_citation_saved_before_these_fields_existed_still_loads_as_legacy() -> None:
    stored = {
        "id": "cite-old",
        "source_name": "Old source",
        "source_type": "knowledge",
        "source_uri": "knowledge://old",
        "snippet": "Saved long ago.",
        "chunk_id": "chunk-old",
        "k_index": 1,
    }

    citation = ChatCitation(**stored)

    assert citation.cited is None
    assert citation.document_id is None
    assert citation.knowledge_config_id is None
    assert citation.w_index is None
    assert citation.u_index is None


def test_fetched_url_citation_keeps_the_number_the_prompt_showed() -> None:
    fetched = [
        {"u_index": 2, "source_name": "Page", "source_uri": "https://example.com/p", "text": "Body."}
    ]

    citation = chat_route._runtime_citations([], [], [], [], True, fetched_urls=fetched)[0]

    assert citation.u_index == 2


def test_platform_web_results_keep_the_number_the_prompt_showed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Result:
        def __init__(self, n: int) -> None:
            self.title = f"Result {n}"
            self.url = f"https://example.com/{n}"
            self.snippet = f"Snippet {n}."

    class Search:
        engine = "duckduckgo"
        api_key = None

        def search(self, _query: str) -> list[Result]:
            return [Result(1), Result(2)]

    monkeypatch.setattr(chat_route, "web_search_client_from_config", lambda _settings: Search())
    context: dict[str, object] = {"web_enabled": True, "citations_enabled": True, "citations": []}
    request = chat_route.ChatCompletionRequest(
        model="gpt-4o-mini", messages=[{"role": "user", "content": "Search."}]
    )

    chat_route._attach_platform_web_search(request, _route(), context, get_store(), "tenant-example")

    prompt = chat_route._runtime_prompt(_model(), context)
    numbered = [(c["source_uri"], c["w_index"]) for c in context["citations"]]
    assert numbered == [("https://example.com/1", 1), ("https://example.com/2", 2)]
    assert "[W1] Result 1 (https://example.com/1)" in prompt
    assert "[W2] Result 2 (https://example.com/2)" in prompt


def _knowledge_citation(k_index: int) -> ChatCitation:
    return ChatCitation(
        id=f"cite-chunk-{k_index}",
        source_name=f"Document {k_index}",
        source_type="upload",
        source_uri=f"upload://document-{k_index}",
        snippet="Passage.",
        chunk_id=f"chunk-{k_index}",
        k_index=k_index,
        document_id=f"document-{k_index}",
        knowledge_config_id="knowledge-shared",
    )


def _web_citation(w_index: int) -> ChatCitation:
    return ChatCitation(
        id=f"cite-web-{w_index}",
        source_name=f"Result {w_index}",
        source_type="web",
        source_uri=f"https://example.com/{w_index}",
        snippet="Result.",
        w_index=w_index,
    )


def _fetched_citation(u_index: int) -> ChatCitation:
    return ChatCitation(
        id=f"cite-fetch-{u_index}",
        source_name=f"Fetched {u_index}",
        source_type="web",
        source_uri=f"https://example.com/fetched-{u_index}",
        snippet="Fetched.",
        u_index=u_index,
    )


_ATTACHMENT = ChatCitation(
    id="cite-attachment",
    source_name="notes.txt",
    source_type="upload",
    source_uri="upload://attachment",
    snippet="Uploaded file available to this chat turn.",
)
_MCP_RESULT = ChatCitation(
    id="cite-mcp-1",
    source_name="Ticket tool",
    source_type="mcp",
    source_uri="mcp://tool/search",
    snippet="Result.",
)


def _kept_knowledge(answer: str, count: int = 4) -> list[int]:
    supplied = [_knowledge_citation(index) for index in range(1, count + 1)]
    return [citation.k_index for citation in citations_used(answer, supplied)]


@pytest.mark.parametrize(
    ("answer", "kept"),
    [
        ("Grounded in [K2].", [2]),
        ("Grounded in 【K2】.", [2]),
        ("Grounded in ［K2］.", [2]),
        ("Grounded in [ K 2 ].", [2]),
        ("Grounded in [K1, K2].", [1, 2]),
        ("Grounded in [K1,K3].", [1, 3]),
        ("Grounded in [K1; K2].", [1, 2]),
        ("Grounded in [K1 and K4].", [1, 4]),
        ("Grounded in [K1][K2].", [1, 2]),
        ("Grounded in [K1], [K3].", [1, 3]),
        ("Grounded in [K1-K3].", [1, 2, 3]),
        ("Grounded in [K1–K3].", [1, 2, 3]),
        ("Grounded in [K1—K3].", [1, 2, 3]),
        ("Grounded in [K1 - K3].", [1, 2, 3]),
        ("Grounded in [K2-3].", [2, 3]),
        ("Grounded in [K3-K1].", [1, 2, 3]),
        ("Grounded in [K1-K3, K4].", [1, 2, 3, 4]),
        ("Grounded in [K2, p. 4].", [2]),
        ("Grounded in [K2, pp. 4-5].", [2]),
        ("Grounded in [K2 p. 4].", [2]),
        ("Grounded in [K2, Slide 3].", [2]),
        ("Grounded in [K1 K2].", [1, 2]),
        ("Grounded in [K1/K2].", [1, 2]),
        ("Grounded in [K1 & K2].", [1, 2]),
        ("Grounded in 【K1，K2】.", [1, 2]),
        ("Grounded in 【K1、K3】.", [1, 3]),
        ("Mixed [K1, K2] and then [K3].", [1, 2, 3]),
        ("Serial comma [K1, K2, and K3].", [1, 2, 3]),
        ("Short serial [K1, and K2].", [1, 2]),
        ("Semicolon serial [K1; and K2].", [1, 2]),
        ("The prompt's own label [K1 (p. 40)].", [1]),
        ("Colon page [K1: p. 40].", [1]),
        ("Dash page [K1 - p. 40].", [1]),
        ("A file [K1: Harlow survey.pdf].", [1]),
        ("A file and page [K1, Harlow survey.pdf, p. 40].", [1]),
        ("Prefix [Source: K1].", [1]),
        ("Prefix [Sources: K1, K2].", [1, 2]),
        ("Prefix [Ref K1].", [1]),
        ("Prefix [Reference: K2].", [2]),
        ("Trailing dot [K1.]", [1]),
        ("Trailing comma [K1,]", [1]),
        ("Markdown escaped \\[K1\\].", [1]),
        ("A footnote [^K1].", [1]),
        ("Full-width K [Ｋ1].", [1]),
        ("Full-width all ［Ｋ１］.", [1]),
        ("Cyrillic K [К1].", [1]),
        ("Greek K [Κ1].", [1]),
        ("Spanish [K1 y K2].", [1, 2]),
        ("French [K1 et K2].", [1, 2]),
        ("German [K1 und K2].", [1, 2]),
        ("Russian [K1 и K2].", [1, 2]),
        ("Chinese [K1 和 K2].", [1, 2]),
        ("Chinese tight [K1和K2].", [1, 2]),
        ("Wave dash [K1〜K3].", [1, 2, 3]),
        ("Full-width tilde [K1～K3].", [1, 2, 3]),
        ("Spelled range [K1 to K3].", [1, 2, 3]),
        ("Arabic comma [K1، K2].", [1, 2]),
        ("German page [K1, S. 4].", [1]),
        ("Spanish page [K1, página 4].", [1]),
        ("Chinese page [K1, 第4页].", [1]),
        ("A diagram counts\n```aperture-diagram\n{\"title\": \"Fees [K2]\"}\n```\n", [2]),
        ("A mermaid diagram counts\n```mermaid\nA[K3] --> B\n```\n", [3]),
        ("A closing fence ends the code\n```\nx\n```\nClaim [K1].", [1]),
        ("Prose before inline code [K1] and `a sample` after.", [1]),
        ("Inline code `a sample` then prose [K2].", [2]),
        ("<think>Weighing the excerpts.</think>The holdback is twelve percent [K1].", [1]),
        ("An unclosed <think> is ordinary text [K1].", [1]),
    ],
)
def test_every_marker_form_real_models_write_is_understood(answer: str, kept: list[int]) -> None:
    assert _kept_knowledge(answer) == kept


@pytest.mark.parametrize(
    ("answer", "kept"),
    [
        ("A plain answer with no markers.", []),
        ("", []),
        ("Hallucinated [K9].", []),
        ("Real [K1] and invented [K9].", [1]),
        ("A range running past the end [K3-K9].", [3, 4]),
        ("A range entirely past the end [K7-K9].", []),
        ("A huge range [K2-K999999].", [2, 3, 4]),
        ("Zero is no chunk [K0].", []),
        ("Too many digits to be a chunk [K" + "9" * 5000 + "].", []),
        ("A word, not a marker [K8s].", []),
        ("A tax form in brackets [K1 statement for the partner].", []),
        ("A word that begins like a locator [K1 pageant].", []),
        ("A file named like prose [K1 statement.pdf].", []),
        ("A page word with nothing after it [K1 page].", []),
        ("A sheet of paper [K1 sheet].", []),
        ("A sheet of paper [K1 sheet of paper].", []),
        ("Lower case after an abbreviation [K1 s. corner parcel].", []),
        ("A dash before a file name [K1 - statement.pdf].", []),
        ("A list that only starts like one [K1, see the appendix].", []),
        ("A locator cannot smuggle a marker [K1, sheet K3].", [1]),
        ("Prose around a marker [see K1].", []),
        ("Lower case is not our label [k1].", []),
        ("<think>[K3] is the cafeteria, irrelevant.</think>A plain answer.", []),
        ("<THINKING>[K3]</THINKING><think>[K4]</think>A plain answer.", []),
        ("A fenced sample\n```python\nweights = [K1, K2]\n```\n", []),
        ("A tilde sample\n~~~\nweights = [K1]\n~~~\n", []),
        ("Inline `weights[K1]` code.", []),
        ("Inline ``a ` [K1]`` code.", []),
        ("A longer fence holds a shorter one\n````\n```\n[K1]\n```\n[K2]\n````\n", []),
        ("Unclosed fence\n```\n[K1]\n", []),
        ("Bare K1: and ^K1 and <K1> and [1].", []),
        ("A statement [K1 statement] and form [K2 form].", []),
        ("Bare K1 outside brackets.", []),
        ("Unclosed [K1 at the end of a line\nof text.", []),
    ],
)
def test_knowledge_fails_closed_and_unknown_numbers_are_dropped(
    answer: str, kept: list[int]
) -> None:
    assert _kept_knowledge(answer) == kept


@pytest.mark.parametrize(
    "text",
    [
        "[K1" + " " * 100_000,
        ("[K1" + " " * 5_000) * 20,
        "[K1" + " " * 50_000 + "," + " " * 50_000,
        "[K1" + " " * 50_000 + "-" + " " * 50_000 + "K",
        "[K1, p." + "x" * 100_000,
        "[" + "K1, " * 25_000,
        " " * 100_000 + "x",
        "[K1 " * 25_000,
        "[K1] " * 40_000,
        "claim [K1], " * 40_000,
        "`" + "x" * 100_000,
        "` " * 50_000,
        "```\n" * 25_000,
        "<think>" + " " * 100_000,
    ],
    ids=lambda text: repr(text[:12]),
)
def test_hostile_text_cannot_stall_the_marker_parser(text: str) -> None:
    def too_slow(*_args: object) -> None:
        raise TimeoutError("polynomial backtracking in the marker grammar")

    previous = signal.signal(signal.SIGALRM, too_slow)
    signal.setitimer(signal.ITIMER_REAL, 10)
    try:
        strip_citation_markers(text)
        citations_used(text, [_knowledge_citation(1)], chunk_texts={"chunk-1": _CHUNK})
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


_CHUNK = (
    "The northern boundary restates the recorded survey of the ledger. "
    "Fees are payable quarterly in arrears. "
    "The Osprey Landing culvert overflowed twice in April, closing the access road. "
    "Repairs were completed by the county in June."
)


def test_kept_knowledge_is_marked_cited_and_keeps_its_location() -> None:
    kept = citations_used("Grounded in [K1].", [_knowledge_citation(1)])

    assert kept[0].cited is True
    assert kept[0].document_id == "document-1"
    assert kept[0].knowledge_config_id == "knowledge-shared"


def test_the_decision_does_not_rewrite_the_turns_own_citations() -> None:
    supplied = [_knowledge_citation(1)]

    citations_used("Grounded in [K1].", supplied)

    assert supplied[0].cited is None


def test_web_lists_only_cited_results_when_the_reply_cites_any() -> None:
    supplied = [_web_citation(1), _web_citation(2), _web_citation(3)]

    kept = citations_used("From the web [W2].", supplied)

    assert [(citation.w_index, citation.cited) for citation in kept] == [(2, True)]


@pytest.mark.parametrize("answer", ["No web markers here.", "Only an invented one [W9]."])
def test_web_stays_as_consulted_when_the_reply_cites_none(answer: str) -> None:
    supplied = [_web_citation(1), _web_citation(2)]

    kept = citations_used(answer, supplied)

    assert [(citation.w_index, citation.cited) for citation in kept] == [(1, False), (2, False)]


def test_a_tax_form_in_brackets_is_not_a_web_citation() -> None:
    supplied = [_web_citation(1), _web_citation(2)]

    kept = citations_used("See [W2 form instructions].", supplied)

    assert [(citation.w_index, citation.cited) for citation in kept] == [(1, False), (2, False)]


def test_web_marker_forms_parse_like_knowledge_ones() -> None:
    supplied = [_web_citation(index) for index in (1, 2, 3, 4)]

    kept = citations_used("Sources [W1-W2] and [W4].", supplied)

    assert [citation.w_index for citation in kept] == [1, 2, 4]


def test_drafts_keep_every_web_result_but_still_say_which_were_cited() -> None:
    supplied = [_web_citation(1), _web_citation(2)]

    kept = citations_used("From the web [W2].", supplied, keep_consulted_web=True)

    assert [(citation.w_index, citation.cited) for citation in kept] == [(1, False), (2, True)]


def test_web_and_knowledge_are_decided_independently() -> None:
    supplied = [_knowledge_citation(1), _knowledge_citation(2), _web_citation(1), _web_citation(2)]

    kept = citations_used("Knowledge [K2], web [W1].", supplied)

    assert [(citation.id, citation.cited) for citation in kept] == [
        ("cite-chunk-2", True),
        ("cite-web-1", True),
    ]


def test_one_marker_group_can_cite_both_kinds() -> None:
    supplied = [_knowledge_citation(1), _web_citation(1), _web_citation(2)]

    kept = citations_used("Both [K1, W2].", supplied)

    assert [citation.id for citation in kept] == ["cite-chunk-1", "cite-web-2"]


def test_fetched_urls_stay_and_say_whether_the_reply_cited_them() -> None:
    supplied = [_fetched_citation(1), _fetched_citation(2)]

    kept = citations_used("From the page [U2].", supplied)

    assert [(citation.u_index, citation.cited) for citation in kept] == [(1, False), (2, True)]


def test_a_web_marker_does_not_remove_a_url_the_person_asked_to_read() -> None:
    supplied = [_fetched_citation(1), _web_citation(1), _web_citation(2)]

    kept = citations_used("From search [W1].", supplied)

    assert [(citation.id, citation.cited) for citation in kept] == [
        ("cite-fetch-1", False),
        ("cite-web-1", True),
    ]


def test_sources_with_no_marker_convention_stay_and_claim_nothing() -> None:
    kept = citations_used("An answer.", [_ATTACHMENT, _MCP_RESULT])

    assert [(citation.id, citation.cited) for citation in kept] == [
        ("cite-attachment", None),
        ("cite-mcp-1", None),
    ]


def test_provider_attributed_web_citation_is_cited_without_a_marker() -> None:
    annotation = {
        "type": "url_citation",
        "url_citation": {"url": "https://example.com/live", "title": "Live", "content": "Text."},
    }

    citation = chat_route._web_citation_from_annotation(annotation, 1)
    kept = citations_used("Answer with no bracket markers.", [citation])

    assert [(item.source_uri, item.cited) for item in kept] == [("https://example.com/live", True)]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Retention is seven years [K1].", "Retention is seven years."),
        ("Retention [K1, K2] is seven [W3] years.", "Retention is seven years."),
        ("Seven years.[K1] Next.", "Seven years. Next."),
        ("Line one [K1-K3]\nLine two [U1]", "Line one\nLine two"),
        ("No markers at all.", "No markers at all."),
        ("Keep [citation needed] and [K8s].", "Keep [citation needed] and [K8s]."),
        ("See [W2 form instructions] here.", "See [W2 form instructions] here."),
        ("Inline code stays: `data[K1]` and `row[W2]`.", "Inline code stays: `data[K1]` and `row[W2]`."),
        ("Seven years[K1].", "Seven years."),
        ("Claim [K1][K2].", "Claim."),
        ("Done.[K1][K2]", "Done."),
        ("Twelve percent (net)[K1].", "Twelve percent (net)."),
        ("押金为四十美元[K1]。", "押金为四十美元。"),
        ("押金[K1, K2]为【K3】四十美元。", "押金为四十美元。"),
        ("See [K1](https://x.test/a) for more.", "See for more."),
        ("A sentence [K1](https://x.test/a).", "A sentence."),
        ("An escaped marker \\[K1\\] goes too.", "An escaped marker goes too."),
        ("Prose data[K1] goes, it cannot be told apart.", "Prose data goes, it cannot be told apart."),
        ("```python\nweights = [K1, K2]\n```\nClaim [K1].", "```python\nweights = [K1, K2]\n```\nClaim."),
        ("~~~ts\nconst [K1, K2] = pair;\n~~~\n", "~~~ts\nconst [K1, K2] = pair;\n~~~\n"),
        ("```ts\nan unclosed fence [K1]", "```ts\nan unclosed fence [K1]"),
        ("Email:\n```\nThe deposit is forty dollars [K1].\n```", "Email:\n```\nThe deposit is forty dollars.\n```"),
        ("~~~\nThe deposit [K1].\n~~~\n", "~~~\nThe deposit.\n~~~\n"),
        ("```text\nThe deposit [K1].\n```", "```text\nThe deposit.\n```"),
        ("```txt\nThe deposit [K1].\n```", "```txt\nThe deposit.\n```"),
        ("```plaintext\nThe deposit [K1].\n```", "```plaintext\nThe deposit.\n```"),
        ("```markdown\nThe deposit [K1].\n```", "```markdown\nThe deposit.\n```"),
        ("```md\nThe deposit [K1].\n```", "```md\nThe deposit.\n```"),
        ("```\nan unclosed plain fence [K1]", "```\nan unclosed plain fence"),
        ("Call `foo([K1, K2])` here [K3].", "Call `foo([K1, K2])` here."),
        ("```mermaid\nA[K1] --> B\n```\n", "```mermaid\nA --> B\n```\n"),
        ("```aperture-diagram\n{\"title\": \"Fees [K1]\"}\n```", "```aperture-diagram\n{\"title\": \"Fees\"}\n```"),
    ],
)
def test_stale_markers_leave_earlier_replies_but_other_text_does_not(
    text: str, expected: str
) -> None:
    assert strip_citation_markers(text) == expected


# -- the real chat route, with only the provider stood in for ---------------

_BASE = "knowledge-box-matters"
_RELEVANT = "escrow-terms.txt"
_QUESTION = "What is the escrow holdback in the Harborview agreement?"
_EXCERPT_LINE = re.compile(r"^- \[K(\d+)\][^\n]*?: (.*)$", re.MULTILINE)
_Reply = Callable[[list[dict[str, object]], int], "tuple[str, str]"]


def _excerpts(messages: list[dict[str, object]]) -> dict[str, str]:
    return dict(_EXCERPT_LINE.findall(str(messages[0]["content"])))


def _grounded(messages: list[dict[str, object]], _call: int) -> tuple[str, str]:
    """A model that cites only the excerpts that really answer the question."""
    cited = [n for n, text in _excerpts(messages).items() if "holdback" in text.lower()]
    markers = "".join(f"[K{n}]" for n in cited)
    return f"The holdback is twelve percent {markers}.", "stop"


class _Provider:
    def __init__(self) -> None:
        self.reply: _Reply = _grounded
        self.calls: list[list[dict[str, object]]] = []
        self.annotations_for: Callable[[int], list[dict[str, object]]] = lambda _call: []

    def _next(self, messages: list[dict[str, object]]) -> tuple[str, str]:
        self.calls.append(messages)
        return self.reply(messages, len(self.calls))

    def complete(self, **kwargs: object) -> dict[str, object]:
        text, finish_reason = self._next(kwargs["messages"])  # type: ignore[arg-type]
        annotations = self.annotations_for(len(self.calls))
        message = {"role": "assistant", "content": text, "annotations": annotations}
        return {
            "id": "citation-route",
            "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
            "usage": {},
        }

    def generate_images(self, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs["messages"])  # type: ignore[arg-type]
        message = {"images": [{"image_url": {"url": "data:image/png;base64,AAAA"}}]}
        return {"choices": [{"message": message}], "usage": {}}

    def stream(self, _client: object, **kwargs: object) -> Iterator[str]:
        text, finish_reason = self._next(kwargs["messages"])  # type: ignore[arg-type]
        usage_sink = kwargs["usage_sink"]
        usage_sink["finish_reason"] = finish_reason  # type: ignore[index]
        usage_sink["annotations"] = self.annotations_for(len(self.calls))  # type: ignore[index]
        return iter([text])


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> _Provider:
    stub = _Provider()

    def tenant_route(*_args: object, tenant_id: str | None) -> ModelGatewayRoute:
        assert tenant_id == "tenant-example"
        return _route()

    monkeypatch.setattr(chat_route, "_resolve_gateway_route", tenant_route)
    monkeypatch.setattr(chat_route, "get_model_gateway_client", lambda: stub)
    monkeypatch.setattr(chat_route, "_gateway_stream", stub.stream)
    return stub


def _upload(name: str, text: str) -> None:
    response = client.post(
        f"/api/knowledge/{_BASE}/documents",
        headers={"x-aperture-user": "user-admin"},
        files=[("files", (name, BytesIO(text.encode()), "text/plain"))],
    )
    assert response.status_code == 200, response.text


@pytest.fixture
def base_with_one_relevant_document() -> None:
    _upload(
        _RELEVANT,
        "The Harborview purchase agreement sets an escrow holdback of twelve percent, "
        "released to the seller eighteen months after closing.",
    )
    _upload(
        "cafeteria-contract.txt",
        "The cafeteria agreement covers lentil soup on Mondays and grilled trout on Fridays.",
    )
    _upload(
        "parking-rules.txt",
        "The parking agreement sends visitors to lot C with a permit on the dashboard.",
    )


def _ask(mode: str, **body: object) -> list[dict[str, object]]:
    """The citations the person receives. The web client saves exactly these."""
    response = client.post(
        "/api/chat/complete",
        headers={"x-aperture-user": "user-admin"},
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": _QUESTION}],
            "knowledge_config_ids": [_BASE],
            **body,
            "stream": mode == "stream",
        },
    )
    assert response.status_code == 200, response.text
    if mode == "json":
        return response.json()["citations"]
    return next(
        event["citations"]
        for event in _sse_events(response.text)
        if isinstance(event, dict) and event.get("done")
    )


_MODES = ["json", "stream"]


def _document_ids() -> dict[str, str]:
    return {document.name: document.id for document in get_store().knowledge_documents_for(_BASE)}


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_only_the_document_the_reply_used_is_a_source(provider: _Provider, mode: str) -> None:
    citations = _ask(mode)

    supplied = _excerpts(provider.calls[0])
    assert len(supplied) == 3, "the unrelated documents must really reach the model"
    assert any("trout" in text for text in supplied.values())
    assert any("lot C" in text for text in supplied.values())
    assert [citation["source_name"] for citation in citations] == [_RELEVANT]
    assert citations[0]["cited"] is True
    assert citations[0]["document_id"] == _document_ids()[_RELEVANT]
    assert citations[0]["knowledge_config_id"] == _BASE
    assert citations[0]["k_index"] in {int(n) for n in supplied}


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_the_reply_carries_the_passage_it_used(provider: _Provider, mode: str) -> None:
    citation = _ask(mode)[0]

    assert citation["passage"] == (
        "The Harborview purchase agreement sets an escrow holdback of twelve percent"
    )


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_reply_with_no_markers_lists_no_knowledge_source(
    provider: _Provider, mode: str
) -> None:
    provider.reply = lambda _messages, _call: ("A plain answer.", "stop")

    assert _ask(mode) == []


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
@pytest.mark.parametrize(("marker", "count"), [("[K1, K2]", 2), ("[K1-K3]", 3), ("[K9]", 0)])
def test_marker_forms_reach_the_listed_sources(
    provider: _Provider, mode: str, marker: str, count: int
) -> None:
    provider.reply = lambda _messages, _call: (f"An answer {marker}.", "stop")

    assert len(_ask(mode)) == count


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_marker_that_arrives_in_a_continuation_still_counts(
    provider: _Provider, mode: str
) -> None:
    def in_two_parts(messages: list[dict[str, object]], call: int) -> tuple[str, str]:
        if call == 1:
            return "The holdback is", "length"
        return _grounded(messages, call)

    provider.reply = in_two_parts

    citations = _ask(mode)

    assert len(provider.calls) == 2
    assert [citation["source_name"] for citation in citations] == [_RELEVANT]


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_marker_in_an_early_segment_survives_a_later_one(provider: _Provider, mode: str) -> None:
    def in_two_parts(messages: list[dict[str, object]], call: int) -> tuple[str, str]:
        if call == 1:
            text, _reason = _grounded(messages, call)
            return text, "length"
        return "And that is the whole of it.", "stop"

    provider.reply = in_two_parts

    assert [c["source_name"] for c in _ask(mode)] == [_RELEVANT]


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_revised_reply_is_judged_on_the_revision_not_the_first_draft(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    issues = iter([["The answer is too thin."], []])
    monkeypatch.setattr(chat_route, "_completion_quality_issues", lambda *_a: next(issues))

    def revised(messages: list[dict[str, object]], call: int) -> tuple[str, str]:
        if call == 1:
            wrong = next(n for n, text in _excerpts(messages).items() if "trout" in text)
            return f"First draft from the wrong excerpt [K{wrong}].", "stop"
        return _grounded(messages, call)

    provider.reply = revised

    assert [c["source_name"] for c in _ask("json")] == [_RELEVANT]


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_resumed_stream_keeps_markers_from_the_text_before_the_drop(provider: _Provider) -> None:
    assert _ask("json"), "the attempt that dropped cited the relevant document"
    partial, _reason = _grounded(provider.calls[0], 1)
    provider.reply = lambda _messages, _call: ("And that is the whole of it.", "stop")

    citations = _ask(
        "stream",
        messages=[
            {"role": "user", "content": _QUESTION},
            {"role": "assistant", "content": partial},
            {"role": "user", "content": chat_route.CONTINUATION_PROMPT},
        ],
    )

    assert _excerpts(provider.calls[1]) == _excerpts(provider.calls[0])
    assert provider.calls[1][-2]["content"] == partial
    assert [c["source_name"] for c in citations] == [_RELEVANT]


def _user(text: str) -> dict[str, str]:
    return {"role": "user", "content": text}


def _assistant(text: str) -> dict[str, str]:
    return {"role": "assistant", "content": text}


def test_a_resume_is_recognized_only_by_its_exact_tail() -> None:
    continue_prompt = _user(chat_route.CONTINUATION_PROMPT)
    partial = _assistant("So far [K1]")

    assert chat_route._resumed_partial([_user("Q"), partial, continue_prompt]) == "So far [K1]"
    assert chat_route._resumed_partial([partial, continue_prompt]) == "So far [K1]"
    assert chat_route._resumed_partial([continue_prompt]) == ""
    assert chat_route._resumed_partial([_user("Q"), partial, _user("Thanks")]) == ""
    assert chat_route._resumed_partial([_user("Q"), _user(chat_route.CONTINUATION_PROMPT)]) == ""
    assert chat_route._resumed_partial([continue_prompt, partial, _assistant("Done")]) == ""


def test_a_resume_retrieves_for_the_question_it_is_finishing() -> None:
    messages = [
        _user("An earlier question"),
        _assistant("An earlier answer"),
        _user("The question being answered"),
        _assistant("So far"),
        _user(chat_route.CONTINUATION_PROMPT),
    ]

    assert chat_route._retrieval_question(messages) == "The question being answered"
    assert chat_route._retrieval_question(messages[:3]) == "The question being answered"


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_resume_does_not_judge_the_tail_against_the_whole_request(provider: _Provider) -> None:
    provider.reply = lambda _messages, _call: ("And that is the whole of it.", "stop")

    response = client.post(
        "/api/chat/complete",
        headers={"x-aperture-user": "user-admin"},
        json={
            "model": "gpt-4o-mini",
            "stream": True,
            "knowledge_config_ids": [_BASE],
            "messages": [
                {"role": "user", "content": "Cite your sources for the escrow holdback."},
                {"role": "assistant", "content": "The holdback is twelve percent."},
                {"role": "user", "content": chat_route.CONTINUATION_PROMPT},
            ],
        },
    )

    assert response.status_code == 200
    assert "Cite each claim with a source link" not in str(provider.calls[0][0]["content"])


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_generated_image_lists_no_retrieved_knowledge(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = get_store()
    image_model = _model().model_copy(
        update={
            "id": "model-image-test",
            "provider_id": "provider-openrouter",
            "upstream_model_id": "google/gemini-3.1-flash-image-preview",
            "group_ids": sorted({g for m in store.models.values() for g in m.group_ids}),
        }
    )
    store.models[image_model.id] = image_model
    monkeypatch.setattr(chat_route, "save_generated_image", lambda _url: "image.png")

    citations = _ask("json", model=image_model.id)

    assert _excerpts(provider.calls[0]), "retrieval must really have supplied excerpts"
    assert citations == []


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_follow_up_cannot_alias_a_number_from_the_earlier_turn(
    provider: _Provider, mode: str
) -> None:
    def echoes_history(messages: list[dict[str, object]], _call: int) -> tuple[str, str]:
        earlier = str(messages[-2]["content"])
        return (f"As I said: {earlier}", "stop")

    provider.reply = echoes_history

    citations = _ask(
        mode,
        messages=[
            {"role": "user", "content": "How much is the deposit?"},
            {"role": "assistant", "content": "The deposit is forty dollars [K1]."},
            {"role": "user", "content": _QUESTION},
        ],
    )

    assert provider.calls[0][-2]["content"] == "The deposit is forty dollars."
    assert citations == []


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_marker_restated_from_a_plain_fence_cannot_cite(provider: _Provider, mode: str) -> None:
    def lifts_it_out(messages: list[dict[str, object]], _call: int) -> tuple[str, str]:
        fenced = re.search(r"```\n(.*?)\n```", str(messages[-2]["content"]), re.DOTALL)
        return f"Rewritten: {fenced[1] if fenced else ''}", "stop"

    provider.reply = lifts_it_out

    citations = _ask(
        mode,
        messages=[
            {"role": "user", "content": "Draft an email about the deposit."},
            {"role": "assistant", "content": "Email:\n```\nThe deposit is forty dollars [K1].\n```"},
            {"role": "user", "content": _QUESTION},
        ],
    )

    assert citations == []


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_the_model_can_still_cite_this_turns_excerpts_on_a_follow_up(
    provider: _Provider, mode: str
) -> None:
    citations = _ask(
        mode,
        messages=[
            {"role": "user", "content": "How much is the deposit?"},
            {"role": "assistant", "content": "The deposit is forty dollars [K1]."},
            {"role": "user", "content": _QUESTION},
        ],
    )

    assert [c["source_name"] for c in citations] == [_RELEVANT]


def test_gateway_clients_keep_their_history_exactly_as_sent(provider: _Provider) -> None:
    provider.reply = lambda _messages, _call: ("An answer.", "stop")
    history = "The deposit is forty dollars [K1]."
    get_store().platform_settings.downstream_api_enabled = True

    response = client.post(
        "/v1/chat/completions",
        headers={"x-aperture-user": "user-owner"},
        json={
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "user", "content": "How much is the deposit?"},
                {"role": "assistant", "content": history},
                {"role": "user", "content": _QUESTION},
            ],
        },
    )

    assert response.status_code == 200, response.text
    assert [m["content"] for m in provider.calls[0] if m["role"] == "assistant"] == [history]


def test_drafts_keep_their_history_exactly_as_sent(provider: _Provider) -> None:
    provider.reply = lambda _messages, _call: ("An answer.", "stop")
    history = "The deposit is forty dollars [K1]."

    _ask(
        "json",
        surface="draft",
        messages=[
            {"role": "user", "content": "How much is the deposit?"},
            {"role": "assistant", "content": history},
            {"role": "user", "content": _QUESTION},
        ],
    )

    assert [m["content"] for m in provider.calls[0] if m["role"] == "assistant"] == [history]


class _WebResult:
    def __init__(self, index: int) -> None:
        self.title = f"Result {index}"
        self.url = f"https://example.com/{index}"
        self.snippet = f"Snippet {index}."


@pytest.fixture
def web_search(monkeypatch: pytest.MonkeyPatch) -> None:
    class Search:
        engine = "duckduckgo"
        api_key = None

        def search(self, _query: str) -> list[_WebResult]:
            return [_WebResult(1), _WebResult(2), _WebResult(3)]

    monkeypatch.setattr(chat_route, "web_search_client_from_config", lambda _settings: Search())


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("web_search")
def test_a_web_result_that_is_also_an_indexed_page_can_still_be_cited(
    provider: _Provider, mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    indexed = _chunk("chunk-indexed", "An indexed page.", ordinal=0).model_copy(
        update={"source_uri": "https://example.com/2", "source_type": "web"}
    )
    monkeypatch.setattr(
        type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [indexed]
    )
    provider.reply = lambda _messages, _call: ("From the web [W2].", "stop")

    citations = _ask(mode, web_enabled=True)

    assert [(c["w_index"], c["cited"]) for c in citations] == [(2, True)]


def _fixed_search(monkeypatch: pytest.MonkeyPatch, results: list[object]) -> None:
    class Search:
        engine = "duckduckgo"
        api_key = None

        def search(self, _query: str) -> list[object]:
            return results

    monkeypatch.setattr(chat_route, "web_search_client_from_config", lambda _settings: Search())


@pytest.mark.parametrize("mode", _MODES)
def test_a_cited_result_is_not_lost_to_a_duplicate_url(
    provider: _Provider, mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    duplicate = _WebResult(1)
    _fixed_search(monkeypatch, [_WebResult(1), duplicate, _WebResult(3)])
    provider.reply = lambda _messages, _call: ("From the web [W2].", "stop")

    citations = _ask(mode, knowledge_config_ids=[], web_enabled=True)

    labels = re.findall(r"^- \[W(\d+)\]", str(provider.calls[0][0]["content"]), re.MULTILINE)
    assert labels == ["1", "2"]
    assert [(c["source_uri"], c["w_index"], c["cited"]) for c in citations] == [
        ("https://example.com/3", 2, True)
    ]


@pytest.mark.parametrize("mode", _MODES)
def test_a_result_that_is_also_a_fetched_url_can_be_cited_either_way(
    provider: _Provider, mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fixed_search(monkeypatch, [_WebResult(1), _WebResult(2)])
    monkeypatch.setattr(
        chat_route,
        "fetch_web_source",
        lambda *_args, **_kwargs: FetchedWebSource(
            requested_url="https://example.com/1",
            final_url="https://example.com/1",
            filename="Fetched page",
            text="Body.",
            byte_count=5,
            content_type="text/html",
        ),
    )
    provider.reply = lambda _messages, _call: ("From the web [W1].", "stop")

    citations = _ask(
        mode,
        knowledge_config_ids=[],
        web_enabled=True,
        fetch_urls=["https://example.com/1"],
    )

    assert [(c["source_uri"], c["u_index"], c["w_index"], c["cited"]) for c in citations] == [
        ("https://example.com/1", 1, 1, True)
    ]


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("web_search")
def test_cited_web_results_are_the_only_ones_listed(provider: _Provider, mode: str) -> None:
    provider.reply = lambda _messages, _call: ("From the web [W2].", "stop")

    citations = _ask(mode, knowledge_config_ids=[], web_enabled=True)

    assert [(c["w_index"], c["cited"]) for c in citations] == [(2, True)]


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("web_search")
def test_uncited_web_results_stay_as_consulted(provider: _Provider, mode: str) -> None:
    provider.reply = lambda _messages, _call: ("An answer with no markers.", "stop")

    citations = _ask(mode, knowledge_config_ids=[], web_enabled=True)

    assert [(c["w_index"], c["cited"]) for c in citations] == [
        (1, False),
        (2, False),
        (3, False),
    ]


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("web_search")
def test_a_draft_keeps_its_whole_web_source_list(provider: _Provider, mode: str) -> None:
    provider.reply = lambda _messages, _call: ("From the web [W2].", "stop")

    citations = _ask(mode, knowledge_config_ids=[], web_enabled=True, surface="draft")

    assert [(c["w_index"], c["cited"]) for c in citations] == [
        (1, False),
        (2, True),
        (3, False),
    ]


_ANNOTATION = {
    "type": "url_citation",
    "url_citation": {"url": "https://example.com/a", "title": "A", "content": "Text."},
}


@pytest.mark.parametrize("mode", _MODES)
def test_provider_annotations_from_any_segment_are_kept(provider: _Provider, mode: str) -> None:
    provider.annotations_for = lambda call: [_ANNOTATION] if call == 1 else []
    provider.reply = lambda _messages, call: (
        ("First half", "length") if call == 1 else ("Second half.", "stop")
    )

    citations = _ask(mode, knowledge_config_ids=[])

    assert [(c["source_uri"], c["cited"]) for c in citations] == [("https://example.com/a", True)]


@pytest.mark.parametrize("mode", _MODES)
def test_sources_from_different_segments_keep_distinct_ids(provider: _Provider, mode: str) -> None:
    second = {
        "type": "url_citation",
        "url_citation": {"url": "https://example.com/b", "title": "B", "content": "Text."},
    }
    provider.annotations_for = lambda call: [_ANNOTATION] if call == 1 else [second]
    provider.reply = lambda _messages, call: (
        ("First half", "length") if call == 1 else ("Second half.", "stop")
    )

    citations = _ask(mode, knowledge_config_ids=[])

    assert [(c["id"], c["source_uri"]) for c in citations] == [
        ("cite-web-1", "https://example.com/a"),
        ("cite-web-2", "https://example.com/b"),
    ]


def test_a_revision_keeps_provider_sources_when_it_brought_none_of_its_own(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    issues = iter([["The answer is too thin."], []])
    monkeypatch.setattr(chat_route, "_completion_quality_issues", lambda *_a: next(issues))
    provider.annotations_for = lambda call: [_ANNOTATION] if call == 1 else []
    provider.reply = lambda _messages, call: ("First." if call == 1 else "Revised.", "stop")

    citations = _ask("json", knowledge_config_ids=[])

    assert [c["source_uri"] for c in citations] == ["https://example.com/a"]


def test_a_revision_that_brings_its_own_sources_replaces_the_first_drafts(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    replacement = {
        "type": "url_citation",
        "url_citation": {"url": "https://example.com/b", "title": "B", "content": "Text."},
    }
    issues = iter([["The answer is too thin."], []])
    monkeypatch.setattr(chat_route, "_completion_quality_issues", lambda *_a: next(issues))
    provider.annotations_for = lambda call: [_ANNOTATION] if call == 1 else [replacement]
    provider.reply = lambda _messages, call: ("First." if call == 1 else "Revised.", "stop")

    citations = _ask("json", knowledge_config_ids=[])

    assert [c["source_uri"] for c in citations] == ["https://example.com/b"]


def test_a_saved_thread_keeps_what_the_reply_returned() -> None:
    citation = _knowledge_citation(1).model_copy(update={"cited": True}).model_dump(mode="json")

    saved = client.put(
        "/api/chat/threads/thread-citation-fields",
        headers={"x-aperture-user": "user-jane"},
        json={
            "title": "Synthetic citation fields",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": "Grounded [K1].",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                    "citations": [citation],
                }
            ],
        },
    )

    assert saved.status_code == 200, saved.text
    assert saved.json()["messages"][0]["citations"] == [citation]


# -- a follow-up can still cite where its claim came from -------------------

_EARLIER_REPLY = "The holdback is twelve percent [K1]."


def _chunk_of(document_name: str) -> KnowledgeChunk:
    chunks = [
        chunk
        for chunk in get_store().knowledge_chunks_for(_BASE)
        if chunk.source_name == document_name
    ]
    return chunks[0]


def _saved_thread(*chunk_ids: str, reply: str = _EARLIER_REPLY, user: str = "user-admin") -> str:
    citations = [
        ChatCitation(
            id=f"cite-{chunk_id}",
            source_name="Forged name.pdf",
            source_type="upload",
            source_uri="upload://forged",
            snippet="Forged snippet.",
            chunk_id=chunk_id,
            k_index=1,
        ).model_dump(mode="json")
        for chunk_id in chunk_ids
    ]
    saved = client.put(
        "/api/chat/threads/thread-follow-up",
        headers={"x-aperture-user": user},
        json={
            "title": "Synthetic follow-up",
            "model_id": "gpt-4o-mini",
            "messages": [
                {
                    "id": "user-1",
                    "role": "user",
                    "content": _QUESTION,
                    "createdAt": "10:00 AM",
                    "status": "ok",
                },
                {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": reply,
                    "createdAt": "10:01 AM",
                    "status": "ok",
                    "citations": citations,
                },
            ],
        },
    )
    assert saved.status_code == 200, saved.text
    return saved.json()["id"]


def _follow_up(thread_id: str | None, mode: str = "json", **body: object) -> list[dict[str, object]]:
    return _ask(
        mode,
        thread_id=thread_id,
        messages=[
            {"role": "user", "content": _QUESTION},
            {"role": "assistant", "content": _EARLIER_REPLY},
            {"role": "user", "content": "Say that again in one sentence."},
        ],
        **body,
    )


def _cites_holdback(messages: list[dict[str, object]], _call: int) -> tuple[str, str]:
    return _grounded(messages, _call)


def _supplied(provider: _Provider) -> list[str]:
    return [text for text in _excerpts(provider.calls[-1]).values()]


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_follow_up_is_given_the_passage_the_last_reply_cited(
    provider: _Provider, mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    chunk = _chunk_of(_RELEVANT)
    thread_id = _saved_thread(chunk.id)
    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [])

    citations = _follow_up(thread_id, mode)

    assert any("escrow holdback" in text for text in _supplied(provider))
    assert [c["chunk_id"] for c in citations] == [chunk.id]
    assert citations[0]["k_index"] == 1
    assert citations[0]["document_id"] == chunk.document_id


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_follow_up_uses_the_latest_reply_with_that_text_and_the_last_reply_it_sent(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    newest = _chunk_of(_RELEVANT)
    older = _chunk_of("parking-rules.txt")
    thread_id = _saved_thread(newest.id)
    thread = get_store().chat_threads[thread_id]
    earliest = thread.messages[1].model_copy(
        update={
            "id": "assistant-0",
            "citations": [thread.messages[1].citations[0].model_copy(update={"chunk_id": older.id})],
        }
    )
    thread.messages.insert(0, earliest)
    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [])
    provider.reply = lambda _messages, _call: ("An answer.", "stop")

    _ask(
        "json",
        thread_id=thread_id,
        messages=[
            {"role": "assistant", "content": "A different, earlier reply."},
            {"role": "user", "content": _QUESTION},
            {"role": "assistant", "content": _EARLIER_REPLY},
            {"role": "user", "content": "Say that again."},
        ],
    )

    supplied = _supplied(provider)
    assert any("escrow holdback" in text for text in supplied)
    assert not any("lot C" in text for text in supplied)


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_carried_passage_comes_from_the_index_not_the_stored_citation(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    thread_id = _saved_thread(_chunk_of(_RELEVANT).id)
    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [])

    citations = _follow_up(thread_id)

    assert citations[0]["source_name"] == _RELEVANT
    assert "Forged" not in json.dumps(citations)


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_carried_passage_takes_this_turns_number_after_retrieval(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    retrieved = _chunk_of("parking-rules.txt")
    thread_id = _saved_thread(_chunk_of(_RELEVANT).id)
    monkeypatch.setattr(
        type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [retrieved]
    )
    provider.reply = lambda _messages, _call: ("From the second excerpt [K2].", "stop")

    citations = _follow_up(thread_id)

    assert [c["source_name"] for c in citations] == [_RELEVANT]
    assert citations[0]["k_index"] == 2
    assert "lot C" in _excerpts(provider.calls[0])["1"]


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_passage_retrieved_again_is_not_supplied_twice(provider: _Provider) -> None:
    thread_id = _saved_thread(_chunk_of(_RELEVANT).id)
    provider.reply = lambda _messages, _call: ("An answer.", "stop")

    _ask(
        "json",
        thread_id=thread_id,
        messages=[
            {"role": "user", "content": _QUESTION},
            {"role": "assistant", "content": _EARLIER_REPLY},
            {"role": "user", "content": _QUESTION},
        ],
    )

    assert sum("escrow holdback" in text for text in _supplied(provider)) == 1


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_nothing_is_carried_from_a_base_outside_this_turn(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    thread_id = _saved_thread(_chunk_of(_RELEVANT).id)
    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [])

    _follow_up(thread_id, knowledge_config_ids=[])

    assert _supplied(provider) == []


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_nothing_is_carried_past_an_ethical_wall(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    thread_id = _saved_thread(_chunk_of(_RELEVANT).id)
    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(chat_route, "knowledge_chunk_visible_to_user", lambda _actor, _chunk: False)

    _follow_up(thread_id)

    assert _supplied(provider) == []


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_nothing_is_carried_from_another_persons_thread(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    thread_id = _saved_thread(_chunk_of(_RELEVANT).id, user="user-jane")
    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [])

    _follow_up(thread_id)

    assert _supplied(provider) == []


@pytest.mark.parametrize(
    "scenario",
    ["no-thread", "unknown-thread", "draft", "other-reply", "first-turn"],
)
@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_nothing_is_carried_outside_a_chat_follow_up(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch, scenario: str
) -> None:
    thread_id = _saved_thread(_chunk_of(_RELEVANT).id)
    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [])
    earlier = [
        {"role": "user", "content": _QUESTION},
        {"role": "assistant", "content": _EARLIER_REPLY},
        {"role": "user", "content": "Say that again."},
    ]
    requests: dict[str, dict[str, object]] = {
        "no-thread": {"thread_id": None, "messages": earlier},
        "unknown-thread": {"thread_id": "thread-missing", "messages": earlier},
        "draft": {"thread_id": thread_id, "messages": earlier, "surface": "draft"},
        "other-reply": {
            "thread_id": thread_id,
            "messages": [earlier[0], {"role": "assistant", "content": "Other."}, earlier[2]],
        },
        "first-turn": {"thread_id": thread_id, "messages": earlier[-1:]},
    }

    _ask("json", **requests[scenario])

    assert _supplied(provider) == []


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_stored_citation_cannot_widen_a_turn_past_the_cap(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    chunk = _chunk_of(_RELEVANT)
    fetched: list[str] = []
    real = get_store().vector_store.chunk

    def counted(chunk_id: str) -> KnowledgeChunk | None:
        fetched.append(chunk_id)
        return real(chunk_id)

    monkeypatch.setattr(get_store().vector_store, "chunk", counted)
    forged = [f"chunk-forged-{number}" for number in range(40)]
    thread_id = _saved_thread(*forged, chunk.id, chunk.id, "live-abc")
    provider.reply = lambda _messages, _call: ("An answer.", "stop")

    _follow_up(thread_id)

    assert fetched == forged[: chat_route.MAX_CARRIED_CHUNKS]


@pytest.mark.usefixtures("base_with_one_relevant_document")
def test_a_resume_sees_the_same_carried_passage_as_the_attempt_that_dropped(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    thread_id = _saved_thread(_chunk_of(_RELEVANT).id)
    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", lambda *_args, **_kwargs: [])
    provider.reply = lambda _messages, _call: ("Partial.", "stop")

    _ask(
        "stream",
        thread_id=thread_id,
        messages=[
            {"role": "user", "content": "An earlier question."},
            {"role": "assistant", "content": "A different, earlier reply."},
            {"role": "user", "content": _QUESTION},
            {"role": "assistant", "content": _EARLIER_REPLY},
            {"role": "user", "content": "Say that again."},
            {"role": "assistant", "content": "Par"},
            {"role": "user", "content": chat_route.CONTINUATION_PROMPT},
        ],
    )

    assert any("escrow holdback" in text for text in _supplied(provider))


SSN = "123-45-6789"
_ADMIN = {"x-aperture-user": "user-admin"}
_ACCOUNT = f"Harborview account {SSN} holds the twelve percent escrow."


def _spoken(mode: str, **body: object) -> tuple[str, list[dict[str, object]]]:
    """What the person really received: the reply text and its citations."""
    response = client.post(
        "/api/chat/complete",
        headers=_ADMIN,
        json={
            "model": "gpt-4o-mini",
            "stream": mode == "stream",
            "knowledge_config_ids": [_BASE],
            "messages": [{"role": "user", "content": "What is the Harborview escrow account?"}],
            **body,
        },
    )
    assert response.status_code == 200, response.text
    if mode == "json":
        payload = response.json()
        return payload["choices"][0]["message"]["content"], payload["citations"]
    events = [event for event in _sse_events(response.text) if isinstance(event, dict)]
    text = "".join(str(event.get("delta", "")) for event in events)
    return text, next(event["citations"] for event in events if event.get("done"))


def _attach_filter(pattern: str, action: str, name: str = "Codename") -> None:
    created = client.post(
        "/api/admin/content-filters",
        headers=_ADMIN,
        json={
            "name": name,
            "description": "Synthetic output rule.",
            "rules": [
                {
                    "id": "rule-1",
                    "label": name,
                    "pattern": pattern,
                    "action": action,
                    "applies_to": "output",
                }
            ],
        },
    )
    assert created.status_code == 201, created.text
    attached = client.put(
        "/api/admin/model-access/gpt-4o-mini/content-filters",
        headers=_ADMIN,
        json={"content_filter_ids": [created.json()["id"]]},
    )
    assert attached.status_code == 200, attached.text


@pytest.mark.parametrize("mode", _MODES)
def test_a_withheld_reply_lists_nothing_and_returns_no_blocked_text(
    provider: _Provider, mode: str
) -> None:
    _upload("secret.txt", "The Harborview codename is BLUEHERON and the holdback is twelve percent.")
    _attach_filter("BLUEHERON", "block")
    provider.reply = lambda _messages, _call: ("The codename is BLUEHERON [K1].", "stop")

    reply, citations = _spoken(mode)

    assert "BLUEHERON" not in reply
    assert "Response withheld" in reply
    assert citations == []


@pytest.mark.parametrize("mode", _MODES)
def test_a_redaction_that_removes_a_marker_removes_its_source(
    provider: _Provider, mode: str
) -> None:
    _upload("secret.txt", "The Harborview holdback is twelve percent.")
    _attach_filter(r"\[K1\]", "redact")
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert citations == []


def test_requirement_checks_read_the_text_the_person_received(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    _attach_filter("BLUEHERON", "block")
    seen: list[str] = []

    def checks(_context: object, text: str) -> None:
        seen.append(text)

    monkeypatch.setattr(chat_route, "requirement_checks", checks)
    provider.reply = lambda _messages, _call: ("The codename is BLUEHERON.", "stop")

    reply, _citations = _spoken("stream", knowledge_config_ids=[])

    assert seen == [reply]
    assert "BLUEHERON" not in reply


@pytest.mark.parametrize("mode", _MODES)
def test_a_citation_never_shows_what_privacy_concealed(provider: _Provider, mode: str) -> None:
    _upload("secret.txt", _ACCOUNT)
    enable_privacy()
    provider.reply = lambda _messages, _call: (f"Account {SSN} holds the escrow [K1].", "stop")

    reply, citations = _spoken(mode)

    assert SSN not in reply
    assert [citation["source_name"] for citation in citations] == ["secret.txt"]
    assert SSN not in json.dumps(citations)
    assert citations[0]["passage"] is None, "a concealed passage is no longer verbatim"
    assert "⟦" in str(citations[0]["snippet"])


@pytest.mark.parametrize("mode", _MODES)
def test_a_citation_never_shows_what_a_redaction_removed(provider: _Provider, mode: str) -> None:
    _upload("secret.txt", _ACCOUNT)
    _attach_filter(SSN, "redact", name="Account number")
    provider.reply = lambda _messages, _call: ("The account holds the escrow [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert SSN not in json.dumps(citations)
    assert citations[0]["passage"] is None


@pytest.mark.parametrize("mode", _MODES)
def test_a_blocked_snippet_keeps_the_row_and_hides_the_text(provider: _Provider, mode: str) -> None:
    _upload("secret.txt", "The Harborview codename is BLUEHERON and the holdback is twelve percent.")
    _attach_filter("BLUEHERON", "block")
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert [citation["source_name"] for citation in citations] == ["secret.txt"]
    assert "BLUEHERON" not in json.dumps(citations)
    assert citations[0]["snippet"] == "[Withheld by content filter]"
    assert citations[0]["passage"] is None


@pytest.mark.parametrize("mode", _MODES)
def test_a_file_name_is_screened_like_the_text(provider: _Provider, mode: str) -> None:
    _upload(f"account {SSN}.txt", "The Harborview holdback is twelve percent.")
    enable_privacy()
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert SSN not in str(citations[0]["source_name"])


def _only_knowledge_chunk(monkeypatch: pytest.MonkeyPatch, **update: object) -> None:
    chunk = next(
        chunk
        for chunk in get_store().knowledge_chunks_for(_BASE)
        if chunk.source_name == "plain.txt"
    ).model_copy(update=update)
    monkeypatch.setattr(type(get_store()), "retrieve_knowledge", lambda *_a, **_k: [chunk])


@pytest.mark.parametrize("mode", _MODES)
def test_a_concealed_file_name_leaves_no_trace_in_the_address(
    provider: _Provider, mode: str
) -> None:
    _upload(f"Claimant {SSN} intake.txt", "The Harborview holdback is twelve percent.")
    enable_privacy()
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert SSN not in json.dumps(citations)
    assert citations[0]["source_uri"] == (
        f"knowledge://{citations[0]['knowledge_config_id']}/{citations[0]['document_id']}"
    )


@pytest.mark.parametrize("mode", _MODES)
def test_a_blocked_file_name_leaves_no_trace_in_any_field(provider: _Provider, mode: str) -> None:
    _upload("BLUEHERON closing memo.txt", "The Harborview holdback is twelve percent.")
    _attach_filter("BLUEHERON", "block")
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert "BLUEHERON" not in json.dumps(citations)
    assert citations[0]["document_id"], "the viewer still opens the document by id"


@pytest.mark.parametrize("mode", _MODES)
def test_a_locator_is_screened_like_the_text(
    provider: _Provider, mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _upload("plain.txt", "The Harborview holdback is twelve percent.")
    _only_knowledge_chunk(monkeypatch, locator=f"Sheet: Claimant {SSN}")
    enable_privacy()
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert SSN not in json.dumps(citations)
    assert str(citations[0]["locator"]).startswith("Sheet: Claimant ")


@pytest.mark.parametrize("mode", _MODES)
def test_an_address_nothing_hid_is_left_alone(provider: _Provider, mode: str) -> None:
    _upload("plain.txt", "The Harborview holdback is twelve percent.")
    enable_privacy()
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert str(citations[0]["source_uri"]).startswith("upload://")


def test_a_web_address_with_nothing_to_open_by_says_so_without_the_value() -> None:
    citation = _web_citation(1).model_copy(update={"source_uri": f"https://example.com/{SSN}"})

    screened = citation.model_copy(
        update=screened_fields(citation.model_dump(), lambda text: text.replace(SSN, "hidden"))
    )

    assert screened.source_uri == "withheld://cite-web-1"


def test_an_address_needs_both_ids_to_name_the_document() -> None:
    citation = {"id": "cite-1", "source_uri": f"upload://{SSN}", "knowledge_config_id": "base"}

    changed = screened_fields(citation, lambda text: text.replace(SSN, "hidden"))

    assert changed == {"source_uri": "withheld://cite-1"}


def test_every_text_field_of_a_citation_is_screened_except_identifiers() -> None:
    identifiers = {"id", "source_type", "chunk_id", "document_id", "knowledge_config_id"}
    text_fields = {
        name
        for name, value in ChatCitation(
            id="x", source_name="x", source_type="x", source_uri="x", snippet="x",
            locator="x", chunk_id="x", document_id="x", knowledge_config_id="x", passage="x",
        ).model_dump().items()
        if isinstance(value, str)
    }

    assert set(CITATION_TEXT_FIELDS) == text_fields - identifiers


def _padded(secret: str, start: int) -> str:
    head = ("word " * 200)[:start]
    return f"{head}{secret} and the holdback is twelve percent, which is the Harborview figure."


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.parametrize("start", [245, 247, 249, 250, 251, 253, 255, 256])
def test_a_concealed_value_on_the_snippet_cut_is_never_partly_shown(
    provider: _Provider, mode: str, start: int
) -> None:
    _upload("cut.txt", _padded(SSN, start))
    enable_privacy()
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert not re.search(r"123\D?45", str(citations[0]["snippet"]))
    assert "123" not in str(citations[0]["snippet"])


@pytest.mark.parametrize("mode", _MODES)
@pytest.mark.parametrize("start", [250, 252, 254])
def test_a_blocked_term_on_the_snippet_cut_is_never_partly_shown(
    provider: _Provider, mode: str, start: int
) -> None:
    _upload("cut.txt", _padded("BLUEHERONX", start))
    _attach_filter("BLUEHERONX", "block")
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert citations[0]["snippet"] == "[Withheld by content filter]"


@pytest.mark.parametrize("mode", _MODES)
def test_a_redaction_on_the_snippet_cut_is_never_partly_shown(
    provider: _Provider, mode: str
) -> None:
    _upload("cut.txt", _padded(SSN, 250))
    _attach_filter(SSN, "redact", name="Account number")
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken(mode)

    assert "123" not in str(citations[0]["snippet"])


def test_a_snippet_ends_on_a_whole_word() -> None:
    snippet = chat_route._citation_snippet(("word " * 51) + "unbrokenword" + " tail" * 20)

    assert snippet.endswith("word...")
    assert "unbrokenw" not in snippet
    assert len(snippet) <= 260


def test_a_snippet_of_one_long_token_is_still_cut() -> None:
    snippet = chat_route._citation_snippet("x" * 400)

    assert snippet == "x" * 257 + "..."


def test_a_short_snippet_is_left_whole() -> None:
    assert chat_route._citation_snippet("x" * 260) == "x" * 260


def test_a_dense_roster_cannot_pull_a_value_into_the_snippet(provider: _Provider) -> None:
    roster = " ".join(f"123-45-{number:04d}," for number in range(1000, 1040))
    _upload("roster.txt", f"{roster} and the holdback is twelve percent at Harborview.")
    enable_privacy()
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken("json")

    assert not re.search(r"\d{3}\D?\d{2}", str(citations[0]["snippet"]))


def test_a_block_rule_past_the_snippet_does_not_withhold_it(provider: _Provider) -> None:
    _upload("long.txt", ("word " * 200) + "BLUEHERONX and the holdback is twelve percent at Harborview.")
    _attach_filter("BLUEHERONX", "block")
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken("json")

    assert str(citations[0]["snippet"]).startswith("word word")
    assert "BLUE" not in json.dumps(citations)


def _web_results(monkeypatch: pytest.MonkeyPatch, snippet: str) -> None:
    result = _WebResult(1)
    result.snippet = snippet
    _fixed_search(monkeypatch, [result])


@pytest.mark.parametrize("mode", _MODES)
def test_a_web_result_is_screened_before_its_cut_too(
    provider: _Provider, mode: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _web_results(monkeypatch, _padded(SSN, 250))
    enable_privacy()
    provider.reply = lambda _messages, _call: ("From the web [W1].", "stop")

    _reply, citations = _spoken(mode, knowledge_config_ids=[], web_enabled=True)

    assert "123" not in str(citations[0]["snippet"])


def test_a_fetched_page_is_screened_before_its_cut_too(
    provider: _Provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        chat_route,
        "fetch_web_source",
        lambda *_args, **_kwargs: FetchedWebSource(
            requested_url="https://example.com/page",
            final_url="https://example.com/page",
            filename="Fetched page",
            text=_padded(SSN, 250),
            byte_count=5,
            content_type="text/html",
        ),
    )
    enable_privacy()
    provider.reply = lambda _messages, _call: ("From the page [U1].", "stop")

    _reply, citations = _spoken(
        "json", knowledge_config_ids=[], fetch_urls=["https://example.com/page"]
    )

    assert str(citations[0]["snippet"]).startswith("word word")
    assert "123" not in str(citations[0]["snippet"])


@pytest.mark.parametrize("mode", _MODES)
def test_a_provider_source_is_screened_before_its_cut_too(provider: _Provider, mode: str) -> None:
    enable_privacy()
    annotation = {
        "type": "url_citation",
        "url_citation": {
            "url": "https://example.com/a",
            "title": "A",
            "content": _padded(SSN, 250),
        },
    }
    provider.annotations_for = lambda _call: [annotation]
    provider.reply = lambda _messages, _call: ("An answer.", "stop")

    _reply, citations = _spoken(mode, knowledge_config_ids=[])

    assert "123" not in str(citations[0]["snippet"])


def test_an_uncut_source_never_reaches_the_audit_trail() -> None:
    audited = chat_route._audit_runtime_context({"citation_texts": {"cite-1": "Whole chunk."}})

    assert "citation_texts" not in audited


def test_an_unscreened_passage_is_left_alone_when_nothing_applies(provider: _Provider) -> None:
    _upload("plain.txt", "The Harborview holdback is twelve percent.")
    _attach_filter("BLUEHERON", "block")
    provider.reply = lambda _messages, _call: ("The holdback is twelve percent [K1].", "stop")

    _reply, citations = _spoken("json")

    assert citations[0]["passage"] == "The Harborview holdback is twelve percent."


def test_saving_a_thread_under_privacy_conceals_every_citation_field() -> None:
    enable_privacy()
    citation = ChatCitation(
        id="cite-1",
        source_name=f"Claimant {SSN}.xlsx",
        source_type="upload",
        source_uri=f"upload://knowledge/k/Claimant {SSN}.xlsx",
        snippet=f"Account {SSN}.",
        locator=f"Sheet: Claimant {SSN}",
        chunk_id="chunk-1",
        k_index=1,
        document_id="document-1",
        knowledge_config_id="knowledge-shared",
    ).model_dump(mode="json")

    saved = client.put(
        "/api/chat/threads/thread-citation-every-field",
        headers={"x-aperture-user": "user-jane"},
        json={
            "title": "Synthetic",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": "Grounded [K1].",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                    "citations": [citation],
                    "metadata": {
                        "responseVersions": [
                            {
                                "id": "version-1",
                                "label": "Version 1",
                                "content": "Grounded [K1].",
                                "citations": [citation, "not a citation"],
                            }
                        ]
                    },
                }
            ],
        },
    )

    assert saved.status_code == 200, saved.text
    stored = get_store().chat_threads["thread-citation-every-field"].messages[0]
    assert SSN not in json.dumps(stored.model_dump(mode="json"))
    assert stored.citations[0].source_uri == "knowledge://knowledge-shared/document-1"
    assert stored.citations[0].source_name.startswith("Claimant ")
    assert str(stored.citations[0].locator).startswith("Sheet: Claimant ")
    version = stored.metadata["responseVersions"][0]["citations"][0]
    assert version["source_uri"] == "knowledge://knowledge-shared/document-1"
    assert version["chunk_id"] == "chunk-1"


def test_saving_a_thread_under_privacy_conceals_the_passage() -> None:
    enable_privacy()
    citation = _knowledge_citation(1).model_copy(update={"cited": True, "passage": _ACCOUNT})

    saved = client.put(
        "/api/chat/threads/thread-citation-passage",
        headers={"x-aperture-user": "user-jane"},
        json={
            "title": "Synthetic",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "assistant-1",
                    "role": "assistant",
                    "content": "Grounded [K1].",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                    "citations": [citation.model_dump(mode="json")],
                }
            ],
        },
    )

    assert saved.status_code == 200, saved.text
    stored = get_store().chat_threads["thread-citation-passage"].messages[0].citations[0]
    assert SSN not in str(stored.passage)


# -- the prompt ------------------------------------------------------------


def _knowledge_prompt(**context: object) -> str:
    chunk = _chunk("chunk-one", "Retention is seven years.", ordinal=0)
    return chat_route._runtime_prompt(
        _model(),
        {
            "citations_enabled": True,
            "knowledge_hits": [chat_route._runtime_knowledge_hit(chunk, k_index=1)],
            **context,
        },
    )


def _web_prompt(**context: object) -> str:
    return chat_route._runtime_prompt(
        _model(),
        {
            "citations_enabled": True,
            "web_enabled": True,
            "web_search_engine": "duckduckgo",
            "web_results": [{"title": "Result", "url": "https://example.com", "snippet": "Text."}],
            **context,
        },
    )


def test_chat_prompt_tells_the_model_excerpts_may_be_irrelevant() -> None:
    prompt = _knowledge_prompt(surface="chat")

    assert "some may be irrelevant to the question" in prompt
    assert "never cite or mention an excerpt you did not use" in prompt
    assert "every claim that relies on an excerpt ends with its marker" in prompt
    assert "a marker appears only on a claim that excerpt supports" in prompt
    assert "If no excerpt is relevant, use no [K#] marker" in prompt


def test_chat_prompt_tells_the_model_to_cite_web_results_by_label() -> None:
    prompt = _web_prompt(surface="chat")

    assert "with its exact [W#] label" in prompt
    assert "cite only results you actually used" in prompt
    assert "cite the [W#] sources by URL" not in prompt


def test_chat_prompt_asks_for_markers_exactly_as_shown() -> None:
    prompt = _knowledge_prompt(surface="chat")

    assert "Write each marker exactly as shown, with nothing else inside the brackets." in prompt


def test_chat_prompt_says_what_to_do_with_a_restated_fact() -> None:
    prompt = _knowledge_prompt(surface="chat")

    assert "If you repeat a fact from an earlier reply" in prompt


def test_chat_prompt_keeps_sources_for_a_reply_that_is_only_a_diagram() -> None:
    prompt = _knowledge_prompt(surface="chat")

    assert "After a diagram or table with no prose, end with a line naming the markers used" in prompt


def test_the_citation_rule_is_repeated_after_the_excerpts() -> None:
    prompt = _knowledge_prompt(surface="chat")

    reminder = prompt.rindex("Reminder: end each claim that relies on an excerpt")
    assert reminder > prompt.rindex("Retention is seven years.")


def test_a_turn_with_no_excerpts_gets_no_citation_reminder() -> None:
    prompt = chat_route._runtime_prompt(_model(), {"citations_enabled": True, "surface": "chat"})

    assert "Reminder: end each claim" not in prompt


@pytest.mark.parametrize(
    ("context", "required"),
    [
        ({"surface": "chat", "citations_enabled": True}, "no"),
        ({"surface": "chat", "citations_enabled": False}, "no"),
        ({"surface": "draft", "citations_enabled": True}, "yes"),
        ({"surface": "draft", "citations_enabled": False}, "no"),
        ({"surface": "chat", "citations_enabled": True, "web_enabled": True}, "yes"),
        ({"surface": "chat", "citations_enabled": True, "attachment_names": ["a.txt"]}, "yes"),
        ({"surface": "chat", "citations_enabled": True, "fetched_urls": [{"u_index": 1}]}, "yes"),
        ({"surface": "chat", "citations_enabled": True, "mcp_tool_results": [{"status": "ready"}]}, "yes"),
    ],
)
def test_citations_are_required_only_when_there_is_something_to_cite(
    context: dict[str, object], required: str
) -> None:
    prompt = chat_route._runtime_prompt(_model(), context)

    assert f"- Citations required: {required}" in prompt


def test_citations_are_required_when_excerpts_were_supplied() -> None:
    assert "- Citations required: yes" in _knowledge_prompt(surface="chat")


def test_the_model_sees_the_end_of_a_full_size_chunk() -> None:
    tail = "The tail fact sits at the very end."
    chunk = _chunk("chunk-long", ("Filler words here. " * 60) + tail, ordinal=0)

    prompt = chat_route._runtime_prompt(
        _model(),
        {
            "citations_enabled": True,
            "knowledge_hits": [chat_route._runtime_knowledge_hit(chunk, k_index=1)],
        },
    )

    assert len(chunk.text) > 1000
    assert tail in prompt


def test_the_web_label_rule_needs_citations_turned_on() -> None:
    prompt = _web_prompt(surface="chat", citations_enabled=False)

    assert "with its exact [W#] label" not in prompt
    assert "cite the [W#] sources by URL" in prompt


def test_draft_prompt_keeps_its_citation_wording() -> None:
    knowledge = _knowledge_prompt(surface="draft")
    web = _web_prompt(surface="draft")

    assert (
        "- Knowledge citations: cite grounded claims inline with the exact [K#] "
        "label shown below (for example, [K1]); do not renumber or invent sources." in knowledge
    )
    assert "some may be irrelevant" not in knowledge
    assert "trust them for anything recent and cite the [W#] sources by URL." in web
    assert "with its exact [W#] label" not in web


@pytest.mark.parametrize(
    "reply",
    [
        "Grounded [K1, K2].",
        "Grounded [K1-K3].",
        "Grounded 【K1】.",
        "Grounded [W1].",
        "Grounded [U1].",
        "Grounded [K1].",
        "Grounded [M1].",
        "See https://example.com/a for it.",
        "See [the page](/a) for it.",
    ],
)
def test_the_cite_sources_requirement_understands_every_marker_form(reply: str) -> None:
    directive = Directive(id="citations", label="Cite sources", instruction="Cite.")

    assert directive_results([directive], reply) == [("citations", "Cite sources", True)]


def test_the_cite_sources_requirement_still_fails_a_reply_with_no_source() -> None:
    directive = Directive(id="citations", label="Cite sources", instruction="Cite.")

    assert directive_results([directive], "A plain answer.") == [("citations", "Cite sources", False)]


# -- rolling back past a schema addition ------------------------------------


def _stored_message(**extra: object) -> dict[str, object]:
    return {
        "id": "assistant-1",
        "role": "assistant",
        "content": "Grounded [K1].",
        "createdAt": "10:00 AM",
        "status": "ok",
        **extra,
    }


_CITATION_ROW = {
    "id": "cite-1",
    "source_name": "Source",
    "source_type": "upload",
    "source_uri": "upload://one",
    "snippet": "Passage.",
}


def test_a_row_written_by_a_newer_version_still_loads() -> None:
    row = [
        _stored_message(
            field_from_the_future=True,
            citations=[{**_CITATION_ROW, "field_from_the_future": 1}],
            activityTrace=[{"id": "step", "label": "Read", "field_from_the_future": 2}],
            attachments=[
                {
                    "id": "file",
                    "name": "a.txt",
                    "kind": "Text",
                    "size": "1 B",
                    "field_from_the_future": 3,
                }
            ],
        )
    ]

    loaded = StrictChatMessagesJSON().process_result_value(row, sqlite.dialect())

    assert loaded is not None
    assert "field_from_the_future" not in loaded[0]
    assert loaded[0]["citations"][0]["id"] == "cite-1"
    assert "field_from_the_future" not in loaded[0]["citations"][0]
    assert "field_from_the_future" not in loaded[0]["activityTrace"][0]
    assert "field_from_the_future" not in loaded[0]["attachments"][0]


def test_dropping_a_stored_field_is_never_silent(caplog: pytest.LogCaptureFixture) -> None:
    decorator = StrictChatMessagesJSON()

    with caplog.at_level(logging.WARNING, logger="app.db.orm"):
        decorator.process_result_value([_stored_message()], sqlite.dialect())
        assert caplog.text == ""
        decorator.process_result_value([_stored_message(future=True)], sqlite.dialect())

    assert "ChatMessage fields this version does not know" in caplog.text


def test_writing_a_row_stays_strict() -> None:
    row = [_stored_message(citations=[{**_CITATION_ROW, "field_from_the_future": 1}])]

    with pytest.raises(ValueError, match="unknown ChatCitation fields"):
        StrictChatMessagesJSON().process_bind_param(row, sqlite.dialect())


@pytest.mark.parametrize("value", ["not a list", ["not an object"]])
def test_a_malformed_row_is_still_refused_on_read(value: object) -> None:
    with pytest.raises(ValueError):
        StrictChatMessagesJSON().process_result_value(value, sqlite.dialect())


def test_a_row_with_no_nested_lists_loads_unchanged() -> None:
    row = [_stored_message()]

    loaded = StrictChatMessagesJSON().process_result_value(row, sqlite.dialect())

    assert loaded is not None and loaded[0]["id"] == "assistant-1"
