from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta, timezone
from io import StringIO
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import IntegrityError

from app.core.config import Settings, get_settings
from app.db import (
    HEAD_REVISION,
    AuditEventRow,
    AuditOutboxRow,
    Base,
    RevokedSessionRow,
    UsageRecordRow,
    create_application_engine,
    create_session_factory,
    current_schema_revision,
    session_scope,
    upgrade_database,
)
from app.db.import_state import StateImportError, import_legacy_state, main as import_state_main
from app.db.engine import alembic_config
from app.models.schemas import AuditEvent, UsageRecord


def _sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _audit_event(*, event_id: str = "audit-complete") -> AuditEvent:
    return AuditEvent(
        id=event_id,
        tenant_id="tenant-full",
        actor_id="user-full",
        actor_name="Avery Operator",
        actor_role="platform_owner",
        action="security.session.revoked",
        action_type="security",
        target="session:deadbeef",
        target_type="session",
        target_name="Browser session",
        detail="Revoked after an explicit security review.",
        created_at=datetime(
            2026,
            7,
            20,
            8,
            9,
            10,
            123456,
            tzinfo=timezone(timedelta(hours=-6)),
        ),
        redacted=False,
        metadata={
            "nested": {"attempt": 3},
            "labels": ["auth", "review"],
            "real": True,
            "captured_at": datetime(2026, 7, 20, 14, 8, 0, tzinfo=UTC),
        },
        severity="critical",
        severity_reason="An active session was deliberately revoked.",
    )


def _usage_record(*, record_id: str = "usage-complete") -> UsageRecord:
    return UsageRecord(
        id=record_id,
        tenant_id="tenant-full",
        user_id="user-full",
        user_name="Avery Operator",
        user_role="platform_owner",
        model_id="provider/model-with-every-field",
        provider_name="Provider Full",
        surface="agent",
        message_count=7,
        prompt_tokens=1_234_567_890,
        completion_tokens=987_654_321,
        total_tokens=2_222_222_211,
        thread_id="thread-full",
        source="live",
        created_at=datetime(2026, 7, 20, 14, 9, 10, 654321, tzinfo=UTC),
    )


def _persisted_audit(event: AuditEvent) -> AuditEvent:
    # Audit severity is deliberately derived on read by audit_severity.py and
    # must never become authoritative database state.
    serialized = event.model_dump(mode="json")
    serialized.update({"severity": "", "severity_reason": ""})
    return AuditEvent.model_validate(serialized)


def test_settings_use_sqlite_path_by_default_and_allow_database_url_override(
    tmp_path: Path,
) -> None:
    database_path = tmp_path / "application.sqlite3"
    settings = Settings(
        _env_file=None,
        environment="test",
        secret_key="test-only-secret",
        application_db_path=str(database_path),
        database_url=None,
    )
    assert settings.application_database_url == _sqlite_url(database_path)

    configured_url = "postgresql+psycopg://db.internal/aperture"
    settings.database_url = f"  {configured_url}  "
    assert settings.application_database_url == configured_url


def test_empty_database_migrates_to_head_with_sqlite_safety_settings(tmp_path: Path) -> None:
    database_path = tmp_path / "nested" / "database" / "empty.sqlite3"
    engine = create_application_engine(_sqlite_url(database_path))
    try:
        assert database_path.parent.is_dir()
        assert current_schema_revision(engine) is None

        upgrade_database(engine)
        upgrade_database(engine)

        assert current_schema_revision(engine) == HEAD_REVISION
        assert set(inspect(engine).get_table_names()) == {
            "agent_runs",
            "alembic_version",
            "alert_notifications",
            "alert_rule_configs",
            "alert_rule_runtime",
            "audit_events",
            "audit_outbox",
            "automations",
            "chat_attachments",
            "chat_feedback",
            "chat_folders",
            "chat_state_imports",
            "chat_thread_tags",
            "chat_threads",
            "companion_memories",
            "configuration_secrets",
            "connector_configs",
            "connectors",
            "content_filters",
            "cutover_vector_source_consumed",
            "cutover_vector_source_journal",
            "draft_documents",
            "draft_revisions",
            "email_settings",
            "identity_cleanup_job_users",
            "identity_cleanup_jobs",
            "identity_config_active_import",
            "identity_config_imports",
            "identity_groups",
            "identity_users",
            "issue_reports",
            "knowledge_configs",
            "matter_deletion_jobs",
            "matter_memberships",
            "matters",
            "mfa_preauth_challenges",
            "model_configs",
            "password_credentials",
            "platform_settings",
            "prompt_templates",
            "provider_credential_bindings",
            "provider_keys",
            "providers",
            "retention_hold_threads",
            "retention_holds",
            "revoked_sessions",
            "runtime_state_imports",
            "scim_tokens",
            "security_alerts",
            "session_families",
            "skill_files",
            "sso_configs",
            "tenant_memory_policies",
            "tenant_mfa_policies",
            "tenant_retention_policies",
            "principal_daily_usage",
                "principal_usage_budgets",
                "tenant_daily_usage",
            "tenant_usage_budgets",
            "tenant_usage_completion_events",
            "tenant_usage_permits",
            "tenants",
            "tool_configs",
            "totp_pending_enrollments",
            "totp_recovery_codes",
            "usage_records",
            "user_api_keys",
            "user_memories",
            "user_memory_settings",
            "user_session_watermarks",
            "user_totp_factors",
        }
        inspector = inspect(engine)
        assert {column["name"] for column in inspector.get_columns("audit_events")} == {
            "sequence",
            "id",
            "tenant_id",
            "actor_id",
            "actor_name",
            "actor_role",
            "action",
            "action_type",
            "target",
            "target_type",
            "target_name",
            "detail",
            "created_at",
            "redacted",
            "metadata",
        }
        assert {column["name"] for column in inspector.get_columns("usage_records")} == {
            "sequence",
            "id",
            "tenant_id",
            "user_id",
            "user_name",
            "user_role",
            "model_id",
            "provider_name",
            "surface",
            "message_count",
            "prompt_tokens",
            "completion_tokens",
            "total_tokens",
            "thread_id",
            "source",
            "created_at",
        }
        assert {column["name"] for column in inspector.get_columns("revoked_sessions")} == {
            "sid",
            "user_id",
            "tenant_id",
            "issued_at",
            "expires_at",
            "revoked_at",
            "reason",
        }
        assert {column["name"] for column in inspector.get_columns("session_families")} == {
            "sid",
            "user_id",
            "tenant_id",
            "auth_method",
            "max_expires_at",
            "legacy_unbounded",
            "revoked_at",
            "revoked_by_issued_at",
            "revoked_by_expires_at",
            "updated_at",
        }
        assert {column["name"] for column in inspector.get_columns("audit_outbox")} == {
            "sequence",
            "dedupe_key",
            "event_id",
            "tenant_id",
            "payload",
            "delivered_at",
        }
        # Historical governance records deliberately survive user/tenant
        # deletion; no cascade-capable identity foreign keys belong here.
        assert inspector.get_foreign_keys("audit_events") == []
        assert inspector.get_foreign_keys("usage_records") == []
        assert inspector.get_foreign_keys("audit_outbox") == []
        with engine.connect() as connection:
            assert connection.execute(text("PRAGMA foreign_keys")).scalar_one() == 1
            assert connection.execute(text("PRAGMA journal_mode")).scalar_one().lower() == "wal"
            assert connection.execute(text("PRAGMA busy_timeout")).scalar_one() == 30_000
            context = MigrationContext.configure(connection)
            assert compare_metadata(context, Base.metadata) == []
    finally:
        engine.dispose()


def test_notification_sequence_migration_is_deterministic_lossless_and_non_reusing(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "notification-upgrade.sqlite3"))
    try:
        upgrade_database(engine, "20260720_0002")
        original_rows = [
            {
                "id": "notification-z",
                "rule_id": "rule-z",
                "rule_name": "Equal time Z",
                "scope": "tenant",
                "tenant_id": "tenant-z",
                "event_id": "audit-z",
                "event_action": "security.equal.z",
                "event_severity": "critical",
                "actor_id": "user-z",
                "actor_name": "Zeta User",
                "summary": "Equal timestamp sorts after A by id.",
                "matched_count": 3,
                "recipients": json.dumps(["z@example.test", "second@example.test"]),
                "status": "sent",
                "status_detail": "Delivered with unicode: café",
                "attempts": 2,
                "created_at": "2026-07-20 12:00:00.123456",
                "delivered_at": "2026-07-20 12:01:02.654321",
            },
            {
                "id": "notification-a",
                "rule_id": "rule-a",
                "rule_name": "Equal time A",
                "scope": "platform",
                "tenant_id": None,
                "event_id": "audit-a",
                "event_action": "platform.equal.a",
                "event_severity": "info",
                "actor_id": "owner-a",
                "actor_name": "Alpha Owner",
                "summary": "Equal timestamp sorts before Z by id.",
                "matched_count": 1,
                "recipients": json.dumps([]),
                "status": "not_configured",
                "status_detail": "SMTP intentionally absent",
                "attempts": 0,
                "created_at": "2026-07-20 12:00:00.123456",
                "delivered_at": None,
            },
            {
                "id": "notification-first",
                "rule_id": "rule-first",
                "rule_name": "Earlier notification",
                "scope": "tenant",
                "tenant_id": "tenant-first",
                "event_id": "audit-first",
                "event_action": "security.first",
                "event_severity": "warning",
                "actor_id": "user-first",
                "actor_name": "First User",
                "summary": "Earlier timestamp remains first.",
                "matched_count": 2,
                "recipients": json.dumps(["first@example.test"]),
                "status": "logged",
                "status_detail": "",
                "attempts": 1,
                "created_at": "2026-07-20 11:59:59.999999",
                "delivered_at": None,
            },
        ]
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    insert into alert_notifications (
                        id, rule_id, rule_name, scope, tenant_id, event_id,
                        event_action, event_severity, actor_id, actor_name,
                        summary, matched_count, recipients, status,
                        status_detail, attempts, created_at, delivered_at
                    ) values (
                        :id, :rule_id, :rule_name, :scope, :tenant_id, :event_id,
                        :event_action, :event_severity, :actor_id, :actor_name,
                        :summary, :matched_count, :recipients, :status,
                        :status_detail, :attempts, :created_at, :delivered_at
                    )
                    """
                ),
                original_rows,
            )

        upgrade_database(engine)

        inspector = inspect(engine)
        assert inspector.get_pk_constraint("alert_notifications")["constrained_columns"] == [
            "sequence"
        ]
        assert {
            tuple(item["column_names"])
            for item in inspector.get_unique_constraints("alert_notifications")
        } == {("id",)}
        with engine.begin() as connection:
            migrated = (
                connection.execute(
                    text(
                        """
                    select sequence, id, rule_id, rule_name, scope, tenant_id,
                           event_id, event_action, event_severity, actor_id,
                           actor_name, summary, matched_count, recipients, status,
                           status_detail, attempts, created_at, delivered_at
                    from alert_notifications
                    order by sequence
                    """
                    )
                )
                .mappings()
                .all()
            )
            assert [(row["sequence"], row["id"]) for row in migrated] == [
                (1, "notification-first"),
                (2, "notification-a"),
                (3, "notification-z"),
            ]
            expected_by_id = {row["id"]: row for row in original_rows}
            for row in migrated:
                expected = expected_by_id[row["id"]]
                for field in (
                    "rule_id",
                    "rule_name",
                    "scope",
                    "tenant_id",
                    "event_id",
                    "event_action",
                    "event_severity",
                    "actor_id",
                    "actor_name",
                    "summary",
                    "matched_count",
                    "status",
                    "status_detail",
                    "attempts",
                    "created_at",
                    "delivered_at",
                ):
                    assert row[field] == expected[field]
                assert json.loads(row["recipients"]) == json.loads(expected["recipients"])

            # Deleting the highest sequence distinguishes AUTOINCREMENT from a
            # plain INTEGER PRIMARY KEY, which would otherwise reuse 3.
            connection.execute(text("delete from alert_notifications where sequence = 3"))
            replacement = dict(original_rows[0])
            replacement.update(
                {
                    "id": "notification-replacement",
                    "rule_id": "rule-replacement",
                    "event_id": "audit-replacement",
                }
            )
            connection.execute(
                text(
                    """
                    insert into alert_notifications (
                        id, rule_id, rule_name, scope, tenant_id, event_id,
                        event_action, event_severity, actor_id, actor_name,
                        summary, matched_count, recipients, status,
                        status_detail, attempts, created_at, delivered_at
                    ) values (
                        :id, :rule_id, :rule_name, :scope, :tenant_id, :event_id,
                        :event_action, :event_severity, :actor_id, :actor_name,
                        :summary, :matched_count, :recipients, :status,
                        :status_detail, :attempts, :created_at, :delivered_at
                    )
                    """
                ),
                replacement,
            )
            assert (
                connection.execute(
                    text(
                        "select sequence from alert_notifications "
                        "where id = 'notification-replacement'"
                    )
                ).scalar_one()
                == 4
            )
            assert (
                connection.execute(
                    text("select seq from sqlite_sequence where name = 'alert_notifications'")
                ).scalar_one()
                == 4
            )
    finally:
        engine.dispose()


def test_postgresql_base_to_head_migrations_render_offline_without_reflection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    buffer = StringIO()
    monkeypatch.setenv("APERTURE_DATABASE_URL", "postgresql://offline.invalid/aperture")
    get_settings.cache_clear()
    config = alembic_config()
    config.output_buffer = buffer
    try:
        command.upgrade(config, "head", sql=True)
    finally:
        get_settings.cache_clear()

    rendered = buffer.getvalue()
    assert "CREATE SEQUENCE alert_notifications_sequence_seq AS BIGINT" in rendered
    assert "row_number() OVER (ORDER BY created_at, id)::BIGINT" in rendered
    assert (
        "ALTER SEQUENCE alert_notifications_sequence_seq OWNED BY alert_notifications.sequence"
    ) in rendered
    assert "nextval('alert_notifications_sequence_seq'::regclass)" in rendered
    assert "ADD CONSTRAINT uq_alert_notifications_id UNIQUE (id)" in rendered
    assert "CREATE TABLE session_families" in rendered
    assert "INSERT INTO session_families" in rendered
    assert "CREATE INDEX ix_session_families_revoked_max_expires_at" in rendered
    assert "CREATE TABLE tenant_mfa_policies" in rendered
    assert "CREATE TABLE user_totp_factors" in rendered
    assert "CREATE TABLE totp_pending_enrollments" in rendered
    assert "CREATE TABLE mfa_preauth_challenges" in rendered
    assert "CREATE TABLE totp_recovery_codes" in rendered
    assert "_alembic_tmp_alert_notifications" not in rendered


def test_all_relational_fields_survive_commit_and_engine_restart(tmp_path: Path) -> None:
    database_url = _sqlite_url(tmp_path / "round-trip.sqlite3")
    expected_audit = _audit_event()
    expected_usage = _usage_record()
    expected_revoked_at = datetime(2026, 7, 20, 15, 30, 45, 765432, tzinfo=UTC)
    expected_delivered_at = datetime(2026, 7, 20, 16, 45, 12, 345678, tzinfo=UTC)
    expected_outbox = AuditOutboxRow.from_audit_event(expected_audit)
    expected_outbox.delivered_at = expected_delivered_at
    expected_outbox_payload = dict(expected_outbox.payload)

    engine = create_application_engine(database_url)
    upgrade_database(engine)
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        session.add(AuditEventRow.from_model(expected_audit))
        session.add(UsageRecordRow.from_model(expected_usage))
        session.add(expected_outbox)
        session.add(
            RevokedSessionRow(
                sid="deadbeef01234567",
                user_id="user-full",
                tenant_id="tenant-full",
                issued_at=1_774_192_245,
                expires_at=1_774_796_245,
                revoked_at=expected_revoked_at,
                reason="administrator_logout_all",
            )
        )
    engine.dispose()

    restarted_engine = create_application_engine(database_url)
    try:
        assert current_schema_revision(restarted_engine) == HEAD_REVISION
        restarted_factory = create_session_factory(restarted_engine)
        with session_scope(restarted_factory) as session:
            audit_row = session.scalar(
                select(AuditEventRow).where(AuditEventRow.id == expected_audit.id)
            )
            usage_row = session.scalar(
                select(UsageRecordRow).where(UsageRecordRow.id == expected_usage.id)
            )
            revoked_row = session.get(RevokedSessionRow, "deadbeef01234567")
            outbox_row = session.scalar(
                select(AuditOutboxRow).where(
                    AuditOutboxRow.dedupe_key == f"audit:{expected_audit.id}"
                )
            )

            assert audit_row is not None
            assert (
                audit_row.to_model().model_dump() == _persisted_audit(expected_audit).model_dump()
            )
            assert usage_row is not None
            assert usage_row.to_model().model_dump() == expected_usage.model_dump()
            assert revoked_row is not None
            assert {
                "sid": revoked_row.sid,
                "user_id": revoked_row.user_id,
                "tenant_id": revoked_row.tenant_id,
                "issued_at": revoked_row.issued_at,
                "expires_at": revoked_row.expires_at,
                "revoked_at": revoked_row.revoked_at,
                "reason": revoked_row.reason,
            } == {
                "sid": "deadbeef01234567",
                "user_id": "user-full",
                "tenant_id": "tenant-full",
                "issued_at": 1_774_192_245,
                "expires_at": 1_774_796_245,
                "revoked_at": expected_revoked_at,
                "reason": "administrator_logout_all",
            }
            assert outbox_row is not None
            assert outbox_row.event_id == expected_audit.id
            assert outbox_row.tenant_id == expected_audit.tenant_id
            assert outbox_row.payload == expected_outbox_payload
            assert outbox_row.delivered_at == expected_delivered_at
    finally:
        restarted_engine.dispose()


def test_legacy_v2_import_is_exact_idempotent_and_does_not_rewrite_source(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "runtime_state.json"
    expected_audit = _audit_event(event_id="audit-import")
    expected_usage = _usage_record(record_id="usage-import")
    expected_outbox_payload = AuditOutboxRow.from_audit_event(expected_audit).payload
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "audit_events": [expected_audit.model_dump(mode="json")],
                "usage_records": [expected_usage.model_dump(mode="json")],
                "elastic_events": [expected_outbox_payload],
                "unrelated_runtime_state": {"must": "remain untouched"},
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    original_source = state_path.read_bytes()
    database_url = _sqlite_url(tmp_path / "import.sqlite3")

    engine = create_application_engine(database_url)
    first_result = import_legacy_state(engine, state_path)
    second_result = import_legacy_state(engine, state_path)
    engine.dispose()

    assert first_result.state_version == 2
    assert (
        first_result.audit_imported,
        first_result.usage_imported,
        first_result.outbox_imported,
    ) == (1, 1, 1)
    assert (
        first_result.alert_notification_imported,
        first_result.alert_runtime_imported,
    ) == (0, 0)
    assert first_result.marker_created is True
    assert len(first_result.source_digest) == 64
    assert second_result.state_version == 2
    assert (
        second_result.audit_skipped,
        second_result.usage_skipped,
        second_result.outbox_skipped,
    ) == (1, 1, 1)
    assert (
        second_result.alert_notification_skipped,
        second_result.alert_runtime_skipped,
    ) == (0, 0)
    assert second_result.marker_created is False
    assert second_result.source_digest == first_result.source_digest
    assert state_path.read_bytes() == original_source

    restarted_engine = create_application_engine(database_url)
    try:
        factory = create_session_factory(restarted_engine)
        with session_scope(factory) as session:
            audit_rows = list(session.scalars(select(AuditEventRow)))
            usage_rows = list(session.scalars(select(UsageRecordRow)))
            outbox_rows = list(session.scalars(select(AuditOutboxRow)))
            assert len(audit_rows) == 1
            assert (
                audit_rows[0].to_model().model_dump()
                == _persisted_audit(expected_audit).model_dump()
            )
            assert len(usage_rows) == 1
            assert usage_rows[0].to_model().model_dump() == expected_usage.model_dump()
            assert len(outbox_rows) == 1
            assert outbox_rows[0].payload == expected_outbox_payload
            assert outbox_rows[0].delivered_at is None
    finally:
        restarted_engine.dispose()


def test_import_rejects_duplicate_or_invalid_legacy_records_before_writing(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "duplicate-runtime-state.json"
    duplicate = _audit_event(event_id="same-id").model_dump(mode="json")
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "audit_events": [duplicate, duplicate],
                "usage_records": [],
            }
        ),
        encoding="utf-8",
    )
    engine = create_application_engine(_sqlite_url(tmp_path / "duplicate.sqlite3"))
    upgrade_database(engine)
    try:
        with pytest.raises(StateImportError, match="contains duplicate id 'same-id'"):
            import_legacy_state(engine, state_path)
        with engine.connect() as connection:
            assert connection.execute(text("select count(*) from audit_events")).scalar_one() == 0
            assert connection.execute(text("select count(*) from usage_records")).scalar_one() == 0
    finally:
        engine.dispose()


def test_import_preserves_append_order_independent_of_created_at(tmp_path: Path) -> None:
    first = _audit_event(event_id="audit-appended-first")
    second = _audit_event(event_id="audit-appended-second").model_copy(
        update={"created_at": first.created_at - timedelta(days=30)}
    )
    state_path = tmp_path / "append-order.json"
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "audit_events": [
                    first.model_dump(mode="json"),
                    second.model_dump(mode="json"),
                ],
                "usage_records": [],
            }
        ),
        encoding="utf-8",
    )
    engine = create_application_engine(_sqlite_url(tmp_path / "append-order.sqlite3"))
    try:
        import_legacy_state(engine, state_path)
        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            rows = list(session.scalars(select(AuditEventRow).order_by(AuditEventRow.sequence)))
            assert [row.id for row in rows] == [first.id, second.id]
    finally:
        engine.dispose()


def test_simultaneous_imports_use_unique_external_ids_without_duplicates(tmp_path: Path) -> None:
    state_path = tmp_path / "simultaneous.json"
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "audit_events": [_audit_event().model_dump(mode="json")],
                "usage_records": [_usage_record().model_dump(mode="json")],
                "elastic_events": [AuditOutboxRow.from_audit_event(_audit_event()).payload],
            }
        ),
        encoding="utf-8",
    )
    engine = create_application_engine(_sqlite_url(tmp_path / "simultaneous.sqlite3"))
    upgrade_database(engine)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(
                executor.map(lambda _: import_legacy_state(engine, state_path), range(2))
            )

        assert sum(result.audit_imported for result in results) == 1
        assert sum(result.usage_imported for result in results) == 1
        assert sum(result.outbox_imported for result in results) == 1
        with engine.connect() as connection:
            assert connection.execute(text("select count(*) from audit_events")).scalar_one() == 1
            assert connection.execute(text("select count(*) from usage_records")).scalar_one() == 1
            assert connection.execute(text("select count(*) from audit_outbox")).scalar_one() == 1
    finally:
        engine.dispose()


def test_existing_id_with_different_payload_aborts_the_whole_import(tmp_path: Path) -> None:
    database_url = _sqlite_url(tmp_path / "conflict.sqlite3")
    existing = _audit_event(event_id="audit-existing")
    engine = create_application_engine(database_url)
    upgrade_database(engine)
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        session.add(AuditEventRow.from_model(existing))

    new_event = _audit_event(event_id="audit-new-before-conflict")
    conflicting = existing.model_copy(update={"actor_name": "Different Actor"})
    state_path = tmp_path / "conflict.json"
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "audit_events": [
                    new_event.model_dump(mode="json"),
                    conflicting.model_dump(mode="json"),
                ],
                "usage_records": [],
                "elastic_events": [],
            }
        ),
        encoding="utf-8",
    )
    try:
        with pytest.raises(StateImportError, match="conflicts with the runtime-state payload"):
            import_legacy_state(engine, state_path)
        with session_scope(factory) as session:
            rows = list(session.scalars(select(AuditEventRow).order_by(AuditEventRow.sequence)))
            assert [row.id for row in rows] == [existing.id]
            assert rows[0].actor_name == existing.actor_name
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("message_count", 0),
        ("prompt_tokens", -1),
        ("completion_tokens", -1),
        ("total_tokens", -1),
    ],
)
def test_usage_database_constraints_reject_invalid_counts(
    tmp_path: Path,
    field: str,
    value: int,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / f"invalid-{field}.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    invalid = _usage_record(record_id=f"invalid-{field}").model_copy(update={field: value})
    try:
        with pytest.raises(IntegrityError):
            with session_scope(factory) as session:
                session.add(UsageRecordRow.from_model(invalid))
        with engine.connect() as connection:
            assert connection.execute(text("select count(*) from usage_records")).scalar_one() == 0
    finally:
        engine.dispose()


def test_usage_round_trip_preserves_null_tokens_separately_from_zero(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "null-v-zero.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    null_tokens = _usage_record(record_id="usage-null").model_copy(
        update={"prompt_tokens": None, "completion_tokens": None, "total_tokens": None}
    )
    zero_tokens = _usage_record(record_id="usage-zero").model_copy(
        update={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    )
    try:
        with session_scope(factory) as session:
            session.add_all(
                [UsageRecordRow.from_model(null_tokens), UsageRecordRow.from_model(zero_tokens)]
            )
        with session_scope(factory) as session:
            rows = {
                row.id: row.to_model()
                for row in session.scalars(select(UsageRecordRow).order_by(UsageRecordRow.sequence))
            }
            assert rows["usage-null"].total_tokens is None
            assert rows["usage-zero"].total_tokens == 0
    finally:
        engine.dispose()


@pytest.mark.parametrize("usage_key_present", [False, True])
def test_importer_backfills_usage_only_when_legacy_key_is_absent(
    tmp_path: Path,
    usage_key_present: bool,
) -> None:
    payload: dict[str, object] = {
        "version": 2,
        "audit_events": [],
        "elastic_events": [],
        "chat_threads": [
            {
                "id": "thread-foundation-backfill",
                "tenant_id": "tenant-foundation",
                "owner_user_id": "user-foundation",
                "title": "Historical thread",
                "model_id": "model-foundation",
                "group_id": "group-foundation",
                "updated_at": "Jul 20, 2026",
                "messages": [
                    {
                        "id": "message-foundation-backfill",
                        "role": "assistant",
                        "content": "Historical answer",
                        "createdAt": "9:01 AM",
                        "createdAtIso": "2026-07-20T15:01:00Z",
                    }
                ],
            }
        ],
    }
    if usage_key_present:
        payload["usage_records"] = []
    state_path = tmp_path / f"usage-key-{usage_key_present}.json"
    state_path.write_text(json.dumps(payload), encoding="utf-8")
    engine = create_application_engine(
        _sqlite_url(tmp_path / f"usage-key-{usage_key_present}.sqlite3")
    )
    try:
        result = import_legacy_state(engine, state_path)
        expected_count = 0 if usage_key_present else 1
        assert result.usage_imported == expected_count
        with engine.connect() as connection:
            assert (
                connection.execute(text("select count(*) from usage_records")).scalar_one()
                == expected_count
            )
    finally:
        engine.dispose()


def test_legacy_outbox_same_id_with_changed_payload_is_not_an_idempotent_skip(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "outbox-conflict.json"
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "audit_events": [],
                "usage_records": [],
                "elastic_events": [{"id": "audit-queued", "event": "original"}],
            }
        ),
        encoding="utf-8",
    )
    engine = create_application_engine(_sqlite_url(tmp_path / "outbox-conflict.sqlite3"))
    try:
        import_legacy_state(engine, state_path)
        state_path.write_text(
            json.dumps(
                {
                    "version": 2,
                    "audit_events": [],
                    "usage_records": [],
                    "elastic_events": [{"id": "audit-queued", "event": "changed"}],
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(StateImportError, match="audit outbox item"):
            import_legacy_state(engine, state_path)
        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            row = session.scalar(select(AuditOutboxRow))
            assert row is not None
            assert row.payload == {"id": "audit-queued", "event": "original"}
    finally:
        engine.dispose()


def test_import_rejects_non_integer_v2_and_does_not_echo_invalid_record_input(
    tmp_path: Path,
) -> None:
    state_path = tmp_path / "invalid-state.json"
    state_path.write_text(json.dumps({"version": 2.0}), encoding="utf-8")
    engine = create_application_engine(_sqlite_url(tmp_path / "invalid-state.sqlite3"))
    try:
        with pytest.raises(StateImportError, match="expected 2"):
            import_legacy_state(engine, state_path)
        assert current_schema_revision(engine) is None

        secret_marker = "must-not-appear-in-validation-error"
        state_path.write_text(
            json.dumps(
                {
                    "version": 2,
                    "audit_events": [{"id": "invalid", "actor_name": secret_marker}],
                }
            ),
            encoding="utf-8",
        )
        with pytest.raises(StateImportError) as exc_info:
            import_legacy_state(engine, state_path)
        assert secret_marker not in str(exc_info.value)
    finally:
        engine.dispose()


def test_import_state_module_cli_reports_only_version_and_counts(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    state_path = tmp_path / "cli-state.json"
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "audit_events": [],
                "usage_records": [],
                "elastic_events": [],
            }
        ),
        encoding="utf-8",
    )
    exit_code = import_state_main(
        [
            "--state-path",
            str(state_path),
            "--database-url",
            _sqlite_url(tmp_path / "cli.sqlite3"),
        ]
    )
    assert exit_code == 0
    result = json.loads(capsys.readouterr().out)
    assert result["state_version"] == 2
    assert result["marker_created"] is True
    assert len(result["source_digest"]) == 64
    for key in (
        "audit_imported",
        "audit_skipped",
        "usage_imported",
        "usage_skipped",
        "outbox_imported",
        "outbox_skipped",
        "alert_notification_imported",
        "alert_notification_skipped",
        "alert_runtime_imported",
        "alert_runtime_skipped",
    ):
        assert result[key] == 0


def test_legacy_naive_timestamps_are_assumed_utc_and_remain_idempotent(tmp_path: Path) -> None:
    naive_audit = _audit_event(event_id="audit-naive").model_copy(
        update={"created_at": datetime(2026, 7, 20, 12, 30, 15, 123456)}
    )
    naive_usage = _usage_record(record_id="usage-naive").model_copy(
        update={"created_at": datetime(2026, 7, 20, 12, 31, 16, 654321)}
    )
    state_path = tmp_path / "naive.json"
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "audit_events": [naive_audit.model_dump(mode="json")],
                "usage_records": [naive_usage.model_dump(mode="json")],
                "elastic_events": [],
            }
        ),
        encoding="utf-8",
    )
    engine = create_application_engine(_sqlite_url(tmp_path / "naive.sqlite3"))
    try:
        first = import_legacy_state(engine, state_path)
        second = import_legacy_state(engine, state_path)
        assert first.audit_imported == first.usage_imported == 1
        assert second.audit_skipped == second.usage_skipped == 1
        factory = create_session_factory(engine)
        with session_scope(factory) as session:
            audit = session.scalar(select(AuditEventRow))
            usage = session.scalar(select(UsageRecordRow))
            assert audit is not None and audit.created_at.tzinfo is not None
            assert usage is not None and usage.created_at.tzinfo is not None
    finally:
        engine.dispose()


def test_relative_import_path_resolves_from_repo_root_not_caller_cwd(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_path = tmp_path / "state" / "relative.json"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "audit_events": [],
                "usage_records": [],
                "elastic_events": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr("app.core.config._REPO_ROOT", tmp_path)
    monkeypatch.chdir(tmp_path.parent)
    engine = create_application_engine(_sqlite_url(tmp_path / "relative.sqlite3"))
    try:
        result = import_legacy_state(engine, Path("state/relative.json"))
        assert result.state_version == 2
    finally:
        engine.dispose()


def test_append_sequence_is_not_reused_after_retention_delete(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "sequence-retention.sqlite3"))
    upgrade_database(engine)
    factory = create_session_factory(engine)
    try:
        with session_scope(factory) as session:
            first = AuditEventRow.from_model(_audit_event(event_id="audit-first"))
            session.add(first)
            session.flush()
            first_sequence = first.sequence
        with session_scope(factory) as session:
            stored = session.scalar(select(AuditEventRow).where(AuditEventRow.id == "audit-first"))
            assert stored is not None
            session.delete(stored)
        with session_scope(factory) as session:
            second = AuditEventRow.from_model(_audit_event(event_id="audit-second"))
            session.add(second)
            session.flush()
            assert second.sequence > first_sequence
    finally:
        engine.dispose()
