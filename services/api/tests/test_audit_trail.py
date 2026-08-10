from __future__ import annotations

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def seed_openrouter_key(secret: str = "sk-or-v1-audit-secret") -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    provider.last_sync = "Loaded for test"
    store.create_provider_key(
        key_id="key-openrouter-primary",
        provider=provider,
        name="OpenRouter Primary",
        environment="Production",
        status="Active",
        expires="Not set",
        secret_value=secret,
    )


def test_disabling_a_model_appends_exactly_one_transaction_audit_event() -> None:
    before_count = len(get_store().audit_events)

    response = client.patch(
        "/api/platform/models/gpt-4o",
        json={"platform_enabled": False},
        headers=headers("user-owner"),
    )
    assert response.status_code == 200

    events = get_store().audit_events
    assert len(events) == before_count + 1
    event = events[-1]
    assert event.action == "platform.model_status_changed"
    assert event.action_type == "MODEL_DISABLED"
    assert event.actor_id == "user-owner"
    assert event.actor_name == "Aperture Platform Owner"
    assert event.actor_role == "PLATFORM_OWNER"
    assert event.target == "gpt-4o"
    assert event.target_type == "model"
    assert event.target_name == "gpt-4o"
    assert "platform_enabled=false" in event.detail
    assert event.created_at.tzinfo is not None

    re_enable = client.patch(
        "/api/platform/models/gpt-4o",
        json={"platform_enabled": True},
        headers=headers("user-owner"),
    )
    assert re_enable.status_code == 200
    assert get_store().audit_events[-1].action_type == "MODEL_ENABLED"


def test_audit_events_endpoint_requires_platform_owner() -> None:
    owner_response = client.get("/api/platform/audit-events", headers=headers("user-owner"))
    assert owner_response.status_code == 200

    admin_response = client.get("/api/platform/audit-events", headers=headers("user-admin"))
    assert admin_response.status_code == 403

    user_response = client.get("/api/platform/audit-events", headers=headers("user-jane"))
    assert user_response.status_code == 403

    anonymous_response = client.get("/api/platform/audit-events")
    assert anonymous_response.status_code == 401


def test_audit_events_endpoint_returns_newest_first_with_iso_timestamps() -> None:
    disable = client.patch(
        "/api/platform/models/gpt-4o",
        json={"platform_enabled": False},
        headers=headers("user-owner"),
    )
    assert disable.status_code == 200
    enable = client.patch(
        "/api/platform/models/gpt-4o",
        json={"platform_enabled": True},
        headers=headers("user-owner"),
    )
    assert enable.status_code == 200

    response = client.get("/api/platform/audit-events", headers=headers("user-owner"))
    assert response.status_code == 200
    events = response.json()
    assert [event["action_type"] for event in events[:2]] == ["MODEL_ENABLED", "MODEL_DISABLED"]
    parsed = datetime.fromisoformat(events[0]["created_at"])
    assert parsed.tzinfo is not None

    limited = client.get("/api/platform/audit-events?limit=1", headers=headers("user-owner"))
    assert limited.status_code == 200
    assert len(limited.json()) == 1
    assert limited.json()[0]["id"] == events[0]["id"]


def test_model_access_grant_changes_record_grant_added_and_removed_events() -> None:
    grant_response = client.patch(
        "/api/admin/model-access/gpt-4o",
        json={"group_ids": ["group-litigation", "group-corporate", "group-default-users", "group-hr"]},
        headers=headers("user-admin"),
    )
    assert grant_response.status_code == 200
    added_event = get_store().audit_events[-1]
    assert added_event.action == "admin.model_access_updated"
    assert added_event.action_type == "GRANT_ADDED"
    assert added_event.target_name == "gpt-4o"
    assert added_event.metadata["previous_group_ids"] == ["group-litigation", "group-corporate", "group-default-users"]

    revoke_response = client.patch(
        "/api/admin/model-access/gpt-4o",
        json={"group_ids": ["group-litigation"]},
        headers=headers("user-admin"),
    )
    assert revoke_response.status_code == 200
    removed_event = get_store().audit_events[-1]
    assert removed_event.action_type == "GRANT_REMOVED"
    assert removed_event.actor_name == "Alex Morgan"
    assert removed_event.actor_role == "TENANT_ADMIN"


def test_user_role_change_and_deactivation_record_typed_events() -> None:
    role_response = client.patch(
        "/api/admin/users/user-jane",
        json={"role": "POWER_USER"},
        headers=headers("user-admin"),
    )
    assert role_response.status_code == 200
    role_event = get_store().audit_events[-1]
    assert role_event.action_type == "USER_ROLE_CHANGED"
    assert role_event.target_type == "user"
    assert role_event.target_name == "Jane Smith"

    deactivate_response = client.post("/api/admin/users/user-jane/deactivate", headers=headers("user-admin"))
    assert deactivate_response.status_code == 200
    deactivate_event = get_store().audit_events[-1]
    assert deactivate_event.action_type == "USER_DEACTIVATED"
    assert deactivate_event.target_name == "Jane Smith"

    delete_response = client.delete("/api/admin/users/user-jane", headers=headers("user-admin"))
    assert delete_response.status_code == 200
    delete_event = get_store().audit_events[-1]
    assert delete_event.action_type == "USER_DELETED"
    assert delete_event.target_name == "Jane Smith"
    assert "user-jane" not in get_store().users


def test_provider_key_reveal_is_audited_without_leaking_the_secret() -> None:
    seed_openrouter_key("sk-or-v1-audit-secret")

    reveal_response = client.post(
        "/api/platform/provider-keys/key-openrouter-primary/reveal",
        headers=headers("user-owner"),
    )
    assert reveal_response.status_code == 200

    audit_response = client.get("/api/platform/audit-events", headers=headers("user-owner"))
    assert audit_response.status_code == 200
    assert "sk-or-v1-audit-secret" not in audit_response.text
    reveal_event = audit_response.json()[0]
    assert reveal_event["action_type"] == "PROVIDER_KEY_REVEALED"
    assert reveal_event["target_type"] == "provider-key"
    assert reveal_event["target_name"] == "OpenRouter Primary"
    assert reveal_event["metadata"]["secret_value"] == "[redacted]"
