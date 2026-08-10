"""Bounded SQL retention behavior for audit and usage history."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from threading import Barrier, Event

import pytest
from sqlalchemy import event as sqlalchemy_event
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.db import create_application_engine, upgrade_database
from app.db.orm import AuditOutboxRow
from app.models.schemas import AuditEvent, UsageRecord
from app.repositories.application_state import ApplicationStateRepository


CUTOFF = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)


def _repository(path: Path) -> ApplicationStateRepository:
    engine = create_application_engine(f"sqlite+pysqlite:///{path.as_posix()}")
    upgrade_database(engine)
    return ApplicationStateRepository(engine)


def _event(event_id: str, created_at: datetime) -> AuditEvent:
    return AuditEvent(
        id=event_id,
        tenant_id="tenant-retention",
        actor_id="user-retention",
        actor_name="Retention User",
        actor_role="ADMIN",
        action="retention.test",
        target=event_id,
        created_at=created_at,
    )


def _usage(record_id: str, created_at: datetime) -> UsageRecord:
    return UsageRecord(
        id=record_id,
        tenant_id="tenant-retention",
        user_id="user-retention",
        user_name="Retention User",
        user_role="ADMIN",
        model_id="model-retention",
        created_at=created_at,
    )


def _outbox_rows(repository: ApplicationStateRepository) -> list[tuple[str, str | None, bool]]:
    def operation(session: Session) -> list[tuple[str, str | None, bool]]:
        rows = session.execute(
            select(
                AuditOutboxRow.dedupe_key,
                AuditOutboxRow.event_id,
                AuditOutboxRow.delivered_at,
            ).order_by(AuditOutboxRow.sequence)
        )
        return [
            (dedupe_key, event_id, delivered_at is not None)
            for dedupe_key, event_id, delivered_at in rows
        ]

    return repository.run_transaction(operation)


def _install_wal_race(
    engine: Engine,
    table_name: str,
    rendezvous: Barrier,
    append_finished: Event,
) -> tuple[list[str], object, object]:
    """Pause after a legacy read or before the new one-statement delete."""

    observed: list[str] = []
    injected = Event()
    table_token = table_name.upper()

    def inject_race() -> None:
        if injected.is_set():
            return
        injected.set()
        rendezvous.wait(timeout=5)
        if not append_finished.wait(timeout=5):
            raise RuntimeError("concurrent retention append did not finish")

    def before_cursor_execute(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        normalized = " ".join(statement.upper().split())
        if table_token not in normalized:
            return
        observed.append(normalized)
        if normalized.startswith(f"DELETE FROM {table_token}"):
            inject_race()

    def after_cursor_execute(
        _connection: object,
        _cursor: object,
        statement: str,
        _parameters: object,
        _context: object,
        _executemany: bool,
    ) -> None:
        normalized = " ".join(statement.upper().split())
        if table_token in normalized and normalized.startswith("SELECT"):
            # The pre-fix implementation first established a WAL read
            # snapshot here, then failed to upgrade it after the append.
            inject_race()

    sqlalchemy_event.listen(engine, "before_cursor_execute", before_cursor_execute)
    sqlalchemy_event.listen(engine, "after_cursor_execute", after_cursor_execute)
    return observed, before_cursor_execute, after_cursor_execute


def _remove_wal_race(engine: Engine, before_listener: object, after_listener: object) -> None:
    sqlalchemy_event.remove(engine, "before_cursor_execute", before_listener)
    sqlalchemy_event.remove(engine, "after_cursor_execute", after_listener)


def test_audit_purge_protects_pending_and_only_removes_matching_delivered_outbox(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "audit-retention.sqlite3")
    try:
        delivered = _event("audit-delivered", CUTOFF - timedelta(hours=3))
        pending = _event("audit-pending", CUTOFF - timedelta(hours=2))
        no_outbox = _event("audit-no-outbox", CUTOFF - timedelta(hours=1))
        boundary = _event("audit-boundary", CUTOFF)
        recent = _event("audit-recent", CUTOFF + timedelta(seconds=1))

        for event in (delivered, pending, boundary, recent):
            repository.append_audit_with_outbox(event)
        repository.append_audit(no_outbox)

        pending_rows = {row.event_id: row.sequence for row in repository.pending_outbox()}
        repository.mark_outbox_delivered(
            [
                pending_rows[delivered.id],
                pending_rows[boundary.id],
                pending_rows[recent.id],
            ],
            delivered_at=CUTOFF + timedelta(minutes=1),
        )

        def add_compatibility_rows(session: Session) -> None:
            # A delivered duplicate must remain while another matching item is
            # pending. A legacy row whose payload happens to contain the same
            # id has no explicit event relation and must remain unrelated.
            session.add_all(
                [
                    AuditOutboxRow(
                        dedupe_key="duplicate-delivered-pending",
                        event_id=pending.id,
                        tenant_id=pending.tenant_id,
                        payload={"id": pending.id, "event": pending.action},
                        delivered_at=CUTOFF + timedelta(minutes=2),
                    ),
                    AuditOutboxRow(
                        dedupe_key="legacy-payload-id-only",
                        event_id=None,
                        tenant_id=delivered.tenant_id,
                        payload={"id": delivered.id, "event": delivered.action},
                        delivered_at=CUTOFF + timedelta(minutes=2),
                    ),
                ]
            )

        repository.run_transaction(add_compatibility_rows)

        assert repository.purge_audit_before(CUTOFF) == 2
        assert [event.id for event in repository.list_audit(newest_first=False)] == [
            pending.id,
            boundary.id,
            recent.id,
        ]
        assert _outbox_rows(repository) == [
            (f"audit:{pending.id}", pending.id, False),
            (f"audit:{boundary.id}", boundary.id, True),
            (f"audit:{recent.id}", recent.id, True),
            ("duplicate-delivered-pending", pending.id, True),
            ("legacy-payload-id-only", None, True),
        ]
    finally:
        repository.close()


def test_purge_batches_are_hard_capped_and_use_created_at_then_sequence(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "bounded-retention.sqlite3")
    timestamp = CUTOFF - timedelta(days=1)
    try:
        repository.extend_audit(_event(f"audit-{index:03d}", timestamp) for index in range(501))
        repository.extend_usage(_usage(f"usage-{index:03d}", timestamp) for index in range(501))

        assert repository.purge_audit_before(CUTOFF) == 500
        assert repository.purge_usage_before(CUTOFF) == 500
        assert [event.id for event in repository.list_audit(newest_first=False)] == ["audit-500"]
        assert [record.id for record in repository.list_usage(newest_first=False)] == ["usage-500"]

        assert repository.purge_audit_before(CUTOFF) == 1
        assert repository.purge_usage_before(CUTOFF) == 1
        assert repository.purge_audit_before(CUTOFF) == 0
        assert repository.purge_usage_before(CUTOFF) == 0
    finally:
        repository.close()


def test_usage_purge_is_strictly_before_cutoff_and_accepts_aware_offset(
    tmp_path: Path,
) -> None:
    repository = _repository(tmp_path / "usage-cutoff.sqlite3")
    try:
        repository.extend_usage(
            [
                _usage("usage-old-first", CUTOFF - timedelta(hours=2)),
                _usage("usage-old-second", CUTOFF - timedelta(hours=1)),
                _usage("usage-boundary", CUTOFF),
                _usage("usage-recent", CUTOFF + timedelta(seconds=1)),
            ]
        )
        mountain_cutoff = CUTOFF.astimezone(timezone(timedelta(hours=-6)))

        assert repository.purge_usage_before(mountain_cutoff, limit=1) == 1
        assert [record.id for record in repository.list_usage(newest_first=False)] == [
            "usage-old-second",
            "usage-boundary",
            "usage-recent",
        ]
        assert repository.purge_usage_before(mountain_cutoff) == 1
        assert [record.id for record in repository.list_usage(newest_first=False)] == [
            "usage-boundary",
            "usage-recent",
        ]
    finally:
        repository.close()


@pytest.mark.parametrize("limit", [0, -1, 501, True, 1.5])
def test_retention_rejects_unbounded_or_invalid_limits(tmp_path: Path, limit: object) -> None:
    repository = _repository(tmp_path / f"invalid-limit-{limit!s}.sqlite3")
    try:
        with pytest.raises(ValueError, match="integer from 1 to 500"):
            repository.purge_audit_before(CUTOFF, limit=limit)  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="integer from 1 to 500"):
            repository.purge_usage_before(CUTOFF, limit=limit)  # type: ignore[arg-type]
    finally:
        repository.close()


def test_retention_rejects_naive_cutoffs(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "naive-cutoff.sqlite3")
    try:
        with pytest.raises(ValueError, match="timezone-aware"):
            repository.purge_audit_before(CUTOFF.replace(tzinfo=None))
        with pytest.raises(ValueError, match="timezone-aware"):
            repository.purge_usage_before(CUTOFF.replace(tzinfo=None))
    finally:
        repository.close()


def test_audit_and_outbox_deletes_rollback_together(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "atomic-retention.sqlite3")
    event = _event("audit-atomic", CUTOFF - timedelta(days=1))
    try:
        repository.append_audit_with_outbox(event)
        sequence = repository.pending_outbox()[0].sequence
        repository.mark_outbox_delivered([sequence], delivered_at=CUTOFF)
        with repository.engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TRIGGER reject_audit_retention "
                    "BEFORE DELETE ON audit_events "
                    "BEGIN SELECT RAISE(ABORT, 'retention rejected'); END"
                )
            )

        with pytest.raises(DBAPIError, match="retention rejected"):
            repository.purge_audit_before(CUTOFF)

        assert repository.count_audit() == 1
        assert repository.count_outbox(pending_only=False) == 1
        assert repository.count_pending_outbox() == 0
        with repository.engine.begin() as connection:
            connection.execute(text("DROP TRIGGER reject_audit_retention"))

        assert repository.purge_audit_before(CUTOFF) == 1
        assert repository.count_audit() == 0
        assert _outbox_rows(repository) == []
    finally:
        repository.close()


def test_file_backed_wal_audit_purge_survives_cross_engine_append(tmp_path: Path) -> None:
    database_path = tmp_path / "audit-wal-race.sqlite3"
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    purge_engine = create_application_engine(database_url)
    append_engine = create_application_engine(database_url)
    upgrade_database(purge_engine)
    purge_repository = ApplicationStateRepository(purge_engine)
    append_repository = ApplicationStateRepository(append_engine)
    rendezvous = Barrier(2)
    append_finished = Event()

    old_event = _event("audit-old-wal", CUTOFF - timedelta(days=1))
    recent_event = _event("audit-recent-wal", CUTOFF + timedelta(seconds=1))
    purge_repository.append_audit_with_outbox(old_event)
    old_sequence = purge_repository.pending_outbox()[0].sequence
    purge_repository.mark_outbox_delivered([old_sequence], delivered_at=CUTOFF)
    observed, before_listener, after_listener = _install_wal_race(
        purge_engine,
        "audit_events",
        rendezvous,
        append_finished,
    )

    def append_recent() -> None:
        try:
            rendezvous.wait(timeout=5)
            append_repository.append_audit_with_outbox(recent_event)
        finally:
            append_finished.set()

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            append_future = executor.submit(append_recent)
            assert purge_repository.purge_audit_before(CUTOFF) == 1
            append_future.result()
        _remove_wal_race(purge_engine, before_listener, after_listener)

        assert observed[0].startswith("DELETE FROM AUDIT_EVENTS")
        assert "SELECT" in observed[0]
        assert "ORDER BY" in observed[0]
        assert "LIMIT" in observed[0]
        assert observed[0].count("AUDIT_OUTBOX.DELIVERED_AT IS NULL") == 2
        assert "RETURNING ID" in observed[0]
        assert [event.id for event in purge_repository.list_audit(newest_first=False)] == [
            recent_event.id
        ]
        assert _outbox_rows(purge_repository) == [
            (f"audit:{recent_event.id}", recent_event.id, False)
        ]
    finally:
        if sqlalchemy_event.contains(purge_engine, "before_cursor_execute", before_listener):
            _remove_wal_race(purge_engine, before_listener, after_listener)
        purge_repository.close()
        append_repository.close()


def test_file_backed_wal_usage_purge_survives_cross_engine_append(tmp_path: Path) -> None:
    database_path = tmp_path / "usage-wal-race.sqlite3"
    database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
    purge_engine = create_application_engine(database_url)
    append_engine = create_application_engine(database_url)
    upgrade_database(purge_engine)
    purge_repository = ApplicationStateRepository(purge_engine)
    append_repository = ApplicationStateRepository(append_engine)
    rendezvous = Barrier(2)
    append_finished = Event()

    old_usage = _usage("usage-old-wal", CUTOFF - timedelta(days=1))
    recent_usage = _usage("usage-recent-wal", CUTOFF + timedelta(seconds=1))
    purge_repository.append_usage_unbounded(old_usage)
    observed, before_listener, after_listener = _install_wal_race(
        purge_engine,
        "usage_records",
        rendezvous,
        append_finished,
    )

    def append_recent() -> None:
        try:
            rendezvous.wait(timeout=5)
            append_repository.append_usage_unbounded(recent_usage)
        finally:
            append_finished.set()

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            append_future = executor.submit(append_recent)
            assert purge_repository.purge_usage_before(CUTOFF) == 1
            append_future.result()
        _remove_wal_race(purge_engine, before_listener, after_listener)

        assert observed[0].startswith("DELETE FROM USAGE_RECORDS")
        assert "SELECT" in observed[0]
        assert "ORDER BY" in observed[0]
        assert "LIMIT" in observed[0]
        assert "RETURNING SEQUENCE" in observed[0]
        assert [record.id for record in purge_repository.list_usage(newest_first=False)] == [
            recent_usage.id
        ]
    finally:
        if sqlalchemy_event.contains(purge_engine, "before_cursor_execute", before_listener):
            _remove_wal_race(purge_engine, before_listener, after_listener)
        purge_repository.close()
        append_repository.close()


def test_concurrent_append_is_safe_and_audit_usage_purges_are_independent() -> None:
    engine = create_application_engine("sqlite+pysqlite:///:memory:")
    upgrade_database(engine)
    first = ApplicationStateRepository(engine)
    second = ApplicationStateRepository(engine)
    barrier = Barrier(3)

    old_event = _event("audit-old", CUTOFF - timedelta(days=1))
    first.append_audit_with_outbox(old_event)
    first.mark_outbox_delivered([first.pending_outbox()[0].sequence], delivered_at=CUTOFF)
    first.append_usage_unbounded(_usage("usage-old", CUTOFF - timedelta(days=1)))

    def append_recent() -> None:
        barrier.wait()
        first.append_audit_with_outbox(_event("audit-recent", CUTOFF + timedelta(seconds=1)))
        first.append_usage_unbounded(_usage("usage-recent", CUTOFF + timedelta(seconds=1)))

    def purge_audit() -> int:
        barrier.wait()
        return second.purge_audit_before(CUTOFF)

    def purge_usage() -> int:
        barrier.wait()
        return second.purge_usage_before(CUTOFF)

    try:
        with ThreadPoolExecutor(max_workers=3) as executor:
            append_future = executor.submit(append_recent)
            audit_future = executor.submit(purge_audit)
            usage_future = executor.submit(purge_usage)
            append_future.result()
            assert audit_future.result() == 1
            assert usage_future.result() == 1

        assert [event.id for event in first.list_audit(newest_first=False)] == ["audit-recent"]
        assert [record.id for record in first.list_usage(newest_first=False)] == ["usage-recent"]
        assert first.count_pending_outbox() == 1
    finally:
        first.close()
        second.close()
