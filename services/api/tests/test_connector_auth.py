"""Real connector authentication coverage: vendor token flows, the Google OAuth
authorize/callback pair, the per-connector test-connection endpoint, and the
knowledge-sync wiring. All vendor HTTP is mocked on the connector_auth module;
no test touches the network."""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import connector_auth
from app.core.config import get_settings
from app.core.connector_auth import TokenResult, acquire_connector_token
from app.core.sessions import sign_oidc_state
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


def _fake_httpx(monkeypatch: pytest.MonkeyPatch, *, post=None, get=None) -> None:
    def unexpected(*_args: object, **_kwargs: object) -> httpx.Response:
        raise AssertionError("Unexpected HTTP call in this test.")

    monkeypatch.setattr(
        connector_auth,
        "httpx",
        SimpleNamespace(post=post or unexpected, get=get or unexpected, HTTPError=httpx.HTTPError),
    )


# --- Microsoft Graph client credentials ----------------------------------------


def test_graph_client_credentials_acquires_caches_and_test_endpoint_reports_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    config = store.connector_configs["conncfg-graph-example"]
    config.settings["tenant_id"] = "tenant-abc"
    store.set_configuration_secret("connector", config.id, "graph-client-secret")

    posts: list[tuple[str, dict[str, str]]] = []

    def fake_post(url: str, *, data: dict[str, str], headers: dict[str, str], timeout: float) -> httpx.Response:
        posts.append((url, dict(data)))
        return httpx.Response(
            200, json={"access_token": "graph-cc-token", "token_type": "Bearer", "expires_in": 3599}
        )

    gets: list[str] = []

    def fake_get(url: str, *, headers: dict[str, str], params=None, timeout: float) -> httpx.Response:
        gets.append(url)
        assert headers["Authorization"] == "Bearer graph-cc-token"
        return httpx.Response(200, json={"displayName": "Contoso Root Site"})

    _fake_httpx(monkeypatch, post=fake_post, get=fake_get)

    class FakeGraphClient:
        def list_drive_items(self, *, item_id: str, drive_id=None, site_id=None) -> list:
            assert item_id == "example-litigation-drive-root"
            return []

    monkeypatch.setattr(connector_auth, "get_microsoft_graph_client", lambda token: FakeGraphClient())

    response = client.post(
        "/api/admin/connector-configs/conncfg-graph-example/test",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert [check["status"] for check in body["checks"]] == ["ok", "ok", "ok", "ok"]
    assert "graph-client-secret" not in response.text
    assert posts == [
        (
            "https://login.microsoftonline.com/tenant-abc/oauth2/v2.0/token",
            {
                "grant_type": "client_credentials",
                "client_id": "entra-aperture-graph-client",
                "client_secret": "graph-client-secret",
                "scope": "https://graph.microsoft.com/.default",
            },
        )
    ]
    # No site_id/drive_id configured, so the probe hits the root site.
    assert gets == ["https://graph.microsoft.com/v1.0/sites/root"]

    assert config.settings["last_test_status"] == "ok"
    assert config.settings["last_test_at"] == "Saved now"
    event = store.audit_events[-1]
    assert event.action == "admin.connector_config_tested"
    assert event.metadata == {"status": "ok", "connector_id": "microsoft-graph"}

    # The token is cached in the connector-oauth namespace: no second POST.
    result = acquire_connector_token(store, config)
    assert result.access_token == "graph-cc-token"
    assert result.status == "live"
    assert len(posts) == 1


def test_graph_vendor_401_surfaces_error_and_test_endpoint_fails_without_leaking_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    config = store.connector_configs["conncfg-graph-example"]
    config.settings["tenant_id"] = "tenant-abc"
    store.set_configuration_secret("connector", config.id, "graph-client-secret")

    def fake_post(url: str, *, data: dict[str, str], headers: dict[str, str], timeout: float) -> httpx.Response:
        return httpx.Response(
            401,
            json={"error": "invalid_client", "error_description": "AADSTS7000215: Invalid client secret provided."},
        )

    _fake_httpx(monkeypatch, post=fake_post)

    response = client.post(
        "/api/admin/connector-configs/conncfg-graph-example/test",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "failed"
    assert "HTTP 401" in body["message"]
    assert "AADSTS7000215" in body["message"]
    assert "graph-client-secret" not in response.text
    auth_check = next(check for check in body["checks"] if check["name"] == "Authentication")
    assert auth_check["status"] == "failed"


# --- Box client credentials grant ------------------------------------------------


def test_box_ccg_posts_subject_params_and_probe_names_service_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch = client.patch(
        "/api/admin/connector-configs/conncfg-box-example",
        headers=headers("user-admin"),
        json={
            "settings": {"client_id": "box-client-id", "enterprise_id": "4711"},
            "secret_value": "box-client-secret",
        },
    )
    assert patch.status_code == 200

    posts: list[tuple[str, dict[str, str]]] = []

    def fake_post(url: str, *, data: dict[str, str], headers: dict[str, str], timeout: float) -> httpx.Response:
        posts.append((url, dict(data)))
        return httpx.Response(200, json={"access_token": "box-ccg-token", "expires_in": 3600})

    def fake_get(url: str, *, headers: dict[str, str], params=None, timeout: float) -> httpx.Response:
        assert url == "https://api.box.com/2.0/users/me"
        assert headers["Authorization"] == "Bearer box-ccg-token"
        return httpx.Response(200, json={"name": "AutomationUser", "login": "AutomationUser@boxdevedition.com"})

    _fake_httpx(monkeypatch, post=fake_post, get=fake_get)

    response = client.post(
        "/api/admin/connector-configs/conncfg-box-example/test",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert posts == [
        (
            "https://api.box.com/oauth2/token",
            {
                "grant_type": "client_credentials",
                "client_id": "box-client-id",
                "client_secret": "box-client-secret",
                "box_subject_type": "enterprise",
                "box_subject_id": "4711",
            },
        )
    ]
    api_check = next(check for check in body["checks"] if check["name"] == "API access")
    assert api_check["detail"] == "Connected as AutomationUser (AutomationUser@boxdevedition.com)."
    assert "box-client-secret" not in response.text


def test_box_missing_enterprise_id_reports_incomplete_with_exact_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch = client.patch(
        "/api/admin/connector-configs/conncfg-box-example",
        headers=headers("user-admin"),
        json={"settings": {"client_id": "box-client-id"}, "secret_value": "box-client-secret"},
    )
    assert patch.status_code == 200
    _fake_httpx(monkeypatch)  # no HTTP call may happen with fields missing

    response = client.post(
        "/api/admin/connector-configs/conncfg-box-example/test",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "incomplete"
    assert "Enterprise ID (enterprise_id)" in body["message"]
    assert body["checks"] == [
        {
            "name": "Required fields",
            "status": "incomplete",
            "detail": "Missing: Enterprise ID (enterprise_id).",
        }
    ]


# --- Google Drive OAuth ------------------------------------------------------------


def test_google_refresh_flow_exchanges_stored_refresh_token(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    config = store.connector_configs["conncfg-google-drive-example"]
    store.set_configuration_secret("connector", config.id, "google-client-secret")
    store.set_configuration_secret(
        "connector-oauth",
        config.id,
        json.dumps({"access_token": "expired-token", "refresh_token": "refresh-1", "expires_at": 100}),
    )

    posts: list[tuple[str, dict[str, str]]] = []

    def fake_post(url: str, *, data: dict[str, str], headers: dict[str, str], timeout: float) -> httpx.Response:
        posts.append((url, dict(data)))
        return httpx.Response(200, json={"access_token": "google-live-token", "expires_in": 3600})

    def fake_get(url: str, *, headers: dict[str, str], params=None, timeout: float) -> httpx.Response:
        assert url == "https://www.googleapis.com/drive/v3/about"
        assert params == {"fields": "user(displayName,emailAddress)"}
        assert headers["Authorization"] == "Bearer google-live-token"
        return httpx.Response(200, json={"user": {"displayName": "Aperture Sync", "emailAddress": "sync@example.com"}})

    _fake_httpx(monkeypatch, post=fake_post, get=fake_get)

    class FakeDriveClient:
        def list_files(self, *, folder_id: str) -> list:
            assert folder_id == "policy-library-folder"
            return []

    monkeypatch.setattr(connector_auth, "get_google_drive_client", lambda token: FakeDriveClient())

    response = client.post(
        "/api/admin/connector-configs/conncfg-google-drive-example/test",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert posts == [
        (
            "https://oauth2.googleapis.com/token",
            {
                "grant_type": "refresh_token",
                "refresh_token": "refresh-1",
                "client_id": "google-aperture-drive-client",
                "client_secret": "google-client-secret",
            },
        )
    ]
    api_check = next(check for check in body["checks"] if check["name"] == "API access")
    assert api_check["detail"] == "Connected as sync@example.com."
    stored = json.loads(store.configuration_secret("connector-oauth", config.id) or "{}")
    assert stored["access_token"] == "google-live-token"
    assert stored["refresh_token"] == "refresh-1"


def test_google_without_refresh_token_tells_admin_to_run_connect_flow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    config = store.connector_configs["conncfg-google-drive-example"]
    store.set_configuration_secret("connector", config.id, "google-client-secret")
    _fake_httpx(monkeypatch)  # no token call may happen without a refresh token

    response = client.post(
        "/api/admin/connector-configs/conncfg-google-drive-example/test",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "incomplete"
    assert "no refresh token is stored" in body["message"]
    assert "Connect Google Drive" in body["message"]
    auth_check = next(check for check in body["checks"] if check["name"] == "Authentication")
    assert auth_check["status"] == "incomplete"


def test_google_oauth_authorize_redirects_with_offline_consent_or_400_when_unconfigured() -> None:
    missing = client.get(
        "/api/admin/connector-configs/conncfg-google-drive-example/oauth/authorize",
        headers=headers("user-admin"),
        follow_redirects=False,
    )
    assert missing.status_code == 400
    assert "Client secret (secret_value)" in missing.json()["detail"]

    store = get_store()
    store.set_configuration_secret("connector", "conncfg-google-drive-example", "google-client-secret")
    response = client.get(
        "/api/admin/connector-configs/conncfg-google-drive-example/oauth/authorize",
        headers=headers("user-admin"),
        follow_redirects=False,
    )
    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "access_type=offline" in location
    assert "prompt=consent" in location
    assert "client_id=google-aperture-drive-client" in location
    assert "connector-oauth%2Fcallback" in location


def test_google_oauth_callback_stores_tokens_and_redirects_to_web_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    config = store.connector_configs["conncfg-google-drive-example"]
    store.set_configuration_secret("connector", config.id, "google-client-secret")

    posts: list[tuple[str, dict[str, str]]] = []

    def fake_post(url: str, *, data: dict[str, str], headers: dict[str, str], timeout: float) -> httpx.Response:
        posts.append((url, dict(data)))
        return httpx.Response(
            200,
            json={"access_token": "google-access", "refresh_token": "google-refresh", "expires_in": 3600},
        )

    _fake_httpx(monkeypatch, post=fake_post)
    state = sign_oidc_state({"config_id": config.id, "actor_id": "user-admin"}, get_settings().secret_key)

    response = client.get(
        "/api/connector-oauth/callback",
        params={"code": "auth-code-9", "state": state},
        follow_redirects=False,
    )

    assert response.status_code == 302
    assert response.headers["location"] == "http://localhost:5173/?connector_oauth=success"
    assert posts == [
        (
            "https://oauth2.googleapis.com/token",
            {
                "grant_type": "authorization_code",
                "code": "auth-code-9",
                "redirect_uri": "http://localhost:8000/api/connector-oauth/callback",
                "client_id": "google-aperture-drive-client",
                "client_secret": "google-client-secret",
            },
        )
    ]
    stored = json.loads(store.configuration_secret("connector-oauth", config.id) or "{}")
    assert stored["access_token"] == "google-access"
    assert stored["refresh_token"] == "google-refresh"
    assert config.settings["oauth_status"] == "connected"
    assert config.settings["oauth_connected_at"] == "Saved now"
    event = store.audit_events[-1]
    assert event.action == "admin.connector_oauth_connected"
    assert "google-refresh" not in str(event.metadata)
    assert "google-access" not in str(event.metadata)


def test_google_oauth_callback_with_bad_state_redirects_with_honest_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_httpx(monkeypatch)  # nothing may be exchanged with a forged state
    response = client.get(
        "/api/connector-oauth/callback",
        params={"code": "auth-code-9", "state": "v1.forged.state"},
        follow_redirects=False,
    )
    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith("http://localhost:5173/?connector_oauth=error&message=")
    assert "invalid%20or%20expired" in location


# --- iManage password grant ---------------------------------------------------------


def test_imanage_password_grant_posts_to_base_url_and_probes_libraries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    patch = client.patch(
        "/api/admin/connector-configs/conncfg-imanage-example",
        headers=headers("user-admin"),
        json={
            "enabled": True,
            "auth_type": "password",
            "settings": {
                "auth_mode": "password",
                "base_url": "https://imanage.example.test",
                "client_id": "imanage-client-id",
                "service_username": "svc-aperture",
                "customer_id": "100",
            },
            "secret_value": "imanage-client-secret",
            "service_password": "imanage-service-password",
        },
    )
    assert patch.status_code == 200
    assert "imanage-service-password" not in patch.text
    store = get_store()
    assert store.audit_events[-1].metadata["service_password"] == "[redacted]"

    posts: list[tuple[str, dict[str, str]]] = []

    def fake_post(url: str, *, data: dict[str, str], headers: dict[str, str], timeout: float) -> httpx.Response:
        posts.append((url, dict(data)))
        return httpx.Response(
            200, json={"access_token": "imanage-token", "refresh_token": "imanage-refresh", "expires_in": 1800}
        )

    def fake_get(url: str, *, headers: dict[str, str], params=None, timeout: float) -> httpx.Response:
        assert url == "https://imanage.example.test/work/api/v2/customers/100/libraries"
        assert headers["Authorization"] == "Bearer imanage-token"
        return httpx.Response(200, json={"data": [{"id": "ACTIVE_US"}, {"id": "ARCHIVE"}]})

    _fake_httpx(monkeypatch, post=fake_post, get=fake_get)

    class FakeIManageClient:
        def list_documents(self, *, workspace_id: str, documents_endpoint=None, customer_id=None, library_id=None) -> list:
            assert workspace_id == "EXAMPLE-LITIGATION"
            return []

    monkeypatch.setattr(connector_auth, "get_imanage_client", lambda token, base_url: FakeIManageClient())

    response = client.post(
        "/api/admin/connector-configs/conncfg-imanage-example/test",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert posts == [
        (
            "https://imanage.example.test/auth/oauth2/token",
            {
                "grant_type": "password",
                "username": "svc-aperture",
                "password": "imanage-service-password",
                "client_id": "imanage-client-id",
                "client_secret": "imanage-client-secret",
            },
        )
    ]
    api_check = next(check for check in body["checks"] if check["name"] == "API access")
    assert api_check["detail"] == "Found 2 libraries: ACTIVE_US, ARCHIVE."
    assert "imanage-service-password" not in response.text
    # The issued refresh token is cached for renewal.
    stored = json.loads(store.configuration_secret("connector-oauth", "conncfg-imanage-example") or "{}")
    assert stored["refresh_token"] == "imanage-refresh"


def test_imanage_missing_base_url_reports_incomplete(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    config = store.connector_configs["conncfg-imanage-example"]
    config.auth_type = "password"
    config.settings["auth_mode"] = "password"
    config.settings["base_url"] = ""
    _fake_httpx(monkeypatch)  # no HTTP call may happen with fields missing

    response = client.post(
        "/api/admin/connector-configs/conncfg-imanage-example/test",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "incomplete"
    assert "iManage base URL (base_url)" in body["message"]
    assert "Service username (service_username)" in body["message"]
    assert "Service account password (service_password)" in body["message"]


def test_imanage_delegated_oauth_test_reports_user_sign_in_as_the_live_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    config = store.connector_configs["conncfg-imanage-example"]
    config.enabled = True
    config.auth_type = "oauth-client"
    config.settings.update(
        {
            "auth_mode": "oauth-client",
            "base_url": "https://imanage.example.test",
            "client_id": "imanage-client-id",
        }
    )
    store.set_configuration_secret("connector", config.id, "imanage-client-secret")
    _fake_httpx(monkeypatch)  # Admin test must not impersonate a user or call iManage.

    response = client.post(
        "/api/admin/connector-configs/conncfg-imanage-example/test",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "incomplete"
    assert "opening iManage from chat" in body["message"]
    isolation = next(check for check in body["checks"] if check["name"] == "User isolation")
    assert isolation["status"] == "ok"
    assert "shared connector credentials are never used" in isolation["detail"]


# --- knowledge sync wiring ------------------------------------------------------------


def test_graph_knowledge_sync_uses_acquired_token(monkeypatch: pytest.MonkeyPatch) -> None:
    acquired: list[str] = []

    def fake_acquire(store: object, config: object) -> TokenResult:
        return TokenResult(access_token="acquired-graph-token", status="live")

    monkeypatch.setattr("app.routes.knowledge.acquire_connector_token", fake_acquire)

    class FakeGraphClient:
        def list_drive_items(self, *, item_id: str, drive_id=None, site_id=None) -> list:
            assert item_id == "example-litigation-drive-root"
            return []

    def fake_client(token: str | None) -> FakeGraphClient:
        acquired.append(token or "")
        return FakeGraphClient()

    monkeypatch.setattr("app.routes.knowledge.get_microsoft_graph_client", fake_client)

    response = client.post(
        "/api/knowledge/knowledge-litigation-playbook/sync",
        json={"force": True},
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    assert acquired == ["acquired-graph-token"]
    assert response.json()["provider_status"] == "live"


def test_pasted_token_mode_without_secret_names_the_field_to_fill(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    config = store.connector_configs["conncfg-box-example"]
    config.settings["auth_mode"] = "developer-token"
    _fake_httpx(monkeypatch)

    result = acquire_connector_token(store, config)
    assert result.status == "missing-credentials"
    assert result.access_token is None
    assert result.message == (
        "Box access token is not stored for auth mode 'developer-token'. "
        "Paste an access token into the connector credential (secret_value) field."
    )
