"""Automations CRUD + on-demand chain execution (isolated store, mocked gateway)."""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.models.schemas import ModelConfig
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-owner") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _approved_model_id() -> str:
    store = get_store()
    # Prefer an OpenRouter-backed approved model so run tests can activate one provider.
    openrouter = next(
        (
            m.id
            for m in store.models.values()
            if m.platform_enabled and m.provider_id == "provider-openrouter"
        ),
        None,
    )
    if openrouter is not None:
        return openrouter
    return next(model.id for model in store.models.values() if model.platform_enabled)


def _base_payload(model_id: str) -> dict:
    return {
        "tenant_id": "tenant-example",
        "name": "Weekly digest",
        "surface": "chat",
        "trigger_type": "weekly",
        "weekly_day": "monday",
        "time_of_day": "09:00",
        "prompt": "Summarize the week.",
        "steps": [{"model_id": model_id, "instruction": "Be concise."}],
        "enabled": True,
    }


def test_automation_crud_lifecycle() -> None:
    model_id = _approved_model_id()
    created = client.post("/api/automations", json=_base_payload(model_id), headers=headers())
    assert created.status_code == 201
    automation = created.json()
    assert automation["surface"] == "chat"
    assert automation["last_run_status"] is None  # honest: no run yet
    automation_id = automation["id"]

    listed = client.get("/api/automations", headers=headers())
    assert any(a["id"] == automation_id for a in listed.json())

    patched = client.patch(
        f"/api/automations/{automation_id}",
        json={"name": "Renamed digest", "enabled": False},
        headers=headers(),
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "Renamed digest"
    assert patched.json()["enabled"] is False

    assert client.delete(f"/api/automations/{automation_id}", headers=headers()).status_code == 204
    assert all(
        a["id"] != automation_id for a in client.get("/api/automations", headers=headers()).json()
    )


def test_automation_requires_at_least_one_step() -> None:
    model_id = _approved_model_id()
    payload = _base_payload(model_id)
    payload["steps"] = []
    response = client.post("/api/automations", json=payload, headers=headers())
    assert response.status_code == 400
    assert "at least one model step" in response.json()["detail"]


def test_owner_automation_binds_to_sole_tenant_without_explicit_tenant_id() -> None:
    payload = _base_payload(_approved_model_id())
    payload.pop("tenant_id")
    response = client.post("/api/automations", json=payload, headers=headers())
    assert response.status_code == 201
    assert response.json()["tenant_id"] == "tenant-example"


def test_owner_automation_requires_tenant_id_when_multiple_tenants_exist() -> None:
    store = get_store()
    store.tenants["tenant-second"] = store.tenants["tenant-example"].model_copy(
        update={"id": "tenant-second", "name": "Second Tenant", "slug": "second"}
    )
    owner = store.users["user-owner"]
    if owner.tenant_id is not None:
        store.users["user-owner"] = owner.model_copy(update={"tenant_id": None})
    payload = _base_payload(_approved_model_id())
    payload.pop("tenant_id")
    response = client.post("/api/automations", json=payload, headers=headers())
    assert response.status_code == 400
    assert response.json()["detail"] == "tenant_id is required when multiple tenants exist."


def test_daily_trigger_is_a_valid_schedule() -> None:
    payload = _base_payload(_approved_model_id())
    payload["trigger_type"] = "daily"
    payload["weekly_day"] = None
    response = client.post("/api/automations", json=payload, headers=headers())
    assert response.status_code == 201
    body = response.json()
    assert body["trigger_type"] == "daily"
    assert body["time_of_day"] == "09:00"


def test_automation_rejects_unapproved_model_for_non_owner() -> None:
    store = get_store()
    # A platform-disabled model is not approved for anyone.
    disabled = next(
        (m for m in store.models.values() if not m.platform_enabled),
        None,
    )
    if disabled is None:
        disabled_id = "model-disabled-test"
        store.models[disabled_id] = ModelConfig(
            id=disabled_id,
            provider_id="provider-openrouter",
            provider_name="OpenRouter",
            name="Disabled Model",
            platform_enabled=False,
        )
    else:
        disabled_id = disabled.id
    payload = _base_payload(disabled_id)
    response = client.post("/api/automations", json=payload, headers=headers("user-admin"))
    assert response.status_code == 403


def test_run_executes_model_chain_feeding_output_forward(monkeypatch) -> None:
    _activate_openrouter()
    model_id = _approved_model_id()
    seen_user_messages: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        body = _json.loads(request.read())
        user_msg = next((m["content"] for m in body["messages"] if m["role"] == "user"), "")
        seen_user_messages.append(user_msg)
        reply = f"step-output-{len(seen_user_messages)}"
        return httpx.Response(
            200,
            json={
                "id": "gen-auto",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": reply},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: fake)

    payload = _base_payload(model_id)
    payload["steps"] = [
        {"model_id": model_id, "instruction": "First step."},
        {"model_id": model_id, "instruction": "Second step."},
    ]
    created = client.post("/api/automations", json=payload, headers=headers())
    automation_id = created.json()["id"]

    run = client.post(f"/api/automations/{automation_id}/run", headers=headers())
    assert run.status_code == 200
    body = run.json()
    assert len(body["transcript"]) == 2
    assert body["final_output"] == "step-output-2"
    # Step 1 receives the automation prompt; step 2 receives step 1's output.
    assert seen_user_messages[0] == "Summarize the week."
    assert seen_user_messages[1] == "step-output-1"
    assert body["automation"]["last_run_status"] == "succeeded"


def test_run_input_override_replaces_stored_prompt_for_one_run(monkeypatch) -> None:
    _activate_openrouter()
    model_id = _approved_model_id()
    seen_user_messages: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        body = _json.loads(request.read())
        user_msg = next((m["content"] for m in body["messages"] if m["role"] == "user"), "")
        seen_user_messages.append(user_msg)
        return httpx.Response(
            200,
            json={
                "id": "gen-auto",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": f"out-{len(seen_user_messages)}"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: fake)

    payload = _base_payload(model_id)
    payload["steps"] = [
        {"model_id": model_id, "instruction": "First step."},
        {"model_id": model_id, "instruction": "Second step."},
    ]
    automation_id = client.post("/api/automations", json=payload, headers=headers()).json()["id"]

    # A chat-provided input replaces the stored prompt for this run only.
    run = client.post(
        f"/api/automations/{automation_id}/run",
        json={"input": "What changed in AI today?"},
        headers=headers(),
    )
    assert run.status_code == 200
    assert seen_user_messages[0] == "What changed in AI today?"
    assert seen_user_messages[1] == "out-1"

    # Whitespace-only input falls back to the stored prompt honestly.
    seen_user_messages.clear()
    run = client.post(
        f"/api/automations/{automation_id}/run",
        json={"input": "   "},
        headers=headers(),
    )
    assert run.status_code == 200
    assert seen_user_messages[0] == "Summarize the week."


def test_run_openrouter_steps_carry_web_search_tool_and_cite_sources(monkeypatch) -> None:
    _activate_openrouter()
    model_id = _approved_model_id()
    seen_tools: list[object] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        body = _json.loads(request.read())
        seen_tools.append(body.get("tools"))
        return httpx.Response(
            200,
            json={
                "id": "gen-auto",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "Fresh answer.",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url_citation": {
                                        "url": "https://example.com/report",
                                        "title": "Example Report",
                                    },
                                }
                            ],
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: fake)

    automation_id = client.post(
        "/api/automations", json=_base_payload(model_id), headers=headers()
    ).json()["id"]
    run = client.post(f"/api/automations/{automation_id}/run", headers=headers())
    assert run.status_code == 200
    # OpenRouter steps ride OpenRouter's server-side web search tool.
    assert seen_tools == [[{"type": "openrouter:web_search", "parameters": {"max_results": 5}}]]
    # Real url_citation annotations surface as a Sources footer in the output.
    output = run.json()["transcript"][0]["output"]
    assert output.endswith("Sources:\n- [Example Report](https://example.com/report)")

    # The admin Web Search connector is the kill switch, same as chat.
    store = get_store()
    store.connectors["web"].platform_enabled = False
    seen_tools.clear()
    run = client.post(f"/api/automations/{automation_id}/run", headers=headers())
    assert run.status_code == 200
    assert seen_tools == [None]


def test_step_token_budget_gives_reasoning_models_room_to_answer() -> None:
    from app.core.automation_runner import (
        AUTOMATION_STEP_TOKEN_BUDGET,
        LONG_CONTEXT_STEP_TOKEN_BUDGET,
        _step_token_budget,
    )
    from app.models.schemas import ModelConfig as _ModelConfig

    # The old fixed 2000-token ceiling let hidden reasoning tokens consume the
    # entire allowance, leaving no room for the visible answer.
    assert AUTOMATION_STEP_TOKEN_BUDGET >= 8192
    small = _ModelConfig(id="m", provider_id="p", provider_name="P", name="Small")
    assert _step_token_budget(small) == AUTOMATION_STEP_TOKEN_BUDGET
    large = small.model_copy(update={"context_window": 200_000})
    assert _step_token_budget(large) == LONG_CONTEXT_STEP_TOKEN_BUDGET


def test_run_fails_honestly_when_a_step_is_truncated_before_answering(monkeypatch) -> None:
    _activate_openrouter()
    model_id = _approved_model_id()

    def handler(request: httpx.Request) -> httpx.Response:
        # A reasoning model that spent its whole budget thinking: the provider
        # returns HTTP 200 with finish_reason "length" and no content at all.
        return httpx.Response(
            200,
            json={
                "id": "gen-auto",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": ""},
                        "finish_reason": "length",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 8192, "total_tokens": 8197},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: fake)

    automation_id = client.post(
        "/api/automations", json=_base_payload(model_id), headers=headers()
    ).json()["id"]
    run = client.post(f"/api/automations/{automation_id}/run", headers=headers())

    # An empty answer is never reported as a successful run.
    assert run.status_code == 502
    detail = run.json()["detail"]
    assert "token limit before writing an answer" in detail
    after = next(
        a
        for a in client.get("/api/automations", headers=headers()).json()
        if a["id"] == automation_id
    )
    assert after["last_run_status"].startswith("failed")


def test_run_marks_a_truncated_step_that_did_produce_text(monkeypatch) -> None:
    _activate_openrouter()
    model_id = _approved_model_id()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-auto",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "A partial answer"},
                        "finish_reason": "length",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 8192, "total_tokens": 8197},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: fake)

    automation_id = client.post(
        "/api/automations", json=_base_payload(model_id), headers=headers()
    ).json()["id"]
    run = client.post(f"/api/automations/{automation_id}/run", headers=headers())

    assert run.status_code == 200
    assert run.json()["transcript"][0]["truncated"] is True


def test_run_bookkeeping_survives_a_snapshot_write_race(monkeypatch) -> None:
    """Losing the relational-digest CAS once must not fail a finished run.

    This is the exact production failure: a two-minute chain completed, then a
    concurrent writer had bumped the identity snapshot digest, the final
    bookkeeping save raised IdentityConfigSnapshotConflict, and the whole run
    was reported as 'failed unexpectedly'.
    """
    from app.repositories.identity_config_sql import IdentityConfigSnapshotConflict

    _activate_openrouter()
    model_id = _approved_model_id()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-auto",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "A real answer."},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
            },
        )

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: fake)

    automation_id = client.post(
        "/api/automations", json=_base_payload(model_id), headers=headers()
    ).json()["id"]

    store = get_store()
    real_save = store.save_runtime_state
    conflicts = {"remaining": 1}

    def flaky_save(*args, **kwargs):
        if conflicts["remaining"] > 0:
            conflicts["remaining"] -= 1
            raise IdentityConfigSnapshotConflict("stale relational digest")
        return real_save(*args, **kwargs)

    monkeypatch.setattr(store, "save_runtime_state", flaky_save)

    run = client.post(f"/api/automations/{automation_id}/run", headers=headers())
    assert run.status_code == 200
    assert run.json()["automation"]["last_run_status"] == "succeeded"
    assert conflicts["remaining"] == 0  # the conflict genuinely fired and was survived


def test_run_bookkeeping_never_resurrects_a_concurrently_deleted_automation() -> None:
    from app.core.automation_runner import persist_automation_fields

    store = get_store()
    assert (
        persist_automation_fields(store, "automation-vanished", {"last_run_status": "x"})
        is None
    )
    assert "automation-vanished" not in store.automations


def test_run_reports_honest_error_on_gateway_failure(monkeypatch) -> None:
    _activate_openrouter()
    model_id = _approved_model_id()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "upstream boom"})

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: fake)

    created = client.post("/api/automations", json=_base_payload(model_id), headers=headers())
    automation_id = created.json()["id"]
    run = client.post(f"/api/automations/{automation_id}/run", headers=headers())
    assert run.status_code == 502
    assert "gateway" in run.json()["detail"].lower()
    # The failed run is recorded honestly rather than silently swallowed.
    after = next(
        a
        for a in client.get("/api/automations", headers=headers()).json()
        if a["id"] == automation_id
    )
    assert after["last_run_status"].startswith("failed")


def test_automation_unknown_openrouter_alias_never_calls_provider(monkeypatch) -> None:
    store = get_store()
    model_id = "automation-alias-without-upstream"
    store.models[model_id] = ModelConfig(
        id=model_id,
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Automation alias without upstream",
        upstream_model_id=None,
        platform_enabled=True,
        group_ids=[],
    )

    class NoCallGateway:
        def complete(self, **_kwargs: object) -> dict[str, object]:
            raise AssertionError("unknown selected model must fail before provider I/O")

    def unexpected_credential_read(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("unknown selected model must fail before credential resolution")

    monkeypatch.setattr(store, "provider_key_secret_for_provider", unexpected_credential_read)
    monkeypatch.setattr(
        "app.routes.automations.get_model_gateway_client",
        lambda: NoCallGateway(),
    )

    created = client.post(
        "/api/automations",
        json=_base_payload(model_id),
        headers=headers(),
    )
    assert created.status_code == 201
    run = client.post(
        f"/api/automations/{created.json()['id']}/run",
        headers=headers(),
    )

    assert run.status_code == 502
    assert run.json()["detail"].endswith(
        f"Selected model '{model_id}' has no explicit OpenRouter upstream model id."
    )
    assert store.openrouter_default_model not in run.text


def test_run_records_unexpected_non_object_http_success_as_unmetered(monkeypatch) -> None:
    _activate_openrouter()
    model_id = _approved_model_id()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=["valid", "json", "but", "not", "an", "object"])

    fake = ModelGatewayClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: fake)

    created = client.post("/api/automations", json=_base_payload(model_id), headers=headers())
    automation_id = created.json()["id"]
    run = client.post(f"/api/automations/{automation_id}/run", headers=headers())

    assert run.status_code == 500
    assert run.json()["detail"] == "Automation run failed unexpectedly."
    store = get_store()
    assert store.automations[automation_id].last_run_status == "failed: unexpected AttributeError"
    usage = [record for record in store.usage_records if record.surface == "automation"]
    assert len(usage) == 1
    assert usage[0].model_id == model_id
    assert usage[0].total_tokens is None
    run_audits = [event for event in store.audit_events if event.target == automation_id]
    assert [event.action for event in run_audits if event.action.startswith("automation.run")] == [
        "automation.run_failed"
    ]
    assert run_audits[-1].metadata["error"] == "unexpected AttributeError"


def _user_payload() -> dict:
    # gpt-4o-mini is reachable by the litigation-group seed users used below.
    payload = _base_payload("gpt-4o-mini")
    payload["enabled"] = False
    return payload


def test_create_binds_tenant_for_non_owner() -> None:
    # A non-owner cannot inject an automation into another tenant by choosing tenant_id.
    payload = _user_payload()
    payload["tenant_id"] = "tenant-victim"
    created = client.post("/api/automations", json=payload, headers=headers("user-jane"))
    assert created.status_code == 201
    assert created.json()["tenant_id"] == "tenant-example"
    assert created.json()["created_by"] == "user-jane"


def test_user_cannot_manage_another_users_automation() -> None:
    created = client.post("/api/automations", json=_user_payload(), headers=headers("user-jane"))
    automation_id = created.json()["id"]

    # A different same-tenant user may not run, edit, or delete someone else's automation.
    assert (
        client.post(
            f"/api/automations/{automation_id}/run", headers=headers("user-casey")
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/api/automations/{automation_id}", json={"name": "x"}, headers=headers("user-casey")
        ).status_code
        == 403
    )
    assert (
        client.delete(
            f"/api/automations/{automation_id}", headers=headers("user-casey")
        ).status_code
        == 403
    )

    # A tenant admin in the same tenant may manage it.
    admin_patch = client.patch(
        f"/api/automations/{automation_id}", json={"name": "Renamed"}, headers=headers("user-admin")
    )
    assert admin_patch.status_code == 200
    assert admin_patch.json()["name"] == "Renamed"


def test_list_scopes_to_creator_for_regular_users() -> None:
    jane_id = client.post(
        "/api/automations", json=_user_payload(), headers=headers("user-jane")
    ).json()["id"]
    casey_id = client.post(
        "/api/automations", json=_user_payload(), headers=headers("user-casey")
    ).json()["id"]

    jane_ids = {
        a["id"] for a in client.get("/api/automations", headers=headers("user-jane")).json()
    }
    assert jane_id in jane_ids and casey_id not in jane_ids

    # A tenant admin sees every automation in the tenant.
    admin_ids = {
        a["id"] for a in client.get("/api/automations", headers=headers("user-admin")).json()
    }
    assert jane_id in admin_ids and casey_id in admin_ids


def test_bootstrap_scopes_automations_like_list_endpoint() -> None:
    jane_id = client.post(
        "/api/automations", json=_user_payload(), headers=headers("user-jane")
    ).json()["id"]
    casey_id = client.post(
        "/api/automations", json=_user_payload(), headers=headers("user-casey")
    ).json()["id"]

    jane_bootstrap_ids = {
        a["id"]
        for a in client.get("/api/bootstrap", headers=headers("user-jane")).json()["automations"]
    }
    assert jane_id in jane_bootstrap_ids
    assert casey_id not in jane_bootstrap_ids

    admin_bootstrap_ids = {
        a["id"]
        for a in client.get("/api/bootstrap", headers=headers("user-admin")).json()["automations"]
    }
    assert jane_id in admin_bootstrap_ids
    assert casey_id in admin_bootstrap_ids


def _activate_openrouter() -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    key_id = "key-openrouter-auto-test"
    store.create_provider_key(
        key_id=key_id,
        provider=provider,
        name="OpenRouter Auto Test",
        environment="Test",
        status="Active",
        expires="Jun 27, 2027",
        secret_value="openrouter-test-key",
    )
