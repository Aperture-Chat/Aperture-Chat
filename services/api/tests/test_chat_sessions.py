from __future__ import annotations

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayRoute
from app.main import app
from app.models.schemas import Role, User
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def test_chat_thread_route_is_sql_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    json_saves: list[bool] = []
    monkeypatch.setattr(
        store,
        "save_runtime_state",
        lambda urgent=False: json_saves.append(urgent),
    )

    response = client.put(
        "/api/chat/threads/thread-sql-only",
        json={
            "title": "SQL-owned chat",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [],
        },
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    assert store.chat_threads["thread-sql-only"].title == "SQL-owned chat"
    assert store.audit_events[-1].action == "chat.thread_saved"
    assert json_saves == []


def test_user_can_save_and_list_owned_chat_thread() -> None:
    response = client.put(
        "/api/chat/threads/thread-jane-nda",
        json={
            "tenant_id": "tenant-example",
            "title": "Draft an NDA summary",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "pinned": False,
            "archived": True,
            "folder_id": "folder-risk-review",
            "used_agent": True,
            "updated_at": "Just now",
            "messages": [
                {
                    "id": "msg-user",
                    "role": "user",
                    "content": "Draft an NDA summary",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                    "attachments": [{"name": "nda.pdf", "size": "20 KB", "kind": "PDF"}],
                },
                {
                    "id": "msg-assistant",
                    "role": "assistant",
                    "content": "Here is the summary.",
                    "createdAt": "10:01 AM",
                    "status": "ok",
                },
            ],
        },
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    saved = response.json()
    assert saved["owner_user_id"] == "user-jane"
    assert saved["archived"] is True
    assert saved["folder_id"] == "folder-risk-review"
    assert saved["messages"][0]["attachments"][0]["name"] == "nda.pdf"
    assert saved["messages"][0]["createdAtIso"]
    assert saved["messages"][1]["executedAt"] == saved["messages"][1]["createdAtIso"]
    datetime.fromisoformat(saved["messages"][1]["completedAt"])

    list_response = client.get("/api/chat/threads", headers=headers("user-jane"))
    assert list_response.status_code == 200
    assert list_response.json()[0]["id"] == "thread-jane-nda"
    assert list_response.json()[0]["messages"][1]["content"] == "Here is the summary."

    sessions_response = client.get("/api/chat/sessions", headers=headers("user-jane"))
    assert sessions_response.status_code == 200
    session = sessions_response.json()[0]
    assert session["id"] == "thread-jane-nda"
    assert session["archived"] is True
    assert session["folder_id"] == "folder-risk-review"
    assert "messages" not in session

    actions = [event.action for event in get_store().audit_events]
    assert actions[-1] == "chat.thread_saved"
    latest = get_store().audit_events[-1]
    assert latest.metadata["message_clock_fields"][1]["executedAt"] == saved["messages"][1]["executedAt"]
    assert latest.metadata["thread_updated_at"] == saved["updated_at"]


def test_user_can_rename_chat_without_rewriting_conversation() -> None:
    create_response = client.put(
        "/api/chat/threads/thread-jane-rename",
        json={
            "tenant_id": "tenant-example",
            "title": "Original generated title",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "pinned": True,
            "archived": False,
            "folder_id": "folder-risk-review",
            "used_agent": True,
            "messages": [
                {
                    "id": "msg-user",
                    "role": "user",
                    "content": "Keep this question intact.",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                },
                {
                    "id": "msg-assistant",
                    "role": "assistant",
                    "content": "Keep this useful answer intact.",
                    "createdAt": "10:01 AM",
                    "status": "ok",
                },
            ],
        },
        headers=headers("user-jane"),
    )
    assert create_response.status_code == 200
    before = create_response.json()

    rename_response = client.patch(
        "/api/chat/threads/thread-jane-rename/title",
        json={"title": "  Artemis II research paper  "},
        headers=headers("user-jane"),
    )

    assert rename_response.status_code == 200
    renamed = rename_response.json()
    assert renamed["title"] == "Artemis II research paper"
    for field in (
        "id",
        "tenant_id",
        "owner_user_id",
        "model_id",
        "group_id",
        "pinned",
        "archived",
        "folder_id",
        "used_agent",
        "messages",
    ):
        assert renamed[field] == before[field]

    session = next(
        item
        for item in client.get("/api/chat/sessions", headers=headers("user-jane")).json()
        if item["id"] == "thread-jane-rename"
    )
    assert session["title"] == "Artemis II research paper"

    latest = get_store().audit_events[-1]
    assert latest.action == "chat.thread_renamed"
    assert latest.metadata["previous_title"] == "Original generated title"
    assert latest.metadata["title"] == "Artemis II research paper"


def test_chat_rename_is_owner_scoped_and_rejects_invalid_titles() -> None:
    create_response = client.put(
        "/api/chat/threads/thread-jane-private-rename",
        json={
            "title": "Jane's private chat",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [],
        },
        headers=headers("user-jane"),
    )
    assert create_response.status_code == 200

    blocked = client.patch(
        "/api/chat/threads/thread-jane-private-rename/title",
        json={"title": "Casey's title"},
        headers=headers("user-casey"),
    )
    assert blocked.status_code == 403
    assert get_store().chat_threads["thread-jane-private-rename"].title == "Jane's private chat"

    blank = client.patch(
        "/api/chat/threads/thread-jane-private-rename/title",
        json={"title": "   "},
        headers=headers("user-jane"),
    )
    assert blank.status_code == 422
    assert blank.json()["detail"] == "Chat title cannot be blank."

    too_long = client.patch(
        "/api/chat/threads/thread-jane-private-rename/title",
        json={"title": "x" * 161},
        headers=headers("user-jane"),
    )
    assert too_long.status_code == 422

    missing = client.patch(
        "/api/chat/threads/thread-missing/title",
        json={"title": "Nothing to rename"},
        headers=headers("user-jane"),
    )
    assert missing.status_code == 404


def _configured_test_route(_store, _model, *, tenant_id: str | None) -> ModelGatewayRoute:
    assert tenant_id == "tenant-example"
    return ModelGatewayRoute(
        provider_id="provider-test",
        provider_name="Test Provider",
        provider_kind="openai-compatible",
        auth_type="bearer",
        upstream_model="gpt-4o-mini",
        base_url="https://provider.invalid/v1",
        configured=True,
        status_message="Configured",
        secret_value="test-only-secret",
    )


def test_ai_title_generation_renames_thread_from_latest_exchange(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    create_response = client.put(
        "/api/chat/threads/thread-jane-ai-title",
        json={
            "title": "New chat",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "msg-ai-title-1",
                    "role": "user",
                    "content": "Research the Artemis II mission timeline.",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                },
                {
                    "id": "msg-ai-title-2",
                    "role": "assistant",
                    "content": "Here is the mission timeline overview.",
                    "createdAt": "10:01 AM",
                    "status": "ok",
                },
                {
                    "id": "msg-ai-title-3",
                    "role": "user",
                    "content": "Switch topics: draft a vendor NDA checklist.",
                    "createdAt": "10:02 AM",
                    "status": "ok",
                },
                {
                    "id": "msg-ai-title-4",
                    "role": "assistant",
                    "content": "Vendor NDA checklist: parties, term, remedies.",
                    "createdAt": "10:03 AM",
                    "status": "ok",
                },
            ],
        },
        headers=headers("user-jane"),
    )
    assert create_response.status_code == 200

    calls: list[dict[str, object]] = []

    class FakeGateway:
        def complete(self, **kwargs: object) -> dict[str, object]:
            calls.append(kwargs)
            return {
                "id": "gen-ai-title",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": ' "Vendor NDA Checklist Drafting." ',
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 120, "completion_tokens": 6, "total_tokens": 126},
            }

    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _configured_test_route)
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: FakeGateway())

    response = client.post(
        "/api/chat/threads/thread-jane-ai-title/title/generate",
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    assert response.json()["title"] == "Vendor NDA Checklist Drafting"
    assert get_store().chat_threads["thread-jane-ai-title"].title == "Vendor NDA Checklist Drafting"

    assert len(calls) == 1
    assert calls[0]["max_tokens"] == 60
    prompt = calls[0]["messages"][-1]["content"]
    assert "Most recent exchange" in prompt
    # The newest exchange sits in its own trailing section so it outweighs
    # the topic the conversation started with.
    assert prompt.index("vendor NDA checklist") > prompt.index("Artemis II")

    latest = get_store().audit_events[-1]
    assert latest.action == "chat.thread_renamed"
    assert latest.metadata["previous_title"] == "New chat"
    assert latest.metadata["title"] == "Vendor NDA Checklist Drafting"
    assert latest.metadata["source"] == "ai_suggestion"
    assert latest.metadata["model_id"] == "gpt-4o-mini"


def test_ai_title_generation_keeps_messages_added_while_request_was_in_flight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    create_response = client.put(
        "/api/chat/threads/thread-jane-ai-title-race",
        json={
            "title": "New chat",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "msg-race-1",
                    "role": "user",
                    "content": "Summarize the Artemis II mission goals.",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                },
                {
                    "id": "msg-race-2",
                    "role": "assistant",
                    "content": "Artemis II is a crewed lunar flyby.",
                    "createdAt": "10:01 AM",
                    "status": "ok",
                },
            ],
        },
        headers=headers("user-jane"),
    )
    assert create_response.status_code == 200

    class SlowGateway:
        def complete(self, **kwargs: object) -> dict[str, object]:
            # While the provider call is in flight, the user completes a
            # second exchange in the same thread.
            store = get_store()
            in_flight = store.chat_threads["thread-jane-ai-title-race"]
            second_user = in_flight.messages[0].model_copy(
                update={"id": "msg-race-3", "content": "Now list the crew members."}
            )
            second_assistant = in_flight.messages[1].model_copy(
                update={"id": "msg-race-4", "content": "The crew is Wiseman, Glover, Koch, Hansen."}
            )
            store.save_chat_thread(
                in_flight.model_copy(
                    update={"messages": [*in_flight.messages, second_user, second_assistant]}
                )
            )
            return {
                "id": "gen-ai-title-race",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Artemis II Mission Goals"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 80, "completion_tokens": 5, "total_tokens": 85},
            }

    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _configured_test_route)
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: SlowGateway())

    response = client.post(
        "/api/chat/threads/thread-jane-ai-title-race/title/generate",
        params={"expected_title": "New chat"},
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    saved = get_store().chat_threads["thread-jane-ai-title-race"]
    assert saved.title == "Artemis II Mission Goals"
    # The exchange completed during title generation must survive the rename.
    assert [message.id for message in saved.messages] == [
        "msg-race-1",
        "msg-race-2",
        "msg-race-3",
        "msg-race-4",
    ]


def test_automatic_ai_title_does_not_overwrite_a_newer_manual_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    create_response = client.put(
        "/api/chat/threads/thread-jane-ai-title-guard",
        json={
            "title": "Artemis paper prompt fallback",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "msg-ai-title-guard-user",
                    "role": "user",
                    "content": "Create a paper about the Artemis II mission.",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                },
                {
                    "id": "msg-ai-title-guard-assistant",
                    "role": "assistant",
                    "content": "Here is the Artemis II research paper.",
                    "createdAt": "10:01 AM",
                    "status": "ok",
                },
            ],
        },
        headers=headers("user-jane"),
    )
    assert create_response.status_code == 200

    rename_response = client.patch(
        "/api/chat/threads/thread-jane-ai-title-guard/title",
        json={"title": "My Artemis Mission Research"},
        headers=headers("user-jane"),
    )
    assert rename_response.status_code == 200

    class ExplodingGateway:
        def complete(self, **kwargs: object) -> dict[str, object]:
            raise AssertionError("A stale automatic title must not call the provider.")

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: ExplodingGateway())

    response = client.post(
        "/api/chat/threads/thread-jane-ai-title-guard/title/generate",
        params={"expected_title": "Artemis paper prompt fallback"},
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    assert response.json()["title"] == "My Artemis Mission Research"
    assert get_store().chat_threads["thread-jane-ai-title-guard"].title == "My Artemis Mission Research"


def test_ai_title_generation_requires_completed_reply_and_owner_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    create_response = client.put(
        "/api/chat/threads/thread-jane-ai-title-pending",
        json={
            "title": "New chat",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [
                {
                    "id": "msg-ai-pending-1",
                    "role": "user",
                    "content": "First question.",
                    "createdAt": "10:00 AM",
                    "status": "ok",
                },
                {
                    "id": "msg-ai-pending-2",
                    "role": "assistant",
                    "content": "Half-written reply",
                    "createdAt": "10:01 AM",
                    "status": "pending",
                },
            ],
        },
        headers=headers("user-jane"),
    )
    assert create_response.status_code == 200

    class ExplodingGateway:
        def complete(self, **kwargs: object) -> dict[str, object]:
            raise AssertionError("The provider must not be called for unfinished chats.")

    monkeypatch.setattr("app.routes.chat._resolve_gateway_route", _configured_test_route)
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: ExplodingGateway())

    blocked = client.post(
        "/api/chat/threads/thread-jane-ai-title-pending/title/generate",
        headers=headers("user-casey"),
    )
    assert blocked.status_code == 403

    unfinished = client.post(
        "/api/chat/threads/thread-jane-ai-title-pending/title/generate",
        headers=headers("user-jane"),
    )
    assert unfinished.status_code == 422
    assert unfinished.json()["detail"] == "AI naming needs at least one completed reply in this chat."
    assert get_store().chat_threads["thread-jane-ai-title-pending"].title == "New chat"

    missing = client.post(
        "/api/chat/threads/thread-missing/title/generate",
        headers=headers("user-jane"),
    )
    assert missing.status_code == 404


def test_chat_threads_are_owner_scoped() -> None:
    create_response = client.put(
        "/api/chat/threads/thread-private",
        json={
            "title": "Private matter",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [],
        },
        headers=headers("user-jane"),
    )
    assert create_response.status_code == 200

    list_response = client.get("/api/chat/threads", headers=headers("user-casey"))
    assert list_response.status_code == 200
    assert list_response.json() == []

    overwrite_response = client.put(
        "/api/chat/threads/thread-private",
        json={
            "title": "Overwrite attempt",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [],
        },
        headers=headers("user-casey"),
    )
    assert overwrite_response.status_code == 403
    assert overwrite_response.json()["detail"] == "Chat thread is out of scope."


def test_platform_owner_archives_and_folders_remain_personal() -> None:
    store = get_store()
    store.users["user-owner-two"] = User(
        id="user-owner-two",
        email="owner-two@aperture.local",
        display_name="Second Platform Owner",
        role=Role.PLATFORM_OWNER,
        auth_method="local",
    )

    for owner_id, suffix in (("user-owner", "one"), ("user-owner-two", "two")):
        thread_response = client.put(
            f"/api/chat/threads/thread-owner-{suffix}",
            json={
                "tenant_id": "tenant-example",
                "title": f"Owner {suffix} archived matter",
                "model_id": "gpt-4o-mini",
                "group_id": "group-litigation",
                "archived": True,
                "messages": [],
            },
            headers=headers(owner_id),
        )
        assert thread_response.status_code == 200

        folder_response = client.put(
            "/api/chat/folders",
            json={
                "id": f"folder-owner-{suffix}",
                "tenant_id": "tenant-example",
                "name": f"Owner {suffix} folder",
            },
            headers=headers(owner_id),
        )
        assert folder_response.status_code == 200

    owner_one_threads = client.get(
        "/api/chat/threads", headers=headers("user-owner")
    )
    assert owner_one_threads.status_code == 200
    assert [thread["id"] for thread in owner_one_threads.json()] == [
        "thread-owner-one"
    ]
    assert owner_one_threads.json()[0]["archived"] is True

    owner_one_sessions = client.get(
        "/api/chat/sessions", headers=headers("user-owner")
    )
    assert [session["id"] for session in owner_one_sessions.json()] == [
        "thread-owner-one"
    ]
    owner_one_folders = client.get(
        "/api/chat/folders", headers=headers("user-owner")
    )
    assert [folder["id"] for folder in owner_one_folders.json()] == [
        "folder-owner-one"
    ]

    owner_two_threads = client.get(
        "/api/chat/threads", headers=headers("user-owner-two")
    )
    assert [thread["id"] for thread in owner_two_threads.json()] == [
        "thread-owner-two"
    ]

    blocked_restore = client.put(
        "/api/chat/threads/thread-owner-two",
        json={
            "tenant_id": "tenant-example",
            "title": "Cross-owner restore attempt",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "archived": False,
            "messages": [],
        },
        headers=headers("user-owner"),
    )
    assert blocked_restore.status_code == 403
    assert blocked_restore.json()["detail"] == "Chat thread is out of scope."

    blocked_delete = client.delete(
        "/api/chat/threads/thread-owner-two", headers=headers("user-owner")
    )
    assert blocked_delete.status_code == 403
    assert store.chat_threads["thread-owner-two"].archived is True

    blocked_folder_delete = client.delete(
        "/api/chat/folders/folder-owner-two", headers=headers("user-owner")
    )
    assert blocked_folder_delete.status_code == 403
    assert "folder-owner-two" in store.chat_folders


def test_owner_can_permanently_delete_chat_thread() -> None:
    create_response = client.put(
        "/api/chat/threads/thread-jane-old",
        json={
            "title": "Old archived matter",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "archived": True,
            "messages": [],
        },
        headers=headers("user-jane"),
    )
    assert create_response.status_code == 200

    delete_response = client.delete(
        "/api/chat/threads/thread-jane-old", headers=headers("user-jane")
    )
    assert delete_response.status_code == 200
    assert delete_response.json() == {"status": "deleted", "id": "thread-jane-old"}

    list_response = client.get("/api/chat/threads", headers=headers("user-jane"))
    assert all(thread["id"] != "thread-jane-old" for thread in list_response.json())

    sessions_response = client.get("/api/chat/sessions", headers=headers("user-jane"))
    assert all(session["id"] != "thread-jane-old" for session in sessions_response.json())

    latest = get_store().audit_events[-1]
    assert latest.action == "chat.thread_deleted"
    assert latest.metadata["title"] == "Old archived matter"
    assert latest.metadata["archived"] is True

    missing_response = client.delete(
        "/api/chat/threads/thread-jane-old", headers=headers("user-jane")
    )
    assert missing_response.status_code == 404


def test_chat_thread_delete_is_owner_scoped() -> None:
    create_response = client.put(
        "/api/chat/threads/thread-jane-keep",
        json={
            "title": "Keep this",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": [],
        },
        headers=headers("user-jane"),
    )
    assert create_response.status_code == 200

    delete_response = client.delete(
        "/api/chat/threads/thread-jane-keep", headers=headers("user-casey")
    )
    assert delete_response.status_code == 403
    assert delete_response.json()["detail"] == "Chat thread is out of scope."

    list_response = client.get("/api/chat/threads", headers=headers("user-jane"))
    assert list_response.json()[0]["id"] == "thread-jane-keep"


def test_chat_thread_save_validates_model_and_group_access() -> None:
    get_store().users["user-casey"].group_ids = ["group-finance"]

    group_response = client.put(
        "/api/chat/threads/thread-bad-group",
        json={
            "title": "Out of group",
            "model_id": "gpt-4.1",
            "group_id": "group-litigation",
            "messages": [],
        },
        headers=headers("user-casey"),
    )
    assert group_response.status_code == 403
    assert group_response.json()["detail"] == "Chat thread group is out of scope."

    model_response = client.put(
        "/api/chat/threads/thread-bad-model",
        json={
            "title": "Out of model",
            "model_id": "gpt-4o-mini",
            "group_id": "group-finance",
            "messages": [],
        },
        headers=headers("user-casey"),
    )
    assert model_response.status_code == 403
    assert "Model access is restricted" in model_response.json()["detail"]


def test_chat_folder_crud_is_owner_scoped_and_delete_unfiles_threads() -> None:
    create_folder = client.put(
        "/api/chat/folders",
        json={
            "id": "folder-jane-matter",
            "name": "  Matter planning  ",
            "created_at": "2026-07-09T12:00:00Z",
        },
        headers=headers("user-jane"),
    )
    assert create_folder.status_code == 200
    assert create_folder.json()["name"] == "Matter planning"
    assert create_folder.json()["owner_user_id"] == "user-jane"

    create_thread = client.put(
        "/api/chat/threads/thread-jane-foldered",
        json={
            "title": "Foldered matter",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "folder_id": "folder-jane-matter",
            "messages": [],
        },
        headers=headers("user-jane"),
    )
    assert create_thread.status_code == 200

    jane_folders = client.get("/api/chat/folders", headers=headers("user-jane"))
    assert jane_folders.status_code == 200
    assert [folder["id"] for folder in jane_folders.json()] == ["folder-jane-matter"]

    casey_folders = client.get("/api/chat/folders", headers=headers("user-casey"))
    assert casey_folders.status_code == 200
    assert casey_folders.json() == []

    blocked_delete = client.delete(
        "/api/chat/folders/folder-jane-matter",
        headers=headers("user-casey"),
    )
    assert blocked_delete.status_code == 403
    assert blocked_delete.json()["detail"] == "Chat folder is out of scope."

    deleted = client.delete(
        "/api/chat/folders/folder-jane-matter",
        headers=headers("user-jane"),
    )
    assert deleted.status_code == 200
    assert deleted.json()["cleared_thread_ids"] == ["thread-jane-foldered"]

    thread = client.get("/api/chat/threads", headers=headers("user-jane")).json()[0]
    assert thread["folder_id"] is None
    session = client.get("/api/chat/sessions", headers=headers("user-jane")).json()[0]
    assert session["folder_id"] is None
    assert client.get("/api/chat/folders", headers=headers("user-jane")).json() == []
