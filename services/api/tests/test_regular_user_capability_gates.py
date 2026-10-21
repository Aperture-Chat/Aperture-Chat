"""Risky capabilities stay off for standard users until an administrator opts in.

MCP connections (tool_authoring), API sources (api_source_authoring), and
Hermes (hermes_companion) are group grants that default to off. Admin-shared
connections stay usable; what a standard user cannot do without the grant is
add their own, call APIs on a schedule, or open Hermes agents and connections.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.core.api_source_fetch as api_fetch
from app.core.automation_runner import _step_context
from app.main import app
from app.models.schemas import KnowledgeConfig, ModelConfig, default_group_permissions
from app.repositories.deps import get_store
from app.routes import chat as chat_route
from app.routes import knowledge as knowledge_route

client = TestClient(app)

USER_ID = "user-jane"
ADMIN_ID = "user-admin"
HERMES_TOOL_ID = "tool-hermes-agent-mcp"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _grant(user_id: str, permission: str, enabled: bool) -> None:
    store = get_store()
    for group_id in store.users[user_id].group_ids:
        store.groups[group_id].permissions[permission] = enabled


def _mock_api(monkeypatch: pytest.MonkeyPatch, payload: dict[str, object]) -> None:
    monkeypatch.setattr(api_fetch, "validate_public_url", lambda _url: None)
    real_fetch = api_fetch.fetch_api_source
    monkeypatch.setattr(
        knowledge_route,
        "fetch_api_source",
        lambda request, **kwargs: real_fetch(
            request,
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload)),
            **kwargs,
        ),
    )


def _own_knowledge_base(user_id: str = USER_ID) -> KnowledgeConfig:
    store = get_store()
    config = KnowledgeConfig(
        id="knowledge-jane-private",
        tenant_id="tenant-example",
        name="Jane's research",
        source_type="upload",
        enabled=True,
        owner_user_id=user_id,
        settings={"status": "draft", "document_count": 0, "last_sync": "Not synced"},
    )
    store.knowledge_configs[config.id] = config
    return config


def _api_source_body() -> dict[str, object]:
    return {"name": "Deadlines", "base_url": "https://api.example.test/deadlines"}


def _hermes_profile() -> ModelConfig:
    store = get_store()
    profile = ModelConfig(
        id="agent-hermes-shared",
        tenant_id="tenant-example",
        provider_id="provider-azure",
        provider_name="Azure OpenAI",
        name="Hermes Matter Agent",
        upstream_model_id="gpt-4o",
        group_ids=["group-litigation"],
        visibility="tenant",
        agentic_companion="hermes",
        is_custom=True,
    )
    store.models[profile.id] = profile
    return profile


def test_risky_grants_default_to_off() -> None:
    defaults = default_group_permissions()
    for permission in (
        "tool_authoring",
        "api_source_authoring",
        "hermes_companion",
        "api_access",
        "agent_authoring",
        "knowledge_authoring",
    ):
        assert defaults[permission] is False, permission
    # Using what an administrator shares stays on by default.
    assert defaults["tools_access"] is True


def test_knowledge_authoring_alone_does_not_allow_api_sources(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _grant(USER_ID, "knowledge_authoring", True)
    config = _own_knowledge_base()
    _mock_api(monkeypatch, {"deadline": "July 8"})

    denied = client.post(
        f"/api/knowledge/{config.id}/api-sources", headers=headers(USER_ID), json=_api_source_body()
    )
    assert denied.status_code == 403
    assert "API sources are disabled" in denied.json()["detail"]
    oauth = client.get(f"/api/knowledge/{config.id}/oauth/authorize-url", headers=headers(USER_ID))
    assert oauth.status_code == 403
    assert not any(
        document.source_type == "api" for document in get_store().knowledge_documents_for(config.id)
    )

    _grant(USER_ID, "api_source_authoring", True)
    allowed = client.post(
        f"/api/knowledge/{config.id}/api-sources", headers=headers(USER_ID), json=_api_source_body()
    )
    assert allowed.status_code == 200, allowed.text


def test_groups_without_the_api_source_key_do_not_grant_it() -> None:
    from app.core.policy import api_source_authoring_allowed

    _grant(USER_ID, "knowledge_authoring", True)
    store = get_store()
    for group_id in store.users[USER_ID].group_ids:
        store.groups[group_id].permissions.pop("api_source_authoring", None)
    assert not api_source_authoring_allowed(store.users[USER_ID], store.groups)


def test_either_hermes_marker_makes_a_connection_a_hermes_tool() -> None:
    from app.core.policy import is_hermes_tool
    from app.models.schemas import ToolConfig

    def tool(settings: dict[str, object]) -> ToolConfig:
        return ToolConfig(id="tool-x", tenant_id="tenant-example", name="X", tool_type="mcp", settings=settings)

    assert is_hermes_tool(tool({"hermes_companion": True}))
    assert is_hermes_tool(tool({"mcp_server": "hermes-agent"}))
    assert not is_hermes_tool(tool({"hermes_companion": "yes", "mcp_server": "other"}))


def test_api_source_grant_does_nothing_without_knowledge_authoring() -> None:
    _grant(USER_ID, "api_source_authoring", True)
    config = _own_knowledge_base()
    resp = client.post(
        f"/api/knowledge/{config.id}/api-sources", headers=headers(USER_ID), json=_api_source_body()
    )
    assert resp.status_code == 403


def test_revoking_the_api_grant_pauses_sync_but_keeps_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _grant(USER_ID, "knowledge_authoring", True)
    _grant(USER_ID, "api_source_authoring", True)
    config = _own_knowledge_base()
    calls: list[str] = []
    monkeypatch.setattr(api_fetch, "validate_public_url", lambda _url: None)
    real_fetch = api_fetch.fetch_api_source

    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json={"deadline": "July 8"})

    monkeypatch.setattr(
        knowledge_route,
        "fetch_api_source",
        lambda request, **kwargs: real_fetch(
            request, transport=httpx.MockTransport(recording), **kwargs
        ),
    )
    added = client.post(
        f"/api/knowledge/{config.id}/api-sources", headers=headers(USER_ID), json=_api_source_body()
    )
    assert added.status_code == 200, added.text
    assert len(calls) == 1

    _grant(USER_ID, "api_source_authoring", False)
    synced = client.post(
        f"/api/knowledge/{config.id}/sync", headers=headers(USER_ID), json={"force": True}
    )

    assert synced.status_code == 200, synced.text
    assert len(calls) == 1, "a paused API source must not be fetched"
    assert "API sources are turned off for your groups" in synced.json()["provider_message"]
    assert any(
        document.source_type == "api" for document in get_store().knowledge_documents_for(config.id)
    )


def test_standard_user_cannot_open_a_hermes_agent_without_the_grant() -> None:
    profile = _hermes_profile()
    resp = client.post(
        "/api/chat/complete",
        headers=headers(USER_ID),
        json={
            "model": profile.id,
            "agent_profile_id": profile.id,
            "agent_enabled": True,
            "messages": [{"role": "user", "content": "Summarize the matter."}],
        },
    )
    assert resp.status_code == 403
    assert "Hermes companion" in resp.json()["detail"]
    assert "administrator" in resp.json()["detail"]


def test_hermes_connections_are_skipped_for_locked_users_only() -> None:
    store = get_store()
    jane = store.users[USER_ID]
    usable, skipped = chat_route._resolve_usable_tool_configs(store, jane, [HERMES_TOOL_ID])
    assert usable == []
    assert skipped == [HERMES_TOOL_ID]

    _grant(USER_ID, "hermes_companion", True)
    usable, skipped = chat_route._resolve_usable_tool_configs(store, jane, [HERMES_TOOL_ID])
    assert [tool.id for tool in usable] == [HERMES_TOOL_ID]
    assert skipped == []


def test_admins_keep_hermes_tools_for_building_and_testing() -> None:
    store = get_store()
    admin = store.users[ADMIN_ID]
    for group_id in admin.group_ids:
        store.groups[group_id].permissions["hermes_companion"] = False
    usable, _skipped = chat_route._resolve_usable_tool_configs(store, admin, [HERMES_TOOL_ID])
    assert [tool.id for tool in usable] == [HERMES_TOOL_ID]


def test_automation_steps_refuse_hermes_agents_for_locked_users() -> None:
    profile = _hermes_profile()
    store = get_store()
    with pytest.raises(HTTPException) as raised:
        _step_context(store, store.users[USER_ID], profile, "Draft it.", step_label="Step 1")
    assert raised.value.status_code == 403
    assert "Hermes companion" in raised.value.detail


def test_bootstrap_reports_api_source_and_hermes_state() -> None:
    state = client.get("/api/bootstrap", headers=headers(USER_ID)).json()["authoringState"]
    assert state["api_sources_enabled"] is False
    assert state["hermes_enabled"] is False
    assert state["tools_enabled"] is False

    _grant(USER_ID, "knowledge_authoring", True)
    _grant(USER_ID, "api_source_authoring", True)
    _grant(USER_ID, "hermes_companion", True)
    state = client.get("/api/bootstrap", headers=headers(USER_ID)).json()["authoringState"]
    assert state["api_sources_enabled"] is True
    assert state["hermes_enabled"] is True

    admin_state = client.get("/api/bootstrap", headers=headers(ADMIN_ID)).json()["authoringState"]
    assert admin_state["api_sources_enabled"] is True
    assert admin_state["hermes_enabled"] is True


def test_user_knowledge_bases_cannot_bind_a_workspace_connector() -> None:
    _grant(USER_ID, "knowledge_authoring", True)
    store = get_store()
    connector_id = next(iter(store.connector_configs), None)
    for body in (
        *(
            {"name": f"Firm {source}", "source_type": source}
            for source in ("box", "microsoft-graph", "google-drive", "imanage")
        ),
        {"name": "Bound upload", "source_type": "upload", "connector_config_id": connector_id or "cc-any"},
    ):
        resp = client.post("/api/admin/knowledge-configs", headers=headers(USER_ID), json=body)
        assert resp.status_code == 403, body
        assert "set up by administrators" in resp.json()["detail"]

    created = client.post(
        "/api/admin/knowledge-configs",
        headers=headers(USER_ID),
        json={"name": "Mine", "source_type": "upload"},
    )
    assert created.status_code == 201
    rebound = client.patch(
        f"/api/admin/knowledge-configs/{created.json()['id']}",
        headers=headers(USER_ID),
        json={"source_type": "google-drive"},
    )
    assert rebound.status_code == 403
    renamed = client.patch(
        f"/api/admin/knowledge-configs/{created.json()['id']}",
        headers=headers(USER_ID),
        json={"name": "Mine, renamed"},
    )
    assert renamed.status_code == 200


def test_granted_tool_authors_add_mcp_connections_only() -> None:
    _grant(USER_ID, "tool_authoring", True)
    script = client.post(
        "/api/admin/tool-configs",
        headers=headers(USER_ID),
        json={"name": "Shell", "tool_type": "custom_script", "settings": {"script": "print(1)"}},
    )
    assert script.status_code == 403
    assert "custom script" in script.json()["detail"]
    preview = client.post(
        "/api/admin/tool-configs/script-preview",
        headers=headers(USER_ID),
        json={"script": "print(1)", "input": ""},
    )
    assert preview.status_code == 403

    hermes_flagged = client.post(
        "/api/admin/tool-configs",
        headers=headers(USER_ID),
        json={
            "name": "My Hermes",
            "tool_type": "mcp",
            "endpoint_url": "https://mcp.example.com/sse",
            "settings": {"hermes_companion": True},
        },
    )
    assert hermes_flagged.status_code == 403
    assert "Hermes" in hermes_flagged.json()["detail"]
    hermes_server = client.post(
        "/api/admin/tool-configs",
        headers=headers(USER_ID),
        json={
            "name": "My Hermes server",
            "tool_type": "mcp",
            "endpoint_url": "https://mcp.example.com/sse",
            "settings": {"mcp_server": "hermes-agent"},
        },
    )
    assert hermes_server.status_code == 403

    plain = client.post(
        "/api/admin/tool-configs",
        headers=headers(USER_ID),
        json={"name": "My MCP", "tool_type": "mcp", "endpoint_url": "https://mcp.example.com/sse"},
    )
    assert plain.status_code == 201, plain.text
    flag_later = client.patch(
        f"/api/admin/tool-configs/{plain.json()['id']}",
        headers=headers(USER_ID),
        json={"settings": {"hermes_companion": True}},
    )
    assert flag_later.status_code == 403


def test_private_hermes_profiles_keep_learned_skills_private() -> None:
    from app.core import hermes

    store = get_store()
    profile = _hermes_profile()
    profile.visibility = "private"
    profile.created_by = USER_ID
    summary = hermes.capture_artifacts(
        store,
        store.users[USER_ID],
        profile_id=profile.id,
        source_thread_id=None,
        full_text="Done.\n\n```hermes-skill\nTitle: Intake checklist\nAsk for the matter number first.\n```\n",
    )
    assert summary is not None
    assert summary["skills_saved"] == []
    assert summary["memories_saved"] == 1
    assert not any(skill.category == "hermes" for skill in store.skill_files.values())
    [memory] = hermes.profile_memories(store, profile.id)
    assert "Intake checklist" in memory.content


def test_private_hermes_authors_can_review_and_delete_their_agents_memories() -> None:
    from app.models.schemas import CompanionMemory

    store = get_store()
    store.platform_settings.users_can_create_models = True
    _grant(USER_ID, "agent_authoring", True)
    _grant(USER_ID, "hermes_companion", True)
    profile = _hermes_profile()
    profile.visibility = "private"
    profile.group_ids = []
    profile.created_by = USER_ID
    store.companion_memories["hermes-mem-proof"] = CompanionMemory(
        id="hermes-mem-proof",
        tenant_id="tenant-example",
        profile_id=profile.id,
        content="Skill — Intake checklist:\nAsk for the matter number first.",
        created_by=USER_ID,
        created_at="2026-10-18T00:00:00Z",
    )

    listed = client.get(f"/api/admin/agent-profiles/{profile.id}/hermes-memories", headers=headers(USER_ID))
    assert listed.status_code == 200, listed.text
    assert [memory["id"] for memory in listed.json()] == ["hermes-mem-proof"]

    other = client.get(f"/api/admin/agent-profiles/{profile.id}/hermes-memories", headers=headers("user-casey"))
    assert other.status_code in {403, 404}

    deleted = client.delete(
        f"/api/admin/agent-profiles/{profile.id}/hermes-memories/hermes-mem-proof", headers=headers(USER_ID)
    )
    assert deleted.status_code == 200
    assert "hermes-mem-proof" not in store.companion_memories


def test_owners_of_older_script_tools_can_switch_them_off_but_not_change_them() -> None:
    from app.models.schemas import ToolConfig

    _grant(USER_ID, "tool_authoring", True)
    store = get_store()
    store.tool_configs["tool-legacy-script"] = ToolConfig(
        id="tool-legacy-script",
        tenant_id="tenant-example",
        name="Legacy script",
        tool_type="custom_script",
        enabled=True,
        owner_user_id=USER_ID,
        settings={"script": "print(1)"},
    )
    off = client.patch(
        "/api/admin/tool-configs/tool-legacy-script", headers=headers(USER_ID), json={"enabled": False}
    )
    assert off.status_code == 200, off.text
    assert off.json()["enabled"] is False
    back_on = client.patch(
        "/api/admin/tool-configs/tool-legacy-script", headers=headers(USER_ID), json={"enabled": True}
    )
    assert back_on.status_code == 403
    renamed = client.patch(
        "/api/admin/tool-configs/tool-legacy-script", headers=headers(USER_ID), json={"name": "Old script"}
    )
    assert renamed.status_code == 200, renamed.text
    admin_on = client.patch(
        "/api/admin/tool-configs/tool-legacy-script", headers=headers(ADMIN_ID), json={"enabled": True}
    )
    assert admin_on.status_code == 200, admin_on.text
    changed = client.patch(
        "/api/admin/tool-configs/tool-legacy-script",
        headers=headers(USER_ID),
        json={"settings": {"script": "print(2)"}},
    )
    assert changed.status_code == 403


def test_automations_refuse_new_hermes_steps_but_allow_pausing_existing_ones() -> None:
    from app.models.schemas import Automation, AutomationStep

    profile = _hermes_profile()
    body = {
        "name": "Hermes digest",
        "surface": "chat",
        "trigger_type": "weekly",
        "weekly_day": "monday",
        "time_of_day": "09:00",
        "prompt": "Summarize the week.",
        "steps": [{"model_id": profile.id, "instruction": ""}],
        "enabled": True,
    }
    created = client.post("/api/automations", headers=headers(USER_ID), json=body)
    assert created.status_code == 403
    assert "Hermes companion" in created.json()["detail"]

    store = get_store()
    store.automations["automation-hermes-old"] = Automation(
        id="automation-hermes-old",
        tenant_id="tenant-example",
        name="Granted earlier",
        surface="chat",
        trigger_type="weekly",
        weekly_day="monday",
        time_of_day="09:00",
        prompt="Summarize the week.",
        steps=[AutomationStep(model_id=profile.id, instruction="")],
        enabled=True,
        created_by=USER_ID,
        created_at="2026-10-01T00:00:00Z",
        updated_at="2026-10-01T00:00:00Z",
    )
    paused = client.patch(
        "/api/automations/automation-hermes-old", headers=headers(USER_ID), json={"enabled": False}
    )
    assert paused.status_code == 200, paused.text
    resumed = client.patch(
        "/api/automations/automation-hermes-old", headers=headers(USER_ID), json={"enabled": True}
    )
    assert resumed.status_code == 403
    # The edit form echoes the unchanged steps with a rename; that stays possible.
    renamed = client.patch(
        "/api/automations/automation-hermes-old",
        headers=headers(USER_ID),
        json={"name": "Granted earlier (renamed)", "steps": [{"model_id": profile.id, "instruction": ""}]},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Granted earlier (renamed)"
    edited = client.patch(
        "/api/automations/automation-hermes-old",
        headers=headers(USER_ID),
        json={"steps": [{"model_id": profile.id, "instruction": "Also list deadlines."}]},
    )
    assert edited.status_code == 403
    assert "Hermes companion" in edited.json()["detail"]


def test_hermes_authors_only_see_memories_from_their_own_chats() -> None:
    """Once an admin publishes a user's Hermes agent it learns from other
    people's chats; the author's review route must not expose those."""
    from app.models.schemas import CompanionMemory

    store = get_store()
    store.platform_settings.users_can_create_models = True
    _grant(USER_ID, "agent_authoring", True)
    _grant(USER_ID, "hermes_companion", True)
    profile = _hermes_profile()
    profile.group_ids = []
    profile.created_by = USER_ID
    for memory_id, author in (("hermes-mem-jane", USER_ID), ("hermes-mem-casey", "user-casey")):
        store.companion_memories[memory_id] = CompanionMemory(
            id=memory_id,
            tenant_id="tenant-example",
            profile_id=profile.id,
            content=f"Learned from {author}.",
            created_by=author,
            created_at="2026-10-18T00:00:00Z",
        )
    route = f"/api/admin/agent-profiles/{profile.id}/hermes-memories"

    listed = client.get(route, headers=headers(USER_ID))
    assert listed.status_code == 200, listed.text
    assert [memory["id"] for memory in listed.json()] == ["hermes-mem-jane"]
    refused = client.delete(f"{route}/hermes-mem-casey", headers=headers(USER_ID))
    assert refused.status_code == 404
    assert "hermes-mem-casey" in store.companion_memories

    admin_view = client.get(route, headers=headers(ADMIN_ID))
    assert admin_view.status_code == 200, admin_view.text
    assert {memory["id"] for memory in admin_view.json()} == {"hermes-mem-jane", "hermes-mem-casey"}

    _grant(USER_ID, "agent_authoring", False)
    revoked = client.get(route, headers=headers(USER_ID))
    assert revoked.status_code == 403
