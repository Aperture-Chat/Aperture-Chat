"""Workspace admins manage their own tenant's connectors, and only their own."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.connector_availability import (
    connector_enabled_for_tenant,
    connector_hidden_for_tenant,
)
from app.core.sessions import sign_oidc_state
from app.main import app
from app.models.schemas import ConnectorConfig, Role, Tenant
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store():
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _foreign_config():
    store = get_store()
    store.tenants["tenant-second"] = Tenant(id="tenant-second", name="Second Tenant", slug="second")
    config = ConnectorConfig(id="conncfg-foreign", tenant_id="tenant-second", connector_id="box")
    store.connector_configs[config.id] = config
    store.set_configuration_secret("connector", config.id, "foreign-example-secret")
    return store, config


@pytest.mark.parametrize("method,suffix,payload", [
    ("get", "", None),
    ("post", "", {"id": "conncfg-forbidden", "connector_id": "box"}),
    ("patch", "/conncfg-google-drive-example", {"enabled": False, "secret_value": "changed"}),
    ("delete", "/conncfg-google-drive-example", None),
    ("post", "/conncfg-google-drive-example/test", None),
    ("get", "/conncfg-google-drive-example/oauth/authorize", None),
    ("get", "/conncfg-google-drive-example/oauth/authorize-url", None),
])
def test_standard_users_cannot_administer_connectors(method, suffix, payload):
    store = get_store()
    config_id = "conncfg-google-drive-example"
    store.set_configuration_secret("connector", config_id, "unchanged-example-secret")
    before = {key: value.model_dump() for key, value in store.connector_configs.items()}
    audit_count = len(store.audit_events)
    response = client.request(
        method, f"/api/admin/connector-configs{suffix}", json=payload,
        headers=headers("user-jane"), follow_redirects=False,
    )
    assert response.status_code == 403
    assert {key: value.model_dump() for key, value in store.connector_configs.items()} == before
    assert store.configuration_secret("connector", config_id) == "unchanged-example-secret"
    assert len(store.audit_events) == audit_count


def test_admin_manages_own_workspace_connector_and_hides_a_source():
    created = client.post(
        "/api/admin/connector-configs", headers=headers("user-admin"),
        json={"id": "conncfg-admin-managed", "connector_id": "box",
              "secret_value": "synthetic-example-secret"},
    )
    assert created.status_code == 201
    assert created.json()["tenant_id"] == "tenant-example"
    assert created.json()["hidden"] is False
    assert "synthetic-example-secret" not in created.text

    hidden = client.patch(
        "/api/admin/connector-configs/conncfg-admin-managed",
        headers=headers("user-admin"), json={"hidden": True},
    )
    assert hidden.status_code == 200
    assert hidden.json()["hidden"] is True
    # Hiding is not turning off: the record and its credential stay as they were.
    assert hidden.json()["enabled"] is True
    assert hidden.json()["secret_set"] is True
    store = get_store()
    assert connector_hidden_for_tenant(store, "box", "tenant-example")
    assert store.audit_events[-1].action == "admin.connector_config_updated"

    listed = client.get("/api/admin/connector-configs", headers=headers("user-admin"))
    assert listed.status_code == 200
    assert {item["tenant_id"] for item in listed.json()} == {"tenant-example"}

    deleted = client.delete("/api/admin/connector-configs/conncfg-admin-managed", headers=headers("user-admin"))
    assert deleted.status_code == 200
    assert store.configuration_secret("connector", "conncfg-admin-managed") is None


def test_admin_can_record_a_source_below_a_closed_platform_ceiling():
    store = get_store()
    store.connectors["box"].platform_enabled = False
    store.connectors["box"].tenant_enabled = False
    created = client.post(
        "/api/admin/connector-configs", headers=headers("user-admin"),
        json={"id": "conncfg-hidden-box", "connector_id": "box", "enabled": False, "hidden": True},
    )
    assert created.status_code == 201
    assert created.json()["hidden"] is True
    assert connector_hidden_for_tenant(store, "box", "tenant-example")


@pytest.mark.parametrize("connector_id", ["google-drive", "microsoft-graph", "box", "imanage"])
def test_every_cloud_file_source_can_be_hidden(connector_id):
    created = client.post(
        "/api/admin/connector-configs", headers=headers("user-admin"),
        json={"id": f"conncfg-hide-{connector_id}", "connector_id": connector_id, "hidden": True},
    )
    assert created.status_code == 201, created.text
    assert connector_hidden_for_tenant(get_store(), connector_id, "tenant-example")


def test_only_cloud_file_sources_can_be_hidden():
    rejected = client.post(
        "/api/admin/connector-configs", headers=headers("user-admin"),
        json={"connector_id": "web", "hidden": True},
    )
    assert rejected.status_code == 400
    created = client.post(
        "/api/admin/connector-configs", headers=headers("user-admin"),
        json={"id": "conncfg-web-switch", "connector_id": "web", "enabled": False},
    )
    assert created.status_code == 201
    patched = client.patch(
        "/api/admin/connector-configs/conncfg-web-switch", headers=headers("user-admin"), json={"hidden": True},
    )
    assert patched.status_code == 400
    assert get_store().connector_configs["conncfg-web-switch"].hidden is False


@pytest.mark.parametrize("method,suffix,payload", [
    ("patch", "/conncfg-foreign", {"enabled": False, "hidden": True, "secret_value": "changed"}),
    ("delete", "/conncfg-foreign", None),
    ("post", "/conncfg-foreign/test", None),
])
def test_admin_cannot_touch_another_workspaces_connector(method, suffix, payload):
    store, config = _foreign_config()
    before = config.model_dump()
    response = client.request(
        method, f"/api/admin/connector-configs{suffix}", json=payload, headers=headers("user-admin"),
    )
    assert response.status_code == 403
    assert store.connector_configs[config.id].model_dump() == before
    assert store.configuration_secret("connector", config.id) == "foreign-example-secret"


def test_admin_cannot_create_or_list_records_for_another_workspace():
    _foreign_config()
    created = client.post(
        "/api/admin/connector-configs", headers=headers("user-admin"),
        json={"connector_id": "box", "tenant_id": "tenant-second", "hidden": True},
    )
    assert created.status_code == 403
    listed = client.get("/api/admin/connector-configs", headers=headers("user-admin"))
    assert "conncfg-foreign" not in {item["id"] for item in listed.json()}


def test_workspace_switch_is_scoped_to_its_tenant():
    store, _config = _foreign_config()
    store.connector_configs["conncfg-web-off"] = ConnectorConfig(
        id="conncfg-web-off", tenant_id="tenant-second", connector_id="web", enabled=False,
    )
    assert connector_enabled_for_tenant(store, "web", "tenant-example")
    assert not connector_enabled_for_tenant(store, "web", "tenant-second")
    # The catalog flags stay the deployment ceiling for every workspace.
    store.connectors["web"].platform_enabled = False
    assert not connector_enabled_for_tenant(store, "web", "tenant-example")


def test_owner_authorizes_workspace_oauth_for_a_tenant():
    store = get_store()
    store.set_configuration_secret("connector", "conncfg-google-drive-example", "example-secret")
    authorized = client.get(
        "/api/admin/connector-configs/conncfg-google-drive-example/oauth/authorize-url",
        headers=headers("user-owner"),
    )
    assert authorized.status_code == 200
    assert authorized.json()["url"].startswith("https://accounts.google.com/")


@pytest.mark.parametrize("actor_state", ["foreign-admin", "user", "inactive", "missing"])
def test_workspace_oauth_rechecks_admin_scope_before_exchanging_credentials(monkeypatch, actor_state):
    from app.routes import connector_oauth

    store = get_store()
    config_id = "conncfg-google-drive-example"
    actor_id = "missing-admin" if actor_state == "missing" else "user-admin"
    state = sign_oidc_state({"actor_id": actor_id, "config_id": config_id},
                            get_settings().secret_key)
    if actor_state != "missing":
        admin = store.users[actor_id]
        if actor_state == "inactive":
            admin.active = False
        elif actor_state == "user":
            admin.role = Role.USER
        else:
            admin.tenant_id = "tenant-second"

    def unexpected_exchange(*_args, **_kwargs):
        raise AssertionError("A callback outside the workspace must not exchange its credentials")

    monkeypatch.setattr(connector_oauth, "exchange_google_authorization_code", unexpected_exchange)
    before = store.connector_configs[config_id].model_dump()
    audit_count = len(store.audit_events)
    response = client.get("/api/connector-oauth/callback", params={"state": state, "code": "example"},
                          follow_redirects=False)
    assert response.status_code == 302
    assert "connector_oauth=error" in response.headers["location"]
    assert store.connector_configs[config_id].model_dump() == before
    assert store.configuration_secret("connector-oauth", config_id) is None
    assert len(store.audit_events) == audit_count


def test_workspace_admin_completes_their_own_oauth_callback(monkeypatch):
    from app.routes import connector_oauth

    store = get_store()
    config_id = "conncfg-google-drive-example"
    state = sign_oidc_state({"actor_id": "user-admin", "config_id": config_id}, get_settings().secret_key)
    monkeypatch.setattr(connector_oauth, "exchange_google_authorization_code", lambda *_args: None)
    response = client.get("/api/connector-oauth/callback", params={"state": state, "code": "example"},
                          follow_redirects=False)
    assert response.status_code == 302
    assert "connector_oauth=success" in response.headers["location"]
    assert store.connector_configs[config_id].settings["oauth_status"] == "connected"
    assert store.audit_events[-1].actor_id == "user-admin"
