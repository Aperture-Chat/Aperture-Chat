from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import inspect, select, text
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.exc import IntegrityError, StatementError
from sqlalchemy.schema import CreateTable

from app.db import (
    APPLICATION_STATE_IMPORT_REVISION,
    CHAT_STATE_IMPORT_REVISION,
    HEAD_REVISION,
    Base,
    ChatAttachmentRow,
    ChatFolderRow,
    ChatStateImportRow,
    ChatThreadRow,
    RevokedSessionRow,
    RuntimeStateImportRow,
    SessionFamilyRow,
    UserApiKeyRow,
    UserSessionWatermarkRow,
    create_application_engine,
    create_session_factory,
    current_schema_revision,
    session_scope,
    upgrade_database,
)
from app.db.engine import alembic_config
from app.models.schemas import (
    ChatActivityTraceStep,
    ChatAttachment,
    ChatCitation,
    ChatFolder,
    ChatMessage,
    ChatThread,
    UserApiKeyRecord,
)


def _sqlite_url(path: Path) -> str:
    return f"sqlite:///{path}"


def _thread() -> ChatThread:
    attachment = ChatAttachment(
        id="attachment-a5",
        tenant_id="tenant-a5",
        owner_user_id="user-a5",
        name="agreement.pdf",
        size="12 KB",
        kind="PDF",
        mime_type="application/pdf",
        size_bytes=12_288,
        source_type="upload",
        source_uri="upload://attachment-a5",
        status="uploaded",
        uploaded_at="Jul 20, 2026, 10:30 AM UTC",
        text_preview="Agreement preview",
    )
    return ChatThread(
        id="thread-a5",
        tenant_id="tenant-a5",
        owner_user_id="user-a5",
        title="Review agreement",
        model_id="model-a5",
        group_id="group-a5",
        pinned=True,
        archived=False,
        folder_id="folder-a5",
        used_agent=True,
        updated_at="Just now",
        messages=[
            ChatMessage(
                id="message-a5",
                role="assistant",
                content="The agreement is ready for review.",
                createdAt="10:31 AM",
                createdAtIso="2026-07-20T16:31:00+00:00",
                metadata={"nested": {"source": "agreement", "pages": [1, 2]}},
                attachments=[attachment],
                citations=[
                    ChatCitation(
                        id="citation-a5",
                        source_name="agreement.pdf",
                        source_type="upload",
                        source_uri="upload://attachment-a5",
                        snippet="Agreement text",
                        page_start=1,
                    )
                ],
                activityTrace=[ChatActivityTraceStep(id="trace-a5", label="Reviewed attachment")],
                usage={"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
            )
        ],
    )


def _downgrade(engine: object, revision: str) -> None:
    config = alembic_config()
    with engine.begin() as connection:  # type: ignore[union-attr]
        config.attributes["connection"] = connection
        command.downgrade(config, revision)


def test_a5_fresh_upgrade_has_expected_authority_tables_and_indexes(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a5-fresh.sqlite3"))
    try:
        upgrade_database(engine)
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        assert current_schema_revision(engine) == HEAD_REVISION == "20260905_0019"
        assert CHAT_STATE_IMPORT_REVISION == "20260720_0004"
        assert APPLICATION_STATE_IMPORT_REVISION == "20260720_0003"
        assert {
            "chat_threads",
            "chat_folders",
            "chat_attachments",
            "user_api_keys",
            "user_session_watermarks",
            "session_families",
            "chat_state_imports",
        } <= tables
        assert "chat_sessions" not in tables

        assert {column["name"] for column in inspector.get_columns("chat_threads")} == {
            "sequence",
            "id",
            "tenant_id",
            "owner_user_id",
            "title",
            "model_id",
            "group_id",
            "pinned",
            "archived",
            "folder_id",
            "matter_id",
            "used_agent",
            "updated_at",
            "created_at",
            "last_activity_at",
            "disposition_state",
            "disposition_pending_since",
            "messages",
        }
        assert {index["name"] for index in inspector.get_indexes("user_api_keys")} >= {
            "ix_user_api_keys_key_hash",
            "ix_user_api_keys_tenant_user",
        }
        key_hash_index = next(
            index
            for index in inspector.get_indexes("user_api_keys")
            if index["name"] == "ix_user_api_keys_key_hash"
        )
        assert key_hash_index["unique"] == 1
        for table in (
            "chat_attachments",
            "user_api_keys",
            "user_session_watermarks",
            "chat_state_imports",
        ):
            assert inspector.get_foreign_keys(table) == []
        assert inspector.get_foreign_keys("chat_threads") == [
            {
                "name": "fk_chat_threads_matter_id_matters",
                "constrained_columns": ["matter_id"],
                "referred_schema": None,
                "referred_table": "matters",
                "referred_columns": ["id"],
                "options": {"ondelete": "SET NULL"},
            }
        ]
        assert inspector.get_foreign_keys("chat_folders") == [
            {
                "name": "fk_chat_folders_matter_id_matters",
                "constrained_columns": ["matter_id"],
                "referred_schema": None,
                "referred_table": "matters",
                "referred_columns": ["id"],
                "options": {"ondelete": "SET NULL"},
            }
        ]
    finally:
        engine.dispose()


def test_a5_upgrade_from_0003_and_down_up_preserves_a4_receipt(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a5-linear.sqlite3"))
    factory = create_session_factory(engine)
    prior_digest = "a" * 64
    try:
        upgrade_database(engine, APPLICATION_STATE_IMPORT_REVISION)
        with session_scope(factory) as session:
            session.add(
                RuntimeStateImportRow(
                    source_digest=prior_digest,
                    source_version=2,
                    target_version=3,
                    completed_at=datetime(2026, 7, 20, tzinfo=UTC),
                    audit_count=1,
                    usage_count=2,
                    outbox_count=1,
                    alert_notification_count=0,
                    alert_runtime_count=0,
                )
            )

        upgrade_database(engine)
        with session_scope(factory) as session:
            assert session.get(RuntimeStateImportRow, prior_digest) is not None

        _downgrade(engine, APPLICATION_STATE_IMPORT_REVISION)
        inspector = inspect(engine)
        assert "chat_threads" not in inspector.get_table_names()
        with session_scope(factory) as session:
            assert session.get(RuntimeStateImportRow, prior_digest) is not None

        upgrade_database(engine)
        assert current_schema_revision(engine) == HEAD_REVISION
        with session_scope(factory) as session:
            assert session.get(RuntimeStateImportRow, prior_digest) is not None
    finally:
        engine.dispose()


def test_session_family_upgrade_backfills_legacy_domain_and_survives_down_up(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "session-family-linear.sqlite3"))
    factory = create_session_factory(engine)
    revoked_at = datetime(2026, 7, 20, tzinfo=UTC)
    try:
        upgrade_database(engine, CHAT_STATE_IMPORT_REVISION)
        with session_scope(factory) as session:
            session.add(
                RevokedSessionRow(
                    sid="legacy-negative-equal",
                    user_id="legacy-user",
                    tenant_id=None,
                    issued_at=-1,
                    expires_at=-1,
                    revoked_at=revoked_at,
                    reason="legacy-import",
                )
            )

        upgrade_database(engine)
        assert current_schema_revision(engine) == HEAD_REVISION
        with session_scope(factory) as session:
            family = session.get(SessionFamilyRow, "legacy-negative-equal")
            assert family is not None
            assert family.legacy_unbounded is True
            assert family.max_expires_at == 0
            assert family.revoked_by_issued_at == -1
            assert family.revoked_by_expires_at == -1

        _downgrade(engine, CHAT_STATE_IMPORT_REVISION)
        assert "session_families" not in inspect(engine).get_table_names()
        with session_scope(factory) as session:
            assert session.get(RevokedSessionRow, "legacy-negative-equal") is not None

        upgrade_database(engine)
        assert current_schema_revision(engine) == HEAD_REVISION
        with session_scope(factory) as session:
            family = session.get(SessionFamilyRow, "legacy-negative-equal")
            assert family is not None and family.legacy_unbounded is True
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("revoked_at", "revoked_by_issued_at", "revoked_by_expires_at"),
    [
        (datetime(2026, 7, 20, tzinfo=UTC), None, 200),
        (datetime(2026, 7, 20, tzinfo=UTC), 100, None),
        (None, 100, 200),
    ],
)
def test_session_family_constraint_rejects_partial_revocation_metadata(
    tmp_path: Path,
    revoked_at: datetime | None,
    revoked_by_issued_at: int | None,
    revoked_by_expires_at: int | None,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "session-family-check.sqlite3"))
    factory = create_session_factory(engine)
    try:
        upgrade_database(engine)
        with pytest.raises(IntegrityError):
            with session_scope(factory) as session:
                session.add(
                    SessionFamilyRow(
                        sid="partial-revocation",
                        user_id="user-one",
                        tenant_id="tenant-one",
                        max_expires_at=200,
                        legacy_unbounded=False,
                        revoked_at=revoked_at,
                        revoked_by_issued_at=revoked_by_issued_at,
                        revoked_by_expires_at=revoked_by_expires_at,
                        updated_at=datetime(2026, 7, 20, tzinfo=UTC),
                    )
                )
    finally:
        engine.dispose()


def test_a5_models_round_trip_complete_chat_and_authority_records(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a5-round-trip.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    thread = _thread()
    folder = ChatFolder(
        id="folder-a5",
        tenant_id="tenant-a5",
        owner_user_id="user-a5",
        name="Agreements",
        created_at="2026-07-20T16:30:00+00:00",
    )
    attachment = thread.messages[0].attachments[0]
    api_key = UserApiKeyRecord(
        id="key-a5",
        user_id="user-a5",
        tenant_id="tenant-a5",
        key_hash="b" * 64,
        key_prefix="apt_example",
        masked_value="apt_example••••0000",
        created_at="2026-07-20T16:32:00+00:00",
    )
    try:
        with session_scope(factory) as session:
            session.add_all(
                [
                    ChatThreadRow.from_model(thread),
                    ChatFolderRow.from_model(folder),
                    ChatAttachmentRow.from_model(attachment),
                    UserApiKeyRow.from_model(api_key),
                    UserSessionWatermarkRow(
                        user_id="user-a5",
                        tenant_id="tenant-a5",
                        issued_before_ms=1_721_492_000_000,
                        updated_at=datetime(2026, 7, 20, 16, 33, tzinfo=UTC),
                        updated_by="owner-a5",
                        reason="administrator-revoke",
                    ),
                    ChatStateImportRow(
                        source_digest="c" * 64,
                        source_version=3,
                        target_version=4,
                        completed_at=datetime(2026, 7, 20, 16, 34, tzinfo=UTC),
                        prior_application_state_digest="a" * 64,
                        thread_count=1,
                        folder_count=1,
                        attachment_count=1,
                        api_key_count=1,
                        watermark_count=0,
                    ),
                ]
            )

        with session_scope(factory) as session:
            stored_thread = session.scalar(select(ChatThreadRow))
            stored_folder = session.scalar(select(ChatFolderRow))
            stored_attachment = session.scalar(select(ChatAttachmentRow))
            stored_key = session.scalar(select(UserApiKeyRow))
            assert stored_thread is not None
            assert stored_folder is not None
            assert stored_attachment is not None
            assert stored_key is not None
            assert stored_thread.to_model().model_dump(mode="json") == thread.model_dump(
                mode="json"
            )
            assert stored_folder.to_model() == folder
            assert stored_attachment.to_model() == attachment
            assert stored_key.to_model() == api_key
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "messages",
    [
        {"id": "not-an-array"},
        [
            {
                "id": "message-a5",
                "role": "user",
                "content": "Hello",
                "createdAt": "Now",
                "extra": True,
            }
        ],
        [
            {
                "id": "message-a5",
                "role": "user",
                "content": "Hello",
                "createdAt": "Now",
                "attachments": [
                    {"name": "bad.txt", "size": "1 B", "kind": "Text", "unknown": True}
                ],
            }
        ],
    ],
)
def test_chat_message_json_fails_closed_on_corrupt_raw_rows(
    tmp_path: Path,
    messages: object,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a5-corrupt.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    try:
        with session_scope(factory) as session:
            session.add(ChatThreadRow.from_model(_thread()))
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE chat_threads SET messages = :messages WHERE id = :thread_id"),
                {"messages": json.dumps(messages), "thread_id": "thread-a5"},
            )
        with pytest.raises((StatementError, ValueError)):
            with session_scope(factory) as session:
                session.scalar(select(ChatThreadRow))
    finally:
        engine.dispose()


def test_chat_message_json_rejects_nonfinite_nested_metadata(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a5-nonfinite.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    thread = _thread()
    thread.messages[0].metadata = {"score": float("nan")}
    try:
        with pytest.raises((StatementError, ValueError), match="strict JSON|finite"):
            with session_scope(factory) as session:
                session.add(ChatThreadRow.from_model(thread))
    finally:
        engine.dispose()


def test_api_key_and_receipt_constraints_are_enforced(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a5-constraints.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    try:
        with session_scope(factory) as session:
            session.add(
                UserApiKeyRow(
                    id="key-one",
                    user_id="user-one",
                    tenant_id="tenant-a5",
                    key_hash="d" * 64,
                    key_prefix="apt_one",
                    masked_value="apt_one••••0001",
                    created_at="Now",
                )
            )
        with pytest.raises(IntegrityError):
            with session_scope(factory) as session:
                session.add(
                    UserApiKeyRow(
                        id="key-two",
                        user_id="user-two",
                        tenant_id="tenant-a5",
                        key_hash="d" * 64,
                        key_prefix="apt_two",
                        masked_value="apt_two••••0002",
                        created_at="Now",
                    )
                )
        with pytest.raises(IntegrityError):
            with session_scope(factory) as session:
                session.add(
                    ChatStateImportRow(
                        source_digest="short",
                        source_version=3,
                        target_version=4,
                        completed_at=datetime.now(UTC),
                        prior_application_state_digest="e" * 64,
                        thread_count=-1,
                        folder_count=0,
                        attachment_count=0,
                        api_key_count=0,
                        watermark_count=0,
                    )
                )
    finally:
        engine.dispose()


def test_a5_metadata_compiles_for_sqlite_and_postgresql() -> None:
    a5_tables = [
        ChatThreadRow.__table__,
        ChatFolderRow.__table__,
        ChatAttachmentRow.__table__,
        UserApiKeyRow.__table__,
        UserSessionWatermarkRow.__table__,
        SessionFamilyRow.__table__,
        ChatStateImportRow.__table__,
    ]
    for dialect in (sqlite.dialect(), postgresql.dialect()):
        for table in a5_tables:
            compiled = str(CreateTable(table).compile(dialect=dialect))
            assert table.name in compiled
    assert set(Base.metadata.tables).isdisjoint({"chat_sessions"})
