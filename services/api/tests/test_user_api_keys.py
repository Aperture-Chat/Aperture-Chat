from __future__ import annotations

from fastapi.testclient import TestClient
import pytest

from app.main import app
from app.models.schemas import PlatformSettings, Tenant
from app.repositories.deps import get_store
from app.repositories.identity_config_sql import IdentityConfigCorruptionError, _model_from_payload


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def test_legacy_platform_settings_accept_only_the_missing_master_policy_field() -> None:
    legacy_payload = PlatformSettings().model_dump(mode="json")
    legacy_payload.pop("downstream_api_enabled")

    loaded = _model_from_payload(PlatformSettings, legacy_payload, "platform")
    assert PlatformSettings().downstream_api_enabled is False
    assert loaded.downstream_api_enabled is True

    noncanonical_payload = dict(legacy_payload)
    noncanonical_payload.pop("require_sso_for_admins")
    with pytest.raises(IdentityConfigCorruptionError):
        _model_from_payload(PlatformSettings, noncanonical_payload, "platform")


def enable_api_access() -> None:
    platform_response = client.patch(
        "/api/platform/settings",
        headers=headers("user-owner"),
        json={"downstream_api_enabled": True},
    )
    assert platform_response.status_code == 200
    response = client.patch(
        "/api/admin/groups/group-litigation",
        headers=headers("user-admin"),
        json={"permissions": {"api_access": True}},
    )
    assert response.status_code == 200


def test_api_key_create_use_and_revoke_are_sql_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enable_api_access()
    store = get_store()
    json_saves: list[bool] = []
    monkeypatch.setattr(
        store,
        "save_runtime_state",
        lambda urgent=False: json_saves.append(urgent),
    )

    created = client.post("/api/auth/api-key", headers=headers("user-jane"))
    assert created.status_code == 200
    secret = created.json()["secret_value"]
    assert client.get(
        "/v1/models",
        headers={"Authorization": f"Bearer {secret}"},
    ).status_code == 200
    assert client.delete(
        "/api/auth/api-key",
        headers=headers("user-jane"),
    ).status_code == 200

    assert json_saves == []


def test_inactive_or_orphan_api_key_is_rejected_without_a_last_used_touch() -> None:
    store = get_store()
    user = store.users["user-jane"]
    _record, secret = store.create_user_api_key(user)

    assert store.user_for_api_key("apt_invalid-key") is None
    assert store.user_api_keys[user.id].last_used_at is None

    user.active = False
    assert store.user_for_api_key(secret) is None
    assert store.user_api_keys[user.id].last_used_at is None

    user.active = True
    removed = store.users.pop(user.id)
    assert store.user_for_api_key(secret) is None
    assert store.user_api_keys[user.id].last_used_at is None
    store.users[user.id] = removed


def test_api_key_touch_fails_closed_if_the_key_rotates_after_lookup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    user = store.users["user-jane"]
    _record, secret = store.create_user_api_key(user)
    monkeypatch.setattr(
        store.application_state_repository,
        "touch_user_api_key_if_current",
        lambda *_args, **_kwargs: False,
    )

    assert store.user_for_api_key(secret) is None
    assert store.user_api_keys[user.id].last_used_at is None


def test_user_api_key_is_admin_gated_returned_once_and_revocable() -> None:
    status = client.get("/api/auth/api-key", headers=headers("user-jane"))
    assert status.status_code == 200
    assert status.json() == {
        "enabled": False,
        "has_key": False,
        "masked_value": None,
        "created_at": None,
        "last_used_at": None,
    }

    denied = client.post("/api/auth/api-key", headers=headers("user-jane"))
    assert denied.status_code == 403

    enable_api_access()
    created = client.post("/api/auth/api-key", headers=headers("user-jane"))
    assert created.status_code == 200
    secret = created.json()["secret_value"]
    assert secret.startswith("apt_")
    assert secret not in created.json()["masked_value"]

    record = get_store().user_api_keys["user-jane"]
    assert record.key_hash != secret
    assert secret not in record.model_dump_json()

    fetched = client.get("/api/auth/api-key", headers=headers("user-jane"))
    assert fetched.status_code == 200
    assert fetched.json()["has_key"] is True
    assert "secret_value" not in fetched.json()

    models = client.get("/v1/models", headers={"Authorization": f"Bearer {secret}"})
    assert models.status_code == 200
    assert models.json()["object"] == "list"
    assert models.json()["data"]
    assert get_store().user_api_keys["user-jane"].last_used_at is not None

    revoked = client.delete("/api/auth/api-key", headers=headers("user-jane"))
    assert revoked.status_code == 200
    assert revoked.json()["has_key"] is False

    rejected = client.get("/v1/models", headers={"Authorization": f"Bearer {secret}"})
    assert rejected.status_code == 401


def test_master_policy_automatically_grants_admins_and_owners_only() -> None:
    admin_status = client.get("/api/auth/api-key", headers=headers("user-admin"))
    owner_status = client.get("/api/auth/api-key", headers=headers("user-owner"))
    assert admin_status.status_code == 200
    assert admin_status.json()["enabled"] is False
    assert owner_status.status_code == 200
    assert owner_status.json()["enabled"] is False

    assert client.post("/api/auth/api-key", headers=headers("user-admin")).status_code == 403
    assert client.post("/api/auth/api-key", headers=headers("user-owner")).status_code == 403

    enabled = client.patch(
        "/api/platform/settings",
        headers=headers("user-owner"),
        json={"downstream_api_enabled": True},
    )
    assert enabled.status_code == 200
    assert client.get("/api/auth/api-key", headers=headers("user-admin")).json()["enabled"] is True
    assert client.get("/api/auth/api-key", headers=headers("user-owner")).json()["enabled"] is True
    assert client.get("/api/auth/api-key", headers=headers("user-jane")).json()["enabled"] is False

    assert client.post("/api/auth/api-key", headers=headers("user-admin")).status_code == 200
    assert client.post("/api/auth/api-key", headers=headers("user-owner")).status_code == 200
    assert client.post("/api/auth/api-key", headers=headers("user-jane")).status_code == 403


def test_only_platform_owner_controls_master_policy_and_admins_grant_users() -> None:
    denied_master_change = client.patch(
        "/api/platform/settings",
        headers=headers("user-admin"),
        json={"downstream_api_enabled": True},
    )
    assert denied_master_change.status_code == 403

    denied_group_grant = client.patch(
        "/api/admin/groups/group-litigation",
        headers=headers("user-admin"),
        json={"permissions": {"api_access": True}},
    )
    assert denied_group_grant.status_code == 403
    assert "unavailable under the current service policy" in denied_group_grant.json()["detail"].lower()

    owner_activation = client.patch(
        "/api/platform/settings",
        headers=headers("user-owner"),
        json={"downstream_api_enabled": True},
    )
    assert owner_activation.status_code == 200
    assert owner_activation.json()["downstream_api_enabled"] is True
    assert client.get("/api/auth/api-key", headers=headers("user-owner")).json()[
        "enabled"
    ] is True
    assert client.get("/api/auth/api-key", headers=headers("user-admin")).json()[
        "enabled"
    ] is True
    assert client.get("/api/auth/api-key", headers=headers("user-jane")).json()[
        "enabled"
    ] is False
    admin_key = client.post("/api/auth/api-key", headers=headers("user-admin"))
    assert admin_key.status_code == 200

    admin_user_grant = client.patch(
        "/api/admin/groups/group-litigation",
        headers=headers("user-admin"),
        json={"permissions": {"api_access": True}},
    )
    assert admin_user_grant.status_code == 200
    assert client.get("/api/auth/api-key", headers=headers("user-jane")).json()[
        "enabled"
    ] is True

    owner_shutdown = client.patch(
        "/api/platform/settings",
        headers=headers("user-owner"),
        json={"downstream_api_enabled": False},
    )
    assert owner_shutdown.status_code == 200
    for user_id in ("user-owner", "user-admin", "user-jane"):
        assert client.get("/api/auth/api-key", headers=headers(user_id)).json()["enabled"] is False
    blocked_key = client.get(
        "/v1/models",
        headers={"Authorization": f"Bearer {admin_key.json()['secret_value']}"},
    )
    assert blocked_key.status_code == 403
    assert "unavailable under the current service policy" in blocked_key.json()["detail"].lower()


def test_disabling_group_api_access_immediately_blocks_an_existing_key() -> None:
    enable_api_access()
    created = client.post("/api/auth/api-key", headers=headers("user-jane"))
    secret = created.json()["secret_value"]

    disabled = client.patch(
        "/api/admin/groups/group-litigation",
        headers=headers("user-admin"),
        json={"permissions": {"api_access": False}},
    )
    assert disabled.status_code == 200

    response = client.get("/v1/models", headers={"Authorization": f"Bearer {secret}"})
    assert response.status_code == 403
    assert "API access is disabled" in response.json()["detail"]


def test_owner_api_key_inherits_only_an_unambiguous_single_tenant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enable_api_access()
    created = client.post("/api/auth/api-key", headers=headers("user-owner"))
    assert created.status_code == 200
    secret = created.json()["secret_value"]

    store = get_store()
    provider = store.providers["provider-openai"]
    provider.connected = True
    store.create_provider_key(
        key_id="key-owner-single-tenant-test",
        provider=provider,
        name="Owner single-tenant test",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="sk-owner-single-tenant-test",
    )

    class FakeGateway:
        def complete(self, **_kwargs):
            return {
                "id": "chatcmpl-owner-single-tenant",
                "model": "gpt-4.1",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "Owner route works"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 3, "total_tokens": 6},
            }

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: FakeGateway())
    payload = {
        "model": "gpt-4.1",
        "messages": [{"role": "user", "content": "Check the owner route."}],
    }
    bearer_headers = {"Authorization": f"Bearer {secret}"}

    single_tenant = client.post(
        "/v1/chat/completions",
        headers=bearer_headers,
        json=payload,
    )
    assert single_tenant.status_code == 200
    assert single_tenant.json()["choices"][0]["message"]["content"] == "Owner route works"

    store.tenants["tenant-second"] = Tenant(
        id="tenant-second",
        name="Second Tenant",
        slug="second",
    )
    ambiguous = client.post(
        "/v1/chat/completions",
        headers=bearer_headers,
        json=payload,
    )
    assert ambiguous.status_code == 400
    assert "explicit tenant scope" in ambiguous.json()["detail"].lower()

    selected = client.post(
        "/v1/chat/completions",
        headers={**bearer_headers, "x-aperture-tenant": "example"},
        json=payload,
    )
    assert selected.status_code == 200


def test_invalid_bearer_key_never_falls_back_to_dev_header_auth() -> None:
    response = client.get(
        "/v1/models",
        headers={"Authorization": "Bearer apt_not-a-real-key", "x-aperture-user": "user-admin"},
    )
    assert response.status_code == 401


def test_personal_key_preserves_agentic_tool_calls_and_openai_stream_chunks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enable_api_access()
    created = client.post("/api/auth/api-key", headers=headers("user-jane"))
    secret = created.json()["secret_value"]
    store = get_store()
    provider = store.providers["provider-openai"]
    provider.connected = True
    store.create_provider_key(
        key_id="key-openai-api-harness-test",
        provider=provider,
        name="Harness test",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="sk-upstream-test",
    )

    captured: dict[str, object] = {}

    class FakeGateway:
        def complete(self, **kwargs):
            captured.update(kwargs)
            return {
                "id": "chatcmpl-tool-test",
                "model": "gpt-4.1",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {"name": "read_file", "arguments": '{"path":"README.md"}'},
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12},
            }

        def stream_events(self, **kwargs):
            captured.update(kwargs)
            yield {
                "id": "chatcmpl-stream-tool-test",
                "object": "chat.completion.chunk",
                "model": "upstream-model",
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {"name": "read_file", "arguments": ""},
                                }
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            }

    monkeypatch.setattr("app.routes.chat.get_model_gateway_client", lambda: FakeGateway())
    tool = {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a workspace file",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
    }
    payload = {
        "model": "gpt-4.1",
        "messages": [{"role": "user", "content": "Read the project readme."}],
        "tools": [tool],
        "tool_choice": "auto",
    }

    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {secret}"},
        json=payload,
    )
    assert response.status_code == 200
    assert response.json()["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "read_file"
    assert captured["tools"] == [tool]
    assert captured["tool_choice"] == "auto"

    streamed = client.post(
        "/v1/chat/completions",
        headers={"Authorization": f"Bearer {secret}"},
        json={**payload, "stream": True},
    )
    assert streamed.status_code == 200
    assert '"tool_calls"' in streamed.text
    assert '"model": "gpt-4.1"' in streamed.text
    assert streamed.text.endswith("data: [DONE]\n\n")
