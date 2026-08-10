from __future__ import annotations

from io import BytesIO

import pytest
from fastapi.testclient import TestClient

from app.core.knowledge_ingestion import ExtractedSegment
from app.core.security import SecretVault
from app.core.vector_store import LocalVectorStore
from app.main import app
from app.models.schemas import KnowledgeChunk, KnowledgeDocument
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes import knowledge as knowledge_route

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _mcp_approval_tokens(
    user_id: str = "user-admin", config_id: str = "tool-hermes-agent-mcp"
) -> list[str]:
    resp = client.post(f"/api/tools/{config_id}/approve", headers=headers(user_id))
    assert resp.status_code == 200
    return [resp.json()["approval_token"]]


def test_vector_store_persists_sources_across_store_restarts(tmp_path) -> None:
    vector_db_path = tmp_path / "knowledge-vectors.sqlite3"
    runtime_state_path = tmp_path / "runtime-state.json"
    store = SeedStore(
        SecretVault("test-secret"),
        runtime_state_path=str(runtime_state_path),
        vector_db_path=str(vector_db_path),
    )
    config = store.knowledge_configs["knowledge-box-matters"]
    document = KnowledgeDocument(
        id="doc-persistent-source",
        knowledge_config_id=config.id,
        tenant_id=config.tenant_id,
        name="Persistent client source.txt",
        source_uri="upload://persistent/client-source.txt",
        source_type="upload",
        status="indexed",
        chunk_count=1,
        acl_group_ids=list(config.acl_group_ids),
        updated_at="Restart test",
        citation_required=True,
    )
    chunk = KnowledgeChunk(
        id="chunk-persistent-source-1",
        knowledge_config_id=config.id,
        document_id=document.id,
        tenant_id=document.tenant_id,
        source_name=document.name,
        source_uri=document.source_uri,
        source_type=document.source_type,
        text="Persistent alpha deadline context survives a backend restart.",
        ordinal=0,
        page_start=7,
        page_end=7,
        locator="Page 7",
        acl_group_ids=document.acl_group_ids,
        updated_at=document.updated_at,
    )
    store.append_knowledge_sources(
        config,
        [document],
        [chunk],
        synced_at="Restart test",
        provider_status="live",
        provider_message="Persisted test source.",
    )
    store.flush_now()
    store.close()

    restarted = SeedStore(
        SecretVault("test-secret"),
        runtime_state_path=str(runtime_state_path),
        vector_db_path=str(vector_db_path),
    )
    documents = restarted.knowledge_documents_for("knowledge-box-matters")
    assert any(item.id == "doc-persistent-source" for item in documents)
    assert restarted.knowledge_configs["knowledge-box-matters"].settings["document_count"] == 4

    hits = restarted.retrieve_knowledge(
        restarted.users["user-admin"],
        ["knowledge-box-matters"],
        "persistent alpha deadline restart",
        limit=3,
    )
    assert hits[0].source_name == "Persistent client source.txt"
    assert hits[0].score > 0
    assert hits[0].page_start == 7
    assert hits[0].page_end == 7
    assert hits[0].locator == "Page 7"
    restarted.close()


def test_vector_store_uses_dense_semantics_without_keyword_overlap() -> None:
    class SemanticEmbedder:
        def passage_embed(self, texts: list[str], *, batch_size: int):
            del batch_size
            for text in texts:
                yield [1.0, 0.0] if "automobile" in text.lower() else [0.0, 1.0]

        def query_embed(self, query: str):
            assert query == "vehicle"
            yield [1.0, 0.0]

    store = SeedStore(SecretVault("test-secret"))
    actor = store.users["user-admin"]
    vector_store = LocalVectorStore(
        ":memory:",
        dense_embeddings_enabled=True,
        dense_embedder=SemanticEmbedder(),
    )
    document = KnowledgeDocument(
        id="doc-semantic",
        knowledge_config_id="knowledge-box-matters",
        tenant_id="tenant-example",
        name="Semantic examples",
        source_uri="upload://semantic.txt",
        source_type="upload",
        status="indexed",
        chunk_count=2,
        acl_group_ids=[],
        updated_at="Semantic test",
        citation_required=True,
    )
    chunks = [
        KnowledgeChunk(
            id="chunk-automobile",
            knowledge_config_id=document.knowledge_config_id,
            document_id=document.id,
            tenant_id=document.tenant_id,
            source_name=document.name,
            source_uri=document.source_uri,
            source_type=document.source_type,
            text="The automobile policy renews next month.",
            ordinal=0,
            acl_group_ids=[],
            updated_at=document.updated_at,
        ),
        KnowledgeChunk(
            id="chunk-discovery",
            knowledge_config_id=document.knowledge_config_id,
            document_id=document.id,
            tenant_id=document.tenant_id,
            source_name=document.name,
            source_uri=document.source_uri,
            source_type=document.source_type,
            text="The discovery deadline is Friday.",
            ordinal=1,
            acl_group_ids=[],
            updated_at=document.updated_at,
        ),
    ]
    vector_store.upsert_sources([document], chunks)

    hits = vector_store.search(
        actor,
        [document.knowledge_config_id],
        "vehicle",
        limit=2,
    )

    assert hits[0].id == "chunk-automobile"
    assert hits[0].score > 1.0


def test_knowledge_sources_upload_web_and_api_are_indexed() -> None:
    upload = client.post(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers("user-admin"),
        files=[
            (
                "files",
                (
                    "client-note.txt",
                    BytesIO(b"Client update should lead with response deadline."),
                    "text/plain",
                ),
            )
        ],
    )
    assert upload.status_code == 200
    uploaded = upload.json()
    assert uploaded["provider_status"] == "live"
    assert any(document["name"] == "client-note.txt" for document in uploaded["documents"])

    web = client.post(
        "/api/knowledge/knowledge-box-matters/web-sources",
        headers=headers("user-admin"),
        json={
            "name": "Court docket",
            "url": "https://example.test/docket",
            "text": "Docket source says the hearing moved to July 8.",
        },
    )
    assert web.status_code == 200
    assert any(document["source_type"] == "web" for document in web.json()["documents"])

    api = client.post(
        "/api/knowledge/knowledge-box-matters/api-sources",
        headers=headers("user-admin"),
        json={
            "name": "Matter API",
            "base_url": "https://api.example.test/matters",
            "auth_type": "oauth-client",
            "client_id": "matter-client-id",
            "authorization_url": "https://login.example.test/oauth/authorize",
            "token_url": "https://login.example.test/oauth/token",
            "callback_url": "https://aperture.example.test/oauth/knowledge/callback",
            "scopes": ["matters.read", "documents.read"],
            "audience": "tenant-example",
            "secret_value": "oauth-client-secret",
            "description": "Matter API exposes client decisions and deadlines.",
        },
    )
    assert api.status_code == 200
    body = api.json()
    assert (
        body["provider_message"]
        == "Registered API source Matter API and stored the credential in the backend vault."
    )
    assert any(document["source_type"] == "api" for document in body["documents"])

    api_key = client.post(
        "/api/knowledge/knowledge-box-matters/api-sources",
        headers=headers("user-admin"),
        json={
            "name": "Docket API key",
            "base_url": "https://api.example.test/docket",
            "auth_type": "api-key",
            "credential_name": "X-Matter-Key",
            "credential_location": "query",
            "secret_value": "api-key-secret",
            "description": "Docket API exposes filing calendar metadata.",
        },
    )
    assert api_key.status_code == 200

    bearer = client.post(
        "/api/knowledge/knowledge-box-matters/api-sources",
        headers=headers("user-admin"),
        json={
            "name": "Review API bearer",
            "base_url": "https://api.example.test/review",
            "auth_type": "bearer-token",
            "secret_value": "bearer-token-secret",
            "description": "Review API exposes matter review status.",
        },
    )
    assert bearer.status_code == 200

    hits = get_store().retrieve_knowledge(
        get_store().users["user-admin"],
        ["knowledge-box-matters"],
        "deadline docket client decisions matter-client-id matters.read X-Matter-Key Authorization Bearer",
        limit=20,
    )
    assert {hit.source_type for hit in hits}.intersection({"upload", "web", "api"})
    api_hit_text = "\n".join(hit.text for hit in hits if hit.source_type == "api")
    assert "matter-client-id" in api_hit_text
    assert "matters.read" in api_hit_text
    assert "X-Matter-Key" in api_hit_text
    assert "query" in api_hit_text
    assert "Authorization header: Bearer token" in api_hit_text
    assert "oauth-client-secret" not in api_hit_text
    assert "api-key-secret" not in api_hit_text
    assert "bearer-token-secret" not in api_hit_text

    search = client.post(
        "/api/knowledge/search",
        headers=headers("user-admin"),
        json={
            "query": "July 8 hearing docket and client deadline",
            "knowledge_config_ids": ["knowledge-box-matters"],
            "limit": 5,
        },
    )
    assert search.status_code == 200
    search_body = search.json()
    assert search_body["knowledge_config_ids"] == ["knowledge-box-matters"]
    assert search_body["hits"]
    assert search_body["hits"][0]["score"] > 0
    assert any(hit["source_type"] in {"upload", "web", "api"} for hit in search_body["hits"])

    agent_search = client.post(
        "/api/knowledge/search",
        headers=headers("user-admin"),
        json={
            "query": "client update package",
            "agent_profile_id": "agent-client-update",
            "limit": 5,
        },
    )
    assert agent_search.status_code == 200
    assert "knowledge-box-matters" in agent_search.json()["knowledge_config_ids"]


def test_uploaded_document_is_chunked_and_retrievable_from_sparse_vector_index() -> None:
    paragraphs = [
        f"Section {section}. "
        + " ".join(f"retention-clause-{section}-{word}" for word in range(90))
        for section in range(8)
    ]
    paragraphs[-1] += " Unique zephyrquartz deadline marker for vector retrieval."

    upload = client.post(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers("user-admin"),
        files=[
            (
                "files",
                (
                    "long-retention-guidance.txt",
                    BytesIO("\n\n".join(paragraphs).encode("utf-8")),
                    "text/plain",
                ),
            )
        ],
    )

    assert upload.status_code == 200
    document = next(
        item for item in upload.json()["documents"] if item["name"] == "long-retention-guidance.txt"
    )
    assert document["status"] == "indexed"
    assert document["chunk_count"] >= 4

    store = get_store()
    chunks = [
        chunk
        for chunk in store.knowledge_chunks_for("knowledge-box-matters")
        if chunk.document_id == document["id"]
    ]
    assert len(chunks) == document["chunk_count"]
    assert all(chunk.text for chunk in chunks)

    hits = store.retrieve_knowledge(
        store.users["user-admin"],
        ["knowledge-box-matters"],
        "zephyrquartz deadline marker",
        limit=3,
    )
    assert hits[0].document_id == document["id"]
    assert hits[0].score > 0


def test_uploaded_xlsx_chunks_persist_sheet_locators() -> None:
    openpyxl = pytest.importorskip("openpyxl")
    workbook = openpyxl.Workbook()
    summary = workbook.active
    summary.title = "Summary"
    summary.append(["Metric", "Value"])
    summary.append(["Revenue", 5000000])
    risks = workbook.create_sheet("Risks")
    risks.append(["Risk", "Level"])
    risks.append(["Concentration", "High"])
    buffer = BytesIO()
    workbook.save(buffer)
    workbook.close()

    upload = client.post(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers("user-admin"),
        files=[
            (
                "files",
                (
                    "deal-model.xlsx",
                    BytesIO(buffer.getvalue()),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ),
            )
        ],
    )

    assert upload.status_code == 200
    document = next(
        item for item in upload.json()["documents"] if item["name"] == "deal-model.xlsx"
    )
    chunks = [
        chunk
        for chunk in get_store().knowledge_chunks_for("knowledge-box-matters")
        if chunk.document_id == document["id"]
    ]
    assert [chunk.locator for chunk in chunks] == ["Sheet: Summary", "Sheet: Risks"]
    assert all(chunk.page_start is None and chunk.page_end is None for chunk in chunks)
    assert "Revenue | 5000000" in chunks[0].text


def test_malformed_msg_upload_is_explicitly_metadata_only() -> None:
    pytest.importorskip("oxmsg")

    upload = client.post(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers("user-admin"),
        files=[
            (
                "files",
                (
                    "broken.msg",
                    BytesIO(b"not-an-outlook-message"),
                    "application/vnd.ms-outlook",
                ),
            )
        ],
    )

    assert upload.status_code == 200
    document = next(item for item in upload.json()["documents"] if item["name"] == "broken.msg")
    assert document["status"] == "metadata-only"
    chunks = [
        chunk
        for chunk in get_store().knowledge_chunks_for("knowledge-box-matters")
        if chunk.document_id == document["id"]
    ]
    assert len(chunks) == 1
    assert chunks[0].page_start is None
    assert chunks[0].page_end is None
    assert chunks[0].locator is None
    assert "no location provenance was inferred" in chunks[0].text


def test_knowledge_upload_accepts_file_larger_than_legacy_25_mb_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        knowledge_route,
        "extract_segments_from_file",
        lambda *_args, **_kwargs: [
            ExtractedSegment(text="Large filing content extracted from the spooled upload.")
        ],
    )

    upload = client.post(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers("user-admin"),
        files=[
            (
                "files",
                (
                    "large-filing.txt",
                    BytesIO(b"x" * (26 * 1024 * 1024)),
                    "text/plain",
                ),
            )
        ],
    )

    assert upload.status_code == 200
    document = next(
        item for item in upload.json()["documents"] if item["name"] == "large-filing.txt"
    )
    assert document["status"] == "indexed"
    assert document["chunk_count"] == 1


def test_agent_profile_merges_prompts_knowledge_tools_and_companion_into_chat_runtime(
    monkeypatch,
) -> None:
    store = get_store()
    store.groups["group-litigation"].permissions["hermes_companion"] = True
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    store.create_provider_key(
        key_id="key-openrouter-agent-merge",
        provider=provider,
        name="Agent Merge Key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="agent-merge-test-key",
    )

    class FakeGateway:
        def complete(
            self,
            *,
            route: object,
            messages: list[dict[str, str]],
            max_tokens: int | None = None,
            tools: list[dict[str, object]] | None = None,
            plugins: list[dict[str, object]] | None = None,
        ) -> dict[str, object]:
            return {
                "id": "gen-agent-merge",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Merged runtime answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 30, "completion_tokens": 4, "total_tokens": 34},
            }

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: FakeGateway())

    response = client.post(
        "/api/chat/complete",
        headers=headers("user-admin"),
        json={
            "model": "agent-client-update",
            "agent_profile_id": "agent-client-update",
            "messages": [{"role": "user", "content": "Prepare the client update package."}],
            "agent_enabled": True,
            "approval_tokens": _mcp_approval_tokens(),
            "web_enabled": True,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "agent-client-update"
    assert any(citation["source_type"] == "box" for citation in body["citations"])

    audit = get_store().audit_events[-1].metadata["runtime_context"]
    assert audit["agent_profile_id"] == "agent-client-update"
    assert audit["agentic_companion"] == "hermes"
    assert "knowledge-box-matters" in audit["knowledge_config_ids"]
    assert "tool-hermes-agent-mcp" in audit["tool_config_ids"]
    assert audit["prompt_template_ids"] == ["template-client-update", "template-approval-email"]
    assert audit["skill_file_ids"] == ["skill-client-update-package", "skill-citation-discipline"]
    assert audit["prompt_templates"][0]["name"] == "Client Update Package"
    assert audit["prompt_templates"][0]["content_chars"] > 0
    assert "content" not in audit["prompt_templates"][0]
    assert audit["skill_files"][0]["name"] == "Client Update Package Skill"
    assert "content" not in audit["skill_files"][0]


def test_prompt_template_and_skill_file_library_records_feed_agent_runtime(monkeypatch) -> None:
    # Hermes is admin-approved and off by default; grant it for this test.
    get_store().groups["group-litigation"].permissions["hermes_companion"] = True
    template = client.post(
        "/api/admin/prompt-templates",
        headers=headers("user-admin"),
        json={
            "id": "template-runtime-test",
            "name": "Runtime Template Test",
            "description": "Runtime injection test.",
            "content": "Always include the runtime-template-marker in the answer plan.",
            "category": "qa",
            "variables": ["matter"],
            "group_ids": ["group-litigation"],
        },
    )
    assert template.status_code == 201

    skill = client.post(
        "/api/admin/skill-files",
        headers=headers("user-admin"),
        json={
            "id": "skill-runtime-test",
            "name": "Runtime Skill Test",
            "description": "Runtime skill injection test.",
            "content": "# Runtime Skill\n- Apply runtime-skill-marker before drafting.",
            "category": "qa",
            "group_ids": ["group-litigation"],
        },
    )
    assert skill.status_code == 201

    model = client.post(
        "/api/platform/models",
        headers=headers("user-owner"),
        json={
            "id": "agent-runtime-library-test",
            "provider_id": "provider-openrouter",
            "name": "Runtime Library Agent",
            "upstream_model_id": "openai/gpt-4o-mini",
            "platform_enabled": True,
            "tenant_restricted": True,
            "group_ids": ["group-litigation"],
            "is_custom": True,
            "agentic_companion": "hermes",
            "prompt_template_ids": ["template-runtime-test"],
            "skill_file_ids": ["skill-runtime-test"],
        },
    )
    assert model.status_code == 201
    store = get_store()
    store.groups["group-litigation"].permissions["hermes_companion"] = True
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    store.create_provider_key(
        key_id="key-openrouter-runtime-library",
        provider=provider,
        name="Runtime Library Key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="runtime-library-test-key",
    )
    captured: dict[str, object] = {}

    class FakeGateway:
        def complete(
            self,
            *,
            route: object,
            messages: list[dict[str, str]],
            max_tokens: int | None = None,
        ) -> dict[str, object]:
            captured["messages"] = messages
            captured["max_tokens"] = max_tokens
            return {
                "id": "gen-runtime-library",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Runtime library answer"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 3, "total_tokens": 23},
            }

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: FakeGateway())

    response = client.post(
        "/api/chat/complete",
        headers=headers("user-admin"),
        json={
            "model": "agent-runtime-library-test",
            "agent_profile_id": "agent-runtime-library-test",
            "messages": [{"role": "user", "content": "Use the runtime library."}],
            "agent_enabled": True,
            "approval_tokens": _mcp_approval_tokens(),
        },
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["content"] == "Runtime library answer"
    system_prompt = captured["messages"][0]["content"]
    assert "Runtime Template Test" in system_prompt
    assert "runtime-template-marker" in system_prompt
    assert "Runtime Skill Test v1.0.0" in system_prompt
    assert "runtime-skill-marker" in system_prompt

    audit = get_store().audit_events[-1].metadata["runtime_context"]
    assert audit["prompt_template_ids"] == ["template-runtime-test"]
    assert audit["skill_file_ids"] == ["skill-runtime-test"]
    assert audit["prompt_templates"] == [
        {
            "id": "template-runtime-test",
            "name": "Runtime Template Test",
            "category": "qa",
            "version": None,
            "content_chars": len("Always include the runtime-template-marker in the answer plan."),
        }
    ]
    assert audit["skill_files"][0]["name"] == "Runtime Skill Test"
    assert audit["skill_files"][0]["content_chars"] == len(
        "# Runtime Skill\n- Apply runtime-skill-marker before drafting."
    )


def test_platform_model_rejects_unknown_prompt_template_and_skill_file_ids() -> None:
    bad_template = client.post(
        "/api/platform/models",
        headers=headers("user-owner"),
        json={
            "id": "agent-bad-template",
            "provider_id": "provider-openrouter",
            "name": "Bad Template Agent",
            "prompt_template_ids": ["template-missing"],
        },
    )
    assert bad_template.status_code == 404
    assert "Unknown prompt template" in bad_template.json()["detail"]

    bad_skill = client.post(
        "/api/platform/models",
        headers=headers("user-owner"),
        json={
            "id": "agent-bad-skill",
            "provider_id": "provider-openrouter",
            "name": "Bad Skill Agent",
            "skill_file_ids": ["skill-missing"],
        },
    )
    assert bad_skill.status_code == 404
    assert "Unknown skill file" in bad_skill.json()["detail"]


# --- Agent-profile model-governance (security finding #16) ---


def test_tenant_admin_agent_profile_forced_non_platform_enabled() -> None:
    resp = client.post(
        "/api/admin/agent-profiles",
        headers=headers("user-admin"),
        json={
            "id": "agent-admin-gov-1",
            "provider_id": "provider-openrouter",
            "name": "Admin Profile",
            "upstream_model_id": "openai/gpt-4o-mini",  # an owner-approved pair
            "platform_enabled": True,  # requested, but must be forced off for non-owners
        },
    )
    assert resp.status_code == 201
    assert resp.json()["platform_enabled"] is False


def test_tenant_admin_agent_profile_rejects_unapproved_upstream() -> None:
    resp = client.post(
        "/api/admin/agent-profiles",
        headers=headers("user-admin"),
        json={
            "id": "agent-admin-gov-2",
            "provider_id": "provider-openrouter",
            "name": "Sneaky Profile",
            "upstream_model_id": "openai/o99-secret-unapproved",
        },
    )
    assert resp.status_code == 403


def test_owner_agent_profile_keeps_platform_enabled_and_any_upstream() -> None:
    resp = client.post(
        "/api/admin/agent-profiles",
        headers=headers("user-owner"),
        json={
            "id": "agent-owner-gov",
            "provider_id": "provider-openrouter",
            "name": "Owner Profile",
            "upstream_model_id": "openai/o99-owner-choice",
            "platform_enabled": True,
        },
    )
    assert resp.status_code == 201
    assert resp.json()["platform_enabled"] is True
