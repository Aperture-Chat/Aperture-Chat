from __future__ import annotations

import json
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select, text

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
    StateImportError,
    prepare_runtime_state,
    validate_legacy_state,
    verify_v4_state,
)
from app.db.orm import (
    AlertNotificationRow,
    AlertRuleRuntimeRow,
    AuditEventRow,
    AuditOutboxRow,
    ChatStateImportRow,
    RuntimeStateImportRow,
    UsageRecordRow,
)
from app.models.schemas import AlertNotification, AuditEvent, UsageRecord


def _sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _audit_event(*, event_id: str = "audit-cutover") -> AuditEvent:
    return AuditEvent(
        id=event_id,
        tenant_id="tenant-cutover",
        actor_id="user-cutover",
        actor_name="Casey Operator",
        actor_role="platform_owner",
        action="security.session.revoked",
        action_type="security",
        target="session:cutover",
        target_type="session",
        target_name="Cutover browser session",
        detail="Revoked during the application-state cutover test.",
        created_at=datetime(2026, 7, 20, 15, 5, 6, 123456, tzinfo=UTC),
        redacted=False,
        metadata={"reason": "explicit_review", "nested": {"attempt": 2}},
        severity="critical",
        severity_reason="Derived fields are intentionally not authoritative.",
    )


def _usage_record(*, record_id: str = "usage-cutover") -> UsageRecord:
    return UsageRecord(
        id=record_id,
        tenant_id="tenant-cutover",
        user_id="user-cutover",
        user_name="Casey Operator",
        user_role="platform_owner",
        model_id="provider/model-cutover",
        provider_name="Provider Cutover",
        surface="agent",
        message_count=3,
        prompt_tokens=321,
        completion_tokens=123,
        total_tokens=444,
        thread_id="thread-cutover",
        source="live",
        created_at=datetime(2026, 7, 20, 15, 6, 7, 654321, tzinfo=UTC),
    )


def _alert_notification() -> AlertNotification:
    return AlertNotification(
        id="notification-cutover",
        rule_id="rule-cutover",
        rule_name="Critical security changes",
        scope="tenant",
        tenant_id="tenant-cutover",
        event_id="audit-cutover",
        event_action="security.session.revoked",
        event_severity="critical",
        actor_id="user-cutover",
        actor_name="Casey Operator",
        summary="A redacted security change matched the configured rule.",
        matched_count=2,
        recipients=["security@example.test", "audit@example.test"],
        status="sent",
        status_detail="Delivered by the configured SMTP relay.",
        attempts=1,
        created_at=datetime(2026, 7, 20, 15, 7, 8, 111222, tzinfo=UTC),
        delivered_at=datetime(2026, 7, 20, 15, 7, 9, 333444, tzinfo=UTC),
    )


def _full_v2_payload() -> dict[str, Any]:
    audit = _audit_event()
    usage = _usage_record()
    notification = _alert_notification()
    return {
        "version": 2,
        "audit_events": [audit.model_dump(mode="json")],
        "usage_records": [usage.model_dump(mode="json")],
        "elastic_events": [
            {
                "id": audit.id,
                "event": audit.action,
                "tenant_id": audit.tenant_id,
                "detail": "Already-redacted durable delivery payload.",
                "metadata": {"source": "runtime-state-v2"},
            }
        ],
        "alert_rules": [
            {
                "id": "rule-cutover",
                "scope": "tenant",
                "tenant_id": "tenant-cutover",
                "name": "Critical security changes",
                "description": "Notify the tenant security team.",
                "enabled": True,
                "action_patterns": ["security.*"],
                "min_severity": "critical",
                "actor_ids": [],
                "threshold_count": 2,
                "window_minutes": 15,
                "cooldown_minutes": 60,
                "recipients": ["security@example.test"],
                "created_by": "user-cutover",
                "created_by_name": "Casey Operator",
                "created_at": "2026-07-20T14:00:00Z",
                "updated_at": "2026-07-20T14:30:00Z",
                "last_triggered_at": "2026-07-20T15:07:08.111222Z",
            }
        ],
        "alert_notifications": [notification.model_dump(mode="json")],
        "durable_configuration": {
            "nested": ["preserved", {"enabled": True}],
            "label": "This non-SQL state must survive byte-for-value migration.",
        },
    }


def _write_payload(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _row_count(session: Any, row_type: Any) -> int:
    return session.scalar(select(func.count()).select_from(row_type)) or 0


def test_v2_cutover_moves_all_sql_state_and_preserves_non_sql_fidelity(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    original = _full_v2_payload()
    _write_payload(state_path, original)
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))

    try:
        prepared = prepare_runtime_state(engine, state_path)

        assert prepared.rewritten is True
        assert prepared.import_result is not None
        assert prepared.import_result.audit_imported == 1
        assert prepared.import_result.usage_imported == 1
        assert prepared.import_result.outbox_imported == 1
        assert prepared.import_result.alert_notification_imported == 1
        assert prepared.import_result.alert_runtime_imported == 1
        assert prepared.import_result.marker_created is True

        migrated = json.loads(state_path.read_text(encoding="utf-8"))
        assert migrated == prepared.payload
        assert migrated["version"] == 4
        assert migrated["durable_configuration"] == original["durable_configuration"]
        for removed_key in (
            "audit_events",
            "usage_records",
            "elastic_events",
            "alert_notifications",
            "chat_threads",
            "chat_folders",
            "chat_sessions",
            "chat_attachments",
            "user_api_keys",
        ):
            assert removed_key not in migrated
        assert migrated["alert_rules"] == [
            {
                key: value
                for key, value in original["alert_rules"][0].items()
                if key != "last_triggered_at"
            }
        ]
        metadata = migrated[APPLICATION_STATE_METADATA_KEY]
        assert metadata == {
            "source_digest": prepared.metadata.source_digest,
            "source_version": 2,
            "target_version": 3,
            "schema_revision": APPLICATION_STATE_IMPORT_REVISION,
            "audit_count": 1,
            "usage_count": 1,
            "outbox_count": 1,
            "alert_notification_count": 1,
            "alert_runtime_count": 1,
        }
        assert prepared.chat_metadata is not None
        assert migrated[CHAT_STATE_METADATA_KEY] == prepared.chat_metadata.to_dict()
        assert prepared.chat_metadata.schema_revision == CHAT_STATE_IMPORT_REVISION
        assert prepared.chat_metadata.prior_application_state_digest == metadata["source_digest"]

        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            audit_row = session.scalar(select(AuditEventRow))
            usage_row = session.scalar(select(UsageRecordRow))
            outbox_row = session.scalar(select(AuditOutboxRow))
            notification_row = session.scalar(select(AlertNotificationRow))
            runtime_row = session.get(AlertRuleRuntimeRow, "rule-cutover")
            marker = session.get(RuntimeStateImportRow, prepared.metadata.source_digest)

            assert audit_row is not None
            assert audit_row.id == _audit_event().id
            assert audit_row.created_at == _audit_event().created_at
            assert audit_row.event_metadata == _audit_event().metadata
            assert usage_row is not None
            assert usage_row.to_model().model_dump() == _usage_record().model_dump()
            assert outbox_row is not None
            assert outbox_row.dedupe_key == "audit:audit-cutover"
            assert outbox_row.payload == original["elastic_events"][0]
            assert outbox_row.delivered_at is None
            assert notification_row is not None
            assert notification_row.to_model().model_dump() == _alert_notification().model_dump()
            assert runtime_row is not None
            assert runtime_row.last_triggered_at == datetime(
                2026, 7, 20, 15, 7, 8, 111222, tzinfo=UTC
            )
            assert marker is not None
            assert marker.audit_count == 1
            assert marker.usage_count == 1
            assert marker.outbox_count == 1
            assert marker.alert_notification_count == 1
            assert marker.alert_runtime_count == 1

        verified = prepare_runtime_state(engine, state_path)
        assert verified.rewritten is False
        assert verified.import_result is None
        assert verified.metadata == prepared.metadata
    finally:
        engine.dispose()


def test_missing_usage_is_backfilled_deterministically_and_repeat_is_idempotent(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    payload: dict[str, Any] = {
        "version": 2,
        "tenants": [
            {
                "id": "tenant-backfill",
                "name": "Backfill Tenant",
                "slug": "backfill-tenant",
            }
        ],
        "users": [
            {
                "id": "user-backfill",
                "tenant_id": "tenant-backfill",
                "email": "backfill@example.test",
                "display_name": "Backfill User",
                "role": "USER",
            }
        ],
        "models": [
            {
                "id": "model-backfill",
                "tenant_id": "tenant-backfill",
                "provider_id": "provider-backfill",
                "provider_name": "Provider Backfill",
                "name": "Model Backfill",
            }
        ],
        "chat_threads": [
            {
                "id": "thread-backfill",
                "tenant_id": "tenant-backfill",
                "owner_user_id": "user-backfill",
                "title": "Historical response",
                "model_id": "model-backfill",
                "group_id": "group-backfill",
                "updated_at": "Just now",
                "messages": [
                    {
                        "id": "message-user",
                        "role": "user",
                        "content": "Question",
                        "createdAt": "9:00 AM",
                        "createdAtIso": "2026-07-20T15:00:00Z",
                    },
                    {
                        "id": "message-assistant",
                        "role": "assistant",
                        "content": "Answer",
                        "createdAt": "9:00 AM",
                        "createdAtIso": "2026-07-20T15:00:01.234567Z",
                        "usage": {
                            "prompt_tokens": 11,
                            "completion_tokens": 7,
                            "total_tokens": 18,
                        },
                    },
                ],
            }
        ],
        "chat_sessions": [
            {
                "id": "thread-backfill",
                "tenant_id": "tenant-backfill",
                "owner_user_id": "user-backfill",
                "title": "Historical response",
                "model_id": "model-backfill",
                "group_id": "group-backfill",
                "updated_at": "Just now",
            }
        ],
    }
    first_validation = validate_legacy_state(deepcopy(payload))
    second_validation = validate_legacy_state(deepcopy(payload))
    assert first_validation.usage_backfilled is True
    assert second_validation.usage_backfilled is True
    assert first_validation.source_digest == second_validation.source_digest
    assert [record.id for record in first_validation.usage_records] == [
        record.id for record in second_validation.usage_records
    ]
    assert len(first_validation.usage_records) == 1
    expected = first_validation.usage_records[0]
    assert expected.id.startswith("usage-backfill-")
    assert expected.user_name == "Backfill User"
    assert expected.user_role == "USER"
    assert expected.provider_name == "Provider Backfill"
    assert expected.prompt_tokens == 11
    assert expected.completion_tokens == 7
    assert expected.total_tokens == 18

    _write_payload(state_path, payload)
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    try:
        first = prepare_runtime_state(engine, state_path)
        repeated = prepare_runtime_state(engine, state_path)
        assert first.rewritten is True
        assert repeated.rewritten is False
        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            records = list(session.scalars(select(UsageRecordRow)))
            assert len(records) == 1
            assert records[0].to_model().model_dump() == expected.model_dump()
            assert _row_count(session, RuntimeStateImportRow) == 1
    finally:
        engine.dispose()


def test_cutover_recovers_after_sql_commit_before_json_rewrite(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.db import import_state

    state_path = tmp_path / "runtime_state.json"
    original = _full_v2_payload()
    _write_payload(state_path, original)
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    real_writer = import_state.write_runtime_state_atomic

    def fail_rewrite(_state_path: Path, _payload: dict[str, Any]) -> None:
        raise RuntimeError("simulated crash after the SQL commit")

    monkeypatch.setattr(import_state, "write_runtime_state_atomic", fail_rewrite)
    try:
        with pytest.raises(RuntimeError, match="simulated crash"):
            prepare_runtime_state(engine, state_path)

        assert json.loads(state_path.read_text(encoding="utf-8"))["version"] == 2
        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            assert _row_count(session, RuntimeStateImportRow) == 1
            assert _row_count(session, AuditEventRow) == 1
            assert _row_count(session, UsageRecordRow) == 1
            assert _row_count(session, AuditOutboxRow) == 1
            assert _row_count(session, AlertNotificationRow) == 1
            assert _row_count(session, AlertRuleRuntimeRow) == 1

        monkeypatch.setattr(import_state, "write_runtime_state_atomic", real_writer)
        recovered = prepare_runtime_state(engine, state_path)
        assert recovered.rewritten is True
        assert recovered.import_result is not None
        assert recovered.import_result.marker_created is False
        assert recovered.import_result.audit_imported == 0
        assert recovered.import_result.usage_imported == 0
        assert recovered.import_result.outbox_imported == 0
        assert recovered.import_result.alert_notification_imported == 0
        assert recovered.import_result.alert_runtime_imported == 0
        assert json.loads(state_path.read_text(encoding="utf-8"))["version"] == 4
        with session_scope(factory) as session:
            assert _row_count(session, RuntimeStateImportRow) == 1
            assert _row_count(session, AuditEventRow) == 1
            assert _row_count(session, UsageRecordRow) == 1
            assert _row_count(session, AuditOutboxRow) == 1
            assert _row_count(session, AlertNotificationRow) == 1
            assert _row_count(session, AlertRuleRuntimeRow) == 1
    finally:
        engine.dispose()


def test_v3_without_metadata_or_matching_marker_fails_closed(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    try:
        _write_payload(state_path, {"version": 3, "durable_configuration": {}})
        with pytest.raises(StateImportError, match="missing application-state metadata"):
            prepare_runtime_state(engine, state_path)

        source_engine = create_application_engine(_sqlite_url(tmp_path / "source.sqlite3"))
        try:
            source_state_path = tmp_path / "source-runtime-state.json"
            _write_payload(source_state_path, _full_v2_payload())
            prepare_runtime_state(source_engine, source_state_path)
            _write_payload(
                state_path,
                json.loads(source_state_path.read_text(encoding="utf-8")),
            )
        finally:
            source_engine.dispose()

        with pytest.raises(StateImportError, match="no matching relational import marker"):
            prepare_runtime_state(engine, state_path)
    finally:
        engine.dispose()


def test_v3_with_mismatched_marker_counts_fails_closed(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime_state.json"
    _write_payload(state_path, _full_v2_payload())
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    try:
        prepare_runtime_state(engine, state_path)
        migrated = json.loads(state_path.read_text(encoding="utf-8"))
        migrated[APPLICATION_STATE_METADATA_KEY]["usage_count"] += 1
        _write_payload(state_path, migrated)

        with pytest.raises(StateImportError, match="no matching relational import marker"):
            prepare_runtime_state(engine, state_path)
    finally:
        engine.dispose()


def test_v3_rejects_retired_sql_owned_json_fields(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime_state.json"
    _write_payload(state_path, _full_v2_payload())
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    try:
        prepare_runtime_state(engine, state_path)
        migrated = json.loads(state_path.read_text(encoding="utf-8"))
        migrated["usage_records"] = []
        _write_payload(state_path, migrated)

        with pytest.raises(StateImportError, match="contains SQL-owned fields: usage_records"):
            prepare_runtime_state(engine, state_path)
    finally:
        engine.dispose()


def test_import_receipts_survive_a_future_linear_head(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.db import import_state

    state_path = tmp_path / "runtime_state.json"
    _write_payload(state_path, _full_v2_payload())
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
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


def test_conflicting_existing_row_rolls_back_every_imported_row_and_marker(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    payload = _full_v2_payload()
    _write_payload(state_path, payload)
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    conflicting_usage = _usage_record().model_copy(
        update={
            "user_name": "Conflicting Existing User",
            "prompt_tokens": 999,
            "total_tokens": 1_122,
        }
    )
    with session_scope(factory) as session:
        session.add(UsageRecordRow.from_model(conflicting_usage))

    try:
        with pytest.raises(StateImportError, match="usage record.*conflicts"):
            prepare_runtime_state(engine, state_path)

        assert json.loads(state_path.read_text(encoding="utf-8"))["version"] == 2
        with session_scope(factory) as session:
            usage_rows = list(session.scalars(select(UsageRecordRow)))
            assert len(usage_rows) == 1
            assert usage_rows[0].to_model().model_dump() == conflicting_usage.model_dump()
            assert _row_count(session, RuntimeStateImportRow) == 0
            assert _row_count(session, AuditEventRow) == 0
            assert _row_count(session, AuditOutboxRow) == 0
            assert _row_count(session, AlertNotificationRow) == 0
            assert _row_count(session, AlertRuleRuntimeRow) == 0
    finally:
        engine.dispose()


def test_unrelated_existing_sql_row_fails_strict_startup_cutover(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime_state.json"
    _write_payload(state_path, _full_v2_payload())
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    unrelated = _usage_record(record_id="usage-unrelated")
    with session_scope(factory) as session:
        session.add(UsageRecordRow.from_model(unrelated))

    try:
        with pytest.raises(StateImportError, match="rows outside the verified"):
            prepare_runtime_state(engine, state_path)

        assert json.loads(state_path.read_text(encoding="utf-8"))["version"] == 2
        with session_scope(factory) as session:
            assert [row.id for row in session.scalars(select(UsageRecordRow))] == [unrelated.id]
            assert _row_count(session, RuntimeStateImportRow) == 0
            assert _row_count(session, AuditEventRow) == 0
            assert _row_count(session, AuditOutboxRow) == 0
            assert _row_count(session, AlertNotificationRow) == 0
            assert _row_count(session, AlertRuleRuntimeRow) == 0
    finally:
        engine.dispose()


def test_missing_json_cannot_claim_a_nonempty_database(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    unrelated = _usage_record(record_id="usage-without-json")
    with session_scope(factory) as session:
        session.add(UsageRecordRow.from_model(unrelated))

    try:
        with pytest.raises(
            StateImportError,
            match="empty predecessor receipts.*operational or chat authority",
        ):
            prepare_runtime_state(engine, state_path)
        assert not state_path.exists()
        with session_scope(factory) as session:
            assert _row_count(session, RuntimeStateImportRow) == 0
            assert _row_count(session, UsageRecordRow) == 1
    finally:
        engine.dispose()


def test_fresh_start_creates_verifiable_empty_v4_state_and_markers(tmp_path: Path) -> None:
    state_path = tmp_path / "nested" / "runtime_state.json"
    engine = create_application_engine(_sqlite_url(tmp_path / "application.sqlite3"))
    try:
        first = prepare_runtime_state(engine, state_path)
        assert first.rewritten is True
        assert first.import_result is None
        assert first.metadata.source_version == 0
        assert first.metadata.target_version == 3
        assert first.metadata.schema_revision == APPLICATION_STATE_IMPORT_REVISION
        assert first.metadata.audit_count == 0
        assert first.metadata.usage_count == 0
        assert first.metadata.outbox_count == 0
        assert first.metadata.alert_notification_count == 0
        assert first.metadata.alert_runtime_count == 0
        assert json.loads(state_path.read_text(encoding="utf-8")) == first.payload
        assert first.chat_metadata is not None
        assert first.chat_metadata.source_version == 3
        assert first.chat_metadata.target_version == 4
        assert first.chat_metadata.schema_revision == CHAT_STATE_IMPORT_REVISION
        assert first.payload == {
            "version": 4,
            APPLICATION_STATE_METADATA_KEY: first.metadata.to_dict(),
            CHAT_STATE_METADATA_KEY: first.chat_metadata.to_dict(),
        }

        repeated = prepare_runtime_state(engine, state_path)
        assert repeated.rewritten is False
        assert repeated.import_result is None
        assert repeated.metadata == first.metadata

        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            marker = session.get(RuntimeStateImportRow, first.metadata.source_digest)
            chat_marker = session.get(ChatStateImportRow, first.chat_metadata.source_digest)
            assert marker is not None
            assert chat_marker is not None
            assert marker.source_version == 0
            assert marker.target_version == 3
            assert _row_count(session, RuntimeStateImportRow) == 1
            assert _row_count(session, ChatStateImportRow) == 1
            assert _row_count(session, AuditEventRow) == 0
            assert _row_count(session, UsageRecordRow) == 0
            assert _row_count(session, AuditOutboxRow) == 0
            assert _row_count(session, AlertNotificationRow) == 0
            assert _row_count(session, AlertRuleRuntimeRow) == 0
    finally:
        engine.dispose()
