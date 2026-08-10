"""Phase-2 honesty coverage: OAuth callbacks, SSO enforcement, web-source
fetching, platform settings/branding/elastic truthfulness, tenant audit
scoping, and group-permission enforcement."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.mcp_runtime import oauth_env_from_token_payload
from app.core.web_fetch import FetchedWebSource, WebFetchError
from app.main import app
from app.models.schemas import Role, User
from app.repositories.deps import get_store
from app.routes import knowledge as knowledge_route
from app.routes import platform as platform_route

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def seed_local_user(user_id: str, email: str, role: Role) -> None:
    store = get_store()
    store.users[user_id] = User(
        id=user_id,
        tenant_id="tenant-example",
        email=email,
        display_name=email.split("@", 1)[0].title(),
        role=role,
        group_ids=["group-litigation"] if role == Role.USER else [],
        active=True,
        auth_method="local",
    )
    store.set_password_credential(user_id, "local-password-123")


# --- A1: knowledge OAuth callback -------------------------------------------


def test_knowledge_oauth_callback_ready_error_and_unknown_paths() -> None:
    ready = client.get("/api/knowledge/knowledge-box-matters/oauth/callback")
    assert ready.status_code == 200
    assert ready.json()["status"] == "ready"
    assert ready.json()["knowledge_config_id"] == "knowledge-box-matters"

    provider_error = client.get(
        "/api/knowledge/knowledge-box-matters/oauth/callback",
        params={"error": "access_denied", "state": "state-1"},
    )
    assert provider_error.status_code == 200
    assert provider_error.json() == {
        "status": "error",
        "knowledge_config_id": "knowledge-box-matters",
        "name": "Box Matter Knowledge",
        "error": "access_denied",
        "state": "state-1",
    }

    unknown = client.get("/api/knowledge/knowledge-missing/oauth/callback")
    assert unknown.status_code == 404


def test_knowledge_oauth_callback_exchanges_code_and_stores_token(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeOAuthClient:
        def __init__(self, **kwargs: object) -> None:
            captured["client_kwargs"] = kwargs

        def __enter__(self) -> "FakeOAuthClient":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def post(self, url: str, *, data: dict[str, str], headers: dict[str, str]) -> httpx.Response:
            captured["url"] = url
            captured["data"] = data
            return httpx.Response(
                200,
                json={"access_token": "knowledge-access-token", "token_type": "Bearer", "scope": "matters.read"},
            )

    register = client.post(
        "/api/knowledge/knowledge-box-matters/api-sources",
        headers=headers("user-admin"),
        json={
            "name": "Matter API",
            "base_url": "https://api.matter.example.test",
            "auth_type": "oauth-client",
            "secret_value": "matter-client-secret",
            "client_id": "matter-client-id",
            "authorization_url": "https://login.example.test/oauth/authorize",
            "token_url": "https://login.example.test/oauth/token",
            "callback_url": "http://testserver/api/knowledge/knowledge-box-matters/oauth/callback",
            "scopes": ["matters.read"],
        },
    )
    assert register.status_code == 200

    monkeypatch.setattr(knowledge_route.httpx, "Client", FakeOAuthClient)
    from app.core.config import get_settings
    from app.core.sessions import sign_oidc_state

    state = sign_oidc_state({"config_id": "knowledge-box-matters", "actor_id": "user-admin"}, get_settings().secret_key)
    response = client.get(
        "/api/knowledge/knowledge-box-matters/oauth/callback",
        params={"code": "auth-code-123", "state": state},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "token_stored"
    assert body["token_type"] == "Bearer"
    assert captured["url"] == "https://login.example.test/oauth/token"
    assert captured["data"] == {
        "grant_type": "authorization_code",
        "code": "auth-code-123",
        "redirect_uri": "http://testserver/api/knowledge/knowledge-box-matters/oauth/callback",
        "client_id": "matter-client-id",
        "client_secret": "matter-client-secret",
    }

    store = get_store()
    token_payload = json.loads(store.configuration_secret("knowledge-oauth-token", "knowledge-box-matters") or "{}")
    assert token_payload["access_token"] == "knowledge-access-token"
    assert store.knowledge_configs["knowledge-box-matters"].settings["oauth_token_status"] == "stored"

    event = store.audit_events[-1]
    assert event.action == "knowledge.oauth_token_stored"
    assert event.action_type == "KNOWLEDGE_OAUTH_TOKEN_STORED"
    assert event.target == "knowledge-box-matters"
    assert event.metadata["access_token"] == "[redacted]"
    assert "knowledge-access-token" not in str(event.metadata)


def test_oauth_env_from_token_payload_builds_mcp_env() -> None:
    env = oauth_env_from_token_payload(json.dumps({"access_token": "tok-1", "token_type": "Bearer"}))
    assert env == {"MCP_OAUTH_ACCESS_TOKEN": "tok-1", "MCP_OAUTH_TOKEN_TYPE": "Bearer"}
    assert oauth_env_from_token_payload(None) == {}
    assert oauth_env_from_token_payload("not-json") == {}
    assert oauth_env_from_token_payload(json.dumps({"token_type": "Bearer"})) == {}


# --- A2: SSO enforce vs enable ------------------------------------------------


def test_enforced_sso_blocks_local_login_and_disabling_enforcement_keeps_sso_enabled() -> None:
    seed_local_user("user-local-example", "local.tester@example.com", Role.USER)
    # SSO management is owner-first by default; delegate so the tenant admin
    # can flip enforcement below.
    delegated = client.patch(
        "/api/platform/settings",
        headers=headers("user-owner"),
        json={"tenant_admins_can_manage_sso": True},
    )
    assert delegated.status_code == 200

    blocked = client.post(
        "/api/auth/login",
        json={"email": "local.tester@example.com", "auth_method": "local", "password": "local-password-123"},
    )
    assert blocked.status_code == 403
    assert "SSO is enforced for this email domain" in blocked.json()["detail"]

    # Turning enforcement OFF only flips settings.enforced; the provider stays enabled.
    relax = client.patch(
        "/api/admin/sso-configs/sso-entra-example",
        headers=headers("user-admin"),
        json={
            "enabled": True,
            "settings": {
                "enforced": False,
                "status": "ready",
                "domains": ["example.com"],
                "jit_provisioning": True,
                "default_role": "USER",
            },
        },
    )
    assert relax.status_code == 200
    assert relax.json()["enabled"] is True

    local_ok = client.post(
        "/api/auth/login",
        json={"email": "local.tester@example.com", "auth_method": "local", "password": "local-password-123"},
    )
    assert local_ok.status_code == 200

    # SSO sign-in remains offered because the provider stays enabled; the actual
    # login now happens through the OIDC redirect flow (covered in test_oidc_sso.py).
    options = client.get("/api/auth/options")
    assert any(provider["id"] == "sso-entra-example" for provider in options.json()["providers"])


# --- B5b: platform settings enforcement ---------------------------------------


def test_require_sso_for_admins_setting_gates_local_admin_login() -> None:
    seed_local_user("user-local-admin", "local.admin@acme-internal.test", Role.TENANT_ADMIN)

    baseline = client.post(
        "/api/auth/login",
        json={"email": "local.admin@acme-internal.test", "auth_method": "local", "password": "local-password-123"},
    )
    assert baseline.status_code == 200

    forbidden_patch = client.patch(
        "/api/platform/settings",
        headers=headers("user-admin"),
        json={"require_sso_for_admins": True},
    )
    assert forbidden_patch.status_code == 403

    enable = client.patch(
        "/api/platform/settings",
        headers=headers("user-owner"),
        json={"require_sso_for_admins": True},
    )
    assert enable.status_code == 200
    assert enable.json()["require_sso_for_admins"] is True
    event = get_store().audit_events[-1]
    assert event.action == "platform.settings_updated"
    assert event.action_type == "PLATFORM_SETTINGS_UPDATED"

    blocked = client.post(
        "/api/auth/login",
        json={"email": "local.admin@acme-internal.test", "auth_method": "local", "password": "local-password-123"},
    )
    assert blocked.status_code == 403
    assert "requires admin accounts to sign in through SSO" in blocked.json()["detail"]

    # The platform owner's own local sign-in is not an admin-role account and keeps working.
    get_store().set_password_credential("user-owner", "owner-password-123")
    owner_ok = client.post(
        "/api/auth/login",
        json={"email": "owner@aperture.local", "auth_method": "local", "password": "owner-password-123"},
    )
    assert owner_ok.status_code == 200


def test_tenant_admins_can_manage_sso_setting_gates_admin_sso_mutations() -> None:
    disable = client.patch(
        "/api/platform/settings",
        headers=headers("user-owner"),
        json={"tenant_admins_can_manage_sso": False},
    )
    assert disable.status_code == 200

    blocked = client.patch(
        "/api/admin/sso-configs/sso-entra-example",
        headers=headers("user-admin"),
        json={"settings": {"enforced": False, "domains": ["example.com"]}},
    )
    assert blocked.status_code == 403
    assert "Organization policy does not permit SSO changes" in blocked.json()["detail"]

    owner_still_allowed = client.patch(
        "/api/admin/sso-configs/sso-entra-example",
        headers=headers("user-owner"),
        json={"settings": {"enforced": True, "domains": ["example.com"], "jit_provisioning": True}},
    )
    assert owner_still_allowed.status_code == 200


# --- B5c: elastic status honesty ----------------------------------------------


def test_elastic_status_reports_configuration_reality(monkeypatch: pytest.MonkeyPatch) -> None:
    unconfigured = client.get("/api/platform/elastic/status", headers=headers("user-owner"))
    assert unconfigured.status_code == 200
    body = unconfigured.json()
    assert body["configured"] is False
    assert body["connected"] is False
    assert "APERTURE_ELASTIC_URL" in body["message"]

    settings = platform_route.get_settings().model_copy(
        update={"elastic_url": "https://elastic.example.test:9243", "elastic_api_key": "elastic-key"}
    )
    monkeypatch.setattr("app.routes.platform.get_settings", lambda: settings)
    configured = client.get("/api/platform/elastic/status", headers=headers("user-owner"))
    assert configured.status_code == 200
    assert configured.json()["configured"] is True
    assert configured.json()["connected"] is True

    admin_blocked = client.get("/api/platform/elastic/status", headers=headers("user-admin"))
    assert admin_blocked.status_code == 403


# --- B5d: tenant branding persistence ------------------------------------------


def test_branding_route_persists_updates_and_emits_audit_event() -> None:
    response = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-owner"),
        json={"chat_brand_name": "Example AI", "primary_color": "#123456", "icon_url": None},
    )
    assert response.status_code == 200
    assert response.json()["chat_brand_name"] == "Example AI"

    bootstrap = client.get("/api/bootstrap", headers=headers("user-owner"))
    assert bootstrap.json()["currentTenant"]["chat_brand_name"] == "Example AI"
    assert bootstrap.json()["currentTenant"]["primary_color"] == "#123456"

    event = get_store().audit_events[-1]
    assert event.action == "platform.branding_updated"
    assert event.action_type == "BRANDING_UPDATED"
    assert event.target_name == "Example Corporation"
    assert "chat_brand_name" in event.metadata["changed"]

    admin_blocked = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-admin"),
        json={"chat_brand_name": "Nope"},
    )
    assert admin_blocked.status_code == 403

    unknown_tenant = client.patch(
        "/api/platform/tenants/tenant-missing/branding",
        headers=headers("user-owner"),
        json={"chat_brand_name": "Nope"},
    )
    assert unknown_tenant.status_code == 404


def test_branding_route_persists_theme_fields_and_exposes_them_pre_auth() -> None:
    response = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-owner"),
        json={
            "primary_color": "#7C3AED",
            "gradient_start": "#1E1B4B",
            "gradient_end": "#7C3AED",
            "text_color": "#111827",
        },
    )
    assert response.status_code == 200
    body = response.json()
    # Hex values are normalized to lowercase before persisting.
    assert body["primary_color"] == "#7c3aed"
    assert body["gradient_start"] == "#1e1b4b"
    assert body["gradient_end"] == "#7c3aed"
    assert body["text_color"] == "#111827"

    # The login screen needs the theme before auth.
    options = client.get("/api/auth/options")
    branding = options.json()["tenant_branding"]
    assert branding["gradient_start"] == "#1e1b4b"
    assert branding["text_color"] == "#111827"

    # Explicit nulls clear the theme back to platform defaults.
    cleared = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-owner"),
        json={"gradient_start": None, "gradient_end": None, "text_color": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["gradient_start"] is None
    assert cleared.json()["text_color"] is None


def test_branding_route_rejects_invalid_values() -> None:
    bad_color = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-owner"),
        json={"primary_color": "not-a-color"},
    )
    assert bad_color.status_code == 422

    bad_gradient = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-owner"),
        json={"gradient_start": "#12"},
    )
    assert bad_gradient.status_code == 422

    bad_mark = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-owner"),
        json={"logo_mark": "sparkles"},
    )
    assert bad_mark.status_code == 422

    bad_scheme = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-owner"),
        json={"logo_url": "javascript:alert(1)"},
    )
    assert bad_scheme.status_code == 422

    oversized = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-owner"),
        json={"icon_url": "data:image/png;base64," + "A" * 400_001},
    )
    assert oversized.status_code == 422

    long_name = client.patch(
        "/api/platform/tenants/tenant-example/branding",
        headers=headers("user-owner"),
        json={"chat_brand_name": "B" * 61},
    )
    assert long_name.status_code == 422

    # Nothing invalid was persisted.
    tenant = get_store().tenants["tenant-example"]
    assert tenant.logo_mark == "aperture"
    assert tenant.chat_brand_name == "Aperture Chat"


# --- B4: web source fetching ----------------------------------------------------


def test_web_source_fetches_url_and_indexes_extracted_text(monkeypatch: pytest.MonkeyPatch) -> None:
    url = "https://example.test/retention-guidance"
    monkeypatch.setattr(
        knowledge_route,
        "fetch_web_source",
        lambda requested_url, **_kwargs: FetchedWebSource(
            requested_url=requested_url,
            final_url=requested_url,
            filename="retention-guidance.html",
            content_type="text/html",
            text="Retention guidance\nLitigation holds suspend deletion schedules.",
            byte_count=81,
        ),
    )

    response = client.post(
        "/api/knowledge/knowledge-box-matters/web-sources",
        headers=headers("user-admin"),
        json={"name": "Retention guidance", "url": url, "text": None},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_message"].startswith("Fetched https://example.test/retention-guidance and indexed")
    added = next(document for document in payload["documents"] if document["name"] == "Retention guidance")
    assert added["source_type"] == "web"
    assert added["chunk_count"] >= 1

    hits = get_store().retrieve_knowledge(
        get_store().users["user-admin"],
        ["knowledge-box-matters"],
        "litigation holds suspend deletion",
        limit=3,
    )
    assert any("Litigation holds suspend deletion schedules." in hit.text for hit in hits)


def test_web_source_fetch_failure_creates_no_document(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_fetch(_url: str, **_kwargs: object) -> FetchedWebSource:
        raise WebFetchError(502, "Web source fetch failed: dns failure in test")

    monkeypatch.setattr(knowledge_route, "fetch_web_source", fail_fetch)
    before = len(get_store().knowledge_documents_for("knowledge-box-matters"))

    response = client.post(
        "/api/knowledge/knowledge-box-matters/web-sources",
        headers=headers("user-admin"),
        json={"name": "Broken source", "url": "https://broken.example.test/page", "text": None},
    )

    assert response.status_code == 502
    assert "Web source fetch failed" in response.json()["detail"]
    assert len(get_store().knowledge_documents_for("knowledge-box-matters")) == before


def test_web_source_manual_text_mode_is_labeled_as_unfetched() -> None:
    response = client.post(
        "/api/knowledge/knowledge-box-matters/web-sources",
        headers=headers("user-admin"),
        json={
            "name": "Pasted guidance",
            "url": "https://example.test/pasted",
            "text": "Operator-provided summary of the retention policy.",
        },
    )
    assert response.status_code == 200
    assert response.json()["provider_message"] == (
        "Indexed operator-provided text for https://example.test/pasted; the page itself was not fetched."
    )


# --- B7: tenant audit endpoint ---------------------------------------------------


def test_admin_audit_events_are_tenant_scoped_and_hide_platform_actions() -> None:
    owner_toggle = client.patch(
        "/api/platform/models/gpt-4o",
        headers=headers("user-owner"),
        json={"platform_enabled": False},
    )
    assert owner_toggle.status_code == 200
    restore = client.patch(
        "/api/platform/models/gpt-4o",
        headers=headers("user-owner"),
        json={"platform_enabled": True},
    )
    assert restore.status_code == 200

    role_change = client.patch(
        "/api/admin/users/user-jane",
        headers=headers("user-admin"),
        json={"role": "POWER_USER"},
    )
    assert role_change.status_code == 200

    response = client.get("/api/admin/audit-events", headers=headers("user-admin"))
    assert response.status_code == 200
    events = response.json()
    assert events, "tenant audit trail should contain the admin mutation"
    assert events[0]["action_type"] == "USER_ROLE_CHANGED"
    assert all(event["tenant_id"] == "tenant-example" for event in events)
    assert all(not event["action"].startswith("platform.") for event in events)
    assert all(event["action_type"] not in {"MODEL_DISABLED", "MODEL_ENABLED"} for event in events)

    user_blocked = client.get("/api/admin/audit-events", headers=headers("user-jane"))
    assert user_blocked.status_code == 403


# --- B8: group permission enforcement --------------------------------------------


def _set_litigation_permissions(**overrides: bool) -> None:
    response = client.patch(
        "/api/admin/groups/group-litigation",
        headers=headers("user-admin"),
        json={"permissions": overrides},
    )
    assert response.status_code == 200


def test_group_chat_permission_gates_chat_completion() -> None:
    _set_litigation_permissions(chat_access=False)

    blocked = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "Chat access is disabled for your platform groups by tenant policy."

    _set_litigation_permissions(chat_access=True)
    allowed = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]},
    )
    # The gate passes; the unconfigured Azure provider then honestly 503s.
    assert allowed.status_code == 503
    assert "Azure OpenAI is not configured for live completions" in allowed.json()["detail"]


def test_group_knowledge_tools_and_agents_permissions_gate_routes() -> None:
    _set_litigation_permissions(knowledge_access=False)
    knowledge_blocked = client.get(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers("user-jane"),
    )
    assert knowledge_blocked.status_code == 403
    assert knowledge_blocked.json()["detail"] == "Knowledge access is disabled for your platform groups by tenant policy."

    search_blocked = client.post(
        "/api/knowledge/search",
        headers=headers("user-jane"),
        json={"query": "response deadline"},
    )
    assert search_blocked.status_code == 403

    # Admins are not gated by tenant group permissions.
    admin_ok = client.get(
        "/api/knowledge/knowledge-box-matters/documents",
        headers=headers("user-admin"),
    )
    assert admin_ok.status_code == 200

    _set_litigation_permissions(knowledge_access=True, tools_access=False)
    tools_blocked = client.post(
        "/api/chat/complete",
        headers=headers("user-jane"),
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}],
            "tool_config_ids": ["tool-hermes-example"],
        },
    )
    assert tools_blocked.status_code == 403
    assert tools_blocked.json()["detail"] == "Tool access is disabled for your platform groups by tenant policy."

    _set_litigation_permissions(tools_access=True, agents_access=False)
    agents_blocked = client.get("/api/agents/runs", headers=headers("user-jane"))
    assert agents_blocked.status_code == 403
    assert agents_blocked.json()["detail"] == "Agent access is disabled for your platform groups by tenant policy."

    _set_litigation_permissions(agents_access=True)
    agents_ok = client.get("/api/agents/runs", headers=headers("user-jane"))
    assert agents_ok.status_code == 200
