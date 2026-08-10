from __future__ import annotations

from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core import oidc
from app.core.security import SecretVault
from app.core.sessions import verify_oidc_state
from app.main import app
from app.models.schemas import (
    AlertNotification,
    AlertRule,
    Automation,
    ChatAttachment,
    ChatFolder,
    ChatThread,
    CompanionMemory,
    ContentFilter,
    ModelConfig,
    Role,
    SecurityAlert,
    TenantCreate,
    User,
)
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore

client = TestClient(app)
OWNER_HEADERS = {"x-aperture-user": "user-owner"}


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_settings.cache_clear()
    get_store.cache_clear()
    yield
    get_store.cache_clear()
    get_settings.cache_clear()


def _create_beta() -> dict:
    response = client.post(
        "/api/platform/tenants",
        headers=OWNER_HEADERS,
        json={
            "name": "Beta Legal",
            "slug": "  Beta Legal  ",
            "custom_domain": "BETA.EXAMPLE.TEST.",
            "chat_brand_name": "Beta Counsel",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_owner_tenant_crud_normalizes_identity_and_provisions_unique_default_group() -> None:
    created = _create_beta()
    assert created["id"] == "tenant-beta-legal"
    assert created["slug"] == "beta-legal"
    assert created["custom_domain"] == "beta.example.test"
    assert created["group_count"] == 1

    store = get_store()
    beta_default = store.default_group_for_tenant(created["id"])
    example_default = store.default_group_for_tenant("tenant-example")
    assert beta_default is not None and example_default is not None
    assert example_default.id == "group-default-users"
    assert beta_default.id != example_default.id
    assert beta_default.tenant_id == created["id"]
    assert beta_default.id in store.models["gpt-4o"].group_ids

    duplicate_slug = client.post(
        "/api/platform/tenants",
        headers=OWNER_HEADERS,
        json={"name": "Duplicate", "slug": "BETA LEGAL"},
    )
    assert duplicate_slug.status_code == 409

    duplicate_domain = client.post(
        "/api/platform/tenants",
        headers=OWNER_HEADERS,
        json={
            "name": "Duplicate Domain",
            "slug": "another",
            "custom_domain": "beta.example.test",
        },
    )
    assert duplicate_domain.status_code == 409

    renamed = client.patch(
        f"/api/platform/tenants/{created['id']}",
        headers=OWNER_HEADERS,
        json={"name": "Beta Advisory", "slug": "Beta Advisory"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["slug"] == "beta-advisory"


def test_host_precedes_tenant_header_and_ambiguous_shared_host_fails_honestly() -> None:
    created = _create_beta()
    store = get_store()
    example_sso = store.sso_configs["sso-entra-example"]
    beta_sso = example_sso.model_copy(
        update={
            "id": "sso-beta",
            "tenant_id": created["id"],
            "settings": {**example_sso.settings, "domains": ["beta.example.test"]},
        },
        deep=True,
    )
    store.sso_configs[beta_sso.id] = beta_sso

    example = client.get(
        "/api/auth/options",
        headers={"host": "chat.example.com", "x-aperture-tenant": "beta-legal"},
    )
    assert example.status_code == 200
    assert example.json()["tenant_branding"]["id"] == "tenant-example"
    assert [provider["id"] for provider in example.json()["providers"]] == ["sso-entra-example"]

    beta = client.get("/api/auth/options", headers={"host": "beta.example.test"})
    assert beta.status_code == 200
    assert beta.json()["tenant_branding"]["id"] == created["id"]
    assert [provider["id"] for provider in beta.json()["providers"]] == ["sso-beta"]

    beta_manifest = client.get(
        "/api/pwa/manifest.webmanifest",
        headers={"host": "shared.example.test", "x-aperture-tenant": "beta-legal"},
    )
    assert beta_manifest.status_code == 200
    assert beta_manifest.json()["name"] == "Beta Counsel"

    ambiguous_auth = client.get("/api/auth/options", headers={"host": "shared.example.test"})
    ambiguous_pwa = client.get(
        "/api/pwa/manifest.webmanifest",
        headers={"host": "shared.example.test"},
    )
    assert ambiguous_auth.status_code == 400
    assert ambiguous_pwa.status_code == 400


def test_scim_token_is_show_once_tenant_scoped_revocable_and_restart_safe(tmp_path: Path) -> None:
    state_path = tmp_path / "runtime-state.json"
    vector_path = tmp_path / "vectors.sqlite3"
    vault = SecretVault("tenant-lifecycle-test-signing-secret-with-adequate-length")
    store = SeedStore(
        vault,
        runtime_state_path=str(state_path),
        vector_db_path=str(vector_path),
        dense_embeddings_enabled=False,
    )
    owner = store.users["user-owner"]
    summary = store.create_tenant(
        TenantCreate(
            name="Restart Tenant",
            slug="restart-tenant",
            custom_domain="restart.example.test",
        ),
        owner,
    )
    token_summary, raw_token = store.mint_scim_token(summary.id, owner)
    token_hash = store.scim_tokens[token_summary.id].token_hash
    store.flush_now()
    store.close()

    serialized = state_path.read_text(encoding="utf-8")
    assert raw_token not in serialized
    # Post-cutover the runtime JSON is an import tombstone; the hashed token
    # is SQL-owned and must not be duplicated into the JSON file.
    assert token_hash not in serialized

    restarted = SeedStore(
        vault,
        runtime_state_path=str(state_path),
        vector_db_path=str(vector_path),
        dense_embeddings_enabled=False,
    )
    assert restarted.tenant_for_scim_token(raw_token).id == summary.id
    public = restarted.scim_token_summaries(summary.id)[0].model_dump()
    assert "token_hash" not in public
    assert "secret_value" not in public
    restarted.revoke_scim_token(summary.id, token_summary.id, restarted.users["user-owner"])
    assert restarted.tenant_for_scim_token(raw_token) is None
    restarted.close()


def test_scim_token_resolves_groups_inside_its_own_tenant() -> None:
    created = _create_beta()
    token_response = client.post(
        f"/api/platform/tenants/{created['id']}/scim-tokens",
        headers=OWNER_HEADERS,
    )
    assert token_response.status_code == 201
    token_payload = token_response.json()
    assert "token_hash" not in token_payload

    store = get_store()
    beta_default = store.default_group_for_tenant(created["id"])
    assert beta_default is not None
    beta_default.name = "Litigation"
    created_user = client.post(
        "/scim/v2/Users",
        headers={"Authorization": f"Bearer {token_payload['secret_value']}"},
        json={
            "userName": "beta.user@example.test",
            "name": {"givenName": "Beta", "familyName": "User"},
            "groups": [{"value": "Litigation"}],
        },
    )
    assert created_user.status_code == 201
    stored_user = store.users[created_user.json()["id"]]
    assert stored_user.tenant_id == created["id"]
    assert stored_user.group_ids == [beta_default.id]

    listed = client.get(
        f"/api/platform/tenants/{created['id']}/scim-tokens",
        headers=OWNER_HEADERS,
    )
    assert listed.status_code == 200
    assert "secret_value" not in listed.text
    assert "token_hash" not in listed.text


def test_environment_scim_token_is_disabled_when_multiple_tenants_exist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _create_beta()
    settings = get_settings().model_copy(update={"scim_bearer_token": "legacy-env-token"})
    monkeypatch.setattr("app.routes.scim.get_settings", lambda: settings)
    response = client.get(
        "/scim/v2/Users",
        headers={"Authorization": "Bearer legacy-env-token"},
    )
    assert response.status_code == 401


def test_oidc_state_binds_the_resolved_tenant_before_network_exchange(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = _create_beta()
    store = get_store()
    existing = store.sso_configs["sso-entra-example"]
    beta_config = existing.model_copy(
        update={
            "id": "sso-beta-state",
            "tenant_id": created["id"],
            "settings": {**existing.settings, "domains": ["beta.example.test"]},
        },
        deep=True,
    )
    store.sso_configs[beta_config.id] = beta_config

    discovery = {
        "issuer": "https://idp.beta.example.test",
        "authorization_endpoint": "https://idp.beta.example.test/authorize",
        "token_endpoint": "https://idp.beta.example.test/token",
        "jwks_uri": "https://idp.beta.example.test/keys",
    }
    monkeypatch.setattr(oidc, "fetch_discovery_document", lambda _issuer: discovery)

    wrong_host = client.get(
        f"/api/auth/sso/{beta_config.id}/authorize",
        headers={"host": "chat.example.com"},
        follow_redirects=False,
    )
    assert wrong_host.status_code == 404

    started = client.get(
        f"/api/auth/sso/{beta_config.id}/authorize",
        headers={"host": "beta.example.test"},
        follow_redirects=False,
    )
    assert started.status_code == 302
    state = parse_qs(urlparse(started.headers["location"]).query)["state"][0]
    state_payload = verify_oidc_state(state, get_settings().secret_key)
    assert state_payload is not None
    assert state_payload["tenant_id"] == created["id"]

    # Reassigning the config after authorize cannot cross the signed tenant
    # boundary, and rejection occurs before a token exchange is attempted.
    beta_config.tenant_id = "tenant-example"

    def unexpected_exchange(*_args, **_kwargs):
        pytest.fail("tenant-mismatched OIDC state must fail before token exchange")

    monkeypatch.setattr(oidc, "exchange_authorization_code", unexpected_exchange)
    callback = client.get(
        "/api/auth/sso/callback",
        params={"code": "unused", "state": state},
        follow_redirects=False,
    )
    assert callback.status_code == 302
    assert "sso_error=" in urlparse(callback.headers["location"]).fragment


def test_delete_tenant_cascades_operational_state_but_preserves_history() -> None:
    created = _create_beta()
    tenant_id = created["id"]
    store = get_store()
    owner = store.users["user-owner"]
    default_group = store.default_group_for_tenant(tenant_id)
    assert default_group is not None
    beta_user = User(
        id="user-beta",
        tenant_id=tenant_id,
        email="beta.user@example.test",
        display_name="Beta User",
        role=Role.USER,
        group_ids=[default_group.id],
        auth_method="local",
    )
    store.users[beta_user.id] = beta_user
    store.set_password_credential(beta_user.id, "beta-password-at-least-twelve")
    store.create_user_api_key(beta_user)

    connector = next(iter(store.connector_configs.values())).model_copy(
        update={"id": "connector-beta", "tenant_id": tenant_id}, deep=True
    )
    sso = next(iter(store.sso_configs.values())).model_copy(
        update={
            "id": "sso-beta-cascade",
            "tenant_id": tenant_id,
            # IdP claim value -> workspace group id.
            "mapped_groups": {"beta-users-claim": default_group.id},
        },
        deep=True,
    )
    knowledge = next(iter(store.knowledge_configs.values())).model_copy(
        update={
            "id": "knowledge-beta",
            "tenant_id": tenant_id,
            "connector_config_id": None,
            "owner_user_id": beta_user.id,
            "acl_group_ids": [default_group.id],
        },
        deep=True,
    )
    tool = next(iter(store.tool_configs.values())).model_copy(
        update={
            "id": "tool-beta",
            "tenant_id": tenant_id,
            "allowed_group_ids": [default_group.id],
        },
        deep=True,
    )
    prompt = next(iter(store.prompt_templates.values())).model_copy(
        update={
            "id": "prompt-beta",
            "tenant_id": tenant_id,
            "group_ids": [default_group.id],
        },
        deep=True,
    )
    skill = next(iter(store.skill_files.values())).model_copy(
        update={
            "id": "skill-beta",
            "tenant_id": tenant_id,
            "group_ids": [default_group.id],
        },
        deep=True,
    )
    for collection, record in (
        (store.connector_configs, connector),
        (store.sso_configs, sso),
        (store.knowledge_configs, knowledge),
        (store.tool_configs, tool),
        (store.prompt_templates, prompt),
        (store.skill_files, skill),
    ):
        collection[record.id] = record

    source_document = next(
        document
        for documents in store.knowledge_documents.values()
        for document in documents
    )
    source_chunk = next(
        chunk
        for chunks in store.knowledge_chunks.values()
        for chunk in chunks
    )
    beta_document = source_document.model_copy(
        update={
            "id": "document-beta",
            "knowledge_config_id": knowledge.id,
            "tenant_id": tenant_id,
            "acl_group_ids": [default_group.id],
        },
        deep=True,
    )
    beta_chunk = source_chunk.model_copy(
        update={
            "id": "chunk-beta",
            "knowledge_config_id": knowledge.id,
            "document_id": beta_document.id,
            "tenant_id": tenant_id,
            "acl_group_ids": [default_group.id],
        },
        deep=True,
    )
    store.knowledge_documents[knowledge.id] = [beta_document]
    store.knowledge_chunks[knowledge.id] = [beta_chunk]
    store.vector_store.replace_config(knowledge.id, [beta_document], [beta_chunk])

    beta_model = ModelConfig(
        id="agent-beta",
        tenant_id=tenant_id,
        provider_id="provider-openai",
        provider_name="OpenAI",
        name="Beta Agent",
        is_custom=True,
        group_ids=[default_group.id],
        knowledge_config_ids=[knowledge.id],
        tool_config_ids=[tool.id],
        prompt_template_ids=[prompt.id],
        skill_file_ids=[skill.id],
    )
    store.models[beta_model.id] = beta_model
    store.content_filters["filter-beta"] = ContentFilter(
        id="filter-beta", tenant_id=tenant_id, name="Beta Filter"
    )
    store.chat_folders["folder-beta"] = ChatFolder(
        id="folder-beta",
        tenant_id=tenant_id,
        owner_user_id=beta_user.id,
        name="Beta",
        created_at="Now",
    )
    store.chat_threads["thread-beta"] = ChatThread(
        id="thread-beta",
        tenant_id=tenant_id,
        owner_user_id=beta_user.id,
        title="Beta",
        model_id=beta_model.id,
        group_id=default_group.id,
        updated_at="Now",
        messages=[],
    )
    store.chat_attachments["attachment-beta"] = ChatAttachment(
        id="attachment-beta",
        owner_user_id=beta_user.id,
        name="beta.txt",
        size="1 B",
        kind="Text",
    )
    store.security_alerts["alert-beta"] = SecurityAlert(
        id="alert-beta", tenant_id=tenant_id, user_id=beta_user.id, rule_id="rule", rule_label="Rule"
    )
    store.automations["automation-beta"] = Automation(
        id="automation-beta", tenant_id=tenant_id, name="Beta Automation"
    )
    store.companion_memories["memory-beta"] = CompanionMemory(
        id="memory-beta",
        tenant_id=tenant_id,
        profile_id=beta_model.id,
        content="Remember",
        created_by=beta_user.id,
        created_at="Now",
    )
    store.alert_rules["rule-beta"] = AlertRule(
        id="rule-beta", scope="tenant", tenant_id=tenant_id, name="Beta Rule", created_by=beta_user.id
    )
    store.alert_notifications["notification-beta"] = AlertNotification(
        id="notification-beta",
        rule_id="rule-beta",
        rule_name="Beta Rule",
        tenant_id=tenant_id,
        event_id="event-beta",
        event_action="test",
    )
    for namespace, record_id in (
        ("connector", connector.id),
        ("connector-oauth", connector.id),
        ("connector-password", connector.id),
        ("sso", sso.id),
        ("knowledge", knowledge.id),
        ("knowledge-api-source", f"{knowledge.id}:oauth-client"),
        ("tool", tool.id),
        ("tool-oauth-token", tool.id),
    ):
        store.set_configuration_secret(namespace, record_id, "secret-value")
    _, scim_secret = store.mint_scim_token(tenant_id, owner)

    tenant_event = store.record_audit(beta_user, "tenant.test_event", "beta-target", {})
    tenant_usage = store.record_usage(
        actor=beta_user,
        model_id=beta_model.id,
        provider_name="OpenAI",
    )
    tenant_elastic_id = tenant_event.id

    response = client.delete(f"/api/platform/tenants/{tenant_id}", headers=OWNER_HEADERS)
    assert response.status_code == 200, response.text

    assert tenant_id not in store.tenants
    assert store.tenant_for_scim_token(scim_secret) is None
    for collection in (
        store.users,
        store.groups,
        store.models,
        store.connector_configs,
        store.sso_configs,
        store.knowledge_configs,
        store.tool_configs,
        store.prompt_templates,
        store.skill_files,
        store.chat_threads,
        store.chat_folders,
        store.chat_attachments,
        store.security_alerts,
        store.automations,
        store.companion_memories,
        store.content_filters,
        store.alert_rules,
        store.alert_notifications,
    ):
        assert all(getattr(record, "tenant_id", None) != tenant_id for record in collection.values())
    assert all("-beta" not in key for key in store._configuration_secrets)  # noqa: SLF001
    assert beta_user.id not in store.password_credentials
    assert beta_user.id not in store.user_api_keys
    assert store.session_issued_before_ms[beta_user.id] > 0
    assert store.vector_store.documents_for(knowledge.id) == []
    assert store.vector_store.chunks_for(knowledge.id) == []

    assert any(event.id == tenant_event.id for event in store.audit_events)
    assert any(record.id == tenant_usage.id for record in store.usage_records)
    assert any(event["id"] == tenant_elastic_id for event in store.elastic_events)
    deletion_event = store.audit_events[-1]
    assert deletion_event.action == "platform.tenant_deleted"
    assert deletion_event.tenant_id is None


def test_final_tenant_deletion_is_rejected_and_tenant_bootstrap_is_scoped() -> None:
    final_delete = client.delete(
        "/api/platform/tenants/tenant-example",
        headers=OWNER_HEADERS,
    )
    assert final_delete.status_code == 409

    created = _create_beta()
    store = get_store()
    store.models["agent-beta-empty"] = ModelConfig(
        id="agent-beta-empty",
        tenant_id=created["id"],
        provider_id="provider-openai",
        provider_name="OpenAI",
        name="Beta Empty Agent",
        is_custom=True,
        visibility="organization",
        group_ids=[],
    )
    admin_bootstrap = client.get("/api/bootstrap", headers={"x-aperture-user": "user-admin"})
    assert admin_bootstrap.status_code == 200
    payload = admin_bootstrap.json()
    assert [tenant["id"] for tenant in payload["tenants"]] == ["tenant-example"]
    assert payload["currentTenant"]["id"] == "tenant-example"
    assert "agent-beta-empty" not in {model["id"] for model in payload["models"]}

    owner_bootstrap = client.get("/api/bootstrap", headers=OWNER_HEADERS)
    assert owner_bootstrap.status_code == 200
    assert owner_bootstrap.json()["currentTenant"] is None


def test_owner_must_name_target_tenant_and_cannot_mix_foreign_groups() -> None:
    created = _create_beta()

    user = client.post(
        "/api/admin/users",
        headers=OWNER_HEADERS,
        json={"email": "ambiguous@example.test", "display_name": "Ambiguous"},
    )
    template = client.post(
        "/api/admin/prompt-templates",
        headers=OWNER_HEADERS,
        json={"name": "Ambiguous", "content": "No tenant"},
    )
    automation = client.post(
        "/api/automations",
        headers=OWNER_HEADERS,
        json={
            "name": "Ambiguous",
            "steps": [{"model_id": "gpt-4o", "instruction": "Run"}],
        },
    )
    profile = client.post(
        "/api/admin/agent-profiles",
        headers=OWNER_HEADERS,
        json={
            "provider_id": "provider-openai",
            "name": "Ambiguous Profile",
            "is_custom": True,
        },
    )
    assert {user.status_code, template.status_code, automation.status_code, profile.status_code} == {400}

    foreign_group = client.post(
        "/api/admin/agent-profiles",
        headers=OWNER_HEADERS,
        json={
            "tenant_id": created["id"],
            "provider_id": "provider-openai",
            "name": "Cross Tenant Profile",
            "is_custom": True,
            "group_ids": ["group-litigation"],
        },
    )
    assert foreign_group.status_code == 403


def test_tenant_admin_model_grant_preserves_other_tenant_groups() -> None:
    created = _create_beta()
    store = get_store()
    beta_default = store.default_group_for_tenant(created["id"])
    assert beta_default is not None
    assert beta_default.id in store.models["gpt-4o"].group_ids

    response = client.patch(
        "/api/admin/model-access/gpt-4o",
        headers={"x-aperture-user": "user-admin"},
        json={"group_ids": ["group-litigation"]},
    )
    assert response.status_code == 200
    assert "group-litigation" in response.json()["group_ids"]
    assert beta_default.id in response.json()["group_ids"]
