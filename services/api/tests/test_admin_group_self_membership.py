"""A tenant admin may join or leave only the groups they created themselves.

Adding any other administrator to a group stays reserved for the platform
owner, exactly as before; these tests pin both sides of that boundary.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.policy import can_self_join_group
from app.main import app
from app.models.schemas import Group, Role, User
from app.repositories.deps import get_store
from app.repositories.identity_config_sql import IdentityConfigCorruptionError, _model_from_payload

client = TestClient(app)

NOT_CREATOR = "You can add yourself only to groups you created."
OWNER_NOT_MEMBER = "Platform owners are not group members."


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def create_group(actor_id: str, group_id: str, **extra: object):
    return client.post(
        "/api/admin/groups",
        json={"id": group_id, "name": group_id.replace("-", " ").title(), **extra},
        headers=headers(actor_id),
    )


def set_membership(actor_headers: dict[str, str], group_id: str, member: bool):
    return client.put(
        f"/api/admin/groups/{group_id}/membership/me",
        json={"member": member},
        headers=actor_headers,
    )


def _user(role: Role, *, user_id: str = "user-x", tenant_id: str | None = "tenant-a") -> User:
    return User(
        id=user_id,
        tenant_id=tenant_id,
        email=f"{user_id}@example.com",
        display_name=user_id,
        role=role,
    )


def _group(*, created_by: str | None, tenant_id: str = "tenant-a") -> Group:
    return Group(
        id="group-x",
        tenant_id=tenant_id,
        name="X",
        distinguished_name="Platform-managed group",
        entra_object_id="platform-group-x",
        created_by_user_id=created_by,
    )


def test_policy_allows_only_the_creating_tenant_admin_in_their_tenant() -> None:
    admin = _user(Role.TENANT_ADMIN)
    assert can_self_join_group(admin, _group(created_by="user-x")) is True
    assert can_self_join_group(admin, _group(created_by="user-other")) is False
    assert can_self_join_group(admin, _group(created_by=None)) is False
    assert can_self_join_group(admin, _group(created_by="user-x", tenant_id="tenant-b")) is False
    owner = _user(Role.PLATFORM_OWNER, tenant_id=None)
    assert can_self_join_group(owner, _group(created_by="user-x")) is False
    regular = _user(Role.POWER_USER)
    assert can_self_join_group(regular, _group(created_by="user-x")) is False


def test_creating_groups_records_the_creator_and_seeded_groups_have_none() -> None:
    single = create_group("user-admin", "group-mine")
    assert single.status_code == 201
    assert single.json()["created_by_user_id"] == "user-admin"

    bulk = client.post(
        "/api/admin/groups/bulk",
        json={"groups": [{"name": "Bulk One"}, {"name": "Bulk Two"}]},
        headers=headers("user-drew"),
    )
    assert bulk.status_code == 201
    assert [group["created_by_user_id"] for group in bulk.json()] == ["user-drew", "user-drew"]

    listed = {group["id"]: group for group in client.get(
        "/api/admin/groups", headers=headers("user-admin")
    ).json()}
    assert listed["group-mine"]["created_by_user_id"] == "user-admin"
    assert listed["group-litigation"]["created_by_user_id"] is None
    # Creating a group never makes the creator a member unless they ask.
    assert "group-mine" not in get_store().users["user-admin"].group_ids


def test_add_me_puts_the_creating_admin_in_the_new_group() -> None:
    before = list(get_store().users["user-admin"].group_ids)
    created = create_group("user-admin", "group-joined", add_me=True)
    assert created.status_code == 201
    assert get_store().users["user-admin"].group_ids == [*before, "group-joined"]
    assert "add_me" not in created.json()
    created_events = {
        event.target: event.metadata["creator_joined"]
        for event in get_store().audit_events
        if event.action == "admin.group_created"
    }
    assert created_events["group-joined"] is True

    bulk = client.post(
        "/api/admin/groups/bulk",
        json={"groups": [{"id": "group-b1", "name": "B1", "add_me": True}, {"id": "group-b2", "name": "B2"}]},
        headers=headers("user-admin"),
    )
    assert bulk.status_code == 201
    group_ids = get_store().users["user-admin"].group_ids
    assert "group-b1" in group_ids and "group-b2" not in group_ids
    created_events = {
        event.target: event.metadata["creator_joined"]
        for event in get_store().audit_events
        if event.action == "admin.group_created"
    }
    assert created_events["group-b2"] is False


def test_platform_owner_cannot_ask_to_join_a_group_they_create() -> None:
    created = client.post(
        "/api/admin/groups",
        json={"id": "group-owner-made", "name": "Owner Made", "tenant_id": "tenant-example", "add_me": True},
        headers=headers("user-owner"),
    )
    assert created.status_code == 400
    assert created.json()["detail"] == OWNER_NOT_MEMBER
    assert "group-owner-made" not in get_store().groups

    plain = client.post(
        "/api/admin/groups",
        json={"id": "group-owner-made", "name": "Owner Made", "tenant_id": "tenant-example"},
        headers=headers("user-owner"),
    )
    assert plain.status_code == 201
    assert plain.json()["created_by_user_id"] == "user-owner"


def test_admin_joins_and_leaves_own_group_and_keeps_the_current_session() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    token, _ = store.issue_session_token_for_user(admin, get_settings().secret_key, 3600)
    session = {"x-aperture-session": token}
    assert create_group("user-admin", "group-self").status_code == 201
    cutoff_before = store.session_issued_before_ms.get(admin.id)
    audits_before = len(store.audit_events)

    joined = set_membership(session, "group-self", True)
    assert joined.status_code == 200
    assert joined.json()["id"] == "user-admin"
    assert joined.json()["group_ids"] == ["group-litigation", "group-finance", "group-self"]
    # Joining is a grant the actor made for themselves: the session that made
    # the request, and the admin's other sessions, stay signed in.
    assert store.session_issued_before_ms.get(admin.id) == cutoff_before
    assert client.get("/api/bootstrap", headers=session).status_code == 200

    again = set_membership(session, "group-self", True)
    assert again.status_code == 200
    assert again.json()["group_ids"].count("group-self") == 1

    left = set_membership(session, "group-self", False)
    assert left.status_code == 200
    assert left.json()["group_ids"] == ["group-litigation", "group-finance"]
    assert set_membership(session, "group-self", False).json()["group_ids"] == [
        "group-litigation",
        "group-finance",
    ]
    assert client.get("/api/bootstrap", headers=session).status_code == 200

    events = [
        (event.action, event.target, event.metadata)
        for event in store.audit_events[audits_before:]
        if event.action == "admin.group_self_membership"
    ]
    assert events == [
        ("admin.group_self_membership", "group-self", {"member": True}),
        ("admin.group_self_membership", "group-self", {"member": False}),
    ]


def test_admin_cannot_join_a_group_someone_else_or_the_system_created() -> None:
    assert create_group("user-drew", "group-drews").status_code == 201
    for group_id in ("group-drews", "group-litigation"):
        response = set_membership(headers("user-admin"), group_id, True)
        assert response.status_code == 403
        assert response.json()["detail"] == NOT_CREATOR
    assert "group-drews" not in get_store().users["user-admin"].group_ids

    leave_seeded = set_membership(headers("user-admin"), "group-litigation", False)
    assert leave_seeded.status_code == 403
    assert "group-litigation" in get_store().users["user-admin"].group_ids


def test_owner_regular_user_and_unknown_group_are_refused() -> None:
    assert create_group("user-owner", "group-by-owner", tenant_id="tenant-example").status_code == 201
    owner = set_membership(headers("user-owner"), "group-by-owner", True)
    assert owner.status_code == 403
    assert owner.json()["detail"] == OWNER_NOT_MEMBER

    assert create_group("user-admin", "group-for-jane").status_code == 201
    regular = set_membership(headers("user-jane"), "group-for-jane", True)
    assert regular.status_code == 403
    assert "group-for-jane" not in get_store().users["user-jane"].group_ids

    assert set_membership(headers("user-admin"), "group-missing", True).status_code == 404


def test_patching_admin_group_ids_stays_reserved_for_the_platform_owner() -> None:
    assert create_group("user-admin", "group-reserved").status_code == 201
    for target in ("user-drew", "user-admin"):
        response = client.patch(
            f"/api/admin/users/{target}",
            json={"group_ids": ["group-reserved"]},
            headers=headers("user-admin"),
        )
        assert response.status_code == 403
    owner = client.patch(
        "/api/admin/users/user-drew",
        json={"group_ids": ["group-reserved"]},
        headers=headers("user-owner"),
    )
    assert owner.status_code == 200


def test_groups_saved_before_creators_were_recorded_still_load() -> None:
    legacy = _group(created_by=None).model_dump(mode="json")
    legacy.pop("created_by_user_id")
    loaded = _model_from_payload(Group, legacy, "groups")
    assert loaded.created_by_user_id is None

    noncanonical = dict(legacy)
    noncanonical.pop("synced")
    with pytest.raises(IdentityConfigCorruptionError):
        _model_from_payload(Group, noncanonical, "groups")


def test_a_reused_admin_id_does_not_inherit_self_join_on_the_deleted_admins_groups() -> None:
    assert create_group("user-drew", "group-drew-made").status_code == 201
    assert create_group("user-admin", "group-alex-made").status_code == 201
    deleted = client.delete("/api/admin/users/user-drew", headers=headers("user-owner"))
    assert deleted.status_code == 200
    store = get_store()
    assert store.groups["group-drew-made"].created_by_user_id is None
    assert store.groups["group-alex-made"].created_by_user_id == "user-admin"

    recreated = client.post(
        "/api/admin/users",
        json={
            "id": "user-drew",
            "email": "new.drew@example.com",
            "display_name": "New Drew",
            "role": "TENANT_ADMIN",
            "tenant_id": "tenant-example",
            "group_ids": [],
        },
        headers=headers("user-owner"),
    )
    assert recreated.status_code == 201
    response = set_membership(headers("user-drew"), "group-drew-made", True)
    assert response.status_code == 403
    assert response.json()["detail"] == NOT_CREATOR


def test_add_me_refuses_an_actor_that_changed_after_authorization(monkeypatch) -> None:
    store = get_store()
    admin = store.users["user-admin"]
    real_lock = store._store_lock

    class DemoteOnEnter:
        def __enter__(self):
            real_lock.__enter__()
            admin.role = Role.USER
            return self

        def __exit__(self, *exc):
            return real_lock.__exit__(*exc)

    monkeypatch.setattr(store, "_store_lock", DemoteOnEnter())
    created = create_group("user-admin", "group-stale", add_me=True)
    monkeypatch.setattr(store, "_store_lock", real_lock)
    admin.role = Role.TENANT_ADMIN
    assert created.status_code == 403
    assert "group-stale" not in store.groups
    assert "group-stale" not in admin.group_ids
