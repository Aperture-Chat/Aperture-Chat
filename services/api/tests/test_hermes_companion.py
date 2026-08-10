"""Hermes companion learning loop: capture, injection, and management APIs."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.models.schemas import CompanionMemory, ModelConfig
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _activate_provider(provider_id: str) -> None:
    store = get_store()
    provider = store.providers[provider_id]
    provider.connected = True
    platform_keys = sorted(
        (
            key
            for key in store.provider_keys.values()
            if key.provider_id == provider_id and key.tenant_id is None
        ),
        key=lambda key: key.id,
    )
    if platform_keys:
        for index, key in enumerate(platform_keys):
            key.status = "Active" if index == 0 else "Inactive"
        store.save_runtime_state(urgent=True)
    else:
        store.create_provider_key(
            key_id=f"key-{provider_id}-test",
            provider=provider,
            name=f"{provider.name} Test Key",
            environment="Test",
            status="Active",
            expires="Not set",
            secret_value=f"{provider.kind}-test-key",
        )


def _grant_hermes_permission() -> None:
    # The companion is admin-approved, off by default; user-admin belongs to
    # group-litigation, so granting it there activates the loop for the tests.
    get_store().groups["group-litigation"].permissions["hermes_companion"] = True


def _hermes_profile(profile_id: str = "agent-hermes-learn") -> ModelConfig:
    _grant_hermes_permission()
    store = get_store()
    store.models[profile_id] = ModelConfig(
        id=profile_id,
        tenant_id="tenant-example",
        provider_id="provider-azure",
        provider_name="Azure OpenAI",
        name="Hermes Learning Agent",
        upstream_model_id="gpt-4o",
        group_ids=["group-litigation"],
        agentic_companion="hermes",
        tool_config_ids=[],
        is_custom=True,
    )
    return store.models[profile_id]


def _completion_handler(reply_text: str, captured: dict[str, object] | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if captured is not None:
            captured["body"] = request.read().decode()
        return httpx.Response(
            200,
            json={
                "id": "gen-hermes",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": reply_text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 30, "total_tokens": 50},
            },
        )

    return handler


HERMES_REPLY = (
    "Here is the update.\n\n"
    "```hermes-memory\nClient prefers Friday updates in bullet form.\n```\n\n"
    "```hermes-skill\nTitle: Weekly client update format\n"
    "Open with matter status, then risks, then next steps.\n```\n\n"
    "```hermes-automation\n"
    '{"name": "Weekly client update", "prompt": "Draft the weekly client update.", '
    '"trigger_type": "weekly", "weekly_day": "friday", "time_of_day": "09:00"}\n'
    "```\n"
)


def test_hermes_reply_persists_memory_skill_and_disabled_automation(monkeypatch) -> None:
    _activate_provider("provider-azure")
    profile = _hermes_profile()
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(_completion_handler(HERMES_REPLY))),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": profile.id,
            "messages": [{"role": "user", "content": "Summarize the matter and remember my preferences."}],
        },
        headers=headers(),
    )

    assert response.status_code == 200
    store = get_store()

    memories = [m for m in store.companion_memories.values() if m.profile_id == profile.id]
    assert len(memories) == 1
    assert memories[0].content == "Client prefers Friday updates in bullet form."
    assert memories[0].created_by == "user-admin"

    hermes_skills = [s for s in store.skill_files.values() if s.category == "hermes"]
    assert len(hermes_skills) == 1
    skill = hermes_skills[0]
    assert skill.name == "Weekly client update format"
    assert "matter status" in skill.content
    assert skill.group_ids == ["group-litigation"]
    assert skill.id in store.models[profile.id].skill_file_ids

    hermes_automations = [a for a in store.automations.values() if a.id.startswith("automation-hermes-")]
    assert len(hermes_automations) == 1
    automation = hermes_automations[0]
    # Proposals must always land disabled for human review.
    assert automation.enabled is False
    assert automation.trigger_type == "weekly"
    assert automation.weekly_day == "friday"
    assert automation.steps[0].model_id == profile.id

    actions = [event.action for event in store.audit_events]
    assert "hermes.memory_saved" in actions
    assert "hermes.skill_saved" in actions
    assert "hermes.automation_proposed" in actions


def test_saved_memories_and_instructions_reach_the_next_prompt(monkeypatch) -> None:
    _activate_provider("provider-azure")
    profile = _hermes_profile()
    store = get_store()
    store.companion_memories["hermes-mem-test1"] = CompanionMemory(
        id="hermes-mem-test1",
        tenant_id="tenant-example",
        profile_id=profile.id,
        content="Client prefers Friday updates in bullet form.",
        created_by="user-admin",
        created_at="2026-07-14T00:00:00+00:00",
    )
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(
            transport=httpx.MockTransport(_completion_handler("Understood.", captured))
        ),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": profile.id,
            "messages": [{"role": "user", "content": "Draft this week's update."}],
        },
        headers=headers(),
    )

    assert response.status_code == 200
    system_message = json.loads(captured["body"])["messages"][0]
    assert system_message["role"] == "system"
    assert "Hermes companion: active" in system_message["content"]
    assert "Client prefers Friday updates in bullet form." in system_message["content"]


def test_hermes_blocks_are_ignored_for_profiles_without_the_companion(monkeypatch) -> None:
    _activate_provider("provider-azure")
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(_completion_handler(HERMES_REPLY))),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "hi"}],
        },
        headers=headers(),
    )

    assert response.status_code == 200
    store = get_store()
    assert store.companion_memories == {}
    assert not any(s.category == "hermes" for s in store.skill_files.values())
    assert not any(a.id.startswith("automation-hermes-") for a in store.automations.values())


def test_stream_done_event_reports_hermes_saves(monkeypatch) -> None:
    _activate_provider("provider-azure")
    profile = _hermes_profile()

    def stream_handler(request: httpx.Request) -> httpx.Response:
        chunk = json.dumps(
            {"choices": [{"delta": {"content": HERMES_REPLY}, "finish_reason": "stop"}]}
        )
        return httpx.Response(
            200,
            content=f"data: {chunk}\n\ndata: [DONE]\n\n".encode(),
            headers={"content-type": "text/event-stream"},
        )

    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(transport=httpx.MockTransport(stream_handler)),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": profile.id,
            "messages": [{"role": "user", "content": "Stream and remember."}],
            "stream": True,
        },
        headers=headers(),
    )

    assert response.status_code == 200
    done_events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: {") and '"done"' in line
    ]
    assert done_events and done_events[-1]["hermes"]["memories_saved"] == 1
    assert done_events[-1]["hermes"]["skills_saved"] == ["Weekly client update format"]
    assert done_events[-1]["hermes"]["automations_proposed"] == ["Weekly client update"]


def test_admin_can_list_and_delete_hermes_memories() -> None:
    profile = _hermes_profile()
    store = get_store()
    store.companion_memories["hermes-mem-admin1"] = CompanionMemory(
        id="hermes-mem-admin1",
        tenant_id="tenant-example",
        profile_id=profile.id,
        content="Prefers concise bullets.",
        created_by="user-admin",
        created_at="2026-07-14T00:00:00+00:00",
    )

    listed = client.get(
        f"/api/admin/agent-profiles/{profile.id}/hermes-memories", headers=headers()
    )
    assert listed.status_code == 200
    assert [m["id"] for m in listed.json()] == ["hermes-mem-admin1"]

    missing = client.delete(
        f"/api/admin/agent-profiles/{profile.id}/hermes-memories/hermes-mem-nope",
        headers=headers(),
    )
    assert missing.status_code == 404

    deleted = client.delete(
        f"/api/admin/agent-profiles/{profile.id}/hermes-memories/hermes-mem-admin1",
        headers=headers(),
    )
    assert deleted.status_code == 200
    assert get_store().companion_memories == {}
    assert any(event.action == "hermes.memory_deleted" for event in get_store().audit_events)


def test_hermes_stays_inert_until_an_admin_grants_the_permission(monkeypatch) -> None:
    _activate_provider("provider-azure")
    profile = _hermes_profile()
    # Revoke the grant the fixture added: the profile keeps its hermes flag,
    # but the learning loop must be fully inert for ungranted users.
    get_store().groups["group-litigation"].permissions["hermes_companion"] = False
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: ModelGatewayClient(
            transport=httpx.MockTransport(_completion_handler(HERMES_REPLY, captured))
        ),
    )

    response = client.post(
        "/api/chat/complete",
        json={
            "model": profile.id,
            "messages": [{"role": "user", "content": "Remember my preferences."}],
        },
        headers=headers(),
    )

    assert response.status_code == 200
    # No instructions reached the model and nothing was captured.
    system_or_user = json.loads(captured["body"])["messages"][0]["content"]
    assert "Hermes companion: active" not in system_or_user
    store = get_store()
    assert store.companion_memories == {}
    assert not any(s.category == "hermes" for s in store.skill_files.values())


def test_saving_a_hermes_profile_requires_the_admin_grant() -> None:
    payload = {
        "id": "agent-hermes-gated",
        "provider_id": "provider-azure",
        "name": "Gated Hermes Agent",
        "upstream_model_id": "gpt-4o",
        "group_ids": ["group-litigation"],
        "is_custom": True,
        "agentic_companion": "hermes",
    }

    denied = client.post("/api/admin/agent-profiles", json=payload, headers=headers())
    assert denied.status_code == 403
    assert "Hermes companion is disabled" in denied.json()["detail"]

    _grant_hermes_permission()
    allowed = client.post("/api/admin/agent-profiles", json=payload, headers=headers())
    assert allowed.status_code == 201
    assert allowed.json()["agentic_companion"] == "hermes"

    # Saving without the companion never touches the gate.
    get_store().groups["group-litigation"].permissions["hermes_companion"] = False
    plain = client.post(
        "/api/admin/agent-profiles",
        json={**payload, "id": "agent-plain", "agentic_companion": None},
        headers=headers(),
    )
    assert plain.status_code == 201
