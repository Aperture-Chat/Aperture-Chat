"""Alert email delivery: honest statuses, retry, vault-only secrets, test-send."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import mailer, scheduler
from app.core.config import Settings
from app.main import app
from app.models.schemas import AlertNotification, Role
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _owner():
    store = get_store()
    return next(user for user in store.users.values() if user.role == Role.PLATFORM_OWNER)


def _queue_notification(store, notification_id: str = "alertnotif-test") -> AlertNotification:
    notification = AlertNotification(
        id=notification_id,
        rule_id="alertrule-x",
        rule_name="Suspicious activity",
        scope="tenant",
        tenant_id="tenant-example",
        event_id="audit-x",
        event_action="security.prompt_flagged",
        event_severity="critical",
        actor_id="user-jane",
        actor_name="Jane Counsel",
        summary="PROMPT_FLAGGED · prompt-1",
        recipients=["soc@example.com"],
        status="queued",
    )
    store.alert_notifications[notification.id] = notification
    return notification


def _configure_email(store, *, password: str | None = "smtp-secret-value") -> None:
    store.email_settings.host = "smtp.example.com"
    store.email_settings.port = 587
    store.email_settings.security = "starttls"
    store.email_settings.username = "mailer@example.com"
    store.email_settings.from_address = "alerts@example.com"
    if password is not None:
        store.set_configuration_secret("smtp", "primary", password)
        store.email_settings.password_set = True


class FakeSMTP:
    instances: list["FakeSMTP"] = []
    fail_with: Exception | None = None

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.started_tls = False
        self.login_args = None
        self.sent_messages = []
        FakeSMTP.instances.append(self)

    def starttls(self):
        self.started_tls = True

    def login(self, username, password):
        self.login_args = (username, password)

    def send_message(self, message):
        if FakeSMTP.fail_with is not None:
            raise FakeSMTP.fail_with
        self.sent_messages.append(message)

    def quit(self):
        pass


@pytest.fixture(autouse=True)
def reset_fake_smtp() -> None:
    FakeSMTP.instances = []
    FakeSMTP.fail_with = None
    yield
    FakeSMTP.instances = []
    FakeSMTP.fail_with = None


def test_delivery_sends_and_marks_sent(monkeypatch) -> None:
    monkeypatch.setattr("app.core.mailer.smtplib.SMTP", FakeSMTP)
    store = get_store()
    _configure_email(store)
    notification = _queue_notification(store)

    sent = scheduler.deliver_alert_notifications(store)

    assert sent == 1
    notification = store.alert_notifications[notification.id]
    assert notification.status == "sent"
    assert notification.delivered_at is not None
    smtp = FakeSMTP.instances[-1]
    assert smtp.started_tls is True
    assert smtp.login_args == ("mailer@example.com", "smtp-secret-value")
    message = smtp.sent_messages[0]
    assert message["To"] == "soc@example.com"
    assert message["From"] == "alerts@example.com"
    assert "Suspicious activity" in message["Subject"]


def test_delivery_failure_retries_then_fails_with_real_error(monkeypatch) -> None:
    monkeypatch.setattr("app.core.mailer.smtplib.SMTP", FakeSMTP)
    monkeypatch.setattr(scheduler, "MAX_DELIVERY_ATTEMPTS", 3)
    FakeSMTP.fail_with = ConnectionRefusedError("Connection refused by smtp.example.com")
    store = get_store()
    _configure_email(store)
    notification = _queue_notification(store)

    for expected_attempts in (1, 2):
        scheduler.deliver_alert_notifications(store)
        notification = store.alert_notifications[notification.id]
        assert notification.status == "queued"
        assert notification.attempts == expected_attempts
        assert "Connection refused" in notification.status_detail

    scheduler.deliver_alert_notifications(store)
    notification = store.alert_notifications[notification.id]
    assert notification.status == "failed"
    assert notification.attempts == 3
    assert "Connection refused" in notification.status_detail


def test_unconfigured_email_marks_not_configured_honestly() -> None:
    store = get_store()
    notification = _queue_notification(store)

    sent = scheduler.deliver_alert_notifications(store)

    assert sent == 0
    notification = store.alert_notifications[notification.id]
    assert notification.status == "not_configured"
    assert "not configured" in notification.status_detail
    assert "platform owner" in notification.status_detail


def test_scheduler_pass_invokes_delivery(monkeypatch) -> None:
    monkeypatch.setattr("app.core.mailer.smtplib.SMTP", FakeSMTP)
    store = get_store()
    _configure_email(store)
    notification = _queue_notification(store)

    scheduler.scheduler_pass(store, Settings())

    notification = store.alert_notifications[notification.id]
    assert notification.status == "sent"


def test_settings_put_stores_password_in_vault_only(tmp_path) -> None:
    from app.core.security import SecretVault
    from app.models.schemas import EmailSettingsUpdateRequest
    from app.repositories.seed import SeedStore
    from app.routes import platform as platform_routes

    state_path = tmp_path / "runtime_state.json"
    store = SeedStore(SecretVault("test-secret"), runtime_state_path=str(state_path))
    owner = next(user for user in store.users.values() if user.role == Role.PLATFORM_OWNER)

    # Drive the route function directly against this persistent store.
    result = platform_routes.update_platform_email_settings(
        EmailSettingsUpdateRequest(
            host="smtp.example.com",
            from_address="alerts@example.com",
            username="mailer@example.com",
            password="ultra-secret-password",
        ),
        actor=owner,
        store=store,
    )
    assert result.password_set is True
    assert result.masked_password
    assert "ultra-secret-password" not in result.masked_password
    store.flush_now()

    raw_state = Path(state_path).read_text(encoding="utf-8")
    assert "ultra-secret-password" not in raw_state
    # Post-cutover the settings authority is SQL; the runtime JSON is an
    # import tombstone and the plaintext must not appear in either file.
    database_bytes = state_path.with_suffix(".sqlite3").read_bytes()
    assert b"ultra-secret-password" not in database_bytes
    assert store.email_settings.password_set is True
    assert store.configuration_secret("smtp", "primary") == "ultra-secret-password"

    audit_actions = [event.action for event in store.audit_events]
    assert "platform.email_settings_updated" in audit_actions
    changed = store.audit_events[-1].metadata.get("changed")
    assert "password" in changed


def test_email_settings_routes_are_owner_only_and_never_echo_password(monkeypatch) -> None:
    owner = _owner()
    assert client.get("/api/platform/email-settings", headers=headers("user-admin")).status_code == 403

    updated = client.put(
        "/api/platform/email-settings",
        json={"host": "smtp.example.com", "from_address": "alerts@example.com", "password": "s3cret"},
        headers=headers(owner.id),
    )
    assert updated.status_code == 200
    body = updated.json()
    assert body["password_set"] is True
    assert "s3cret" not in json.dumps(body)

    fetched = client.get("/api/platform/email-settings", headers=headers(owner.id)).json()
    assert "s3cret" not in json.dumps(fetched)


def test_test_send_reports_honest_success_and_failure(monkeypatch) -> None:
    monkeypatch.setattr("app.core.mailer.smtplib.SMTP", FakeSMTP)
    owner = _owner()
    store = get_store()

    unconfigured = client.post(
        "/api/platform/email-settings/test",
        json={"recipient": "owner@example.com"},
        headers=headers(owner.id),
    )
    assert unconfigured.status_code == 400
    assert "not configured" in unconfigured.json()["detail"]

    _configure_email(store)
    success = client.post(
        "/api/platform/email-settings/test",
        json={"recipient": "owner@example.com"},
        headers=headers(owner.id),
    )
    assert success.status_code == 200
    assert success.json()["status"] == "sent"
    assert store.email_settings.last_test_status == "sent"

    FakeSMTP.fail_with = RuntimeError("535 authentication failed")
    failure = client.post(
        "/api/platform/email-settings/test",
        json={"recipient": "owner@example.com"},
        headers=headers(owner.id),
    )
    assert failure.status_code == 200
    assert failure.json()["status"] == "failed"
    assert "535" in failure.json()["detail"]
    assert store.email_settings.last_test_status == "failed: 535 authentication failed"


def test_ssl_mode_uses_smtp_ssl(monkeypatch) -> None:
    monkeypatch.setattr("app.core.mailer.smtplib.SMTP_SSL", FakeSMTP)
    store = get_store()
    _configure_email(store)
    store.email_settings.security = "ssl"
    _queue_notification(store)

    scheduler.deliver_alert_notifications(store)

    smtp = FakeSMTP.instances[-1]
    assert smtp.started_tls is False
    assert smtp.sent_messages


def test_send_email_wraps_all_failures_as_mailer_error(monkeypatch) -> None:
    def boom(host, port, timeout=None):
        raise OSError("network unreachable")

    monkeypatch.setattr("app.core.mailer.smtplib.SMTP", boom)
    with pytest.raises(mailer.MailerError, match="network unreachable"):
        mailer.send_email(
            host="smtp.example.com",
            port=587,
            security="starttls",
            username="",
            password=None,
            from_address="alerts@example.com",
            recipients=["soc@example.com"],
            subject="x",
            body_text="y",
        )
