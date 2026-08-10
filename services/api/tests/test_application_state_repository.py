from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier

import pytest
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.orm import Session

import app.repositories.application_state as application_state_module
from app.db.engine import (
    APPLICATION_STATE_IMPORT_REVISION,
    create_application_engine,
    upgrade_database,
)
from app.db.orm import AuditEventRow, RuntimeStateImportRow
from app.models.schemas import AlertNotification, AuditEvent, UsageRecord
from app.repositories.application_state import ApplicationStateRepository


NOW = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)


def _event(event_id: str, *, actor_role: str = "USER") -> AuditEvent:
    return AuditEvent(
        id=event_id,
        tenant_id="tenant-one",
        actor_id="user-one",
        actor_name="User One",
        actor_role=actor_role,
        action="auth.login",
        target="user-one",
        created_at=NOW,
        metadata={"safe": True},
    )


def _usage(record_id: str) -> UsageRecord:
    return UsageRecord(
        id=record_id,
        tenant_id="tenant-one",
        user_id="user-one",
        user_name="User One",
        user_role="USER",
        model_id="model-one",
        created_at=NOW,
    )


def _notification(notification_id: str, *, rule_id: str = "rule-one") -> AlertNotification:
    return AlertNotification(
        id=notification_id,
        rule_id=rule_id,
        rule_name="Rule one",
        tenant_id="tenant-one",
        event_id="audit-one",
        event_action="auth.login",
        recipients=["alerts@example.com"],
        status="queued",
        created_at=NOW,
    )


def _repository_pair() -> tuple[ApplicationStateRepository, ApplicationStateRepository]:
    engine = create_application_engine("sqlite+pysqlite:///:memory:")
    upgrade_database(engine)
    return ApplicationStateRepository(engine), ApplicationStateRepository(engine)


def test_nested_transaction_is_rejected_and_outer_work_rolls_back() -> None:
    first, second = _repository_pair()

    def outer_operation(session: Session) -> None:
        session.add(AuditEventRow.from_model(_event("audit-outer")))
        session.flush()
        second.append_audit(_event("audit-inner"))

    try:
        with pytest.raises(RuntimeError, match="Nested application-state"):
            first.run_transaction(outer_operation)

        assert first.count_audit() == 0
    finally:
        first.close()
        second.close()


def test_two_repositories_share_static_pool_lock_and_engine_lifetime() -> None:
    first, second = _repository_pair()

    def append(index: int) -> None:
        repository = first if index % 2 else second
        repository.append_audit(_event(f"audit-thread-{index}"))

    try:
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(append, range(100)))

        assert first.count_audit() == 100
        first.close()

        # Closing one owner must not dispose the engine out from under another.
        second.append_audit(_event("audit-after-first-close"))
        assert second.count_audit() == 101
    finally:
        first.close()
        second.close()


def test_marker_verification_accepts_canonical_v3_and_reads_live_revision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = create_application_engine("sqlite+pysqlite:///:memory:")
    upgrade_database(engine)
    repository = ApplicationStateRepository(engine)
    marker = RuntimeStateImportRow(
        source_digest="a" * 64,
        source_version=2,
        target_version=3,
        completed_at=NOW,
        audit_count=4,
        usage_count=3,
        outbox_count=2,
        alert_notification_count=1,
        alert_runtime_count=1,
    )
    canonical = {
        "source_digest": marker.source_digest,
        "source_version": marker.source_version,
        "target_version": marker.target_version,
        "schema_revision": APPLICATION_STATE_IMPORT_REVISION,
        "audit_count": marker.audit_count,
        "usage_count": marker.usage_count,
        "outbox_count": marker.outbox_count,
        "alert_notification_count": marker.alert_notification_count,
        "alert_runtime_count": marker.alert_runtime_count,
    }

    try:
        repository.insert_import_marker(marker)

        assert repository.verify_import_marker(marker)
        assert repository.verify_import_marker(canonical)
        assert repository.verify_import_marker(
            {"version": 3, "application_state_import": canonical}
        )
        assert not repository.verify_import_marker({**canonical, "usage_count": 999})

        with engine.begin() as connection:
            connection.execute(text("update alembic_version set version_num = 'not-the-live-head'"))
        assert not repository.verify_import_marker(marker)
        assert not repository.verify_import_marker(canonical)

        future_head = "20260720_0004"
        monkeypatch.setattr(application_state_module, "HEAD_REVISION", future_head)
        with engine.begin() as connection:
            connection.execute(
                text("update alembic_version set version_num = :revision"),
                {"revision": future_head},
            )
        assert repository.verify_import_marker(marker)
        assert repository.verify_import_marker(canonical)
    finally:
        repository.close()


def test_compatibility_views_compare_by_value_and_reject_silent_model_mutation() -> None:
    engine = create_application_engine("sqlite+pysqlite:///:memory:")
    upgrade_database(engine)
    repository = ApplicationStateRepository(engine)
    event = _event("audit-one")
    usage = _usage("usage-one")
    notification = _notification("notification-one")

    try:
        assert repository.audit_events == []
        assert repository.usage_records == []
        assert repository.elastic_events == []
        assert repository.alert_notifications == {}

        repository.audit_events.append(event)
        repository.usage_records.append(usage)
        repository.elastic_events.append({"id": "elastic-one", "event": "auth.login"})
        repository.alert_notifications[notification.id] = notification

        assert repository.audit_events == [event]
        assert repository.usage_records == [usage]
        assert repository.elastic_events == [{"id": "elastic-one", "event": "auth.login"}]
        assert repository.alert_notifications == {notification.id: notification}

        detached_usage = repository.usage_records[0]
        with pytest.raises(ValidationError, match="frozen"):
            detached_usage.created_at = NOW + timedelta(days=1)
        replacement = detached_usage.model_copy(update={"created_at": NOW + timedelta(days=1)})
        repository.usage_records[0] = replacement
        assert repository.usage_records[0].created_at == NOW + timedelta(days=1)

        detached_notification = repository.alert_notifications[notification.id]
        with pytest.raises(ValidationError, match="frozen"):
            detached_notification.status = "sent"
        repository.alert_notifications[notification.id] = detached_notification.model_copy(
            update={"status": "sent", "delivered_at": NOW}
        )
        assert repository.alert_notifications[notification.id].status == "sent"

        with pytest.raises(IndexError, match="append-only"):
            repository.audit_events.insert(-1, _event("audit-invalid-insert"))
        with pytest.raises(IndexError, match="append-only"):
            repository.usage_records.insert(-1, _usage("usage-invalid-insert"))
        with pytest.raises(IndexError, match="append-only"):
            repository.elastic_events.insert(-1, {"event": "invalid"})
    finally:
        repository.close()


def test_alert_trigger_compare_and_set_allows_only_one_worker() -> None:
    first, second = _repository_pair()
    barrier = Barrier(2)

    def trigger(
        repository: ApplicationStateRepository,
        notification_id: str,
    ) -> AlertNotification | None:
        barrier.wait()
        return repository.record_alert_trigger(
            _notification(notification_id),
            expected_last_triggered_at=None,
            last_triggered_at=NOW,
            max_records=100,
        )

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(
                executor.map(
                    lambda item: trigger(*item),
                    ((first, "notification-first"), (second, "notification-second")),
                )
            )

        assert sum(result is not None for result in results) == 1
        assert first.count_alert_notifications() == 1
        assert first.get_alert_rule_runtime("rule-one").last_triggered_at == NOW
    finally:
        first.close()
        second.close()


def test_notification_sequence_preserves_equal_timestamp_insertion_order() -> None:
    engine = create_application_engine("sqlite+pysqlite:///:memory:")
    upgrade_database(engine)
    repository = ApplicationStateRepository(engine)
    first = _notification("notification-z", rule_id="rule-z")
    second = _notification("notification-a", rule_id="rule-a")

    try:
        repository.insert_alert_notification(first)
        repository.insert_alert_notification(second)

        assert [item.id for item in repository.list_alert_notifications()] == [
            first.id,
            second.id,
        ]
        assert list(repository.alert_notifications) == [first.id, second.id]
        assert repository.trim_alert_notifications(1) == 1
        assert list(repository.alert_notifications) == [second.id]
    finally:
        repository.close()
