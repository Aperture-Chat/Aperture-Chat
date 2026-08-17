"""MCP retention tagging: policy gate, followup behavior, admin drilldown.

Uses the seeded demo store through the app like the other route suites.
All data is synthetic.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.orm import ChatThreadRow
from app.main import app
from app.repositories.deps import get_store
from app.routes.chat import _run_retention_tagging
from types import SimpleNamespace

from app.models.schemas import ChatCompletionRequest, ChatThread, RetentionHold

import pytest

client = TestClient(app)

# Subject tagging is off in most tests, so an unconfigured route is honest.
FAKE_ROUTE = SimpleNamespace(configured=False)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _completion_request(thread_id: str) -> ChatCompletionRequest:
    return ChatCompletionRequest(model="model-synthetic", messages=[], thread_id=thread_id)


MCP_RESULTS = [
    {"tool_config_id": "tool-box", "server_name": "Box", "tool_name": "search", "status": "ready"}
]


def test_retention_policy_routes_roundtrip_and_audit() -> None:
    response = client.get("/api/admin/retention/policy", headers=headers("user-admin"))
    assert response.status_code == 200
    policy = response.json()
    assert policy["enabled"] is False
    assert policy["mcp_tagging_enabled"] is False
    assert policy["chat_retention_days"] == 0

    response = client.patch(
        "/api/admin/retention/policy",
        headers=headers("user-admin"),
        json={"mcp_tagging_enabled": True, "chat_retention_days": 1095},
    )
    assert response.status_code == 200
    saved = response.json()
    assert saved["mcp_tagging_enabled"] is True
    assert saved["chat_retention_days"] == 1095
    assert saved["updated_by"] == "user-admin"

    response = client.get("/api/admin/retention/policy", headers=headers("user-admin"))
    assert response.json()["mcp_tagging_enabled"] is True

    store = get_store()
    actions = [event.action for event in store.audit_events_newest_first(limit=5)]
    assert "retention.policy_updated" in actions


def test_retention_policy_requires_admin() -> None:
    response = client.get("/api/admin/retention/policy", headers=headers("user-jane"))
    assert response.status_code == 403


def test_tagging_followup_respects_policy_gate() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    request = _completion_request("thread-retention-gate")
    runtime_context = {"mcp_tool_results": list(MCP_RESULTS)}

    # Gate closed (default): no tag rows appear.
    _run_retention_tagging(store, admin, request, FAKE_ROUTE, runtime_context)
    assert store.list_chat_thread_tags(thread_id="thread-retention-gate") == []

    policy = store.tenant_retention_policy(admin.tenant_id)
    policy.mcp_tagging_enabled = True
    store.save_tenant_retention_policy(policy)

    _run_retention_tagging(store, admin, request, FAKE_ROUTE, runtime_context)
    tags = store.list_chat_thread_tags(thread_id="thread-retention-gate")
    assert [(tag.namespace, tag.key, tag.value) for tag in tags] == [("mcp", "tool-box", "Box")]
    assert tags[0].tenant_id == admin.tenant_id
    actions = [event.action for event in store.audit_events_newest_first(limit=5)]
    assert "chat.retention_tag_applied" in actions

    # Re-running the same completion refreshes the single tag, not a second.
    _run_retention_tagging(store, admin, request, FAKE_ROUTE, runtime_context)
    assert len(store.list_chat_thread_tags(thread_id="thread-retention-gate")) == 1


def test_tagged_threads_drilldown_lists_tenant_tags_only() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    policy = store.tenant_retention_policy(admin.tenant_id)
    policy.mcp_tagging_enabled = True
    store.save_tenant_retention_policy(policy)
    _run_retention_tagging(
        store,
        admin,
        _completion_request("thread-tagged-1"),
        FAKE_ROUTE,
        {"mcp_tool_results": list(MCP_RESULTS)},
    )

    response = client.get(
        "/api/admin/retention/tagged-threads", headers=headers("user-admin")
    )
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    row = rows[0]
    assert row["thread_id"] == "thread-tagged-1"
    # The thread was never saved by a client, so no title is exposed.
    assert row["title"] is None
    assert [tag["key"] for tag in row["tags"]] == ["tool-box"]

    filtered = client.get(
        "/api/admin/retention/tagged-threads?namespace=purview",
        headers=headers("user-admin"),
    )
    assert filtered.json() == []

    # Regular users cannot reach the drilldown.
    response = client.get(
        "/api/admin/retention/tagged-threads", headers=headers("user-jane")
    )
    assert response.status_code == 403


def _save_thread(store, thread_id: str, tenant_id: str) -> None:
    store.save_chat_thread(
        ChatThread(
            id=thread_id,
            tenant_id=tenant_id,
            owner_user_id="user-jane",
            title=f"Synthetic {thread_id}",
            model_id="model-synthetic",
            group_id="group-synthetic",
            updated_at="Just now",
            messages=[],
        )
    )


def test_retention_batch_delete_respects_holds_tenant_scope_and_audits() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    tenant_id = admin.tenant_id
    _save_thread(store, "thread-b1", tenant_id)
    _save_thread(store, "thread-b2", tenant_id)
    store.application_state_repository.create_retention_hold(
        RetentionHold(
            id="hold-batch",
            tenant_id=tenant_id,
            name="Litigation hold",
            created_by=admin.id,
            created_at=datetime.now(UTC),
        ),
        ["thread-b2"],
    )

    response = client.post(
        "/api/admin/retention/batch",
        headers=headers("user-admin"),
        json={"action": "delete", "thread_ids": ["thread-b1", "thread-b2", "thread-ghost"]},
    )
    assert response.status_code == 200
    assert response.json() == {
        "action": "delete",
        "requested": 3,
        "disposed": 1,
        "skipped_held": 1,
        "skipped_missing": 1,
    }
    assert store.chat_threads.get("thread-b1") is None
    assert store.chat_threads.get("thread-b2") is not None
    actions = [event.action for event in store.audit_events_newest_first(limit=5)]
    assert "retention.batch_deleted" in actions


def test_retention_batch_archive_keeps_retention_clock() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    _save_thread(store, "thread-arch", admin.tenant_id)

    def row_state(session):
        row = session.scalar(select(ChatThreadRow).where(ChatThreadRow.id == "thread-arch"))
        return row.archived, row.last_activity_at, row.sequence

    repository = store.application_state_repository
    archived_before, clock_before, sequence_before = repository.run_transaction(row_state)
    assert archived_before is False

    response = client.post(
        "/api/admin/retention/batch",
        headers=headers("user-admin"),
        json={"action": "archive", "thread_ids": ["thread-arch"]},
    )
    assert response.status_code == 200
    assert response.json()["disposed"] == 1
    archived_after, clock_after, sequence_after = repository.run_transaction(row_state)
    assert archived_after is True
    # Archiving is view management: the retention clock and the thread's
    # sequence position must not move.
    assert clock_after == clock_before
    assert sequence_after == sequence_before


def test_retention_batch_requires_admin() -> None:
    response = client.post(
        "/api/admin/retention/batch",
        headers=headers("user-jane"),
        json={"action": "delete", "thread_ids": ["thread-x"]},
    )
    assert response.status_code == 403


def test_attachment_tagging_respects_its_own_gate() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    request = _completion_request("thread-uploads")
    runtime_context = {
        "attachments": [
            {"id": "up-1", "name": "contract.pdf", "kind": "PDF", "mime_type": "application/pdf"},
            {"id": "up-2", "name": "scan.png", "kind": "Image", "mime_type": "image/png"},
            {"id": "up-3", "name": "brief.docx", "kind": "DOCX", "mime_type": None},
        ]
    }

    # MCP tagging being on does not imply attachment tagging.
    policy = store.tenant_retention_policy(admin.tenant_id)
    policy.mcp_tagging_enabled = True
    store.save_tenant_retention_policy(policy)
    _run_retention_tagging(store, admin, request, FAKE_ROUTE, runtime_context)
    assert store.list_chat_thread_tags(thread_id="thread-uploads") == []

    policy = store.tenant_retention_policy(admin.tenant_id)
    policy.attachment_tagging_enabled = True
    store.save_tenant_retention_policy(policy)
    _run_retention_tagging(store, admin, request, FAKE_ROUTE, runtime_context)
    tags = store.list_chat_thread_tags(thread_id="thread-uploads")
    assert sorted((tag.namespace, tag.key) for tag in tags) == [
        ("attachments", "document"),
        ("attachments", "image"),
    ]


def test_retention_threads_lists_untagged_chats_too() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    _save_thread(store, "thread-plain", admin.tenant_id)
    policy = store.tenant_retention_policy(admin.tenant_id)
    policy.mcp_tagging_enabled = True
    store.save_tenant_retention_policy(policy)
    _run_retention_tagging(
        store,
        admin,
        _completion_request("thread-plain"),
        FAKE_ROUTE,
        {"mcp_tool_results": list(MCP_RESULTS)},
    )
    _save_thread(store, "thread-untagged", admin.tenant_id)

    response = client.get("/api/admin/retention/threads", headers=headers("user-admin"))
    assert response.status_code == 200
    rows = {row["thread_id"]: row for row in response.json()}
    assert rows["thread-untagged"]["tags"] == []
    assert rows["thread-untagged"]["archived"] is False
    assert [tag["key"] for tag in rows["thread-plain"]["tags"]] == ["tool-box"]

    response = client.get("/api/admin/retention/threads", headers=headers("user-jane"))
    assert response.status_code == 403


def test_stored_policy_without_attachment_flag_still_loads() -> None:
    # Retention policies saved before attachment tagging existed omit the
    # field; the identity/config loader must backfill it fail-closed instead
    # of crash-looping the API.
    from app.models.schemas import TenantRetentionPolicy
    from app.repositories.identity_config_sql import _model_from_payload

    legacy_payload = TenantRetentionPolicy(tenant_id="tenant-legacy").model_dump(mode="json")
    del legacy_payload["attachment_tagging_enabled"]
    model = _model_from_payload(TenantRetentionPolicy, legacy_payload, "tenant_retention_policies")
    assert model.attachment_tagging_enabled is False


def test_parse_subject_label_validates_against_taxonomy() -> None:
    from app.core.retention import parse_subject_label

    assert parse_subject_label("legal/litigation") == ("legal", "litigation")
    assert parse_subject_label("  Financial/IRA.  ") == ("financial", "ira")
    assert parse_subject_label("code") == ("code", None)
    # Unknown subtypes degrade to the primary; unknown primaries are dropped.
    assert parse_subject_label("legal/space-law") == ("legal", None)
    assert parse_subject_label("astrology") is None
    assert parse_subject_label("other") is None
    assert parse_subject_label("") is None
    assert parse_subject_label(None) is None


def test_subject_tagging_classifies_once_per_thread(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    admin = store.users["user-admin"]
    policy = store.tenant_retention_policy(admin.tenant_id)
    policy.subject_tagging_enabled = True
    store.save_tenant_retention_policy(policy)

    calls: list[str] = []

    def fake_classify(_client, _route, _messages):
        calls.append("classified")
        return ("legal", "litigation")

    monkeypatch.setattr("app.routes.chat.classify_thread_subject", fake_classify)
    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: object())

    request = ChatCompletionRequest(
        model="model-synthetic",
        messages=[{"role": "user", "content": "Draft a motion to compel discovery."}],
        thread_id="thread-subject",
    )
    _run_retention_tagging(store, admin, request, FAKE_ROUTE, {})
    tags = store.list_chat_thread_tags(thread_id="thread-subject", namespace="subject")
    assert [(tag.key, tag.value) for tag in tags] == [("legal", "litigation")]

    # A later turn in the same thread must not re-bill the classifier.
    _run_retention_tagging(store, admin, request, FAKE_ROUTE, {})
    assert calls == ["classified"]


def test_retention_threads_carry_matter_labels_for_search() -> None:
    from sqlalchemy import update as sa_update

    from app.db.orm import MatterRow

    store = get_store()
    admin = store.users["user-admin"]
    tenant_id = admin.tenant_id
    _save_thread(store, "thread-matter", tenant_id)
    repository = store.application_state_repository

    def seed_matter(session):
        session.add(
            MatterRow(
                id="matter-acme-001",
                tenant_id=tenant_id,
                name="Acme Corp — 12345.001 Merger",
                created_by_user_id=admin.id,
                version=1,
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
            )
        )
        session.flush()
        session.execute(
            sa_update(ChatThreadRow)
            .where(ChatThreadRow.id == "thread-matter")
            .values(matter_id="matter-acme-001")
        )

    repository.run_transaction(seed_matter)

    response = client.get("/api/admin/retention/threads", headers=headers("user-admin"))
    assert response.status_code == 200
    rows = {row["thread_id"]: row for row in response.json()}
    assert rows["thread-matter"]["matter_id"] == "matter-acme-001"
    assert rows["thread-matter"]["matter_label"] == "Acme Corp — 12345.001 Merger"
