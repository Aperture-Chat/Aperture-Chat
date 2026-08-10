"""User-created knowledge bases and tools sit behind tenant group grants.

The knowledge_authoring and tool_authoring group permissions are off by
default: standard users cannot create either record type until a tenant admin
grants the permission (surfaced as the Policy Controls toggles in the admin
console). Granted users author private, self-owned records; group sharing and
tenant-wide management stay admin-only.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)

USER_ID = "user-jane"
ADMIN_ID = "user-admin"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _grant(permission: str, enabled: bool) -> None:
    store = get_store()
    for group_id in store.users[USER_ID].group_ids:
        store.groups[group_id].permissions[permission] = enabled


def _kb_body(name: str = "My Research") -> dict[str, object]:
    return {"name": name, "source_type": "upload"}


def _tool_body(name: str = "My Tool") -> dict[str, object]:
    return {"name": name, "tool_type": "mcp", "endpoint_url": "https://mcp.example.com/sse"}


def test_ungranted_user_cannot_create_knowledge_or_tools() -> None:
    for path, body, phrase in (
        ("/api/admin/knowledge-configs", _kb_body(), "knowledge bases"),
        ("/api/admin/tool-configs", _tool_body(), "tools"),
    ):
        resp = client.post(path, headers=headers(USER_ID), json=body)
        assert resp.status_code == 403
        assert phrase in resp.json()["detail"]
        assert "tenant policy" in resp.json()["detail"]


def test_granted_user_creates_private_self_owned_knowledge_base() -> None:
    _grant("knowledge_authoring", True)
    body = _kb_body() | {
        # Sharing, ownership, and tenant cannot be spoofed through the payload.
        "acl_group_ids": list(get_store().users[USER_ID].group_ids),
        "owner_user_id": ADMIN_ID,
        "tenant_id": "tenant-other",
    }
    resp = client.post("/api/admin/knowledge-configs", headers=headers(USER_ID), json=body)
    assert resp.status_code == 201, resp.json()
    created = resp.json()
    assert created["owner_user_id"] == USER_ID
    assert created["acl_group_ids"] == []
    assert created["tenant_id"] == get_store().users[USER_ID].tenant_id


def test_granted_user_manages_own_knowledge_content_but_not_others() -> None:
    _grant("knowledge_authoring", True)
    created = client.post(
        "/api/admin/knowledge-configs", headers=headers(USER_ID), json=_kb_body()
    ).json()

    indexed = client.post(
        f"/api/knowledge/{created['id']}/web-sources",
        headers=headers(USER_ID),
        json={
            "url": "https://example.com/notes",
            "name": "Notes",
            "text": "Operator-provided reference text.",
        },
    )
    assert indexed.status_code == 200, indexed.json()

    admin_kb = client.post(
        "/api/admin/knowledge-configs", headers=headers(ADMIN_ID), json=_kb_body("Admin KB")
    ).json()
    blocked = client.post(
        f"/api/knowledge/{admin_kb['id']}/web-sources",
        headers=headers(USER_ID),
        json={"url": "https://example.com/x", "name": "X", "text": "nope"},
    )
    assert blocked.status_code == 403
    assert "owner" in blocked.json()["detail"]

    # The user deletes their own knowledge base but not the admin's.
    assert (
        client.delete(
            f"/api/admin/knowledge-configs/{created['id']}", headers=headers(USER_ID)
        ).status_code
        == 200
    )
    assert (
        client.delete(
            f"/api/admin/knowledge-configs/{admin_kb['id']}", headers=headers(USER_ID)
        ).status_code
        == 403
    )


def test_revoking_the_grant_freezes_existing_knowledge_bases() -> None:
    _grant("knowledge_authoring", True)
    created = client.post(
        "/api/admin/knowledge-configs", headers=headers(USER_ID), json=_kb_body()
    ).json()
    _grant("knowledge_authoring", False)
    blocked = client.post(
        f"/api/knowledge/{created['id']}/web-sources",
        headers=headers(USER_ID),
        json={"url": "https://example.com/y", "name": "Y", "text": "frozen"},
    )
    assert blocked.status_code == 403


def test_granted_user_creates_private_self_owned_tool() -> None:
    _grant("tool_authoring", True)
    body = _tool_body() | {
        "allowed_group_ids": list(get_store().users[USER_ID].group_ids),
        "tenant_id": "tenant-other",
    }
    resp = client.post("/api/admin/tool-configs", headers=headers(USER_ID), json=body)
    assert resp.status_code == 201, resp.json()
    created = resp.json()
    assert created["owner_user_id"] == USER_ID
    assert created["allowed_group_ids"] == []
    assert created["tenant_id"] == get_store().users[USER_ID].tenant_id

    # The author manages their own tool; an admin-created tool stays locked.
    assert (
        client.delete(
            f"/api/admin/tool-configs/{created['id']}", headers=headers(USER_ID)
        ).status_code
        == 200
    )
    admin_tool = client.post(
        "/api/admin/tool-configs", headers=headers(ADMIN_ID), json=_tool_body("Admin Tool")
    ).json()
    assert (
        client.delete(
            f"/api/admin/tool-configs/{admin_tool['id']}", headers=headers(USER_ID)
        ).status_code
        == 403
    )


def test_granted_user_still_cannot_create_stdio_tools() -> None:
    _grant("tool_authoring", True)
    resp = client.post(
        "/api/admin/tool-configs",
        headers=headers(USER_ID),
        json={
            "name": "Sneaky stdio",
            "tool_type": "mcp",
            "settings": {"transport": "stdio", "command": "python"},
        },
    )
    assert resp.status_code == 403
    assert "service level" in resp.json()["detail"]


def test_owner_scoped_tool_stays_private_to_its_author() -> None:
    _grant("tool_authoring", True)
    created = client.post(
        "/api/admin/tool-configs", headers=headers(USER_ID), json=_tool_body() | {"enabled": True}
    ).json()

    author_payload = client.get("/api/bootstrap", headers=headers(USER_ID)).json()
    assert any(tool["id"] == created["id"] for tool in author_payload["toolConfigs"])

    other_payload = client.get("/api/bootstrap", headers=headers("user-casey")).json()
    assert all(tool["id"] != created["id"] for tool in other_payload["toolConfigs"])


def test_bootstrap_reports_resolved_authoring_state() -> None:
    payload = client.get("/api/bootstrap", headers=headers(USER_ID)).json()
    assert payload["authoringState"] == {"knowledge_enabled": False, "tools_enabled": False}

    _grant("knowledge_authoring", True)
    payload = client.get("/api/bootstrap", headers=headers(USER_ID)).json()
    assert payload["authoringState"] == {"knowledge_enabled": True, "tools_enabled": False}

    admin_payload = client.get("/api/bootstrap", headers=headers(ADMIN_ID)).json()
    assert admin_payload["authoringState"] == {"knowledge_enabled": True, "tools_enabled": True}


def test_admins_remain_unaffected_by_the_grants() -> None:
    resp = client.post(
        "/api/admin/knowledge-configs", headers=headers(ADMIN_ID), json=_kb_body("Admin KB")
    )
    assert resp.status_code == 201
    resp = client.post(
        "/api/admin/tool-configs", headers=headers(ADMIN_ID), json=_tool_body("Admin Tool")
    )
    assert resp.status_code == 201
    assert resp.json()["owner_user_id"] is None


def test_tool_rows_written_before_ownership_existed_still_load() -> None:
    """Regression: adding ToolConfig.owner_user_id must not brick a deployment.

    Tool rows persisted before the field existed omit it. The identity/config
    SQL authority compares stored payloads against the canonical model dump,
    so the loader backfills None for the missing key instead of failing
    startup with "Stored tool_configs payload is not canonical."
    """
    from app.models.schemas import ToolConfig
    from app.repositories.identity_config_sql import _model_from_payload

    modern = ToolConfig(
        id="tool-legacy",
        tenant_id="tenant-example",
        name="Legacy Tool",
        tool_type="mcp",
        endpoint_url="https://mcp.example.com/sse",
        enabled=True,
        settings={},
    )
    legacy_payload = modern.model_dump(mode="json")
    del legacy_payload["owner_user_id"]

    loaded = _model_from_payload(ToolConfig, legacy_payload, "tool_configs")

    assert isinstance(loaded, ToolConfig)
    # Backfilled to unset: pre-existing tools stay admin-managed, tenant-wide.
    assert loaded.owner_user_id is None


def test_unknown_stored_tool_field_is_still_rejected() -> None:
    """The ownership backfill must not blanket-accept arbitrary tool payloads."""
    from app.models.schemas import ToolConfig
    from app.repositories.identity_config_sql import (
        IdentityConfigCorruptionError,
        _model_from_payload,
    )

    modern = ToolConfig(
        id="tool-bad",
        tenant_id="tenant-example",
        name="Bad Tool",
        tool_type="mcp",
        settings={},
    )
    payload = modern.model_dump(mode="json")
    payload["not_a_real_field"] = True

    with pytest.raises(IdentityConfigCorruptionError):
        _model_from_payload(ToolConfig, payload, "tool_configs")
