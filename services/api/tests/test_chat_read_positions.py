"""Server-side chat read positions keep unread indicators consistent across browsers."""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.chat_read import later_read_marker
from app.db.engine import alembic_config, create_application_engine, upgrade_database
from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _message(message_id: str, role: str, content: str) -> dict[str, object]:
    return {"id": message_id, "role": role, "content": content, "createdAt": "10:00 AM", "status": "ok"}


def _save(thread_id: str, messages: list[dict[str, object]], **extra: object) -> dict[str, object]:
    response = client.put(
        f"/api/chat/threads/{thread_id}",
        json={
            "title": "Synthetic read position",
            "model_id": "gpt-4o-mini",
            "group_id": "group-litigation",
            "messages": messages,
            **extra,
        },
        headers=headers("user-jane"),
    )
    assert response.status_code == 200, response.text
    return response.json()


def _listed(thread_id: str) -> dict[str, object]:
    threads = client.get("/api/chat/threads", headers=headers("user-jane")).json()
    return next(thread for thread in threads if thread["id"] == thread_id)


def test_later_read_marker_only_moves_forward() -> None:
    ids = ["m1", "m2", "m3"]
    assert later_read_marker(ids, None, "m2") == "m2"
    assert later_read_marker(ids, "m2", "m3") == "m3"
    assert later_read_marker(ids, "m3", "m1") == "m3"
    assert later_read_marker(ids, "m2", None) == "m2"
    # Unknown incoming ids never replace a real position.
    assert later_read_marker(ids, "m2", "missing") == "m2"
    # A stored marker whose message is gone yields to one that exists.
    assert later_read_marker(ids, "gone", "m1") == "m1"


def test_new_threads_start_unread_and_marking_read_is_remembered_for_every_browser() -> None:
    saved = _save("thread-read-new", [_message("u1", "user", "Question"), _message("a1", "assistant", "Answer")])
    assert saved["last_read_message_id"] is None

    response = client.put(
        "/api/chat/threads/thread-read-new/read",
        json={"message_id": "a1"},
        headers=headers("user-jane"),
    )
    assert response.status_code == 200
    assert response.json() == {"thread_id": "thread-read-new", "last_read_message_id": "a1"}
    # Another browser loading the list sees the same read position.
    assert _listed("thread-read-new")["last_read_message_id"] == "a1"


def test_marking_read_never_reorders_or_touches_the_thread_clock() -> None:
    _save("thread-read-older", [_message("u1", "user", "Older"), _message("a1", "assistant", "Older reply")])
    _save("thread-read-newer", [_message("u2", "user", "Newer"), _message("a2", "assistant", "Newer reply")])
    store = get_store()
    before = store.chat_threads["thread-read-older"]
    order_before = [thread["id"] for thread in client.get("/api/chat/threads", headers=headers("user-jane")).json()]

    client.put("/api/chat/threads/thread-read-older/read", json={"message_id": "a1"}, headers=headers("user-jane"))

    after = store.chat_threads["thread-read-older"]
    assert after.updated_at == before.updated_at
    assert after.messages == before.messages
    order_after = [thread["id"] for thread in client.get("/api/chat/threads", headers=headers("user-jane")).json()]
    assert order_after == order_before


def test_stale_saves_and_reads_cannot_move_the_position_backwards() -> None:
    messages = [
        _message("u1", "user", "First"),
        _message("a1", "assistant", "First reply"),
        _message("u2", "user", "Second"),
        _message("a2", "assistant", "Second reply"),
    ]
    _save("thread-read-stale", messages, last_read_message_id="a2")

    # A browser with an older copy saves (for example, pinning the chat).
    saved = _save("thread-read-stale", messages, pinned=True, last_read_message_id="a1")
    assert saved["last_read_message_id"] == "a2"
    saved = _save("thread-read-stale", messages, pinned=False)
    assert saved["last_read_message_id"] == "a2"

    stale = client.put(
        "/api/chat/threads/thread-read-stale/read",
        json={"message_id": "a1"},
        headers=headers("user-jane"),
    )
    assert stale.json()["last_read_message_id"] == "a2"


def test_a_save_carries_a_read_that_raced_ahead_of_it() -> None:
    _save("thread-read-race", [_message("u1", "user", "Question")])
    # The reply is visible in the browser before its save lands on the server.
    early = client.put(
        "/api/chat/threads/thread-read-race/read",
        json={"message_id": "a1"},
        headers=headers("user-jane"),
    )
    assert early.status_code == 409

    saved = _save(
        "thread-read-race",
        [_message("u1", "user", "Question"), _message("a1", "assistant", "Answer")],
        last_read_message_id="a1",
    )
    assert saved["last_read_message_id"] == "a1"


def test_read_positions_are_personal() -> None:
    _save("thread-read-private", [_message("u1", "user", "Mine"), _message("a1", "assistant", "Reply")])

    for other in ("user-casey", "user-owner"):
        response = client.put(
            "/api/chat/threads/thread-read-private/read",
            json={"message_id": "a1"},
            headers=headers(other),
        )
        assert response.status_code == 403
    missing = client.put(
        "/api/chat/threads/thread-does-not-exist/read",
        json={"message_id": "a1"},
        headers=headers("user-jane"),
    )
    assert missing.status_code == 404
    assert _listed("thread-read-private")["last_read_message_id"] is None


def test_upgrade_marks_existing_history_read_through_its_last_message(tmp_path: Path) -> None:
    engine = create_application_engine(f"sqlite:///{tmp_path / 'read-positions.sqlite3'}")
    upgrade_database(engine, "20260917_0023")
    insert = text(
        "INSERT INTO chat_threads (id, tenant_id, owner_user_id, title, model_id, group_id, pinned, archived, "
        "used_agent, updated_at, messages) VALUES (:id, 'tenant-example', 'user-jane', 'Synthetic', 'gpt-4o-mini', "
        "'group-litigation', 0, 0, 0, 'Just now', :messages)"
    )
    with engine.begin() as connection:
        connection.execute(
            insert,
            {
                "id": "thread-history",
                "messages": '[{"id":"u1","role":"user","content":"Q","createdAt":"9:00 AM","status":"ok"},'
                '{"id":"a1","role":"assistant","content":"A","createdAt":"9:01 AM","status":"ok"}]',
            },
        )
        connection.execute(insert, {"id": "thread-empty", "messages": "[]"})

    upgrade_database(engine, "20260923_0024")
    with engine.connect() as connection:
        positions = dict(connection.execute(text("SELECT id, last_read_message_id FROM chat_threads")).all())
    assert positions == {"thread-history": "a1", "thread-empty": None}

    config = alembic_config()
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, "20260917_0023")
    with engine.connect() as connection:
        columns = [row[1] for row in connection.execute(text("PRAGMA table_info(chat_threads)")).all()]
    assert "last_read_message_id" not in columns
    engine.dispose()
