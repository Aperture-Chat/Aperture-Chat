"""The document viewer's four routes: who gets in, and what comes back."""

from __future__ import annotations

import io
from collections.abc import Iterator

import pikepdf
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfWriter

from app.core.knowledge_originals import DocumentRef, KnowledgeOriginalStore
from app.main import app
from app.models.schemas import (
    Group,
    KnowledgeChunk,
    KnowledgeConfig,
    KnowledgeDocument,
    KnowledgeDocumentWall,
    Role,
    User,
)
from app.repositories.deps import get_store

client = TestClient(app)

CONFIG_ID = "knowledge-viewer-test"
TENANT_ID = "tenant-example"
OPEN_DOC = "doc-open"
WALLED_DOC = "doc-walled"
OPEN_CHUNK = f"chunk-{OPEN_DOC}-2"
WALLED_CHUNK = f"chunk-{WALLED_DOC}-1"
BASE = f"/api/knowledge/{CONFIG_ID}/documents"

ROUTES = ("view", "file", "original", "location")
DOCUMENT_ROUTES = ("view", "file", "original")


def _route(kind: str, document_id: str = OPEN_DOC, chunk_id: str = OPEN_CHUNK) -> str:
    return {
        "view": f"{BASE}/{document_id}/view",
        "file": f"{BASE}/{document_id}/view/file",
        "original": f"{BASE}/{document_id}/original",
        "location": f"/api/knowledge/chunks/{chunk_id}/location",
    }[kind]


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _pdf(pages: int) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (10, 20, 30)).save(buffer, "PNG")
    return buffer.getvalue()


def _document(document_id: str, name: str, **updates: object) -> KnowledgeDocument:
    values: dict[str, object] = {
        "id": document_id,
        "knowledge_config_id": CONFIG_ID,
        "tenant_id": TENANT_ID,
        "name": name,
        "source_uri": f"upload://knowledge/{CONFIG_ID}/{name}",
        "source_type": "upload",
        "chunk_count": 2,
        "acl_group_ids": ["group-litigation"],
        "updated_at": "now",
    }
    values.update(updates)
    return KnowledgeDocument(**values)


def _chunk(document_id: str, ordinal: int, text: str, **updates: object) -> KnowledgeChunk:
    values: dict[str, object] = {
        "id": f"chunk-{document_id}-{ordinal + 1}",
        "knowledge_config_id": CONFIG_ID,
        "document_id": document_id,
        "tenant_id": TENANT_ID,
        "source_name": document_id,
        "source_uri": "upload://x",
        "source_type": "upload",
        "text": text,
        "ordinal": ordinal,
        "acl_group_ids": ["group-litigation"],
        "updated_at": "now",
    }
    values.update(updates)
    return KnowledgeChunk(**values)


@pytest.fixture
def store(tmp_path) -> Iterator[object]:
    get_store.cache_clear()
    seeded = get_store()
    seeded.knowledge_originals = KnowledgeOriginalStore(tmp_path / "originals")
    seeded.groups["group-falcon"] = Group(
        id="group-falcon",
        tenant_id=TENANT_ID,
        name="Project Falcon",
        distinguished_name="CN=Project Falcon",
        entra_object_id="group-falcon",
    )
    seeded.knowledge_configs[CONFIG_ID] = KnowledgeConfig(
        id=CONFIG_ID,
        tenant_id=TENANT_ID,
        name="Viewer test",
        source_type="upload",
        enabled=True,
        acl_group_ids=["group-litigation"],
    )
    wall = KnowledgeDocumentWall(source="manual", group_ids=["group-falcon"])
    documents = [
        _document(OPEN_DOC, "survey.pdf"),
        _document(WALLED_DOC, "falcon.pdf", wall=wall),
    ]
    chunks = [
        _chunk(OPEN_DOC, 0, "Page one words.", page_start=1, page_end=1, locator="Page 1"),
        _chunk(OPEN_DOC, 1, "The cited words.", page_start=2, page_end=3, locator="Page 2"),
        _chunk(WALLED_DOC, 0, "Walled words.", page_start=1, page_end=1, locator="Page 1"),
    ]
    seeded.knowledge_documents[CONFIG_ID] = documents
    seeded.knowledge_chunks[CONFIG_ID] = chunks
    seeded.vector_store.replace_config(CONFIG_ID, documents, chunks)
    seeded.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, OPEN_DOC), _pdf(3))
    seeded.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, WALLED_DOC), _pdf(1))
    yield seeded
    get_store.cache_clear()


def _add_document(store, document_id: str, name: str, chunks: list[KnowledgeChunk]) -> None:
    document = _document(document_id, name, chunk_count=len(chunks))
    store.knowledge_documents[CONFIG_ID].append(document)
    store.knowledge_chunks[CONFIG_ID].extend(chunks)
    store.vector_store.upsert_sources([document], chunks)


def _join_falcon(store, user_id: str) -> None:
    store.users[user_id].group_ids = [*store.users[user_id].group_ids, "group-falcon"]


# ------------------------------------------------------------- authorization


@pytest.mark.parametrize("route", DOCUMENT_ROUTES)
@pytest.mark.parametrize("user_id", ["user-jane", "user-admin", "user-owner"])
def test_wall_hides_a_document_from_every_role(store, route: str, user_id: str) -> None:
    walled = client.get(_route(route, WALLED_DOC), headers=headers(user_id))
    missing = client.get(_route(route, "doc-that-never-existed"), headers=headers(user_id))
    assert walled.status_code == 404
    assert walled.json() == missing.json()


@pytest.mark.parametrize("user_id", ["user-jane", "user-admin", "user-owner"])
def test_wall_hides_the_location_of_a_chunk_from_every_role(store, user_id: str) -> None:
    walled = client.get(_route("location", chunk_id=WALLED_CHUNK), headers=headers(user_id))
    missing = client.get(_route("location", chunk_id="chunk-unknown"), headers=headers(user_id))
    assert walled.status_code == 404
    assert walled.json() == missing.json()


@pytest.mark.parametrize("route", DOCUMENT_ROUTES)
def test_wall_member_gets_in(store, route: str) -> None:
    _join_falcon(store, "user-jane")
    assert client.get(_route(route, WALLED_DOC), headers=headers("user-jane")).status_code == 200


def test_wall_member_finds_the_chunk(store) -> None:
    _join_falcon(store, "user-jane")
    response = client.get(_route("location", chunk_id=WALLED_CHUNK), headers=headers("user-jane"))
    assert response.status_code == 200
    assert response.json() == {"knowledge_config_id": CONFIG_ID, "document_id": WALLED_DOC}


def _same_as_a_missing_base(route: str, response: object, user_id: str) -> None:
    """Every refusal by the base reads the same, so a config id proves nothing."""
    missing = client.get(_route(route).replace(CONFIG_ID, "knowledge-missing"), headers=headers(user_id))
    assert response.status_code == 404
    if route != "location":
        assert response.json() == missing.json()


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("user_id", ["user-jane", "user-admin", "user-owner"])
def test_disabled_base_is_closed_even_to_operators(store, route: str, user_id: str) -> None:
    store.knowledge_configs[CONFIG_ID].enabled = False
    _same_as_a_missing_base(route, client.get(_route(route), headers=headers(user_id)), user_id)


@pytest.mark.parametrize("route", ROUTES)
def test_user_outside_the_base_sharing_is_refused(store, route: str) -> None:
    response = client.get(_route(route), headers=headers("user-maya"))
    _same_as_a_missing_base(route, response, "user-maya")


@pytest.mark.parametrize("route", ROUTES)
def test_another_tenant_is_refused(store, route: str) -> None:
    store.users["user-other"] = User(
        id="user-other",
        tenant_id="tenant-other",
        email="other@example.test",
        display_name="Other",
        role=Role.TENANT_ADMIN,
        group_ids=["group-litigation"],
    )
    response = client.get(_route(route), headers=headers("user-other"))
    _same_as_a_missing_base(route, response, "user-other")


@pytest.mark.parametrize("route", ROUTES)
def test_group_without_knowledge_access_is_refused(store, route: str) -> None:
    store.groups["group-litigation"].permissions = {
        **store.groups["group-litigation"].permissions,
        "knowledge_access": False,
    }
    assert client.get(_route(route), headers=headers("user-jane")).status_code == (
        404 if route == "location" else 403
    )


@pytest.mark.parametrize("route", DOCUMENT_ROUTES)
def test_missing_document_and_missing_base_are_404(store, route: str) -> None:
    assert client.get(_route(route, "doc-missing"), headers=headers("user-jane")).status_code == 404
    other_base = _route(route).replace(CONFIG_ID, "knowledge-missing")
    assert client.get(other_base, headers=headers("user-jane")).status_code == 404


def test_missing_chunk_is_404(store) -> None:
    response = client.get(_route("location", chunk_id="chunk-missing"), headers=headers("user-jane"))
    assert response.status_code == 404


@pytest.mark.parametrize("route", ROUTES)
def test_anonymous_caller_is_refused(store, route: str) -> None:
    assert client.get(_route(route)).status_code in {401, 403}


@pytest.mark.parametrize(
    ("route", "access"),
    [("view", "view"), ("file", "file"), ("original", "original"), ("location", "location")],
)
def test_every_route_audits_ids_and_never_text(store, route: str, access: str) -> None:
    response = client.get(_route(route), headers=headers("user-jane"))
    assert response.status_code == 200
    events = [
        event
        for event in store.audit_events
        if event.action == "knowledge.document.viewed"
    ]
    assert len(events) == 1
    event = events[0]
    assert event.actor_id == "user-jane"
    assert event.target == CONFIG_ID
    assert event.metadata["document_id"] == OPEN_DOC
    assert event.metadata["access"] == access
    assert "cited words" not in str(event.metadata)
    assert "survey" not in str(event.metadata)


def test_viewing_never_rewrites_runtime_state(store, monkeypatch: pytest.MonkeyPatch) -> None:
    saves: list[object] = []
    monkeypatch.setattr(store, "save_runtime_state", lambda **kwargs: saves.append(kwargs))
    assert client.get(_route("view"), headers=headers("user-jane")).status_code == 200
    assert saves == []


def test_wall_refusal_is_audited_with_ids_only_and_looks_like_a_missing_document(store) -> None:
    response = client.get(_route("view", WALLED_DOC), headers=headers("user-admin"))
    assert response.status_code == 404
    assert not [e for e in store.audit_events if e.action == "knowledge.document.viewed"]
    events = [e for e in store.audit_events if e.action == "knowledge.document.view_denied"]
    assert len(events) == 1
    assert events[0].actor_id == "user-admin"
    assert events[0].target == CONFIG_ID
    assert events[0].metadata == {"document_id": WALLED_DOC, "access": "view"}


def test_a_wall_refusal_never_rewrites_runtime_state(store, monkeypatch: pytest.MonkeyPatch) -> None:
    saves: list[object] = []
    monkeypatch.setattr(store, "save_runtime_state", lambda **kwargs: saves.append(kwargs))
    client.get(_route("view", WALLED_DOC), headers=headers("user-admin"))
    assert saves == []


def test_missing_document_is_not_audited_as_a_wall_refusal(store) -> None:
    client.get(_route("view", "doc-missing"), headers=headers("user-admin"))
    assert not [e for e in store.audit_events if e.action == "knowledge.document.view_denied"]


def test_view_json_is_never_cached(store) -> None:
    response = client.get(_route("view"), headers=headers("user-jane"))
    assert response.headers["cache-control"] == "private, no-store"


# ------------------------------------------------------------------ view shape


def test_native_pdf_points_at_the_stored_page(store) -> None:
    response = client.get(
        _route("view"), params={"chunk_id": OPEN_CHUNK}, headers=headers("user-jane")
    )
    assert response.status_code == 200
    assert response.json() == {
        "document_id": OPEN_DOC,
        "knowledge_config_id": CONFIG_ID,
        "name": "survey.pdf",
        "content_type": "application/pdf",
        "mode": "pdf",
        "file_url": f"{BASE}/{OPEN_DOC}/view/file",
        "original_available": True,
        "page_count": 3,
        "target": {
            "page": 2,
            "page_end": 3,
            "locator": "Page 2",
            "excerpt": "The cited words.",
            "chunk_id": OPEN_CHUNK,
            "exact": True,
        },
        "segments": None,
        "notice": None,
    }


def _text_pdf(*pages: str) -> bytes:
    document = pikepdf.new()
    font = pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
    )
    for text in pages:
        page = document.add_blank_page(page_size=(612, 792))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = document.make_stream(f"BT /F1 12 Tf 72 700 Td ({text}) Tj ET".encode())
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def test_pdf_chunk_with_no_recorded_page_is_found_by_its_text(store) -> None:
    _add_document(
        store,
        "doc-unpaged",
        "form.pdf",
        [_chunk("doc-unpaged", 0, "Words on the second page.")],
    )
    store.knowledge_originals.save(
        DocumentRef(TENANT_ID, CONFIG_ID, "doc-unpaged"),
        _text_pdf("Nothing to see here.", "Words on the second page."),
    )
    body = client.get(
        _route("view", "doc-unpaged"),
        params={"chunk_id": "chunk-doc-unpaged-1"},
        headers=headers("user-jane"),
    ).json()
    assert body["target"]["page"] == 2
    assert body["target"]["locator"] == "Page 2"
    assert body["target"]["exact"] is True


def test_image_chunk_with_no_recorded_page_keeps_its_place_exact(store) -> None:
    _add_document(store, "doc-image", "scan.png", [_chunk("doc-image", 0, "Stamped words.")])
    store.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, "doc-image"), _png())
    body = client.get(
        _route("view", "doc-image"),
        params={"chunk_id": "chunk-doc-image-1"},
        headers=headers("user-jane"),
    ).json()
    assert body["target"]["exact"] is True
    assert body["target"]["page"] is None


def test_store_reads_chunks_kept_only_in_memory(store) -> None:
    memory_only = _chunk("doc-memory", 0, "Not in the vector index.")
    store.knowledge_chunks[CONFIG_ID].append(memory_only)
    assert [chunk.id for chunk in store.knowledge_document_chunks(CONFIG_ID, "doc-memory")] == [
        memory_only.id
    ]
    assert store.knowledge_chunk(memory_only.id).text == "Not in the vector index."


def test_no_chunk_id_means_no_target(store) -> None:
    body = client.get(_route("view"), headers=headers("user-jane")).json()
    assert body["target"] is None


def test_unknown_chunk_opens_at_the_top(store) -> None:
    body = client.get(
        _route("view"), params={"chunk_id": "chunk-gone"}, headers=headers("user-jane")
    ).json()
    assert body["target"] is None
    assert body["mode"] == "pdf"


def test_chunk_of_another_document_is_not_a_target(store) -> None:
    body = client.get(
        _route("view"), params={"chunk_id": WALLED_CHUNK}, headers=headers("user-jane")
    ).json()
    assert body["target"] is None
    assert "Walled words" not in str(body)


def test_document_without_a_stored_file_opens_as_text_at_the_cited_passage(store) -> None:
    first = "The easement runs along the north bank of Harlow Creek for its whole length."
    second = first[-30:] + "\n\nIt ends at the county line, where the survey stops."
    _add_document(
        store,
        "doc-legacy",
        "legacy.docx",
        [_chunk("doc-legacy", 0, first), _chunk("doc-legacy", 1, second)],
    )
    response = client.get(
        _route("view", "doc-legacy"),
        params={"chunk_id": "chunk-doc-legacy-2"},
        headers=headers("user-jane"),
    )
    body = response.json()
    assert response.status_code == 200
    assert body["mode"] == "text"
    assert body["file_url"] is None
    assert body["original_available"] is False
    assert body["notice"] == "original_missing"
    assert body["page_count"] is None
    assert [segment["id"] for segment in body["segments"]] == [
        "chunk-doc-legacy-1",
        "chunk-doc-legacy-2",
    ]
    assert body["segments"][1]["text"] == "It ends at the county line, where the survey stops."
    assert body["target"]["excerpt"] == second
    assert body["target"]["page"] is None
    assert body["target"]["exact"] is True


def test_document_known_only_by_name_has_no_text_to_show(store) -> None:
    _add_document(
        store,
        "doc-inventory",
        "unread.docx",
        [_chunk("doc-inventory", 0, "Base source inventory: unread.docx is available from upload.")],
    )
    store.knowledge_documents[CONFIG_ID][-1].status = "metadata-only"
    store.vector_store.upsert_sources([store.knowledge_documents[CONFIG_ID][-1]], [])
    body = client.get(_route("view", "doc-inventory"), headers=headers("user-jane")).json()
    assert body["mode"] == "text"
    assert body["segments"] == []
    assert body["notice"] == "original_missing"


def test_legacy_pdf_segments_keep_their_pages(store) -> None:
    _add_document(
        store,
        "doc-paged",
        "paged.pdf",
        [
            _chunk("doc-paged", 0, "Page ten.", page_start=10, page_end=10, locator="Page 10"),
            _chunk("doc-paged", 1, "Slide text.", locator="Slide 3"),
        ],
    )
    body = client.get(
        _route("view", "doc-paged"),
        params={"chunk_id": "chunk-doc-paged-1"},
        headers=headers("user-jane"),
    ).json()
    assert [(item["page"], item["locator"]) for item in body["segments"]] == [
        (10, "Page 10"),
        (3, "Slide 3"),
    ]
    assert body["target"]["page"] == 10


def test_image_opens_as_an_image(store) -> None:
    _add_document(store, "doc-image", "scan.png", [_chunk("doc-image", 0, "Stamped words.")])
    store.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, "doc-image"), _png())
    body = client.get(_route("view", "doc-image"), headers=headers("user-jane")).json()
    assert body["mode"] == "image"
    assert body["content_type"] == "image/png"
    assert body["file_url"] == f"{BASE}/doc-image/view/file"
    assert body["page_count"] == 1
    assert body["notice"] is None


def test_plain_text_upload_is_text_with_an_original_and_no_notice(store) -> None:
    _add_document(store, "doc-text", "notes.txt", [_chunk("doc-text", 0, "Plain notes.")])
    store.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, "doc-text"), b"Plain notes.")
    body = client.get(_route("view", "doc-text"), headers=headers("user-jane")).json()
    assert body["mode"] == "text"
    assert body["content_type"] == "text/plain"
    assert body["original_available"] is True
    assert body["notice"] is None
    assert body["file_url"] is None
    assert [segment["text"] for segment in body["segments"]] == ["Plain notes."]


def test_unreadable_pdf_falls_back_to_text(store) -> None:
    _add_document(store, "doc-broken", "broken.pdf", [_chunk("doc-broken", 0, "Indexed words.")])
    store.knowledge_originals.save(
        DocumentRef(TENANT_ID, CONFIG_ID, "doc-broken"), b"%PDF-1.7 not really a pdf"
    )
    body = client.get(_route("view", "doc-broken"), headers=headers("user-jane")).json()
    assert body["mode"] == "text"
    assert body["notice"] == "conversion_failed"
    assert body["original_available"] is True


# ------------------------------------------------------------------ file bytes


def test_file_is_private_inline_and_not_sniffed(store) -> None:
    response = client.get(_route("file"), headers=headers("user-jane"))
    assert response.status_code == 200
    assert response.content.startswith(b"%PDF")
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-disposition"].startswith("inline")


def test_file_of_a_converted_scan_is_a_pdf_whatever_the_original_was(store) -> None:
    buffer = io.BytesIO()
    Image.new("L", (16, 16), 90).save(buffer, "TIFF")
    _add_document(store, "doc-scan", "scan.tif", [_chunk("doc-scan", 0, "Words.")])
    store.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, "doc-scan"), buffer.getvalue())
    body = client.get(_route("view", "doc-scan"), headers=headers("user-jane")).json()
    assert (body["mode"], body["content_type"]) == ("pdf", "image/tiff")
    response = client.get(_route("file", "doc-scan"), headers=headers("user-jane"))
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")


def test_file_of_an_image_is_that_image(store) -> None:
    _add_document(store, "doc-image", "scan.png", [_chunk("doc-image", 0, "Words.")])
    store.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, "doc-image"), _png())
    response = client.get(_route("file", "doc-image"), headers=headers("user-jane"))
    assert response.headers["content-type"] == "image/png"
    assert response.content == _png()


def test_file_route_serves_nothing_for_a_text_document(store) -> None:
    _add_document(store, "doc-text", "notes.html", [_chunk("doc-text", 0, "Words.")])
    store.knowledge_originals.save(
        DocumentRef(TENANT_ID, CONFIG_ID, "doc-text"), b"<script>alert(1)</script>"
    )
    assert client.get(_route("file", "doc-text"), headers=headers("user-jane")).status_code == 404


def test_original_is_an_attachment_that_cannot_render_in_the_browser(store) -> None:
    _add_document(store, "doc-html", 'na"me\r\nx.html', [_chunk("doc-html", 0, "Words.")])
    payload = b"<script>alert(1)</script>"
    store.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, "doc-html"), payload)
    response = client.get(_route("original", "doc-html"), headers=headers("user-jane"))
    assert response.status_code == 200
    assert response.content == payload
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment")
    assert "\r" not in disposition and "\n" not in disposition


def test_original_of_a_document_without_a_stored_file_is_404(store) -> None:
    _add_document(store, "doc-legacy", "legacy.docx", [_chunk("doc-legacy", 0, "Words.")])
    assert client.get(_route("original", "doc-legacy"), headers=headers("user-jane")).status_code == 404


def test_unusual_document_ids_stay_addressable(store) -> None:
    identifier = "doc-box-a b"
    _add_document(store, identifier, "odd.pdf", [_chunk(identifier, 0, "Words.")])
    store.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, identifier), _pdf(1))
    quoted = "doc-box-a%20b"
    body = client.get(f"{BASE}/{quoted}/view", headers=headers("user-jane")).json()
    assert body["file_url"] == f"{BASE}/{quoted}/view/file"
