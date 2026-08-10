from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)

USER_ID = "user-jane"
ADMIN_ID = "user-admin"
OWNER_ID = "user-owner"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _approved_target() -> tuple[str, str]:
    """A provider/upstream pair the owner has already platform-enabled."""
    store = get_store()
    for model in store.models.values():
        if model.platform_enabled and (model.upstream_model_id or "").strip():
            return model.provider_id, model.upstream_model_id  # type: ignore[return-value]
    raise AssertionError("no platform-enabled model in seed data")


def _grant_authoring(enabled: bool) -> None:
    store = get_store()
    for group_id in _user_group_ids():
        store.groups[group_id].permissions["agent_authoring"] = enabled


def _user_group_ids() -> list[str]:
    store = get_store()
    return list(store.users[USER_ID].group_ids)


def _set_ceiling(enabled: bool) -> None:
    get_store().platform_settings.users_can_create_models = enabled


def _create_body(name: str = "My Agent") -> dict[str, object]:
    provider_id, upstream = _approved_target()
    return {
        "name": name,
        "provider_id": provider_id,
        "upstream_model_id": upstream,
        "system_prompt": "Be helpful.",
        "is_custom": True,
    }


def test_ceiling_off_blocks_users_and_names_the_policy() -> None:
    _set_ceiling(False)
    _grant_authoring(True)
    resp = client.post("/api/admin/agent-profiles", headers=headers(USER_ID), json=_create_body())
    assert resp.status_code == 403
    assert "unavailable under the current service policy" in resp.json()["detail"]


def test_ceiling_on_without_grant_still_blocks() -> None:
    _set_ceiling(True)
    _grant_authoring(False)
    resp = client.post("/api/admin/agent-profiles", headers=headers(USER_ID), json=_create_body())
    assert resp.status_code == 403
    assert "platform groups" in resp.json()["detail"]


def test_granted_user_creates_private_self_owned_agent() -> None:
    _set_ceiling(True)
    _grant_authoring(True)
    resp = client.post("/api/admin/agent-profiles", headers=headers(USER_ID), json=_create_body())
    assert resp.status_code == 201, resp.json()
    created = resp.json()
    # Sharing and publication stay on the admin side regardless of payload.
    assert created["visibility"] == "private"
    assert created["group_ids"] == []
    assert created["platform_enabled"] is False
    assert created["created_by"] == USER_ID
    assert created["admin_delete_locked"] is False


def test_granted_user_cannot_publish_or_share_through_payload() -> None:
    _set_ceiling(True)
    _grant_authoring(True)
    body = _create_body("Sneaky")
    body |= {
        "visibility": "organization",
        "group_ids": _user_group_ids(),
        "platform_enabled": True,
        "created_by": "user-admin",
        "admin_delete_locked": True,
    }
    created = client.post(
        "/api/admin/agent-profiles", headers=headers(USER_ID), json=body
    ).json()
    assert created["visibility"] == "private"
    assert created["group_ids"] == []
    assert created["platform_enabled"] is False
    assert created["created_by"] == USER_ID
    assert created["admin_delete_locked"] is False


def test_granted_user_edits_own_agent_but_not_someone_elses() -> None:
    _set_ceiling(True)
    _grant_authoring(True)
    mine = client.post(
        "/api/admin/agent-profiles", headers=headers(USER_ID), json=_create_body("Mine")
    ).json()
    theirs = client.post(
        "/api/admin/agent-profiles", headers=headers(ADMIN_ID), json=_create_body("Theirs")
    ).json()

    own = client.patch(
        f"/api/admin/agent-profiles/{mine['id']}",
        headers=headers(USER_ID),
        json={"name": "Renamed"},
    )
    assert own.status_code == 200
    assert own.json()["name"] == "Renamed"

    # Another author's profile is not even acknowledged as existing.
    foreign = client.patch(
        f"/api/admin/agent-profiles/{theirs['id']}",
        headers=headers(USER_ID),
        json={"name": "Hijacked"},
    )
    assert foreign.status_code == 404
    assert client.delete(
        f"/api/admin/agent-profiles/{theirs['id']}", headers=headers(USER_ID)
    ).status_code == 404


def test_granted_user_cannot_escalate_visibility_on_update() -> None:
    _set_ceiling(True)
    _grant_authoring(True)
    mine = client.post(
        "/api/admin/agent-profiles", headers=headers(USER_ID), json=_create_body("Mine")
    ).json()
    updated = client.patch(
        f"/api/admin/agent-profiles/{mine['id']}",
        headers=headers(USER_ID),
        json={"visibility": "organization", "group_ids": _user_group_ids()},
    )
    # visibility/group_ids are stripped, leaving nothing but a no-op edit.
    assert updated.status_code == 400
    assert get_store().models[mine["id"]].visibility == "private"
    assert get_store().models[mine["id"]].group_ids == []


def test_granted_user_deletes_own_agent() -> None:
    _set_ceiling(True)
    _grant_authoring(True)
    mine = client.post(
        "/api/admin/agent-profiles", headers=headers(USER_ID), json=_create_body("Mine")
    ).json()
    resp = client.delete(f"/api/admin/agent-profiles/{mine['id']}", headers=headers(USER_ID))
    assert resp.status_code == 200
    assert mine["id"] not in get_store().models


def test_admins_and_owners_are_unaffected_by_the_ceiling() -> None:
    _set_ceiling(False)
    _grant_authoring(False)
    for actor in (ADMIN_ID, OWNER_ID):
        resp = client.post(
            "/api/admin/agent-profiles", headers=headers(actor), json=_create_body(f"By {actor}")
        )
        assert resp.status_code == 201, (actor, resp.json())
        assert resp.json()["visibility"] != "private"


def test_group_rows_written_before_a_permission_existed_still_load() -> None:
    """Regression: adding a group permission must not brick an existing deployment.

    Rows persisted before a permission key existed omit it. The identity/config
    SQL authority compares stored payloads against the canonical model dump, so
    the loader backfills platform defaults for missing keys instead of failing
    startup with "Stored groups payload is not canonical."
    """
    from app.models.schemas import DEFAULT_GROUP_PERMISSIONS, Group
    from app.repositories.identity_config_sql import _model_from_payload

    store = get_store()
    group = next(iter(store.groups.values()))
    legacy_payload = group.model_dump(mode="json")
    legacy_payload["permissions"] = {
        key: value
        for key, value in legacy_payload["permissions"].items()
        if key != "agent_authoring"
    }
    assert "agent_authoring" not in legacy_payload["permissions"]

    loaded = _model_from_payload(Group, legacy_payload, "groups")

    assert isinstance(loaded, Group)
    # Backfilled to the platform default, which keeps the capability off.
    assert loaded.permissions["agent_authoring"] is False
    assert loaded.permissions["agent_authoring"] == DEFAULT_GROUP_PERMISSIONS["agent_authoring"]


def test_unknown_stored_group_permission_is_still_rejected() -> None:
    """The backfill must not turn into a blanket accept of arbitrary payloads."""
    from app.models.schemas import Group
    from app.repositories.identity_config_sql import (
        IdentityConfigCorruptionError,
        _model_from_payload,
    )

    store = get_store()
    group = next(iter(store.groups.values()))
    payload = group.model_dump(mode="json")
    payload["permissions"] = {**payload["permissions"], "not_a_real_permission": True}

    with pytest.raises(IdentityConfigCorruptionError):
        _model_from_payload(Group, payload, "groups")
