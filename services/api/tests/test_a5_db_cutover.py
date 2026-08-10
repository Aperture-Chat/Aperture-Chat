from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, inspect, select, text

from app.db.engine import (
    APPLICATION_STATE_IMPORT_REVISION,
    CHAT_STATE_IMPORT_REVISION,
    create_application_engine,
    create_session_factory,
    session_scope,
    upgrade_database,
)
from app.db.import_state import (
    APPLICATION_STATE_METADATA_KEY,
    CHAT_STATE_METADATA_KEY,
    CHAT_STATE_RETIRED_FIELDS,
    StateImportError,
    build_v3_payload,
    import_v3_chat_state,
    import_validated_state,
    prepare_runtime_state,
    validate_legacy_state,
    validate_v3_chat_state,
    verify_v4_state,
)
from app.db.orm import (
    ChatAttachmentRow,
    ChatFolderRow,
    ChatStateImportRow,
    ChatThreadRow,
    UserApiKeyRow,
    UserSessionWatermarkRow,
)
from app.models.schemas import ChatAttachment, ChatFolder, ChatThread, UserApiKeyRecord


def _sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _v2_payload() -> dict[str, Any]:
    key_hash = hashlib.sha256(b"a5-user-secret").hexdigest()
    return {
        "version": 2,
        "tenants": [
            {"id": "tenant-a", "name": "Tenant A", "slug": "tenant-a"},
            {"id": "tenant-b", "name": "Tenant B", "slug": "tenant-b"},
        ],
        "users": [
            {
                "id": "user-a",
                "tenant_id": "tenant-a",
                "email": "user-a@example.test",
                "display_name": "User A",
                "role": "USER",
            },
            {
                "id": "user-b",
                "tenant_id": "tenant-b",
                "email": "user-b@example.test",
                "display_name": "User B",
                "role": "USER",
            },
            {
                "id": "platform-owner",
                "tenant_id": None,
                "email": "owner@example.test",
                "display_name": "Platform Owner",
                "role": "PLATFORM_OWNER",
            },
        ],
        # Suppress A4's deterministic usage backfill so these tests isolate A5.
        "usage_records": [],
        "chat_folders": [
            {
                "id": "folder-a",
                "tenant_id": "tenant-a",
                "owner_user_id": "user-a",
                "name": "Matter Alpha",
                "created_at": "2026-07-20T10:00:00Z",
            }
        ],
        "chat_threads": [
            {
                "id": "thread-a",
                "tenant_id": "tenant-a",
                "owner_user_id": "user-a",
                "title": "Strict A5 import",
                "model_id": "provider/model-a",
                "group_id": "group-a",
                "folder_id": "folder-a",
                "updated_at": "Just now",
                "messages": [
                    {
                        "id": "message-a",
                        "role": "assistant",
                        "content": "A durable answer.",
                        "createdAt": "10:01 AM",
                        "createdAtIso": "2026-07-20T10:01:00Z",
                        "metadata": {"nested": {"valid": True}},
                        "attachments": [
                            {
                                "id": "attachment-inline",
                                "tenant_id": "tenant-a",
                                "owner_user_id": "user-a",
                                "name": "inline.pdf",
                                "size": "12 KB",
                                "kind": "PDF",
                            }
                        ],
                        "citations": [
                            {
                                "id": "citation-a",
                                "source_name": "Source A",
                                "source_type": "pdf",
                                "source_uri": "source://a",
                                "snippet": "Supported text",
                                "page_start": 2,
                                "page_end": 2,
                            }
                        ],
                        "activityTrace": [{"id": "trace-a", "label": "Retrieved source"}],
                    }
                ],
            }
        ],
        "chat_sessions": [
            {
                "id": "thread-a",
                "tenant_id": "tenant-a",
                "owner_user_id": "user-a",
                "title": "Strict A5 import",
                "model_id": "provider/model-a",
                "group_id": "group-a",
                "folder_id": "folder-a",
                "updated_at": "Just now",
            }
        ],
        "chat_attachments": [
            {
                "id": "attachment-a",
                "tenant_id": "tenant-a",
                "owner_user_id": "user-a",
                "name": "evidence.pdf",
                "size": "42 KB",
                "kind": "PDF",
                "mime_type": "application/pdf",
                "size_bytes": 43_008,
                "source_type": "upload",
                "source_uri": "upload://attachment-a",
                "status": "uploaded",
                "uploaded_at": "2026-07-20T10:02:00Z",
                "text_preview": "Verified evidence",
            }
        ],
        "user_api_keys": [
            {
                "id": "user-a",
                "user_id": "user-a",
                "tenant_id": "tenant-a",
                "key_hash": key_hash,
                "key_prefix": "apt_example",
                "masked_value": "apt_example••••0000",
                "created_at": "2026-07-20T10:03:00Z",
                "last_used_at": "2026-07-20T10:04:00Z",
            }
        ],
        "durable_configuration": {
            "nested": ["preserve", {"enabled": True}],
        },
    }


def _seed_verified_v3(engine: Any, state_path: Path) -> dict[str, Any]:
    legacy = validate_legacy_state(_v2_payload())
    upgrade_database(engine)
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        import_validated_state(session, legacy, strict_counts=True)
    payload = build_v3_payload(legacy)
    state_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    return payload


def _row_count(session: Any, row_type: Any) -> int:
    return session.scalar(select(func.count()).select_from(row_type)) or 0


def test_v3_to_v4_imports_every_a5_collection_and_retires_json_authority(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    v3_payload = _seed_verified_v3(engine, state_path)

    try:
        prepared = prepare_runtime_state(engine, state_path)

        assert prepared.rewritten is True
        assert prepared.import_result is None
        assert prepared.chat_import_result is not None
        assert prepared.chat_import_result.thread_imported == 1
        assert prepared.chat_import_result.folder_imported == 1
        assert prepared.chat_import_result.attachment_imported == 1
        assert prepared.chat_import_result.api_key_imported == 1
        assert prepared.chat_import_result.watermark_imported == 0
        assert prepared.chat_import_result.marker_created is True
        assert prepared.chat_metadata is not None
        assert prepared.chat_metadata.schema_revision == CHAT_STATE_IMPORT_REVISION
        assert (
            prepared.chat_metadata.prior_application_state_digest == prepared.metadata.source_digest
        )

        migrated = json.loads(state_path.read_text(encoding="utf-8"))
        assert migrated == prepared.payload
        assert migrated["version"] == 4
        assert migrated["durable_configuration"] == v3_payload["durable_configuration"]
        assert (
            migrated[APPLICATION_STATE_METADATA_KEY] == v3_payload[APPLICATION_STATE_METADATA_KEY]
        )
        assert migrated[CHAT_STATE_METADATA_KEY] == prepared.chat_metadata.to_dict()
        assert CHAT_STATE_RETIRED_FIELDS.isdisjoint(migrated)

        expected_thread = ChatThread.model_validate(v3_payload["chat_threads"][0])
        expected_folder = ChatFolder.model_validate(v3_payload["chat_folders"][0])
        expected_attachment = ChatAttachment.model_validate(v3_payload["chat_attachments"][0])
        expected_api_key = UserApiKeyRecord.model_validate(v3_payload["user_api_keys"][0])
        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            assert session.scalar(select(ChatThreadRow)).to_model() == expected_thread
            assert session.scalar(select(ChatFolderRow)).to_model() == expected_folder
            assert session.scalar(select(ChatAttachmentRow)).to_model() == expected_attachment
            assert session.scalar(select(UserApiKeyRow)).to_model() == expected_api_key
            assert _row_count(session, UserSessionWatermarkRow) == 0
            marker = session.get(ChatStateImportRow, prepared.chat_metadata.source_digest)
            assert marker is not None
            assert marker.prior_application_state_digest == prepared.metadata.source_digest
        assert "chat_sessions" not in inspect(engine).get_table_names()

        repeated = prepare_runtime_state(engine, state_path)
        assert repeated.rewritten is False
        assert repeated.chat_import_result is None
        assert repeated.chat_metadata == prepared.chat_metadata
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "mutation, error",
    [
        (
            lambda payload: payload["chat_threads"][0].__setitem__("messages", {"bad": True}),
            "messages: expected an array",
        ),
        (
            lambda payload: payload["chat_threads"][0]["messages"][0].__setitem__(
                "unknown_message_field", True
            ),
            "unknown fields unknown_message_field",
        ),
        (
            lambda payload: payload["chat_threads"][0]["messages"][0]["attachments"][0].__setitem__(
                "unknown_attachment_field", True
            ),
            "unknown fields unknown_attachment_field",
        ),
    ],
)
def test_v3_chat_messages_are_strictly_validated(
    tmp_path: Path,
    mutation: Any,
    error: str,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    payload = _seed_verified_v3(engine, state_path)
    mutation(payload)
    state_path.write_text(json.dumps(payload), encoding="utf-8")

    try:
        with pytest.raises(StateImportError, match=error):
            prepare_runtime_state(engine, state_path)
        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            assert _row_count(session, ChatStateImportRow) == 0
            assert _row_count(session, ChatThreadRow) == 0
    finally:
        engine.dispose()


def test_v3_rejects_nonfinite_message_json_before_sql_writes(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    payload = _seed_verified_v3(engine, state_path)
    payload["chat_threads"][0]["messages"][0]["metadata"]["invalid"] = float("nan")

    try:
        with pytest.raises(StateImportError, match="strict JSON"):
            validate_v3_chat_state(payload)
        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            assert _row_count(session, ChatStateImportRow) == 0
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "mutation",
    [
        lambda payload: payload.__setitem__("chat_sessions", []),
        lambda payload: payload["chat_sessions"][0].__setitem__("title", "Drifted title"),
        lambda payload: payload["chat_sessions"].append(
            {
                "id": "extra-session",
                "tenant_id": "tenant-a",
                "owner_user_id": "user-a",
                "title": "Extra",
                "model_id": "provider/model-a",
                "group_id": "group-a",
                "updated_at": "Just now",
            }
        ),
        lambda payload: payload["chat_sessions"][0].__setitem__("unknown", True),
    ],
)
def test_v3_chat_sessions_must_exactly_equal_thread_projection(
    tmp_path: Path,
    mutation: Any,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    payload = _seed_verified_v3(engine, state_path)
    mutation(payload)

    try:
        with pytest.raises(StateImportError, match="chat_sessions"):
            validate_v3_chat_state(payload)
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "mutation, error",
    [
        (
            lambda payload: (
                payload["chat_threads"][0].__setitem__("tenant_id", "missing-tenant"),
                payload["chat_sessions"][0].__setitem__("tenant_id", "missing-tenant"),
            ),
            "unknown tenant",
        ),
        (
            lambda payload: (
                payload["chat_threads"][0].__setitem__("owner_user_id", "user-b"),
                payload["chat_sessions"][0].__setitem__("owner_user_id", "user-b"),
            ),
            "crosses tenant ownership boundaries",
        ),
        (
            lambda payload: (
                payload["chat_threads"][0].__setitem__("owner_user_id", "missing-user"),
                payload["chat_sessions"][0].__setitem__("owner_user_id", "missing-user"),
            ),
            "unknown owner",
        ),
        (
            lambda payload: (
                payload["chat_threads"][0].__setitem__("folder_id", "missing-folder"),
                payload["chat_sessions"][0].__setitem__("folder_id", "missing-folder"),
            ),
            "folder outside its owner and tenant",
        ),
        (
            lambda payload: payload["chat_attachments"][0].__setitem__("owner_user_id", "user-b"),
            "crosses tenant ownership boundaries",
        ),
        (
            lambda payload: payload["user_api_keys"][0].__setitem__("id", "wrong-id"),
            "id must exactly match user_id",
        ),
        (
            lambda payload: payload["user_api_keys"][0].__setitem__("key_hash", "A" * 64),
            "lowercase SHA-256 digest",
        ),
        (
            lambda payload: payload["user_api_keys"].append(
                {
                    **payload["user_api_keys"][0],
                    "id": "user-b",
                    "user_id": "user-b",
                    "tenant_id": "tenant-b",
                }
            ),
            "duplicate key_hash",
        ),
    ],
)
def test_v3_a5_relationship_and_api_key_invariants_fail_before_import(
    tmp_path: Path,
    mutation: Any,
    error: str,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    payload = _seed_verified_v3(engine, state_path)
    mutation(payload)

    try:
        with pytest.raises(StateImportError, match=error):
            validate_v3_chat_state(payload)
        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            assert _row_count(session, ChatStateImportRow) == 0
    finally:
        engine.dispose()


def test_conflicting_chat_row_rolls_back_entire_a5_import(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    payload = _seed_verified_v3(engine, state_path)
    expected = ChatThread.model_validate(payload["chat_threads"][0])
    conflicting = expected.model_copy(update={"title": "Existing conflicting title"})
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        session.add(ChatThreadRow.from_model(conflicting))

    try:
        with pytest.raises(StateImportError, match="chat thread.*conflicts"):
            prepare_runtime_state(engine, state_path)
        assert json.loads(state_path.read_text(encoding="utf-8"))["version"] == 3
        with session_scope(factory) as session:
            assert session.scalar(select(ChatThreadRow)).to_model() == conflicting
            assert _row_count(session, ChatFolderRow) == 0
            assert _row_count(session, ChatAttachmentRow) == 0
            assert _row_count(session, UserApiKeyRow) == 0
            assert _row_count(session, ChatStateImportRow) == 0
    finally:
        engine.dispose()


def test_public_v3_import_is_strict_and_rolls_back_for_unrelated_rows(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    _seed_verified_v3(engine, state_path)
    unrelated = ChatAttachment(
        id="attachment-unrelated",
        tenant_id="tenant-a",
        owner_user_id="user-a",
        name="unrelated.txt",
        size="1 KB",
        kind="Text",
    )
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        session.add(ChatAttachmentRow.from_model(unrelated))

    try:
        with pytest.raises(StateImportError, match="rows outside the verified v3 import"):
            import_v3_chat_state(engine, state_path)
        with session_scope(factory) as session:
            assert [row.id for row in session.scalars(select(ChatAttachmentRow))] == [unrelated.id]
            assert _row_count(session, ChatThreadRow) == 0
            assert _row_count(session, ChatFolderRow) == 0
            assert _row_count(session, UserApiKeyRow) == 0
            assert _row_count(session, ChatStateImportRow) == 0
    finally:
        engine.dispose()


def test_a5_cutover_recovers_after_sql_commit_before_v4_rewrite(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.db import import_state

    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    _seed_verified_v3(engine, state_path)
    real_writer = import_state.write_runtime_state_atomic

    def fail_rewrite(_state_path: Path, _payload: dict[str, Any]) -> None:
        raise RuntimeError("simulated crash after A5 SQL commit")

    monkeypatch.setattr(import_state, "write_runtime_state_atomic", fail_rewrite)
    try:
        with pytest.raises(RuntimeError, match="after A5 SQL commit"):
            prepare_runtime_state(engine, state_path)
        assert json.loads(state_path.read_text(encoding="utf-8"))["version"] == 3

        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            assert _row_count(session, ChatStateImportRow) == 1
            assert _row_count(session, ChatThreadRow) == 1
            assert _row_count(session, ChatFolderRow) == 1
            assert _row_count(session, ChatAttachmentRow) == 1
            assert _row_count(session, UserApiKeyRow) == 1

        monkeypatch.setattr(import_state, "write_runtime_state_atomic", real_writer)
        recovered = prepare_runtime_state(engine, state_path)
        assert recovered.rewritten is True
        assert recovered.chat_import_result is not None
        assert recovered.chat_import_result.marker_created is False
        assert recovered.chat_import_result.thread_imported == 0
        assert recovered.chat_import_result.thread_skipped == 1
        assert json.loads(state_path.read_text(encoding="utf-8"))["version"] == 4
    finally:
        engine.dispose()


def test_v4_receipts_survive_a_future_linear_head(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.db import import_state

    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    _seed_verified_v3(engine, state_path)

    try:
        prepared = prepare_runtime_state(engine, state_path)
        future_head = "20260720_0005"
        with engine.begin() as connection:
            connection.execute(
                text("update alembic_version set version_num = :revision"),
                {"revision": future_head},
            )
        monkeypatch.setattr(import_state, "HEAD_REVISION", future_head)

        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            application_metadata, chat_metadata = verify_v4_state(session, prepared.payload)
        assert application_metadata.schema_revision == APPLICATION_STATE_IMPORT_REVISION
        assert chat_metadata.schema_revision == CHAT_STATE_IMPORT_REVISION
    finally:
        engine.dispose()


def test_semantically_equivalent_a5_defaults_share_canonical_digest(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    payload = _seed_verified_v3(engine, state_path)
    explicit = deepcopy(payload)
    explicit["chat_threads"][0].update({"pinned": False, "archived": False, "used_agent": False})
    explicit["chat_sessions"][0].update({"pinned": False, "archived": False, "used_agent": False})

    try:
        assert (
            validate_v3_chat_state(payload).source_digest
            == validate_v3_chat_state(explicit).source_digest
        )
    finally:
        engine.dispose()


@pytest.mark.parametrize("retired_field", sorted(CHAT_STATE_RETIRED_FIELDS))
def test_v4_rejects_reintroduced_sql_owned_fields(
    tmp_path: Path,
    retired_field: str,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    _seed_verified_v3(engine, state_path)

    try:
        prepared = prepare_runtime_state(engine, state_path)
        corrupted = deepcopy(prepared.payload)
        corrupted[retired_field] = []
        state_path.write_text(json.dumps(corrupted), encoding="utf-8")
        with pytest.raises(StateImportError, match="contains SQL-owned fields"):
            prepare_runtime_state(engine, state_path)
    finally:
        engine.dispose()


def test_v4_rejects_chat_receipt_count_tampering(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    _seed_verified_v3(engine, state_path)

    try:
        prepared = prepare_runtime_state(engine, state_path)
        corrupted = deepcopy(prepared.payload)
        corrupted[CHAT_STATE_METADATA_KEY]["thread_count"] += 1
        state_path.write_text(json.dumps(corrupted), encoding="utf-8")
        with pytest.raises(StateImportError, match="no matching chat-state import marker"):
            prepare_runtime_state(engine, state_path)
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "watermark_field",
    ["user_session_watermarks", "session_issued_before_ms"],
)
def test_v3_rejects_unsupported_legacy_watermarks(
    tmp_path: Path,
    watermark_field: str,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    payload = _seed_verified_v3(engine, state_path)
    payload[watermark_field] = [{"user_id": "user-a", "issued_before_ms": 1_000}]

    try:
        with pytest.raises(StateImportError, match="no authoritative legacy watermark"):
            validate_v3_chat_state(payload)
    finally:
        engine.dispose()


def test_missing_json_with_existing_database_authority_fails_closed(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    _seed_verified_v3(engine, state_path)

    try:
        prepare_runtime_state(engine, state_path)
        state_path.unlink()
        with pytest.raises(
            StateImportError,
            match="empty predecessor receipts.*operational or chat authority",
        ):
            prepare_runtime_state(engine, state_path)
    finally:
        engine.dispose()
