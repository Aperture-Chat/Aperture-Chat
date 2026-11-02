"""A knowledge document or a whole base pulled into a chat with ``#``.

To the person it is an attachment: it sits in the composer as a block, opens in
the viewer, goes with the message, and the model reads it. To everything that
decides access it stays the knowledge base's. Nothing is copied, and every read
passes the knowledge gate, so a wall or a deletion reaches a block already sitting
in a chat. All data is synthetic.
"""

from __future__ import annotations

import io
import json
from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app.core.attachment_documents import attachment_ref
from app.core.knowledge_attachments import (
    KnowledgeAddress,
    knowledge_address,
    knowledge_uri,
    passages_within,
)
from app.core.knowledge_originals import DocumentRef, KnowledgeOriginalStore
from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.models.schemas import (
    ChatAttachment,
    Group,
    KnowledgeChunk,
    KnowledgeConfig,
    KnowledgeDocument,
    KnowledgeDocumentWall,
)
from app.repositories.deps import get_store

client = TestClient(app)

OWNER = "user-jane"
STRANGER = "user-casey"
TENANT_ID = "tenant-example"
CONFIG_ID = "knowledge-file-block"
LEASE = "doc-lease"
LEASE_NAME = "Harbor lease.pdf"
SIBLING = "doc-sibling"
SIBLING_NAME = "Harbor survey.pdf"
WALLED = "doc-walled"
PHOTO = "doc-photo"
OPENING_FACT = "The landlord is Meridian Holdings"
TAIL_FACT = "The management fee is ZEPHYRINE four percent"
SIBLING_FACT = "The survey found QUILLON cracks in the seawall"
WALLED_FACT = "The settlement figure is OBSIDIAN nine million"
FILLER = "Clause on ordinary building upkeep and resident notices."
# More passages than a knowledge search would ever hand the model.
LEASE_PASSAGES = [OPENING_FACT, *[f"{FILLER} Item {n}." for n in range(1, 11)], TAIL_FACT]
ATTACH = "/api/chat/attachments/knowledge"


def headers(user_id: str = OWNER) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _pdf(pages: int = 2) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _document(document_id: str, name: str, **updates: object) -> KnowledgeDocument:
    values: dict[str, object] = {
        "id": document_id,
        "knowledge_config_id": CONFIG_ID,
        "tenant_id": TENANT_ID,
        "name": name,
        "source_uri": f"upload://knowledge/{CONFIG_ID}/{name}",
        "source_type": "upload",
        "chunk_count": 1,
        "acl_group_ids": ["group-litigation"],
        "updated_at": "now",
    }
    values.update(updates)
    return KnowledgeDocument(**values)


def _chunk(document_id: str, name: str, ordinal: int, text: str, **updates: object) -> KnowledgeChunk:
    values: dict[str, object] = {
        "id": f"chunk-{document_id}-{ordinal}",
        "knowledge_config_id": CONFIG_ID,
        "document_id": document_id,
        "tenant_id": TENANT_ID,
        "source_name": name,
        "source_uri": f"upload://knowledge/{CONFIG_ID}/{name}",
        "source_type": "upload",
        "text": text,
        "ordinal": ordinal,
        "page_start": ordinal + 1,
        "page_end": ordinal + 1,
        "locator": f"Page {ordinal + 1}",
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
        name="Harbor matter",
        source_type="upload",
        enabled=True,
        acl_group_ids=["group-litigation"],
    )
    wall = KnowledgeDocumentWall(source="manual", group_ids=["group-falcon"])
    documents = [
        _document(LEASE, LEASE_NAME, chunk_count=len(LEASE_PASSAGES)),
        _document(SIBLING, SIBLING_NAME),
        _document(WALLED, "Settlement.pdf", wall=wall),
        _document(PHOTO, "Seawall.png"),
    ]
    chunks = [
        *(_chunk(LEASE, LEASE_NAME, n, text) for n, text in enumerate(LEASE_PASSAGES)),
        _chunk(SIBLING, SIBLING_NAME, 0, SIBLING_FACT),
        _chunk(WALLED, "Settlement.pdf", 0, WALLED_FACT, wall_group_ids=["group-falcon"]),
        _chunk(PHOTO, "Seawall.png", 0, "Sign reads NO MOORING."),
    ]
    seeded.knowledge_documents[CONFIG_ID] = documents
    seeded.knowledge_chunks[CONFIG_ID] = chunks
    seeded.vector_store.replace_config(CONFIG_ID, documents, chunks)
    seeded.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, LEASE), _pdf(12))
    seeded.knowledge_originals.save(DocumentRef(TENANT_ID, CONFIG_ID, WALLED), _pdf(1))
    yield seeded
    get_store.cache_clear()


def _attach(document_id: str = LEASE, *, user_id: str = OWNER, config_id: str = CONFIG_ID) -> httpx.Response:
    return client.post(
        ATTACH,
        headers=headers(user_id),
        json={"knowledge_config_id": config_id, "document_id": document_id},
    )


def _attached(document_id: str = LEASE) -> dict:
    response = _attach(document_id)
    assert response.status_code == 200, response.text
    return response.json()


def _wall_off(store: object, document_id: str = LEASE) -> None:
    wall = KnowledgeDocumentWall(source="manual", group_ids=["group-falcon"])
    documents = store.knowledge_documents[CONFIG_ID]
    target = next(document for document in documents if document.id == document_id)
    target.wall = wall
    for chunk in store.knowledge_chunks[CONFIG_ID]:
        if chunk.document_id == document_id:
            chunk.wall_group_ids = ["group-falcon"]
    store.vector_store.update_document_walls(CONFIG_ID, {document_id: wall})


def _remove_from_the_base(store: object, document_id: str = LEASE) -> None:
    documents = [d for d in store.knowledge_documents[CONFIG_ID] if d.id != document_id]
    chunks = [c for c in store.knowledge_chunks[CONFIG_ID] if c.document_id != document_id]
    store.knowledge_documents[CONFIG_ID] = documents
    store.knowledge_chunks[CONFIG_ID] = chunks
    store.vector_store.replace_config(CONFIG_ID, documents, chunks)


def _forged_row(store: object, document_id: str, *, owner: str = OWNER) -> str:
    """What a row would be if something other than the attach route had written it."""
    attachment_id = f"forged-{document_id}"
    store.save_chat_attachment(
        ChatAttachment(
            id=attachment_id,
            tenant_id=TENANT_ID,
            owner_user_id=owner,
            name="forged.pdf",
            size="1 KB",
            kind="PDF",
            source_type="knowledge",
            source_uri=knowledge_uri(KnowledgeAddress(CONFIG_ID, document_id)),
        )
    )
    return attachment_id


def activate_provider(store: object, provider_id: str = "provider-azure") -> None:
    provider = store.providers[provider_id]
    provider.connected = True
    store.create_provider_key(
        key_id=f"key-{provider_id}-file-block",
        provider=provider,
        name=f"{provider.name} File block",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value=f"{provider.kind}-test-key",
    )


def _provider(monkeypatch: pytest.MonkeyPatch, store: object, reply: str = "Noted.") -> list[dict]:
    activate_provider(store)
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            json={
                "id": "gen-file-block",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}
                ],
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )
    return seen


def _complete(question: str, **fields: object) -> httpx.Response:
    return client.post(
        "/api/chat/complete",
        headers=headers(),
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": question}],
            "citations_enabled": True,
            **fields,
        },
    )


def _forwarded(seen: list[dict]) -> str:
    return json.dumps(seen[0], ensure_ascii=False)


def _open(attachment: dict, route: str, user_id: str = OWNER) -> httpx.Response:
    return client.get(f"/api/chat/attachments/{attachment['id']}/{route}", headers=headers(user_id))


def _sent(seen: list[dict], question: str, **fields: object) -> str:
    """What reached the model on a turn that has to succeed."""
    reply = _complete(question, **fields)
    assert reply.status_code == 200, reply.text
    return _forwarded(seen)


def _save_chat(attachment: dict, thread_id: str = "thread-file-block") -> None:
    saved = client.put(
        f"/api/chat/threads/{thread_id}",
        headers=headers(),
        json={
            "title": "Harbor",
            "model_id": "gpt-4o",
            "messages": [
                {
                    "id": "message-1",
                    "role": "user",
                    "content": "Please read this",
                    "createdAt": "Now",
                    "status": "ok",
                    "attachments": [attachment],
                }
            ],
        },
    )
    assert saved.status_code == 200, saved.text


# ---------------------------------------------------------------- the address


@pytest.mark.parametrize(
    ("config_id", "document_id"),
    [
        ("kb-1", "doc-1"),
        ("kb/one", "doc two.pdf"),
        ("kb%20x", "d/o/c"),
        ("kb-1", None),
        ("kb/one", None),
    ],
)
def test_an_address_reads_back_as_written(config_id: str, document_id: str | None) -> None:
    address = KnowledgeAddress(config_id, document_id)
    row = ChatAttachment(
        name="x", size="", kind="PDF", source_type="knowledge", source_uri=knowledge_uri(address)
    )

    assert knowledge_address(row) == address


@pytest.mark.parametrize(
    ("source_type", "source_uri"),
    [
        ("upload", "knowledge://kb-1/doc-1"),
        ("knowledge", None),
        ("knowledge", "upload://kb-1/doc-1"),
        ("knowledge", "knowledge://kb-1/"),
        ("knowledge", "knowledge:///doc-1"),
        ("knowledge", "knowledge://kb-1/doc-1/extra"),
    ],
)
def test_anything_else_is_no_address(source_type: str, source_uri: str | None) -> None:
    row = ChatAttachment(
        name="x", size="", kind="PDF", source_type=source_type, source_uri=source_uri
    )

    assert knowledge_address(row) is None


def _sized(*lengths: int) -> list[KnowledgeChunk]:
    return [_chunk(LEASE, LEASE_NAME, n, "x" * length) for n, length in enumerate(lengths)]


def test_passages_fill_a_budget_exactly() -> None:
    assert [len(c.text) for c in passages_within(_sized(6, 4), 10)] == [6, 4]


def test_the_budget_counts_everything_already_chosen() -> None:
    assert [len(c.text) for c in passages_within(_sized(6, 5), 10)] == [6]


def test_a_shorter_passage_still_fits_after_a_longer_one_did_not() -> None:
    assert [len(c.text) for c in passages_within(_sized(6, 9, 3), 10)] == [6, 3]


def test_nothing_fits_an_empty_budget_but_an_empty_passage() -> None:
    assert passages_within(_sized(1), 0) == []


# ------------------------------------------------------------ pulling it in


def test_a_picked_document_arrives_as_a_file_with_its_real_name_and_size(store) -> None:
    attachment = _attached()

    assert attachment["id"]
    assert attachment["name"] == LEASE_NAME
    assert attachment["kind"] == "PDF"
    assert attachment["size_bytes"] == len(_pdf(12))
    assert attachment["size"].endswith("B")
    assert attachment["source_type"] == "knowledge"
    assert attachment["owner_user_id"] == OWNER
    assert attachment["tenant_id"] == TENANT_ID


def test_a_document_with_no_stored_file_still_arrives(store) -> None:
    attachment = _attached(SIBLING)

    assert attachment["name"] == SIBLING_NAME
    assert attachment["size"] == ""
    assert attachment["size_bytes"] is None


def test_nothing_of_the_document_is_copied(store) -> None:
    attachment = _attached()

    ref = attachment_ref(attachment["id"])
    assert attachment["text_preview"] is None
    assert store.attachment_documents.path(ref) is None
    assert store.chat_attachment_for(store.users[OWNER], attachment["id"]).text_preview is None


def test_pulling_a_file_in_is_audited(store) -> None:
    attachment = _attached()

    events = [event for event in store.audit_events if event.target == attachment["id"]]
    assert [event.action for event in events] == ["chat.attachment_pulled_from_knowledge"]
    assert events[0].metadata == {"knowledge_config_id": CONFIG_ID, "document_id": LEASE}


def test_pulling_a_file_in_never_rewrites_runtime_state(store, monkeypatch) -> None:
    saves: list[object] = []
    monkeypatch.setattr(store, "save_runtime_state", lambda **kwargs: saves.append(kwargs))

    _attached()

    assert saves == []


def test_a_walled_document_cannot_be_pulled_in_and_looks_missing(store) -> None:
    walled = _attach(WALLED)
    missing = _attach("doc-that-never-was")

    assert walled.status_code == 404
    assert walled.json() == missing.json()


def test_a_wall_member_can_pull_it_in(store) -> None:
    store.users[OWNER].group_ids = [*store.users[OWNER].group_ids, "group-falcon"]

    assert _attach(WALLED).status_code == 200


def test_someone_outside_the_base_cannot_pull_a_file_in(store) -> None:
    store.knowledge_configs[CONFIG_ID].acl_group_ids = ["group-falcon"]
    store.update_knowledge_acl(store.knowledge_configs[CONFIG_ID])

    assert _attach().status_code == 404


def test_a_disabled_base_gives_up_no_files(store) -> None:
    store.knowledge_configs[CONFIG_ID].enabled = False

    assert _attach().status_code == 404


# ----------------------------------------------------------------- opening it


def test_it_opens_as_the_knowledge_document(store) -> None:
    attachment = _attached()

    view = _open(attachment, "view")

    assert view.status_code == 200, view.text
    body = view.json()
    assert body["mode"] == "pdf"
    assert body["page_count"] == 12
    assert body["name"] == LEASE_NAME
    # The address the viewer loads bytes from, so the knowledge gate serves them.
    assert body["attachment_id"] is None
    assert body["knowledge_config_id"] == CONFIG_ID
    assert body["document_id"] == LEASE
    file = client.get(body["file_url"], headers=headers())
    assert file.status_code == 200
    assert file.content == _pdf(12)


def test_it_downloads_as_the_stored_file(store) -> None:
    attachment = _attached()

    original = _open(attachment, "original")

    assert original.status_code == 200
    assert original.content == _pdf(12)
    assert "attachment" in original.headers["content-disposition"]


@pytest.mark.parametrize("route", ["view", "original"])
def test_nobody_else_can_open_someone_elses_block(store, route: str) -> None:
    attachment = _attached()

    refused = _open(attachment, route, STRANGER)

    assert refused.status_code == 404


@pytest.mark.parametrize("route", ["view", "original"])
def test_a_wall_added_later_closes_a_block_already_in_a_chat(store, route: str) -> None:
    attachment = _attached()
    _wall_off(store)

    refused = _open(attachment, route)

    assert refused.status_code == 404


@pytest.mark.parametrize("route", ["view", "original"])
def test_a_document_removed_from_the_base_is_gone_from_the_block(store, route: str) -> None:
    attachment = _attached()
    _remove_from_the_base(store)

    refused = _open(attachment, route)

    assert refused.status_code == 404


def test_a_row_cannot_open_a_door_the_gate_keeps_shut(store) -> None:
    forged = _forged_row(store, WALLED)

    view = client.get(f"/api/chat/attachments/{forged}/view", headers=headers())
    original = client.get(f"/api/chat/attachments/{forged}/original", headers=headers())

    assert view.status_code == 404
    assert original.status_code == 404


# ------------------------------------------------------------ the model reads it


def test_the_model_reads_that_whole_file_and_only_that_file(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    attachment = _attached()

    forwarded = _sent(seen, "Summarize this", attachment_ids=[attachment["id"]])

    assert OPENING_FACT in forwarded
    assert TAIL_FACT in forwarded
    assert LEASE_NAME in forwarded
    assert SIBLING_FACT not in forwarded


def test_one_file_is_told_to_the_model_as_a_file_not_a_base(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    attachment = _attached()

    reply = _complete("Summarize this", attachment_ids=[attachment["id"]])

    forwarded = _forwarded(seen)
    assert "This is the whole file." in forwarded
    assert "whole knowledge base" not in forwarded
    file_row = next(c for c in reply.json()["citations"] if not c.get("chunk_id"))
    assert file_row["snippet"].startswith("Attached PDF file (")


def test_a_base_is_listed_among_the_sources_as_a_base(store, monkeypatch) -> None:
    _provider(monkeypatch, store)
    block = _attach_base().json()

    reply = _complete("Summarize this matter", attachment_ids=[block["id"]])

    base_row = next(c for c in reply.json()["citations"] if not c.get("chunk_id"))
    assert base_row["snippet"].startswith("Attached knowledge base (3 files)")


def test_one_file_too_long_for_the_turn_stays_inside_that_file(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    _a_tight_turn(monkeypatch)
    attachment = _attached()

    forwarded = _sent(seen, "What did the QUILLON survey find?", attachment_ids=[attachment["id"]])

    assert SIBLING_FACT not in forwarded
    assert "only part of this file" in forwarded


def test_an_upload_and_a_block_go_in_the_same_message(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    block = _attached()
    upload = client.post(
        "/api/chat/attachments",
        files={"file": ("notes.txt", b"The uploaded note mentions VERMILION tides.", "text/plain")},
        headers=headers(),
    )
    assert upload.status_code == 200, upload.text

    forwarded = _sent(seen, "Compare these", attachment_ids=[block["id"], upload.json()["id"]])

    assert "VERMILION" in forwarded
    assert TAIL_FACT in forwarded


def test_a_cited_passage_opens_the_knowledge_document_at_its_place(store, monkeypatch) -> None:
    attachment = _attached()
    tail_marker = len(LEASE_PASSAGES)
    _provider(monkeypatch, store, reply=f"The fee is four percent [K{tail_marker}].")

    reply = _complete("What is the management fee?", attachment_ids=[attachment["id"]])

    assert reply.status_code == 200, reply.text
    cited = [c for c in reply.json()["citations"] if c.get("chunk_id")]
    assert [c["chunk_id"] for c in cited] == [f"chunk-{LEASE}-{len(LEASE_PASSAGES) - 1}"]
    assert cited[0]["knowledge_config_id"] == CONFIG_ID
    assert cited[0]["document_id"] == LEASE
    assert cited[0]["attachment_id"] is None
    assert cited[0]["page_start"] == len(LEASE_PASSAGES)


def test_a_follow_up_finds_what_the_question_names(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    attachment = _attached()

    forwarded = _sent(seen, "What about ZEPHYRINE?", context_attachment_ids=[attachment["id"]])

    assert TAIL_FACT in forwarded
    # Only what the question names, not the file again, and the model is told so.
    assert OPENING_FACT not in forwarded
    assert "Attached earlier in this chat" in forwarded
    assert "This is the whole file." not in forwarded


def test_a_wall_added_before_sending_stops_the_turn_and_says_nothing(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    attachment = _attached()
    _wall_off(store)

    refused = _complete("Summarize this", attachment_ids=[attachment["id"]])
    unknown = _complete("Summarize this", attachment_ids=["attachment-that-never-was"])

    assert refused.status_code == 404
    assert seen == []
    assert LEASE_NAME not in refused.text
    assert refused.json()["detail"].split("'")[0] == unknown.json()["detail"].split("'")[0]


def test_a_wall_added_later_leaves_the_chat_working_without_the_file(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    attachment = _attached()
    _wall_off(store)

    forwarded = _sent(seen, "What about ZEPHYRINE?", context_attachment_ids=[attachment["id"]])

    assert TAIL_FACT not in forwarded
    assert LEASE_NAME not in forwarded


def test_a_wall_refusal_at_send_is_audited(store, monkeypatch) -> None:
    _provider(monkeypatch, store)
    attachment = _attached()
    _wall_off(store)

    _complete("Summarize this", attachment_ids=[attachment["id"]])

    refused = [e for e in store.audit_events if e.action == "knowledge.document.view_denied"]
    assert [e.metadata for e in refused] == [{"document_id": LEASE, "access": "chat"}]


def test_a_forged_row_gives_the_model_nothing(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    forged = _forged_row(store, WALLED)

    refused = _complete("Summarize this", attachment_ids=[forged])

    assert refused.status_code == 404
    assert seen == []


def test_a_passage_the_person_may_not_see_stays_out_of_a_readable_document(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    attachment = _attached()
    for chunk in store.knowledge_chunks[CONFIG_ID]:
        if chunk.text == TAIL_FACT:
            chunk.acl_group_ids = ["group-falcon"]
    store.vector_store.replace_config(
        CONFIG_ID, store.knowledge_documents[CONFIG_ID], store.knowledge_chunks[CONFIG_ID]
    )

    forwarded = _sent(seen, "Summarize this", attachment_ids=[attachment["id"]])

    assert OPENING_FACT in forwarded
    assert TAIL_FACT not in forwarded


def test_a_file_in_a_base_also_being_searched_is_not_read_twice(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    attachment = _attached()

    forwarded = _sent(
        seen,
        "What is the ZEPHYRINE management fee?",
        attachment_ids=[attachment["id"]],
        knowledge_config_ids=[CONFIG_ID],
    )

    assert forwarded.count(TAIL_FACT) == 1


def test_an_image_in_a_base_is_read_as_its_text_not_a_missing_picture(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    attachment = _attached(PHOTO)

    forwarded = _sent(seen, "What does the sign say?", attachment_ids=[attachment["id"]])

    assert "NO MOORING" in forwarded
    assert "image_url" not in forwarded


# ------------------------------------------------------------- taking it back


def test_taking_a_block_back_leaves_the_document_alone(store) -> None:
    attachment = _attached()

    removed = client.delete(f"/api/chat/attachments/{attachment['id']}", headers=headers())

    assert removed.status_code == 200, removed.text
    assert store.chat_attachment_for(store.users[OWNER], attachment["id"]) is None
    assert store.knowledge_originals.path(DocumentRef(TENANT_ID, CONFIG_ID, LEASE)) is not None
    assert len(store.knowledge_document_chunks(CONFIG_ID, LEASE)) == len(LEASE_PASSAGES)


def test_deleting_the_chat_leaves_the_document_alone(store) -> None:
    attachment = _attached()
    _save_chat(attachment)

    deleted = client.delete("/api/chat/threads/thread-file-block", headers=headers())

    assert deleted.status_code == 200, deleted.text
    assert store.chat_attachment_for(store.users[OWNER], attachment["id"]) is None
    assert store.knowledge_originals.path(DocumentRef(TENANT_ID, CONFIG_ID, LEASE)) is not None
    assert len(store.knowledge_document_chunks(CONFIG_ID, LEASE)) == len(LEASE_PASSAGES)


# ------------------------------------------------------------ a whole base


def _attach_base(*, user_id: str = OWNER, config_id: str = CONFIG_ID) -> httpx.Response:
    return client.post(ATTACH, headers=headers(user_id), json={"knowledge_config_id": config_id})


def _base() -> dict:
    response = _attach_base()
    assert response.status_code == 200, response.text
    return response.json()


def _a_tight_turn(monkeypatch: pytest.MonkeyPatch, chars: int = 400) -> None:
    monkeypatch.setattr("app.routes.chat.attachment_turn_budget", lambda _window: chars)


def test_a_base_arrives_as_one_block_counting_the_files_the_person_can_see(store) -> None:
    block = _base()

    assert block["name"] == "Harbor matter"
    assert block["kind"] == "Knowledge"
    # Four files, one of them behind a wall this person is outside.
    assert block["size"] == "3 files"
    assert block["size_bytes"] is None
    assert block["text_preview"] is None
    assert block["source_type"] == "knowledge"
    assert knowledge_address(ChatAttachment(**block)) == KnowledgeAddress(CONFIG_ID)


def test_a_base_with_one_file_says_one_file(store) -> None:
    for document_id in (SIBLING, PHOTO):
        _remove_from_the_base(store, document_id)

    assert _base()["size"] == "1 file"


def test_pulling_a_base_in_is_audited(store) -> None:
    block = _base()

    events = [event for event in store.audit_events if event.target == block["id"]]
    assert [event.action for event in events] == ["chat.attachment_pulled_from_knowledge"]
    assert events[0].metadata == {"knowledge_config_id": CONFIG_ID, "document_id": None}


def test_a_base_the_person_cannot_read_looks_missing(store) -> None:
    store.knowledge_configs[CONFIG_ID].acl_group_ids = ["group-falcon"]
    store.update_knowledge_acl(store.knowledge_configs[CONFIG_ID])

    refused = _attach_base()
    missing = _attach_base(config_id="base-that-never-was")

    assert refused.status_code == 404
    assert refused.json() == missing.json()


def test_a_disabled_base_cannot_be_pulled_in(store) -> None:
    store.knowledge_configs[CONFIG_ID].enabled = False

    assert _attach_base().status_code == 404


def test_a_base_block_opens_as_the_files_it_brings(store) -> None:
    block = _base()

    view = _open(block, "view")

    assert view.status_code == 200, view.text
    body = view.json()
    assert body["name"] == "Harbor matter"
    assert body["mode"] == "text"
    assert body["attachment_id"] == block["id"]
    assert body["original_available"] is False
    assert body["file_url"] is None
    assert [segment["text"] for segment in body["segments"]] == [LEASE_NAME, SIBLING_NAME, "Seawall.png"]


def test_a_base_block_has_no_one_file_to_download(store) -> None:
    block = _base()

    original = _open(block, "original")

    assert original.status_code == 404


def test_a_base_block_closes_when_the_person_loses_the_base(store) -> None:
    block = _base()
    store.knowledge_configs[CONFIG_ID].enabled = False

    view = _open(block, "view")

    assert view.status_code == 404


def test_someone_elses_base_block_is_closed(store) -> None:
    block = _base()

    view = _open(block, "view", STRANGER)

    assert view.status_code == 404


def test_the_model_reads_the_whole_base_except_what_is_walled(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    block = _base()

    forwarded = _sent(seen, "Summarize this matter", attachment_ids=[block["id"]])

    assert OPENING_FACT in forwarded
    assert TAIL_FACT in forwarded
    assert SIBLING_FACT in forwarded
    assert WALLED_FACT not in forwarded
    assert "whole knowledge base" in forwarded


def test_each_passage_of_a_base_names_its_file(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    block = _base()

    _complete("Summarize this matter", attachment_ids=[block["id"]])

    system = _forwarded(seen)
    assert f"({SIBLING_NAME}, " in system
    assert f"({LEASE_NAME}, " in system


def test_a_base_passage_is_cited_as_its_own_document(store, monkeypatch) -> None:
    _provider(monkeypatch, store, reply="The survey found cracks [K1].")
    block = _base()

    reply = _complete("What did the survey find?", attachment_ids=[block["id"]])

    assert reply.status_code == 200, reply.text
    cited = [c for c in reply.json()["citations"] if c.get("chunk_id")]
    assert len(cited) == 1
    assert cited[0]["knowledge_config_id"] == CONFIG_ID
    assert cited[0]["document_id"] == LEASE
    assert cited[0]["attachment_id"] is None


def test_a_base_too_large_gives_what_best_matches_and_says_so(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    _a_tight_turn(monkeypatch)
    block = _base()

    forwarded = _sent(seen, "What is the ZEPHYRINE management fee?", attachment_ids=[block["id"]])

    assert TAIL_FACT in forwarded
    assert "only part of this knowledge base" in forwarded
    assert "If the answer may depend on the rest, say so" in forwarded
    assert forwarded.count(FILLER) < len(LEASE_PASSAGES) - 2


def test_a_base_too_large_never_reaches_past_a_wall(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    _a_tight_turn(monkeypatch)
    block = _base()

    _complete("What is the OBSIDIAN settlement figure?", attachment_ids=[block["id"]])

    assert WALLED_FACT not in _forwarded(seen)


def test_an_earlier_base_gives_what_the_question_names(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    block = _base()

    forwarded = _sent(seen, "What about ZEPHYRINE?", context_attachment_ids=[block["id"]])

    assert TAIL_FACT in forwarded
    assert forwarded.count(FILLER) < len(LEASE_PASSAGES) - 2
    assert "Attached earlier in this chat" in forwarded
    assert "This is the whole knowledge base." not in forwarded


def test_a_wall_added_later_hides_that_file_and_keeps_the_base(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    block = _base()
    _wall_off(store)

    forwarded = _sent(seen, "Summarize this matter", attachment_ids=[block["id"]])

    assert SIBLING_FACT in forwarded
    assert TAIL_FACT not in forwarded


def test_a_base_turned_off_stops_the_turn_and_drops_from_later_ones(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    block = _base()
    store.knowledge_configs[CONFIG_ID].enabled = False

    refused = _complete("Summarize this matter", attachment_ids=[block["id"]])
    later = _complete("What about ZEPHYRINE?", context_attachment_ids=[block["id"]])

    assert refused.status_code == 404
    assert later.status_code == 200, later.text
    assert len(seen) == 1
    assert TAIL_FACT not in _forwarded(seen)


def test_a_file_and_its_base_together_are_read_once(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    base = _base()
    file = _attached()

    forwarded = _sent(seen, "Summarize this matter", attachment_ids=[base["id"], file["id"]])

    assert forwarded.count(TAIL_FACT) == 1


def test_a_base_also_being_searched_is_read_once(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    base = _base()

    forwarded = _sent(
        seen,
        "What is the ZEPHYRINE management fee?",
        attachment_ids=[base["id"]],
        knowledge_config_ids=[CONFIG_ID],
    )

    assert forwarded.count(TAIL_FACT) == 1


def test_taking_a_base_block_back_leaves_the_base_alone(store) -> None:
    block = _base()

    removed = client.delete(f"/api/chat/attachments/{block['id']}", headers=headers())

    assert removed.status_code == 200, removed.text
    assert CONFIG_ID in store.knowledge_configs
    assert len(store.knowledge_documents[CONFIG_ID]) == 4


def test_the_text_of_one_file_is_never_clipped_by_the_end_of_another(store, monkeypatch) -> None:
    seen = _provider(monkeypatch, store)
    shared = "Standard harbor authority notice applies to this matter."
    _remove_from_the_base(store, PHOTO)
    for chunk in store.knowledge_chunks[CONFIG_ID]:
        if chunk.document_id == LEASE and chunk.text == TAIL_FACT:
            chunk.text = f"{TAIL_FACT}. {shared}"
            chunk.locator = "Page 1"
        if chunk.document_id == SIBLING:
            chunk.text = f"{shared} {SIBLING_FACT}"
    store.vector_store.replace_config(
        CONFIG_ID, store.knowledge_documents[CONFIG_ID], store.knowledge_chunks[CONFIG_ID]
    )
    block = _base()

    _complete("Summarize this matter", attachment_ids=[block["id"]])

    assert f"{shared} {SIBLING_FACT}" in _forwarded(seen)
