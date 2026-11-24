"""An "Only me" audience on MCP tool connections.

A tenant admin (or the platform owner) can keep a connection to themselves
instead of sharing it with groups or the whole workspace. Another tenant
admin never sees it: every listing, lookup, and run treats it as absent (404,
never 403, so its existence does not leak). Platform owners still see and
manage every connection.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.policy import tool_access_allowed, tool_config_visible_to
from app.main import app
from app.models.schemas import ToolConfig
from app.repositories.deps import get_store
from app.routes.chat import _resolve_usable_tool_configs

client = TestClient(app)

ADMIN_A = "user-admin"
ADMIN_B = "user-drew"
OWNER = "user-owner"
USER = "user-jane"
OTHER_USER = "user-casey"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _create(user_id: str, **overrides: object):
    body: dict[str, object] = {
        "name": "My Notes MCP",
        "tool_type": "mcp",
        "endpoint_url": "https://mcp.example.com/mcp",
        "enabled": True,
        "approval_required": True,
        "allowed_group_ids": [],
        "settings": {"transport": "http"},
        "only_me": True,
    }
    body.update(overrides)
    return client.post("/api/admin/tool-configs", headers=headers(user_id), json=body)


def _create_only_me(user_id: str = ADMIN_A) -> dict:
    created = _create(user_id)
    assert created.status_code == 201, created.text
    return created.json()


def _tool_ids(path: str, user_id: str, key: str | None = None) -> set[str]:
    response = client.get(path, headers=headers(user_id))
    assert response.status_code == 200, response.text
    body = response.json()
    return {tool["id"] for tool in (body[key] if key else body)}


def _listed_ids(user_id: str) -> set[str]:
    return _tool_ids("/api/admin/tool-configs", user_id)


def _bootstrap_tool_ids(user_id: str) -> set[str]:
    return _tool_ids("/api/bootstrap", user_id, "toolConfigs")


# --- Creating -----------------------------------------------------------------


def test_admin_creates_an_only_me_tool_owned_by_them() -> None:
    tool = _create_only_me()
    assert tool["only_me"] is True
    assert tool["owner_user_id"] == ADMIN_A
    assert tool["allowed_group_ids"] == []


def test_tools_default_to_not_only_me() -> None:
    plain = client.post(
        "/api/admin/tool-configs",
        headers=headers(ADMIN_A),
        json={"name": "Shared", "tool_type": "mcp", "settings": {"transport": "http"}},
    )
    assert plain.status_code == 201, plain.text
    assert plain.json()["only_me"] is False
    assert plain.json()["owner_user_id"] is None


def test_only_me_cannot_also_be_shared_with_groups() -> None:
    response = _create(ADMIN_A, allowed_group_ids=["group-litigation"])
    assert response.status_code == 400
    assert response.json()["detail"] == "Only me connections can't also be shared with groups."


def test_platform_owner_can_create_an_only_me_tool() -> None:
    created = _create(OWNER, tenant_id="tenant-example")
    assert created.status_code == 201, created.text
    tool = created.json()
    assert tool["only_me"] is True
    assert tool["owner_user_id"] == OWNER
    assert tool["id"] not in _listed_ids(ADMIN_A)


def test_regular_user_cannot_choose_only_me() -> None:
    store = get_store()
    for group_id in store.users[USER].group_ids:
        store.groups[group_id].permissions["tool_authoring"] = True
    response = _create(USER)
    assert response.status_code == 403
    assert "Only me" in response.json()["detail"]
    # Their ordinary private connection still works exactly as before.
    plain = _create(USER, only_me=False)
    assert plain.status_code == 201, plain.text
    assert plain.json()["owner_user_id"] == USER
    assert plain.json()["only_me"] is False
    mine = plain.json()["id"]
    toggled = client.patch(
        f"/api/admin/tool-configs/{mine}", headers=headers(USER), json={"only_me": True}
    )
    assert toggled.status_code == 403
    assert get_store().tool_configs[mine].only_me is False


# --- Who sees and manages it ----------------------------------------------------


def test_other_admins_do_not_see_it_but_owner_and_platform_owner_do() -> None:
    tool_id = _create_only_me()["id"]
    assert tool_id in _listed_ids(ADMIN_A)
    assert tool_id in _listed_ids(OWNER)
    assert tool_id not in _listed_ids(ADMIN_B)
    assert tool_id in _bootstrap_tool_ids(ADMIN_A)
    assert tool_id not in _bootstrap_tool_ids(ADMIN_B)
    assert tool_id not in _bootstrap_tool_ids(OTHER_USER)


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("patch", "/api/admin/tool-configs/{id}", {"name": "Taken over"}),
        ("delete", "/api/admin/tool-configs/{id}", None),
        ("delete", "/api/admin/tool-configs/{id}/secret", None),
        ("get", "/api/tools/{id}/oauth/authorize-url", None),
        ("delete", "/api/tools/{id}/oauth/token", None),
        ("post", "/api/tools/{id}/approve", None),
        ("post", "/api/tools/{id}/mcp/health", None),
        ("post", "/api/tools/{id}/mcp/call", {"tool_name": "search", "arguments": {}}),
        ("post", "/api/tools/{id}/run-script", {"input": ""}),
    ],
)
def test_another_admin_gets_not_found_everywhere(method: str, path: str, body: dict | None) -> None:
    tool_id = _create_only_me()["id"]
    before = get_store().tool_configs[tool_id].model_dump()
    kwargs: dict[str, object] = {"headers": headers(ADMIN_B)}
    if body is not None:
        kwargs["json"] = body
    response = getattr(client, method)(path.format(id=tool_id), **kwargs)
    assert response.status_code == 404, response.text
    assert get_store().tool_configs[tool_id].model_dump() == before


def test_owner_and_platform_owner_manage_it() -> None:
    tool_id = _create_only_me()["id"]
    renamed = client.patch(
        f"/api/admin/tool-configs/{tool_id}", headers=headers(ADMIN_A), json={"name": "Mine"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["only_me"] is True
    by_owner = client.patch(
        f"/api/admin/tool-configs/{tool_id}", headers=headers(OWNER), json={"name": "Checked"}
    )
    assert by_owner.status_code == 200, by_owner.text
    assert by_owner.json()["owner_user_id"] == ADMIN_A
    deleted = client.delete(f"/api/admin/tool-configs/{tool_id}", headers=headers(OWNER))
    assert deleted.status_code == 200
    assert tool_id not in get_store().tool_configs


def test_another_admin_cannot_attach_it_to_an_agent_profile() -> None:
    tool_id = _create_only_me()["id"]
    store = get_store()
    model = next(m for m in store.models.values() if m.platform_enabled and m.upstream_model_id)
    body = {
        "name": "Borrowed tools",
        "provider_id": model.provider_id,
        "upstream_model_id": model.upstream_model_id,
        "system_prompt": "Be helpful.",
        "is_custom": True,
        "tool_config_ids": [tool_id],
    }
    response = client.post("/api/admin/agent-profiles", headers=headers(ADMIN_B), json=body)
    assert response.status_code == 404, response.text
    own = client.post("/api/admin/agent-profiles", headers=headers(ADMIN_A), json=body)
    assert own.status_code == 201, own.text


# --- Who can run it -----------------------------------------------------------


def test_only_the_owner_resolves_it_for_chat() -> None:
    tool_id = _create_only_me()["id"]
    store = get_store()
    usable, skipped = _resolve_usable_tool_configs(store, store.users[ADMIN_A], [tool_id])
    assert [tool.id for tool in usable] == [tool_id]
    assert skipped == []
    for user_id in (ADMIN_B, OTHER_USER):
        usable, skipped = _resolve_usable_tool_configs(store, store.users[user_id], [tool_id])
        assert usable == []
        assert skipped == [tool_id]


def _only_me_config(**overrides: object) -> ToolConfig:
    fields: dict[str, object] = {
        "id": "tool-private",
        "tenant_id": "tenant-example",
        "name": "Private",
        "tool_type": "mcp",
        "only_me": True,
        "owner_user_id": ADMIN_A,
    }
    fields.update(overrides)
    return ToolConfig(**fields)


def test_policy_matrix_for_only_me_tools() -> None:
    store = get_store()
    config = _only_me_config()
    expected = {ADMIN_A: True, OWNER: True, ADMIN_B: False, USER: False, OTHER_USER: False}
    for user_id, allowed in expected.items():
        user = store.users[user_id]
        assert tool_config_visible_to(user, config) is allowed, user_id
        assert tool_access_allowed(user, config) is allowed, user_id
    assert tool_access_allowed(store.users[ADMIN_A], _only_me_config(enabled=False)) is False


def test_a_users_private_tool_still_reaches_its_author_and_admins() -> None:
    store = get_store()
    private = _only_me_config(only_me=False, owner_user_id=USER)
    expected = {USER: True, OTHER_USER: False, ADMIN_A: True}
    for user_id, allowed in expected.items():
        assert tool_access_allowed(store.users[user_id], private) is allowed, user_id


def test_workspace_payload_keeps_its_existing_private_tool_rule() -> None:
    store = get_store()
    for tool_id, owner, groups in (
        ("tool-workspace", None, []),
        ("tool-janes-private", USER, []),
        ("tool-janes-shared", USER, ["group-litigation"]),
    ):
        store.tool_configs[tool_id] = ToolConfig(
            id=tool_id,
            tenant_id="tenant-example",
            name=tool_id,
            tool_type="webhook",
            owner_user_id=owner,
            allowed_group_ids=groups,
        )
    store.users[OTHER_USER].group_ids = ["group-litigation"]
    seen_by_casey = _bootstrap_tool_ids(OTHER_USER)
    assert {"tool-workspace", "tool-janes-shared"} <= seen_by_casey
    assert "tool-janes-private" not in seen_by_casey
    assert "tool-janes-private" in _bootstrap_tool_ids(USER)
    assert "tool-janes-private" in _bootstrap_tool_ids(ADMIN_A)


def test_visibility_of_ordinary_tools_is_unchanged() -> None:
    store = get_store()
    workspace = _only_me_config(only_me=False, owner_user_id=None)
    other_tenant = _only_me_config(only_me=False, owner_user_id=None, tenant_id="tenant-other")
    for user_id in (ADMIN_A, ADMIN_B, USER, OWNER):
        assert tool_config_visible_to(store.users[user_id], workspace) is True
    assert tool_config_visible_to(store.users[ADMIN_B], other_tenant) is False
    assert tool_config_visible_to(store.users[OWNER], other_tenant) is True


# --- Turning it on and off ----------------------------------------------------


def test_turning_only_me_off_returns_to_workspace_or_group_semantics() -> None:
    tool_id = _create_only_me()["id"]
    opened = client.patch(
        f"/api/admin/tool-configs/{tool_id}", headers=headers(ADMIN_A), json={"only_me": False}
    )
    assert opened.status_code == 200, opened.text
    assert opened.json()["only_me"] is False
    assert opened.json()["owner_user_id"] is None
    assert tool_id in _listed_ids(ADMIN_B)
    store = get_store()
    assert tool_access_allowed(store.users[OTHER_USER], store.tool_configs[tool_id]) is True

    closed = client.patch(
        f"/api/admin/tool-configs/{tool_id}", headers=headers(ADMIN_A), json={"only_me": True}
    )
    assert closed.status_code == 200, closed.text
    assert closed.json()["owner_user_id"] == ADMIN_A
    grouped = client.patch(
        f"/api/admin/tool-configs/{tool_id}",
        headers=headers(ADMIN_A),
        json={"only_me": False, "allowed_group_ids": ["group-litigation"]},
    )
    assert grouped.status_code == 200, grouped.text
    assert grouped.json()["allowed_group_ids"] == ["group-litigation"]
    assert grouped.json()["owner_user_id"] is None


NOT_CREATOR = "You can make a connection Only me only if you created it."


def test_only_the_creator_turns_a_shared_connection_into_only_me() -> None:
    created = _create(ADMIN_B, only_me=False, allowed_group_ids=["group-litigation"])
    assert created.status_code == 201, created.text
    assert created.json()["created_by_user_id"] == ADMIN_B
    tool_id = created.json()["id"]
    takeover = client.patch(
        f"/api/admin/tool-configs/{tool_id}", headers=headers(ADMIN_A), json={"only_me": True}
    )
    assert takeover.status_code == 403
    assert takeover.json()["detail"] == NOT_CREATOR
    assert get_store().tool_configs[tool_id].owner_user_id is None
    private = client.patch(
        f"/api/admin/tool-configs/{tool_id}", headers=headers(ADMIN_B), json={"only_me": True}
    )
    assert private.status_code == 200, private.text
    assert private.json()["allowed_group_ids"] == []
    assert private.json()["owner_user_id"] == ADMIN_B
    assert tool_id not in _listed_ids(ADMIN_A)
    events = [
        event
        for event in get_store().audit_events_newest_first()
        if event.target == tool_id and event.action == "admin.tool_config_updated"
    ]
    assert events[0].metadata["owner_user_id"] == ADMIN_B
    assert events[0].metadata["cleared_group_ids"] == ["group-litigation"]


def _legacy_shared_tool(tool_id: str = "tool-legacy-shared", created_by: str | None = None) -> str:
    get_store().tool_configs[tool_id] = ToolConfig(
        id=tool_id,
        tenant_id="tenant-example",
        name="Legacy shared",
        tool_type="mcp",
        created_by_user_id=created_by,
    )
    return tool_id


def test_a_connection_with_no_known_creator_cannot_be_made_only_me_by_an_admin() -> None:
    tool_id = _legacy_shared_tool()
    response = client.patch(
        f"/api/admin/tool-configs/{tool_id}", headers=headers(ADMIN_A), json={"only_me": True}
    )
    assert response.status_code == 403
    assert response.json()["detail"] == NOT_CREATOR
    assert get_store().tool_configs[tool_id].only_me is False


def test_platform_owner_makes_any_connection_only_me_for_its_creator_or_itself() -> None:
    legacy = _legacy_shared_tool()
    known = _legacy_shared_tool("tool-made-by-b", created_by=ADMIN_B)
    for tool_id, expected_owner in ((legacy, OWNER), (known, ADMIN_B)):
        response = client.patch(
            f"/api/admin/tool-configs/{tool_id}", headers=headers(OWNER), json={"only_me": True}
        )
        assert response.status_code == 200, response.text
        assert response.json()["owner_user_id"] == expected_owner


def test_groups_and_only_me_conflict_on_update() -> None:
    tool_id = _create_only_me()["id"]
    both = client.patch(
        f"/api/admin/tool-configs/{tool_id}",
        headers=headers(ADMIN_A),
        json={"allowed_group_ids": ["group-litigation"]},
    )
    assert both.status_code == 400
    assert both.json()["detail"] == "Only me connections can't also be shared with groups."
    plain = _create(ADMIN_A, only_me=False)
    explicit = client.patch(
        f"/api/admin/tool-configs/{plain.json()['id']}",
        headers=headers(ADMIN_A),
        json={"only_me": True, "allowed_group_ids": ["group-litigation"]},
    )
    assert explicit.status_code == 400
    assert get_store().tool_configs[tool_id].allowed_group_ids == []


def test_admin_cannot_make_someone_elses_connection_only_me() -> None:
    store = get_store()
    store.tool_configs["tool-janes"] = ToolConfig(
        id="tool-janes",
        tenant_id="tenant-example",
        name="Jane's",
        tool_type="mcp",
        owner_user_id=USER,
    )
    response = client.patch(
        "/api/admin/tool-configs/tool-janes", headers=headers(ADMIN_A), json={"only_me": True}
    )
    assert response.status_code == 403
    assert store.tool_configs["tool-janes"].only_me is False


# --- Persistence and lifecycle ------------------------------------------------


def test_only_me_never_has_group_shares() -> None:
    with pytest.raises(ValidationError):
        _only_me_config(allowed_group_ids=["group-litigation"])
    # An Only me tool whose owner was deleted keeps no owner: nobody but a
    # platform owner can see it.
    orphan = _only_me_config(owner_user_id=None, enabled=False)
    assert tool_config_visible_to(get_store().users[ADMIN_A], orphan) is False
    assert tool_config_visible_to(get_store().users[OWNER], orphan) is True


def test_legacy_tool_rows_load_as_not_only_me() -> None:
    from app.repositories.identity_config_sql import _model_from_payload

    legacy_payload = _only_me_config(only_me=False, owner_user_id=None).model_dump(mode="json")
    del legacy_payload["only_me"]
    loaded = _model_from_payload(ToolConfig, legacy_payload, "tool_configs")
    assert isinstance(loaded, ToolConfig)
    assert loaded.only_me is False


def test_only_me_round_trips_through_stored_payloads() -> None:
    from app.repositories.identity_config_sql import _model_from_payload

    tool_id = _create_only_me()["id"]
    stored = get_store().tool_configs[tool_id].model_dump(mode="json")
    reloaded = _model_from_payload(ToolConfig, stored, "tool_configs")
    assert isinstance(reloaded, ToolConfig)
    assert reloaded.only_me is True
    assert reloaded.owner_user_id == ADMIN_A


def test_turning_off_a_demoted_owners_tool_keeps_it_private_to_them() -> None:
    from app.models.schemas import Role

    tool_id = _create_only_me()["id"]
    get_store().users[ADMIN_A].role = Role.USER
    opened = client.patch(
        f"/api/admin/tool-configs/{tool_id}", headers=headers(OWNER), json={"only_me": False}
    )
    assert opened.status_code == 200, opened.text
    assert opened.json()["only_me"] is False
    assert opened.json()["owner_user_id"] == ADMIN_A


def test_deleted_owner_leaves_the_tool_off_and_to_platform_owners_only() -> None:
    tool_id = _create_only_me()["id"]
    shared_id = _create(ADMIN_A, only_me=False).json()["id"]
    store = get_store()
    former = store.users[ADMIN_A].model_copy()
    deleted = client.delete(f"/api/admin/users/{ADMIN_A}", headers=headers(OWNER))
    assert deleted.status_code == 200, deleted.text
    orphan = store.tool_configs[tool_id]
    assert (orphan.only_me, orphan.owner_user_id, orphan.enabled) == (True, None, False)
    assert store.tool_configs[shared_id].created_by_user_id is None
    assert tool_id in _listed_ids(OWNER)
    assert tool_id not in _listed_ids(ADMIN_B)
    # A later account that reuses the id inherits nothing.
    store.users[ADMIN_A] = former
    assert tool_id not in _listed_ids(ADMIN_A)
    usable, _ = _resolve_usable_tool_configs(store, former, [tool_id])
    assert usable == []
    reclaim = client.patch(
        f"/api/admin/tool-configs/{shared_id}", headers=headers(ADMIN_A), json={"only_me": True}
    )
    assert reclaim.status_code == 403


def test_deleting_someone_else_leaves_an_only_me_tool_alone() -> None:
    tool_id = _create_only_me()["id"]
    deleted = client.delete(f"/api/admin/users/{OTHER_USER}", headers=headers(OWNER))
    assert deleted.status_code == 200, deleted.text
    tool = get_store().tool_configs[tool_id]
    assert (tool.owner_user_id, tool.enabled) == (ADMIN_A, True)


# --- Audit trail and agent profiles -------------------------------------------


def _audit_targets(user_id: str) -> set[str]:
    response = client.get("/api/admin/audit-events?limit=1000", headers=headers(user_id))
    assert response.status_code == 200, response.text
    return {event["target"] for event in response.json()}


def test_other_admins_do_not_see_audit_events_for_an_only_me_tool() -> None:
    tool_id = _create_only_me()["id"]
    client.patch(f"/api/admin/tool-configs/{tool_id}", headers=headers(ADMIN_A), json={"name": "Renamed"})
    shared_id = _create(ADMIN_A, only_me=False).json()["id"]
    assert tool_id not in _audit_targets(ADMIN_B)
    assert shared_id in _audit_targets(ADMIN_B)
    assert tool_id in _audit_targets(ADMIN_A)
    assert tool_id in _audit_targets(OWNER)


def test_tenant_admins_still_see_only_their_own_tenants_events() -> None:
    store = get_store()
    outsider = store.users[ADMIN_B].model_copy(update={"id": "user-outsider", "tenant_id": "tenant-other"})
    store.record_audit(outsider, "admin.tool_config_created", "tool-elsewhere", {})
    assert "tool-elsewhere" not in _audit_targets(ADMIN_B)


def _profile_body(tool_ids: list[str]) -> dict[str, object]:
    store = get_store()
    model = next(m for m in store.models.values() if m.platform_enabled and m.upstream_model_id)
    return {
        "name": "Shared agent",
        "provider_id": model.provider_id,
        "upstream_model_id": model.upstream_model_id,
        "system_prompt": "Be helpful.",
        "is_custom": True,
        "tool_config_ids": tool_ids,
    }


def test_another_admin_edits_a_profile_without_seeing_or_dropping_an_only_me_tool() -> None:
    tool_id = _create_only_me()["id"]
    created = client.post("/api/admin/agent-profiles", headers=headers(ADMIN_A), json=_profile_body([tool_id]))
    assert created.status_code == 201, created.text
    profile_id = created.json()["id"]
    path = f"/api/admin/agent-profiles/{profile_id}"
    renamed = client.patch(path, headers=headers(ADMIN_B), json={"name": "Renamed"})
    assert renamed.status_code == 200, renamed.text
    shared_id = _create(ADMIN_B, only_me=False).json()["id"]
    saved = client.patch(path, headers=headers(ADMIN_B), json={"tool_config_ids": [shared_id]})
    assert saved.status_code == 200, saved.text
    assert saved.json()["tool_config_ids"] == [shared_id, tool_id]
    cleared = client.patch(path, headers=headers(ADMIN_A), json={"tool_config_ids": []})
    assert cleared.json()["tool_config_ids"] == []
