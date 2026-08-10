from __future__ import annotations

import json
import sqlite3
import stat
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
import sqlalchemy as sa
from alembic.script import ScriptDirectory
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy import MetaData, Table, create_engine, func, inspect, select
from sqlalchemy.exc import SQLAlchemyError, StatementError

from app.db.engine import alembic_config, create_application_engine, upgrade_database
from app.db.transfer_database import (
    DatabaseTransferError,
    _assert_schema_compatible,
    _build_manifest,
    _canonical_check_expression,
    _ordered_primary_key,
    _ordered_table_columns,
    _reflect_tables,
    _sqlite_sequence_watermarks,
    _source_snapshot,
    _target_transfer_lock,
    _type_family,
    analyze_database_transfer,
    create_readonly_sqlite_engine,
    execute_database_transfer,
    main,
    migration_head_revision,
    write_receipt_file,
)


def _sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _migrated_engine(path: Path):
    engine = create_application_engine(_sqlite_url(path))
    upgrade_database(engine)
    return engine


def _insert_audit(
    engine,
    *,
    event_id: str,
    detail: str,
    sequence: int | None = None,
) -> None:
    metadata = MetaData()
    table = Table("audit_events", metadata, autoload_with=engine)
    with engine.begin() as connection:
        values = {
            "id": event_id,
            "tenant_id": "tenant-transfer",
            "actor_id": "user-transfer",
            "actor_name": "Transfer Operator",
            "actor_role": "platform_owner",
            "action": "database.transfer.tested",
            "action_type": "database",
            "target": "application database",
            "target_type": "database",
            "target_name": "Application database",
            "detail": detail,
            "created_at": datetime(2026, 7, 20, 18, 30, tzinfo=UTC),
            "redacted": False,
            "metadata": {"nested": {"verified": True}, "labels": ["sqlite", "postgres"]},
        }
        if sequence is not None:
            values["sequence"] = sequence
        connection.execute(table.insert().values(**values))


def _rewrite_sqlite_table_sql(
    path: Path,
    *,
    table_name: str,
    before: str,
    after: str,
) -> None:
    with sqlite3.connect(path) as connection:
        create_sql = connection.execute(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()[0]
        assert before in create_sql
        schema_version = int(connection.execute("PRAGMA schema_version").fetchone()[0])
        connection.execute("PRAGMA writable_schema=ON")
        connection.execute(
            "UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = ?",
            (create_sql.replace(before, after), table_name),
        )
        connection.execute("PRAGMA writable_schema=OFF")
        connection.execute(f"PRAGMA schema_version={schema_version + 1}")


def test_transfer_discovers_the_single_live_alembic_head() -> None:
    assert (
        migration_head_revision()
        == ScriptDirectory.from_config(alembic_config()).get_current_head()
    )


def test_dry_run_copy_verification_idempotence_and_external_receipt(tmp_path: Path) -> None:
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source_writer = _migrated_engine(source_path)
    target = _migrated_engine(target_path)
    _insert_audit(source_writer, event_id="audit-source", detail="copied exactly")
    source_writer.dispose()
    source = create_readonly_sqlite_engine(source_path)
    try:
        dry_run = analyze_database_transfer(
            source,
            target,
            require_postgresql=False,
        )
        assert dry_run.status == "dry-run"
        assert dry_run.receipt_persisted is False
        assert dry_run.row_count == 1
        assert len(dry_run.source_digest) == 64
        assert "audit_events" in dry_run.table_manifest["tables"]
        assert set(dry_run.table_manifest["sequence_watermarks"]) == {
            "alert_notifications",
            "audit_events",
            "audit_outbox",
            "chat_folders",
            "chat_threads",
            "email_settings",
            "identity_config_active_import",
            "platform_settings",
            "usage_records",
        }
        audit_manifest = dry_run.table_manifest["tables"]["audit_events"]
        sequence_index = audit_manifest["columns"].index("sequence")
        assert audit_manifest["column_types"][sequence_index] == "bigint"
        assert {
            "tenant_usage_budgets",
            "tenant_daily_usage",
            "tenant_usage_permits",
            "tenant_usage_completion_events",
        } <= set(dry_run.table_manifest["tables"])

        imported = execute_database_transfer(
            source,
            target,
            expected_source_digest=dry_run.source_digest,
            require_postgresql=False,
        )
        assert imported.status == "imported"
        assert imported.source_digest == dry_run.source_digest
        assert "database_transfer_receipts" not in inspect(target).get_table_names()

        audit = Table("audit_events", MetaData(), autoload_with=target)
        with target.connect() as connection:
            assert connection.scalar(select(func.count()).select_from(audit)) == 1
            copied = connection.execute(select(audit)).mappings().one()
        assert copied["id"] == "audit-source"
        assert copied["metadata"] == {
            "nested": {"verified": True},
            "labels": ["sqlite", "postgres"],
        }

        repeated = execute_database_transfer(
            source,
            target,
            expected_source_digest=dry_run.source_digest,
            require_postgresql=False,
        )
        assert repeated.status == "already-imported"

        receipt_path = tmp_path / "operator" / "transfer-receipt.json"
        persisted = write_receipt_file(receipt_path, repeated)
        assert persisted.receipt_persisted is True
        assert stat.S_IMODE(receipt_path.stat().st_mode) == 0o600
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        assert receipt["receipt_type"] == "aperture-sqlite-postgres-transfer"
        assert receipt["transfer"]["source_digest"] == dry_run.source_digest
        assert receipt["transfer"]["receipt_persisted"] is True
    finally:
        source.dispose()
        target.dispose()


def test_execute_rejects_source_changed_since_dry_run(tmp_path: Path) -> None:
    source_path = tmp_path / "source.sqlite3"
    target_path = tmp_path / "target.sqlite3"
    source_writer = _migrated_engine(source_path)
    target = _migrated_engine(target_path)
    source_writer.dispose()
    source = create_readonly_sqlite_engine(source_path)
    try:
        dry_run = analyze_database_transfer(source, target, require_postgresql=False)
    finally:
        source.dispose()

    source_writer = create_application_engine(_sqlite_url(source_path))
    _insert_audit(source_writer, event_id="audit-after-dry-run", detail="changed")
    source_writer.dispose()
    source = create_readonly_sqlite_engine(source_path)
    try:
        with pytest.raises(DatabaseTransferError, match="approved dry-run digest"):
            execute_database_transfer(
                source,
                target,
                expected_source_digest=dry_run.source_digest,
                require_postgresql=False,
            )
        audit = Table("audit_events", MetaData(), autoload_with=target)
        with target.connect() as connection:
            assert connection.scalar(select(func.count()).select_from(audit)) == 0
    finally:
        source.dispose()
        target.dispose()


def test_nonempty_nonmatching_target_fails_closed(tmp_path: Path) -> None:
    source = _migrated_engine(tmp_path / "source.sqlite3")
    target = _migrated_engine(tmp_path / "target.sqlite3")
    _insert_audit(source, event_id="audit-source", detail="source")
    _insert_audit(target, event_id="audit-target", detail="different target")
    try:
        with pytest.raises(DatabaseTransferError, match="does not exactly match"):
            analyze_database_transfer(source, target, require_postgresql=False)
    finally:
        source.dispose()
        target.dispose()


def test_current_head_target_schema_drift_is_rejected_on_dry_run(tmp_path: Path) -> None:
    source = _migrated_engine(tmp_path / "source.sqlite3")
    target = _migrated_engine(tmp_path / "target.sqlite3")
    with target.begin() as connection:
        connection.exec_driver_sql("DROP TABLE audit_outbox")
    try:
        with pytest.raises(DatabaseTransferError, match="missing target tables"):
            analyze_database_transfer(source, target, require_postgresql=False)
    finally:
        source.dispose()
        target.dispose()


def test_unversioned_or_unknown_revision_target_fails_preflight(tmp_path: Path) -> None:
    source = _migrated_engine(tmp_path / "source-target-revision.sqlite3")
    unversioned = create_engine(_sqlite_url(tmp_path / "target-unversioned.sqlite3"))
    with unversioned.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE audit_events (sequence INTEGER PRIMARY KEY)")
    unknown = create_engine(_sqlite_url(tmp_path / "target-unknown-revision.sqlite3"))
    with unknown.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE alembic_version (version_num VARCHAR(32))")
        connection.exec_driver_sql(
            "INSERT INTO alembic_version (version_num) VALUES ('unknown_revision')"
        )
    try:
        with pytest.raises(DatabaseTransferError, match="no Alembic revision"):
            analyze_database_transfer(source, unversioned, require_postgresql=False)
        with pytest.raises(DatabaseTransferError, match="not part of the current migration graph"):
            analyze_database_transfer(source, unknown, require_postgresql=False)
    finally:
        source.dispose()
        unversioned.dispose()
        unknown.dispose()


@pytest.mark.parametrize(
    ("drift_kind", "table_name", "before", "after"),
    [
        (
            "check",
            "tenant_usage_budgets",
            "daily_token_limit >= 0",
            "daily_token_limit >= -1",
        ),
        (
            "type",
            "revoked_sessions",
            "reason VARCHAR(255) NOT NULL",
            "reason INTEGER NOT NULL",
        ),
        (
            "integer-width",
            "tenant_usage_budgets",
            "daily_token_limit BIGINT NOT NULL",
            "daily_token_limit INTEGER NOT NULL",
        ),
        (
            "generation",
            "audit_events",
            "sequence INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT",
            "sequence INTEGER NOT NULL PRIMARY KEY",
        ),
    ],
)
def test_current_head_target_check_and_type_drift_fail_closed(
    tmp_path: Path,
    drift_kind: str,
    table_name: str,
    before: str,
    after: str,
) -> None:
    source = _migrated_engine(tmp_path / f"source-{drift_kind}.sqlite3")
    target_path = tmp_path / f"target-{drift_kind}.sqlite3"
    target = _migrated_engine(target_path)
    target.dispose()
    _rewrite_sqlite_table_sql(
        target_path,
        table_name=table_name,
        before=before,
        after=after,
    )
    target = create_application_engine(_sqlite_url(target_path))
    try:
        with pytest.raises(DatabaseTransferError, match="types, defaults, keys"):
            analyze_database_transfer(source, target, require_postgresql=False)
    finally:
        source.dispose()
        target.dispose()


def test_current_head_target_index_drift_fails_closed(tmp_path: Path) -> None:
    source = _migrated_engine(tmp_path / "source-index.sqlite3")
    target = _migrated_engine(tmp_path / "target-index.sqlite3")
    with target.begin() as connection:
        connection.exec_driver_sql("DROP INDEX ix_audit_events_action_created_at")
    try:
        with pytest.raises(DatabaseTransferError, match="types, defaults, keys"):
            analyze_database_transfer(source, target, require_postgresql=False)
    finally:
        source.dispose()
        target.dispose()


def test_cross_dialect_check_normalization_handles_postgres_any_array() -> None:
    sqlite_check = "status IN ('issued', 'started')"
    postgres_check = (
        "status = ANY (ARRAY['issued'::character varying, 'started'::character varying])"
    )
    assert _canonical_check_expression(sqlite_check) == _canonical_check_expression(postgres_check)

    realistic_postgres_check = (
        "((status)::text = ANY ((ARRAY['issued'::character varying, "
        "'started'::character varying])::text[]))"
    )
    assert _canonical_check_expression(sqlite_check) == _canonical_check_expression(
        realistic_postgres_check
    )

    sqlite_not_in = "status NOT IN ('ready', 'complete')"
    postgres_all = (
        "(status::text <> ALL (ARRAY['ready'::character varying, "
        "'complete'::character varying]::text[]))"
    )
    assert _canonical_check_expression(sqlite_not_in) == _canonical_check_expression(postgres_all)


def test_authoritative_column_order_ignores_dialect_reflection_order() -> None:
    metadata = MetaData()
    reflected = Table(
        "alert_notifications",
        metadata,
        # PostgreSQL receives sequence in a later migration and reflects it last.
        sa.Column("id", sa.String(255), primary_key=True),
        sa.Column("sequence", sa.BigInteger()),
    )
    assert [column.name for column in _ordered_table_columns(reflected)] == [
        "sequence",
        "id",
    ]
    assert _ordered_primary_key(reflected) == ("id",)


def test_implicit_integer_key_watermark_does_not_require_sqlite_sequence() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE singleton_settings ("
            "singleton_id INTEGER PRIMARY KEY, payload JSON NOT NULL)"
        )
        connection.exec_driver_sql(
            "INSERT INTO singleton_settings (singleton_id, payload) VALUES (1, '{}')"
        )
        metadata = _reflect_tables(connection, ("singleton_settings",))
        assert _sqlite_sequence_watermarks(connection, metadata) == {"singleton_settings": 1}
    engine.dispose()


def test_postgres_type_families_preserve_timezone_and_json_storage() -> None:
    assert (
        _type_family(sa.DateTime(timezone=True), dialect_name="postgresql") == "datetime:timezone"
    )
    assert _type_family(sa.DateTime(timezone=False), dialect_name="postgresql") == "datetime:naive"
    assert _type_family(sa.JSON(), dialect_name="postgresql") == "json"
    assert _type_family(JSONB(), dialect_name="postgresql") == "jsonb"


def test_check_normalization_handles_postgres_like_and_preserves_boolean_grouping() -> None:
    sqlite_like = "encrypted_secret_ciphertext LIKE 'v3.%'"
    postgres_like = "((encrypted_secret_ciphertext)::text ~~ 'v3.%'::text)"
    assert _canonical_check_expression(sqlite_like) == _canonical_check_expression(postgres_like)

    left_grouped = "a > 0 AND (b > 0 OR c > 0)"
    right_grouped = "(a > 0 AND b > 0) OR c > 0"
    assert _canonical_check_expression(left_grouped) != _canonical_check_expression(right_grouped)

    sqlite_trim = "length(trim(title)) >= 1"
    postgres_trim = "length(TRIM(BOTH FROM title)) >= 1"
    assert _canonical_check_expression(sqlite_trim) == _canonical_check_expression(postgres_trim)
    assert _canonical_check_expression("status != 'failed'") == _canonical_check_expression(
        "status <> 'failed'"
    )

    sqlite_group_chain = (
        "(application_refs_cleared_at IS NULL OR "
        "application_refs_cleared_at >= requested_at) AND "
        "(review_refs_cleared_at IS NULL OR review_refs_cleared_at >= requested_at)"
    )
    postgres_stripped_boundaries = (
        "application_refs_cleared_at IS NULL OR "
        "application_refs_cleared_at >= requested_at) AND "
        "(review_refs_cleared_at IS NULL OR review_refs_cleared_at >= requested_at"
    )
    assert _canonical_check_expression(sqlite_group_chain) == _canonical_check_expression(
        postgres_stripped_boundaries
    )
    assert _canonical_check_expression(
        "attempt_count <= 9223372036854775807"
    ) == _canonical_check_expression("attempt_count <= '9223372036854775807'::bigint")
    assert _canonical_check_expression(
        "total_tokens = prompt_tokens + completion_tokens"
    ) == _canonical_check_expression("total_tokens = (prompt_tokens + completion_tokens)")
    assert _canonical_check_expression("(a + b) * c > 0") != _canonical_check_expression(
        "a + b * c > 0"
    )
    assert _canonical_check_expression("status = 'ready::text'") != _canonical_check_expression(
        "status = 'ready'"
    )
    assert _canonical_check_expression("label = 'a\"b'") != _canonical_check_expression(
        "label = 'ab'"
    )


def test_check_normalization_handles_postgres_string_concatenation() -> None:
    sqlite_check = (
        "(tenant_id IS NULL AND credential_scope = 'platform') OR "
        "(tenant_id IS NOT NULL AND credential_scope = 'tenant:' || tenant_id)"
    )
    postgres_check = (
        "((tenant_id IS NULL) AND ((credential_scope)::text = 'platform'::text)) OR "
        "((tenant_id IS NOT NULL) AND ((credential_scope)::text = "
        "('tenant:'::text || (tenant_id)::text)))"
    )
    assert _canonical_check_expression(sqlite_check) == _canonical_check_expression(postgres_check)


def test_server_default_drift_fails_closed(tmp_path: Path) -> None:
    source = create_engine(_sqlite_url(tmp_path / "source-default.sqlite3"))
    target = create_engine(_sqlite_url(tmp_path / "target-default.sqlite3"))
    with source.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE schema_probe ("
            "id VARCHAR(64) PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT 0)"
        )
    with target.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE schema_probe (id VARCHAR(64) PRIMARY KEY, enabled BOOLEAN NOT NULL)"
        )
    try:
        with source.connect() as source_connection:
            source_metadata = _reflect_tables(source_connection, ("schema_probe",))
            manifest = _build_manifest(
                source_connection,
                source_metadata,
                schema_revision="schema-probe",
            )
        with target.connect() as target_connection:
            target_metadata = _reflect_tables(target_connection, ("schema_probe",))
            with pytest.raises(DatabaseTransferError, match="types, defaults, keys"):
                _assert_schema_compatible(manifest, target_metadata, target_connection)
    finally:
        source.dispose()
        target.dispose()


def test_partial_index_drift_fails_closed(tmp_path: Path) -> None:
    source = create_engine(_sqlite_url(tmp_path / "source-index-options.sqlite3"))
    target = create_engine(_sqlite_url(tmp_path / "target-index-options.sqlite3"))
    for engine in (source, target):
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE TABLE schema_probe ("
                "id VARCHAR(64) PRIMARY KEY, code VARCHAR(64), active BOOLEAN NOT NULL)"
            )
    with source.begin() as connection:
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX ix_schema_probe_code ON schema_probe (code)"
        )
    with target.begin() as connection:
        connection.exec_driver_sql(
            "CREATE UNIQUE INDEX ix_schema_probe_code ON schema_probe (code) WHERE active = 1"
        )
    try:
        with source.connect() as source_connection:
            source_metadata = _reflect_tables(source_connection, ("schema_probe",))
            manifest = _build_manifest(
                source_connection,
                source_metadata,
                schema_revision="schema-probe",
            )
        with target.connect() as target_connection:
            target_metadata = _reflect_tables(target_connection, ("schema_probe",))
            with pytest.raises(DatabaseTransferError, match="types, defaults, keys"):
                _assert_schema_compatible(manifest, target_metadata, target_connection)
    finally:
        source.dispose()
        target.dispose()


def test_row_digest_is_independent_of_database_collation_order(tmp_path: Path) -> None:
    source = create_engine(_sqlite_url(tmp_path / "source-order.sqlite3"))
    target = create_engine(_sqlite_url(tmp_path / "target-order.sqlite3"))
    for engine, identifiers in (
        (source, ("z", "A", "é", "a")),
        (target, ("a", "é", "A", "z")),
    ):
        with engine.begin() as connection:
            connection.exec_driver_sql(
                "CREATE TABLE schema_probe (id TEXT PRIMARY KEY, payload TEXT NOT NULL)"
            )
            for identifier in identifiers:
                connection.exec_driver_sql(
                    "INSERT INTO schema_probe (id, payload) VALUES (?, ?)",
                    (identifier, f"payload-{identifier}"),
                )
    try:
        manifests = []
        for engine in (source, target):
            with engine.connect() as connection:
                metadata = _reflect_tables(connection, ("schema_probe",))
                manifests.append(
                    _build_manifest(
                        connection,
                        metadata,
                        schema_revision="schema-probe",
                    )
                )
        assert manifests[0].source_digest == manifests[1].source_digest
    finally:
        source.dispose()
        target.dispose()


def test_snapshot_detects_a_wal_writer_commit_from_an_independent_connection(
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source-wal.sqlite3"
    writer = _migrated_engine(source_path)
    with writer.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA journal_mode=WAL").scalar_one() == "wal"
        connection.commit()
    writer.dispose()

    source = create_readonly_sqlite_engine(source_path)
    try:
        with pytest.raises(DatabaseTransferError, match="changed while it was being read"):
            with _source_snapshot(source):
                racing_writer = create_application_engine(_sqlite_url(source_path))
                try:
                    _insert_audit(
                        racing_writer,
                        event_id="audit-concurrent",
                        detail="committed during source snapshot",
                    )
                finally:
                    racing_writer.dispose()
    finally:
        source.dispose()


def test_deleted_sqlite_autoincrement_high_water_is_preserved(tmp_path: Path) -> None:
    source_path = tmp_path / "source-sequence.sqlite3"
    target_path = tmp_path / "target-sequence.sqlite3"
    source_writer = _migrated_engine(source_path)
    target = _migrated_engine(target_path)
    _insert_audit(source_writer, event_id="audit-low", detail="survives", sequence=1)
    _insert_audit(source_writer, event_id="audit-high", detail="deleted", sequence=100)
    audit = Table("audit_events", MetaData(), autoload_with=source_writer)
    with source_writer.begin() as connection:
        connection.execute(audit.delete().where(audit.c.id == "audit-high"))
    source_writer.dispose()

    source = create_readonly_sqlite_engine(source_path)
    try:
        dry_run = analyze_database_transfer(source, target, require_postgresql=False)
        assert dry_run.table_manifest["sequence_watermarks"]["audit_events"] == 100
        execute_database_transfer(
            source,
            target,
            expected_source_digest=dry_run.source_digest,
            require_postgresql=False,
        )
        _insert_audit(target, event_id="audit-after-import", detail="next sequence")
        target_audit = Table("audit_events", MetaData(), autoload_with=target)
        with target.connect() as connection:
            sequence = connection.scalar(
                select(target_audit.c.sequence).where(target_audit.c.id == "audit-after-import")
            )
        assert sequence == 101
    finally:
        source.dispose()
        target.dispose()


def test_all_rows_deleted_sequence_import_is_idempotent(tmp_path: Path) -> None:
    source_path = tmp_path / "source-empty-sequence.sqlite3"
    target_path = tmp_path / "target-empty-sequence.sqlite3"
    source_writer = _migrated_engine(source_path)
    target = _migrated_engine(target_path)
    _insert_audit(source_writer, event_id="audit-deleted", detail="deleted", sequence=100)
    audit = Table("audit_events", MetaData(), autoload_with=source_writer)
    with source_writer.begin() as connection:
        connection.execute(audit.delete())
    source_writer.dispose()

    source = create_readonly_sqlite_engine(source_path)
    try:
        dry_run = analyze_database_transfer(source, target, require_postgresql=False)
        assert dry_run.status == "dry-run"
        imported = execute_database_transfer(
            source,
            target,
            expected_source_digest=dry_run.source_digest,
            require_postgresql=False,
        )
        assert imported.status == "imported"
        repeated = execute_database_transfer(
            source,
            target,
            expected_source_digest=dry_run.source_digest,
            require_postgresql=False,
        )
        assert repeated.status == "already-imported"
        with target.connect() as connection:
            watermark = connection.exec_driver_sql(
                "SELECT seq FROM sqlite_sequence WHERE name = 'audit_events'"
            ).scalar_one()
        assert watermark == 100
    finally:
        source.dispose()
        target.dispose()


def test_pristine_zero_sequences_allow_nonsequence_rows_to_import(tmp_path: Path) -> None:
    source_path = tmp_path / "source-nonsequence.sqlite3"
    target_path = tmp_path / "target-nonsequence.sqlite3"
    source_writer = _migrated_engine(source_path)
    target = _migrated_engine(target_path)
    revoked = Table("revoked_sessions", MetaData(), autoload_with=source_writer)
    with source_writer.begin() as connection:
        connection.execute(
            revoked.insert().values(
                sid="session-transfer",
                user_id="user-transfer",
                tenant_id="tenant-transfer",
                issued_at=1,
                expires_at=2,
                revoked_at=datetime(2026, 7, 20, 18, 30, tzinfo=UTC),
                reason="transfer regression",
            )
        )
    source_writer.dispose()

    source = create_readonly_sqlite_engine(source_path)
    try:
        dry_run = analyze_database_transfer(source, target, require_postgresql=False)
        assert dry_run.status == "dry-run"
        assert not any(dry_run.table_manifest["sequence_watermarks"].values())
        imported = execute_database_transfer(
            source,
            target,
            expected_source_digest=dry_run.source_digest,
            require_postgresql=False,
        )
        assert imported.status == "imported"
    finally:
        source.dispose()
        target.dispose()


class _FakePostgresLockConnection:
    def __init__(self, events: list[str], *, fail_first_commit: bool = False) -> None:
        self.events = events
        self._in_transaction = False
        self.fail_first_commit = fail_first_commit
        self.commit_count = 0

    def __enter__(self):
        self.events.append("connect")
        return self

    def __exit__(self, *_args) -> None:
        self.events.append("close")

    def execute(self, statement, _parameters) -> None:
        rendered = str(statement)
        self.events.append("unlock" if "unlock" in rendered else "lock")
        self._in_transaction = True

    def commit(self) -> None:
        self.events.append("commit")
        self.commit_count += 1
        if self.fail_first_commit and self.commit_count == 1:
            raise SQLAlchemyError("forced commit failure")
        self._in_transaction = False

    def rollback(self) -> None:
        self.events.append("rollback")
        self._in_transaction = False

    def in_transaction(self) -> bool:
        return self._in_transaction

    def invalidate(self) -> None:
        self.events.append("invalidate")


class _FakePostgresLockEngine:
    def __init__(self, events: list[str], *, fail_first_commit: bool = False) -> None:
        self.events = events
        self.fail_first_commit = fail_first_commit
        self.dialect = SimpleNamespace(name="postgresql")

    def connect(self) -> _FakePostgresLockConnection:
        return _FakePostgresLockConnection(
            self.events,
            fail_first_commit=self.fail_first_commit,
        )


def test_postgres_session_lock_releases_after_failure() -> None:
    events: list[str] = []
    target = _FakePostgresLockEngine(events)
    with pytest.raises(RuntimeError, match="forced"):
        with _target_transfer_lock(target):  # type: ignore[arg-type]
            events.append("transfer")
            raise RuntimeError("forced")
    assert events == [
        "connect",
        "lock",
        "commit",
        "transfer",
        "unlock",
        "commit",
        "close",
    ]


def test_postgres_session_lock_invalidates_if_acquisition_commit_fails() -> None:
    events: list[str] = []
    target = _FakePostgresLockEngine(events, fail_first_commit=True)
    with pytest.raises(SQLAlchemyError, match="forced commit failure"):
        with _target_transfer_lock(target):  # type: ignore[arg-type]
            pytest.fail("transfer body must not run")
    assert events == ["connect", "lock", "commit", "invalidate", "close"]


def test_execute_holds_postgres_session_lock_around_the_full_transfer(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_path = tmp_path / "source-lock.sqlite3"
    source_writer = _migrated_engine(source_path)
    source_writer.dispose()
    source = create_readonly_sqlite_engine(source_path)
    digest_target = _migrated_engine(tmp_path / "digest-target.sqlite3")
    try:
        dry_run = analyze_database_transfer(
            source,
            digest_target,
            require_postgresql=False,
        )
    finally:
        digest_target.dispose()

    events: list[str] = []
    target = _FakePostgresLockEngine(events)

    def _fake_locked_transfer(*_args, expected_head: str, **_kwargs):
        assert "lock" in events
        assert "unlock" not in events
        events.append("preflight-migration-copy")
        return "imported", expected_head

    monkeypatch.setattr(
        "app.db.transfer_database._execute_locked_transfer",
        _fake_locked_transfer,
    )
    try:
        report = execute_database_transfer(
            source,
            target,  # type: ignore[arg-type]
            expected_source_digest=dry_run.source_digest,
        )
        assert report.status == "imported"
    finally:
        source.dispose()
    assert events.index("lock") < events.index("preflight-migration-copy")
    assert events.index("preflight-migration-copy") < events.index("unlock")


def test_receipt_rejects_mode_reuse_but_accepts_completed_status_equivalence(
    tmp_path: Path,
) -> None:
    source = _migrated_engine(tmp_path / "source-receipt.sqlite3")
    target = _migrated_engine(tmp_path / "target-receipt.sqlite3")
    try:
        report = analyze_database_transfer(source, target, require_postgresql=False)
        dry_run_path = tmp_path / "dry-run.json"
        write_receipt_file(dry_run_path, report)
        with pytest.raises(DatabaseTransferError, match="different transfer mode"):
            write_receipt_file(
                dry_run_path,
                replace(report, mode="execute", status="imported"),
            )

        completed_path = tmp_path / "completed.json"
        imported = replace(report, mode="execute", status="imported")
        write_receipt_file(completed_path, imported)
        persisted = write_receipt_file(
            completed_path,
            replace(report, mode="execute", status="already-imported"),
        )
        assert persisted.receipt_persisted is True
    finally:
        source.dispose()
        target.dispose()


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("receipt_type", "unrelated-receipt", "receipt type"),
        ("receipt_version", 2, "receipt version"),
        ("receipt_version", True, "receipt version"),
    ],
)
def test_receipt_rejects_wrong_type_or_version(
    tmp_path: Path,
    field: str,
    value: object,
    message: str,
) -> None:
    source = _migrated_engine(tmp_path / f"source-{field}-{value}.sqlite3")
    target = _migrated_engine(tmp_path / f"target-{field}-{value}.sqlite3")
    try:
        report = analyze_database_transfer(source, target, require_postgresql=False)
        receipt_path = tmp_path / f"receipt-{field}-{value}.json"
        write_receipt_file(receipt_path, report)
        payload = json.loads(receipt_path.read_text(encoding="utf-8"))
        payload[field] = value
        receipt_path.write_text(json.dumps(payload), encoding="utf-8")
        with pytest.raises(DatabaseTransferError, match=message):
            write_receipt_file(receipt_path, report)
    finally:
        source.dispose()
        target.dispose()


def test_receipt_rejects_symlink_and_nonregular_destination(tmp_path: Path) -> None:
    source = _migrated_engine(tmp_path / "source-receipt-path.sqlite3")
    target = _migrated_engine(tmp_path / "target-receipt-path.sqlite3")
    try:
        report = analyze_database_transfer(source, target, require_postgresql=False)
        victim = tmp_path / "victim.json"
        victim.write_text("do not follow", encoding="utf-8")
        symlink = tmp_path / "receipt-link.json"
        symlink.symlink_to(victim)
        with pytest.raises(DatabaseTransferError, match="regular file"):
            write_receipt_file(symlink, report)

        directory = tmp_path / "receipt-directory"
        directory.mkdir()
        with pytest.raises(DatabaseTransferError, match="regular file"):
            write_receipt_file(directory, report)
        assert victim.read_text(encoding="utf-8") == "do not follow"
    finally:
        source.dispose()
        target.dispose()


def test_readonly_source_rejects_symlink_and_nonregular_paths(tmp_path: Path) -> None:
    source_path = tmp_path / "source-real.sqlite3"
    source_writer = _migrated_engine(source_path)
    source_writer.dispose()
    symlink_path = tmp_path / "source-link.sqlite3"
    symlink_path.symlink_to(source_path)
    with pytest.raises(DatabaseTransferError, match="regular file, never a symlink"):
        create_readonly_sqlite_engine(symlink_path)
    directory_path = tmp_path / "source-directory"
    directory_path.mkdir()
    with pytest.raises(DatabaseTransferError, match="regular file, never a symlink"):
        create_readonly_sqlite_engine(directory_path)


def test_readonly_source_opens_frozen_wal_database_without_directory_writes(
    tmp_path: Path,
) -> None:
    staging_path = tmp_path / "staging.sqlite3"
    source_writer = _migrated_engine(staging_path)
    source_writer.dispose()
    frozen_directory = tmp_path / "restored-volume"
    frozen_directory.mkdir()
    source_path = frozen_directory / "aperture.sqlite3"
    staging_path.replace(source_path)
    source_path.chmod(0o444)
    frozen_directory.chmod(0o555)

    source = None
    try:
        source = create_readonly_sqlite_engine(source_path)
        with source.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA query_only").scalar_one() == 1
            assert connection.exec_driver_sql(
                "SELECT version_num FROM alembic_version"
            ).scalar_one() == migration_head_revision()
    finally:
        if source is not None:
            source.dispose()
        frozen_directory.chmod(0o755)
        source_path.chmod(0o644)


def test_production_wrapper_rejects_a_non_postgres_target(tmp_path: Path) -> None:
    source = _migrated_engine(tmp_path / "source.sqlite3")
    target = _migrated_engine(tmp_path / "target.sqlite3")
    try:
        with pytest.raises(DatabaseTransferError, match="must use PostgreSQL"):
            analyze_database_transfer(source, target)
    finally:
        source.dispose()
        target.dispose()


def test_execute_requires_an_external_receipt_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APERTURE_DATABASE_URL", "postgresql+psycopg://database.invalid/aperture")
    with pytest.raises(SystemExit, match="--receipt-output"):
        main(
            [
                "--source-sqlite",
                "unused.sqlite3",
                "--execute",
                "--expected-source-digest",
                "0" * 64,
            ]
        )


def test_cli_never_renders_sqlalchemy_statement_parameters(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    secret_value = "provider-secret-that-must-not-appear"
    disposable_source = create_engine("sqlite+pysqlite:///:memory:")
    disposable_target = create_engine("sqlite+pysqlite:///:memory:")

    monkeypatch.setattr(
        "app.db.transfer_database.create_readonly_sqlite_engine",
        lambda _path: disposable_source,
    )
    monkeypatch.setattr(
        "app.db.transfer_database.create_application_engine",
        lambda _url: disposable_target,
    )

    def _raise_statement_error(*_args, **_kwargs):
        raise StatementError(
            "forced insert failure",
            "INSERT INTO provider_keys (ciphertext) VALUES (:ciphertext)",
            {"ciphertext": secret_value},
            ValueError("forced"),
        )

    monkeypatch.setattr(
        "app.db.transfer_database.analyze_database_transfer",
        _raise_statement_error,
    )
    with pytest.raises(SystemExit) as captured:
        main(
            [
                "--source-sqlite",
                str(tmp_path / "unused.sqlite3"),
                "--database-url",
                "postgresql+psycopg://database.invalid/aperture",
            ]
        )
    message = str(captured.value)
    assert "StatementError" in message
    assert secret_value not in message
    assert "INSERT INTO" not in message
    assert "ciphertext" not in message
