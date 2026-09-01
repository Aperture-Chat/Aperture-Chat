from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayClient, ModelGatewayRoute
from app.main import app
from app.models.schemas import ChatCitation, KnowledgeChunk, ModelConfig
from app.repositories.deps import get_store
from app.routes import chat as chat_route


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
                        "content": "Grounded answer.",
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
        return iter(["Grounded answer."])

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
