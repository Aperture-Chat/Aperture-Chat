"""Library > Tools flows, replaying the exact payloads the web editor sends.

The connection editor sends only the fields that changed, the Enabled switch
sends only ``{"enabled": ...}``, and older clients re-sent an empty stdio
command on every save. These tests pin the server side of that contract for
tenant admins and self-authoring users, plus the OAuth round trip and the
companion/approval interaction in chat.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.models.schemas import ModelConfig, ToolConfig
from app.repositories.deps import get_store
from app.routes import tools as tools_route

client = TestClient(app)

AUTHOR_ID = "user-jane"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _grant_tool_authoring() -> None:
    store = get_store()
    for group_id in store.users[AUTHOR_ID].group_ids:
        store.groups[group_id].permissions["tool_authoring"] = True


# Payloads exactly as ToolsLibrary.tsx builds them.
def _ui_create_payload(name: str = "Docs Search") -> dict[str, object]:
    return {
        "name": name,
        "tool_type": "mcp",
        "endpoint_url": "https://mcp.example.com/mcp",
        "enabled": False,
        "approval_required": True,
        "allowed_group_ids": [],
        "settings": {"transport": "http"},
    }


def _ui_save_payload() -> dict[str, object]:
    return {
        "name": "Docs Search MCP",
        "settings": {
            "description": "Searches the internal docs site.",
            "auth_type": "bearer-token",
            "runtime_invocations": [
                {"tool_name": "search", "label": "Docs search", "arguments": {"q": "{{query}}"}}
            ],
        },
        "secret_value": "synthetic-token-123",
    }


def _create_save_toggle(user_id: str) -> dict:
    created = client.post("/api/admin/tool-configs", headers=headers(user_id), json=_ui_create_payload())
    assert created.status_code == 201, created.text
    tool = created.json()
    assert tool["enabled"] is False
    assert tool["settings"] == {"transport": "http"}
    assert tool["allowed_group_ids"] == []

    saved = client.patch(
        f"/api/admin/tool-configs/{tool['id']}", headers=headers(user_id), json=_ui_save_payload()
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["name"] == "Docs Search MCP"
    assert body["tool_type"] == "mcp"
    assert body["settings"]["transport"] == "http"
    assert body["settings"]["auth_type"] == "bearer-token"
    assert body["secret_set"] is True

    for enabled in (True, False):
        toggled = client.patch(
            f"/api/admin/tool-configs/{tool['id']}", headers=headers(user_id), json={"enabled": enabled}
        )
        assert toggled.status_code == 200, toggled.text
        assert toggled.json()["enabled"] is enabled
        # The switch never touches the rest of the configuration.
        assert toggled.json()["settings"] == body["settings"]
    return body


def test_tenant_admin_creates_saves_enables_and_disables_http_tool() -> None:
    tool = _create_save_toggle("user-admin")
    assert tool["owner_user_id"] is None


def test_self_authoring_user_creates_saves_enables_and_disables_own_tool() -> None:
    _grant_tool_authoring()
    tool = _create_save_toggle(AUTHOR_ID)
    assert tool["owner_user_id"] == AUTHOR_ID
    # Self-authors still can't run admin connection checks (the UI hides them).
    health = client.post(f"/api/tools/{tool['id']}/mcp/health", headers=headers(AUTHOR_ID))
    assert health.status_code == 403


@pytest.mark.parametrize("user_id", ["user-admin", AUTHOR_ID])
def test_empty_stdio_command_resubmits_are_treated_as_no_change(user_id: str) -> None:
    # Regression: older clients sent command "" / args [] / transport on every
    # save and toggle, and the server read that as "adding a host command".
    if user_id == AUTHOR_ID:
        _grant_tool_authoring()
    tool = client.post(
        "/api/admin/tool-configs", headers=headers(user_id), json=_ui_create_payload()
    ).json()
    legacy_save = client.patch(
        f"/api/admin/tool-configs/{tool['id']}",
        headers=headers(user_id),
        json={
            "name": "Docs Search",
            "enabled": True,
            "settings": {"transport": "http", "command": "", "args": [], "scopes": []},
        },
    )
    assert legacy_save.status_code == 200, legacy_save.text

    # Adding a real command stays owner-only, whatever the transport spelling.
    for settings in (
        {"transport": "stdio", "command": "/bin/sh"},
        {"transport": " STDIO ", "command": "python", "args": ["-c", "print(1)"]},
    ):
        blocked = client.patch(
            f"/api/admin/tool-configs/{tool['id']}", headers=headers(user_id), json={"settings": settings}
        )
        assert blocked.status_code == 403
        assert "service level" in blocked.json()["detail"]
    assert get_store().tool_configs[tool["id"]].settings.get("command") in (None, "")


def test_tenant_admin_can_toggle_and_resave_a_service_managed_stdio_tool() -> None:
    # The seeded Hermes tool launches `hermes mcp serve`, configured by the
    # platform owner. Admins can still turn it on/off and edit other settings.
    tool_id = "tool-hermes-agent-mcp"
    assert client.patch(
        f"/api/admin/tool-configs/{tool_id}", headers=headers("user-admin"), json={"enabled": False}
    ).status_code == 200
    unchanged_resend = client.patch(
        f"/api/admin/tool-configs/{tool_id}",
        headers=headers("user-admin"),
        json={"settings": {"transport": "stdio", "command": " hermes ", "args": ["mcp", "serve"]}},
    )
    assert unchanged_resend.status_code == 200
    # ...but cannot clear or re-point the command.
    for settings in ({"command": ""}, {"args": ["mcp"]}, {"command": "/bin/sh"}):
        response = client.patch(
            f"/api/admin/tool-configs/{tool_id}", headers=headers("user-admin"), json={"settings": settings}
        )
        assert response.status_code == 403, settings
    saved = get_store().tool_configs[tool_id].settings
    assert saved["command"] == "hermes"
    assert saved["args"] == ["mcp", "serve"]


def test_hermes_switch_never_changes_a_custom_script_tool_type() -> None:
    created = client.post(
        "/api/admin/tool-configs",
        headers=headers("user-admin"),
        json={
            "name": "Uppercase",
            "tool_type": "custom_script",
            "approval_required": False,
            "settings": {"script": "print('hi')", "timeout_seconds": 5},
        },
    )
    assert created.status_code == 201, created.text
    tool_id = created.json()["id"]

    converted = client.patch(
        f"/api/admin/tool-configs/{tool_id}",
        headers=headers("user-admin"),
        json={"tool_type": "mcp", "settings": {"hermes_companion": True}},
    )
    assert converted.status_code == 400
    assert get_store().tool_configs[tool_id].tool_type == "custom_script"
    assert get_store().tool_configs[tool_id].settings.get("hermes_companion") is None

    same_type = client.patch(
        f"/api/admin/tool-configs/{tool_id}",
        headers=headers("user-admin"),
        json={"tool_type": "custom_script", "name": "Uppercase v2"},
    )
    assert same_type.status_code == 200
    assert same_type.json()["tool_type"] == "custom_script"


def test_clearing_a_saved_tool_secret() -> None:
    tool = client.post(
        "/api/admin/tool-configs",
        headers=headers("user-admin"),
        json={**_ui_create_payload(), "secret_value": "synthetic-token"},
    ).json()
    assert tool["secret_set"] is True
    cleared = client.delete(f"/api/admin/tool-configs/{tool['id']}/secret", headers=headers("user-admin"))
    assert cleared.status_code == 200
    assert cleared.json()["secret_set"] is False
    assert cleared.json()["masked_secret"] is None
    assert get_store().configuration_secret("tool", tool["id"]) is None
    # Standard users without the authoring grant cannot.
    assert client.delete(
        f"/api/admin/tool-configs/{tool['id']}/secret", headers=headers("user-casey")
    ).status_code == 403


class _FakeTokenClient:
    captured: dict[str, object] = {}

    def __init__(self, timeout: float) -> None:
        pass

    def __enter__(self) -> "_FakeTokenClient":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def post(self, url: str, *, data: dict[str, str], headers: dict[str, str]) -> httpx.Response:
        type(self).captured = {"url": url, "data": data}
        return httpx.Response(
            200, json={"access_token": "synthetic-access", "token_type": "Bearer", "scope": "docs.read"}
        )


def test_oauth_authorize_url_round_trip_uses_configured_public_callback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APERTURE_API_BASE_URL", "https://aperture.example.com")
    get_settings.cache_clear()
    monkeypatch.setattr(tools_route.httpx, "Client", _FakeTokenClient)
    try:
        store = get_store()
        store.tool_configs["tool-oauth-docs"] = ToolConfig(
            id="tool-oauth-docs",
            tenant_id="tenant-example",
            name="Docs OAuth",
            tool_type="mcp",
            endpoint_url="https://mcp.example.com/mcp",
            enabled=True,
            approval_required=False,
            settings={
                "transport": "http",
                "auth_type": "oauth-2.1-static",
                "client_id": "client-docs",
                "oauth_authorization_url": "https://auth.example.com/authorize",
                "oauth_token_url": "https://auth.example.com/token",
                "scopes": ["docs.read"],
                # A relative value saved by older clients is ignored.
                "oauth_callback_url": "/api/tools/tool-oauth-docs/oauth/callback",
            },
        )

        authorize = client.get("/api/tools/tool-oauth-docs/oauth/authorize-url", headers=headers("user-admin"))
        assert authorize.status_code == 200
        body = authorize.json()
        expected_redirect = "https://aperture.example.com/api/tools/tool-oauth-docs/oauth/callback"
        assert body["redirect_uri"] == expected_redirect
        query = parse_qs(urlparse(body["authorize_url"]).query)
        assert query["redirect_uri"] == [expected_redirect]
        assert query["client_id"] == ["client-docs"]
        assert query["scope"] == ["docs.read"]
        assert query["state"] == [body["state"]]

        # Standard users can't start a provider sign-in.
        assert client.get(
            "/api/tools/tool-oauth-docs/oauth/authorize-url", headers=headers("user-casey")
        ).status_code == 403

        callback = client.get(
            "/api/tools/tool-oauth-docs/oauth/callback", params={"code": "code-1", "state": body["state"]}
        )
        assert callback.status_code == 200
        assert "Docs OAuth is connected" in callback.text
        assert _FakeTokenClient.captured["data"]["redirect_uri"] == expected_redirect
        assert store.tool_configs["tool-oauth-docs"].settings["oauth_token_status"] == "stored"

        forged = client.get(
            "/api/tools/tool-oauth-docs/oauth/callback", params={"code": "code-2", "state": "tool-oauth-docs"}
        )
        assert forged.status_code == 400
        assert "invalid or has expired" in forged.text

        disconnected = client.delete("/api/tools/tool-oauth-docs/oauth/token", headers=headers("user-admin"))
        assert disconnected.status_code == 200
        assert "oauth_token_status" not in disconnected.json()["settings"]
        assert store.configuration_secret("tool-oauth-token", "tool-oauth-docs") is None
    finally:
        get_settings.cache_clear()


def test_agent_turn_skips_tools_the_user_cannot_use_instead_of_failing(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    store.tool_configs["tool-restricted-web"] = ToolConfig(
        id="tool-restricted-web",
        tenant_id="tenant-example",
        name="Finance only",
        tool_type="webhook",
        endpoint_url="https://hooks.example.com/finance",
        enabled=True,
        approval_required=False,
        allowed_group_ids=["group-finance"],
    )
    store.tool_configs["tool-turned-off"] = ToolConfig(
        id="tool-turned-off",
        tenant_id="tenant-example",
        name="Turned off",
        tool_type="webhook",
        enabled=False,
        approval_required=False,
    )
    captured: dict[str, object] = {}

    def fake_runtime(store_arg, actor, request, model):  # noqa: ANN001
        from app.routes import chat as chat_route

        context = original(store_arg, actor, request, model)
        captured.update(context)
        raise chat_route.HTTPException(status_code=418, detail="stop after runtime context")

    from app.routes import chat as chat_route

    original = chat_route._resolve_runtime_context
    monkeypatch.setattr(chat_route, "_resolve_runtime_context", fake_runtime)
    store.users["user-casey"].group_ids = ["group-litigation"]
    response = client.post(
        "/api/chat/complete",
        headers=headers("user-casey"),
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}],
            "agent_enabled": True,
            "tool_config_ids": ["tool-restricted-web", "tool-turned-off", "tool-deleted"],
        },
    )
    # The turn reached the runtime context instead of failing with a 403/404.
    assert response.status_code == 418, response.text
    assert captured["tool_config_ids"] == []
    assert captured["skipped_tool_config_ids"] == [
        "tool-restricted-web",
        "tool-turned-off",
        "tool-deleted",
    ]


def test_unapproved_companion_tool_is_left_out_instead_of_failing_hermes_chat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    store.groups["group-litigation"].permissions["hermes_companion"] = True
    store.models["agent-hermes-plain"] = ModelConfig(
        id="agent-hermes-plain",
        tenant_id="tenant-example",
        provider_id="provider-azure",
        provider_name="Azure OpenAI",
        name="Hermes Plain",
        upstream_model_id="gpt-4o",
        group_ids=["group-litigation"],
        agentic_companion="hermes",
        tool_config_ids=[],
    )
    captured: dict[str, object] = {}
    from app.routes import chat as chat_route

    original = chat_route._resolve_runtime_context

    def fake_runtime(store_arg, actor, request, model):  # noqa: ANN001
        context = original(store_arg, actor, request, model)
        captured.update(context)
        raise chat_route.HTTPException(status_code=418, detail="stop after runtime context")

    monkeypatch.setattr(chat_route, "_resolve_runtime_context", fake_runtime)
    response = client.post(
        "/api/chat/complete",
        headers=headers("user-admin"),
        json={
            "model": "agent-hermes-plain",
            "agent_profile_id": "agent-hermes-plain",
            "messages": [{"role": "user", "content": "hello"}],
            "agent_enabled": True,
        },
    )
    # Before: 403 "MCP tool approval required" although nothing asked the user.
    assert response.status_code == 418, response.text
    assert "tool-hermes-agent-mcp" not in captured["tool_config_ids"]
    assert "tool-hermes-agent-mcp" in captured["skipped_tool_config_ids"]
    assert captured["mcp_servers"] == []


def test_prompt_and_skill_saves_stamp_a_real_timestamp() -> None:
    template = client.post(
        "/api/admin/prompt-templates",
        headers=headers("user-admin"),
        json={"name": "Weekly update", "content": "Summarize {{topic}}."},
    )
    assert template.status_code == 201
    assert template.json()["updated_at"][:4].isdigit()
    updated = client.patch(
        f"/api/admin/prompt-templates/{template.json()['id']}",
        headers=headers("user-admin"),
        json={"content": "Summarize {{topic}} in three bullets."},
    )
    assert updated.json()["updated_at"] != "Just now"
    assert "T" in updated.json()["updated_at"]

    skill = client.post(
        "/api/admin/skill-files",
        headers=headers("user-admin"),
        json={"name": "Citations", "content": "# Cite every claim"},
    )
    assert skill.status_code == 201
    assert "T" in skill.json()["updated_at"]
