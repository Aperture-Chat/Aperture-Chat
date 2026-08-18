"""Server-side chat response feedback with optional comments.

Uses the seeded demo store through the app like the other route suites.
All data is synthetic.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import ChatMessage, ChatThread
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _save_thread(store, thread_id: str, owner: str, tenant_id: str) -> None:
    store.save_chat_thread(
        ChatThread(
            id=thread_id,
            tenant_id=tenant_id,
            owner_user_id=owner,
            title="Synthetic feedback thread",
            model_id="model-synthetic",
            group_id="group-synthetic",
            updated_at="Just now",
            messages=[
                ChatMessage(
                    id="msg-reply",
                    role="assistant",
                    content="   The   agreement   looks   fine. " + "x" * 400,
                    createdAt="10:00 AM",
                )
            ],
        )
    )


def test_feedback_upserts_and_keeps_note_across_rating_changes() -> None:
    store = get_store()
    jane = store.users["user-jane"]
    _save_thread(store, "thread-fb", jane.id, jane.tenant_id)

    response = client.post(
        "/api/chat/feedback",
        headers=headers(jane.id),
        json={"thread_id": "thread-fb", "message_id": "msg-reply", "rating": "negative"},
    )
    assert response.status_code == 200
    record = response.json()
    assert record["rating"] == "negative"
    assert record["comment"] == ""
    # The server's own copy of the response text becomes the preview,
    # whitespace-collapsed and bounded.
    assert record["message_preview"].startswith("The agreement looks fine.")
    assert len(record["message_preview"]) <= 280
    assert record["thread_title"] == "Synthetic feedback thread"

    response = client.post(
        "/api/chat/feedback",
        headers=headers(jane.id),
        json={
            "thread_id": "thread-fb",
            "message_id": "msg-reply",
            "rating": "negative",
            "comment": "It cited the wrong clause.",
        },
    )
    assert response.status_code == 200
    assert response.json()["comment"] == "It cited the wrong clause."

    # Flipping the rating without a comment keeps the note.
    response = client.post(
        "/api/chat/feedback",
        headers=headers(jane.id),
        json={"thread_id": "thread-fb", "message_id": "msg-reply", "rating": "positive"},
    )
    assert response.status_code == 200
    flipped = response.json()
    assert flipped["rating"] == "positive"
    assert flipped["comment"] == "It cited the wrong clause."

    # One row per (user, message).
    assert len(store.list_chat_feedback(tenant_id=jane.tenant_id)) == 1
    actions = [event.action for event in store.audit_events_newest_first(limit=5)]
    assert "chat.feedback_submitted" in actions


def test_feedback_on_unsaved_thread_uses_client_fallback_context() -> None:
    store = get_store()
    jane = store.users["user-jane"]
    response = client.post(
        "/api/chat/feedback",
        headers=headers(jane.id),
        json={
            "thread_id": "thread-not-saved-yet",
            "message_id": "msg-fresh",
            "rating": "negative",
            "comment": "Too vague.",
            "message_preview": "A fresh reply the client has not saved yet.",
            "thread_title": "Brand new chat",
            "model_id": "model-synthetic",
        },
    )
    assert response.status_code == 200
    record = response.json()
    assert record["tenant_id"] == jane.tenant_id
    assert record["thread_title"] == "Brand new chat"
    assert record["message_preview"] == "A fresh reply the client has not saved yet."


def test_feedback_is_rejected_on_someone_elses_chat() -> None:
    store = get_store()
    jane = store.users["user-jane"]
    _save_thread(store, "thread-owned-by-jane", jane.id, jane.tenant_id)
    response = client.post(
        "/api/chat/feedback",
        headers=headers("user-casey"),
        json={
            "thread_id": "thread-owned-by-jane",
            "message_id": "msg-reply",
            "rating": "positive",
        },
    )
    assert response.status_code == 403


def test_admin_feedback_list_scopes_visibility() -> None:
    store = get_store()
    jane = store.users["user-jane"]
    owner = store.users["user-owner"]
    _save_thread(store, "thread-fb-jane", jane.id, jane.tenant_id)
    client.post(
        "/api/chat/feedback",
        headers=headers(jane.id),
        json={
            "thread_id": "thread-fb-jane",
            "message_id": "msg-reply",
            "rating": "negative",
            "comment": "Missed the point.",
        },
    )
    # Owner feedback lands in the same tenant but stays hidden from admins.
    client.post(
        "/api/chat/feedback",
        headers=headers(owner.id),
        json={
            "thread_id": "thread-owner-chat",
            "message_id": "msg-owner",
            "rating": "positive",
            "thread_title": "Owner chat",
        },
    )

    response = client.get("/api/admin/chat-feedback", headers=headers("user-admin"))
    assert response.status_code == 200
    admin_rows = response.json()
    assert [row["user_id"] for row in admin_rows] == [jane.id]
    assert admin_rows[0]["comment"] == "Missed the point."

    response = client.get("/api/admin/chat-feedback", headers=headers(owner.id))
    assert response.status_code == 200
    assert {row["user_id"] for row in response.json()} == {jane.id, owner.id}

    response = client.get("/api/chat-feedback", headers=headers(jane.id))
    assert response.status_code in (403, 404, 405)
    response = client.get("/api/admin/chat-feedback", headers=headers(jane.id))
    assert response.status_code == 403


def test_feedback_preview_strips_markdown_decoration() -> None:
    from app.routes.chat import _feedback_preview

    raw = (
        "## Heading\n\n**Bold** and _italic_ with `code` and [a link](https://x)\n"
        "```python\nprint('hi')\n```\n- bullet | cell\n> quoted"
    )
    preview = _feedback_preview(raw)
    assert "**" not in preview
    assert "`" not in preview
    assert "#" not in preview
    assert "](" not in preview
    assert "|" not in preview
    assert "Bold and italic with code and a link" in preview
    assert "Heading" in preview
    assert "quoted" in preview
