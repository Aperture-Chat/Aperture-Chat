from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.box import BoxError, BoxItem
from app.core.cloud_sources import CloudSourceItem
from app.core.knowledge_ingestion import ExtractedSegment
from app.main import app
from app.models.schemas import KnowledgeConfig
from app.repositories.deps import get_store
from app.routes import knowledge as knowledge_route

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def test_acl_permitted_user_can_list_knowledge_documents() -> None:
    response = client.get(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers("user-jane"),
    )

    assert response.status_code == 200
    documents = response.json()
    assert len(documents) == 3
    assert documents[0]["knowledge_config_id"] == "knowledge-box-matters"
    assert documents[0]["source_uri"].startswith("box://")

    actions = [event.action for event in get_store().audit_events]
    assert actions[-1] == "knowledge.documents_listed"


def test_knowledge_document_listing_enforces_source_acl() -> None:
    get_store().users["user-casey"].group_ids = ["group-finance"]

    response = client.get(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers("user-casey"),
    )

    assert response.status_code == 403
    assert (
        response.json()["detail"]
        == "Knowledge access is restricted by tenant, group, or source ACL policy."
    )


def test_private_knowledge_base_is_visible_only_to_creator_and_admins() -> None:
    store = get_store()
    store.knowledge_configs["knowledge-private-jane"] = KnowledgeConfig(
        id="knowledge-private-jane",
        tenant_id="tenant-example",
        name="Jane Private Knowledge",
        source_type="upload",
        enabled=True,
        owner_user_id="user-jane",
        acl_group_ids=[],
        settings={
            "description": "Private uploaded knowledge.",
            "source": "Personal uploads",
            "status": "synced",
            "document_count": 0,
            "last_sync": "Just now",
            "acl": "Only me",
        },
    )

    jane_bootstrap = client.get("/api/bootstrap", headers=headers("user-jane"))
    casey_bootstrap = client.get("/api/bootstrap", headers=headers("user-casey"))
    admin_bootstrap = client.get("/api/bootstrap", headers=headers("user-admin"))

    assert "knowledge-private-jane" in {
        item["id"] for item in jane_bootstrap.json()["knowledgeConfigs"]
    }
    assert "knowledge-private-jane" not in {
        item["id"] for item in casey_bootstrap.json()["knowledgeConfigs"]
    }
    assert "knowledge-private-jane" in {
        item["id"] for item in admin_bootstrap.json()["knowledgeConfigs"]
    }

    owner_documents = client.get(
        "/api/knowledge/knowledge-private-jane/documents",
        headers=headers("user-jane"),
    )
    blocked_documents = client.get(
        "/api/knowledge/knowledge-private-jane/documents",
        headers=headers("user-casey"),
    )
    admin_documents = client.get(
        "/api/knowledge/knowledge-private-jane/documents",
        headers=headers("user-admin"),
    )

    assert owner_documents.status_code == 200
    assert owner_documents.json() == []
    assert blocked_documents.status_code == 403
    assert admin_documents.status_code == 200


def test_group_shared_knowledge_ignores_owner_and_requires_group_membership() -> None:
    store = get_store()
    store.knowledge_configs["knowledge-default-users"] = KnowledgeConfig(
        id="knowledge-default-users",
        tenant_id="tenant-example",
        name="Default group knowledge",
        source_type="upload",
        enabled=True,
        owner_user_id="user-jane",
        acl_group_ids=["group-default-users"],
        settings={"acl": "Only Jane Smith"},
    )
    store.users["user-jane"].group_ids = ["group-default-users"]
    store.users["user-casey"].group_ids = ["group-finance"]

    member_bootstrap = client.get("/api/bootstrap", headers=headers("user-jane"))
    nonmember_bootstrap = client.get("/api/bootstrap", headers=headers("user-casey"))

    assert "knowledge-default-users" in {
        item["id"] for item in member_bootstrap.json()["knowledgeConfigs"]
    }
    assert "knowledge-default-users" not in {
        item["id"] for item in nonmember_bootstrap.json()["knowledgeConfigs"]
    }

    blocked = client.get(
        "/api/knowledge/knowledge-default-users/documents",
        headers=headers("user-casey"),
    )
    assert blocked.status_code == 403


def test_tenant_admin_can_sync_knowledge_and_regular_user_cannot() -> None:
    blocked = client.post(
        "/api/knowledge/knowledge-box-matters/sync",
        json={"force": True},
        headers=headers("user-jane"),
    )
    assert blocked.status_code == 403

    response = client.post(
        "/api/knowledge/knowledge-box-matters/sync",
        json={"force": True},
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    payload = response.json()
    # The seeded connector has no credentials, so the sync honestly reports the
    # cached sample index as "stale" instead of claiming a green "synced".
    assert payload["status"] == "stale"
    assert payload["provider_status"] == "cached"
    assert payload["config"]["settings"]["status"] == "stale"
    assert payload["config"]["settings"]["document_count"] == 3
    assert payload["config"]["settings"]["last_sync"] == payload["synced_at"]
    assert len(payload["documents"]) == 3

    actions = [event.action for event in get_store().audit_events]
    assert actions[-1] == "knowledge.config_synced"


def test_box_sync_uses_live_adapter_when_connector_has_token(monkeypatch) -> None:
    store = get_store()
    store.connector_configs["conncfg-box-example"].auth_type = "developer-token"
    store.connector_configs["conncfg-box-example"].settings["auth_mode"] = "developer-token"
    store.connector_configs["conncfg-box-example"].settings["folder_id"] = "12345"
    store.set_configuration_secret("connector", "conncfg-box-example", "box-live-token")

    class FakeBoxClient:
        def list_folder_items(self, *, folder_id: str) -> list[BoxItem]:
            assert folder_id == "12345"
            return [
                BoxItem(
                    id="987",
                    type="file",
                    name="Live Box motion.txt",
                    modified_at="2026-01-02T16:05:00-07:00",
                    size=8100,
                    item_status="active",
                ),
                BoxItem(id="folder-1", type="folder", name="Nested Folder"),
            ]

        def download_file(self, *, file_id: str) -> bytes:
            assert file_id == "987"
            return b"Motion strategy: preserve processor-obligation objections and cite the protective order."

    captured_tokens: list[str | None] = []

    def fake_client(token: str | None) -> FakeBoxClient:
        captured_tokens.append(token)
        return FakeBoxClient()

    monkeypatch.setattr("app.routes.knowledge.get_box_client", fake_client)

    response = client.post(
        "/api/knowledge/knowledge-box-matters/sync",
        json={"force": True},
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert captured_tokens == ["box-live-token"]
    assert payload["provider_status"] == "live"
    assert payload["provider_message"] == (
        "Box returned 1 file records from folder 12345; indexed 1 text chunks from 1 files."
    )
    assert payload["documents"][0]["id"] == "doc-box-987"
    assert payload["documents"][0]["name"] == "Live Box motion.txt"
    assert payload["documents"][0]["source_uri"] == "box://files/987"
    assert payload["documents"][0]["chunk_count"] == 1
    assert payload["documents"][0]["acl_group_ids"] == ["group-litigation"]
    assert payload["config"]["settings"]["provider_status"] == "live"
    assert payload["config"]["settings"]["document_count"] == 1

    chunks = get_store().knowledge_chunks_for("knowledge-box-matters")
    assert len(chunks) == 1
    assert chunks[0].source_name == "Live Box motion.txt"
    assert "processor-obligation objections" in chunks[0].text

    hits = get_store().retrieve_knowledge(
        get_store().users["user-admin"],
        ["knowledge-box-matters"],
        "processor obligation objections",
    )
    assert hits[0].source_name == "Live Box motion.txt"
    assert "protective order" in hits[0].text


def test_box_sync_keeps_metadata_chunk_when_file_text_cannot_be_extracted(monkeypatch) -> None:
    store = get_store()
    store.connector_configs["conncfg-box-example"].auth_type = "developer-token"
    store.connector_configs["conncfg-box-example"].settings["auth_mode"] = "developer-token"
    store.connector_configs["conncfg-box-example"].settings["folder_id"] = "12345"
    store.set_configuration_secret("connector", "conncfg-box-example", "box-live-token")

    class FakeBoxClient:
        def list_folder_items(self, *, folder_id: str) -> list[BoxItem]:
            assert folder_id == "12345"
            return [
                BoxItem(
                    id="987",
                    type="file",
                    name="Unsupported binary.bin",
                    modified_at="2026-01-02T16:05:00-07:00",
                    size=1200,
                    item_status="active",
                )
            ]

        def download_file(self, *, file_id: str) -> bytes:
            assert file_id == "987"
            return b"\x00\x01\x02\x03"

    monkeypatch.setattr("app.routes.knowledge.get_box_client", lambda token: FakeBoxClient())

    response = client.post(
        "/api/knowledge/knowledge-box-matters/sync",
        json={"force": True},
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_message"] == (
        "Box returned 1 file records from folder 12345; indexed 1 text chunks from 0 files and kept 1 metadata-only records."
    )
    assert payload["documents"][0]["status"] == "metadata-only"
    assert payload["documents"][0]["chunk_count"] == 1

    chunks = get_store().knowledge_chunks_for("knowledge-box-matters")
    assert len(chunks) == 1
    assert chunks[0].source_name == "Unsupported binary.bin"
    assert "Full file-text extraction is not available yet" in chunks[0].text


def test_box_chunk_builder_preserves_pdf_page_provenance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = get_store().knowledge_configs["knowledge-box-matters"]
    item = BoxItem(
        id="page-source",
        type="file",
        name="Page source.pdf",
        modified_at="2026-01-02T16:05:00-07:00",
        size=1000,
        item_status="active",
    )

    class FakeBoxClient:
        def download_file(self, *, file_id: str) -> bytes:
            assert file_id == "page-source"
            return b"pdf-bytes"

    monkeypatch.setattr(
        knowledge_route,
        "extract_segments",
        lambda *_args, **_kwargs: [
            ExtractedSegment("First page text", page_start=1, page_end=1, locator="Page 1"),
            ExtractedSegment("Second page text", page_start=2, page_end=2, locator="Page 2"),
        ],
    )

    document, chunks, used_file_text = knowledge_route._box_document_and_chunks(
        config,
        item,
        FakeBoxClient(),
    )

    assert used_file_text is True
    assert document.chunk_count == 2
    assert [(chunk.page_start, chunk.page_end, chunk.locator) for chunk in chunks] == [
        (1, 1, "Page 1"),
        (2, 2, "Page 2"),
    ]


def test_box_sync_falls_back_without_folder_id_and_does_not_call_adapter(monkeypatch) -> None:
    def fake_client(token: str | None) -> object:
        raise AssertionError("Box client should not be constructed without folder_id.")

    monkeypatch.setattr("app.routes.knowledge.get_box_client", fake_client)

    response = client.post(
        "/api/knowledge/knowledge-box-matters/sync",
        json={"force": True},
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_status"] == "cached"
    assert payload["provider_message"] == "Box folder_id is not configured for this knowledge base."
    assert [document["id"] for document in payload["documents"]] == [
        "doc-box-complaint-outline",
        "doc-box-discovery-plan",
        "doc-box-client-update",
    ]


def test_box_sync_falls_back_when_adapter_errors_and_secret_stays_redacted(monkeypatch) -> None:
    store = get_store()
    store.connector_configs["conncfg-box-example"].auth_type = "developer-token"
    store.connector_configs["conncfg-box-example"].settings["auth_mode"] = "developer-token"
    store.connector_configs["conncfg-box-example"].settings["folder_id"] = "12345"
    store.set_configuration_secret("connector", "conncfg-box-example", "box-secret-token")

    class FailingBoxClient:
        def list_folder_items(self, *, folder_id: str) -> list[BoxItem]:
            raise BoxError("timeout")

    monkeypatch.setattr("app.routes.knowledge.get_box_client", lambda token: FailingBoxClient())

    response = client.post(
        "/api/knowledge/knowledge-box-matters/sync",
        json={"force": True},
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    payload_text = response.text
    assert "box-secret-token" not in payload_text
    payload = response.json()
    # Adapter failures are reported as errors, not silently served as synced cache.
    assert payload["provider_status"] == "error"
    assert payload["status"] == "error"
    assert (
        payload["provider_message"] == "Box sync failed (timeout); using cached indexed inventory."
    )
    assert payload["config"]["settings"]["status"] == "error"
    assert payload["documents"][0]["id"] == "doc-box-complaint-outline"

    latest = get_store().audit_events[-1]
    assert "box-secret-token" not in str(latest.metadata)
    assert latest.metadata["provider_status"] == "error"


def test_microsoft_graph_sync_uses_live_adapter_when_access_token_configured(monkeypatch) -> None:
    store = get_store()
    graph_config = store.connector_configs["conncfg-graph-example"]
    graph_config.auth_type = "access-token"
    graph_config.settings["auth_mode"] = "manual-token"
    graph_config.settings["drive_item_id"] = "graph-root"
    graph_config.settings["drive_id"] = "drive-123"
    store.set_configuration_secret("connector", "conncfg-graph-example", "graph-live-token")

    class FakeGraphClient:
        def list_drive_items(
            self, *, item_id: str, drive_id: str | None = None, site_id: str | None = None
        ) -> list[CloudSourceItem]:
            assert item_id == "graph-root"
            assert drive_id == "drive-123"
            assert site_id is None
            return [
                CloudSourceItem(
                    id="graph-file-1",
                    type="file",
                    name="Live Graph pleading.txt",
                    source_type="microsoft-graph",
                    source_uri="graph://drive-123/items/graph-file-1",
                    modified_at="2026-01-03T10:00:00Z",
                    size=4096,
                    item_status="active",
                    mime_type="text/plain",
                ),
                CloudSourceItem(
                    id="graph-folder",
                    type="folder",
                    name="Folder",
                    source_type="microsoft-graph",
                    source_uri="graph://drive-123/items/graph-folder",
                ),
            ]

        def download_file(self, *, file_id: str, drive_id: str | None = None) -> bytes:
            assert file_id == "graph-file-1"
            assert drive_id == "drive-123"
            return b"Graph pleading source: preserve jurisdictional defenses and cite the SharePoint strategy memo."

    captured_tokens: list[str | None] = []

    def fake_client(token: str | None) -> FakeGraphClient:
        captured_tokens.append(token)
        return FakeGraphClient()

    monkeypatch.setattr("app.routes.knowledge.get_microsoft_graph_client", fake_client)

    response = client.post(
        "/api/knowledge/knowledge-litigation-playbook/sync",
        json={"force": True},
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert captured_tokens == ["graph-live-token"]
    assert payload["provider_status"] == "live"
    assert payload["provider_message"] == (
        "Microsoft Graph returned 1 file records from graph-root; indexed 1 text chunks from 1 files."
    )
    assert payload["documents"][0]["name"] == "Live Graph pleading.txt"
    assert payload["documents"][0]["source_type"] == "microsoft-graph"

    chunks = get_store().knowledge_chunks_for("knowledge-litigation-playbook")
    assert len(chunks) == 1
    assert "SharePoint strategy memo" in chunks[0].text


def test_google_drive_sync_uses_live_adapter_when_access_token_configured(monkeypatch) -> None:
    store = get_store()
    drive_config = store.connector_configs["conncfg-google-drive-example"]
    drive_config.auth_type = "access-token"
    drive_config.settings["auth_mode"] = "manual-token"
    drive_config.settings["folder_id"] = "folder-123"
    store.set_configuration_secret("connector", "conncfg-google-drive-example", "drive-live-token")

    class FakeDriveClient:
        def list_files(self, *, folder_id: str) -> list[CloudSourceItem]:
            assert folder_id == "folder-123"
            return [
                CloudSourceItem(
                    id="drive-file-1",
                    type="file",
                    name="Live Drive policy",
                    source_type="google-drive",
                    source_uri="gdrive://files/drive-file-1",
                    modified_at="2026-01-04T10:00:00Z",
                    size=2048,
                    item_status="active",
                    mime_type="application/vnd.google-apps.document",
                )
            ]

        def download_file(self, *, file_id: str, mime_type: str | None = None) -> bytes:
            assert file_id == "drive-file-1"
            assert mime_type == "application/vnd.google-apps.document"
            return b"Google Drive policy source: approved AI use requires ACL enforcement and retained citations."

    monkeypatch.setattr(
        "app.routes.knowledge.get_google_drive_client", lambda token: FakeDriveClient()
    )

    response = client.post(
        "/api/knowledge/knowledge-policy-library/sync",
        json={"force": True},
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_status"] == "live"
    assert payload["provider_message"] == (
        "Google Drive returned 1 file records from folder-123; indexed 1 text chunks from 1 files."
    )
    assert payload["documents"][0]["source_type"] == "google-drive"
    assert (
        "retained citations" in get_store().knowledge_chunks_for("knowledge-policy-library")[0].text
    )


def test_cloud_chunk_builder_preserves_slide_locator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = get_store().knowledge_configs["knowledge-litigation-playbook"]
    item = CloudSourceItem(
        id="deck-1",
        type="file",
        name="Strategy deck.pptx",
        source_type="microsoft-graph",
        source_uri="graph://items/deck-1",
        modified_at="2026-01-03T10:00:00Z",
        size=2048,
        item_status="active",
        mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )

    class FakeCloudClient:
        def download_file(self, *, file_id: str, mime_type: str | None = None) -> bytes:
            assert file_id == "deck-1"
            assert mime_type == item.mime_type
            return b"pptx-bytes"

    monkeypatch.setattr(
        knowledge_route,
        "extract_segments",
        lambda *_args, **_kwargs: [
            ExtractedSegment("Overview", locator="Slide 1"),
            ExtractedSegment("Risk analysis", locator="Slide 2"),
        ],
    )

    document, chunks, used_file_text = knowledge_route._cloud_document_and_chunks(
        config,
        item,
        FakeCloudClient(),
        download_kwargs={},
    )

    assert used_file_text is True
    assert document.chunk_count == 2
    assert [chunk.locator for chunk in chunks] == ["Slide 1", "Slide 2"]
    assert all(chunk.page_start is None and chunk.page_end is None for chunk in chunks)


def test_imanage_sync_uses_live_adapter_when_access_token_configured(monkeypatch) -> None:
    store = get_store()
    imanage_config = store.connector_configs["conncfg-imanage-example"]
    imanage_config.enabled = True
    imanage_config.auth_type = "access-token"
    imanage_config.settings["auth_mode"] = "manual-token"
    imanage_config.settings["workspace_id"] = "WS-1042"
    imanage_config.settings["base_url"] = "https://imanage.example.test"
    store.set_configuration_secret("connector", "conncfg-imanage-example", "imanage-live-token")

    class FakeIManageClient:
        def list_documents(
            self,
            *,
            workspace_id: str,
            documents_endpoint: str | None = None,
            customer_id: str | None = None,
            library_id: str | None = None,
        ) -> list[CloudSourceItem]:
            assert workspace_id == "WS-1042"
            return [
                CloudSourceItem(
                    id="imanage-doc-1",
                    type="file",
                    name="Live iManage work product.txt",
                    source_type="imanage",
                    source_uri="imanage://WS-1042/documents/imanage-doc-1",
                    modified_at="2026-01-05T10:00:00Z",
                    size=1024,
                    item_status="indexed",
                    mime_type="text/plain",
                )
            ]

        def download_file(self, *, file_id: str) -> bytes:
            assert file_id == "imanage-doc-1"
            return b"iManage source: partner-approved analysis must stay internal until attorney review."

    captured_args: list[tuple[str | None, str]] = []

    def fake_client(token: str | None, base_url: str) -> FakeIManageClient:
        captured_args.append((token, base_url))
        return FakeIManageClient()

    monkeypatch.setattr("app.routes.knowledge.get_imanage_client", fake_client)

    response = client.post(
        "/api/knowledge/knowledge-imanage-workspace/sync",
        json={"force": True},
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert captured_args == [("imanage-live-token", "https://imanage.example.test")]
    assert payload["provider_status"] == "live"
    assert payload["provider_message"] == (
        "iManage returned 1 file records from WS-1042; indexed 1 text chunks from 1 files."
    )
    assert payload["documents"][0]["source_type"] == "imanage"
    assert (
        "attorney review" in get_store().knowledge_chunks_for("knowledge-imanage-workspace")[0].text
    )


def test_microsoft_graph_sync_falls_back_without_access_token_and_does_not_call_adapter(
    monkeypatch,
) -> None:
    def fake_client(token: str | None) -> object:
        raise AssertionError(
            "Microsoft Graph client should not be constructed without an access token."
        )

    monkeypatch.setattr("app.routes.knowledge.get_microsoft_graph_client", fake_client)

    response = client.post(
        "/api/knowledge/knowledge-litigation-playbook/sync",
        json={"force": True},
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_status"] == "cached"
    assert payload["status"] == "stale"
    # The seeded Graph connector uses client-credentials: the message names the
    # exact credential fields that are still missing (tenant ID and client secret).
    assert payload["provider_message"] == (
        "Microsoft Graph client-credentials authentication is missing required fields: "
        "Tenant ID (tenant_id), Client secret (secret_value). Save them on the connector configuration."
    )
    assert [document["id"] for document in payload["documents"]] == [
        "doc-graph-pleading-template",
        "doc-graph-discovery-objections",
    ]
