"""Uploads keep file properties, apply ethical walls, and read handwriting with AI."""

from __future__ import annotations

import zipfile
from io import BytesIO
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.models.schemas import Group, ModelConfig
from app.repositories.deps import get_store

client = TestClient(app)
CONFIG = "knowledge-box-matters"
_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _docx(custom: dict[str, str]) -> bytes:
    properties = "".join(
        f'<property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="{index + 2}" '
        f'name="{name}"><vt:lpwstr>{value}</vt:lpwstr></property>'
        for index, (name, value) in enumerate(custom.items())
    )
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "word/document.xml",
            f"<w:document {_W}><w:body><w:p><w:r><w:t>Osprey valuation is 42 million."
            "</w:t></w:r></w:p></w:body></w:document>",
        )
        archive.writestr(
            "docProps/core.xml",
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Osprey valuation memo</dc:title>'
            "<dc:creator>Avery Example</dc:creator></cp:coreProperties>",
        )
        archive.writestr(
            "docProps/custom.xml",
            '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" '
            'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
            f"{properties}</Properties>",
        )
    return buffer.getvalue()


def _upload(name: str, content: bytes, mime: str, user: str = "user-admin") -> httpx.Response:
    return client.post(
        f"/api/knowledge/{CONFIG}/documents",
        headers=headers(user),
        files=[("files", (name, BytesIO(content), mime))],
    )


def _uploaded(response: httpx.Response, name: str) -> dict[str, Any]:
    assert response.status_code == 200, response.text
    return next(item for item in response.json()["documents"] if item["name"] == name)


def _chunks(document_id: str) -> list[Any]:
    return [
        chunk
        for chunk in get_store().knowledge_chunks_for(CONFIG)
        if chunk.document_id == document_id
    ]


def test_upload_keeps_file_properties_and_makes_them_searchable() -> None:
    response = _upload(
        "osprey.docx",
        _docx({"Matter number": "20419"}),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    document = _uploaded(response, "osprey.docx")
    assert document["metadata"]["Title"] == "Osprey valuation memo"
    assert document["metadata"]["Author"] == "Avery Example"
    assert document["metadata"]["Matter number"] == "20419"
    assert document["metadata"]["Uploaded by"]
    chunks = _chunks(document["id"])
    card = [chunk for chunk in chunks if chunk.locator == "Document properties"]
    assert card and "Matter number: 20419" in card[0].text
    assert all(
        chunk.source_details and chunk.source_details.startswith("Title: Osprey valuation memo · Author: Avery Example")
        for chunk in chunks
    )
    store = get_store()
    hits = store.retrieve_knowledge(store.users["user-jane"], [CONFIG], "matter 20419", limit=3)
    assert hits and hits[0].document_id == document["id"]


def test_ethical_wall_property_hides_the_upload_from_people_outside_it() -> None:
    store = get_store()
    store.groups["group-osprey"] = Group(
        id="group-osprey",
        tenant_id="tenant-example",
        name="Osprey deal team",
        distinguished_name="CN=Osprey deal team",
        entra_object_id="group-osprey",
    )
    response = _upload(
        "osprey.docx",
        _docx({"Ethical wall": "Osprey deal team"}),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    document = _uploaded(response, "osprey.docx")
    assert document["wall"]["group_ids"] == ["group-osprey"]
    jane = store.users["user-jane"]
    assert not store.retrieve_knowledge(jane, [CONFIG], "Osprey valuation", limit=10) or all(
        hit.document_id != document["id"]
        for hit in store.retrieve_knowledge(jane, [CONFIG], "Osprey valuation", limit=10)
    )
    jane.group_ids = [*jane.group_ids, "group-osprey"]
    hits = store.retrieve_knowledge(jane, [CONFIG], "Osprey valuation", limit=10)
    assert any(hit.document_id == document["id"] for hit in hits)


# ------------------------------------------------------------- AI page reading


def _vision_model() -> ModelConfig:
    return ModelConfig(
        id="model-vision-test",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Gemini Flash Test",
        upstream_model_id="google/gemini-3.5-flash",
    )


def _activate(model: ModelConfig) -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    store.models[model.id] = model
    store.create_provider_key(
        key_id="key-provider-openrouter-vision",
        provider=provider,
        name=f"{provider.name} Vision Key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="openrouter-vision-test-key",
    )


def _gateway(text: str, seen: list[dict[str, Any]]) -> ModelGatewayClient:
    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "gen-vision",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 900, "completion_tokens": 30, "total_tokens": 930},
            },
        )

    return ModelGatewayClient(transport=httpx.MockTransport(handler))


def _scanned_pdf() -> bytes:
    buffer = BytesIO()
    Image.effect_noise((600, 800), 60).convert("RGB").save(buffer, format="PDF")
    return buffer.getvalue()


def test_scanned_pdf_upload_is_read_by_the_workspace_vision_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _activate(_vision_model())
    seen: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "app.core.vision_ocr.get_model_gateway_client",
        lambda: _gateway("Handwritten: settle at 1.2M - AE", seen),
    )
    document = _uploaded(_upload("note.pdf", _scanned_pdf(), "application/pdf"), "note.pdf")
    chunks = _chunks(document["id"])
    assert any("settle at 1.2M" in chunk.text for chunk in chunks)
    assert seen and seen[0]["model"] == "google/gemini-3.5-flash"
    message = get_store().knowledge_configs[CONFIG].settings["provider_message"]
    assert "Gemini Flash Test read handwriting" in message
    usage = [record for record in get_store().usage_records if record.surface == "knowledge-ocr"]
    assert usage and usage[-1].model_id == "model-vision-test"


def test_knowledge_base_can_keep_pages_off_the_model(monkeypatch: pytest.MonkeyPatch) -> None:
    _activate(_vision_model())
    seen: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "app.core.vision_ocr.get_model_gateway_client", lambda: _gateway("never", seen)
    )
    monkeypatch.setattr(
        "app.core.knowledge_ingestion._ocr_image", lambda *_args, **_kwargs: "Tesseract read this."
    )
    config = get_store().knowledge_configs[CONFIG]
    config.settings = {**config.settings, "vision_ocr": False}
    document = _uploaded(_upload("note.pdf", _scanned_pdf(), "application/pdf"), "note.pdf")
    assert seen == []
    assert any("Tesseract read this." in chunk.text for chunk in _chunks(document["id"]))


def test_without_a_vision_model_uploads_use_standard_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.core.knowledge_ingestion._ocr_image", lambda *_args, **_kwargs: "Tesseract read this."
    )
    document = _uploaded(_upload("note.pdf", _scanned_pdf(), "application/pdf"), "note.pdf")
    assert any("Tesseract read this." in chunk.text for chunk in _chunks(document["id"]))


def test_limits_report_the_page_reading_model() -> None:
    _activate(_vision_model())
    limits = client.get("/api/knowledge/limits", headers=headers()).json()
    assert limits["vision_ocr"] == {
        "available": True,
        "model_name": "Gemini Flash Test",
        "max_pages": 60,
    }


def test_properties_passage_lists_descriptive_fields_and_yields_to_content() -> None:
    from app.core.knowledge_ingestion import ExtractedSegment
    from app.routes import knowledge as knowledge_route

    store = get_store()
    config = store.knowledge_configs[CONFIG]
    memo, memo_chunks = knowledge_route._document_from_segments(
        config,
        name="memo.docx",
        source_type="upload",
        source_uri="upload://memo.docx",
        segments=[ExtractedSegment(text="Jordan Sample: Confirm escrow percentage with the client.")],
        synced_at="now",
        metadata={"Title": "Deal memo", "File size": "2 KB", "Uploaded by": "Alex Morgan"},
    )
    agreement, agreement_chunks = knowledge_route._document_from_segments(
        config,
        name="signed-escrow-agreement.pdf",
        source_type="upload",
        source_uri="upload://signed-escrow-agreement.pdf",
        segments=[ExtractedSegment(text="Clause 4 releases funds after ninety days.")],
        synced_at="now",
        metadata={"Title": "Escrow agreement", "Page count": "1", "File size": "12 KB"},
    )
    card = next(chunk for chunk in agreement_chunks if chunk.locator == "Document properties")
    assert card.text == "Document properties:\n\nTitle: Escrow agreement"
    store.append_knowledge_sources(
        config,
        [memo, agreement],
        [*memo_chunks, *agreement_chunks],
        synced_at="now",
        provider_status="live",
        provider_message="seeded",
    )
    hits = store.retrieve_knowledge(store.users["user-jane"], [CONFIG], "escrow percentage", limit=3)
    assert hits[0].document_id == memo.id
    assert hits[0].locator is None


def test_upload_facts_alone_add_no_properties_passage() -> None:
    from app.core.knowledge_ingestion import ExtractedSegment
    from app.routes import knowledge as knowledge_route

    config = get_store().knowledge_configs[CONFIG]
    _document, chunks = knowledge_route._document_from_segments(
        config,
        name="notes.txt",
        source_type="upload",
        source_uri="upload://notes.txt",
        segments=[ExtractedSegment(text="Plain notes.")],
        synced_at="now",
        metadata={"File size": "1 KB", "Uploaded by": "Alex Morgan", "Uploaded": "now"},
    )
    assert [chunk.locator for chunk in chunks] == [None]
    assert chunks[0].source_details is None


class _FakeUsageContext:
    def __init__(self) -> None:
        self.status = "active"
        self.settled_child_count = 0
        self.calls: list[str] = []

    def fail(self) -> None:
        self.calls.append("fail")
        self.status = "failed"

    def abandon(self) -> None:
        self.calls.append("abandon")
        self.status = "abandoned"

    def complete_success(self) -> None:
        self.calls.append("complete")
        self.status = "completed"


def _usage_with_context() -> tuple[Any, _FakeUsageContext]:
    from app.routes import knowledge as knowledge_route

    context = _FakeUsageContext()
    usage = knowledge_route._LazyUsage(lambda: context)
    usage.get()
    return usage, context


def test_metered_upload_abandons_an_unused_request_on_success() -> None:
    from app.routes import knowledge as knowledge_route

    usage, context = _usage_with_context()
    with knowledge_route._metered_upload(usage):
        pass
    assert context.calls == ["abandon"]


def test_metered_upload_maps_transcription_failures_and_fails_the_request() -> None:
    from fastapi import HTTPException

    from app.core.media_transcription import MediaTranscriptionError
    from app.routes import knowledge as knowledge_route

    usage, context = _usage_with_context()
    with pytest.raises(HTTPException) as raised:
        with knowledge_route._metered_upload(usage):
            raise MediaTranscriptionError("No model can transcribe this.", status_code=503)
    assert raised.value.status_code == 503
    assert raised.value.detail == "No model can transcribe this."
    assert context.calls == ["fail"]


def test_metered_upload_maps_budget_errors() -> None:
    from fastapi import HTTPException

    from app.core.usage_budget import UsageBudgetUnavailable
    from app.routes import knowledge as knowledge_route

    usage, context = _usage_with_context()
    with pytest.raises(HTTPException) as raised:
        with knowledge_route._metered_upload(usage):
            raise UsageBudgetUnavailable("accounting offline")
    assert raised.value.status_code >= 400
    assert context.calls == ["fail"]


def test_metered_upload_reraises_other_errors_after_failing_the_request() -> None:
    from app.routes import knowledge as knowledge_route

    usage, context = _usage_with_context()
    with pytest.raises(RuntimeError, match="disk full"):
        with knowledge_route._metered_upload(usage):
            raise RuntimeError("disk full")
    assert context.calls == ["fail"]


def test_metered_upload_without_a_request_does_nothing() -> None:
    from app.routes import knowledge as knowledge_route

    usage = knowledge_route._LazyUsage(lambda: _FakeUsageContext())
    with pytest.raises(RuntimeError):
        with knowledge_route._metered_upload(usage):
            raise RuntimeError("boom")
    assert usage.context is None


def test_upload_note_reports_pages_the_model_could_not_read(monkeypatch: pytest.MonkeyPatch) -> None:
    _activate(_vision_model())

    class Flaky:
        def complete(self, **_kwargs: Any) -> dict[str, Any]:
            raise RuntimeError("socket closed")

    monkeypatch.setattr("app.core.vision_ocr.get_model_gateway_client", lambda: Flaky())
    monkeypatch.setattr("app.core.knowledge_ingestion._ocr_image", lambda *_a, **_k: "Tesseract read this.")
    _uploaded(_upload("note.pdf", _scanned_pdf(), "application/pdf"), "note.pdf")
    message = get_store().knowledge_configs[CONFIG].settings["provider_message"]
    assert "Gemini Flash Test could not read 1 page of note.pdf; standard OCR was used for it." in message
