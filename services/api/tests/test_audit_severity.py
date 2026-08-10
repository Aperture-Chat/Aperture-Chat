"""Rule-based audit severity classification and endpoint decoration."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.audit_severity import classify_audit_event, severity_at_least
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


@pytest.mark.parametrize(
    ("action", "metadata", "expected"),
    [
        ("platform.provider_key_revealed", None, "critical"),
        ("platform.provider_key_deleted", None, "critical"),
        ("admin.user_deleted", None, "critical"),
        ("admin.password_reset", None, "critical"),
        ("admin.sso_config_updated", None, "critical"),
        ("admin.user_updated", {"changed": ["role"]}, "critical"),
        ("admin.user_updated", {"changed": ["display_name"]}, "info"),
        ("security.content_filter_blocked", None, "critical"),
        ("security.prompt_flagged", {"severity": "high"}, "critical"),
        ("security.prompt_flagged", {"severity": "medium"}, "warning"),
        ("auth.bootstrap_owner_created", None, "critical"),
        ("admin.group_deleted", None, "warning"),
        ("platform.model_deleted", None, "warning"),
        ("platform.provider_models_sync_failed", None, "warning"),
        ("platform.provider_runtime_validation_failed", None, "warning"),
        ("automation.run_failed", None, "warning"),
        ("admin.model_access_updated", None, "warning"),
        ("admin.user_deactivated", None, "warning"),
        ("auth.api_key_created", None, "warning"),
        ("security.content_filter_redacted", None, "warning"),
        ("security.alert_acknowledged", None, "info"),
        ("auth.login", None, "info"),
        ("chat.thread_saved", None, "info"),
        ("admin.group_created", None, "info"),
        ("hermes.memory_saved", None, "info"),
        ("future.new_action", None, "info"),
    ],
)
def test_classifier_rules(action: str, metadata: dict | None, expected: str) -> None:
    severity, reason = classify_audit_event(action, metadata)
    assert severity == expected
    assert reason


def test_every_classification_carries_a_reason_and_valid_level() -> None:
    sample_actions = [
        "platform.provider_key_revealed",
        "admin.user_updated",
        "security.prompt_flagged",
        "chat.folder_saved",
        "totally.unknown_action",
    ]
    for action in sample_actions:
        severity, reason = classify_audit_event(action, {})
        assert severity in {"info", "warning", "critical"}
        assert isinstance(reason, str) and reason


def test_severity_at_least_ordering() -> None:
    assert severity_at_least("critical", "info")
    assert severity_at_least("warning", "warning")
    assert not severity_at_least("info", "warning")
    # Unknown values degrade to the lowest rank instead of raising.
    assert severity_at_least("bogus", "info")
    assert not severity_at_least("bogus", "critical")


def test_admin_audit_listing_is_decorated_and_still_scoped() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    owner = next(user for user in store.users.values() if user.role == Role.PLATFORM_OWNER)
    store.record_audit(admin, "admin.group_deleted", "group-x", {"name": "X"})
    store.record_audit(owner, "platform.provider_key_revealed", "key-1", {})

    response = client.get("/api/admin/audit-events", headers=headers())
    assert response.status_code == 200
    events = response.json()
    assert events, "expected at least the admin event"
    for event in events:
        assert event["severity"] in {"info", "warning", "critical"}
        assert event["severity_reason"]
        assert event["actor_role"] != "PLATFORM_OWNER"
        assert not event["action"].startswith("platform.")
    deletion = next(e for e in events if e["action"] == "admin.group_deleted")
    assert deletion["severity"] == "warning"


def test_owner_audit_listing_is_decorated_and_global() -> None:
    store = get_store()
    owner = next(user for user in store.users.values() if user.role == Role.PLATFORM_OWNER)
    store.record_audit(owner, "platform.provider_key_revealed", "key-1", {})

    response = client.get("/api/platform/audit-events", headers=headers(owner.id))
    assert response.status_code == 200
    events = response.json()
    reveal = next(e for e in events if e["action"] == "platform.provider_key_revealed")
    assert reveal["severity"] == "critical"
    assert "revealed" in reveal["severity_reason"]


def test_elastic_mirror_carries_severity() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    store.record_audit(admin, "admin.sso_config_updated", "sso-1", {})
    assert store.elastic_events[-1]["severity"] == "critical"
