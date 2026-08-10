import base64
import hashlib
import hmac
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi.testclient import TestClient

from app.core.security import SecretVault
from app.main import app
from app.models.schemas import Provider, Role
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore

client = TestClient(app)


def _legacy_vault_token(secret: str, value: str) -> str:
    key = hashlib.sha256(secret.encode("utf-8")).digest()
    nonce = b"legacy-nonce-123"
    blocks: list[bytes] = []
    counter = 0
    payload_bytes = value.encode("utf-8")
    while sum(len(block) for block in blocks) < len(payload_bytes):
        blocks.append(
            hmac.new(
                key,
                nonce + counter.to_bytes(4, "big"),
                hashlib.sha256,
            ).digest()
        )
        counter += 1
    stream = b"".join(blocks)[: len(payload_bytes)]
    payload = bytes(left ^ right for left, right in zip(payload_bytes, stream, strict=True))
    tag = hmac.new(key, nonce + payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(nonce + tag + payload).decode("ascii")


def test_secret_vault_v2_round_trip_and_tamper_detection() -> None:
    vault = SecretVault("test-signing-secret")
    token = vault.encrypt("provider-secret-value")

    assert token.startswith("v2.")
    assert vault.decrypt(token) == "provider-secret-value"

    raw = bytearray(base64.urlsafe_b64decode(token.removeprefix("v2.")))
    raw[-1] ^= 1
    tampered = "v2." + base64.urlsafe_b64encode(raw).decode("ascii")
    with pytest.raises(ValueError, match="integrity"):
        vault.decrypt(tampered)


def test_secret_vault_reads_legacy_tokens_and_store_reencrypts_on_restart(
    tmp_path,
) -> None:
    secret = "test-signing-secret"
    provider_value = "legacy-provider-value"
    configuration_value = "legacy-configuration-value"
    legacy_provider = _legacy_vault_token(secret, provider_value)
    legacy_configuration = _legacy_vault_token(secret, configuration_value)
    vault = SecretVault(secret)

    assert vault.decrypt(legacy_provider) == provider_value
    assert vault.encrypt(provider_value).startswith("v2.")

    state_path = tmp_path / "runtime_state.json"
    store = SeedStore(
        vault,
        runtime_state_path=str(state_path),
    )
    provider = Provider(
        id="provider-legacy-test",
        name="Legacy provider test",
        kind="openai-compatible",
        region="Test",
        base_url="https://provider.example.test/v1",
        connected=True,
    )
    store.providers[provider.id] = provider
    provider_key = store.create_provider_key(
        key_id="key-legacy-provider-test",
        provider=provider,
        name="Legacy provider key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value=provider_value,
    )
    store._encrypted_keys[provider_key.id] = legacy_provider
    configuration_secret_key = "tool:tool-agent-workflow"
    store._configuration_secrets[configuration_secret_key] = legacy_configuration
    store.save_runtime_state()
    store.flush_now()
    store.close()

    restarted = SeedStore(
        SecretVault(secret),
        runtime_state_path=str(state_path),
    )
    assert restarted._encrypted_keys[provider_key.id].startswith("v3.")
    assert restarted._configuration_secrets[configuration_secret_key].startswith("v2.")
    assert restarted.provider_key_secret(provider_key.id).secret_value == provider_value
    assert (
        restarted.vault.decrypt(restarted._configuration_secrets[configuration_secret_key])
        == configuration_value
    )
    restarted.close()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def seed_openrouter_key(secret: str = "sk-or-v1-test-openrouter") -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    store.create_provider_key(
        key_id="key-openrouter-primary",
        provider=provider,
        name="OpenRouter Primary",
        environment="Production",
        status="Active",
        expires="Not set",
        secret_value=secret,
    )


def test_tenant_admin_cannot_see_platform_owner_in_user_list() -> None:
    response = client.get("/api/admin/users", headers=headers("user-admin"))
    assert response.status_code == 200
    emails = {user["email"] for user in response.json()}
    assert "owner@aperture.local" not in emails
    assert "alex.morgan@example.com" in emails


def test_tenant_admin_cannot_access_provider_key_vault() -> None:
    list_response = client.get("/api/platform/provider-keys", headers=headers("user-admin"))
    assert list_response.status_code == 403

    reveal_response = client.post(
        "/api/platform/provider-keys/key-openrouter-primary/reveal",
        headers=headers("user-admin"),
    )
    assert reveal_response.status_code == 403


def test_platform_owner_can_reveal_key_and_audit_redacts_secret() -> None:
    seed_openrouter_key()

    response = client.post(
        "/api/platform/provider-keys/key-openrouter-primary/reveal",
        headers=headers("user-owner"),
    )
    assert response.status_code == 200
    assert response.json()["secret_value"].startswith("sk-or-v1")

    store = get_store()
    latest = store.audit_events[-1]
    assert latest.action == "platform.provider_key_revealed"
    assert latest.metadata["secret_value"] == "[redacted]"


def test_tenant_admin_cannot_delete_admin_or_platform_owner() -> None:
    admin_response = client.delete("/api/admin/users/user-drew", headers=headers("user-admin"))
    assert admin_response.status_code == 403

    owner_response = client.delete("/api/admin/users/user-owner", headers=headers("user-admin"))
    assert owner_response.status_code == 403


def test_admin_creation_delegation_stays_below_platform_owner() -> None:
    store = get_store()
    original_policy = store.platform_settings.tenant_admins_can_create_admins
    delegated_admin_id = "user-delegated-admin-test"
    delegated_owner_id = "user-delegated-owner-test"
    owner_created_id = "user-owner-created-test"
    for user_id in [delegated_admin_id, delegated_owner_id, owner_created_id]:
        store.users.pop(user_id, None)
    store.platform_settings.tenant_admins_can_create_admins = False
    try:
        blocked_admin = client.post(
            "/api/admin/users",
            headers=headers("user-admin"),
            json={
                "id": delegated_admin_id,
                "tenant_id": "tenant-example",
                "email": "delegated.admin@example.com",
                "display_name": "Delegated Admin",
                "role": "TENANT_ADMIN",
            },
        )
        assert blocked_admin.status_code == 403

        store.platform_settings.tenant_admins_can_create_admins = True
        allowed_admin = client.post(
            "/api/admin/users",
            headers=headers("user-admin"),
            json={
                "id": delegated_admin_id,
                "tenant_id": "tenant-example",
                "email": "delegated.admin@example.com",
                "display_name": "Delegated Admin",
                "role": "TENANT_ADMIN",
            },
        )
        assert allowed_admin.status_code == 201
        assert allowed_admin.json()["tenant_id"] == "tenant-example"

        blocked_owner = client.post(
            "/api/admin/users",
            headers=headers("user-admin"),
            json={
                "id": delegated_owner_id,
                "email": "delegated.owner@example.com",
                "display_name": "Delegated Owner",
                "role": "PLATFORM_OWNER",
            },
        )
        assert blocked_owner.status_code == 403

        owner_created = client.post(
            "/api/admin/users",
            headers=headers("user-owner"),
            json={
                "id": owner_created_id,
                "tenant_id": "tenant-example",
                "email": "owner.created@example.com",
                "display_name": "Owner Created",
                "role": "PLATFORM_OWNER",
            },
        )
        assert owner_created.status_code == 201
        assert owner_created.json()["tenant_id"] is None
    finally:
        store.platform_settings.tenant_admins_can_create_admins = original_policy
        for user_id in [delegated_admin_id, delegated_owner_id, owner_created_id]:
            store.users.pop(user_id, None)


def test_platform_owner_cannot_demote_last_active_owner() -> None:
    response = client.patch(
        "/api/admin/users/user-owner",
        headers=headers("user-owner"),
        json={"role": "USER"},
    )
    assert response.status_code == 409
    assert "This service-managed account cannot be changed" in response.json()["detail"]


def test_disabled_model_fails_before_provider_invocation() -> None:
    response = client.post(
        "/v1/chat/completions",
        json={"model": "o3-mini", "messages": [{"role": "user", "content": "hello"}]},
        headers=headers("user-jane"),
    )
    assert response.status_code == 403

    store = get_store()
    assert not any(
        event.target == "o3-mini" and event.action == "gateway.chat_completion"
        for event in store.audit_events
    )


def _enable_scim(monkeypatch, token: str = "scim-test-token") -> dict[str, str]:
    from app.core.config import get_settings

    settings = get_settings().model_copy(update={"scim_bearer_token": token})
    monkeypatch.setattr("app.routes.scim.get_settings", lambda: settings)
    return {"Authorization": f"Bearer {token}"}


def test_scim_rejects_unconfigured_and_bad_bearer_tokens(monkeypatch) -> None:
    # Without a configured token SCIM refuses to pretend provisioning works.
    unconfigured = client.get("/scim/v2/Users", headers=headers("user-admin"))
    assert unconfigured.status_code == 503
    assert "SCIM provisioning is not configured" in unconfigured.json()["detail"]

    scim_headers = _enable_scim(monkeypatch)
    wrong_token = client.get("/scim/v2/Users", headers={"Authorization": "Bearer wrong-token"})
    assert wrong_token.status_code == 401

    spoofed_header = client.get("/scim/v2/Users", headers=headers("user-admin"))
    assert spoofed_header.status_code == 401

    accepted = client.get("/scim/v2/Users", headers=scim_headers)
    assert accepted.status_code == 200
    emails = {resource["userName"] for resource in accepted.json()["Resources"]}
    assert "owner@aperture.local" not in emails
    assert "jane.smith@example.com" in emails


def test_scim_create_update_and_deactivate_operate_on_real_user_store(monkeypatch) -> None:
    scim_headers = _enable_scim(monkeypatch)
    create_response = client.post(
        "/scim/v2/Users",
        json={
            "userName": "new.user@example.com",
            "active": True,
            "externalId": "entra-new-user",
            "name": {"givenName": "New", "familyName": "User"},
            "groups": [{"value": "group-litigation"}],
        },
        headers=scim_headers,
    )
    assert create_response.status_code == 201
    user_id = create_response.json()["id"]

    store = get_store()
    provisioned = store.users[user_id]
    assert provisioned.email == "new.user@example.com"
    assert provisioned.display_name == "New User"
    assert provisioned.tenant_id == "tenant-example"
    assert provisioned.group_ids == ["group-litigation"]
    assert provisioned.auth_method == "scim"

    replace_response = client.put(
        f"/scim/v2/Users/{user_id}",
        json={
            "userName": "renamed.user@example.com",
            "active": True,
            "externalId": "entra-new-user",
            "name": {"givenName": "Renamed", "familyName": "User"},
        },
        headers=scim_headers,
    )
    assert replace_response.status_code == 200
    assert replace_response.json()["userName"] == "renamed.user@example.com"
    assert store.users[user_id].email == "renamed.user@example.com"

    patch_response = client.patch(
        f"/scim/v2/Users/{user_id}",
        json={"Operations": [{"op": "replace", "path": "active", "value": False}]},
        headers=scim_headers,
    )
    assert patch_response.status_code == 200
    assert patch_response.json()["active"] is False
    assert store.users[user_id].active is False

    owner_attempt = client.patch(
        "/scim/v2/Users/user-owner",
        json={"Operations": [{"op": "replace", "path": "active", "value": False}]},
        headers=scim_headers,
    )
    # Platform owners have no tenant, so SCIM cannot even see them.
    assert owner_attempt.status_code == 404
    assert store.users["user-owner"].active is True

    delete_response = client.delete(f"/scim/v2/Users/{user_id}", headers=scim_headers)
    assert delete_response.status_code == 204
    assert store.users[user_id].active is False


def test_scim_deactivation_paths_advance_monotonically_and_reactivation_retains_cutoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scim_headers = _enable_scim(monkeypatch)
    create_response = client.post(
        "/scim/v2/Users",
        json={
            "userName": "session.lifecycle@example.com",
            "active": True,
            "name": {"givenName": "Session", "familyName": "Lifecycle"},
        },
        headers=scim_headers,
    )
    assert create_response.status_code == 201
    user_id = create_response.json()["id"]
    store = get_store()
    original_advance = store.advance_user_session_watermark
    calls: list[dict[str, object]] = []

    def observed_advance(
        observed_user_id: str,
        tenant_id: str | None,
        **kwargs: object,
    ) -> int:
        target = store.users[observed_user_id]
        observed = {
            "user_id": observed_user_id,
            "tenant_id": tenant_id,
            "reason": kwargs["reason"],
            "updated_by": kwargs["updated_by"],
            "deactivate": kwargs["deactivate"],
            "expected_user": kwargs["expected_user"],
            "active_before": target.active,
            "email_before": target.email,
        }
        advanced = original_advance(observed_user_id, tenant_id, **kwargs)
        observed["active_after"] = target.active
        calls.append(observed)
        return advanced

    monkeypatch.setattr(store, "advance_user_session_watermark", observed_advance)
    try:
        put_deactivate = client.put(
            f"/scim/v2/Users/{user_id}",
            json={
                "userName": "renamed.lifecycle@example.com",
                "active": False,
                "name": {"givenName": "Renamed", "familyName": "Lifecycle"},
            },
            headers=scim_headers,
        )
        assert put_deactivate.status_code == 200
        first_cutoff = store.session_issued_before_ms[user_id]
        assert calls == [
            {
                "user_id": user_id,
                "tenant_id": "tenant-example",
                "reason": "scim-user-deactivated",
                "updated_by": "scim-provisioner-tenant-example",
                "deactivate": True,
                "expected_user": store.users[user_id],
                "active_before": True,
                "email_before": "session.lifecycle@example.com",
                "active_after": False,
            }
        ]

        repeated_put = client.put(
            f"/scim/v2/Users/{user_id}",
            json={"userName": "renamed.lifecycle@example.com", "active": False},
            headers=scim_headers,
        )
        assert repeated_put.status_code == 200
        assert len(calls) == 2
        assert calls[-1]["active_before"] is False
        assert calls[-1]["active_after"] is False
        second_cutoff = store.session_issued_before_ms[user_id]
        assert second_cutoff >= first_cutoff

        put_reactivate = client.put(
            f"/scim/v2/Users/{user_id}",
            json={"userName": "renamed.lifecycle@example.com", "active": True},
            headers=scim_headers,
        )
        assert put_reactivate.status_code == 200
        # A full SCIM PUT can replace identity and group fields, so v5 revokes
        # the prior session family even when the final active state is true.
        assert len(calls) == 3
        assert calls[-1]["active_before"] is False
        assert calls[-1]["active_after"] is True
        third_cutoff = store.session_issued_before_ms[user_id]
        assert third_cutoff >= second_cutoff

        patch_deactivate = client.patch(
            f"/scim/v2/Users/{user_id}",
            json={"Operations": [{"op": "replace", "path": "active", "value": "false"}]},
            headers=scim_headers,
        )
        assert patch_deactivate.status_code == 200
        assert patch_deactivate.json()["active"] is False
        assert len(calls) == 4
        fourth_cutoff = store.session_issued_before_ms[user_id]
        assert fourth_cutoff >= third_cutoff

        patch_reactivate = client.patch(
            f"/scim/v2/Users/{user_id}",
            json={"Operations": [{"op": "replace", "path": "active", "value": "true"}]},
            headers=scim_headers,
        )
        assert patch_reactivate.status_code == 200
        assert patch_reactivate.json()["active"] is True
        assert len(calls) == 4
        assert store.session_issued_before_ms[user_id] == fourth_cutoff

        deactivate_then_reactivate = client.patch(
            f"/scim/v2/Users/{user_id}",
            json={
                "Operations": [
                    {"op": "replace", "path": "active", "value": False},
                    {"op": "replace", "path": "active", "value": True},
                ]
            },
            headers=scim_headers,
        )
        assert deactivate_then_reactivate.status_code == 200
        assert deactivate_then_reactivate.json()["active"] is True
        assert len(calls) == 5
        fifth_cutoff = store.session_issued_before_ms[user_id]
        assert fifth_cutoff >= fourth_cutoff

        delete_deactivate = client.delete(f"/scim/v2/Users/{user_id}", headers=scim_headers)
        assert delete_deactivate.status_code == 204
        assert len(calls) == 6
        sixth_cutoff = store.session_issued_before_ms[user_id]
        assert sixth_cutoff >= fifth_cutoff

        repeated_delete = client.delete(f"/scim/v2/Users/{user_id}", headers=scim_headers)
        assert repeated_delete.status_code == 204
        assert len(calls) == 7
        assert calls[-1]["active_before"] is False
        assert calls[-1]["active_after"] is False
        assert store.session_issued_before_ms[user_id] >= sixth_cutoff
    finally:
        store.users.pop(user_id, None)


@pytest.mark.parametrize(
    ("method", "payload"),
    [
        (
            "PUT",
            {
                "userName": "admin@example.com",
                "active": False,
                "name": {"givenName": "Alex", "familyName": "Morgan"},
            },
        ),
        (
            "PATCH",
            {
                "Operations": [
                    {
                        "op": "replace",
                        "path": "displayName",
                        "value": "Must Not Change",
                    },
                    {"op": "replace", "path": "active", "value": False},
                ]
            },
        ),
        ("DELETE", None),
    ],
)
def test_scim_cannot_deactivate_last_active_tenant_admin(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    payload: dict[str, object] | None,
) -> None:
    """The guard now counts owners as administrators: SCIM deprovisioning of
    the sole tenant admin is only refused when no active owner remains."""

    scim_headers = _enable_scim(monkeypatch)
    store = get_store()
    target = store.users["user-admin"]
    prior_activity = {
        user.id: user.active
        for user in store.users.values()
        if user.role in {Role.TENANT_ADMIN, Role.PLATFORM_OWNER}
    }
    try:
        for user in store.users.values():
            if user.role == Role.PLATFORM_OWNER:
                user.active = False
            if user.role == Role.TENANT_ADMIN and user.tenant_id == target.tenant_id:
                user.active = user.id == target.id
        before_user = target.model_dump(mode="json")
        before_watermarks = dict(store.session_issued_before_ms.items())
        before_audit_count = len(store.audit_events)

        response = client.request(
            method,
            f"/scim/v2/Users/{target.id}",
            json=payload,
            headers=scim_headers,
        )

        assert response.status_code == 409
        assert response.json() == {
            "detail": "This action is blocked by administrative continuity policy."
        }
        assert target.model_dump(mode="json") == before_user
        assert dict(store.session_issued_before_ms.items()) == before_watermarks
        assert len(store.audit_events) == before_audit_count
    finally:
        for user_id, active in prior_activity.items():
            store.users[user_id].active = active


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
def test_scim_deactivates_last_tenant_admin_while_owner_remains(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
) -> None:
    """Owners are administrators too: with an active owner, SCIM may
    deprovision the sole tenant admin for real."""

    payloads = {
        "PUT": {
            "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
            "userName": "admin@aperture.local",
            "active": False,
        },
        "PATCH": {
            "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
            "Operations": [{"op": "replace", "path": "active", "value": False}],
        },
        "DELETE": None,
    }
    scim_headers = _enable_scim(monkeypatch)
    store = get_store()
    target = store.users["user-admin"]
    prior_activity = {
        user.id: user.active
        for user in store.users.values()
        if user.role in {Role.TENANT_ADMIN, Role.PLATFORM_OWNER}
    }
    try:
        for user in store.users.values():
            if user.role == Role.TENANT_ADMIN and user.tenant_id == target.tenant_id:
                user.active = user.id == target.id

        response = client.request(
            method,
            f"/scim/v2/Users/{target.id}",
            json=payloads[method],
            headers=scim_headers,
        )

        assert response.status_code == (204 if method == "DELETE" else 200)
        assert store.users[target.id].active is False
    finally:
        for user_id, active in prior_activity.items():
            store.users[user_id].active = active


def test_scim_false_then_true_reactivates_last_admin_after_advancing_cutoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scim_headers = _enable_scim(monkeypatch)
    store = get_store()
    target = store.users["user-admin"]
    admin_activity = {
        user.id: user.active
        for user in store.users.values()
        if user.role == Role.TENANT_ADMIN and user.tenant_id == target.tenant_id
    }
    try:
        for user_id in admin_activity:
            store.users[user_id].active = user_id == target.id
        before_cutoff = store.session_issued_before_ms.get(target.id, 0)

        response = client.patch(
            f"/scim/v2/Users/{target.id}",
            json={
                "Operations": [
                    {"op": "replace", "path": "active", "value": False},
                    {"op": "replace", "path": "active", "value": True},
                ]
            },
            headers=scim_headers,
        )

        assert response.status_code == 200
        assert response.json()["active"] is True
        assert target.active is True
        assert store.session_issued_before_ms[target.id] > before_cutoff
    finally:
        for user_id, active in admin_activity.items():
            store.users[user_id].active = active


def test_scim_put_rechecks_unique_email_inside_locked_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scim_headers = _enable_scim(monkeypatch)
    store = get_store()
    target = store.users["user-jane"]
    original_apply = store.apply_scim_user_mutation
    precheck_complete = Event()
    allow_locked_recheck = Event()
    requested_email = "scim.unique.race@example.com"

    def blocked_apply(*args: object, **kwargs: object) -> int | None:
        precheck_complete.set()
        assert allow_locked_recheck.wait(timeout=5)
        return original_apply(*args, **kwargs)

    monkeypatch.setattr(store, "apply_scim_user_mutation", blocked_apply)
    before_target = target.model_dump(mode="json")
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            response_future = executor.submit(
                client.put,
                f"/scim/v2/Users/{target.id}",
                json={"userName": requested_email, "active": True},
                headers=scim_headers,
            )
            assert precheck_complete.wait(timeout=5)
            with store._store_lock:
                store.users["user-scim-identity-race"] = target.model_copy(
                    deep=True,
                    update={"id": "user-scim-identity-race", "email": requested_email},
                )
            allow_locked_recheck.set()
            response = response_future.result(timeout=5)

        assert response.status_code == 409
        assert response.json() == {"detail": "User email already exists."}
        assert target.model_dump(mode="json") == before_target
        assert dict(store.session_issued_before_ms.items()) == before_cutoffs
        assert len(store.audit_events) == before_audit_count
    finally:
        store.users.pop("user-scim-identity-race", None)


def test_concurrent_scim_create_enforces_unique_identity_under_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scim_headers = _enable_scim(monkeypatch)
    store = get_store()
    email = "scim.concurrent.create@example.com"
    before_audit_count = len(store.audit_events)

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = [
            future.result(timeout=5)
            for future in [
                executor.submit(
                    client.post,
                    "/scim/v2/Users",
                    json={"userName": email, "active": True},
                    headers=scim_headers,
                )
                for _ in range(2)
            ]
        ]

    assert sorted(response.status_code for response in responses) == [201, 409]
    created = [user for user in store.users.values() if user.email == email]
    assert len(created) == 1
    assert len(store.audit_events) == before_audit_count + 1
    store.users.pop(created[0].id, None)


@pytest.mark.parametrize(
    ("method", "payload"),
    [
        (
            "PUT",
            {
                "userName": "must.not.change@example.com",
                "active": False,
                "name": {"givenName": "Must", "familyName": "Not Change"},
            },
        ),
        (
            "PATCH",
            {
                "Operations": [
                    {"op": "replace", "path": "displayName", "value": "Must Not Change"},
                    {"op": "replace", "path": "active", "value": False},
                ]
            },
        ),
        ("DELETE", None),
    ],
)
def test_scim_security_mutations_reject_in_place_scope_change_after_authorization(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    payload: dict[str, object] | None,
) -> None:
    scim_headers = _enable_scim(monkeypatch)
    store = get_store()
    target = store.users["user-jane"].model_copy(
        deep=True,
        update={
            "id": "user-scim-scope-race",
            "email": "scim.scope.race@example.com",
            "display_name": "SCIM Scope Race",
            "role": Role.USER,
            "active": True,
        },
    )
    store.users[target.id] = target
    original_apply = store.apply_scim_user_mutation
    authorized = Event()
    allow_mutation = Event()

    def blocked_apply(*args: object, **kwargs: object) -> int | None:
        authorized.set()
        assert allow_mutation.wait(timeout=5)
        return original_apply(*args, **kwargs)

    monkeypatch.setattr(store, "apply_scim_user_mutation", blocked_apply)
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            response_future = executor.submit(
                client.request,
                method,
                f"/scim/v2/Users/{target.id}",
                json=payload,
                headers=scim_headers,
            )
            assert authorized.wait(timeout=5)
            with store._store_lock:
                target.role = Role.PLATFORM_OWNER
                target.tenant_id = None
                target.group_ids = []
            allow_mutation.set()
            response = response_future.result(timeout=5)

        assert response.status_code == 503
        assert response.json() == {"detail": "Session revocation is temporarily unavailable."}
        assert target.role == Role.PLATFORM_OWNER
        assert target.tenant_id is None
        assert target.active is True
        assert target.email == "scim.scope.race@example.com"
        assert target.display_name == "SCIM Scope Race"
        assert dict(store.session_issued_before_ms.items()) == before_cutoffs
        assert len(store.audit_events) == before_audit_count
    finally:
        store.users.pop(target.id, None)


@pytest.mark.parametrize("value", [None, 0, 1, "", "yes", [], {}])
def test_scim_patch_rejects_malformed_active_values_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
    value: object,
) -> None:
    scim_headers = _enable_scim(monkeypatch)
    store = get_store()
    target = store.users["user-jane"]
    before_user = target.model_dump(mode="json")
    before_watermarks = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)

    response = client.patch(
        f"/scim/v2/Users/{target.id}",
        json={"Operations": [{"op": "replace", "path": "active", "value": value}]},
        headers=scim_headers,
    )

    assert response.status_code == 400
    assert response.json() == {
        "detail": "SCIM active must be a boolean or the string 'true' or 'false'."
    }
    assert target.model_dump(mode="json") == before_user
    assert dict(store.session_issued_before_ms.items()) == before_watermarks
    assert len(store.audit_events) == before_audit_count


@pytest.mark.parametrize(
    ("method", "payload"),
    [
        (
            "PUT",
            {
                "userName": "must.not.change@example.com",
                "active": False,
                "name": {"givenName": "Must", "familyName": "Not Change"},
            },
        ),
        (
            "PATCH",
            {
                "Operations": [
                    {"op": "replace", "path": "displayName", "value": "Must Not Change"},
                    {"op": "replace", "path": "active", "value": False},
                ]
            },
        ),
        ("DELETE", None),
    ],
)
def test_scim_session_revocation_failure_is_503_before_any_mutation(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    payload: dict[str, object] | None,
) -> None:
    scim_headers = _enable_scim(monkeypatch)
    store = get_store()
    target = store.users["user-jane"]
    before_user = target.model_dump(mode="json")
    before_watermarks = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)

    def unavailable(*_args: object, **_kwargs: object) -> int:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(store, "advance_user_session_watermark", unavailable)
    response = client.request(
        method,
        f"/scim/v2/Users/{target.id}",
        json=payload,
        headers=scim_headers,
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "Session revocation is temporarily unavailable."}
    assert target.model_dump(mode="json") == before_user
    assert dict(store.session_issued_before_ms.items()) == before_watermarks
    assert len(store.audit_events) == before_audit_count
