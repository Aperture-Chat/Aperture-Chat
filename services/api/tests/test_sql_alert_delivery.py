"""SQL-only alert evaluation, alert delivery, and Elastic outbox tests."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from app.core import alerting, mailer, scheduler
from app.core.config import Settings
from app.core.elastic_export import flush_elastic_events
from app.db import create_application_engine, upgrade_database
from app.models.schemas import AlertNotification, AlertRule, AuditEvent, EmailSettings
from app.repositories.application_state import ApplicationStateRepository


class _RuntimeStore:
    """Small store facade that intentionally has no legacy JSON collections."""

    def __init__(self, repository: ApplicationStateRepository) -> None:
        self.application_state_repository = repository
        self.alert_rules: dict[str, AlertRule] = {}
        self._evaluating_alerts = False
        self.email_settings = EmailSettings()
        self.elastic_last_delivery_at: str | None = None
        self.elastic_last_delivery_error: str | None = None

    def configuration_secret(self, namespace: str, key_id: str) -> str | None:
        assert (namespace, key_id) == ("smtp", "primary")
        return "smtp-test-secret"

    def brand_name(self, tenant_id: str | None = None) -> str:
        return "Tenant Aperture" if tenant_id else "Aperture"


def _database_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _repository(path: Path) -> ApplicationStateRepository:
    engine = create_application_engine(_database_url(path))
    upgrade_database(engine)
    return ApplicationStateRepository(engine)


def _event(event_id: str, created_at: datetime) -> AuditEvent:
    return AuditEvent(
        id=event_id,
        tenant_id="tenant-example",
        actor_id="user-admin",
        actor_name="Admin User",
        actor_role="ADMIN",
        action="security.prompt_flagged",
        action_type="security",
        target=f"prompt-{event_id}",
        target_type="prompt",
        target_name="Flagged prompt",
        detail="Sensitive content policy matched.",
        created_at=created_at,
        metadata={"severity": "high"},
    )


def _rule(*, threshold_count: int = 1, cooldown_minutes: int = 60) -> AlertRule:
    return AlertRule(
        id="alertrule-security",
        scope="tenant",
        tenant_id="tenant-example",
        name="Security watch",
        action_patterns=["security.*"],
        min_severity="warning",
        threshold_count=threshold_count,
        window_minutes=5,
        cooldown_minutes=cooldown_minutes,
        recipients=["soc@example.com"],
        created_by="user-admin",
    )


def _notification(notification_id: str = "alertnotif-test") -> AlertNotification:
    return AlertNotification(
        id=notification_id,
        rule_id="alertrule-security",
        rule_name="Security watch",
        scope="tenant",
        tenant_id="tenant-example",
        event_id="audit-security",
        event_action="security.prompt_flagged",
        event_severity="critical",
        actor_id="user-admin",
        actor_name="Admin User",
        summary="security · Flagged prompt",
        recipients=["soc@example.com"],
        status="queued",
        created_at=datetime(2026, 7, 20, 12, 0, tzinfo=UTC),
    )


def test_alert_threshold_cooldown_and_notification_survive_restart(tmp_path: Path) -> None:
    database_path = tmp_path / "alerts.sqlite3"
    repository = _repository(database_path)
    store = _RuntimeStore(repository)
    rule = _rule(threshold_count=2)
    store.alert_rules[rule.id] = rule
    start = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)

    first = _event("audit-first", start)
    repository.append_audit_with_outbox(first)
    assert alerting.evaluate_audit_event(store, first) == []

    second = _event("audit-second", start + timedelta(minutes=1))
    repository.append_audit_with_outbox(second)
    created = alerting.evaluate_audit_event(store, second)
    assert len(created) == 1
    assert created[0].matched_count == 2
    # The same-process rule projection stays current, but cooldown checks and
    # restart recovery read the authoritative SQL runtime row.
    assert rule.last_triggered_at == second.created_at

    third = _event("audit-third", start + timedelta(minutes=2))
    repository.append_audit_with_outbox(third)
    assert alerting.evaluate_audit_event(store, third) == []
    runtime = repository.get_alert_rule_runtime(rule.id)
    assert runtime is not None
    assert runtime.last_triggered_at == second.created_at
    assert repository.count_alert_notifications() == 1
    assert not hasattr(store, "audit_events")
    assert not hasattr(store, "alert_notifications")
    repository.close()

    restarted = _repository(database_path)
    try:
        persisted = restarted.list_alert_notifications()
        assert [item.event_id for item in persisted] == [second.id]
        restarted_runtime = restarted.get_alert_rule_runtime(rule.id)
        assert restarted_runtime is not None
        assert restarted_runtime.last_triggered_at == second.created_at
    finally:
        restarted.close()


def test_alert_notification_retention_is_enforced_in_sql(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = _repository(tmp_path / "retention.sqlite3")
    try:
        store = _RuntimeStore(repository)
        rule = _rule(cooldown_minutes=0)
        store.alert_rules[rule.id] = rule
        monkeypatch.setattr(alerting, "ALERT_NOTIFICATIONS_MAX", 2)
        start = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)

        for index in range(3):
            event = _event(f"audit-{index}", start + timedelta(minutes=index))
            repository.append_audit_with_outbox(event)
            assert len(alerting.evaluate_audit_event(store, event)) == 1

        persisted = repository.list_alert_notifications(newest_first=False)
        assert [item.event_id for item in persisted] == ["audit-1", "audit-2"]
    finally:
        repository.close()


def test_alert_delivery_persists_success_without_runtime_json(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_path = tmp_path / "delivery.sqlite3"
    repository = _repository(database_path)
    store = _RuntimeStore(repository)
    store.email_settings = EmailSettings(
        host="smtp.example.com",
        port=587,
        security="starttls",
        username="mailer@example.com",
        from_address="alerts@example.com",
        password_set=True,
    )
    repository.insert_alert_notification(_notification())
    sent_messages: list[dict[str, object]] = []

    def _send(**kwargs: object) -> None:
        sent_messages.append(kwargs)

    monkeypatch.setattr(mailer, "send_email", _send)
    assert scheduler.deliver_alert_notifications(store) == 1
    assert len(sent_messages) == 1
    assert "Tenant Aperture alert" in str(sent_messages[0]["subject"])
    persisted = repository.get_alert_notification("alertnotif-test")
    assert persisted is not None
    assert persisted.status == "sent"
    assert persisted.attempts == 1
    assert persisted.delivered_at is not None
    assert not hasattr(store, "alert_notifications")
    assert not hasattr(store, "save_runtime_state")
    repository.close()

    restarted = _repository(database_path)
    try:
        after_restart = restarted.get_alert_notification("alertnotif-test")
        assert after_restart is not None
        assert after_restart.status == "sent"
        assert after_restart.attempts == 1
    finally:
        restarted.close()


def test_alert_delivery_retries_and_persists_terminal_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = _repository(tmp_path / "delivery-failure.sqlite3")
    try:
        store = _RuntimeStore(repository)
        store.email_settings = EmailSettings(
            host="smtp.example.com",
            from_address="alerts@example.com",
        )
        repository.insert_alert_notification(_notification())
        monkeypatch.setattr(scheduler, "MAX_DELIVERY_ATTEMPTS", 2)

        def _fail(**kwargs: object) -> None:
            del kwargs
            raise mailer.MailerError("SMTP refused the connection")

        monkeypatch.setattr(mailer, "send_email", _fail)
        assert scheduler.deliver_alert_notifications(store) == 0
        retrying = repository.get_alert_notification("alertnotif-test")
        assert retrying is not None
        assert retrying.status == "queued"
        assert retrying.attempts == 1

        assert scheduler.deliver_alert_notifications(store) == 0
        failed = repository.get_alert_notification("alertnotif-test")
        assert failed is not None
        assert failed.status == "failed"
        assert failed.attempts == 2
        assert "SMTP refused" in failed.status_detail
    finally:
        repository.close()


def _elastic_settings() -> Settings:
    return Settings(elastic_url="http://elastic.test:9200", elastic_api_key="test-key")


def test_elastic_flush_marks_ordered_outbox_only_after_success(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "elastic-success.sqlite3")
    try:
        store = _RuntimeStore(repository)
        start = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)
        repository.append_audit_with_outbox(_event("audit-one", start))
        repository.append_audit_with_outbox(_event("audit-two", start + timedelta(seconds=1)))
        requests: list[httpx.Request] = []

        def _success(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={"errors": False, "items": []})

        delivered = flush_elastic_events(
            store,
            _elastic_settings(),
            transport=httpx.MockTransport(_success),
        )

        assert delivered == 2
        assert repository.count_pending_outbox() == 0
        assert repository.count_outbox(pending_only=False) == 2
        body_lines = requests[0].content.decode().splitlines()
        assert [json.loads(body_lines[index])["id"] for index in (1, 3)] == [
            "audit-one",
            "audit-two",
        ]
        assert store.elastic_last_delivery_at is not None
        assert store.elastic_last_delivery_error is None
        assert not hasattr(store, "elastic_events")
        assert not hasattr(store, "save_runtime_state")
    finally:
        repository.close()


def test_elastic_failure_keeps_batch_pending_for_retry(tmp_path: Path) -> None:
    repository = _repository(tmp_path / "elastic-retry.sqlite3")
    try:
        store = _RuntimeStore(repository)
        repository.append_audit_with_outbox(
            _event("audit-retry", datetime(2026, 7, 20, 12, 0, tzinfo=UTC))
        )

        def _failure(request: httpx.Request) -> httpx.Response:
            del request
            return httpx.Response(503, json={"error": "unavailable"})

        assert (
            flush_elastic_events(
                store,
                _elastic_settings(),
                transport=httpx.MockTransport(_failure),
            )
            == 0
        )
        assert repository.count_pending_outbox() == 1
        assert store.elastic_last_delivery_error is not None

        def _success(request: httpx.Request) -> httpx.Response:
            del request
            return httpx.Response(200, json={"errors": False, "items": []})

        assert (
            flush_elastic_events(
                store,
                _elastic_settings(),
                transport=httpx.MockTransport(_success),
            )
            == 1
        )
        assert repository.count_pending_outbox() == 0
        assert store.elastic_last_delivery_error is None
    finally:
        repository.close()
