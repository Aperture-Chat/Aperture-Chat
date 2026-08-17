"""Phase 1 chat-retention foundations.

Covers the authoritative thread clocks, server-owned disposition state, the
tag and hold tables, the attachment-to-thread link, the migration backfill,
and the pure longest-wins policy resolution. All data is synthetic.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select, text, update

from app.core.retention import apply_mcp_runtime_tags, effective_retention_days
from app.db import create_application_engine, upgrade_database
from app.db.orm import (
    ChatAttachmentRow,
    ChatThreadRow,
    TenantRow,
)
from app.models.schemas import (
    ChatAttachment,
    ChatMessage,
    ChatThread,
    ChatThreadTag,
    RetentionHold,
    RetentionRule,
    TenantRetentionPolicy,
)
from app.repositories.application_state import ApplicationStateRepository


TENANT = "tenant-retention"
OTHER_TENANT = "tenant-other"
NOW = datetime(2026, 8, 16, 12, 0, tzinfo=UTC)


def _repository(path: Path) -> ApplicationStateRepository:
    engine = create_application_engine(f"sqlite+pysqlite:///{path.as_posix()}")
    upgrade_database(engine)
    repository = ApplicationStateRepository(engine)
    _seed_tenants(repository)
    return repository


def _seed_tenants(repository: ApplicationStateRepository) -> None:
    def operation(session):
        session.add(TenantRow(id=TENANT, ordinal=0, slug="retention", payload={}))
        session.add(TenantRow(id=OTHER_TENANT, ordinal=1, slug="other", payload={}))

    repository.run_transaction(operation)


def _message(message_id: str, iso: str | None, attachment_id: str | None = None) -> ChatMessage:
    attachments = None
    if attachment_id is not None:
        attachments = [
            ChatAttachment(
                id=attachment_id,
                name="synthetic.png",
                size="1 KB",
                kind="Image",
            )
        ]
    return ChatMessage(
        id=message_id,
        role="user",
        content="synthetic message",
        createdAt="10:00 AM",
        createdAtIso=iso,
        attachments=attachments,
    )


def _thread(thread_id: str, messages: list[ChatMessage], tenant_id: str = TENANT) -> ChatThread:
    return ChatThread(
        id=thread_id,
        tenant_id=tenant_id,
        owner_user_id="user-retention",
        title="Synthetic thread",
        model_id="model-synthetic",
        group_id="group-synthetic",
        updated_at="Just now",
        messages=messages,
    )


def _tag(thread_id: str, namespace: str = "mcp", key: str = "tool-box") -> ChatThreadTag:
    return ChatThreadTag(
        id=f"tag-{thread_id}-{namespace}-{key}",
        tenant_id=TENANT,
        thread_id=thread_id,
        namespace=namespace,
        key=key,
        value="Box",
        source="auto",
        applied_at=NOW,
        applied_by="user-retention",
    )


def _thread_row(repository: ApplicationStateRepository, thread_id: str) -> ChatThreadRow:
    def operation(session):
        row = session.scalar(select(ChatThreadRow).where(ChatThreadRow.id == thread_id))
        assert row is not None
        session.expunge(row)
        return row

    return repository.run_transaction(operation)


# --- server-owned clocks and disposition state ------------------------------


def test_upsert_stamps_clocks_and_preserves_created_at(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "state.sqlite3")
    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", "2026-08-01T10:00:00+00:00")]))
    first = _thread_row(repository, "thread-1")
    assert first.created_at is not None
    assert first.last_activity_at is not None

    repository.upsert_chat_thread(
        _thread(
            "thread-1",
            [
                _message("m1", "2026-08-01T10:00:00+00:00"),
                _message("m2", "2026-08-02T10:00:00+00:00"),
            ],
        )
    )
    second = _thread_row(repository, "thread-1")
    assert second.created_at == first.created_at
    assert second.last_activity_at >= first.last_activity_at


def test_client_resave_cannot_clear_disposition_state(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "state.sqlite3")
    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", None)]))
    pending_since = NOW

    def mark(session):
        session.execute(
            update(ChatThreadRow)
            .where(ChatThreadRow.id == "thread-1")
            .values(disposition_state="pending", disposition_pending_since=pending_since)
        )

    repository.run_transaction(mark)

    # A normal workspace save (the client PUTs the whole thread) must not
    # reset the sweep's marker.
    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", None)]))
    row = _thread_row(repository, "thread-1")
    assert row.disposition_state == "pending"
    assert row.disposition_pending_since == pending_since


# --- tags -------------------------------------------------------------------


def test_tags_survive_thread_resave_and_are_idempotent(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "state.sqlite3")
    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", None)]))
    repository.apply_chat_thread_tag(_tag("thread-1"))

    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", None)]))
    tags = repository.list_chat_thread_tags(thread_id="thread-1")
    assert [(tag.namespace, tag.key, tag.value) for tag in tags] == [("mcp", "tool-box", "Box")]

    updated = _tag("thread-1")
    updated.value = "Box (renamed)"
    repository.apply_chat_thread_tag(updated)
    tags = repository.list_chat_thread_tags(thread_id="thread-1")
    assert len(tags) == 1
    assert tags[0].value == "Box (renamed)"


def test_list_tags_filters_by_tenant_namespace_and_key(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "state.sqlite3")
    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", None)]))
    repository.apply_chat_thread_tag(_tag("thread-1", "mcp", "tool-box"))
    repository.apply_chat_thread_tag(_tag("thread-1", "purview", "confidential"))

    assert len(repository.list_chat_thread_tags(tenant_id=TENANT)) == 2
    assert len(repository.list_chat_thread_tags(tenant_id=TENANT, namespace="mcp")) == 1
    assert repository.list_chat_thread_tags(tenant_id=OTHER_TENANT) == []
    removed = repository.remove_chat_thread_tag("thread-1", "purview", "confidential")
    assert removed is not None
    assert len(repository.list_chat_thread_tags(tenant_id=TENANT)) == 1


# --- attachment linking and thread deletion ---------------------------------


def test_thread_save_links_attachments_and_reupload_preserves_link(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "state.sqlite3")
    attachment = ChatAttachment(
        id="upload-1",
        tenant_id=TENANT,
        owner_user_id="user-retention",
        name="synthetic.png",
        size="1 KB",
        kind="Image",
    )
    repository.upsert_chat_attachment(attachment)
    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", None, "upload-1")]))

    def fetch(session):
        row = session.get(ChatAttachmentRow, "upload-1")
        assert row is not None
        return row.thread_id

    assert repository.run_transaction(fetch) == "thread-1"

    # Re-uploading metadata for the same attachment keeps the link.
    repository.upsert_chat_attachment(attachment)
    assert repository.run_transaction(fetch) == "thread-1"


def test_delete_thread_cascades_tags_holds_attachments_and_previews(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    unlinked: list[str] = []
    monkeypatch.setattr(
        "app.repositories.application_state.delete_attachment_preview",
        unlinked.append,
    )
    repository = _repository(tmp_path / "state.sqlite3")
    repository.upsert_chat_attachment(
        ChatAttachment(
            id="upload-1",
            tenant_id=TENANT,
            owner_user_id="user-retention",
            name="synthetic.png",
            size="1 KB",
            kind="Image",
        )
    )
    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", None, "upload-1")]))
    repository.apply_chat_thread_tag(_tag("thread-1"))
    hold, held_ids = repository.create_retention_hold(
        RetentionHold(
            id="hold-1",
            tenant_id=TENANT,
            name="Synthetic hold",
            created_by="user-retention",
            created_at=NOW,
        ),
        ["thread-1"],
    )
    assert held_ids == ["thread-1"]

    deleted = repository.delete_chat_thread("thread-1")
    assert deleted is not None
    assert unlinked == ["upload-1"]
    assert repository.list_chat_thread_tags(thread_id="thread-1") == []
    assert repository.retention_hold_thread_ids(hold.id) == []

    def leftovers(session):
        return session.get(ChatAttachmentRow, "upload-1")

    assert repository.run_transaction(leftovers) is None


# --- holds ------------------------------------------------------------------


def test_hold_membership_is_tenant_scoped_and_release_works(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "state.sqlite3")
    repository.upsert_chat_thread(_thread("thread-mine", [_message("m1", None)]))
    repository.upsert_chat_thread(
        _thread("thread-theirs", [_message("m1", None)], tenant_id=OTHER_TENANT)
    )

    hold, held_ids = repository.create_retention_hold(
        RetentionHold(
            id="hold-1",
            tenant_id=TENANT,
            name="Litigation hold",
            reason="Synthetic matter",
            created_by="user-retention",
            created_at=NOW,
        ),
        ["thread-mine", "thread-theirs", "thread-missing"],
    )
    assert held_ids == ["thread-mine"]
    assert repository.thread_ids_under_active_hold(TENANT) == {"thread-mine"}
    assert repository.thread_ids_under_active_hold(OTHER_TENANT) == set()

    released = repository.release_retention_hold(
        hold.id, released_at=NOW + timedelta(days=1), released_by="user-retention"
    )
    assert released is not None
    assert released.released_at == NOW + timedelta(days=1)
    assert repository.thread_ids_under_active_hold(TENANT) == set()
    assert repository.list_retention_holds(tenant_id=TENANT, active_only=True) == []
    assert len(repository.list_retention_holds(tenant_id=TENANT)) == 1
    # Releasing twice reports "already released" via None.
    assert (
        repository.release_retention_hold(
            hold.id, released_at=NOW, released_by="user-retention"
        )
        is None
    )


def test_purge_user_removes_tags_and_hold_membership(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "state.sqlite3")
    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", None)]))
    repository.apply_chat_thread_tag(_tag("thread-1"))
    repository.create_retention_hold(
        RetentionHold(
            id="hold-1",
            tenant_id=TENANT,
            name="Synthetic hold",
            created_by="user-retention",
            created_at=NOW,
        ),
        ["thread-1"],
    )

    repository.purge_a5_user("user-retention", TENANT, 1_000)
    assert repository.list_chat_thread_tags(tenant_id=TENANT) == []
    assert repository.retention_hold_thread_ids("hold-1") == []


# --- migration backfill -----------------------------------------------------


def test_migration_backfills_clocks_and_attachment_links(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    engine = create_application_engine(f"sqlite+pysqlite:///{path.as_posix()}")
    upgrade_database(engine, revision="20260807_0015")

    messages = (
        '[{"id": "m1", "role": "user", "content": "hi", "createdAt": "10:00 AM",'
        ' "createdAtIso": "2026-07-01T10:00:00+00:00",'
        ' "attachments": [{"id": "upload-1", "name": "synthetic.png",'
        ' "size": "1 KB", "kind": "Image"}]},'
        ' {"id": "m2", "role": "assistant", "content": "hello",'
        ' "createdAt": "10:01 AM", "createdAtIso": "2026-07-02T10:00:00Z"}]'
    )
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO chat_threads (id, tenant_id, owner_user_id, title,"
                " model_id, group_id, pinned, archived, used_agent, updated_at,"
                " messages) VALUES (:id, :tenant, :owner, 'T', 'model', 'group',"
                " 0, 0, 0, 'Just now', :messages)"
            ),
            {"id": "thread-legacy", "tenant": TENANT, "owner": "user-retention", "messages": messages},
        )
        connection.execute(
            text(
                "INSERT INTO chat_attachments (id, tenant_id, owner_user_id,"
                " name, size, kind, source_type, status)"
                " VALUES ('upload-1', :tenant, 'user-retention', 'synthetic.png',"
                " '1 KB', 'Image', 'upload', 'uploaded')"
            ),
            {"tenant": TENANT},
        )

    upgrade_database(engine)
    repository = ApplicationStateRepository(engine)
    row = _thread_row(repository, "thread-legacy")
    assert row.created_at == datetime(2026, 7, 1, 10, 0, tzinfo=UTC)
    assert row.last_activity_at == datetime(2026, 7, 2, 10, 0, tzinfo=UTC)
    assert row.disposition_state is None

    def fetch(session):
        attachment = session.get(ChatAttachmentRow, "upload-1")
        assert attachment is not None
        return attachment.thread_id

    assert repository.run_transaction(fetch) == "thread-legacy"


def test_migration_falls_back_to_migration_time_without_message_clocks(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    engine = create_application_engine(f"sqlite+pysqlite:///{path.as_posix()}")
    upgrade_database(engine, revision="20260807_0015")
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO chat_threads (id, tenant_id, owner_user_id, title,"
                " model_id, group_id, pinned, archived, used_agent, updated_at,"
                " messages) VALUES ('thread-empty', :tenant, 'user-retention',"
                " 'T', 'model', 'group', 0, 0, 0, 'Just now', '[]')"
            ),
            {"tenant": TENANT},
        )
    before = datetime.now(UTC)
    upgrade_database(engine)
    after = datetime.now(UTC)
    repository = ApplicationStateRepository(engine)
    row = _thread_row(repository, "thread-empty")
    assert row.created_at is not None
    assert before <= row.created_at <= after
    assert row.created_at == row.last_activity_at


# --- policy model and resolution --------------------------------------------


def test_policy_defaults_are_fail_closed() -> None:
    policy = TenantRetentionPolicy(tenant_id=TENANT)
    assert policy.id == TENANT
    assert policy.enabled is False
    assert policy.chat_retention_days == 0
    assert policy.mcp_tagging_enabled is False
    assert policy.external_tags_enabled is False
    assert policy.rules == []
    # Round-trips canonically, which the identity/config snapshot requires.
    assert TenantRetentionPolicy.model_validate(policy.model_dump(mode="json")) == policy


def _policy(**kwargs) -> TenantRetentionPolicy:
    return TenantRetentionPolicy(tenant_id=TENANT, enabled=True, **kwargs)


def test_resolution_disabled_policy_governs_nothing() -> None:
    policy = TenantRetentionPolicy(tenant_id=TENANT, chat_retention_days=365)
    assert effective_retention_days(policy) is None


def test_resolution_unmatched_thread_is_ungoverned() -> None:
    policy = _policy(
        rules=[
            RetentionRule(id="r1", tag_namespace="mcp", tag_key="tool-box", retention_days=1095)
        ]
    )
    assert effective_retention_days(policy, tags=[("manual", "keep")]) is None
    # A matter value alone is a floor, never a trigger.
    assert effective_retention_days(policy, matter_retention_days=3650) is None


def test_resolution_longest_wins_across_default_rules_and_matter() -> None:
    policy = _policy(
        chat_retention_days=365,
        rules=[
            RetentionRule(id="r1", tag_namespace="mcp", tag_key="tool-box", retention_days=1095),
            RetentionRule(id="r2", tag_namespace="purview", retention_days=2555),
        ],
    )
    assert effective_retention_days(policy) == 365
    assert effective_retention_days(policy, tags=[("mcp", "tool-box")]) == 1095
    assert (
        effective_retention_days(
            policy, tags=[("mcp", "tool-box"), ("purview", "anything")]
        )
        == 2555
    )
    assert (
        effective_retention_days(
            policy, tags=[("mcp", "tool-box")], matter_retention_days=3650
        )
        == 3650
    )
    # Namespace-wide rules do not fire on other namespaces' keys.
    assert effective_retention_days(policy, tags=[("mcp", "tool-other")]) == 365


# --- MCP auto-tagging -------------------------------------------------------


def test_apply_mcp_runtime_tags_covers_errors_and_dedupes(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "state.sqlite3")
    repository.upsert_chat_thread(_thread("thread-1", [_message("m1", None)]))
    applied = apply_mcp_runtime_tags(
        repository,
        tenant_id=TENANT,
        thread_id="thread-1",
        actor_id="user-retention",
        mcp_tool_results=[
            {"tool_config_id": "tool-box", "server_name": "Box", "status": "ready"},
            # Errors still expose data on the wire; they must tag too.
            {"tool_config_id": "tool-jira", "server_name": "Jira", "is_error": True},
            # Same server twice in one completion collapses to one tag.
            {"tool_config_id": "tool-box", "server_name": "Box", "status": "ready"},
            {"server_name": "missing-id-is-skipped"},
        ],
    )
    assert sorted(tag.key for tag in applied) == ["tool-box", "tool-jira"]
    stored = repository.list_chat_thread_tags(thread_id="thread-1", namespace="mcp")
    assert sorted((tag.key, tag.value) for tag in stored) == [
        ("tool-box", "Box"),
        ("tool-jira", "Jira"),
    ]
    assert all(tag.source == "auto" for tag in stored)
