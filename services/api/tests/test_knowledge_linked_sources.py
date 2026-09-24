"""Linked knowledge sources: API fetches, Sync semantics, and upload honesty."""

from __future__ import annotations

import json
from io import BytesIO
from typing import Any, Callable

import httpx
import pytest
from fastapi.testclient import TestClient

import app.core.api_source_fetch as api_fetch
from app.core.config import get_settings
from app.main import app
from app.models.schemas import KnowledgeConfig
from app.repositories.deps import get_store
from app.routes import chat as chat_route
from app.routes import knowledge as knowledge_route

client = TestClient(app)
CONFIG_ID = "knowledge-box-matters"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _mock_api(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> list[httpx.Request]:
    """Route API-source fetches through the real fetcher onto a mock transport."""
    seen: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(api_fetch, "validate_public_url", lambda _url: None)
    real_fetch = api_fetch.fetch_api_source
    monkeypatch.setattr(
        knowledge_route,
        "fetch_api_source",
        lambda request, **kwargs: real_fetch(
            request, transport=httpx.MockTransport(recording), **kwargs
        ),
    )
    return seen


def _upload_only_config() -> KnowledgeConfig:
    store = get_store()
    config = KnowledgeConfig(
        id="knowledge-uploads-only",
        tenant_id="tenant-example",
        name="Uploads Only",
        source_type="upload",
        enabled=True,
        owner_user_id="user-admin",
        acl_group_ids=["group-litigation"],
        settings={"status": "draft", "document_count": 0, "last_sync": "Not synced"},
    )
    store.knowledge_configs[config.id] = config
    return config


def _api_documents(config_id: str = CONFIG_ID) -> list[Any]:
    return [
        document
        for document in get_store().knowledge_documents_for(config_id)
        if document.source_type == "api"
    ]


def test_api_key_source_fetches_real_data_and_never_indexes_the_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Matter-Key"] == "api-key-secret"
        assert request.headers["X-Client"] == "aperture"
        return httpx.Response(
            200,
            json={
                "matters": [
                    {"name": "Harbor v. Beacon", "deadline": "July 8", "status": "open"},
                    {"name": "Estate of Marlow", "deadline": "August 2", "status": "stayed"},
                ]
            },
        )

    seen = _mock_api(monkeypatch, handler)
    response = client.post(
        f"/api/knowledge/{CONFIG_ID}/api-sources",
        headers=headers("user-admin"),
        json={
            "name": "Matter API",
            "base_url": "https://api.example.test",
            "path": "/v1/matters?status=all",
            "headers": "X-Client: aperture",
            "auth_type": "api-key",
            "credential_name": "X-Matter-Key",
            "credential_location": "header",
            "secret_value": "api-key-secret",
        },
    )

    assert response.status_code == 200, response.text
    assert len(seen) == 1
    assert str(seen[0].url) == "https://api.example.test/v1/matters?status=all"
    body = response.json()
    assert body["provider_status"] == "live"
    assert "Fetched Matter API" in body["provider_message"]
    [document] = _api_documents()
    assert document.source_uri == "https://api.example.test/v1/matters?status=all"
    store = get_store()
    chunk_text = "\n".join(
        chunk.text for chunk in store.knowledge_chunks_for(CONFIG_ID) if chunk.document_id == document.id
    )
    assert "matters[0].name: Harbor v. Beacon" in chunk_text
    assert "matters[1].deadline: August 2" in chunk_text
    assert "api-key-secret" not in chunk_text
    assert store.configuration_secret("knowledge-api-source", f"{CONFIG_ID}:{document.id}") == (
        "api-key-secret"
    )
    hits = store.retrieve_knowledge(store.users["user-admin"], [CONFIG_ID], "Harbor Beacon deadline", limit=3)
    assert hits and "Harbor v. Beacon" in hits[0].text
    assert "api-key-secret" not in json.dumps(store.audit_events[-1].metadata)


def test_query_api_key_is_sent_but_kept_out_of_the_stored_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["api_key"] == "query-secret"
        return httpx.Response(200, text="Filing calendar: motion hearing on July 8.")

    _mock_api(monkeypatch, handler)
    response = client.post(
        f"/api/knowledge/{CONFIG_ID}/api-sources",
        headers=headers("user-admin"),
        json={
            "name": "Docket",
            "base_url": "https://api.example.test/docket",
            "auth_type": "api-key",
            "credential_name": "api_key",
            "credential_location": "query",
            "secret_value": "query-secret",
        },
    )

    assert response.status_code == 200, response.text
    [document] = _api_documents()
    assert document.source_uri == "https://api.example.test/docket"
    assert "query-secret" not in response.text


def test_failed_api_request_creates_nothing_and_stores_no_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_api(monkeypatch, lambda _request: httpx.Response(401, json={"error": "bad key"}))
    response = client.post(
        f"/api/knowledge/{CONFIG_ID}/api-sources",
        headers=headers("user-admin"),
        json={
            "name": "Review API",
            "base_url": "https://api.example.test/review",
            "auth_type": "bearer-token",
            "secret_value": "wrong-token",
        },
    )

    assert response.status_code == 502
    assert "returned HTTP 401" in response.json()["detail"]
    assert _api_documents() == []
    store = get_store()
    assert not any(
        key.startswith(f"knowledge-api-source:{CONFIG_ID}:") for key in store._configuration_secrets  # noqa: SLF001
    )
    assert "linked_sources" not in store.knowledge_configs[CONFIG_ID].settings


def test_api_redirects_are_refused_so_credentials_never_follow_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_api(
        monkeypatch,
        lambda _request: httpx.Response(302, headers={"location": "https://elsewhere.test/collect"}),
    )
    response = client.post(
        f"/api/knowledge/{CONFIG_ID}/api-sources",
        headers=headers("user-admin"),
        json={
            "name": "Moved API",
            "base_url": "https://api.example.test/old",
            "auth_type": "bearer-token",
            "secret_value": "token",
        },
    )
    assert response.status_code == 502
    assert "redirected to https://elsewhere.test/collect" in response.json()["detail"]


def test_reserved_and_malformed_headers_are_rejected() -> None:
    for header_text in ("Host: evil.test", "not a header"):
        response = client.post(
            f"/api/knowledge/{CONFIG_ID}/api-sources",
            headers=headers("user-admin"),
            json={"name": "x", "base_url": "https://api.example.test", "headers": header_text},
        )
        assert response.status_code == 400


def test_sync_refreshes_linked_sources_in_place_and_leaves_uploads_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _upload_only_config()
    upload = client.post(
        f"/api/knowledge/{config.id}/documents",
        headers=headers("user-admin"),
        files=[("files", ("brief.txt", BytesIO(b"The brief is due in May."), "text/plain"))],
    )
    assert upload.status_code == 200
    uploaded = next(item for item in upload.json()["documents"] if item["name"] == "brief.txt")

    payload = {"deadline": "July 8"}
    _mock_api(monkeypatch, lambda _request: httpx.Response(200, json=payload))
    added = client.post(
        f"/api/knowledge/{config.id}/api-sources",
        headers=headers("user-admin"),
        json={"name": "Deadlines", "base_url": "https://api.example.test/deadlines"},
    )
    assert added.status_code == 200, added.text
    [api_document] = _api_documents(config.id)

    payload["deadline"] = "September 30"
    synced = client.post(f"/api/knowledge/{config.id}/sync", headers=headers("user-admin"), json={"force": True})

    assert synced.status_code == 200, synced.text
    body = synced.json()
    assert body["status"] == "synced"
    assert body["provider_message"] == "Refreshed 1 linked source."
    [refreshed] = _api_documents(config.id)
    assert refreshed.id == api_document.id
    store = get_store()
    texts = [chunk.text for chunk in store.knowledge_chunks_for(config.id) if chunk.document_id == refreshed.id]
    assert texts == ["deadline: September 30"]
    brief = next(item for item in body["documents"] if item["name"] == "brief.txt")
    assert brief["updated_at"] == uploaded["updated_at"]
    assert brief["id"] == uploaded["id"]


def test_failed_refresh_keeps_previous_content_and_reports_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    responses = [httpx.Response(200, json={"deadline": "July 8"}), httpx.Response(503, text="down")]
    _mock_api(monkeypatch, lambda _request: responses.pop(0))
    added = client.post(
        f"/api/knowledge/{CONFIG_ID}/api-sources",
        headers=headers("user-admin"),
        json={"name": "Deadlines", "base_url": "https://api.example.test/deadlines"},
    )
    assert added.status_code == 200
    config = get_store().knowledge_configs[CONFIG_ID]
    config.source_type = "upload"  # use linked-source sync instead of the Box adapter

    synced = client.post(f"/api/knowledge/{CONFIG_ID}/sync", headers=headers("user-admin"))

    assert synced.status_code == 200
    body = synced.json()
    assert body["status"] == "error"
    assert "Could not refresh Deadlines" in body["provider_message"]
    assert "Their previous content is kept." in body["provider_message"]
    [document] = _api_documents()
    texts = [c.text for c in get_store().knowledge_chunks_for(CONFIG_ID) if c.document_id == document.id]
    assert texts == ["deadline: July 8"]


def test_sync_on_upload_only_knowledge_base_changes_nothing() -> None:
    config = _upload_only_config()
    upload = client.post(
        f"/api/knowledge/{config.id}/documents",
        headers=headers("user-admin"),
        files=[("files", ("brief.txt", BytesIO(b"The brief is due in May."), "text/plain"))],
    )
    assert upload.status_code == 200
    before = get_store().knowledge_configs[config.id].settings.copy()
    before_documents = upload.json()["documents"]

    synced = client.post(f"/api/knowledge/{config.id}/sync", headers=headers("user-admin"))

    assert synced.status_code == 200
    body = synced.json()
    assert body["provider_status"] == "unchanged"
    assert body["status"] == "synced"
    assert body["provider_message"].startswith("Nothing to sync.")
    assert body["documents"] == before_documents
    after = get_store().knowledge_configs[config.id].settings
    assert after["status"] == before["status"] == "synced"
    assert after["last_sync"] == before["last_sync"]


def test_deleting_a_linked_document_forgets_its_refresh_recipe_and_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_api(monkeypatch, lambda _request: httpx.Response(200, json={"ok": True}))
    config = _upload_only_config()
    added = client.post(
        f"/api/knowledge/{config.id}/api-sources",
        headers=headers("user-admin"),
        json={
            "name": "Status API",
            "base_url": "https://api.example.test/status",
            "auth_type": "bearer-token",
            "secret_value": "status-token",
        },
    )
    assert added.status_code == 200
    [document] = _api_documents(config.id)
    store = get_store()
    assert store.configuration_secret("knowledge-api-source", f"{config.id}:{document.id}")

    deleted = client.delete(
        f"/api/knowledge/{config.id}/documents/{document.id}", headers=headers("user-admin")
    )

    assert deleted.status_code == 200
    assert store.configuration_secret("knowledge-api-source", f"{config.id}:{document.id}") is None
    assert store.knowledge_configs[config.id].settings["linked_sources"] == []
    synced = client.post(f"/api/knowledge/{config.id}/sync", headers=headers("user-admin"))
    assert synced.json()["provider_status"] == "unchanged"


def test_upload_reports_truncation_and_unreadable_files(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(get_settings(), "knowledge_max_extracted_chars", 100_000)
    long_text = ("Clause " + "x" * 90 + ".\n\n") * 1_500  # ~150k characters

    upload = client.post(
        f"/api/knowledge/{CONFIG_ID}/documents",
        headers=headers("user-admin"),
        files=[("files", ("long.txt", BytesIO(long_text.encode()), "text/plain"))],
    )

    assert upload.status_code == 200, upload.text
    message = upload.json()["provider_message"]
    assert "Only the first 100,000 characters of long.txt were indexed." in message
    document = next(item for item in upload.json()["documents"] if item["name"] == "long.txt")
    chunks = [
        chunk for chunk in get_store().knowledge_chunks_for(CONFIG_ID) if chunk.document_id == document["id"]
    ]
    assert sum(len(chunk.text) for chunk in chunks) < 120_000

    exact = client.post(
        f"/api/knowledge/{CONFIG_ID}/documents",
        headers=headers("user-admin"),
        files=[("files", ("short.txt", BytesIO(b"Short and complete."), "text/plain"))],
    )
    assert "were indexed" not in exact.json()["provider_message"].split("Indexed", 2)[-1]
    assert exact.json()["provider_message"] == "Indexed 1 of 1 uploaded file (1 passage)."

    unreadable = client.post(
        f"/api/knowledge/{CONFIG_ID}/documents",
        headers=headers("user-admin"),
        files=[("files", ("scan.pdf", BytesIO(b"%PDF-1.4 broken"), "application/pdf"))],
    )
    assert unreadable.status_code == 200
    assert "No readable text was found in scan.pdf" in unreadable.json()["provider_message"]
    assert unreadable.json()["provider_message"].startswith("Indexed 0 of 1 uploaded file")


def test_index_status_reports_semantic_search_state() -> None:
    response = client.get(f"/api/knowledge/{CONFIG_ID}/index-status", headers=headers("user-admin"))
    assert response.status_code == 200
    body = response.json()
    assert body["knowledge_config_id"] == CONFIG_ID
    assert body["semantic_search"] == "off"  # dense embeddings are disabled in tests
    assert body["total_chunks"] > 0
    assert body["pending_chunks"] == 0

    denied = client.get(f"/api/knowledge/{CONFIG_ID}/index-status", headers=headers("user-casey"))
    get_store().users["user-casey"].group_ids = ["group-finance"]
    denied = client.get(f"/api/knowledge/{CONFIG_ID}/index-status", headers=headers("user-casey"))
    assert denied.status_code == 403


def test_sharing_a_knowledge_base_with_a_new_group_reaches_its_chunks() -> None:
    store = get_store()
    casey = store.users["user-casey"]
    casey.group_ids = ["group-corporate"]
    assert store.retrieve_knowledge(casey, [CONFIG_ID], "motion", limit=5) == []

    response = client.patch(
        f"/api/admin/knowledge-configs/{CONFIG_ID}",
        headers=headers("user-admin"),
        json={"acl_group_ids": ["group-litigation", "group-corporate"]},
    )

    assert response.status_code == 200, response.text
    hits = store.retrieve_knowledge(casey, [CONFIG_ID], "motion", limit=5)
    assert hits
    assert all("group-corporate" in hit.acl_group_ids for hit in hits)
    persisted = store.vector_store.chunks_for(CONFIG_ID)
    assert all(chunk.acl_group_ids == ["group-litigation", "group-corporate"] for chunk in persisted)


def test_tenant_admin_outside_the_group_can_still_search_tenant_knowledge() -> None:
    store = get_store()
    admin = store.users["user-admin"]
    admin.group_ids = []
    hits = store.retrieve_knowledge(admin, [CONFIG_ID], "motion", limit=5)
    assert hits


def test_enabled_toggle_patch_does_not_rewrite_status() -> None:
    store = get_store()
    config = store.knowledge_configs[CONFIG_ID]
    config.settings = {**config.settings, "status": "synced", "last_sync": "Jan 2, 2026, 4:05 PM UTC"}

    off = client.patch(
        f"/api/admin/knowledge-configs/{CONFIG_ID}", headers=headers("user-admin"), json={"enabled": False}
    )
    on = client.patch(
        f"/api/admin/knowledge-configs/{CONFIG_ID}", headers=headers("user-admin"), json={"enabled": True}
    )

    assert off.status_code == on.status_code == 200
    assert on.json()["settings"]["status"] == "synced"
    assert on.json()["settings"]["last_sync"] == "Jan 2, 2026, 4:05 PM UTC"


def test_disabled_knowledge_base_is_skipped_for_agent_profiles_only() -> None:
    store = get_store()
    store.knowledge_configs[CONFIG_ID].enabled = False
    assert chat_route._enabled_knowledge_ids(store, [CONFIG_ID, "knowledge-missing"]) == [  # noqa: SLF001
        "knowledge-missing"
    ]
    store.knowledge_configs[CONFIG_ID].enabled = True
    assert chat_route._enabled_knowledge_ids(store, [CONFIG_ID]) == [CONFIG_ID]  # noqa: SLF001


def test_chat_with_agent_whose_knowledge_base_is_off_answers_without_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    store.groups["group-litigation"].permissions["hermes_companion"] = True
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    store.create_provider_key(
        key_id="key-openrouter-disabled-kb",
        provider=provider,
        name="Disabled KB Key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="disabled-kb-test-key",
    )

    class FakeGateway:
        def complete(self, **_kwargs: object) -> dict[str, object]:
            return {
                "id": "gen-disabled-kb",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Answer without that base"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
            }

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: FakeGateway())
    store.knowledge_configs[CONFIG_ID].enabled = False
    approval = client.post("/api/tools/tool-hermes-agent-mcp/approve", headers=headers("user-admin"))
    assert approval.status_code == 200

    response = client.post(
        "/api/chat/complete",
        headers=headers("user-admin"),
        json={
            "model": "agent-client-update",
            "agent_profile_id": "agent-client-update",
            "messages": [{"role": "user", "content": "Prepare the client update package."}],
            "agent_enabled": True,
            "approval_tokens": [approval.json()["approval_token"]],
        },
    )

    assert response.status_code == 200, response.text
    assert not any(citation["source_type"] == "box" for citation in response.json()["citations"])
    runtime = store.audit_events[-1].metadata["runtime_context"]
    assert CONFIG_ID not in runtime["knowledge_config_ids"]

    explicit = client.post(
        "/api/chat/complete",
        headers=headers("user-admin"),
        json={
            "model": "agent-client-update",
            "messages": [{"role": "user", "content": "Use the box base."}],
            "knowledge_config_ids": [CONFIG_ID],
        },
    )
    assert explicit.status_code == 403


def test_managers_can_inspect_a_turned_off_knowledge_base_but_readers_cannot() -> None:
    store = get_store()
    store.knowledge_configs[CONFIG_ID].enabled = False
    admin = client.get(f"/api/knowledge/{CONFIG_ID}/documents", headers=headers("user-admin"))
    assert admin.status_code == 200
    assert admin.json()
    reader = client.get(f"/api/knowledge/{CONFIG_ID}/documents", headers=headers("user-jane"))
    assert reader.status_code == 403
    status_response = client.get(f"/api/knowledge/{CONFIG_ID}/index-status", headers=headers("user-admin"))
    assert status_response.status_code == 200
