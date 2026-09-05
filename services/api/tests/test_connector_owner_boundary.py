"""Shared connector credentials are owned by the service, not tenant admins."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.sessions import sign_oidc_state
from app.main import app
from app.models.schemas import Role
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store():
    get_store.cache_clear()
    yield
    get_store.cache_clear()


@pytest.mark.parametrize("actor", ["user-admin", "user-jane"])
@pytest.mark.parametrize("method,suffix,payload", [
    ("get", "", None),
    ("post", "", {"id": "conncfg-forbidden", "connector_id": "box"}),
    ("patch", "/conncfg-google-drive-example", {"enabled": False, "secret_value": "changed"}),
    ("delete", "/conncfg-google-drive-example", None),
    ("post", "/conncfg-google-drive-example/test", None),
    ("get", "/conncfg-google-drive-example/oauth/authorize", None),
    ("get", "/conncfg-google-drive-example/oauth/authorize-url", None),
])
def test_tenant_roles_cannot_administer_shared_connections(actor, method, suffix, payload):
    store = get_store()
    config_id = "conncfg-google-drive-example"
    store.set_configuration_secret("connector", config_id, "unchanged-example-secret")
    before = {key: value.model_dump() for key, value in store.connector_configs.items()}
    audit_count = len(store.audit_events)
    response = client.request(
        method, f"/api/admin/connector-configs{suffix}", json=payload,
        headers={"x-aperture-user": actor}, follow_redirects=False,
    )
    assert response.status_code == 403
    assert {key: value.model_dump() for key, value in store.connector_configs.items()} == before
    assert store.configuration_secret("connector", config_id) == "unchanged-example-secret"
    assert len(store.audit_events) == audit_count


def test_owner_manages_shared_credentials_and_authorizes_workspace_oauth():
    headers = {"x-aperture-user": "user-owner"}
    created = client.post(
        "/api/admin/connector-configs", headers=headers,
        json={"id": "conncfg-owner-managed", "connector_id": "box",
              "tenant_id": "tenant-example", "secret_value": "synthetic-example-secret"},
    )
    assert created.status_code == 201
    assert "synthetic-example-secret" not in created.text
    listed = client.get("/api/admin/connector-configs", headers=headers)
    assert listed.status_code == 200
    assert any(item["id"] == "conncfg-owner-managed" for item in listed.json())
    patched = client.patch("/api/admin/connector-configs/conncfg-owner-managed",
                           headers=headers, json={"enabled": False})
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False
    deleted = client.delete("/api/admin/connector-configs/conncfg-owner-managed", headers=headers)
    assert deleted.status_code == 200
    store = get_store()
    assert store.configuration_secret("connector", "conncfg-owner-managed") is None
    store.set_configuration_secret("connector", "conncfg-google-drive-example", "example-secret")
    authorized = client.get(
        "/api/admin/connector-configs/conncfg-google-drive-example/oauth/authorize-url",
        headers=headers,
    )
    assert authorized.status_code == 200
    assert authorized.json()["url"].startswith("https://accounts.google.com/")


@pytest.mark.parametrize("actor_state", ["admin", "user", "inactive", "missing"])
def test_workspace_oauth_rechecks_owner_before_exchanging_credentials(monkeypatch, actor_state):
    from app.routes import connector_oauth

    store = get_store()
    config_id = "conncfg-google-drive-example"
    actor_id = "missing-owner" if actor_state == "missing" else "user-owner"
    state = sign_oidc_state({"actor_id": actor_id, "config_id": config_id},
                            get_settings().secret_key)
    if actor_state != "missing":
        owner = store.users[actor_id]
        if actor_state == "inactive":
            owner.active = False
        else:
            owner.role = Role.TENANT_ADMIN if actor_state == "admin" else Role.USER

    def unexpected_exchange(*_args, **_kwargs):
        raise AssertionError("A non-owner callback must not exchange shared credentials")

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
