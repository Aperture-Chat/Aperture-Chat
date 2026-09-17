from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.policy import (
    MODEL_ACCESS_REASONS,
    explain_model_access,
    model_access_allowed,
)
from app.main import app
from app.models.schemas import ModelConfig, Role, Tenant, User
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    from app.routes.model_access import _REQUEST_BUCKETS

    get_store.cache_clear()
    _REQUEST_BUCKETS._buckets.clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _temp_user() -> User:
    return User(
        id="user-temp",
        tenant_id="tenant-example",
        email="temp@example.com",
        display_name="Temp Person",
        role=Role.TEMP_USER,
        group_ids=["group-litigation"],
    )


def _pending_user() -> User:
    return User(
        id="user-pending",
        tenant_id="tenant-example",
        email="pending@example.com",
        display_name="Pending Person",
        role=Role.USER,
        group_ids=[],
    )


def _cross_tenant_model() -> ModelConfig:
    return ModelConfig(
        id="model-other-tenant",
        tenant_id="tenant-other",
        provider_id="provider-openai",
        provider_name="OpenAI",
        name="Other Org Model",
        upstream_model_id="gpt-4.1",
    )


def test_explain_model_access_matches_boolean_verdict_across_fixture_matrix() -> None:
    store = get_store()
    store.models["model-other-tenant"] = _cross_tenant_model()
    store.models["agent-private-casey"] = ModelConfig(
        id="agent-private-casey",
        tenant_id="tenant-example",
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        name="Casey Private Agent",
        upstream_model_id="openai/gpt-4o-mini",
        is_custom=True,
        created_by="Casey Doe",
        visibility="private",
        meta_prompt="private",
    )
    users = [*store.users.values(), _temp_user(), _pending_user()]
    for user in users:
        for model in store.models.values():
            for explicit_deny in (False, True):
                decision = explain_model_access(
                    user,
                    model,
                    provider=store.providers.get(model.provider_id),
                    explicit_deny=explicit_deny,
                )
                assert decision.allowed == model_access_allowed(
                    user, model, explicit_deny=explicit_deny
                ), (user.id, model.id, explicit_deny)
                if decision.allowed:
                    assert decision.reason_code in {None, "provider_connected"}
                    assert decision.usable == (
                        store.providers[model.provider_id].connected
                        if model.provider_id in store.providers
                        else True
                    )
                else:
                    assert decision.reason_code in MODEL_ACCESS_REASONS
                    assert decision.reason == MODEL_ACCESS_REASONS[decision.reason_code]
                    assert not decision.usable
                assert decision.gates, "every decision records at least one gate"


def test_reason_codes_name_the_first_failing_gate() -> None:
    store = get_store()
    jane = store.users["user-jane"]
    maya = _pending_user()
    assert explain_model_access(jane, store.models["o3-mini"]).reason_code == "platform_enabled"
    assert (
        explain_model_access(jane, store.models["openrouter-openai-gpt-5-5"]).reason_code
        == "group_grant"
    )
    assert explain_model_access(maya, store.models["gpt-4o"]).reason_code == "account_pending"
    assert explain_model_access(jane, _cross_tenant_model()).reason_code == "tenant_scope"
    assert (
        explain_model_access(_temp_user(), store.models["gpt-4o"]).reason_code
        == "temp_user_contract"
    )
    assert (
        explain_model_access(jane, store.models["gpt-4o"], explicit_deny=True).reason_code
        == "explicit_deny"
    )
    # Allowed but the Azure provider is disconnected: usable=False, allowed=True.
    decision = explain_model_access(
        jane, store.models["gpt-4o"], provider=store.providers["provider-azure"]
    )
    assert decision.allowed and not decision.usable
    assert decision.reason_code == "provider_connected"


def test_catalog_redacts_prompts_and_hides_other_tenants_models() -> None:
    store = get_store()
    store.models["model-other-tenant"] = _cross_tenant_model()
    response = client.get("/api/me/model-catalog", headers=headers("user-jane"))
    assert response.status_code == 200
    body = response.json()
    assert body["browsing_enabled"] is True
    ids = {entry["model"]["id"] for entry in body["entries"]}
    assert "model-other-tenant" not in ids
    assert "o3-mini" not in ids, "platform-disabled models are not browsable"
    assert "openrouter-openai-gpt-5-5" in ids
    for entry in body["entries"]:
        assert "system_prompt" not in entry["model"]
        assert "meta_prompt" not in entry["model"]
        assert "notes" not in entry["model"]
    not_granted = next(e for e in body["entries"] if e["model"]["id"] == "openrouter-openai-gpt-5-5")
    assert not_granted["decision"]["allowed"] is False
    assert not_granted["decision"]["reason_code"] == "group_grant"
    assert not_granted["decision"]["requestable"] is True
    assert not_granted["decision"]["reason"] == MODEL_ACCESS_REASONS["group_grant"]

    direct = client.get("/api/me/model-access/model-other-tenant", headers=headers("user-jane"))
    assert direct.status_code == 404


def test_catalog_kill_switch_hides_inaccessible_models() -> None:
    store = get_store()
    store.platform_settings.users_can_browse_model_catalog = False
    response = client.get("/api/me/model-catalog", headers=headers("user-jane"))
    assert response.status_code == 200
    body = response.json()
    assert body["browsing_enabled"] is False
    assert all(entry["decision"]["allowed"] for entry in body["entries"])
    denied = client.post(
        "/api/me/model-access-requests",
        json={"model_id": "openrouter-openai-gpt-5-5"},
        headers=headers("user-jane"),
    )
    assert denied.status_code == 403


def test_request_lifecycle_create_duplicate_approve_flips_decision() -> None:
    store = get_store()
    model_id = "openrouter-openai-gpt-5-5"
    already = client.post(
        "/api/me/model-access-requests", json={"model_id": "gpt-4o"}, headers=headers("user-jane")
    )
    assert already.status_code == 409

    created = client.post(
        "/api/me/model-access-requests",
        json={"model_id": model_id, "note": "  Need it for the quarterly memo.  "},
        headers=headers("user-jane"),
    )
    assert created.status_code == 202, created.text
    entry = created.json()
    assert entry["open_request"]["status"] == "pending"
    assert entry["open_request"]["note"] == "Need it for the quarterly memo."
    request_id = entry["open_request"]["id"]

    duplicate = client.post(
        "/api/me/model-access-requests", json={"model_id": model_id}, headers=headers("user-jane")
    )
    assert duplicate.status_code == 409

    catalog = client.get("/api/me/model-catalog", headers=headers("user-jane")).json()
    pending_entry = next(e for e in catalog["entries"] if e["model"]["id"] == model_id)
    assert pending_entry["open_request"]["id"] == request_id
    assert pending_entry["decision"]["allowed"] is False, "a pending request never grants access"

    # The admin sees the request; the user does not receive the bootstrap count.
    admin_bootstrap = client.get("/api/bootstrap", headers=headers("user-admin")).json()
    assert admin_bootstrap["modelAccessRequestCount"] == 1
    user_bootstrap = client.get("/api/bootstrap", headers=headers("user-jane")).json()
    assert "modelAccessRequestCount" not in user_bootstrap

    listed = client.get("/api/admin/model-access-requests", headers=headers("user-admin"))
    assert listed.status_code == 200
    views = listed.json()
    assert [view["request"]["id"] for view in views] == [request_id]
    assert views[0]["requester_email"] == "jane.smith@example.com"
    assert views[0]["model_name"] == store.models[model_id].name
    tenant_group_ids = {g.id for g in store.groups.values() if g.tenant_id == "tenant-example"}
    assert views[0]["eligible_group_ids"] == [
        g for g in store.models[model_id].group_ids if g in tenant_group_ids
    ]
    assert "group-litigation" not in views[0]["eligible_group_ids"]
    assert views[0]["can_grant_new_group"] is True

    forbidden_user_list = client.get("/api/admin/model-access-requests", headers=headers("user-jane"))
    assert forbidden_user_list.status_code == 403

    approved = client.post(
        f"/api/admin/model-access-requests/{request_id}/approve",
        json={"group_id": "group-litigation", "note": "Approved for the memo."},
        headers=headers("user-admin"),
    )
    assert approved.status_code == 200, approved.text
    resolution = approved.json()
    assert resolution["request"]["status"] == "approved"
    assert resolution["request"]["granted_group_id"] == "group-litigation"
    assert resolution["decision"]["allowed"] is True
    assert "group-litigation" in store.models[model_id].group_ids
    assert model_access_allowed(store.users["user-jane"], store.models[model_id])

    again = client.post(
        f"/api/admin/model-access-requests/{request_id}/approve",
        json={"group_id": "group-litigation"},
        headers=headers("user-admin"),
    )
    assert again.status_code == 409

    actions = [event.action for event in store.audit_events_newest_first(limit=20)]
    assert "user.model_access_requested" in actions
    assert "admin.model_access_request_approved" in actions
    assert "admin.model_access_updated" in actions


def test_structural_gates_cannot_be_requested_and_pending_users_can() -> None:
    store = get_store()
    store.tenants["tenant-other"] = Tenant(id="tenant-other", name="Other", slug="other")
    store.models["model-other-tenant"] = _cross_tenant_model()
    cross = client.post(
        "/api/me/model-access-requests",
        json={"model_id": "model-other-tenant"},
        headers=headers("user-jane"),
    )
    assert cross.status_code == 404, "other organizations' models are never confirmed"

    store.users["user-pending"] = _pending_user()
    pending = client.post(
        "/api/me/model-access-requests", json={"model_id": "gpt-4o"}, headers=headers("user-pending")
    )
    assert pending.status_code == 202
    assert pending.json()["decision"]["reason_code"] == "account_pending"

    owner = client.post(
        "/api/me/model-access-requests", json={"model_id": "gpt-4o"}, headers=headers("user-owner")
    )
    assert owner.status_code == 409


def test_withdraw_and_decline_paths() -> None:
    created = client.post(
        "/api/me/model-access-requests",
        json={"model_id": "openrouter-openai-gpt-5-5"},
        headers=headers("user-jane"),
    ).json()
    request_id = created["open_request"]["id"]
    stranger = client.delete(
        f"/api/me/model-access-requests/{request_id}", headers=headers("user-casey")
    )
    assert stranger.status_code == 404
    withdrawn = client.delete(
        f"/api/me/model-access-requests/{request_id}", headers=headers("user-jane")
    )
    assert withdrawn.status_code == 200
    assert withdrawn.json()["status"] == "withdrawn"

    second = client.post(
        "/api/me/model-access-requests",
        json={"model_id": "openrouter-openai-gpt-5-5"},
        headers=headers("user-jane"),
    ).json()["open_request"]["id"]
    declined = client.post(
        f"/api/admin/model-access-requests/{second}/decline",
        json={"note": "Not this quarter."},
        headers=headers("user-admin"),
    )
    assert declined.status_code == 200
    assert declined.json()["request"]["status"] == "declined"
    assert declined.json()["request"]["resolution_note"] == "Not this quarter."
    assert declined.json()["decision"]["allowed"] is False


def test_tenant_admin_cannot_approve_into_another_tenants_group() -> None:
    store = get_store()
    store.tenants["tenant-other"] = Tenant(id="tenant-other", name="Other", slug="other")
    from app.models.schemas import Group

    store.groups["group-other"] = Group(
        id="group-other",
        tenant_id="tenant-other",
        name="Other Group",
        distinguished_name="Platform-managed group",
        entra_object_id="entra-group-other",
    )
    request_id = client.post(
        "/api/me/model-access-requests",
        json={"model_id": "openrouter-openai-gpt-5-5"},
        headers=headers("user-jane"),
    ).json()["open_request"]["id"]
    response = client.post(
        f"/api/admin/model-access-requests/{request_id}/approve",
        json={"group_id": "group-other"},
        headers=headers("user-admin"),
    )
    assert response.status_code == 403
    assert store.users["user-jane"].group_ids == ["group-litigation"]


def test_owner_lists_all_tenants_or_a_named_tenant_and_admin_pins_to_own() -> None:
    store = get_store()
    request_id = client.post(
        "/api/me/model-access-requests",
        json={"model_id": "openrouter-openai-gpt-5-5"},
        headers=headers("user-jane"),
    ).json()["open_request"]["id"]
    everything = client.get("/api/admin/model-access-requests", headers=headers("user-owner"))
    assert everything.status_code == 200
    assert [view["request"]["id"] for view in everything.json()] == [request_id]
    named = client.get(
        "/api/admin/model-access-requests",
        headers={**headers("user-owner"), "X-Aperture-Tenant": store.tenants["tenant-example"].slug},
    )
    assert named.status_code == 200
    unknown = client.get(
        "/api/admin/model-access-requests",
        headers={**headers("user-owner"), "X-Aperture-Tenant": "nope"},
    )
    assert unknown.status_code == 404
    outside = client.get(
        "/api/admin/model-access-requests",
        headers={**headers("user-admin"), "X-Aperture-Tenant": "nope"},
    )
    assert outside.status_code == 403


def test_trace_respects_can_view_user_and_lists_every_gate() -> None:
    owner_target = client.get("/api/admin/users/user-owner/model-access", headers=headers("user-admin"))
    assert owner_target.status_code == 404
    forbidden = client.get("/api/admin/users/user-jane/model-access", headers=headers("user-casey"))
    assert forbidden.status_code == 403
    trace = client.get("/api/admin/users/user-jane/model-access", headers=headers("user-admin"))
    assert trace.status_code == 200
    body = trace.json()
    assert body["user_id"] == "user-jane"
    entries = {entry["model"]["id"]: entry for entry in body["entries"]}
    assert entries["gpt-4o"]["decision"]["allowed"] is True
    keys = [gate["key"] for gate in entries["gpt-4o"]["decision"]["gates"]]
    assert keys == [
        "explicit_deny",
        "tenant_scope",
        "platform_enabled",
        "account_pending",
        "group_grant",
        "provider_connected",
    ]
    assert entries["openrouter-openai-gpt-5-5"]["decision"]["reason_code"] == "group_grant"
    assert "meta_prompt" not in entries["gpt-4o"]["model"]
    owner_trace = client.get("/api/admin/users/user-jane/model-access", headers=headers("user-owner"))
    assert owner_trace.status_code == 200


def test_legacy_platform_settings_and_provider_payloads_stay_loadable() -> None:
    """Rows saved before the catalog switch and provider timestamps existed
    must load at startup instead of failing as "not canonical"."""
    from app.models.schemas import PlatformSettings, Provider
    from app.repositories.identity_config_sql import (
        IdentityConfigCorruptionError,
        _model_from_payload,
    )

    settings_payload = PlatformSettings().model_dump(mode="json")
    del settings_payload["users_can_browse_model_catalog"]
    loaded = _model_from_payload(PlatformSettings, settings_payload, "platform")
    assert isinstance(loaded, PlatformSettings)
    assert loaded.users_can_browse_model_catalog is True

    provider_payload = Provider(id="p", name="P", kind="openai", region="Global").model_dump(mode="json")
    for field_name in (
        "last_validated_at",
        "last_validation_status",
        "last_validation_model_id",
        "last_synced_at",
    ):
        del provider_payload[field_name]
    provider = _model_from_payload(Provider, provider_payload, "providers")
    assert isinstance(provider, Provider)
    assert provider.last_validation_status is None

    provider_payload["surprise"] = True
    with pytest.raises(IdentityConfigCorruptionError):
        _model_from_payload(Provider, provider_payload, "providers")
