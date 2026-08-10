from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.core.cloud_sources import CloudSourceItem
from app.core.config import get_settings
from app.core.sessions import sign_oidc_state
from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def test_google_drive_picker_lists_and_imports_chat_attachments(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    drive_config = store.connector_configs["conncfg-google-drive-example"]
    drive_config.auth_type = "access-token"
    drive_config.settings["auth_mode"] = "manual-token"
    drive_config.settings["folder_id"] = "folder-123"
    store.set_configuration_secret("connector", drive_config.id, "drive-live-token")

    class FakeDriveClient:
        def list_files(self, *, folder_id: str, max_items: int) -> list[CloudSourceItem]:
            assert folder_id == "folder-123"
            assert max_items == 100
            return [
                CloudSourceItem(
                    id="drive-file-1",
                    type="file",
                    name="Drive policy memo.txt",
                    source_type="google-drive",
                    source_uri="gdrive://files/drive-file-1",
                    modified_at="2026-07-03T12:00:00Z",
                    size=76,
                    item_status="active",
                    mime_type="text/plain",
                )
            ]

        def download_file(self, *, file_id: str, mime_type: str | None = None) -> bytes:
            assert file_id == "drive-file-1"
            assert mime_type == "text/plain"
            return b"Drive policy memo: attach selected Google Drive files directly into chat context."

    monkeypatch.setattr("app.routes.chat.get_google_drive_client", lambda token: FakeDriveClient())

    list_response = client.get(
        "/api/chat/cloud-attachments/google-drive/items?tenant_id=tenant-example",
        headers=headers(),
    )

    assert list_response.status_code == 200
    assert list_response.json() == [
        {
            "id": "drive-file-1",
            "name": "Drive policy memo.txt",
            "kind": "Text",
            "item_type": "file",
            "mime_type": "text/plain",
            "size": "76 B",
            "size_bytes": 76,
            "source_type": "google-drive",
            "source_uri": "gdrive://files/drive-file-1",
            "modified_at": "2026-07-03T12:00:00Z",
        }
    ]

    import_response = client.post(
        "/api/chat/cloud-attachments/google-drive/attachments",
        json={"item_ids": ["drive-file-1"], "tenant_id": "tenant-example"},
        headers=headers(),
    )

    assert import_response.status_code == 200
    attachment = import_response.json()[0]
    assert attachment["id"].startswith("cloud-google-drive-")
    assert attachment["tenant_id"] == "tenant-example"
    assert attachment["owner_user_id"] == "user-admin"
    assert attachment["name"] == "Drive policy memo.txt"
    assert attachment["kind"] == "Text"
    assert attachment["source_type"] == "google-drive"
    assert attachment["source_uri"] == "gdrive://files/drive-file-1"
    assert "Google Drive files directly into chat context" in attachment["text_preview"]
    assert get_store().chat_attachment_for(get_store().users["user-admin"], attachment["id"]) is not None


def test_google_drive_oauth_client_requires_per_user_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    """oauth-client mode: each user connects their own Google account and only sees their own Drive."""
    store = get_store()
    drive_config = store.connector_configs["conncfg-google-drive-example"]
    assert drive_config.settings["auth_mode"] == "oauth-client"
    store.set_configuration_secret("connector", drive_config.id, "google-client-secret")

    # Not connected yet: the picker asks the user to connect, not an opaque error.
    list_response = client.get(
        "/api/chat/cloud-attachments/google-drive/items?tenant_id=tenant-example",
        headers=headers(),
    )
    assert list_response.status_code == 428
    assert "Connect your Google Drive account" in list_response.json()["detail"]

    # The consent URL is a real Google authorization URL carrying signed state.
    authorize_response = client.get(
        "/api/chat/cloud-attachments/google-drive/authorize-url?tenant_id=tenant-example",
        headers=headers(),
    )
    assert authorize_response.status_code == 200
    url = authorize_response.json()["url"]
    parts = urlsplit(url)
    assert parts.netloc == "accounts.google.com"
    query = parse_qs(parts.query)
    assert query["client_id"] == ["google-aperture-drive-client"]
    assert query["access_type"] == ["offline"]
    assert query["state"]

    # Provider redirects back with a code; the exchange stores tokens for this user only.
    monkeypatch.setattr(
        "app.core.connector_auth._post_token",
        lambda token_url, data: (
            {"access_token": "user-drive-token", "refresh_token": "user-drive-refresh", "expires_in": 3600},
            None,
        ),
    )
    state = sign_oidc_state(
        {"config_id": drive_config.id, "actor_id": "user-admin", "subject": "user"},
        get_settings().secret_key,
    )
    callback = client.get(f"/api/connector-oauth/callback?code=auth-code&state={state}")
    assert callback.status_code == 200
    assert "Account connected" in callback.text

    class FakeUserDriveClient:
        def list_files(self, *, folder_id: str, max_items: int) -> list[CloudSourceItem]:
            # Per-user tokens list the user's own My Drive root, not the org folder.
            assert folder_id == "root"
            return [
                CloudSourceItem(
                    id="my-file-1",
                    type="file",
                    name="My notes.txt",
                    source_type="google-drive",
                    source_uri="gdrive://files/my-file-1",
                    size=10,
                    mime_type="text/plain",
                )
            ]

    def fake_client(token: str) -> FakeUserDriveClient:
        assert token == "user-drive-token"
        return FakeUserDriveClient()

    monkeypatch.setattr("app.routes.chat.get_google_drive_client", fake_client)

    connected_list = client.get(
        "/api/chat/cloud-attachments/google-drive/items?tenant_id=tenant-example",
        headers=headers(),
    )
    assert connected_list.status_code == 200
    assert [item["id"] for item in connected_list.json()] == ["my-file-1"]

    # Another user in the same tenant has not connected: they see nothing of user-admin's files.
    other_response = client.get(
        "/api/chat/cloud-attachments/google-drive/items?tenant_id=tenant-example",
        headers=headers("user-jane"),
    )
    assert other_response.status_code == 428


def test_sharepoint_site_only_config_lists_and_downloads(monkeypatch: pytest.MonkeyPatch) -> None:
    """Site-rooted Graph configs must never fall back to /me for downloads."""
    store = get_store()
    graph_config = store.connector_configs["conncfg-graph-example"]
    graph_config.auth_type = "access-token"
    graph_config.settings["auth_mode"] = "manual-token"
    graph_config.settings["site_id"] = "contoso-site"
    graph_config.settings["drive_id"] = ""
    graph_config.settings["drive_item_id"] = "root"
    graph_config.settings["source_root_id"] = ""
    store.set_configuration_secret("connector", graph_config.id, "graph-shared-token")

    calls: dict[str, object] = {}

    class FakeGraphClient:
        def list_drive_items(
            self,
            *,
            item_id: str,
            drive_id: str | None = None,
            site_id: str | None = None,
            max_items: int = 100,
        ) -> list[CloudSourceItem]:
            assert item_id == "root"
            assert drive_id is None
            assert site_id == "contoso-site"
            return [
                CloudSourceItem(
                    id="sp-file-1",
                    type="file",
                    name="Site policy.txt",
                    source_type="microsoft-graph",
                    source_uri="graph://items/sp-file-1",
                    size=20,
                    mime_type="text/plain",
                ),
                CloudSourceItem(
                    id="sp-file-2",
                    type="file",
                    name="Preauth memo.txt",
                    source_type="microsoft-graph",
                    source_uri="graph://items/sp-file-2",
                    size=24,
                    mime_type="text/plain",
                    download_url="https://graph.example.net/preauth/sp-file-2",
                ),
            ]

        def download_file(self, *, file_id: str, drive_id: str | None = None, site_id: str | None = None) -> bytes:
            calls["download_file"] = {"file_id": file_id, "drive_id": drive_id, "site_id": site_id}
            return b"Site policy body"

        def download_from_url(self, url: str) -> bytes:
            calls["download_from_url"] = url
            return b"Preauth memo body"

    monkeypatch.setattr("app.routes.chat.get_microsoft_graph_client", lambda token: FakeGraphClient())

    list_response = client.get(
        "/api/chat/cloud-attachments/sharepoint/items?tenant_id=tenant-example",
        headers=headers(),
    )
    assert list_response.status_code == 200

    import_response = client.post(
        "/api/chat/cloud-attachments/sharepoint/attachments",
        json={"item_ids": ["sp-file-1", "sp-file-2"], "tenant_id": "tenant-example"},
        headers=headers(),
    )
    assert import_response.status_code == 200
    # Id-based download targets the configured site drive, not /me.
    assert calls["download_file"] == {"file_id": "sp-file-1", "drive_id": None, "site_id": "contoso-site"}
    # Items carrying a pre-authenticated URL use it directly.
    assert calls["download_from_url"] == "https://graph.example.net/preauth/sp-file-2"


def test_onedrive_authorize_url_uses_delegated_microsoft_flow() -> None:
    store = get_store()
    graph_config = store.connector_configs["conncfg-graph-example"]
    assert graph_config.settings["auth_mode"] == "client-credentials"
    graph_config.settings["tenant_id"] = "contoso-tenant"
    store.set_configuration_secret("connector", graph_config.id, "graph-client-secret")

    # Client-credentials mode is per-user for chat attachments: not connected yet.
    list_response = client.get(
        "/api/chat/cloud-attachments/onedrive/items?tenant_id=tenant-example",
        headers=headers(),
    )
    assert list_response.status_code == 428

    authorize_response = client.get(
        "/api/chat/cloud-attachments/onedrive/authorize-url?tenant_id=tenant-example",
        headers=headers(),
    )
    assert authorize_response.status_code == 200
    url = authorize_response.json()["url"]
    parts = urlsplit(url)
    assert parts.netloc == "login.microsoftonline.com"
    assert parts.path == "/contoso-tenant/oauth2/v2.0/authorize"
    query = parse_qs(parts.query)
    assert query["scope"] == ["offline_access Files.Read.All Sites.Read.All"]
    assert query["state"]


def test_box_authorize_url_uses_each_users_own_oauth_connection() -> None:
    store = get_store()
    box_config = store.connector_configs["conncfg-box-example"]
    box_config.enabled = True
    box_config.settings.update(
        {
            "auth_mode": "client-credentials",
            "client_id": "box-client-id",
            # Deliberately blank: enterprise_id is required for background CCG,
            # not for a user's authorization-code flow.
            "enterprise_id": "",
        }
    )
    store.set_configuration_secret("connector", box_config.id, "box-client-secret")
    store.connectors["box"].platform_enabled = True
    store.connectors["box"].tenant_enabled = True

    first_list = client.get(
        "/api/chat/cloud-attachments/box/items?tenant_id=tenant-example",
        headers=headers(),
    )
    assert first_list.status_code == 428
    assert "Connect your Box account" in first_list.json()["detail"]

    authorize_response = client.get(
        "/api/chat/cloud-attachments/box/authorize-url?tenant_id=tenant-example",
        headers=headers(),
    )
    assert authorize_response.status_code == 200
    parts = urlsplit(authorize_response.json()["url"])
    assert parts.netloc == "account.box.com"
    assert parts.path == "/api/oauth2/authorize"
    query = parse_qs(parts.query)
    assert query["client_id"] == ["box-client-id"]
    assert query["state"]

    other_user = client.get(
        "/api/chat/cloud-attachments/box/items?tenant_id=tenant-example",
        headers=headers("user-jane"),
    )
    assert other_user.status_code == 428


def test_imanage_requires_a_separate_oauth_connection_for_each_user(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    imanage_config = store.connector_configs["conncfg-imanage-example"]
    imanage_config.enabled = True
    imanage_config.auth_type = "oauth-client"
    imanage_config.settings.update(
        {
            "auth_mode": "oauth-client",
            "base_url": "https://imanage.example.test",
            "client_id": "imanage-client-id",
            "workspace_id": "WS-1042",
        }
    )
    store.set_configuration_secret("connector", imanage_config.id, "imanage-client-secret")
    store.connectors["imanage"].platform_enabled = True
    store.connectors["imanage"].tenant_enabled = True

    # No user token means no files: the shared app secret is never treated as
    # an access token and the picker asks this user to sign in.
    first_list = client.get(
        "/api/chat/cloud-attachments/imanage/items?tenant_id=tenant-example",
        headers=headers(),
    )
    assert first_list.status_code == 428
    assert "Connect your iManage account" in first_list.json()["detail"]

    authorize_response = client.get(
        "/api/chat/cloud-attachments/imanage/authorize-url?tenant_id=tenant-example",
        headers=headers(),
    )
    assert authorize_response.status_code == 200
    parts = urlsplit(authorize_response.json()["url"])
    assert parts.netloc == "imanage.example.test"
    assert parts.path == "/auth/oauth2/authorize"
    query = parse_qs(parts.query)
    assert query["client_id"] == ["imanage-client-id"]
    assert query["state"]

    monkeypatch.setattr(
        "app.core.connector_auth._post_token",
        lambda token_url, data: (
            {
                "access_token": "user-imanage-token",
                "refresh_token": "user-imanage-refresh",
                "expires_in": 3600,
            },
            None,
        ),
    )
    state = sign_oidc_state(
        {"config_id": imanage_config.id, "actor_id": "user-admin", "subject": "user"},
        get_settings().secret_key,
    )
    callback = client.get(f"/api/connector-oauth/callback?code=auth-code&state={state}")
    assert callback.status_code == 200
    assert "Account connected" in callback.text

    class FakeIManageClient:
        def list_documents(
            self,
            *,
            workspace_id: str,
            documents_endpoint=None,
            customer_id=None,
            library_id=None,
            max_items: int,
        ) -> list[CloudSourceItem]:
            assert workspace_id == "WS-1042"
            assert max_items == 100
            return [
                CloudSourceItem(
                    id="imanage-user-file",
                    type="file",
                    name="Authorized matter note.txt",
                    source_type="imanage",
                    source_uri="imanage://documents/imanage-user-file",
                    size=42,
                    mime_type="text/plain",
                )
            ]

    def fake_imanage_client(token: str, base_url: str) -> FakeIManageClient:
        assert token == "user-imanage-token"
        assert base_url == "https://imanage.example.test"
        return FakeIManageClient()

    monkeypatch.setattr("app.routes.chat.get_imanage_client", fake_imanage_client)

    connected_list = client.get(
        "/api/chat/cloud-attachments/imanage/items?tenant_id=tenant-example",
        headers=headers(),
    )
    assert connected_list.status_code == 200
    assert [item["id"] for item in connected_list.json()] == ["imanage-user-file"]

    # A second user cannot reuse the first user's token or see their files.
    other_user = client.get(
        "/api/chat/cloud-attachments/imanage/items?tenant_id=tenant-example",
        headers=headers("user-jane"),
    )
    assert other_user.status_code == 428


def test_imanage_chat_never_falls_back_to_a_shared_manual_token() -> None:
    store = get_store()
    config = store.connector_configs["conncfg-imanage-example"]
    config.enabled = True
    config.settings.update(
        {
            "auth_mode": "manual-token",
            "base_url": "https://imanage.example.test",
            "workspace_id": "WS-1042",
        }
    )
    store.set_configuration_secret("connector", config.id, "shared-imanage-token")
    store.connectors["imanage"].platform_enabled = True
    store.connectors["imanage"].tenant_enabled = True

    response = client.get(
        "/api/chat/cloud-attachments/imanage/items?tenant_id=tenant-example",
        headers=headers(),
    )
    assert response.status_code == 409
    assert "requires delegated per-user OAuth" in response.json()["detail"]
