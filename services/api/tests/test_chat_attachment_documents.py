"""A file attached to a chat is a document, the same as one in a knowledge base.

It keeps its bytes so it can be shown as it is, its whole text so the model can
read past the opening, and its properties. Everything is scoped to the person
who attached it, and goes when the attachment goes. All data is synthetic.
"""

from __future__ import annotations

import io
import json
import zipfile
from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfWriter

from app.core.attachment_documents import (
    AttachmentIndex,
    load_attachment_index,
    retain_attachment,
)
from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.core.document_metadata import PROPERTIES_LOCATOR
from app.models.schemas import ChatAttachment, ChatCompletionRequest, KnowledgeChunk
from app.repositories.deps import get_store
from app.routes.chat import DOCUMENT_PATCH_PREFIX, _body_text, document_patch_instruction

client = TestClient(app)

OWNER = "user-jane"
STRANGER = "user-casey"
TAIL_FACT = "The management fee is ZEPHYRINE four percent"
LONG_TEXT = ("Clause about ordinary building upkeep and resident notices.\n\n" * 200) + TAIL_FACT


def headers(user_id: str = OWNER) -> dict[str, str]:
    return {"x-aperture-user": user_id}


@pytest.fixture(autouse=True)
def reset_store() -> Iterator[None]:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _pdf(pages: int) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _docx(paragraphs: list[str], *, title: str = "", creator: str = "") -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>" for text in paragraphs)
    document = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>"
    )
    core = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/">'
        f"<dc:title>{title}</dc:title><dc:creator>{creator}</dc:creator></cp:coreProperties>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", document)
        archive.writestr("docProps/core.xml", core)
    return buffer.getvalue()


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buffer, "PNG")
    return buffer.getvalue()


def upload(name: str, content: bytes, mime: str, user_id: str = OWNER) -> dict:
    response = client.post(
        "/api/chat/attachments",
        files={"file": (name, content, mime)},
        headers=headers(user_id),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _routes(attachment_id: str) -> dict[str, str]:
    base = f"/api/chat/attachments/{attachment_id}"
    return {"view": f"{base}/view", "file": f"{base}/view/file", "original": f"{base}/original"}


def activate_provider(provider_id: str = "provider-azure") -> None:
    store = get_store()
    provider = store.providers[provider_id]
    provider.connected = True
    store.create_provider_key(
        key_id=f"key-{provider_id}-documents",
        provider=provider,
        name=f"{provider.name} Documents",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value=f"{provider.kind}-test-key",
    )


def mock_completion(monkeypatch: pytest.MonkeyPatch, reply: str, seen: list) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            json={
                "id": "gen-document-test",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}
                ],
            },
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(handler)),
    )


def complete(attachment_ids: list[str], question: str, **fields: object) -> dict:
    response = client.post(
        "/api/chat/complete",
        headers=headers(),
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": question}],
            "attachment_ids": attachment_ids,
            "citations_enabled": True,
            **fields,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


# ----------------------------------------------------------------- the viewer


def test_a_pdf_opens_as_its_own_pages() -> None:
    content = _pdf(3)
    attachment = upload("lease.pdf", content, "application/pdf")
    routes = _routes(attachment["id"])

    view = client.get(routes["view"], headers=headers())

    assert view.status_code == 200, view.text
    body = view.json()
    assert body["mode"] == "pdf"
    assert body["page_count"] == 3
    assert body["attachment_id"] == attachment["id"]
    assert body["name"] == "lease.pdf"
    assert body["original_available"] is True
    file = client.get(routes["file"], headers=headers())
    assert file.status_code == 200
    assert file.headers["content-type"] == "application/pdf"
    assert file.headers["x-content-type-options"] == "nosniff"
    assert file.content == content


def test_the_original_downloads_as_stored_and_cannot_render_in_the_browser() -> None:
    content = b"<html><script>alert(1)</script></html>"
    attachment = upload("notes.html", content, "text/html")

    original = client.get(_routes(attachment["id"])["original"], headers=headers())

    assert original.status_code == 200
    assert original.content == content
    assert original.headers["content-type"] == "application/octet-stream"
    assert "attachment" in original.headers["content-disposition"]
    assert "notes.html" in original.headers["content-disposition"]


def test_nothing_active_is_served_for_display() -> None:
    attachment = upload("notes.html", b"<html><script>alert(1)</script></html>", "text/html")

    view = client.get(_routes(attachment["id"])["view"], headers=headers()).json()
    file = client.get(_routes(attachment["id"])["file"], headers=headers())

    assert view["mode"] == "text"
    assert view["file_url"] is None
    assert file.status_code == 404


def test_an_image_opens_as_an_image() -> None:
    attachment = upload("receipt.png", _png(), "image/png")

    view = client.get(_routes(attachment["id"])["view"], headers=headers()).json()
    file = client.get(_routes(attachment["id"])["file"], headers=headers())

    assert view["mode"] == "image"
    assert file.status_code == 200
    assert file.headers["content-type"] == "image/png"


def test_text_shows_the_whole_document_not_its_preview() -> None:
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")
    assert TAIL_FACT not in (attachment["text_preview"] or "")

    view = client.get(_routes(attachment["id"])["view"], headers=headers()).json()

    assert view["mode"] == "text"
    shown = "\n".join(segment["text"] for segment in view["segments"])
    assert TAIL_FACT in shown
    assert view["passage_count"] == len(view["segments"])
    assert view["passage_count"] > 1


def test_a_word_file_reports_the_properties_it_carries() -> None:
    content = _docx(["Opening clause."], title="Harbor Agreement", creator="Dana Reyes")
    attachment = upload(
        "agreement.docx",
        content,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

    view = client.get(_routes(attachment["id"])["view"], headers=headers()).json()

    properties = {item["label"]: item["value"] for item in view["properties"]}
    assert properties["Title"] == "Harbor Agreement"
    assert properties["Author"] == "Dana Reyes"


def test_a_passage_opens_at_its_place() -> None:
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")
    index = load_attachment_index(get_store().attachment_documents, _saved(attachment["id"]))
    assert index is not None
    last = index.passages[-1]

    view = client.get(
        _routes(attachment["id"])["view"], params={"chunk_id": last.id}, headers=headers()
    ).json()

    assert view["target"]["chunk_id"] == last.id
    assert TAIL_FACT in view["target"]["excerpt"]


def test_a_chunk_id_from_another_attachment_finds_nothing() -> None:
    mine = upload("agreement.txt", b"Mine.", "text/plain")
    theirs = upload("theirs.txt", b"Theirs.", "text/plain", STRANGER)
    index = load_attachment_index(get_store().attachment_documents, _saved(theirs["id"]))
    assert index is not None

    view = client.get(
        _routes(mine["id"])["view"], params={"chunk_id": index.passages[0].id}, headers=headers()
    ).json()

    assert view["target"] is None


@pytest.mark.parametrize("route", ["view", "file", "original"])
def test_nobody_else_can_reach_an_attachment(route: str) -> None:
    attachment = upload("lease.pdf", _pdf(1), "application/pdf")

    refused = client.get(_routes(attachment["id"])[route], headers=headers(STRANGER))

    assert refused.status_code == 404


def test_viewing_is_audited_as_the_owner_opening_the_file() -> None:
    attachment = upload("lease.pdf", _pdf(1), "application/pdf")

    client.get(_routes(attachment["id"])["view"], headers=headers())

    events = [
        event
        for event in get_store().audit_events
        if event.action == "chat.attachment.viewed" and event.target == attachment["id"]
    ]
    assert len(events) == 1
    assert events[0].metadata == {"access": "view"}


def test_an_attachment_from_before_documents_were_kept_opens_its_text() -> None:
    saved = get_store().save_chat_attachment(
        ChatAttachment(
            id="upload-legacy",
            tenant_id=get_store().users[OWNER].tenant_id,
            owner_user_id=OWNER,
            name="old.docx",
            size="10 KB",
            kind="Word",
            text_preview="The opening of an old document.",
        )
    )

    view = client.get(_routes(saved.id or "")["view"], headers=headers())

    assert view.status_code == 200, view.text
    body = view.json()
    assert body["mode"] == "text"
    assert body["notice"] == "original_missing"
    assert body["original_available"] is False
    assert [segment["text"] for segment in body["segments"]] == ["The opening of an old document."]


def test_an_old_image_still_opens_from_its_preview(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    from app.core import attachment_previews

    monkeypatch.setattr(attachment_previews, "attachment_previews_dir", lambda: tmp_path)
    attachment = upload("receipt.png", _png(), "image/png")
    get_store().attachment_documents.delete_document(_ref(attachment["id"]))

    view = client.get(_routes(attachment["id"])["view"], headers=headers()).json()
    file = client.get(_routes(attachment["id"])["file"], headers=headers())

    assert view["mode"] == "image"
    assert view["original_available"] is False
    assert view["page_count"] == 1
    assert file.status_code == 200
    assert file.headers["content-type"] == "image/webp"


def test_a_file_that_cannot_be_read_still_uploads() -> None:
    attachment = upload("broken.pdf", b"%PDF-1.7 not really a pdf", "application/pdf")

    view = client.get(_routes(attachment["id"])["view"], headers=headers())

    assert view.status_code == 200
    assert view.json()["segments"] == []


def test_a_cloud_file_is_kept_the_same_way() -> None:
    store = get_store()
    attachment = store.save_chat_attachment(
        ChatAttachment(
            id="cloud-demo-1",
            tenant_id=store.users[OWNER].tenant_id,
            owner_user_id=OWNER,
            name="board.txt",
            size="1 KB",
            kind="Text",
            source_type="google_drive",
            source_uri="https://drive.example/board",
            status="attached",
        )
    )
    retain_attachment(store.attachment_documents, attachment, LONG_TEXT.encode())

    view = client.get(_routes("cloud-demo-1")["view"], headers=headers()).json()

    assert TAIL_FACT in "\n".join(segment["text"] for segment in view["segments"])


# ------------------------------------------------------------------ lifecycle


def _saved(attachment_id: str) -> ChatAttachment:
    attachment = get_store().chat_attachments.get(attachment_id)
    assert attachment is not None
    return attachment


def _ref(attachment_id: str):
    from app.core.attachment_documents import attachment_ref

    return attachment_ref(attachment_id)


def _kept(attachment_id: str) -> bool:
    return get_store().attachment_documents.path(_ref(attachment_id)) is not None


def test_hard_deleting_a_user_removes_their_files() -> None:
    attachment = upload("lease.pdf", _pdf(1), "application/pdf")
    assert _kept(attachment["id"])

    deleted = client.delete(f"/api/admin/users/{OWNER}", headers=headers("user-admin"))

    assert deleted.status_code == 200, deleted.text
    assert not _kept(attachment["id"])


def test_deleting_a_chat_removes_its_files() -> None:
    attachment = upload("lease.pdf", _pdf(1), "application/pdf")
    saved = client.put(
        "/api/chat/threads/thread-documents",
        headers=headers(),
        json={
            "title": "Synthetic",
            "model_id": "gpt-4o",
            "messages": [
                {
                    "id": "m1",
                    "role": "user",
                    "content": "See attached",
                    "createdAt": "Now",
                    "status": "ok",
                    "attachments": [attachment],
                }
            ],
        },
    )
    assert saved.status_code == 200, saved.text

    deleted = client.delete("/api/chat/threads/thread-documents", headers=headers())

    assert deleted.status_code == 200, deleted.text
    assert not _kept(attachment["id"])


def test_a_staged_file_can_be_taken_back_before_it_is_sent() -> None:
    attachment = upload("lease.pdf", _pdf(1), "application/pdf")

    removed = client.delete(f"/api/chat/attachments/{attachment['id']}", headers=headers())

    assert removed.status_code == 200, removed.text
    assert not _kept(attachment["id"])
    assert get_store().chat_attachments.get(attachment["id"]) is None
    assert client.get(_routes(attachment["id"])["view"], headers=headers()).status_code == 404


def test_a_file_already_in_a_chat_is_not_taken_back() -> None:
    attachment = upload("lease.pdf", _pdf(1), "application/pdf")
    client.put(
        "/api/chat/threads/thread-kept",
        headers=headers(),
        json={
            "title": "Synthetic",
            "model_id": "gpt-4o",
            "messages": [
                {
                    "id": "m1",
                    "role": "user",
                    "content": "See attached",
                    "createdAt": "Now",
                    "status": "ok",
                    "attachments": [attachment],
                }
            ],
        },
    )

    refused = client.delete(f"/api/chat/attachments/{attachment['id']}", headers=headers())

    assert refused.status_code == 409
    assert _kept(attachment["id"])


def test_only_the_owner_can_take_a_file_back() -> None:
    attachment = upload("lease.pdf", _pdf(1), "application/pdf")

    refused = client.delete(f"/api/chat/attachments/{attachment['id']}", headers=headers(STRANGER))

    assert refused.status_code == 404
    assert _kept(attachment["id"])


# ------------------------------------------------------------------- the model


def test_the_model_reads_past_the_opening_of_a_document(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider()
    seen: list = []
    mock_completion(monkeypatch, "Done.", seen)
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")

    complete([attachment["id"]], "Fill in the gaps of this document.")

    forwarded = json.dumps(seen[0], ensure_ascii=False)
    assert TAIL_FACT in forwarded


def test_a_cited_passage_is_a_source_that_opens_at_its_place(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider()
    seen: list = []
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")
    index = load_attachment_index(get_store().attachment_documents, _saved(attachment["id"]))
    assert index is not None
    total = len(index.passages)
    mock_completion(monkeypatch, f"The fee is four percent [K{total}].", seen)

    reply = complete([attachment["id"]], "What is the management fee?")

    cited = [item for item in reply["citations"] if item.get("k_index")]
    assert len(cited) == 1
    assert cited[0]["attachment_id"] == attachment["id"]
    assert cited[0]["chunk_id"] == index.passages[-1].id
    assert cited[0]["cited"] is True
    # The sentence the viewer marks, found inside the passage the reply cited.
    assert "ZEPHYRINE" in cited[0]["passage"]


def test_the_file_itself_stays_a_source_and_says_what_was_read(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider()
    mock_completion(monkeypatch, "No markers here.", [])
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")

    reply = complete([attachment["id"]], "Summarize this.")

    file_rows = [item for item in reply["citations"] if not item.get("k_index")]
    assert len(file_rows) == 1
    assert file_rows[0]["attachment_id"] == attachment["id"]
    assert "read in full" in file_rows[0]["snippet"]


def test_a_document_too_long_for_the_turn_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider()
    seen: list = []
    mock_completion(monkeypatch, "Done.", seen)
    monkeypatch.setattr("app.routes.chat.attachment_turn_budget", lambda _window: 3000)
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")

    reply = complete([attachment["id"]], "What is the ZEPHYRINE management fee?")

    forwarded = json.dumps(seen[0], ensure_ascii=False)
    assert "ZEPHYRINE" in forwarded  # Found by the question, not by position.
    assert "only part of this file" in forwarded
    file_row = next(item for item in reply["citations"] if not item.get("k_index"))
    assert "of " in file_row["snippet"] and "passages read" in file_row["snippet"]


def test_an_earlier_document_is_searched_for_a_follow_up(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider()
    seen: list = []
    mock_completion(monkeypatch, "Done.", seen)
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")

    reply = complete([], "What does it say about the ZEPHYRINE fee?", context_attachment_ids=[attachment["id"]])

    forwarded = json.dumps(seen[0], ensure_ascii=False)
    assert TAIL_FACT in forwarded
    # Only the passages the question names, never the whole file again.
    assert forwarded.count("ordinary building upkeep") < LONG_TEXT.count("ordinary building upkeep") / 2
    assert reply["citations"] == []


def test_an_earlier_document_that_does_not_bear_on_the_question_stays_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activate_provider()
    seen: list = []
    mock_completion(monkeypatch, "Done.", seen)
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")

    complete([], "Tell me a joke about penguins.", context_attachment_ids=[attachment["id"]])

    assert "ZEPHYRINE" not in json.dumps(seen[0], ensure_ascii=False)


def test_attached_text_is_held_to_the_input_filters(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider()
    seen: list = []
    mock_completion(monkeypatch, "Summary ready.", seen)
    attached = client.put(
        "/api/admin/model-access/gpt-4o/content-filters",
        json={"content_filter_ids": ["cf-preset-pii-hipaa"]},
        headers=headers("user-admin"),
    )
    assert attached.status_code == 200
    social = "078-05-1120"
    body = ("Ordinary clause text about shared parking.\n\n" * 200) + f"SSN {social}."
    attachment = upload("intake.txt", body.encode(), "text/plain")

    complete([attachment["id"]], "Summarize the attached intake.")

    forwarded = json.dumps(seen[0], ensure_ascii=False)
    assert social not in forwarded
    assert "[REDACTED · US Social Security number]" in forwarded


def test_the_audit_records_which_passages_never_their_text(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider()
    mock_completion(monkeypatch, "Done.", [])
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")

    complete([attachment["id"]], "Fill in the gaps.")

    assert "ZEPHYRINE" not in json.dumps(
        [event.model_dump(mode="json") for event in get_store().audit_events]
    )


def test_a_file_saved_before_indexing_still_gives_its_preview(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider()
    seen: list = []
    mock_completion(monkeypatch, "Done.", seen)
    store = get_store()
    store.save_chat_attachment(
        ChatAttachment(
            id="upload-legacy",
            tenant_id=store.users[OWNER].tenant_id,
            owner_user_id=OWNER,
            name="old.docx",
            size="10 KB",
            kind="Word",
            text_preview="The opening of an old document.",
        )
    )

    complete(["upload-legacy"], "What does this say?")

    assert "The opening of an old document." in json.dumps(seen[0], ensure_ascii=False)


def test_each_passage_goes_to_the_model_under_the_marker_its_citation_carries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activate_provider()
    seen: list = []
    attachment = upload("agreement.txt", LONG_TEXT.encode(), "text/plain")
    index = load_attachment_index(get_store().attachment_documents, _saved(attachment["id"]))
    assert index is not None
    last = len(index.passages)
    mock_completion(monkeypatch, f"Opening [K1]. Closing [K{last}].", seen)

    reply = complete([attachment["id"]], "Summarize this.")

    prompt = seen[0]["messages"][0]["content"]
    assert prompt.index("[K1]") < prompt.index(f"[K{last}]")
    assert TAIL_FACT not in prompt[: prompt.index(f"[K{last}]")]
    assert TAIL_FACT in prompt[prompt.index(f"[K{last}]") :]
    cited = {item["k_index"]: item["chunk_id"] for item in reply["citations"] if item.get("k_index")}
    assert cited == {1: index.passages[0].id, last: index.passages[-1].id}


def test_a_cloud_file_is_described_as_attached_not_uploaded(monkeypatch: pytest.MonkeyPatch) -> None:
    activate_provider()
    mock_completion(monkeypatch, "Done.", [])
    store = get_store()
    attachment = store.save_chat_attachment(
        ChatAttachment(
            id="cloud-demo-1",
            tenant_id=store.users[OWNER].tenant_id,
            owner_user_id=OWNER,
            name="board.txt",
            size="1 KB",
            kind="Text",
            source_type="google_drive",
            source_uri="https://drive.example/board",
            status="attached",
        )
    )
    retain_attachment(store.attachment_documents, attachment, b"Words about the board.")

    reply = complete(["cloud-demo-1"], "Summarize this.")

    file_row = next(item for item in reply["citations"] if not item.get("k_index"))
    assert file_row["snippet"] == "Attached Text file (1 KB), read in full."


def test_a_preview_built_from_the_index_is_the_file_not_its_properties() -> None:
    chunk = dict(
        knowledge_config_id="", document_id="a", tenant_id="t", source_name="a.pdf",
        source_uri="upload://a", source_type="upload", updated_at="now",
    )
    index = AttachmentIndex(
        [
            KnowledgeChunk(id="a:0", text="Body words.", **chunk),
            KnowledgeChunk(id="a:1", text="Document properties: x", locator=PROPERTIES_LOCATOR, **chunk),
        ],
        {},
    )

    assert _body_text(index) == "Body words."


def test_a_recording_is_indexed_from_its_transcript() -> None:
    store = get_store()
    attachment = store.save_chat_attachment(
        ChatAttachment(
            id="upload-call",
            tenant_id=store.users[OWNER].tenant_id,
            owner_user_id=OWNER,
            name="call.mp3",
            size="1 MB",
            kind="Audio",
            mime_type="audio/mpeg",
        )
    )

    retain_attachment(store.attachment_documents, attachment, b"\x00audio", transcript=LONG_TEXT)

    index = load_attachment_index(store.attachment_documents, attachment)
    assert index is not None
    assert TAIL_FACT in index.passages[-1].text


def test_an_attachment_with_no_id_keeps_nothing() -> None:
    store = get_store()
    attachment = ChatAttachment(name="loose.txt", size="1 KB", kind="Text")

    retain_attachment(store.attachment_documents, attachment, b"Words.")

    assert load_attachment_index(store.attachment_documents, attachment) is None


def test_a_rebuilt_index_is_ignored_when_its_format_is_unknown() -> None:
    store = get_store()
    attachment = upload("agreement.txt", b"Plain words here.", "text/plain")
    ref = _ref(attachment["id"])
    path = store.attachment_documents.derived(ref, "index.json")
    assert path is not None
    path.write_text(json.dumps({"version": 999, "passages": [{"nonsense": True}]}))

    assert load_attachment_index(store.attachment_documents, _saved(attachment["id"])) is None


def test_the_index_is_typed() -> None:
    attachment = upload("agreement.txt", b"Plain words here.", "text/plain")

    index = load_attachment_index(get_store().attachment_documents, _saved(attachment["id"]))

    assert isinstance(index, AttachmentIndex)
    assert index.passages[0].document_id == attachment["id"]
    assert index.passages[0].source_name == "agreement.txt"


# ----------------------------------------------------------- a whole-document edit


def _patch_prompt(document_text: str) -> str:
    return (
        f"{DOCUMENT_PATCH_PREFIX}\n"
        'The document is titled "Agreement".\n\n'
        "User instruction:\nFill in the gaps.\n\n"
        f"Document blocks:\n[1] {document_text}"
    )


def test_a_document_edit_does_not_mine_the_document_for_requirements(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    activate_provider()
    seen: list = []
    mock_completion(monkeypatch, "@@ end", seen)
    text = "Write a report of at least 25 pages."

    for content in (text, _patch_prompt(text)):
        response = client.post(
            "/api/chat/complete",
            headers=headers(),
            json={"model": "gpt-4o", "surface": "draft", "messages": [{"role": "user", "content": content}]},
        )
        assert response.status_code == 200, response.text

    # A fresh request's checklist can send a short reply back for another try.
    fresh, edit = seen[0]["messages"][0]["content"], seen[-1]["messages"][0]["content"]
    assert "25" in fresh
    assert "25" not in edit


def test_a_document_edit_searches_on_its_instruction_not_the_document() -> None:
    request = ChatCompletionRequest(
        model="gpt-4o",
        surface="draft",
        messages=[{"role": "user", "content": _patch_prompt("Every word of a long agreement.")}],
    )

    assert document_patch_instruction(request) == "Fill in the gaps."


def test_only_a_draft_surface_prompt_counts_as_a_document_edit() -> None:
    request = ChatCompletionRequest(
        model="gpt-4o",
        surface="chat",
        messages=[{"role": "user", "content": _patch_prompt("Pasted text.")}],
    )

    assert document_patch_instruction(request) is None
