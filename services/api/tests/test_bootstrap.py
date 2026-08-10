from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import ChatThread, ModelConfig
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def test_bootstrap_agent_visibility_keeps_admins_over_user_scopes() -> None:
    store = get_store()
    store.models["agent-private-casey"] = ModelConfig(
        id="agent-private-casey",
        tenant_id="tenant-example",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Casey Private Agent",
        upstream_model_id="openai/gpt-4o-mini",
        platform_enabled=False,
        is_custom=True,
        created_by="Casey Doe",
        visibility="private",
        meta_prompt="Keep this workspace private to the creator.",
    )
    store.models["agent-tenant-wide"] = ModelConfig(
        id="agent-tenant-wide",
        tenant_id="tenant-example",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Tenant Wide Agent",
        upstream_model_id="openai/gpt-4o-mini",
        platform_enabled=False,
        is_custom=True,
        created_by="Alex Morgan",
        visibility="tenant",
        meta_prompt="Available tenant-wide.",
    )
    store.models["agent-finance-only"] = ModelConfig(
        id="agent-finance-only",
        tenant_id="tenant-example",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Finance Agent",
        upstream_model_id="openai/gpt-4o-mini",
        platform_enabled=False,
        is_custom=True,
        created_by="Alex Morgan",
        visibility="group",
        group_ids=["group-finance"],
        meta_prompt="Use finance group sources.",
    )

    admin_models = _bootstrap_model_ids("user-admin")
    jane_models = _bootstrap_model_ids("user-jane")
    casey_models = _bootstrap_model_ids("user-casey")

    assert {"agent-private-casey", "agent-tenant-wide", "agent-finance-only"}.issubset(admin_models)
    assert "agent-private-casey" not in jane_models
    assert "agent-finance-only" not in jane_models
    assert "agent-tenant-wide" in jane_models
    assert "agent-private-casey" in casey_models


def test_bootstrap_chat_sessions_remain_owner_private_for_admins_and_owner() -> None:
    store = get_store()
    store.save_chat_thread(
        ChatThread(
            id="thread-bootstrap-jane",
            tenant_id="tenant-example",
            owner_user_id="user-jane",
            title="Jane private title",
            model_id="gpt-4o-mini",
            group_id="group-litigation",
            updated_at="Now",
            messages=[],
        )
    )
    store.save_chat_thread(
        ChatThread(
            id="thread-bootstrap-casey",
            tenant_id="tenant-example",
            owner_user_id="user-casey",
            title="Casey private title",
            model_id="gpt-4o-mini",
            group_id="group-finance",
            updated_at="Now",
            messages=[],
        )
    )

    jane = client.get("/api/bootstrap", headers=headers("user-jane"))
    admin = client.get("/api/bootstrap", headers=headers("user-admin"))
    owner = client.get("/api/bootstrap", headers=headers("user-owner"))

    assert jane.status_code == admin.status_code == owner.status_code == 200
    assert [session["id"] for session in jane.json()["chatSessions"]] == [
        "thread-bootstrap-jane"
    ]
    assert admin.json()["chatSessions"] == []
    assert owner.json()["chatSessions"] == []


def _bootstrap_model_ids(user_id: str) -> set[str]:
    response = client.get("/api/bootstrap", headers=headers(user_id))
    assert response.status_code == 200
    return {model["id"] for model in response.json()["models"]}


def test_disabled_connectors_strip_user_payload_but_not_admin() -> None:
    store = get_store()
    store.connectors["mcp"].tenant_enabled = False
    store.connectors["prompt-library"].tenant_enabled = False

    user_payload = client.get("/api/bootstrap", headers=headers("user-jane")).json()
    assert all(tool["tool_type"] != "mcp" for tool in user_payload["toolConfigs"])
    assert user_payload["promptTemplates"] == []

    admin_payload = client.get("/api/bootstrap", headers=headers("user-admin")).json()
    assert any(tool["tool_type"] == "mcp" for tool in admin_payload["toolConfigs"])
    assert admin_payload["promptTemplates"] != []

    # Re-enabling restores the user payload — on is on.
    store.connectors["mcp"].tenant_enabled = True
    store.connectors["prompt-library"].tenant_enabled = True
    restored = client.get("/api/bootstrap", headers=headers("user-jane")).json()
    assert any(tool["tool_type"] == "mcp" for tool in restored["toolConfigs"])
    assert restored["promptTemplates"] != []


def test_platform_disabled_connector_also_strips_user_payload() -> None:
    store = get_store()
    store.connectors["mcp"].platform_enabled = False
    payload = client.get("/api/bootstrap", headers=headers("user-jane")).json()
    assert all(tool["tool_type"] != "mcp" for tool in payload["toolConfigs"])
