from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.model_gateway import ModelGatewayAuthError, ModelGatewayError
from app.main import app
from app.models.schemas import Provider
from app.repositories.deps import get_store
from app.routes.platform import build_platform_setup_status

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


class FakeGateway:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.calls = 0

    def complete(self, **_kwargs: object) -> dict[str, object]:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return {"choices": [{"message": {"content": "OK"}}]}


def _steps(body: dict[str, object]) -> dict[str, dict[str, object]]:
    return {step["key"]: step for step in body["steps"]}  # type: ignore[index,union-attr]


def _empty_install() -> None:
    store = get_store()
    for key_id in list(store.provider_keys):
        store.delete_provider_key(key_id)
    store.providers.clear()
    store.models.clear()


def test_setup_status_is_owner_only_and_all_todo_on_an_empty_install() -> None:
    _empty_install()
    forbidden = client.get("/api/platform/setup-status", headers=headers("user-admin"))
    assert forbidden.status_code == 403
    response = client.get("/api/platform/setup-status", headers=headers("user-owner"))
    assert response.status_code == 200
    body = response.json()
    steps = _steps(body)
    assert [step["key"] for step in body["steps"]] == [
        "provider",
        "credential",
        "validate",
        "catalog",
        "enable",
        "grant",
    ]
    assert all(step["state"] == "todo" for step in steps.values())
    assert body["ready_for_users"] is False
    assert steps["provider"]["summary"].startswith("No provider yet")
    unknown_tenant = client.get(
        "/api/platform/setup-status", params={"tenant_id": "nope"}, headers=headers("user-owner")
    )
    assert unknown_tenant.status_code == 404


def test_setup_status_walks_through_each_step_from_real_records() -> None:
    _empty_install()
    store = get_store()
    provider = Provider(id="p-open", name="Open", kind="openai", region="Global", connected=False)
    store.providers[provider.id] = provider
    steps = _steps(client.get("/api/platform/setup-status", headers=headers("user-owner")).json())
    assert steps["provider"]["state"] == "done"
    assert steps["provider"]["counts"] == {"providers": 1, "connected": 0}
    assert steps["credential"]["state"] == "todo"

    store.create_provider_key(
        key_id="k1",
        provider=provider,
        name="Platform key",
        environment="production",
        status="Active",
        expires="Never",
        secret_value="sk-test-synthetic-1111111111",
        tenant_id=None,
    )
    steps = _steps(client.get("/api/platform/setup-status", headers=headers("user-owner")).json())
    assert steps["credential"]["state"] == "done"
    assert steps["validate"]["state"] == "todo"
    assert steps["validate"]["providers"][0]["has_active_platform_key"] is True
    assert steps["validate"]["providers"][0]["last_validation_status"] is None

    provider.connected = True
    provider.last_validation_status = "passed"
    provider.last_validated_at = "2026-09-13T00:00:00Z"
    provider.last_validation_model_id = "m1"
    steps = _steps(client.get("/api/platform/setup-status", headers=headers("user-owner")).json())
    assert steps["validate"]["state"] == "done"
    assert steps["catalog"]["state"] == "todo"

    from app.models.schemas import ModelConfig

    store.models["m1"] = ModelConfig(
        id="m1",
        provider_id="p-open",
        provider_name="Open",
        name="gpt-4o-mini",
        upstream_model_id="gpt-4o-mini",
        platform_enabled=False,
    )
    steps = _steps(client.get("/api/platform/setup-status", headers=headers("user-owner")).json())
    assert steps["catalog"]["state"] == "done"
    assert steps["enable"]["state"] == "todo"

    store.models["m1"].platform_enabled = True
    body = client.get("/api/platform/setup-status", headers=headers("user-owner")).json()
    steps = _steps(body)
    assert steps["enable"]["state"] == "done"
    assert steps["grant"]["state"] == "todo"
    assert body["ready_for_users"] is False

    store.models["m1"].group_ids = ["group-litigation"]
    body = client.get("/api/platform/setup-status", headers=headers("user-owner")).json()
    steps = _steps(body)
    assert steps["grant"]["state"] == "done"
    assert steps["grant"]["counts"]["enabled_models_with_groups"] == 1
    assert steps["grant"]["counts"]["active_users_with_group"] >= 1
    assert steps["grant"]["per_tenant"][0]["tenant_id"] == "tenant-example"
    assert body["ready_for_users"] is True

    # A waiting access request turns the grant step into attention, never done.
    store.model_access_request_repository.create(
        tenant_id="tenant-example", user_id="user-jane", model_id="m1", note=None
    )
    steps = _steps(client.get("/api/platform/setup-status", headers=headers("user-owner")).json())
    assert steps["grant"]["state"] == "attention"
    assert steps["grant"]["counts"]["pending_access_requests"] == 1


def test_setup_status_redacts_provider_status_messages() -> None:
    store = get_store()
    store.providers["provider-openai"].status_message = "Upstream said api_key=sk-live-SECRET123 invalid"
    status = build_platform_setup_status(store)
    validate = next(step for step in status.steps if step.key == "validate")
    message = next(p for p in validate.providers if p.id == "provider-openai").status_message
    assert message is not None
    assert "sk-live-SECRET123" not in message


def test_validate_endpoint_records_real_outcomes(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    ok = FakeGateway()
    monkeypatch.setattr("app.routes.platform.get_model_gateway_client", lambda: ok)
    forbidden = client.post("/api/platform/providers/provider-openai/validate", headers=headers("user-admin"))
    assert forbidden.status_code == 403

    passed = client.post("/api/platform/providers/provider-openai/validate", headers=headers("user-owner"))
    assert passed.status_code == 200, passed.text
    body = passed.json()
    assert body["model_name"]
    assert body["latency_ms"] >= 0
    assert body["provider"]["connected"] is True
    assert body["provider"]["last_validation_status"] == "passed"
    assert body["provider"]["last_validation_model_id"] == body["model_id"]
    assert body["provider"]["last_validated_at"]
    assert ok.calls == 1

    failing = FakeGateway(error=ModelGatewayError("upstream 503"))
    monkeypatch.setattr("app.routes.platform.get_model_gateway_client", lambda: failing)
    failed = client.post("/api/platform/providers/provider-openai/validate", headers=headers("user-owner"))
    assert failed.status_code == 503
    provider = store.providers["provider-openai"]
    assert provider.connected is False
    assert provider.last_validation_status == "failed"
    assert provider.last_validation_model_id is None
    # Models are kept; only the health bit and the machine-readable outcome move.
    assert any(model.provider_id == "provider-openai" for model in store.models.values())

    store.create_provider_key(
        key_id="k-open",
        provider=provider,
        name="Platform key",
        environment="production",
        status="Active",
        expires="Never",
        secret_value="sk-test-synthetic-0000000000",
        tenant_id=None,
    )
    auth_failing = FakeGateway(error=ModelGatewayAuthError("nope", status_code=401))
    monkeypatch.setattr("app.routes.platform.get_model_gateway_client", lambda: auth_failing)
    rejected = client.post("/api/platform/providers/provider-openai/validate", headers=headers("user-owner"))
    assert rejected.status_code == 401
    assert provider.last_validation_status == "auth_failed"
    assert store.provider_keys["k-open"].status == "Inactive"
    actions = [event.action for event in store.audit_events_newest_first(limit=10)]
    assert "platform.provider_runtime_validated" in actions
    assert "platform.provider_runtime_validation_failed" in actions

    unknown = client.post("/api/platform/providers/nope/validate", headers=headers("user-owner"))
    assert unknown.status_code == 404
