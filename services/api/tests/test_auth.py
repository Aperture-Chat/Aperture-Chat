import base64
import json

from fastapi.testclient import TestClient
import pytest

from app.core.config import get_settings
from app.core.security import SecretVault
from app.main import app
from app.models.schemas import (
    AgentRun,
    AgentStep,
    Approval,
    Artifact,
    ChatAttachment,
    ChatMessage,
    ChatThread,
    Connector,
    ConnectorConfig,
    Group,
    KnowledgeChunk,
    KnowledgeConfig,
    KnowledgeDocument,
    ModelConfig,
    PlatformSettings,
    PromptTemplate,
    Provider,
    Role,
    SkillFile,
    SsoConfig,
    ToolConfig,
    User,
)
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_settings.cache_clear()
    get_store.cache_clear()
    yield
    get_store.cache_clear()
    get_settings.cache_clear()


@pytest.mark.parametrize(
    "environment",
    ["production", "staging", "prod", "dev", "development"],
)
def test_unsigned_user_header_never_authenticates_outside_a_local_environment(
    monkeypatch, environment: str
) -> None:
    """No environment name may turn the plain header into passwordless entry.

    "dev"/"development" are included deliberately: a deployed staging site is
    still deployed, so the header must not let a request claim another user's
    identity there even though those names read as local elsewhere.
    """
    monkeypatch.setenv("APERTURE_ENVIRONMENT", environment)
    monkeypatch.setenv("APERTURE_SECRET_KEY", "x" * 48)
    get_settings.cache_clear()

    response = client.get("/api/bootstrap", headers={"x-aperture-user": "user-owner"})

    assert response.status_code == 401
    assert response.json()["detail"] == "Authentication required"


def test_unsigned_user_header_still_works_for_genuinely_local_development(
    monkeypatch,
) -> None:
    monkeypatch.setenv("APERTURE_ENVIRONMENT", "local")
    get_settings.cache_clear()

    response = client.get("/api/bootstrap", headers={"x-aperture-user": "user-owner"})

    assert response.status_code == 200


def test_auth_options_expose_enabled_sso_without_secrets() -> None:
    response = client.get("/api/auth/options")

    assert response.status_code == 200
    payload = response.json()
    assert payload["local_auth_enabled"] is True
    assert payload["bootstrap_required"] is False
    assert payload["password_auth_enabled"] is False
    assert payload["providers"][0]["id"] == "sso-entra-example"
    assert payload["providers"][0]["name"] == "Microsoft Entra ID"
    assert payload["providers"][0]["domains"] == ["example.com"]
    assert payload["providers"][0]["mfa_enforced"] is True
    assert payload["providers"][0]["mfa_methods"] == ["Microsoft Authenticator", "Duo Mobile"]
    assert payload["tenant_branding"]["chat_brand_name"] == "Aperture Chat"
    assert payload["tenant_branding"]["logo_url"] is None
    assert payload["supported_sso_protocols"] == ["OIDC"]
    assert payload["deferred_sso_protocols"] == ["SAML"]
    assert "secret" not in response.text.lower()


def test_auth_options_include_updated_public_tenant_branding() -> None:
    store = get_store()
    store.tenants["tenant-example"].chat_brand_name = "Example AI"
    store.tenants["tenant-example"].logo_url = "https://assets.example.com/logo.png"
    store.tenants["tenant-example"].icon_url = "https://assets.example.com/icon.png"

    response = client.get("/api/auth/options")

    assert response.status_code == 200
    branding = response.json()["tenant_branding"]
    assert branding["chat_brand_name"] == "Example AI"
    assert branding["logo_url"] == "https://assets.example.com/logo.png"
    assert branding["icon_url"] == "https://assets.example.com/icon.png"


def test_access_request_creates_an_inactive_pending_identity_without_enumerating_duplicates() -> None:
    payload = {
        "first_name": "  Jamie  ",
        "last_name": "  Rivera ",
        "email": "Jamie.Rivera@example.com",
    }

    created = client.post("/api/auth/access-requests", json=payload)
    duplicate = client.post("/api/auth/access-requests", json=payload)

    assert created.status_code == duplicate.status_code == 202
    assert created.json() == duplicate.json() == {
        "status": "pending",
        "message": "Your access request is pending review.",
    }
    matches = [
        user
        for user in get_store().users.values()
        if user.email == "jamie.rivera@example.com"
    ]
    assert len(matches) == 1
    requested = matches[0]
    assert requested.display_name == "Jamie Rivera"
    assert requested.first_name == "Jamie"
    assert requested.last_name == "Rivera"
    assert requested.tenant_id == "tenant-example"
    assert requested.role == Role.USER
    assert requested.active is False
    assert requested.group_ids == []
    assert requested.access_request_status == "pending"
    assert requested.access_requested_at is not None


def test_access_request_rejects_invalid_email_without_persisting_identity() -> None:
    before = set(get_store().users)
    response = client.post(
        "/api/auth/access-requests",
        json={"first_name": "Jamie", "last_name": "Rivera", "email": "not-an-email"},
    )
    assert response.status_code == 400
    assert set(get_store().users) == before


def test_typed_email_sso_login_is_rejected_in_favor_of_redirect_flow() -> None:
    # The old theater path (type an email, get logged in "via SSO") must stay dead.
    response = client.post(
        "/api/auth/login",
        json={"email": "jane.smith@example.com", "auth_method": "sso", "provider_id": "sso-entra-example"},
    )
    assert response.status_code == 400
    assert "redirect flow" in response.json()["detail"]

    bootstrap = client.get("/api/bootstrap")
    assert bootstrap.status_code == 401
    assert bootstrap.json()["detail"] == "Authentication required"


def test_failed_sign_ins_are_budgeted_per_account_not_across_all_users() -> None:
    """Colleagues share one egress address, so one account's wrong guesses must
    never consume another account's ability to sign in."""
    from app.routes.auth import _LOGIN_FAILURE_BUCKETS

    _LOGIN_FAILURE_BUCKETS._buckets.clear()
    store = get_store()
    limit = get_settings().auth_rate_limit_per_minute
    victim, bystander = "victim@example.local", "bystander@example.local"
    for email in (victim, bystander):
        user = store.users[
            next(
                uid
                for uid, u in store.users.items()
                if u.role == Role.USER and u.auth_method != "local"
            )
        ].model_copy(update={"id": f"user-{email}", "email": email, "auth_method": "local"})
        store.users[user.id] = user
        store.set_password_credential(user.id, "correct-horse-battery-staple")

    for _ in range(limit):
        wrong = client.post(
            "/api/auth/login",
            json={"email": victim, "password": "wrong-password", "auth_method": "local"},
        )
        assert wrong.status_code == 401

    locked = client.post(
        "/api/auth/login",
        json={"email": victim, "password": "wrong-password", "auth_method": "local"},
    )
    assert locked.status_code == 429
    assert "Retry-After" in locked.headers

    # The bystander is untouched, and a correct password spends no budget.
    for _ in range(limit + 2):
        ok = client.post(
            "/api/auth/login",
            json={
                "email": bystander,
                "password": "correct-horse-battery-staple",
                "auth_method": "local",
            },
        )
        assert ok.status_code == 200


def test_auth_options_include_sso_start_url_for_redirect_flow() -> None:
    response = client.get("/api/auth/options")
    assert response.status_code == 200
    provider = response.json()["providers"][0]
    assert provider["start_url"] == f"/api/auth/sso/{provider['id']}/authorize"


def test_first_run_bootstrap_creates_initial_platform_owner_with_password() -> None:
    store = get_store()
    store.users.pop("user-owner")

    options = client.get("/api/auth/options")
    assert options.status_code == 200
    assert options.json()["bootstrap_required"] is True

    response = client.post(
        "/api/auth/bootstrap-owner",
        json={
            "email": "first.owner@example.test",
            "display_name": "First Owner",
            "password": "long-enough-owner-password",
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["user"]["role"] == "PLATFORM_OWNER"
    assert payload["user"]["email"] == "first.owner@example.test"
    assert payload["session"]["auth_method"] == "local"
    assert payload["bootstrap"]["me"]["role"] == "PLATFORM_OWNER"
    assert get_store().verify_password_credential(payload["user"]["id"], "long-enough-owner-password")

    duplicate = client.post(
        "/api/auth/bootstrap-owner",
        json={
            "email": "second.owner@example.test",
            "display_name": "Second Owner",
            "password": "another-long-password",
        },
    )
    assert duplicate.status_code == 409


def test_first_run_mode_can_start_without_seeded_platform_owner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APERTURE_SEED_PLATFORM_OWNER_ENABLED", "false")
    get_settings.cache_clear()
    get_store.cache_clear()

    response = client.get("/api/auth/options")

    assert response.status_code == 200
    payload = response.json()
    assert payload["bootstrap_required"] is True
    assert payload["password_auth_enabled"] is False
    assert "user-owner" not in get_store().users


def test_release_seed_flags_start_as_blank_first_owner_platform(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("APERTURE_SEED_PLATFORM_OWNER_ENABLED", "false")
    monkeypatch.setenv("APERTURE_SEED_DEMO_DATA_ENABLED", "false")
    monkeypatch.setenv("APERTURE_RUNTIME_STATE_PATH", str(tmp_path / "runtime_state.json"))
    monkeypatch.setenv("APERTURE_APPLICATION_DB_PATH", str(tmp_path / "aperture.sqlite3"))
    monkeypatch.setenv("APERTURE_VECTOR_DB_PATH", str(tmp_path / "knowledge_vectors.sqlite3"))
    # get_store() keeps demo data enabled while pytest is set. This contract is
    # specifically for the release path, so run it through the non-test branch.
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    get_settings.cache_clear()
    get_store.cache_clear()

    response = client.get("/api/auth/options")

    assert response.status_code == 200
    payload = response.json()
    store = get_store()
    assert payload["bootstrap_required"] is True
    assert payload["password_auth_enabled"] is False
    assert payload["providers"] == []
    assert payload["tenant_branding"]["name"] == "New Organization"
    assert store.users == {}
    assert store.providers == {}
    assert store.models == {}
    assert store.connector_configs == {}
    assert store.sso_configs == {}
    assert store.knowledge_configs == {}
    assert store.tool_configs == {}
    assert store.chat_threads == {}
    assert store.agent_runs == {}


def test_runtime_state_persists_first_owner_profile_and_password(tmp_path) -> None:
    state_path = tmp_path / "runtime_state.json"
    store = SeedStore(
        SecretVault("test-secret"),
        seed_platform_owner_enabled=False,
        runtime_state_path=str(state_path),
    )
    user = User(
        id="user-primary-owner",
        email="primary.owner@example.com",
        display_name="Taylor Example",
        role=Role.PLATFORM_OWNER,
        auth_method="local",
        last_active="Now",
    )
    store.users[user.id] = user
    store.set_password_credential(user.id, "synthetic-owner-password")
    user.bio = "Testing persistent profile details."
    user.phone = "+1 555 0100"
    user.avatar_url = "data:image/png;base64,aGVsbG8="
    store.save_runtime_state()
    store.flush_now()

    restarted = SeedStore(
        SecretVault("test-secret"),
        seed_platform_owner_enabled=False,
        runtime_state_path=str(state_path),
    )

    assert restarted.bootstrap_required() is False
    assert restarted.users[user.id].email == "primary.owner@example.com"
    assert restarted.users[user.id].bio == "Testing persistent profile details."
    assert restarted.users[user.id].avatar_url == "data:image/png;base64,aGVsbG8="
    assert restarted.verify_password_credential(user.id, "synthetic-owner-password")


def test_runtime_state_persists_platform_catalog_and_runtime_data(tmp_path) -> None:
    state_path = tmp_path / "runtime_state.json"
    vector_path = tmp_path / "knowledge_vectors.sqlite3"
    vault = SecretVault("test-secret")
    store = SeedStore(
        vault,
        seed_demo_data_enabled=False,
        runtime_state_path=str(state_path),
        vector_db_path=str(vector_path),
    )
    owner = User(
        id="user-persist-owner",
        email="owner@example.test",
        display_name="Persistent Owner",
        role=Role.PLATFORM_OWNER,
        auth_method="local",
        last_active="Now",
    )
    group = Group(
        id="group-persist",
        tenant_id="tenant-example",
        name="Persistent Group",
        distinguished_name="CN=Persistent Group",
        entra_object_id="entra-group-persist",
    )
    provider = Provider(
        id="provider-persist",
        name="Persistent Provider",
        kind="openai",
        region="Global",
        base_url="https://api.example.test/v1",
    )
    model = ModelConfig(
        id="model-persist",
        provider_id=provider.id,
        provider_name=provider.name,
        name="Persistent Model",
        upstream_model_id="persistent/model",
        group_ids=[group.id],
    )
    connector = Connector(id="connector-persist", name="Persistent Connector", category="content")
    connector_config = ConnectorConfig(
        id="conncfg-persist",
        tenant_id="tenant-example",
        connector_id=connector.id,
        auth_type="api-key",
        secret_set=True,
        masked_secret="sk...test",
    )
    sso_config = SsoConfig(
        id="sso-persist",
        tenant_id="tenant-example",
        provider="entra",
        issuer_url="https://login.example.test",
        client_id="client-persist",
        secret_set=True,
        masked_secret="ss...ret",
    )
    knowledge_config = KnowledgeConfig(
        id="knowledge-persist",
        tenant_id="tenant-example",
        name="Persistent Knowledge",
        source_type="upload",
        acl_group_ids=[group.id],
        settings={"status": "draft"},
    )
    document = KnowledgeDocument(
        id="doc-persist",
        knowledge_config_id=knowledge_config.id,
        tenant_id="tenant-example",
        name="Persistent document.md",
        source_uri="upload://doc-persist",
        source_type="upload",
        chunk_count=1,
        acl_group_ids=[group.id],
        updated_at="Now",
    )
    chunk = KnowledgeChunk(
        id="chunk-persist",
        knowledge_config_id=knowledge_config.id,
        document_id=document.id,
        tenant_id="tenant-example",
        source_name=document.name,
        source_uri=document.source_uri,
        source_type=document.source_type,
        text="Persistent knowledge content",
        acl_group_ids=[group.id],
        updated_at="Now",
    )
    tool = ToolConfig(
        id="tool-persist",
        tenant_id="tenant-example",
        name="Persistent Tool",
        tool_type="mcp",
        endpoint_url="https://tools.example.test/mcp",
        secret_set=True,
        masked_secret="to...ret",
    )
    prompt = PromptTemplate(
        id="prompt-persist",
        tenant_id="tenant-example",
        name="Persistent Prompt",
        content="Persist this prompt.",
    )
    skill = SkillFile(
        id="skill-persist",
        tenant_id="tenant-example",
        name="Persistent Skill",
        content="# Persistent skill",
    )
    thread = ChatThread(
        id="thread-persist",
        tenant_id="tenant-example",
        owner_user_id=owner.id,
        title="Persistent chat",
        model_id=model.id,
        group_id=group.id,
        updated_at="Now",
        messages=[
            ChatMessage(
                id="message-persist",
                role="user",
                content="Remember this chat.",
                createdAt="Now",
            )
        ],
    )
    attachment = ChatAttachment(
        id="upload-persist",
        tenant_id="tenant-example",
        owner_user_id=owner.id,
        name="persistent.txt",
        size="12 B",
        kind="TXT",
        text_preview="persistent",
    )
    run = AgentRun(
        id="run-persist",
        tenant_id="tenant-example",
        name="Persistent run",
        status="Completed",
        started_by=owner.display_name,
        started_at="Now",
        sources=["Persistent Knowledge"],
        steps=[AgentStep(id="step-persist", label="Persist", status="Completed", detail="Saved")],
        artifacts=[Artifact(id="artifact-persist", name="persistent.docx", kind="DOCX", size="10 KB", created_at="Now")],
        approvals=[Approval(id="approval-persist", title="Persistent approval", requested_by=owner.display_name, requested_at="Now")],
        logs=[{"time": "Now", "step": "Persist", "event": "Saved"}],
    )

    store.tenants["tenant-example"].name = "Persistent Firm"
    store.users[owner.id] = owner
    store.set_password_credential(owner.id, "owner-password")
    store.groups[group.id] = group
    store.providers[provider.id] = provider
    store.models[model.id] = model
    store.connectors[connector.id] = connector
    store.connector_configs[connector_config.id] = connector_config
    store.sso_configs[sso_config.id] = sso_config
    store.knowledge_configs[knowledge_config.id] = knowledge_config
    store.tool_configs[tool.id] = tool
    store.prompt_templates[prompt.id] = prompt
    store.skill_files[skill.id] = skill
    store.save_chat_thread(thread)
    store.save_chat_attachment(attachment)
    store.agent_runs[run.id] = run
    store.platform_settings = PlatformSettings(
        require_sso_for_admins=True,
        users_can_create_models=True,
        tenant_admins_can_manage_sso=False,
        tenant_admins_can_create_admins=True,
    )
    store.create_provider_key(
        key_id="key-persist",
        provider=provider,
        name="Persistent Key",
        environment="Production",
        status="Active",
        expires="Not set",
        secret_value="sk-test-persist",
    )
    store.set_configuration_secret("tool", tool.id, "tool-secret")
    store.sync_knowledge_config(
        knowledge_config.id,
        [document],
        chunks=[chunk],
        provider_status="live",
        provider_message="Persisted test document.",
    )
    store.record_audit(owner, "platform.provider_created", provider.id, {"name": provider.name})
    store.flush_now()

    raw_state = state_path.read_text(encoding="utf-8")
    assert "owner-password" not in raw_state
    assert "sk-test-persist" not in raw_state
    assert "tool-secret" not in raw_state
    parsed_state = json.loads(raw_state)
    assert parsed_state["version"] == 5
    for retired_key in (
        "tenants",
        "users",
        "groups",
        "providers",
        "models",
        "provider_keys",
        "connector_configs",
        "sso_configs",
        "knowledge_configs",
        "knowledge_documents",
        "knowledge_chunks",
        "password_credentials",
        "encrypted_provider_keys",
        "configuration_secrets",
        "chat_threads",
        "chat_folders",
        "chat_sessions",
        "chat_attachments",
        "user_api_keys",
    ):
        assert retired_key not in parsed_state

    restarted = SeedStore(
        vault,
        seed_demo_data_enabled=False,
        runtime_state_path=str(state_path),
        vector_db_path=str(vector_path),
    )

    assert restarted.tenants["tenant-example"].name == "Persistent Firm"
    assert restarted.users[owner.id].display_name == "Persistent Owner"
    assert restarted.verify_password_credential(owner.id, "owner-password")
    assert restarted.groups[group.id].name == "Persistent Group"
    assert restarted.providers[provider.id].base_url == "https://api.example.test/v1"
    assert restarted.models[model.id].upstream_model_id == "persistent/model"
    assert restarted.provider_key_secret("key-persist").secret_value == "sk-test-persist"
    assert restarted.connectors[connector.id].name == "Persistent Connector"
    assert restarted.connector_configs[connector_config.id].secret_set is True
    assert restarted.sso_configs[sso_config.id].client_id == "client-persist"
    assert restarted.knowledge_configs[knowledge_config.id].settings["provider_status"] == "live"
    assert restarted.knowledge_documents_for(knowledge_config.id)[0].name == "Persistent document.md"
    assert restarted.knowledge_chunks_for(knowledge_config.id)[0].text == "Persistent knowledge content"
    assert restarted.tool_configs[tool.id].endpoint_url == "https://tools.example.test/mcp"
    assert restarted.configuration_secret("tool", tool.id) == "tool-secret"
    assert restarted.prompt_templates[prompt.id].content == "Persist this prompt."
    assert restarted.skill_files[skill.id].content == "# Persistent skill"
    assert restarted.chat_threads[thread.id].messages[0].content == "Remember this chat."
    assert restarted.chat_sessions[thread.id].title == "Persistent chat"
    assert restarted.chat_attachments[attachment.id].text_preview == "persistent"
    assert restarted.agent_runs[run.id].artifacts[0].name == "persistent.docx"
    assert restarted.platform_settings.require_sso_for_admins is True
    assert restarted.platform_settings.users_can_create_models is True
    assert restarted.platform_settings.tenant_admins_can_manage_sso is False
    assert restarted.platform_settings.tenant_admins_can_create_admins is True
    assert restarted.audit_events[-1].action == "platform.provider_created"
    assert restarted.elastic_events[-1]["event"] == "platform.provider_created"


def test_user_can_update_own_profile() -> None:
    response = client.patch(
        "/api/auth/profile",
        headers={"x-aperture-user": "user-admin"},
        json={
            "display_name": "Alex Morgan",
            "bio": "Litigation automation lead.",
            "firm_name": "Spencer Fane LLP",
            "website_url": "https://www.spencerfane.com",
            "phone": "+1 555 0100",
            "avatar_url": "https://example.com/avatar.png",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["display_name"] == "Alex Morgan"
    assert payload["bio"] == "Litigation automation lead."
    assert payload["firm_name"] == "Spencer Fane LLP"
    assert payload["website_url"] == "https://www.spencerfane.com"
    assert payload["phone"] == "+1 555 0100"
    assert payload["avatar_url"] == "https://example.com/avatar.png"
    assert get_store().users["user-admin"].display_name == "Alex Morgan"
    assert get_store().audit_events[-1].action == "auth.profile_updated"


def test_profile_website_requires_http_or_https() -> None:
    response = client.patch(
        "/api/auth/profile",
        headers={"x-aperture-user": "user-admin"},
        json={"website_url": "javascript:alert(1)"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Website must use an http(s) URL."


def test_first_run_guide_marker_persists_on_user() -> None:
    store = get_store()
    user = store.users["user-jane"]
    assert user.first_run_guide_seen_at is None

    response = client.post(
        "/api/auth/first-run-guide/seen",
        headers={"x-aperture-user": user.id},
    )

    assert response.status_code == 200
    seen_at = response.json()["first_run_guide_seen_at"]
    assert seen_at
    assert store.users[user.id].first_run_guide_seen_at == seen_at
    assert store.audit_events[-1].action == "auth.first_run_guide_seen"

    repeat = client.post(
        "/api/auth/first-run-guide/seen",
        headers={"x-aperture-user": user.id},
    )
    assert repeat.status_code == 200
    assert repeat.json()["first_run_guide_seen_at"] == seen_at
    first_run_events = [event.action for event in store.audit_events]
    assert first_run_events.count("auth.first_run_guide_seen") == 1

    bootstrap = client.get("/api/bootstrap", headers={"x-aperture-user": user.id})
    assert bootstrap.status_code == 200
    assert bootstrap.json()["me"]["first_run_guide_seen_at"] == seen_at


def test_profile_photo_rejects_non_image_references() -> None:
    response = client.patch(
        "/api/auth/profile",
        headers={"x-aperture-user": "user-admin"},
        json={"avatar_url": "javascript:alert(1)"},
    )

    assert response.status_code == 400
    assert "Profile photo" in response.json()["detail"]


def test_profile_photo_accepts_uploaded_data_url_up_to_five_mb() -> None:
    image_bytes = b"a" * (5 * 1024 * 1024)
    image_data_url = f"data:image/png;base64,{base64.b64encode(image_bytes).decode()}"

    response = client.patch(
        "/api/auth/profile",
        headers={"x-aperture-user": "user-admin"},
        json={"avatar_url": image_data_url},
    )

    assert response.status_code == 200
    assert response.json()["avatar_url"] == image_data_url


def test_profile_photo_rejects_uploaded_data_url_over_five_mb() -> None:
    image_bytes = b"a" * ((5 * 1024 * 1024) + 1)
    image_data_url = f"data:image/png;base64,{base64.b64encode(image_bytes).decode()}"

    response = client.patch(
        "/api/auth/profile",
        headers={"x-aperture-user": "user-admin"},
        json={"avatar_url": image_data_url},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Profile photo must be 5 MB or smaller."


def test_local_login_requires_matching_password() -> None:
    store = get_store()
    store.set_password_credential("user-owner", "owner-password-123")

    missing = client.post(
        "/api/auth/login",
        json={"email": "owner@aperture.local", "auth_method": "local"},
    )
    assert missing.status_code == 401

    wrong = client.post(
        "/api/auth/login",
        json={"email": "owner@aperture.local", "auth_method": "local", "password": "wrong-password"},
    )
    assert wrong.status_code == 401

    ok = client.post(
        "/api/auth/login",
        json={"email": "owner@aperture.local", "auth_method": "local", "password": "owner-password-123"},
    )
    assert ok.status_code == 200


def test_local_login_is_allowed_until_sso_is_fully_configured() -> None:
    store = get_store()
    store.set_password_credential("user-owner", "owner-password-123")
    store.sso_configs.clear()
    # Removing the seeded SSO config must also remove its vaulted client
    # secret; identity validation rejects secrets that reference no resource.
    store._configuration_secrets.pop("sso:sso-entra-example", None)  # noqa: SLF001
    store.sso_configs["sso-unconfigured"] = SsoConfig(
        id="sso-unconfigured",
        tenant_id="tenant-example",
        provider="entra-id",
        issuer_url="https://login.microsoftonline.com/example/v2.0",
        client_id="client-id",
        enabled=True,
        settings={
            "protocol": "OIDC",
            "domains": ["aperture.local"],
            "enforced": True,
            "redirect_url": "https://chat.example.com/auth/callback",
        },
        secret_set=False,
        masked_secret=None,
    )

    options = client.get("/api/auth/options")
    assert options.status_code == 200
    assert options.json()["providers"] == []

    local = client.post(
        "/api/auth/login",
        json={"email": "owner@aperture.local", "auth_method": "local", "password": "owner-password-123"},
    )
    assert local.status_code == 200

    store.sso_configs["sso-unconfigured"].secret_set = True
    store.sso_configs["sso-unconfigured"].masked_secret = "cl********et"

    enforced = client.post(
        "/api/auth/login",
        json={"email": "owner@aperture.local", "auth_method": "local", "password": "owner-password-123"},
    )
    assert enforced.status_code == 403
    assert enforced.json()["detail"] == "SSO is enforced for this email domain; local sign-in is disabled. Use the configured identity provider."


def test_local_password_update_requires_current_password() -> None:
    store = get_store()
    store.set_password_credential("user-owner", "owner-password-123")

    wrong = client.post(
        "/api/auth/password",
        headers={"x-aperture-user": "user-owner"},
        json={"current_password": "wrong-password", "new_password": "owner-password-456"},
    )
    assert wrong.status_code == 401

    short = client.post(
        "/api/auth/password",
        headers={"x-aperture-user": "user-owner"},
        json={"current_password": "owner-password-123", "new_password": "short"},
    )
    assert short.status_code == 400

    ok = client.post(
        "/api/auth/password",
        headers={"x-aperture-user": "user-owner"},
        json={"current_password": "owner-password-123", "new_password": "owner-password-456"},
    )
    assert ok.status_code == 200
    assert ok.json() == {"status": "updated"}
    assert store.verify_password_credential("user-owner", "owner-password-456")
    assert not store.verify_password_credential("user-owner", "owner-password-123")


def test_sso_password_update_is_blocked() -> None:
    response = client.post(
        "/api/auth/password",
        headers={"x-aperture-user": "user-admin"},
        json={"current_password": "whatever-password", "new_password": "new-password-123"},
    )

    assert response.status_code == 403


def test_uploaded_avatars_are_downscaled_before_they_reach_every_payload() -> None:
    """One user record ships in every directory payload, so a full-size photo
    inflates sign-in for the whole tenant."""
    from io import BytesIO

    from PIL import Image

    from app.routes.auth import PROFILE_IMAGE_MAX_EDGE_PIXELS

    photo = Image.new("RGB", (1800, 1200))
    for x in range(0, 1800, 3):
        for y in range(0, 1200, 5):
            photo.putpixel((x, y), (x % 256, y % 256, (x * y) % 256))
    buffer = BytesIO()
    photo.save(buffer, format="JPEG", quality=92)
    original = "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()

    response = client.patch(
        "/api/auth/profile",
        json={"avatar_url": original},
        headers={"x-aperture-user": "user-admin"},
    )
    assert response.status_code == 200
    stored = response.json()["avatar_url"]
    assert stored.startswith("data:image/webp;base64,")
    assert len(stored) < len(original) // 4

    decoded = base64.b64decode(stored.split(",", 1)[1])
    with Image.open(BytesIO(decoded)) as shrunk:
        assert max(shrunk.size) <= PROFILE_IMAGE_MAX_EDGE_PIXELS

    # A remote reference is a pointer, not payload weight; leave it alone.
    remote = client.patch(
        "/api/auth/profile",
        json={"avatar_url": "https://cdn.example.com/a.png"},
        headers={"x-aperture-user": "user-admin"},
    )
    assert remote.status_code == 200
    assert remote.json()["avatar_url"] == "https://cdn.example.com/a.png"
