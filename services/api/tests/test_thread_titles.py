"""Conversation names for the runtime log, under the prompt-activity access rules."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import ChatThread
from app.repositories.deps import get_store

client = TestClient(app)
SSN = "123-45-6789"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def add_thread(thread_id: str, owner_id: str, title: str, tenant_id: str | None = None) -> None:
    store = get_store()
    owner = store.users[owner_id]
    store.chat_threads[thread_id] = ChatThread(
        id=thread_id,
        tenant_id=tenant_id or owner.tenant_id or store.users["user-jane"].tenant_id,
        owner_user_id=owner_id,
        title=title,
        model_id="gpt-4o",
        group_id="",
        updated_at="Just now",
    )


def titles(path: str, user_id: str, *thread_ids: str) -> dict[str, str]:
    response = client.get(path, params={"thread_id": list(thread_ids)}, headers=headers(user_id))
    assert response.status_code == 200
    return response.json()


def test_owner_gets_titles_for_every_user_and_nothing_for_unknown_threads() -> None:
    add_thread("thread-jane", "user-jane", "Lease review")
    add_thread("thread-owner", "user-owner", "Owner review")
    assert titles("/api/platform/thread-titles", "user-owner", "thread-jane", "thread-owner", "thread-gone") == {
        "thread-jane": "Lease review",
        "thread-owner": "Owner review",
    }


def test_admin_never_sees_a_platform_owners_title() -> None:
    add_thread("thread-jane", "user-jane", "Lease review")
    add_thread("thread-owner", "user-owner", "Owner private review")
    assert titles("/api/admin/thread-titles", "user-admin", "thread-jane", "thread-owner") == {
        "thread-jane": "Lease review"
    }


def test_admin_never_sees_another_organizations_title() -> None:
    add_thread("thread-other", "user-jane", "Other organization", tenant_id="tenant-elsewhere")
    assert titles("/api/admin/thread-titles", "user-admin", "thread-other") == {}


def test_regular_users_cannot_use_either_lookup() -> None:
    add_thread("thread-jane", "user-jane", "Lease review")
    for path in ("/api/admin/thread-titles", "/api/platform/thread-titles"):
        response = client.get(path, params={"thread_id": "thread-jane"}, headers=headers("user-jane"))
        assert response.status_code == 403, path
    response = client.get(
        "/api/platform/thread-titles", params={"thread_id": "thread-jane"}, headers=headers("user-admin")
    )
    assert response.status_code == 403


def test_a_title_saved_before_protection_was_on_is_concealed() -> None:
    add_thread("thread-legacy", "user-jane", f"SSN {SSN}")
    enabled = client.patch(
        "/api/admin/privacy/policy", json={"enabled": True}, headers=headers("user-admin")
    )
    assert enabled.status_code == 200
    title = titles("/api/admin/thread-titles", "user-admin", "thread-legacy")["thread-legacy"]
    assert SSN not in title


def test_the_lookup_is_bounded() -> None:
    response = client.get(
        "/api/platform/thread-titles",
        params={"thread_id": [f"thread-{index}" for index in range(501)]},
        headers=headers("user-owner"),
    )
    assert response.status_code == 422


def test_no_ids_is_an_empty_answer() -> None:
    assert titles("/api/platform/thread-titles", "user-owner") == {}
