"""Custom alert rules: CRUD gating, matching, thresholds, and safety rails."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core import alerting
from app.main import app
from app.models.schemas import Role
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _rule_payload(**overrides) -> dict:
    payload = {
        "name": "Security watch",
        "action_patterns": ["security.*"],
        "min_severity": "warning",
        "recipients": ["soc@example.com"],
    }
    payload.update(overrides)
    return payload


def _owner():
    store = get_store()
    return next(user for user in store.users.values() if user.role == Role.PLATFORM_OWNER)


def test_admin_creates_tenant_rule_and_user_is_forbidden() -> None:
    denied = client.post("/api/admin/alert-rules", json=_rule_payload(), headers=headers("user-jane"))
    assert denied.status_code == 403

    created = client.post("/api/admin/alert-rules", json=_rule_payload(), headers=headers())
    assert created.status_code == 201
    rule = created.json()
    assert rule["scope"] == "tenant"
    assert rule["tenant_id"] == "tenant-example"
    assert rule["recipients"] == ["soc@example.com"]

    listed = client.get("/api/admin/alert-rules", headers=headers())
    assert [r["id"] for r in listed.json()] == [rule["id"]]


def test_owner_sees_all_rules_and_admin_cannot_touch_platform_rules() -> None:
    owner = _owner()
    platform_rule = client.post(
        "/api/platform/alert-rules", json=_rule_payload(name="Owner watch"), headers=headers(owner.id)
    )
    assert platform_rule.status_code == 201
    assert platform_rule.json()["scope"] == "platform"
    tenant_rule = client.post("/api/admin/alert-rules", json=_rule_payload(), headers=headers())
    assert tenant_rule.status_code == 201

    owner_listing = client.get("/api/platform/alert-rules", headers=headers(owner.id))
    scopes = {r["id"]: r["scope"] for r in owner_listing.json()}
    assert scopes[platform_rule.json()["id"]] == "platform"
    assert scopes[tenant_rule.json()["id"]] == "tenant"

    # The admin surface never exposes or mutates platform rules.
    admin_listing = client.get("/api/admin/alert-rules", headers=headers())
    assert [r["id"] for r in admin_listing.json()] == [tenant_rule.json()["id"]]
    denied = client.patch(
        f"/api/admin/alert-rules/{platform_rule.json()['id']}",
        json={"enabled": False},
        headers=headers(),
    )
    assert denied.status_code == 404

    # Platform alert routes are owner-only.
    assert (
        client.get("/api/platform/alert-rules", headers=headers()).status_code == 403
    )


def test_validation_rejects_bad_emails_severity_patterns_and_hidden_actors() -> None:
    bad_email = client.post(
        "/api/admin/alert-rules", json=_rule_payload(recipients=["not-an-email"]), headers=headers()
    )
    assert bad_email.status_code == 400
    bad_severity = client.post(
        "/api/admin/alert-rules", json=_rule_payload(min_severity="catastrophic"), headers=headers()
    )
    assert bad_severity.status_code == 400
    bad_pattern = client.post(
        "/api/admin/alert-rules", json=_rule_payload(action_patterns=["se curity.*"]), headers=headers()
    )
    assert bad_pattern.status_code == 400
    owner = _owner()
    hidden_actor = client.post(
        "/api/admin/alert-rules", json=_rule_payload(actor_ids=[owner.id]), headers=headers()
    )
    assert hidden_actor.status_code == 400


def test_matching_event_queues_notification_and_info_event_does_not() -> None:
    client.post("/api/admin/alert-rules", json=_rule_payload(), headers=headers())
    store = get_store()
    admin = store.users["user-admin"]

    store.record_audit(admin, "security.prompt_flagged", "prompt-1", {"severity": "high"})
    notifications = [n for n in store.alert_notifications.values()]
    assert len(notifications) == 1
    notification = notifications[0]
    assert notification.status == "queued"
    assert notification.recipients == ["soc@example.com"]
    assert notification.event_action == "security.prompt_flagged"
    assert notification.event_severity == "critical"

    store.record_audit(admin, "chat.thread_saved", "thread-1", {})
    assert len(store.alert_notifications) == 1  # info event below min_severity


def test_tenant_rule_never_fires_for_owner_or_platform_events() -> None:
    client.post(
        "/api/admin/alert-rules",
        json=_rule_payload(action_patterns=[], min_severity="info", cooldown_minutes=0),
        headers=headers(),
    )
    store = get_store()
    owner = _owner()

    baseline = len(store.alert_notifications)
    store.record_audit(owner, "platform.provider_key_revealed", "key-1", {})
    store.record_audit(owner, "admin.group_updated", "group-litigation", {})
    assert len(store.alert_notifications) == baseline


def test_threshold_rule_fires_only_at_count_within_window() -> None:
    client.post(
        "/api/admin/alert-rules",
        json=_rule_payload(threshold_count=3, window_minutes=5, cooldown_minutes=0),
        headers=headers(),
    )
    store = get_store()
    admin = store.users["user-admin"]

    store.record_audit(admin, "security.prompt_flagged", "p1", {"severity": "medium"})
    store.record_audit(admin, "security.prompt_flagged", "p2", {"severity": "medium"})
    assert len(store.alert_notifications) == 0

    store.record_audit(admin, "security.prompt_flagged", "p3", {"severity": "medium"})
    notifications = list(store.alert_notifications.values())
    assert len(notifications) == 1
    assert notifications[0].matched_count == 3


def test_cooldown_suppresses_immediate_refire() -> None:
    client.post(
        "/api/admin/alert-rules", json=_rule_payload(cooldown_minutes=60), headers=headers()
    )
    store = get_store()
    admin = store.users["user-admin"]

    store.record_audit(admin, "security.prompt_flagged", "p1", {"severity": "high"})
    store.record_audit(admin, "security.prompt_flagged", "p2", {"severity": "high"})
    assert len(store.alert_notifications) == 1


def test_rule_matching_admin_actions_fires_once_without_runaway() -> None:
    client.post(
        "/api/admin/alert-rules",
        json=_rule_payload(name="Governance watch", action_patterns=["admin.*"], min_severity="info", cooldown_minutes=0),
        headers=headers(),
    )
    store = get_store()
    events_before = len(store.audit_events)
    notifications_before = len(store.alert_notifications)

    response = client.post(
        "/api/admin/groups",
        json={"name": "Alert Loop Group"},
        headers=headers(),
    )
    assert response.status_code in (200, 201)
    # Exactly one audit event and one notification: evaluation never records
    # audit events of its own, so there is no feedback loop.
    assert len(store.audit_events) == events_before + 1
    assert len(store.alert_notifications) == notifications_before + 1


def test_request_path_never_sends_email(monkeypatch) -> None:
    def _forbidden(**kwargs):
        raise AssertionError("send_email must never run in the request path")

    monkeypatch.setattr("app.core.mailer.send_email", _forbidden)
    client.post("/api/admin/alert-rules", json=_rule_payload(), headers=headers())
    store = get_store()
    admin = store.users["user-admin"]
    store.record_audit(admin, "security.prompt_flagged", "p1", {"severity": "high"})
    assert [n.status for n in store.alert_notifications.values()] == ["queued"]


def test_rule_without_recipients_logs_in_app_only() -> None:
    client.post(
        "/api/admin/alert-rules", json=_rule_payload(recipients=[]), headers=headers()
    )
    store = get_store()
    admin = store.users["user-admin"]
    store.record_audit(admin, "security.prompt_flagged", "p1", {"severity": "high"})
    notification = next(iter(store.alert_notifications.values()))
    assert notification.status == "logged"
    assert "in-app" in notification.status_detail


def test_notification_log_is_capped(monkeypatch) -> None:
    monkeypatch.setattr(alerting, "ALERT_NOTIFICATIONS_MAX", 3)
    client.post(
        "/api/admin/alert-rules",
        json=_rule_payload(cooldown_minutes=0),
        headers=headers(),
    )
    store = get_store()
    admin = store.users["user-admin"]
    for index in range(5):
        store.record_audit(admin, "security.prompt_flagged", f"p{index}", {"severity": "high"})
    assert len(store.alert_notifications) == 3


def test_notifications_listing_is_scoped() -> None:
    owner = _owner()
    client.post("/api/admin/alert-rules", json=_rule_payload(cooldown_minutes=0), headers=headers())
    client.post(
        "/api/platform/alert-rules",
        json=_rule_payload(name="Owner watch", action_patterns=["platform.*"], min_severity="info", cooldown_minutes=0),
        headers=headers(owner.id),
    )
    store = get_store()
    admin = store.users["user-admin"]
    store.record_audit(admin, "security.prompt_flagged", "p1", {"severity": "high"})
    store.record_audit(owner, "platform.provider_key_revealed", "key-1", {})

    admin_visible = client.get("/api/admin/alert-notifications", headers=headers()).json()
    assert {n["scope"] for n in admin_visible} == {"tenant"}
    owner_visible = client.get(
        "/api/platform/alert-notifications", headers=headers(owner.id)
    ).json()
    assert {n["scope"] for n in owner_visible} == {"tenant", "platform"}


def test_admin_email_status_is_honest_when_unconfigured() -> None:
    response = client.get("/api/admin/alert-email-status", headers=headers())
    assert response.status_code == 200
    body = response.json()
    assert body["configured"] is False
    assert "not configured" in body["message"]
    assert "logged in-app" in body["message"]


def test_rule_persistence_round_trip(tmp_path) -> None:
    from app.core.security import SecretVault
    from app.repositories.seed import SeedStore

    state_path = tmp_path / "runtime_state.json"
    store = SeedStore(SecretVault("test-secret"), runtime_state_path=str(state_path))
    admin = store.users["user-admin"]
    from app.models.schemas import AlertRule

    store.alert_rules["alertrule-test"] = AlertRule(
        id="alertrule-test",
        scope="tenant",
        tenant_id="tenant-example",
        name="Persisted rule",
        action_patterns=["security.*"],
        min_severity="warning",
        recipients=["soc@example.com"],
        created_by=admin.id,
    )
    store.record_audit(admin, "security.prompt_flagged", "p1", {"severity": "high"})
    store.flush_now()

    reloaded = SeedStore(SecretVault("test-secret"), runtime_state_path=str(state_path))
    assert "alertrule-test" in reloaded.alert_rules
    assert len(reloaded.alert_notifications) == 1


def test_alert_notification_archive_respects_scopes() -> None:
    owner = _owner()
    client.post("/api/admin/alert-rules", json=_rule_payload(cooldown_minutes=0), headers=headers())
    client.post(
        "/api/platform/alert-rules",
        json=_rule_payload(
            name="Owner watch", action_patterns=["platform.*"], min_severity="info", cooldown_minutes=0
        ),
        headers=headers(owner.id),
    )
    store = get_store()
    admin = store.users["user-admin"]
    store.record_audit(admin, "security.prompt_flagged", "p1", {"severity": "high"})
    store.record_audit(owner, "platform.provider_key_revealed", "key-1", {})
    by_scope = {n.scope: n for n in store.alert_notifications.values()}
    tenant_notification = by_scope["tenant"]
    platform_notification = by_scope["platform"]

    archived = client.patch(
        f"/api/admin/alert-notifications/{tenant_notification.id}",
        json={"archived": True},
        headers=headers(),
    )
    assert archived.status_code == 200
    assert archived.json()["archived"] is True

    # Tenant admins can never reach platform-scope deliveries.
    denied = client.patch(
        f"/api/admin/alert-notifications/{platform_notification.id}",
        json={"archived": True},
        headers=headers(),
    )
    assert denied.status_code == 404

    # The flag persists in the listing, and the owner can restore it.
    listed = client.get("/api/admin/alert-notifications", headers=headers()).json()
    assert [n["archived"] for n in listed if n["id"] == tenant_notification.id] == [True]
    restored = client.patch(
        f"/api/platform/alert-notifications/{tenant_notification.id}",
        json={"archived": False},
        headers=headers(owner.id),
    )
    assert restored.status_code == 200
    assert restored.json()["archived"] is False

    missing = client.patch(
        "/api/platform/alert-notifications/notification-does-not-exist",
        json={"archived": True},
        headers=headers(owner.id),
    )
    assert missing.status_code == 404
