from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Barrier, Event

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.model_discovery import DiscoveredModel, ModelDiscoveryError, discover_provider_models
from app.core.model_gateway import ModelGatewayAuthError, ModelGatewayError
from app.main import app
from app.models.schemas import (
    DEFAULT_USER_GROUP_ID,
    Automation,
    AutomationStep,
    ChatMessage,
    ChatThread,
    ModelCapabilities,
    ModelConfig,
    Provider,
    Role,
)
from app.repositories.deps import get_store
from app.repositories.seed import LastActiveAdministrativeAccountError, SessionUserStateError

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def seed_provider_key(
    provider_id: str, secret: str, key_id: str | None = None, name: str | None = None
) -> None:
    store = get_store()
    provider = store.providers[provider_id]
    provider.connected = True
    provider.last_sync = "Loaded for test"
    key_id = key_id or f"key-{provider.id}-primary"
    store.create_provider_key(
        key_id=key_id,
        provider=provider,
        name=name or f"{provider.name} Primary",
        environment="Production",
        status="Active",
        expires="Not set",
        secret_value=secret,
    )


def seed_openrouter_key(secret: str = "sk-or-v1-test-openrouter") -> None:
    seed_provider_key("provider-openrouter", secret, "key-openrouter-primary", "OpenRouter Primary")


def test_admin_approves_pending_temp_user_with_luna_only_model_access() -> None:
    requested = client.post(
        "/api/auth/access-requests",
        json={"first_name": "Taylor", "last_name": "Ng", "email": "taylor.ng@example.com"},
    )
    assert requested.status_code == 202
    store = get_store()
    target = next(user for user in store.users.values() if user.email == "taylor.ng@example.com")
    source_model = next(iter(store.models.values()))
    store.models["openai-gpt-5-6-luna"] = source_model.model_copy(
        deep=True,
        update={
            "id": "openai-gpt-5-6-luna",
            "name": "OpenAI GPT 5.6 Luna",
            "upstream_model_id": "gpt-5.6-luna",
            "platform_enabled": True,
            "tenant_id": "tenant-example",
            "group_ids": [],
        },
    )

    approved = client.post(
        f"/api/admin/access-requests/{target.id}/approve",
        headers=headers("user-admin"),
        json={"role": "TEMP_USER"},
    )

    assert approved.status_code == 200
    approved_user = approved.json()
    assert approved_user["role"] == "TEMP_USER"
    assert approved_user["active"] is True
    assert approved_user["access_request_status"] == "approved"
    assert approved_user["group_ids"] == [DEFAULT_USER_GROUP_ID]
    bootstrap = client.get("/api/bootstrap", headers=headers(target.id))
    assert bootstrap.status_code == 200
    assert [model["id"] for model in bootstrap.json()["models"]] == ["openai-gpt-5-6-luna"]


def test_admin_cannot_approve_request_as_admin_without_delegation_and_can_decline() -> None:
    client.post(
        "/api/auth/access-requests",
        json={"first_name": "Morgan", "last_name": "Lee", "email": "morgan.lee@example.com"},
    )
    target = next(user for user in get_store().users.values() if user.email == "morgan.lee@example.com")

    denied = client.post(
        f"/api/admin/access-requests/{target.id}/approve",
        headers=headers("user-admin"),
        json={"role": "TENANT_ADMIN"},
    )
    assert denied.status_code == 403
    declined = client.delete(
        f"/api/admin/access-requests/{target.id}",
        headers=headers("user-admin"),
    )
    assert declined.status_code == 200
    assert target.id not in get_store().users


def test_admin_cannot_approve_temp_access_without_an_enabled_luna_model() -> None:
    client.post(
        "/api/auth/access-requests",
        json={"first_name": "Sam", "last_name": "Ortiz", "email": "sam.ortiz@example.com"},
    )
    target = next(user for user in get_store().users.values() if user.email == "sam.ortiz@example.com")

    denied = client.post(
        f"/api/admin/access-requests/{target.id}/approve",
        headers=headers("user-admin"),
        json={"role": "TEMP_USER"},
    )

    assert denied.status_code == 409
    assert denied.json()["detail"] == "Enable a Luna model for this workspace before approving temporary access."
    assert target.active is False
    assert target.access_request_status == "pending"


def seed_tenant(tenant_id: str) -> None:
    store = get_store()
    if tenant_id in store.tenants:
        return
    source = store.tenants["tenant-example"]
    store.tenants[tenant_id] = source.model_copy(
        deep=True,
        update={
            "id": tenant_id,
            "name": "Other Tenant",
            "slug": "other-tenant",
            "custom_domain": None,
        },
    )


class FakeProviderRuntimeGateway:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error

    def complete(self, **_kwargs: object) -> dict[str, object]:
        if self.error is not None:
            raise self.error
        return {"choices": [{"message": {"content": "OK"}}]}


def mock_provider_runtime(
    monkeypatch: pytest.MonkeyPatch, *, error: Exception | None = None
) -> None:
    monkeypatch.setattr(
        "app.routes.platform.get_model_gateway_client",
        lambda: FakeProviderRuntimeGateway(error=error),
    )


def test_tenant_admin_can_create_update_and_deactivate_assignable_user() -> None:
    create_response = client.post(
        "/api/admin/users",
        json={
            "id": "user-new-power",
            "email": "new.power@example.com",
            "display_name": "New Power",
            "role": "POWER_USER",
            "group_ids": ["group-litigation"],
        },
        headers=headers("user-admin"),
    )
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["tenant_id"] == "tenant-example"
    assert created["role"] == "POWER_USER"

    update_response = client.patch(
        "/api/admin/users/user-new-power",
        json={"display_name": "New Approver", "role": "AGENT_APPROVER"},
        headers=headers("user-admin"),
    )
    assert update_response.status_code == 200
    assert update_response.json()["role"] == "AGENT_APPROVER"

    deactivate_response = client.post(
        "/api/admin/users/user-new-power/deactivate", headers=headers("user-admin")
    )
    assert deactivate_response.status_code == 200
    assert get_store().users["user-new-power"].active is False

    actions = [event.action for event in get_store().audit_events]
    assert actions[-3:] == ["admin.user_created", "admin.user_updated", "admin.user_deactivated"]


def test_admin_deactivation_paths_advance_monotonically_and_reactivation_retains_cutoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    target = store.users["user-jane"]
    original_advance = store.advance_user_session_watermark
    calls: list[dict[str, object]] = []

    def observed_advance(
        user_id: str,
        tenant_id: str | None,
        **kwargs: object,
    ) -> int:
        observed = {
            "user_id": user_id,
            "tenant_id": tenant_id,
            "reason": kwargs["reason"],
            "updated_by": kwargs["updated_by"],
            "deactivate": kwargs["deactivate"],
            "expected_user": kwargs["expected_user"],
            "active_before": store.users[user_id].active,
            "display_name_before": store.users[user_id].display_name,
        }
        advanced = original_advance(user_id, tenant_id, **kwargs)
        observed["active_after"] = store.users[user_id].active
        calls.append(observed)
        return advanced

    monkeypatch.setattr(store, "advance_user_session_watermark", observed_advance)

    patch_deactivate = client.patch(
        f"/api/admin/users/{target.id}",
        json={"active": False, "display_name": "Deactivated Jane"},
        headers=headers("user-admin"),
    )
    assert patch_deactivate.status_code == 200
    first_cutoff = store.session_issued_before_ms[target.id]
    assert calls == [
        {
            "user_id": target.id,
            "tenant_id": target.tenant_id,
            "reason": "admin-user-deactivated",
            "updated_by": "user-admin",
            "deactivate": True,
            "expected_user": target,
            "active_before": True,
            "display_name_before": "Jane Smith",
            "active_after": False,
        }
    ]

    repeated_patch = client.patch(
        f"/api/admin/users/{target.id}",
        json={"active": False},
        headers=headers("user-admin"),
    )
    assert repeated_patch.status_code == 200
    assert len(calls) == 2
    assert calls[-1]["active_before"] is False
    assert calls[-1]["active_after"] is False
    second_cutoff = store.session_issued_before_ms[target.id]
    assert second_cutoff >= first_cutoff

    reactivate = client.patch(
        f"/api/admin/users/{target.id}",
        json={"active": True},
        headers=headers("user-admin"),
    )
    assert reactivate.status_code == 200
    assert len(calls) == 2
    assert store.session_issued_before_ms[target.id] == second_cutoff

    post_deactivate = client.post(
        f"/api/admin/users/{target.id}/deactivate",
        headers=headers("user-admin"),
    )
    assert post_deactivate.status_code == 200
    assert len(calls) == 3
    third_cutoff = store.session_issued_before_ms[target.id]
    assert third_cutoff >= second_cutoff

    repeated_post = client.post(
        f"/api/admin/users/{target.id}/deactivate",
        headers=headers("user-admin"),
    )
    assert repeated_post.status_code == 200
    assert len(calls) == 4
    assert calls[-1]["active_after"] is False
    assert store.session_issued_before_ms[target.id] >= third_cutoff


def test_admin_deactivation_cannot_interleave_with_session_issuance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    target = store.users["user-jane"]
    target.email = "jane.session-race@local.invalid"
    target.auth_method = "local"
    password_checked = Event()
    allow_login_to_issue = Event()

    def blocked_password_check(user_id: str, password: str | None) -> bool:
        assert user_id == target.id
        assert password == "session-race-password"
        password_checked.set()
        assert allow_login_to_issue.wait(timeout=5)
        return True

    monkeypatch.setattr(store, "verify_password_credential", blocked_password_check)
    with ThreadPoolExecutor(max_workers=1) as executor:
        login_future = executor.submit(
            client.post,
            "/api/auth/login",
            json={
                "email": target.email,
                "password": "session-race-password",
                "auth_method": "local",
            },
        )
        assert password_checked.wait(timeout=5)
        try:
            deactivated = client.post(
                f"/api/admin/users/{target.id}/deactivate",
                headers=headers("user-admin"),
            )
            assert deactivated.status_code == 200
            assert target.active is False
            assert store.session_issued_before_ms[target.id] > 0
        finally:
            allow_login_to_issue.set()
        login_response = login_future.result(timeout=5)

    assert login_response.status_code == 401
    assert login_response.json() == {"detail": "Session is invalid or expired. Sign in again."}
    reactivate = client.patch(
        f"/api/admin/users/{target.id}",
        json={"active": True},
        headers=headers("user-admin"),
    )
    assert reactivate.status_code == 200
    assert target.active is True


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        (
            "PATCH",
            "/api/admin/users/user-jane",
            {"active": False, "display_name": "Must Not Change"},
        ),
        ("POST", "/api/admin/users/user-jane/deactivate", None),
        ("POST", "/api/admin/users/user-jane/sessions/revoke", None),
    ],
)
def test_admin_session_revocation_failure_is_503_before_any_mutation(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    store = get_store()
    before_user = store.users["user-jane"].model_dump(mode="json")
    before_watermarks = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)

    def unavailable(*_args: object, **_kwargs: object) -> int:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(store, "advance_user_session_watermark", unavailable)
    response = client.request(
        method,
        path,
        json=payload,
        headers=headers("user-admin"),
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "Session revocation is temporarily unavailable."}
    assert store.users["user-jane"].model_dump(mode="json") == before_user
    assert dict(store.session_issued_before_ms.items()) == before_watermarks
    assert len(store.audit_events) == before_audit_count


def test_admin_session_revocation_endpoint_obeys_user_policy_and_audits_sql_only() -> None:
    store = get_store()
    target = store.users["user-jane"]

    revoked = client.post(
        f"/api/admin/users/{target.id}/sessions/revoke",
        headers=headers("user-admin"),
    )
    assert revoked.status_code == 200
    payload = revoked.json()
    assert payload == {
        "status": "revoked",
        "user_id": target.id,
        "issued_before_ms": store.session_issued_before_ms[target.id],
    }
    assert target.active is True
    assert store.audit_events[-1].action == "admin.user_sessions_revoked"
    assert store.audit_events[-1].metadata == {"issued_before_ms": payload["issued_before_ms"]}

    regular_user = client.post(
        "/api/admin/users/user-casey/sessions/revoke",
        headers=headers("user-jane"),
    )
    assert regular_user.status_code == 403
    assert "user-casey" not in store.session_issued_before_ms

    owner_target = client.post(
        "/api/admin/users/user-owner/sessions/revoke",
        headers=headers("user-admin"),
    )
    assert owner_target.status_code == 403
    assert "user-owner" not in store.session_issued_before_ms

    store.users["user-outside-revoke"] = target.model_copy(
        update={
            "id": "user-outside-revoke",
            "tenant_id": "tenant-other",
            "email": "outside.revoke@example.com",
        }
    )
    cross_tenant = client.post(
        "/api/admin/users/user-outside-revoke/sessions/revoke",
        headers=headers("user-admin"),
    )
    assert cross_tenant.status_code == 403
    assert "user-outside-revoke" not in store.session_issued_before_ms

    owner_revoke = client.post(
        "/api/admin/users/user-outside-revoke/sessions/revoke",
        headers=headers("user-owner"),
    )
    assert owner_revoke.status_code == 200
    assert (
        owner_revoke.json()["issued_before_ms"]
        == store.session_issued_before_ms["user-outside-revoke"]
    )


def test_admin_analytics_reports_store_derived_counts() -> None:
    store = get_store()
    store.chat_threads["thread-analytics"] = ChatThread(
        id="thread-analytics",
        tenant_id="tenant-example",
        owner_user_id="user-jane",
        title="Analytics smoke",
        model_id="gpt-4o",
        group_id="group-litigation",
        pinned=False,
        updated_at="Just now",
        messages=[
            ChatMessage(id="msg-user", role="user", content="Hello", createdAt="Now"),
            ChatMessage(id="msg-assistant", role="assistant", content="Hi", createdAt="Now"),
        ],
    )

    response = client.get("/api/admin/analytics", headers=headers("user-admin"))
    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == "hybrid-application-store"
    assert payload["elasticCredentialsVisible"] is False
    usage = {item["label"]: item["value"] for item in payload["usage"]}
    assert usage["Chats"] == 1
    assert usage["Chat messages"] == 2
    assert usage["Active users"] == len(
        [user for user in store.tenant_visible_users_for(store.users["user-admin"]) if user.active]
    )
    assert "Requests" not in usage
    assert "Cost" not in usage


def test_tenant_scoped_user_lists_exclude_platform_owner_for_admins_and_owner() -> None:
    admin_users = client.get("/api/admin/users", headers=headers("user-admin"))
    assert admin_users.status_code == 200
    assert all(user["role"] != "PLATFORM_OWNER" for user in admin_users.json())
    assert {user["id"] for user in admin_users.json()} == {
        "user-admin",
        "user-jane",
        "user-casey",
        "user-drew",
        "user-maya",
    }

    owner_users = client.get("/api/admin/users", headers=headers("user-owner"))
    assert owner_users.status_code == 200
    assert all(user["role"] != "PLATFORM_OWNER" for user in owner_users.json())

    owner_bootstrap = client.get("/api/bootstrap", headers=headers("user-owner"))
    assert owner_bootstrap.status_code == 200
    owner_payload = owner_bootstrap.json()
    assert all(user["role"] != "PLATFORM_OWNER" for user in owner_payload["visibleUsers"])
    # The owner console directory keeps owner accounts; only tenant surfaces hide them.
    assert any(user["id"] == "user-owner" for user in owner_payload["users"])

    admin_bootstrap = client.get("/api/bootstrap", headers=headers("user-admin"))
    assert admin_bootstrap.status_code == 200
    admin_payload = admin_bootstrap.json()
    assert all(user["role"] != "PLATFORM_OWNER" for user in admin_payload["users"])
    assert all(user["role"] != "PLATFORM_OWNER" for user in admin_payload["visibleUsers"])


def test_tenant_admin_cannot_target_platform_owner_accounts() -> None:
    role_change = client.patch(
        "/api/admin/users/user-owner",
        json={"role": "USER"},
        headers=headers("user-admin"),
    )
    assert role_change.status_code == 403

    deactivate_patch = client.patch(
        "/api/admin/users/user-owner",
        json={"active": False},
        headers=headers("user-admin"),
    )
    assert deactivate_patch.status_code == 403

    deactivate_post = client.post(
        "/api/admin/users/user-owner/deactivate", headers=headers("user-admin")
    )
    assert deactivate_post.status_code == 403

    delete_response = client.delete("/api/admin/users/user-owner", headers=headers("user-admin"))
    assert delete_response.status_code == 403

    store = get_store()
    assert store.users["user-owner"].active is True
    assert store.users["user-owner"].role == "PLATFORM_OWNER"


def test_tenant_admin_cannot_create_or_promote_admin_roles() -> None:
    create_response = client.post(
        "/api/admin/users",
        json={
            "email": "admin.two@example.com",
            "display_name": "Admin Two",
            "role": "TENANT_ADMIN",
        },
        headers=headers("user-admin"),
    )
    assert create_response.status_code == 403

    promote_response = client.patch(
        "/api/admin/users/user-jane",
        json={"role": "TENANT_ADMIN"},
        headers=headers("user-admin"),
    )
    assert promote_response.status_code == 403


def test_user_identity_must_be_unique_for_create_and_update() -> None:
    duplicate_email = client.post(
        "/api/admin/users",
        json={
            "email": "Jane.Smith@Example.com",
            "display_name": "Duplicate Jane",
            "role": "USER",
            "group_ids": ["group-litigation"],
        },
        headers=headers("user-admin"),
    )
    assert duplicate_email.status_code == 409
    assert duplicate_email.json()["detail"] == "User email already exists."

    duplicate_entra = client.post(
        "/api/admin/users",
        json={
            "email": "unique.user@example.com",
            "display_name": "Duplicate Entra",
            "role": "USER",
            "entra_object_id": "ENTRA-USER-001",
            "group_ids": ["group-litigation"],
        },
        headers=headers("user-admin"),
    )
    assert duplicate_entra.status_code == 409
    assert duplicate_entra.json()["detail"] == "User Entra object ID already exists."

    update_duplicate = client.patch(
        "/api/admin/users/user-casey",
        json={"email": "jane.smith@example.com"},
        headers=headers("user-admin"),
    )
    assert update_duplicate.status_code == 409
    assert update_duplicate.json()["detail"] == "User email already exists."


def test_admin_deactivation_preserves_self_owner_and_last_admin_invariants() -> None:
    self_deactivate = client.post(
        "/api/admin/users/user-admin/deactivate", headers=headers("user-admin")
    )
    assert self_deactivate.status_code == 400
    assert self_deactivate.json()["detail"] == "You cannot deactivate your own account."

    owner_deactivate = client.post(
        "/api/admin/users/user-owner/deactivate", headers=headers("user-owner")
    )
    assert owner_deactivate.status_code == 400
    assert owner_deactivate.json()["detail"] == "You cannot deactivate your own account."

    first_admin = client.post(
        "/api/admin/users/user-drew/deactivate", headers=headers("user-owner")
    )
    assert first_admin.status_code == 200

    # Owners are administrators too: the last tenant admin is removable while
    # any active owner remains.
    last_admin = client.post(
        "/api/admin/users/user-admin/deactivate", headers=headers("user-owner")
    )
    assert last_admin.status_code == 200
    assert get_store().users["user-admin"].active is False


def test_store_guard_still_blocks_removing_the_final_administrator() -> None:
    """With every owner inactive, the sole remaining tenant admin is the last
    administrative account and the store refuses to deactivate it."""

    store = get_store()
    target = store.users["user-admin"]
    for user in store.users.values():
        if user.role == Role.PLATFORM_OWNER:
            user.active = False
        if user.role == Role.TENANT_ADMIN and user.tenant_id == target.tenant_id:
            user.active = user.id == target.id
    with pytest.raises(LastActiveAdministrativeAccountError):
        store.advance_user_session_watermark(
            target.id,
            target.tenant_id,
            reason="test-final-admin-guard",
            updated_by="user-owner",
            expected_user=target,
            expected_role=Role.TENANT_ADMIN,
            deactivate=True,
            preserve_last_active_admin=True,
        )
    assert store.users[target.id].active is True


@pytest.mark.parametrize("scope", ["platform", "tenant"])
def test_concurrent_admin_deactivation_atomically_preserves_last_active_account(
    monkeypatch: pytest.MonkeyPatch,
    scope: str,
) -> None:
    from app.routes import admin as admin_routes

    store = get_store()
    if scope == "platform":
        first = store.users["user-owner"]
        second = first.model_copy(
            deep=True,
            update={
                "id": "user-owner-concurrent",
                "email": "owner.concurrent@aperture.local",
                "display_name": "Concurrent Owner",
            },
        )
        store.users[second.id] = second
        requests = [(first.id, second), (second.id, first)]
        role = Role.PLATFORM_OWNER
        expected_status = 403
        expected_detail = "Administrator authorization changed. Retry the request."
    else:
        first = store.users["user-admin"]
        second = store.users["user-drew"]
        for user in store.users.values():
            if user.role == Role.TENANT_ADMIN and user.tenant_id == first.tenant_id:
                user.active = user.id in {first.id, second.id}
        requests = [("user-owner", first), ("user-owner", second)]
        role = Role.TENANT_ADMIN
        # The acting owner keeps the tenant administered, so neither request
        # trips the guard: both admins deactivate, even concurrently.
        expected_status = 200
        expected_detail = None

    both_passed_route_precheck = Barrier(2)
    original_assert = admin_routes._assert_deactivation_allowed
    prechecked_targets: set[str] = set()

    def synchronized_assert(actor, target, observed_store) -> None:  # type: ignore[no-untyped-def]
        original_assert(actor, target, observed_store)
        if target.id in {first.id, second.id} and target.id not in prechecked_targets:
            prechecked_targets.add(target.id)
            both_passed_route_precheck.wait(timeout=5)

    monkeypatch.setattr(admin_routes, "_assert_deactivation_allowed", synchronized_assert)
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            (
                target,
                executor.submit(
                    client.post,
                    f"/api/admin/users/{target.id}/deactivate",
                    headers=headers(actor_id),
                ),
            )
            for actor_id, target in requests
        ]
        results = [(target, future.result(timeout=5)) for target, future in futures]

    assert sorted(response.status_code for _, response in results) == sorted([200, expected_status])
    if expected_status == 200:
        for target, _response in results:
            assert target.active is False
            assert store.session_issued_before_ms[target.id] > before_cutoffs.get(target.id, 0)
        assert store.users["user-owner"].active is True
        assert len(store.audit_events) == before_audit_count + 2
    else:
        assert (
            sum(
                user.active
                for user in store.users.values()
                if user.role == role
                and (role == Role.PLATFORM_OWNER or user.tenant_id == first.tenant_id)
            )
            == 1
        )
        successful_target = next(
            target for target, response in results if response.status_code == 200
        )
        rejected_target, rejected_response = next(
            (target, response)
            for target, response in results
            if response.status_code == expected_status
        )
        assert successful_target.active is False
        assert store.session_issued_before_ms[successful_target.id] > before_cutoffs.get(
            successful_target.id, 0
        )
        assert rejected_target.active is True
        assert store.session_issued_before_ms.get(rejected_target.id) == before_cutoffs.get(
            rejected_target.id
        )
        assert rejected_response.json() == {"detail": expected_detail}
        assert len(store.audit_events) == before_audit_count + 1


@pytest.mark.parametrize("scope", ["platform", "tenant"])
def test_concurrent_role_demotion_atomically_preserves_last_active_account(
    monkeypatch: pytest.MonkeyPatch,
    scope: str,
) -> None:
    from app.routes import admin as admin_routes

    store = get_store()
    if scope == "platform":
        first = store.users["user-owner"]
        second = first.model_copy(
            deep=True,
            update={
                "id": "user-owner-role-race",
                "email": "owner.role.race@aperture.local",
                "display_name": "Role Race Owner",
            },
        )
        store.users[second.id] = second
        requests = [(first.id, second), (second.id, first)]
        guarded_role = Role.PLATFORM_OWNER
        expected_status = 403
        expected_detail = "Administrator authorization changed. Retry the request."
    else:
        first = store.users["user-admin"]
        second = store.users["user-drew"]
        for user in store.users.values():
            if user.role == Role.TENANT_ADMIN and user.tenant_id == first.tenant_id:
                user.active = user.id in {first.id, second.id}
        requests = [("user-owner", first), ("user-owner", second)]
        guarded_role = Role.TENANT_ADMIN
        # With the acting owner covering the tenant, neither demotion trips
        # the guard: both admins become users, even concurrently.
        expected_status = 200
        expected_detail = None

    both_passed_route_precheck = Barrier(2)
    original_assert = admin_routes._assert_role_change_allowed
    prechecked_targets: set[str] = set()

    def synchronized_assert(target, requested_role, observed_store) -> None:  # type: ignore[no-untyped-def]
        original_assert(target, requested_role, observed_store)
        if target.id in {first.id, second.id} and target.id not in prechecked_targets:
            prechecked_targets.add(target.id)
            both_passed_route_precheck.wait(timeout=5)

    monkeypatch.setattr(admin_routes, "_assert_role_change_allowed", synchronized_assert)
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            (
                target,
                executor.submit(
                    client.patch,
                    f"/api/admin/users/{target.id}",
                    json={"role": "USER"},
                    headers=headers(actor_id),
                ),
            )
            for actor_id, target in requests
        ]
        results = [(target, future.result(timeout=5)) for target, future in futures]

    assert sorted(response.status_code for _, response in results) == sorted([200, expected_status])
    if expected_status == 200:
        for target, _response in results:
            assert target.role == Role.USER
            assert store.session_issued_before_ms[target.id] > before_cutoffs.get(target.id, 0)
        new_audits = list(store.audit_events)[before_audit_count:]
        assert sorted(event.target for event in new_audits) == sorted([first.id, second.id])
        assert {event.action for event in new_audits} == {"admin.user_updated"}
    else:
        assert (
            sum(
                user.active
                for user in store.users.values()
                if user.role == guarded_role
                and (guarded_role == Role.PLATFORM_OWNER or user.tenant_id == first.tenant_id)
            )
            == 1
        )
        successful_target = next(
            target for target, response in results if response.status_code == 200
        )
        rejected_target, rejected_response = next(
            (target, response)
            for target, response in results
            if response.status_code == expected_status
        )
        assert successful_target.role == Role.USER
        if scope == "platform":
            assert successful_target.tenant_id == "tenant-example"
        assert store.session_issued_before_ms[successful_target.id] > before_cutoffs.get(
            successful_target.id, 0
        )
        assert rejected_target.role == guarded_role
        assert store.session_issued_before_ms.get(rejected_target.id) == before_cutoffs.get(
            rejected_target.id
        )
        assert rejected_response.json() == {"detail": expected_detail}
        new_audits = list(store.audit_events)[before_audit_count:]
        assert [(event.action, event.target) for event in new_audits] == [
            ("admin.user_updated", successful_target.id)
        ]


def test_role_and_tenant_scope_changes_revoke_old_sessions() -> None:
    store = get_store()
    target = store.users["user-jane"]
    secret = get_settings().secret_key
    role_token, _ = store.issue_session_token_for_user(target, secret, 3600)

    role_change = client.patch(
        f"/api/admin/users/{target.id}",
        json={"role": "POWER_USER"},
        headers=headers("user-admin"),
    )
    assert role_change.status_code == 200
    role_cutoff = store.session_issued_before_ms[target.id]
    assert (
        client.get("/api/bootstrap", headers={"x-aperture-session": role_token}).status_code == 401
    )

    tenant_token, _ = store.issue_session_token_for_user(target, secret, 3600)
    source_tenant = store.tenants["tenant-example"]
    destination_tenant = source_tenant.model_copy(
        deep=True,
        update={
            "id": "tenant-session-scope",
            "name": "Session Scope",
            "slug": "session-scope",
            "custom_domain": None,
        },
    )
    store.tenants[destination_tenant.id] = destination_tenant
    tenant_change = client.patch(
        f"/api/admin/users/{target.id}",
        json={"tenant_id": destination_tenant.id},
        headers=headers("user-owner"),
    )
    assert tenant_change.status_code == 200
    assert tenant_change.json()["tenant_id"] == destination_tenant.id
    tenant_cutoff = store.session_issued_before_ms[target.id]
    assert tenant_cutoff > role_cutoff
    assert (
        client.get("/api/bootstrap", headers={"x-aperture-session": tenant_token}).status_code
        == 401
    )

    current_token, _ = store.issue_session_token_for_user(target, secret, 3600)
    assert (
        client.get("/api/bootstrap", headers={"x-aperture-session": current_token}).status_code
        == 200
    )


def test_role_change_revocation_failure_is_mutation_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    target = store.users["user-jane"]
    before_user = target.model_dump(mode="json")
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)

    def unavailable(*_args: object, **_kwargs: object) -> int:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(
        store.application_state_repository,
        "advance_session_issued_before_ms_strict",
        unavailable,
    )
    response = client.patch(
        f"/api/admin/users/{target.id}",
        json={"role": "POWER_USER", "display_name": "Must Not Change"},
        headers=headers("user-admin"),
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "Session revocation is temporarily unavailable."}
    assert target.model_dump(mode="json") == before_user
    assert dict(store.session_issued_before_ms.items()) == before_cutoffs
    assert len(store.audit_events) == before_audit_count


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        (
            "PATCH",
            "/api/admin/users/user-jane",
            {"active": False, "display_name": "Must Not Change"},
        ),
        ("POST", "/api/admin/users/user-jane/deactivate", None),
        ("POST", "/api/admin/users/user-jane/sessions/revoke", None),
    ],
)
def test_admin_security_mutations_reject_in_place_scope_change_after_authorization(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    from app.routes import admin as admin_routes

    store = get_store()
    target = store.users["user-jane"]
    original_assert = admin_routes.assert_can_modify_user
    authorized = Event()
    allow_mutation = Event()

    def blocked_assert(*args: object, **kwargs: object) -> None:
        original_assert(*args, **kwargs)
        authorized.set()
        assert allow_mutation.wait(timeout=5)

    monkeypatch.setattr(admin_routes, "assert_can_modify_user", blocked_assert)
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)
    original_display_name = target.display_name

    with ThreadPoolExecutor(max_workers=1) as executor:
        response_future = executor.submit(
            client.request,
            method,
            path,
            json=payload,
            headers=headers("user-admin"),
        )
        assert authorized.wait(timeout=5)
        with store._store_lock:
            target.role = Role.PLATFORM_OWNER
            target.tenant_id = None
            target.group_ids = []
        allow_mutation.set()
        response = response_future.result(timeout=5)

    assert response.status_code == 403
    assert target.role == Role.PLATFORM_OWNER
    assert target.tenant_id is None
    assert target.active is True
    assert target.display_name == original_display_name
    assert dict(store.session_issued_before_ms.items()) == before_cutoffs
    assert len(store.audit_events) == before_audit_count


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        (
            "PATCH",
            "/api/admin/users/user-jane",
            {"active": False, "display_name": "Must Not Change"},
        ),
        ("POST", "/api/admin/users/user-jane/deactivate", None),
        ("POST", "/api/admin/users/user-jane/sessions/revoke", None),
        ("DELETE", "/api/admin/users/user-jane", None),
    ],
)
def test_admin_lifecycle_rejects_actor_deactivated_after_initial_authorization(
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    from app.routes import admin as admin_routes

    store = get_store()
    actor = store.users["user-admin"]
    target = store.users["user-jane"]
    authorized = Event()
    allow_locked_recheck = Event()
    if method == "DELETE":
        original_assert = admin_routes._assert_user_delete_allowed

        def blocked_assert(*args: object, **kwargs: object) -> None:
            original_assert(*args, **kwargs)
            authorized.set()
            assert allow_locked_recheck.wait(timeout=5)

        monkeypatch.setattr(admin_routes, "_assert_user_delete_allowed", blocked_assert)
    else:
        original_assert = admin_routes.assert_can_modify_user

        def blocked_assert(*args: object, **kwargs: object) -> None:
            original_assert(*args, **kwargs)
            authorized.set()
            assert allow_locked_recheck.wait(timeout=5)

        monkeypatch.setattr(admin_routes, "assert_can_modify_user", blocked_assert)

    before_target = target.model_dump(mode="json")
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)
    with ThreadPoolExecutor(max_workers=1) as executor:
        response_future = executor.submit(
            client.request,
            method,
            path,
            json=payload,
            headers=headers(actor.id),
        )
        assert authorized.wait(timeout=5)
        with store._store_lock:
            actor.active = False
        allow_locked_recheck.set()
        response = response_future.result(timeout=5)

    assert response.status_code == 403
    assert response.json() == {"detail": "Administrator authorization changed. Retry the request."}
    assert target.model_dump(mode="json") == before_target
    assert dict(store.session_issued_before_ms.items()) == before_cutoffs
    assert len(store.audit_events) == before_audit_count


def test_admin_update_rechecks_unique_identity_inside_mutation_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.routes import admin as admin_routes

    store = get_store()
    target = store.users["user-jane"]
    original_assert = admin_routes._assert_unique_user_identity
    precheck_complete = Event()
    allow_locked_recheck = Event()
    assertion_calls = 0

    def blocked_assert(*args: object, **kwargs: object) -> None:
        nonlocal assertion_calls
        original_assert(*args, **kwargs)
        assertion_calls += 1
        if assertion_calls == 1:
            precheck_complete.set()
            assert allow_locked_recheck.wait(timeout=5)

    monkeypatch.setattr(admin_routes, "_assert_unique_user_identity", blocked_assert)
    requested_email = "race.unique@example.com"
    before_target = target.model_dump(mode="json")
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)
    with ThreadPoolExecutor(max_workers=1) as executor:
        response_future = executor.submit(
            client.patch,
            f"/api/admin/users/{target.id}",
            json={"email": requested_email},
            headers=headers("user-admin"),
        )
        assert precheck_complete.wait(timeout=5)
        with store._store_lock:
            store.users["user-identity-race"] = target.model_copy(
                deep=True,
                update={"id": "user-identity-race", "email": requested_email},
            )
        allow_locked_recheck.set()
        response = response_future.result(timeout=5)

    assert response.status_code == 409
    assert response.json() == {"detail": "User email already exists."}
    assert target.model_dump(mode="json") == before_target
    assert dict(store.session_issued_before_ms.items()) == before_cutoffs
    assert len(store.audit_events) == before_audit_count


@pytest.mark.parametrize("final_active", [True, False])
def test_scope_transition_exposes_group_and_active_state_only_after_atomic_commit(
    monkeypatch: pytest.MonkeyPatch,
    final_active: bool,
) -> None:
    store = get_store()
    target = store.users["user-jane"]
    source_tenant = store.tenants["tenant-example"]
    destination_tenant = source_tenant.model_copy(
        deep=True,
        update={
            "id": f"tenant-atomic-scope-{str(final_active).lower()}",
            "name": "Atomic Scope",
            "slug": f"atomic-scope-{str(final_active).lower()}",
            "custom_domain": None,
        },
    )
    store.tenants[destination_tenant.id] = destination_tenant
    store.ensure_default_user_group()
    destination_group = store.default_group_for_tenant(destination_tenant.id)
    assert destination_group is not None
    original_advance = store.application_state_repository.advance_session_issued_before_ms_strict
    cutoff_written = Event()
    allow_scope_commit = Event()

    def blocked_advance(*args: object, **kwargs: object) -> int:
        advanced = original_advance(*args, **kwargs)
        cutoff_written.set()
        assert allow_scope_commit.wait(timeout=5)
        return advanced

    monkeypatch.setattr(
        store.application_state_repository,
        "advance_session_issued_before_ms_strict",
        blocked_advance,
    )
    original_issue = store.issue_session_token_for_user
    issuance_attempted = Event()

    def observed_issue(*args: object, **kwargs: object) -> tuple[str, int]:
        issuance_attempted.set()
        return original_issue(*args, **kwargs)

    monkeypatch.setattr(store, "issue_session_token_for_user", observed_issue)
    secret = get_settings().secret_key

    with ThreadPoolExecutor(max_workers=2) as executor:
        transition_future = executor.submit(
            client.patch,
            f"/api/admin/users/{target.id}",
            json={"tenant_id": destination_tenant.id, "active": final_active},
            headers=headers("user-owner"),
        )
        assert cutoff_written.wait(timeout=5)
        issuance_future = executor.submit(
            store.issue_session_token_for_user,
            target,
            secret,
            3600,
        )
        assert issuance_attempted.wait(timeout=5)
        assert issuance_future.done() is False
        allow_scope_commit.set()
        transition_response = transition_future.result(timeout=5)
        if final_active:
            token, _ = issuance_future.result(timeout=5)
            assert (
                client.get("/api/bootstrap", headers={"x-aperture-session": token}).status_code
                == 200
            )
        else:
            with pytest.raises(SessionUserStateError):
                issuance_future.result(timeout=5)

    assert transition_response.status_code == 200
    assert target.tenant_id == destination_tenant.id
    assert target.group_ids == [destination_group.id]
    assert target.active is final_active


def test_tenant_admin_deletes_regular_user_and_owned_runtime_state() -> None:
    store = get_store()
    store.chat_threads["thread-jane-delete"] = ChatThread(
        id="thread-jane-delete",
        tenant_id="tenant-example",
        owner_user_id="user-jane",
        title="To be removed",
        model_id="gpt-4o",
        group_id="group-litigation",
        pinned=False,
        updated_at="Just now",
        messages=[ChatMessage(id="msg-1", role="user", content="hello", createdAt="Now")],
    )
    store.password_credentials["user-jane"] = "argon2-hash-placeholder"

    delete_response = client.delete("/api/admin/users/user-jane", headers=headers("user-admin"))
    assert delete_response.status_code == 200
    assert delete_response.json() == {"status": "deleted", "user_id": "user-jane"}

    store = get_store()
    assert "user-jane" not in store.users
    assert "thread-jane-delete" not in store.chat_threads
    assert "user-jane" not in store.password_credentials
    assert store.session_issued_before_ms["user-jane"] > 0
    assert store.audit_events[-1].action == "admin.user_deleted"


def test_user_delete_exact_binding_rejects_aba_replacement_before_any_purge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.repositories import review_deps

    store = get_store()
    target = store.users["user-jane"]
    replacement = target.model_copy(
        deep=True,
        update={
            "email": "replacement.jane@example.com",
            "display_name": "Replacement Jane",
            "role": Role.PLATFORM_OWNER,
            "tenant_id": None,
            "group_ids": [],
        },
    )
    thread = ChatThread(
        id="thread-jane-aba",
        tenant_id=target.tenant_id,
        owner_user_id=target.id,
        title="Must survive stale deletion",
        model_id="gpt-4o",
        group_id="group-litigation",
        pinned=False,
        updated_at="Just now",
        messages=[ChatMessage(id="msg-aba", role="user", content="keep", createdAt="Now")],
    )
    store.chat_threads[thread.id] = thread
    store.password_credentials[target.id] = "replacement-credential"
    store.temporary_password_user_ids.add(target.id)
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)
    original_delete = store.delete_user_account
    delete_authorized = Event()
    allow_exact_bound_delete = Event()
    purge_calls: list[str] = []

    def blocked_delete(user_id: str, **kwargs: object) -> dict[str, int]:
        assert kwargs["expected_user"] is target
        delete_authorized.set()
        assert allow_exact_bound_delete.wait(timeout=5)
        return original_delete(user_id, **kwargs)

    monkeypatch.setattr(store, "delete_user_account", blocked_delete)
    monkeypatch.setattr(
        review_deps,
        "purge_review_owner",
        lambda user_id: purge_calls.append(f"review:{user_id}") or 0,
    )
    monkeypatch.setattr(
        store.application_state_repository,
        "purge_a5_user",
        lambda *_args, **_kwargs: purge_calls.append("application") or {},
    )
    original_save = store.save_runtime_state

    def observed_save(*args: object, **kwargs: object) -> None:
        purge_calls.append("json-save")
        original_save(*args, **kwargs)

    monkeypatch.setattr(store, "save_runtime_state", observed_save)

    with ThreadPoolExecutor(max_workers=1) as executor:
        response_future = executor.submit(
            client.delete,
            f"/api/admin/users/{target.id}",
            headers=headers("user-admin"),
        )
        assert delete_authorized.wait(timeout=5)
        store.users[target.id] = replacement
        allow_exact_bound_delete.set()
        response = response_future.result(timeout=5)

    assert response.status_code == 409
    assert response.json() == {
        "detail": "The user account changed while it was being deleted. Retry the request."
    }
    assert store.users[target.id] is replacement
    assert store.chat_threads[thread.id].model_dump(mode="json") == thread.model_dump(mode="json")
    assert store.password_credentials[target.id] == "replacement-credential"
    assert target.id in store.temporary_password_user_ids
    assert dict(store.session_issued_before_ms.items()) == before_cutoffs
    assert len(store.audit_events) == before_audit_count
    assert purge_calls == []


def test_user_delete_rejects_in_place_scope_change_after_authorization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.repositories import review_deps

    store = get_store()
    target = store.users["user-jane"]
    from app.routes import admin as admin_routes

    original_assert = admin_routes._assert_user_delete_allowed
    delete_authorized = Event()
    allow_locked_recheck = Event()
    assertion_calls = 0
    purge_calls: list[str] = []

    def blocked_assert(actor, observed_target) -> None:  # type: ignore[no-untyped-def]
        nonlocal assertion_calls
        original_assert(actor, observed_target)
        assertion_calls += 1
        if assertion_calls == 1:
            delete_authorized.set()
            assert allow_locked_recheck.wait(timeout=5)

    monkeypatch.setattr(admin_routes, "_assert_user_delete_allowed", blocked_assert)
    monkeypatch.setattr(
        review_deps,
        "purge_review_owner",
        lambda user_id: purge_calls.append(f"review:{user_id}") or 0,
    )
    monkeypatch.setattr(
        store.application_state_repository,
        "purge_a5_user",
        lambda *_args, **_kwargs: purge_calls.append("application") or {},
    )
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)

    with ThreadPoolExecutor(max_workers=1) as executor:
        response_future = executor.submit(
            client.delete,
            f"/api/admin/users/{target.id}",
            headers=headers("user-admin"),
        )
        assert delete_authorized.wait(timeout=5)
        with store._store_lock:
            target.role = Role.PLATFORM_OWNER
            target.tenant_id = None
            target.group_ids = []
        allow_locked_recheck.set()
        response = response_future.result(timeout=5)

    assert response.status_code == 403
    assert response.json() == {
        "detail": "This service-managed account cannot be deleted from the Admin Console."
    }
    assert store.users[target.id] is target
    assert target.role == Role.PLATFORM_OWNER
    assert target.tenant_id is None
    assert target.active is True
    assert dict(store.session_issued_before_ms.items()) == before_cutoffs
    assert len(store.audit_events) == before_audit_count
    assert purge_calls == []


def test_hard_delete_allows_last_active_tenant_admin_while_owner_remains(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.repositories import review_deps

    store = get_store()
    target = store.users["user-admin"]
    for user in store.users.values():
        if user.role == Role.TENANT_ADMIN and user.tenant_id == target.tenant_id:
            user.active = user.id == target.id
    before_audit_count = len(store.audit_events)
    purge_calls: list[str] = []
    monkeypatch.setattr(
        review_deps,
        "purge_review_owner",
        lambda user_id: purge_calls.append(f"review:{user_id}") or 0,
    )
    monkeypatch.setattr(
        store.application_state_repository,
        "purge_a5_user",
        lambda *_args, **_kwargs: purge_calls.append("application") or {},
    )

    response = client.delete(f"/api/admin/users/{target.id}", headers=headers("user-owner"))

    # Owners administer every tenant, so deleting the sole tenant admin is a
    # real deletion — record gone, purges run, audit written.
    assert response.status_code == 200
    assert response.json() == {"status": "deleted", "user_id": target.id}
    assert target.id not in store.users
    assert purge_calls
    new_audits = list(store.audit_events)[before_audit_count:]
    assert ("admin.user_deleted", target.id) in [
        (event.action, event.target) for event in new_audits
    ]


def test_hard_delete_revocation_failure_precedes_review_a5_and_json_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.repositories import review_deps

    store = get_store()
    target = store.users["user-jane"]
    before_user = target.model_dump(mode="json")
    before_cutoffs = dict(store.session_issued_before_ms.items())
    before_audit_count = len(store.audit_events)
    purge_calls: list[str] = []

    def unavailable(*_args: object, **_kwargs: object) -> int:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(
        store.application_state_repository,
        "advance_session_issued_before_ms_strict",
        unavailable,
    )
    monkeypatch.setattr(
        review_deps,
        "purge_review_owner",
        lambda user_id: purge_calls.append(f"review:{user_id}") or 0,
    )
    monkeypatch.setattr(
        store.application_state_repository,
        "purge_a5_user",
        lambda *_args, **_kwargs: purge_calls.append("application") or {},
    )
    response = client.delete(f"/api/admin/users/{target.id}", headers=headers("user-admin"))

    assert response.status_code == 503
    assert response.json() == {"detail": "Session revocation is temporarily unavailable."}
    assert target.model_dump(mode="json") == before_user
    assert dict(store.session_issued_before_ms.items()) == before_cutoffs
    assert len(store.audit_events) == before_audit_count
    assert purge_calls == []


def test_user_deletion_role_boundaries() -> None:
    # Tenant admins cannot delete other admins.
    admin_deletes_admin = client.delete("/api/admin/users/user-drew", headers=headers("user-admin"))
    assert admin_deletes_admin.status_code == 403

    # Tenant admins cannot delete users outside their tenant.
    store = get_store()
    seed_tenant("tenant-other")
    store.users["user-outside"] = store.users["user-jane"].model_copy(
        update={
            "id": "user-outside",
            "tenant_id": "tenant-other",
            "email": "outside@example.com",
            "group_ids": [],
        }
    )
    cross_tenant = client.delete("/api/admin/users/user-outside", headers=headers("user-admin"))
    assert cross_tenant.status_code == 403

    # Nobody deletes their own account through this route.
    self_delete = client.delete("/api/admin/users/user-admin", headers=headers("user-admin"))
    assert self_delete.status_code == 400

    # Owners can delete tenant admins and users.
    owner_deletes_admin = client.delete("/api/admin/users/user-drew", headers=headers("user-owner"))
    assert owner_deletes_admin.status_code == 200
    owner_deletes_user = client.delete("/api/admin/users/user-casey", headers=headers("user-owner"))
    assert owner_deletes_user.status_code == 200

    store = get_store()
    assert "user-drew" not in store.users
    assert "user-casey" not in store.users


def test_patching_one_group_permission_leaves_the_others_alone() -> None:
    # These three default to on, so a partial update that forgets them would
    # turn them back on and hand the group access an admin had removed.
    created = client.post(
        "/api/admin/groups",
        json={
            "id": "group-partial",
            "name": "Partial Update",
            "permissions": {
                "knowledge_access": False,
                "tools_access": False,
                "agent_authoring": False,
            },
        },
        headers=headers("user-admin"),
    )
    assert created.status_code == 201
    before = created.json()["permissions"]
    assert before["knowledge_access"] is False
    assert before["tools_access"] is False
    assert before["agent_authoring"] is False

    patched = client.patch(
        "/api/admin/groups/group-partial",
        json={"permissions": {"chat_access": False}},
        headers=headers("user-admin"),
    )
    assert patched.status_code == 200
    after = patched.json()["permissions"]
    assert after["chat_access"] is False
    assert after["knowledge_access"] is False
    assert after["tools_access"] is False
    assert after["agent_authoring"] is False


def test_group_user_count_reflects_real_membership_not_the_creation_value() -> None:
    created = client.post(
        "/api/admin/groups",
        json={"id": "group-counted", "name": "Counted"},
        headers=headers("user-admin"),
    )
    assert created.status_code == 201
    assert created.json()["user_count"] == 0

    added = client.patch(
        "/api/admin/users/user-jane",
        json={"group_ids": ["group-counted"]},
        headers=headers("user-admin"),
    )
    assert added.status_code == 200

    listed = client.get("/api/admin/groups", headers=headers("user-admin"))
    assert listed.status_code == 200
    counted = next(group for group in listed.json() if group["id"] == "group-counted")
    # An admin reads this number before changing a permission, so a stale zero
    # would understate the blast radius of that change.
    assert counted["user_count"] == 1


def test_tenant_admin_manages_groups_and_deleting_group_cleans_acl_memberships() -> None:
    create_response = client.post(
        "/api/admin/groups",
        json={
            "id": "group-discovery",
            "name": "Discovery",
            "entra_object_id": "entra-group-discovery",
            "permissions": {"agents_access": True},
        },
        headers=headers("user-admin"),
    )
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["tenant_id"] == "tenant-example"
    assert created["name"] == "Discovery"

    bulk_response = client.post(
        "/api/admin/groups/bulk",
        json={
            "groups": [
                {"name": "Trial Team", "entra_object_id": "entra-group-trial"},
                {"name": "Client Intake", "entra_object_id": "entra-group-intake"},
            ]
        },
        headers=headers("user-admin"),
    )
    assert bulk_response.status_code == 201
    assert [group["name"] for group in bulk_response.json()] == ["Trial Team", "Client Intake"]

    patch_response = client.patch(
        "/api/admin/groups/group-discovery",
        json={"permissions": {"agents_access": False, "box_knowledge": True}},
        headers=headers("user-admin"),
    )
    assert patch_response.status_code == 200
    assert "box_knowledge" not in patch_response.json()["permissions"]
    assert patch_response.json()["permissions"]["agents_access"] is False

    store = get_store()
    store.users["user-jane"].group_ids.append("group-discovery")
    store.models["gpt-4o"].group_ids.append("group-discovery")
    store.knowledge_configs["knowledge-litigation-playbook"].acl_group_ids.append("group-discovery")
    store.tool_configs["tool-agent-workflow"].allowed_group_ids.append("group-discovery")

    delete_response = client.delete(
        "/api/admin/groups/group-discovery", headers=headers("user-admin")
    )
    assert delete_response.status_code == 200
    assert "group-discovery" not in store.groups
    assert "group-discovery" not in store.users["user-jane"].group_ids
    assert "group-discovery" not in store.models["gpt-4o"].group_ids
    assert (
        "group-discovery"
        not in store.knowledge_configs["knowledge-litigation-playbook"].acl_group_ids
    )
    assert "group-discovery" not in store.tool_configs["tool-agent-workflow"].allowed_group_ids

    bulk_delete_response = client.post(
        "/api/admin/groups/bulk-delete",
        json={"group_ids": ["group-trial-team", "group-client-intake"]},
        headers=headers("user-admin"),
    )
    assert bulk_delete_response.status_code == 200
    assert bulk_delete_response.json()["deleted_group_ids"] == [
        "group-trial-team",
        "group-client-intake",
    ]


def test_default_user_group_is_seeded_protected_and_used_for_fast_provisioning() -> None:
    store = get_store()
    default_group = store.groups[DEFAULT_USER_GROUP_ID]
    assert default_group.default_group is True
    assert default_group.permissions == {
        "chat_access": True,
        "knowledge_access": True,
        "agents_access": True,
        "tools_access": True,
        "api_access": False,
        "hermes_companion": False,
        "agent_authoring": False,
        "knowledge_authoring": False,
        "tool_authoring": False,
        "memory_access": True,
    }

    groups_response = client.get("/api/admin/groups", headers=headers("user-admin"))
    assert groups_response.status_code == 200
    assert any(
        group["id"] == DEFAULT_USER_GROUP_ID and group["default_group"]
        for group in groups_response.json()
    )

    delete_response = client.delete(
        f"/api/admin/groups/{DEFAULT_USER_GROUP_ID}", headers=headers("user-admin")
    )
    assert delete_response.status_code == 409
    assert "protected" in delete_response.json()["detail"]

    bulk_delete_response = client.post(
        "/api/admin/groups/bulk-delete",
        json={"group_ids": [DEFAULT_USER_GROUP_ID]},
        headers=headers("user-admin"),
    )
    assert bulk_delete_response.status_code == 409
    assert DEFAULT_USER_GROUP_ID in store.groups

    created_response = client.post(
        "/api/admin/users",
        json={
            "id": "user-default-created",
            "email": "default.created@example.com",
            "display_name": "Default Created",
            "role": "USER",
            "group_ids": [],
        },
        headers=headers("user-admin"),
    )
    assert created_response.status_code == 201
    assert created_response.json()["group_ids"] == [DEFAULT_USER_GROUP_ID]

    store.platform_settings.default_user_group_enabled = False
    policy_off_response = client.post(
        "/api/admin/users",
        json={
            "id": "user-no-default-created",
            "email": "no.default.created@example.com",
            "display_name": "No Default Created",
            "role": "USER",
            "group_ids": [],
        },
        headers=headers("user-admin"),
    )
    assert policy_off_response.status_code == 201
    assert policy_off_response.json()["group_ids"] == []


def test_admin_model_access_waterfalls_from_platform_enabled_models_to_group_grants() -> None:
    admin_catalog_response = client.get("/api/admin/model-access", headers=headers("user-admin"))
    assert admin_catalog_response.status_code == 200
    admin_model_ids = {model["id"] for model in admin_catalog_response.json()}
    assert "o3-mini" not in admin_model_ids
    assert "openrouter-openai-gpt-5-5" in admin_model_ids

    grant_response = client.patch(
        "/api/admin/model-access/openrouter-openai-gpt-5-5",
        json={"group_ids": ["group-litigation"]},
        headers=headers("user-admin"),
    )
    assert grant_response.status_code == 200
    assert grant_response.json()["group_ids"] == ["group-litigation"]
    assert get_store().models["openrouter-openai-gpt-5-5"].tenant_restricted is True

    disabled_response = client.patch(
        "/api/admin/model-access/o3-mini",
        json={"group_ids": ["group-litigation"]},
        headers=headers("user-admin"),
    )
    assert disabled_response.status_code == 403
    assert disabled_response.json()["detail"] == "Model is disabled by platform policy."


def test_admin_model_access_sync_does_not_enable_new_provider_catalog_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed_openrouter_key("or-live-secret")

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        assert provider.id == "provider-openrouter"
        assert secret_value == "or-live-secret"
        return (
            [
                DiscoveredModel("openai/gpt-5.5", "OpenAI: GPT-5.5", 1_000_000, "Owner-enabled"),
                DiscoveredModel(
                    "openai/gpt-4o-mini", "OpenAI: GPT-4o mini", 128000, "Owner-enabled"
                ),
                DiscoveredModel(
                    "anthropic/claude-3.5-sonnet",
                    "Anthropic: Claude 3.5 Sonnet",
                    200000,
                    "Owner-enabled",
                ),
            ],
            "openrouter:/models/user",
        )

    monkeypatch.setattr("app.routes.admin.discover_provider_models", fake_discovery)

    sync_response = client.post("/api/admin/model-access-sync", headers=headers("user-admin"))
    assert sync_response.status_code == 200
    synced_model_ids = {model["id"] for model in sync_response.json()}
    new_model_id = "provider-openrouter-anthropic-claude-3-5-sonnet"
    assert new_model_id not in synced_model_ids
    assert "o3-mini" not in synced_model_ids
    store = get_store()
    assert new_model_id not in store.models
    assert store.providers["provider-openrouter"].model_count == 3
    assert store.providers["provider-openrouter"].enabled_model_count == 3


def test_admin_model_access_grant_cannot_enable_missing_openrouter_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed_openrouter_key("or-live-secret")
    model_id = "provider-openrouter-anthropic-claude-opus-latest"
    assert model_id not in get_store().models

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        assert provider.id == "provider-openrouter"
        assert secret_value == "or-live-secret"
        return (
            [
                DiscoveredModel("openai/gpt-5.5", "OpenAI: GPT-5.5", 1_000_000, "Owner-enabled"),
                DiscoveredModel(
                    "openai/gpt-4o-mini", "OpenAI: GPT-4o mini", 128000, "Owner-enabled"
                ),
                DiscoveredModel(
                    "~anthropic/claude-opus-latest",
                    "Anthropic: Claude Opus Latest",
                    1_000_000,
                    "Owner-enabled",
                ),
            ],
            "openrouter:/models/user",
        )

    monkeypatch.setattr("app.routes.admin.discover_provider_models", fake_discovery)

    grant_response = client.patch(
        f"/api/admin/model-access/{model_id}",
        json={"group_ids": ["group-litigation", "group-finance"]},
        headers=headers("user-admin"),
    )
    assert grant_response.status_code == 404
    assert grant_response.json()["detail"] == "Unknown model."
    assert model_id not in get_store().models


def test_admin_model_access_grant_cannot_enable_missing_non_openrouter_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed_provider_key("provider-openai", "sk-openai-test", "key-openai-primary", "OpenAI Primary")
    model_id = "provider-openai-gpt-4-2"
    assert model_id not in get_store().models

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        if provider.id == "provider-openai":
            assert secret_value == "sk-openai-test"
            return ([DiscoveredModel("gpt-4.2", "GPT-4.2", 128000, "Provider catalog")], "models")
        return ([], "openrouter:/models/user" if provider.kind == "openrouter" else "models")

    monkeypatch.setattr("app.routes.admin.discover_provider_models", fake_discovery)

    grant_response = client.patch(
        f"/api/admin/model-access/{model_id}",
        json={"group_ids": ["group-corporate"]},
        headers=headers("user-admin"),
    )
    assert grant_response.status_code == 404
    assert grant_response.json()["detail"] == "Unknown model."
    assert model_id not in get_store().models


def test_bootstrap_model_catalog_matches_owner_admin_user_waterfall() -> None:
    owner_response = client.get("/api/bootstrap", headers=headers("user-owner"))
    assert owner_response.status_code == 200
    owner_model_ids = {model["id"] for model in owner_response.json()["models"]}
    assert "o3-mini" in owner_model_ids

    admin_response = client.get("/api/bootstrap", headers=headers("user-admin"))
    assert admin_response.status_code == 200
    admin_model_ids = {model["id"] for model in admin_response.json()["models"]}
    assert "o3-mini" not in admin_model_ids
    assert "openrouter-openai-gpt-5-5" not in admin_model_ids

    admin_management_response = client.get("/api/admin/model-access", headers=headers("user-admin"))
    assert admin_management_response.status_code == 200
    admin_management_model_ids = {model["id"] for model in admin_management_response.json()}
    assert "o3-mini" not in admin_management_model_ids
    assert "openrouter-openai-gpt-5-5" in admin_management_model_ids

    user_response = client.get("/api/bootstrap", headers=headers("user-jane"))
    assert user_response.status_code == 200
    user_model_ids = {model["id"] for model in user_response.json()["models"]}
    assert "gpt-4o" in user_model_ids
    assert "openrouter-openai-gpt-5-5" not in user_model_ids


def test_tenant_admin_chat_runtime_cannot_use_ungranted_model() -> None:
    response = client.post(
        "/api/chat/complete",
        json={
            "model": "openrouter-openai-gpt-5-5",
            "messages": [{"role": "user", "content": "Hello"}],
        },
        headers=headers("user-admin"),
    )
    assert response.status_code == 403
    assert (
        response.json()["detail"]
        == "Model access is restricted by platform, tenant, group, or explicit deny policy."
    )


def test_platform_owner_can_create_provider_and_model_then_update_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_response = client.post(
        "/api/platform/providers",
        json={
            "id": "provider-test",
            "name": "Test Provider",
            "kind": "openai-compatible",
            "region": "Local",
            "base_url": "https://models.example.com/v1",
            "auth_type": "bearer",
            "auth_metadata": {"header_name": "Authorization", "audience": "legal-ai"},
        },
        headers=headers("user-owner"),
    )
    assert provider_response.status_code == 201
    created_provider = provider_response.json()
    assert created_provider["base_url"] == "https://models.example.com/v1"
    assert created_provider["auth_type"] == "bearer"
    assert created_provider["auth_metadata"] == {
        "header_name": "Authorization",
        "audience": "legal-ai",
    }

    provider_update_response = client.patch(
        "/api/platform/providers/provider-test",
        json={
            "region": "Private Cloud",
            "base_url": "https://private-models.example.com/v1",
            "auth_metadata": {"header_name": "X-API-Key"},
            "connected": False,
        },
        headers=headers("user-owner"),
    )
    assert provider_update_response.status_code == 200
    updated_provider = provider_update_response.json()
    assert updated_provider["connected"] is False
    assert updated_provider["base_url"] == "https://private-models.example.com/v1"
    assert updated_provider["auth_metadata"] == {"header_name": "X-API-Key"}

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        assert provider.id == "provider-test"
        assert secret_value == "test-provider-secret-123"
        return (
            [
                DiscoveredModel(
                    "test-provider-small", "Test Provider Small", 128000, "Runtime test model"
                )
            ],
            "models",
        )

    monkeypatch.setattr("app.routes.platform.discover_provider_models", fake_discovery)
    mock_provider_runtime(monkeypatch)

    key_response = client.post(
        "/api/platform/provider-keys",
        json={
            "id": "key-provider-test-primary",
            "provider_id": "provider-test",
            "name": "Test Provider Primary",
            "environment": "Production",
            "secret_value": "test-provider-secret-123",
            "expires": "Jun 27, 2027",
        },
        headers=headers("user-owner"),
    )
    assert key_response.status_code == 201
    created_key = key_response.json()
    assert created_key["provider_id"] == "provider-test"
    assert created_key["masked_value"] != "test-provider-secret-123"
    assert (
        get_store().provider_key_secret_for_provider("provider-test").secret_value
        == "test-provider-secret-123"
    )
    assert get_store().providers["provider-test"].connected is True

    model_response = client.post(
        "/api/platform/models",
        json={
            "id": "model-test",
            "provider_id": "provider-test",
            "name": "Test Legal Model",
            "system_prompt": "You are a careful legal assistant.",
            "meta_prompt": "Prefer cited answers and identify assumptions.",
            "knowledge_config_ids": ["knowledge-box-matters"],
            "tool_config_ids": ["tool-hermes-example"],
            "platform_enabled": True,
            "is_custom": True,
            "created_by": "Aperture Platform Owner",
            "context_window": 200000,
            "visibility": "group",
        },
        headers=headers("user-owner"),
    )
    assert model_response.status_code == 201
    created_model = model_response.json()
    assert created_model["provider_name"] == "Test Provider"
    assert created_model["system_prompt"] == "You are a careful legal assistant."
    assert created_model["meta_prompt"] == "Prefer cited answers and identify assumptions."
    assert created_model["knowledge_config_ids"] == ["knowledge-box-matters"]
    assert created_model["tool_config_ids"] == ["tool-hermes-example"]
    assert created_model["is_custom"] is True
    assert created_model["created_by"] == "Aperture Platform Owner"
    assert created_model["context_window"] == 200000
    assert created_model["visibility"] == "group"
    assert DEFAULT_USER_GROUP_ID in created_model["group_ids"]

    model_update_response = client.patch(
        "/api/platform/models/model-test",
        json={
            "platform_enabled": False,
            "meta_prompt": "Use only approved matter knowledge.",
            "tool_config_ids": [],
            "notes": "Paused for validation",
            "visibility": "tenant",
        },
        headers=headers("user-owner"),
    )
    assert model_update_response.status_code == 200
    updated_model = model_update_response.json()
    assert updated_model["platform_enabled"] is False
    assert updated_model["meta_prompt"] == "Use only approved matter knowledge."
    assert updated_model["knowledge_config_ids"] == ["knowledge-box-matters"]
    assert updated_model["tool_config_ids"] == []
    assert updated_model["visibility"] == "tenant"

    tenant_response = client.post(
        "/api/platform/providers",
        json={"name": "Blocked", "kind": "openai", "region": "Global"},
        headers=headers("user-admin"),
    )
    assert tenant_response.status_code == 403

    actions = [event.action for event in get_store().audit_events]
    assert "platform.provider_created" in actions
    assert "platform.provider_updated" in actions
    assert "platform.provider_key_created" in actions
    assert "platform.model_created" in actions
    assert "platform.model_updated" in actions


def test_platform_owner_cannot_attach_unknown_model_config_references() -> None:
    create_response = client.post(
        "/api/platform/models",
        json={
            "id": "model-bad-knowledge",
            "provider_id": "provider-openai",
            "name": "Bad Knowledge Model",
            "knowledge_config_ids": ["knowledge-missing"],
        },
        headers=headers("user-owner"),
    )
    assert create_response.status_code == 404
    assert create_response.json()["detail"] == "Unknown knowledge configuration: knowledge-missing."

    update_response = client.patch(
        "/api/platform/models/gpt-4o",
        json={"tool_config_ids": ["tool-missing"]},
        headers=headers("user-owner"),
    )
    assert update_response.status_code == 404
    assert update_response.json()["detail"] == "Unknown tool configuration: tool-missing."


def test_platform_owner_syncs_openrouter_models_from_active_provider_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_response = client.post(
        "/api/platform/providers",
        json={
            "id": "provider-openrouter-zdr",
            "name": "OpenRouter ZDR",
            "kind": "openrouter",
            "region": "Global",
            "base_url": "https://openrouter.ai/api/v1",
            "auth_type": "bearer",
        },
        headers=headers("user-owner"),
    )
    assert provider_response.status_code == 201

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        assert provider.id == "provider-openrouter-zdr"
        assert secret_value == "or-live-secret"
        return (
            [
                DiscoveredModel("openai/gpt-4o", "OpenAI: GPT-4o", 128000, "ZDR available"),
                DiscoveredModel(
                    "anthropic/claude-3.5-sonnet",
                    "Anthropic: Claude 3.5 Sonnet",
                    200000,
                    "ZDR available",
                ),
            ],
            "openrouter:/models/user",
        )

    monkeypatch.setattr("app.routes.platform.discover_provider_models", fake_discovery)
    mock_provider_runtime(monkeypatch)

    key_response = client.post(
        "/api/platform/provider-keys",
        json={
            "id": "key-openrouter-zdr",
            "provider_id": "provider-openrouter-zdr",
            "name": "OpenRouter ZDR",
            "environment": "Production",
            "status": "Active",
            "secret_value": "or-live-secret",
        },
        headers=headers("user-owner"),
    )
    assert key_response.status_code == 201
    assert get_store().providers["provider-openrouter-zdr"].model_count == 2

    sync_response = client.post(
        "/api/platform/providers/provider-openrouter-zdr/sync-models",
        headers=headers("user-owner"),
    )
    assert sync_response.status_code == 200
    payload = sync_response.json()
    assert payload["source"] == "openrouter:/models/user"
    assert payload["imported_count"] == 0
    assert payload["updated_count"] == 2
    assert payload["removed_count"] == 0
    assert payload["provider"]["model_count"] == 2
    assert "ZDR eligibility" in payload["provider"]["status_message"]
    assert "Runtime test passed" in payload["provider"]["status_message"]
    assert "Runtime test passed" in payload["message"]
    upstream_ids = {model["upstream_model_id"] for model in payload["models"]}
    assert upstream_ids == {"openai/gpt-4o", "anthropic/claude-3.5-sonnet"}
    assert all("/" not in model["id"] for model in payload["models"])
    assert "or-live-secret" not in str(get_store().audit_events[-1].metadata)
    assert get_store().audit_events[-1].action == "platform.provider_models_synced"


def test_model_sync_never_overwrites_custom_agent_profiles(monkeypatch: pytest.MonkeyPatch) -> None:
    """A custom agent profile sharing an upstream id with a catalog row keeps
    its own name and notes; the catalog row absorbs the sync update and the
    provider-reported capability metadata."""
    seed_openrouter_key("agent-shielding-sync")

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        return (
            [
                DiscoveredModel(
                    "openai/gpt-4o-mini",
                    "OpenAI: GPT-4o mini (refreshed)",
                    128000,
                    "Synced from OpenRouter ZDR-filtered catalog.",
                    ModelCapabilities(
                        supported_parameters=["temperature", "tools"],
                        input_modalities=["text", "image"],
                        output_modalities=["text"],
                    ),
                ),
                DiscoveredModel("openai/gpt-5.5", "OpenAI: GPT-5.5", 1000000, "Synced."),
            ],
            "openrouter:/models?zdr=true",
        )

    monkeypatch.setattr("app.routes.platform.discover_provider_models", fake_discovery)
    mock_provider_runtime(monkeypatch)

    store = get_store()
    agent_before = store.models["agent-client-update"]
    assert agent_before.is_custom
    original_name = agent_before.name
    original_notes = agent_before.notes

    sync_response = client.post(
        "/api/platform/providers/provider-openrouter/sync-models",
        headers=headers("user-owner"),
    )
    assert sync_response.status_code == 200

    store = get_store()
    agent = store.models["agent-client-update"]
    assert agent.name == original_name
    assert agent.notes == original_notes
    assert agent.capabilities is None
    catalog_row = store.models["openrouter-openai-gpt-4o-mini"]
    assert catalog_row.name == "OpenAI: GPT-4o mini (refreshed)"
    assert catalog_row.capabilities is not None
    assert catalog_row.capabilities.supported_parameters == ["temperature", "tools"]


def test_newly_synced_provider_models_default_to_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    """New catalog models wait for an explicit owner enable; the enable grants the default group."""
    provider_response = client.post(
        "/api/platform/providers",
        json={
            "id": "provider-openrouter-defaults",
            "name": "OpenRouter Defaults",
            "kind": "openrouter",
            "region": "Global",
            "base_url": "https://openrouter.ai/api/v1",
            "auth_type": "bearer",
        },
        headers=headers("user-owner"),
    )
    assert provider_response.status_code == 201

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        return (
            [DiscoveredModel("openai/gpt-5.5", "OpenAI: GPT 5.5", 200000, "New catalog model")],
            "openrouter:/models?zdr=true",
        )

    monkeypatch.setattr("app.routes.platform.discover_provider_models", fake_discovery)
    mock_provider_runtime(monkeypatch)

    key_response = client.post(
        "/api/platform/provider-keys",
        json={
            "id": "key-openrouter-defaults",
            "provider_id": "provider-openrouter-defaults",
            "name": "OpenRouter Defaults",
            "environment": "Production",
            "status": "Active",
            "secret_value": "or-defaults-secret",
        },
        headers=headers("user-owner"),
    )
    assert key_response.status_code == 201

    store = get_store()
    provider_models = [
        item for item in store.models.values() if item.provider_id == "provider-openrouter-defaults"
    ]
    assert provider_models
    assert all(model.platform_enabled is False for model in provider_models)
    assert all(model.group_ids == [] for model in provider_models)
    assert store.providers["provider-openrouter-defaults"].enabled_model_count == 0
    model = next(item for item in provider_models if item.upstream_model_id == "openai/gpt-5.5")

    enable_response = client.patch(
        f"/api/platform/models/{model.id}?platform_enabled=true",
        headers=headers("user-owner"),
    )
    assert enable_response.status_code == 200
    enabled = enable_response.json()
    assert enabled["platform_enabled"] is True
    assert enabled["group_ids"], "enabling should grant the default user group"
    assert store.providers["provider-openrouter-defaults"].enabled_model_count == 1


def test_tenant_openrouter_key_cannot_seed_global_catalog_but_platform_key_can() -> None:
    store = get_store()
    provider = Provider(
        id="provider-tenant-catalog-scope",
        name="Tenant catalog scope",
        kind="openrouter",
        region="Global",
        base_url="https://openrouter.example.test/api/v1",
        auth_type="bearer",
        connected=False,
    )
    store.providers[provider.id] = provider
    initial_model_ids = set(store.models)

    store.create_provider_key(
        key_id="key-tenant-catalog-scope",
        provider=provider,
        name="Tenant-scoped key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="tenant-catalog-scope-secret",
        tenant_id="tenant-example",
    )

    assert set(store.models) == initial_model_ids
    assert provider.model_count == 0
    assert provider.enabled_model_count == 0
    assert provider.connected is False

    store.create_provider_key(
        key_id="key-platform-catalog-scope",
        provider=provider,
        name="Platform-scoped key",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="platform-catalog-scope-secret",
    )

    created_model_ids = set(store.models).difference(initial_model_ids)
    assert len(created_model_ids) == 1
    created_model = store.models[created_model_ids.pop()]
    assert created_model.provider_id == provider.id
    assert created_model.tenant_id is None
    assert created_model.platform_enabled is False
    assert provider.model_count == 1
    assert provider.enabled_model_count == 0


def test_openrouter_key_save_does_not_leave_failed_provider_connected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_response = client.post(
        "/api/platform/providers",
        json={
            "id": "provider-openrouter-invalid",
            "name": "OpenRouter Invalid",
            "kind": "openrouter",
            "region": "Global",
            "base_url": "https://openrouter.ai/api/v1",
            "auth_type": "bearer",
        },
        headers=headers("user-owner"),
    )
    assert provider_response.status_code == 201

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        assert provider.id == "provider-openrouter-invalid"
        assert secret_value == "bad-openrouter-key"
        raise ModelDiscoveryError("Provider model sync failed with HTTP 401.", status_code=401)

    monkeypatch.setattr("app.routes.platform.discover_provider_models", fake_discovery)

    key_response = client.post(
        "/api/platform/provider-keys",
        json={
            "id": "key-openrouter-invalid",
            "provider_id": "provider-openrouter-invalid",
            "name": "OpenRouter Invalid",
            "environment": "Production",
            "status": "Active",
            "secret_value": "bad-openrouter-key",
        },
        headers=headers("user-owner"),
    )

    assert key_response.status_code == 201
    store = get_store()
    provider = store.providers["provider-openrouter-invalid"]
    assert provider.connected is False
    assert provider.last_sync == "Model sync failed"
    assert "HTTP 401" in (provider.status_message or "")
    assert store.provider_keys["key-openrouter-invalid"].status == "Inactive"
    assert store.provider_key_secret_for_provider("provider-openrouter-invalid") is None


def test_openrouter_key_save_requires_runtime_completion_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_response = client.post(
        "/api/platform/providers",
        json={
            "id": "provider-openrouter-runtime-invalid",
            "name": "OpenRouter Runtime Invalid",
            "kind": "openrouter",
            "region": "Global",
            "base_url": "https://openrouter.ai/api/v1",
            "auth_type": "bearer",
        },
        headers=headers("user-owner"),
    )
    assert provider_response.status_code == 201

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        assert provider.id == "provider-openrouter-runtime-invalid"
        assert secret_value == "catalog-only-key"
        return (
            [
                DiscoveredModel(
                    "openai/gpt-4o-mini", "OpenAI: GPT-4o mini", 128000, "Catalog worked"
                )
            ],
            "openrouter:/models?zdr=true",
        )

    monkeypatch.setattr("app.routes.platform.discover_provider_models", fake_discovery)
    mock_provider_runtime(
        monkeypatch, error=ModelGatewayAuthError("OpenRouter Runtime Invalid", 401)
    )

    key_response = client.post(
        "/api/platform/provider-keys",
        json={
            "id": "key-openrouter-runtime-invalid",
            "provider_id": "provider-openrouter-runtime-invalid",
            "name": "OpenRouter Runtime Invalid",
            "environment": "Production",
            "status": "Active",
            "secret_value": "catalog-only-key",
        },
        headers=headers("user-owner"),
    )

    assert key_response.status_code == 201
    store = get_store()
    provider = store.providers["provider-openrouter-runtime-invalid"]
    assert provider.model_count == 1
    assert provider.connected is False
    assert provider.last_sync == "Credential rejected"
    assert "HTTP 401" in (provider.status_message or "")
    assert store.provider_keys["key-openrouter-runtime-invalid"].status == "Inactive"
    assert store.provider_key_secret_for_provider("provider-openrouter-runtime-invalid") is None
    actions = [event.action for event in store.audit_events]
    assert "platform.provider_runtime_validation_failed" in actions


def test_provider_model_sync_runtime_failure_keeps_key_active_but_provider_disconnected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seed_openrouter_key("runtime-model-forbidden")

    def fake_discovery(
        provider: Provider, secret_value: str | None
    ) -> tuple[list[DiscoveredModel], str]:
        assert provider.id == "provider-openrouter"
        assert secret_value == "runtime-model-forbidden"
        return (
            [
                DiscoveredModel(
                    "openai/gpt-4o-mini", "OpenAI: GPT-4o mini", 128000, "Catalog worked"
                )
            ],
            "openrouter:/models?zdr=true",
        )

    monkeypatch.setattr("app.routes.platform.discover_provider_models", fake_discovery)
    mock_provider_runtime(monkeypatch, error=ModelGatewayError("OpenRouter returned HTTP 403"))

    sync_response = client.post(
        "/api/platform/providers/provider-openrouter/sync-models",
        headers=headers("user-owner"),
    )

    assert sync_response.status_code == 503
    assert "live chat validation failed" in sync_response.json()["detail"]
    store = get_store()
    provider = store.providers["provider-openrouter"]
    assert provider.connected is False
    assert provider.last_sync == "Runtime test failed"
    assert store.provider_keys["key-openrouter-primary"].status == "Active"


def test_openrouter_discovery_uses_key_scoped_user_catalog() -> None:
    provider = Provider(
        id="provider-openrouter",
        name="OpenRouter",
        kind="openrouter",
        region="Global",
        base_url="https://openrouter.ai/api/v1",
        auth_metadata={"catalog_scope": "user"},
    )
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "data": [
                    {"id": "openai/gpt-4o", "name": "OpenAI: GPT-4o", "context_length": 128000},
                    {"id": "openai/gpt-4o", "name": "duplicate should be ignored"},
                ]
            },
        )

    models, source = discover_provider_models(
        provider,
        "or-test-secret",
        transport=httpx.MockTransport(handler),
    )

    assert source == "openrouter:/models/user"
    assert [model.id for model in models] == ["openai/gpt-4o"]
    assert models[0].context_window == 128000
    assert requests[0].url.path == "/api/v1/models/user"
    assert requests[0].headers["authorization"] == "Bearer or-test-secret"


def test_openrouter_discovery_defaults_to_zdr_filtered_catalog() -> None:
    provider = Provider(
        id="provider-openrouter",
        name="OpenRouter",
        kind="openrouter",
        region="Global",
        base_url="https://openrouter.ai/api/v1",
    )
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": "mistralai/mistral-large",
                        "name": "Mistral Large",
                        "context_length": 128000,
                    }
                ]
            },
        )

    models, source = discover_provider_models(
        provider,
        "or-test-secret",
        transport=httpx.MockTransport(handler),
    )

    assert source == "openrouter:/models?zdr=true"
    assert [model.id for model in models] == ["mistralai/mistral-large"]
    assert requests[0].url.path == "/api/v1/models"
    assert requests[0].url.params["zdr"] == "true"
    assert requests[0].headers["authorization"] == "Bearer or-test-secret"


def test_openrouter_discovery_falls_back_to_zdr_filtered_catalog_when_user_catalog_unavailable() -> (
    None
):
    provider = Provider(
        id="provider-openrouter",
        name="OpenRouter",
        kind="openrouter",
        region="Global",
        base_url="https://openrouter.ai/api/v1",
        auth_metadata={"catalog_scope": "user"},
    )
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/api/v1/models/user":
            return httpx.Response(404)
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": "mistralai/mistral-large",
                        "name": "Mistral Large",
                        "context_length": 128000,
                    }
                ]
            },
        )

    models, source = discover_provider_models(
        provider,
        "or-test-secret",
        transport=httpx.MockTransport(handler),
    )

    assert source == "openrouter:/models?zdr=true"
    assert [model.id for model in models] == ["mistralai/mistral-large"]
    assert requests[1].url.path == "/api/v1/models"
    assert requests[1].url.params["zdr"] == "true"


def test_platform_owner_can_reveal_keys_reject_fake_rotation_and_toggle_platform_connectors() -> (
    None
):
    seed_openrouter_key()

    original_secret = client.post(
        "/api/platform/provider-keys/key-openrouter-primary/reveal",
        headers=headers("user-owner"),
    )
    assert original_secret.status_code == 200
    original_value = original_secret.json()["secret_value"]
    assert original_value.startswith("sk-or-v1")

    rotate_response = client.post(
        "/api/platform/provider-keys/key-openrouter-primary/rotate",
        headers=headers("user-owner"),
    )
    assert rotate_response.status_code == 400
    assert "cannot be rotated automatically" in rotate_response.json()["detail"]

    rotated_secret = client.post(
        "/api/platform/provider-keys/key-openrouter-primary/reveal",
        headers=headers("user-owner"),
    )
    assert rotated_secret.status_code == 200
    assert rotated_secret.json()["secret_value"] == original_value
    assert rotated_secret.json()["masked_value"] == original_secret.json()["masked_value"]

    connector_response = client.patch(
        "/api/platform/connectors/box",
        json={"platform_enabled": False},
        headers=headers("user-owner"),
    )
    assert connector_response.status_code == 200
    connector = connector_response.json()
    assert connector["platform_enabled"] is False
    assert connector["tenant_enabled"] is False

    tenant_rotate = client.post(
        "/api/platform/provider-keys/key-openrouter-primary/rotate", headers=headers("user-admin")
    )
    assert tenant_rotate.status_code == 403

    delete_response = client.delete(
        "/api/platform/provider-keys/key-openrouter-primary", headers=headers("user-owner")
    )
    assert delete_response.status_code == 204
    assert "key-openrouter-primary" not in get_store().provider_keys
    assert "key-openrouter-primary" not in get_store()._encrypted_keys
    assert get_store().provider_key_secret_for_provider("provider-openrouter") is None
    assert get_store().providers["provider-openrouter"].connected is False

    deleted_reveal = client.post(
        "/api/platform/provider-keys/key-openrouter-primary/reveal", headers=headers("user-owner")
    )
    assert deleted_reveal.status_code == 404

    missing_connector = client.patch(
        "/api/platform/connectors/missing",
        json={"platform_enabled": False},
        headers=headers("user-owner"),
    )
    assert missing_connector.status_code == 404

    actions = [event.action for event in get_store().audit_events]
    assert "platform.provider_key_revealed" in actions
    assert "platform.provider_key_rotated" not in actions
    assert "platform.connector_updated" in actions


def test_expired_provider_key_cannot_be_revealed_or_used_for_model_sync() -> None:
    provider_response = client.post(
        "/api/platform/providers",
        json={
            "id": "provider-openrouter-expired",
            "name": "Expired OpenRouter",
            "kind": "openrouter",
            "region": "US",
            "base_url": "https://openrouter.ai/api/v1",
            "auth_type": "bearer",
        },
        headers=headers("user-owner"),
    )
    assert provider_response.status_code == 201

    create_response = client.post(
        "/api/platform/provider-keys",
        json={
            "id": "key-openrouter-expired",
            "provider_id": "provider-openrouter-expired",
            "name": "Expired OpenRouter",
            "environment": "Production",
            "status": "Active",
            "expires": "Jan 1, 2025",
            "secret_value": "sk-or-v1-expired",
        },
        headers=headers("user-owner"),
    )
    assert create_response.status_code == 201
    assert create_response.json()["status"] == "Expired"

    list_response = client.get("/api/platform/provider-keys", headers=headers("user-owner"))
    assert list_response.status_code == 200
    expired = next(key for key in list_response.json() if key["id"] == "key-openrouter-expired")
    assert expired["status"] == "Expired"

    reveal_response = client.post(
        "/api/platform/provider-keys/key-openrouter-expired/reveal",
        headers=headers("user-owner"),
    )
    assert reveal_response.status_code == 409

    sync_response = client.post(
        "/api/platform/providers/provider-openrouter-expired/sync-models",
        headers=headers("user-owner"),
    )
    assert sync_response.status_code == 400
    assert "requires an active provider key" in sync_response.json()["detail"]


def test_config_records_are_seeded_and_mutations_redact_secrets() -> None:
    seeded_sso = client.get("/api/admin/sso-configs", headers=headers("user-admin"))
    assert seeded_sso.status_code == 200
    assert any(record["id"] == "sso-entra-example" for record in seeded_sso.json())

    create_response = client.post(
        "/api/admin/connector-configs",
        json={
            "id": "conncfg-test",
            "connector_id": "box",
            "auth_type": "client-secret",
            "settings": {"safe": "ok", "nested": {"api_key": "nested-secret"}},
            "secret_value": "super-secret-token",
        },
        headers=headers("user-admin"),
    )
    assert create_response.status_code == 201
    assert create_response.json()["secret_set"] is True
    assert "super-secret-token" not in create_response.text

    list_response = client.get("/api/admin/connector-configs", headers=headers("user-admin"))
    assert list_response.status_code == 200
    assert any(record["id"] == "conncfg-test" for record in list_response.json())

    update_response = client.patch(
        "/api/admin/connector-configs/conncfg-test",
        json={
            "settings": {"client_secret": "nested-client-secret"},
            "secret_value": "rotated-secret-token",
        },
        headers=headers("user-admin"),
    )
    assert update_response.status_code == 200
    assert "rotated-secret-token" not in update_response.text

    latest = get_store().audit_events[-1]
    assert latest.action == "admin.connector_config_updated"
    assert latest.metadata["secret_value"] == "[redacted]"
    assert latest.metadata["settings"]["client_secret"] == "[redacted]"


def test_connector_config_clear_replaces_settings_and_deletes_stored_secrets() -> None:
    store = get_store()
    config = store.connector_configs["conncfg-google-drive-example"]
    config.settings["oauth_status"] = "connected"
    config.secret_set = True
    config.masked_secret = "••••cret"
    store.set_configuration_secret("connector", config.id, "google-client-secret")
    store.set_configuration_secret("connector-oauth", config.id, "stored-refresh-token")
    store.set_configuration_secret("connector-password", config.id, "stored-service-password")

    response = client.patch(
        f"/api/admin/connector-configs/{config.id}",
        json={
            "enabled": False,
            "settings": {},
            "replace_settings": True,
            "clear_secret": True,
            "clear_oauth": True,
            "clear_service_password": True,
        },
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is False
    assert body["settings"] == {}
    assert body["secret_set"] is False
    assert body["masked_secret"] is None
    assert store.configuration_secret("connector", config.id) is None
    assert store.configuration_secret("connector-oauth", config.id) is None
    assert store.configuration_secret("connector-password", config.id) is None


def test_tenant_admin_can_persist_sso_knowledge_and_tool_configs() -> None:
    # SSO management is owner-first by default; the owner delegates it here so
    # the tenant-admin persistence path can be exercised.
    delegated = client.patch(
        "/api/platform/settings",
        headers=headers("user-owner"),
        json={"tenant_admins_can_manage_sso": True},
    )
    assert delegated.status_code == 200
    sso_response = client.post(
        "/api/admin/sso-configs",
        json={
            "id": "sso-test",
            "provider": "okta",
            "issuer_url": "https://idp.example.com/oauth2/default",
            "client_id": "aperture-test",
            "client_secret": "okta-client-secret",
        },
        headers=headers("user-admin"),
    )
    assert sso_response.status_code == 201
    assert "okta-client-secret" not in sso_response.text

    knowledge_response = client.post(
        "/api/admin/knowledge-configs",
        json={
            "id": "knowledge-test",
            "name": "Matter Files",
            "source_type": "box",
            "connector_config_id": "conncfg-box-example",
            "acl_group_ids": ["group-litigation"],
            "secret_value": "knowledge-secret",
        },
        headers=headers("user-admin"),
    )
    assert knowledge_response.status_code == 201

    tool_response = client.post(
        "/api/admin/tool-configs",
        json={
            "id": "tool-test",
            "name": "Draft Analyzer",
            "tool_type": "mcp",
            "allowed_group_ids": ["group-litigation"],
            "secret_value": "tool-secret",
        },
        headers=headers("user-admin"),
    )
    assert tool_response.status_code == 201

    store = get_store()
    assert "sso-test" in store.sso_configs
    assert "knowledge-test" in store.knowledge_configs
    assert "tool-test" in store.tool_configs
    assert [event.action for event in store.audit_events][-3:] == [
        "admin.sso_config_created",
        "admin.knowledge_config_created",
        "admin.tool_config_created",
    ]


def test_platform_owner_can_create_knowledge_config() -> None:
    # The tenant-unbound platform owner defaults to owner_user_id and must not
    # trip the durable-state cross-tenant owner validation.
    response = client.post(
        "/api/admin/knowledge-configs",
        json={
            "id": "knowledge-owner-created",
            "name": "Owner Upload KB",
            "source_type": "upload",
        },
        headers=headers("user-owner"),
    )
    assert response.status_code == 201
    body = response.json()
    assert body["owner_user_id"] == "user-owner"
    assert body["tenant_id"] == "tenant-example"

    store = get_store()
    assert "knowledge-owner-created" in store.knowledge_configs
    assert store.audit_events[-1].action == "admin.knowledge_config_created"


def test_knowledge_config_rejects_unknown_or_cross_tenant_owner() -> None:
    response = client.post(
        "/api/admin/knowledge-configs",
        json={
            "id": "knowledge-bad-owner",
            "name": "Bad Owner KB",
            "source_type": "upload",
            "owner_user_id": "user-does-not-exist",
        },
        headers=headers("user-admin"),
    )
    assert response.status_code == 400
    assert "knowledge-bad-owner" not in get_store().knowledge_configs

    created = client.post(
        "/api/admin/knowledge-configs",
        json={"id": "knowledge-owner-check", "name": "Owner Check KB", "source_type": "upload"},
        headers=headers("user-admin"),
    )
    assert created.status_code == 201
    update_response = client.patch(
        "/api/admin/knowledge-configs/knowledge-owner-check",
        json={"owner_user_id": "user-does-not-exist"},
        headers=headers("user-admin"),
    )
    assert update_response.status_code == 400
    assert get_store().knowledge_configs["knowledge-owner-check"].owner_user_id == "user-admin"


def test_regular_user_cannot_mutate_tenant_configs() -> None:
    response = client.post(
        "/api/admin/tool-configs",
        json={"name": "Blocked Tool", "tool_type": "mcp"},
        headers=headers("user-jane"),
    )
    assert response.status_code == 403


def test_admin_can_delete_knowledge_config_and_index() -> None:
    create_response = client.post(
        "/api/admin/knowledge-configs",
        json={
            "id": "knowledge-delete-me",
            "name": "Delete Me Knowledge",
            "source_type": "upload",
            "acl_group_ids": ["group-litigation"],
            "secret_value": "knowledge-secret",
            "settings": {"source": "Manual upload", "status": "draft", "document_count": 0},
        },
        headers=headers("user-admin"),
    )
    assert create_response.status_code == 201

    upload_response = client.post(
        "/api/knowledge/knowledge-delete-me/documents",
        headers=headers("user-admin"),
        files=[
            (
                "files",
                ("delete-me.txt", BytesIO(b"Delete test knowledge vector content."), "text/plain"),
            )
        ],
    )
    assert upload_response.status_code == 200

    store = get_store()
    store.models["agent-client-update"].knowledge_config_ids.append("knowledge-delete-me")
    store.set_configuration_secret(
        "knowledge-api-source", "knowledge-delete-me:source-secret", "api-secret"
    )
    assert store.configuration_secret("knowledge", "knowledge-delete-me") == "knowledge-secret"
    assert store.knowledge_documents_for("knowledge-delete-me")
    assert store.knowledge_chunks_for("knowledge-delete-me")

    response = client.delete(
        "/api/admin/knowledge-configs/knowledge-delete-me", headers=headers("user-admin")
    )

    assert response.status_code == 200
    assert response.json() == {"status": "deleted", "id": "knowledge-delete-me"}
    assert "knowledge-delete-me" not in store.knowledge_configs
    assert store.configuration_secret("knowledge", "knowledge-delete-me") is None
    assert (
        store.configuration_secret("knowledge-api-source", "knowledge-delete-me:source-secret")
        is None
    )
    assert store.knowledge_documents_for("knowledge-delete-me") == []
    assert store.knowledge_chunks_for("knowledge-delete-me") == []
    assert "knowledge-delete-me" not in store.models["agent-client-update"].knowledge_config_ids
    assert (
        store.retrieve_knowledge(
            store.users["user-admin"], ["knowledge-delete-me"], "Delete test knowledge", limit=3
        )
        == []
    )
    assert store.audit_events[-1].action == "admin.knowledge_config_deleted"


def test_admin_can_delete_single_knowledge_document_and_chunks() -> None:
    create_response = client.post(
        "/api/admin/knowledge-configs",
        json={
            "id": "knowledge-delete-doc",
            "name": "Document Delete Knowledge",
            "source_type": "upload",
            "acl_group_ids": ["group-litigation"],
            "settings": {"source": "Manual upload", "status": "draft", "document_count": 0},
        },
        headers=headers("user-admin"),
    )
    assert create_response.status_code == 201

    upload_response = client.post(
        "/api/knowledge/knowledge-delete-doc/documents",
        headers=headers("user-admin"),
        files=[
            (
                "files",
                (
                    "delete-one.txt",
                    BytesIO(b"Delete only this alpaca vector sentence."),
                    "text/plain",
                ),
            ),
            (
                "files",
                ("keep-one.txt", BytesIO(b"Keep this narwhal vector sentence."), "text/plain"),
            ),
        ],
    )
    assert upload_response.status_code == 200
    documents = upload_response.json()["documents"]
    delete_document = next(
        document for document in documents if document["name"] == "delete-one.txt"
    )
    keep_document = next(document for document in documents if document["name"] == "keep-one.txt")

    response = client.delete(
        f"/api/knowledge/knowledge-delete-doc/documents/{delete_document['id']}",
        headers=headers("user-admin"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["config"]["settings"]["document_count"] == 1
    assert [document["id"] for document in payload["documents"]] == [keep_document["id"]]
    store = get_store()
    assert [document.id for document in store.knowledge_documents_for("knowledge-delete-doc")] == [
        keep_document["id"]
    ]
    assert all(
        chunk.document_id != delete_document["id"]
        for chunk in store.knowledge_chunks_for("knowledge-delete-doc")
    )
    assert all(
        chunk.document_id != delete_document["id"]
        for chunk in store.retrieve_knowledge(
            store.users["user-admin"], ["knowledge-delete-doc"], "alpaca", limit=3
        )
    )
    assert (
        store.retrieve_knowledge(
            store.users["user-admin"], ["knowledge-delete-doc"], "narwhal", limit=3
        )[0].document_id
        == keep_document["id"]
    )
    assert store.audit_events[-1].action == "knowledge.document_deleted"


def test_admin_can_delete_tool_config_and_secret() -> None:
    create_response = client.post(
        "/api/admin/tool-configs",
        json={
            "id": "tool-delete-me",
            "name": "Delete Me",
            "tool_type": "mcp",
            "allowed_group_ids": ["group-litigation"],
            "secret_value": "delete-secret",
        },
        headers=headers("user-admin"),
    )
    assert create_response.status_code == 201
    store = get_store()
    store.models["agent-client-update"].tool_config_ids.append("tool-delete-me")
    store.set_configuration_secret(
        "tool-oauth-token", "tool-delete-me", '{"access_token":"delete-token"}'
    )
    assert store.configuration_secret("tool", "tool-delete-me") == "delete-secret"
    assert (
        store.configuration_secret("tool-oauth-token", "tool-delete-me")
        == '{"access_token":"delete-token"}'
    )

    response = client.delete(
        "/api/admin/tool-configs/tool-delete-me", headers=headers("user-admin")
    )

    assert response.status_code == 200
    assert response.json() == {"status": "deleted", "id": "tool-delete-me"}
    assert "tool-delete-me" not in store.tool_configs
    assert store.configuration_secret("tool", "tool-delete-me") is None
    assert store.configuration_secret("tool-oauth-token", "tool-delete-me") is None
    assert "tool-delete-me" not in store.models["agent-client-update"].tool_config_ids
    assert store.audit_events[-1].action == "admin.tool_config_deleted"


def test_admin_can_delete_prompt_template_and_skill_file_references() -> None:
    template_response = client.post(
        "/api/admin/prompt-templates",
        json={
            "id": "template-delete-me",
            "name": "Delete Me Template",
            "content": "Draft an update for {{matter_name}}.",
            "category": "client-communications",
            "variables": ["matter_name"],
            "group_ids": ["group-litigation"],
        },
        headers=headers("user-admin"),
    )
    assert template_response.status_code == 201

    skill_response = client.post(
        "/api/admin/skill-files",
        json={
            "id": "skill-delete-me",
            "name": "Delete Me Skill",
            "content": "# Delete Me\n- Temporary workflow rule.",
            "category": "legal-workflow",
            "group_ids": ["group-litigation"],
        },
        headers=headers("user-admin"),
    )
    assert skill_response.status_code == 201

    store = get_store()
    store.models["agent-client-update"].prompt_template_ids.append("template-delete-me")
    store.models["agent-client-update"].skill_file_ids.append("skill-delete-me")

    template_delete = client.delete(
        "/api/admin/prompt-templates/template-delete-me", headers=headers("user-admin")
    )
    skill_delete = client.delete(
        "/api/admin/skill-files/skill-delete-me", headers=headers("user-admin")
    )

    assert template_delete.status_code == 200
    assert template_delete.json() == {"status": "deleted", "id": "template-delete-me"}
    assert skill_delete.status_code == 200
    assert skill_delete.json() == {"status": "deleted", "id": "skill-delete-me"}
    assert "template-delete-me" not in store.prompt_templates
    assert "skill-delete-me" not in store.skill_files
    assert "template-delete-me" not in store.models["agent-client-update"].prompt_template_ids
    assert "skill-delete-me" not in store.models["agent-client-update"].skill_file_ids
    assert [event.action for event in store.audit_events][-2:] == [
        "admin.prompt_template_deleted",
        "admin.skill_file_deleted",
    ]


def test_platform_owner_can_delete_custom_agent_profile() -> None:
    store = get_store()
    # Hermes is admin-approved and off by default; grant it for this test.
    store.groups["group-litigation"].permissions["hermes_companion"] = True
    provider = store.providers["provider-openrouter"]
    initial_model_count = provider.model_count
    initial_enabled_count = provider.enabled_model_count

    create_response = client.post(
        "/api/platform/models",
        json={
            "id": "agent-delete-me",
            "provider_id": "provider-openrouter",
            "name": "Delete Me Agent",
            "upstream_model_id": "openai/gpt-4o-mini",
            "system_prompt": "Use configured matter sources.",
            "meta_prompt": "Keep internal and client-facing sections separate.",
            "knowledge_config_ids": ["knowledge-litigation-playbook"],
            "tool_config_ids": ["tool-hermes-agent-mcp"],
            "is_custom": True,
            "created_by": "Aperture Platform Owner",
            "visibility": "tenant",
            "agentic_companion": "hermes",
            "prompt_template_ids": ["template-client-update"],
            "skill_file_ids": ["skill-client-update-package"],
        },
        headers=headers("user-owner"),
    )
    assert create_response.status_code == 201
    assert provider.model_count == initial_model_count + 1
    assert provider.enabled_model_count == initial_enabled_count + 1

    delete_response = client.delete(
        "/api/platform/models/agent-delete-me", headers=headers("user-owner")
    )

    assert delete_response.status_code == 200
    assert delete_response.json() == {"status": "deleted", "id": "agent-delete-me"}
    assert "agent-delete-me" not in store.models
    assert provider.model_count == initial_model_count
    assert provider.enabled_model_count == initial_enabled_count
    assert store.audit_events[-1].action == "platform.model_deleted"

    seeded_profile_delete = client.delete(
        "/api/platform/models/openrouter-openai-gpt-5-5",
        headers=headers("user-owner"),
    )
    assert seeded_profile_delete.status_code == 200
    assert seeded_profile_delete.json() == {"status": "deleted", "id": "openrouter-openai-gpt-5-5"}
    assert "openrouter-openai-gpt-5-5" not in store.models
    assert store.audit_events[-1].action == "platform.model_deleted"

    base_model_delete = client.delete("/api/platform/models/gpt-4o", headers=headers("user-owner"))
    assert base_model_delete.status_code == 409


def test_tenant_admin_can_delete_agent_profile() -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    initial_model_count = provider.model_count
    initial_enabled_count = provider.enabled_model_count

    delete_response = client.delete(
        "/api/admin/agent-profiles/agent-client-update", headers=headers("user-admin")
    )

    assert delete_response.status_code == 200
    assert delete_response.json() == {"status": "deleted", "id": "agent-client-update"}
    assert "agent-client-update" not in store.models
    assert provider.model_count == initial_model_count - 1
    assert provider.enabled_model_count == initial_enabled_count - 1
    assert store.audit_events[-1].action == "admin.agent_profile_deleted"


def test_tenant_admin_cannot_delete_locked_agent_profile() -> None:
    store = get_store()
    store.models["agent-client-update"].admin_delete_locked = True

    delete_response = client.delete(
        "/api/admin/agent-profiles/agent-client-update", headers=headers("user-admin")
    )

    assert delete_response.status_code == 403
    assert (
        delete_response.json()["detail"] == "This agent profile is locked by organization policy."
    )
    assert "platform owner" not in delete_response.json()["detail"].lower()
    assert "agent-client-update" in store.models


def test_admin_agent_profile_delete_rejects_base_models() -> None:
    delete_response = client.delete(
        "/api/admin/agent-profiles/gpt-4o", headers=headers("user-admin")
    )

    assert delete_response.status_code == 409
    assert (
        delete_response.json()["detail"] == "Only agent profiles can be deleted from this surface."
    )


# --- Model-access delegation ceiling (security finding #11) ---


def _seed_foreign_restricted_model(model_id: str, group_id: str) -> None:
    from app.models.schemas import Group, ModelConfig

    store = get_store()
    seed_tenant("tenant-other")
    store.groups[group_id] = Group(
        id=group_id,
        tenant_id="tenant-other",
        name="Foreign Group",
        distinguished_name=f"cn={group_id}",
        entra_object_id=f"obj-{group_id}",
    )
    store.models[model_id] = ModelConfig(
        id=model_id,
        provider_id="provider-openrouter",
        provider_name="OpenRouter",
        tenant_id="tenant-other",
        name="Foreign Restricted Model",
        platform_enabled=True,
        tenant_restricted=True,
        group_ids=[group_id],
    )


def test_tenant_admin_cannot_rescope_model_restricted_to_foreign_tenant() -> None:
    _seed_foreign_restricted_model("model-foreign-restricted", "group-foreign")
    resp = client.patch(
        "/api/admin/model-access/model-foreign-restricted",
        headers=headers("user-admin"),
        json={"group_ids": ["group-litigation"]},
    )
    assert resp.status_code == 403


def test_tenant_admin_can_rescope_unrestricted_platform_model() -> None:
    resp = client.patch(
        "/api/admin/model-access/gpt-4o",
        headers=headers("user-admin"),
        json={"group_ids": ["group-litigation"]},
    )
    assert resp.status_code == 200
    assert resp.json()["group_ids"] == ["group-litigation"]


def test_platform_owner_can_rescope_foreign_restricted_model() -> None:
    _seed_foreign_restricted_model("model-foreign-restricted-2", "group-foreign-2")
    resp = client.patch(
        "/api/admin/model-access/model-foreign-restricted-2",
        headers=headers("user-owner"),
        json={"group_ids": ["group-foreign-2"]},
    )
    assert resp.status_code == 200


def test_retention_settings_are_owner_gated_and_persisted() -> None:
    denied = client.patch(
        "/api/platform/settings",
        json={"audit_retention_days": 30},
        headers=headers("user-admin"),
    )
    assert denied.status_code == 403

    updated = client.patch(
        "/api/platform/settings",
        json={"audit_retention_days": 30, "usage_retention_days": 90},
        headers=headers("user-owner"),
    )
    assert updated.status_code == 200
    assert updated.json()["audit_retention_days"] == 30
    assert updated.json()["usage_retention_days"] == 90

    fetched = client.get("/api/platform/settings", headers=headers("user-owner"))
    assert fetched.json()["audit_retention_days"] == 30
    assert fetched.json()["usage_retention_days"] == 90

    # Zero disables retention and remains an accepted, persisted value.
    disabled = client.patch(
        "/api/platform/settings",
        json={"audit_retention_days": 0},
        headers=headers("user-owner"),
    )
    assert disabled.status_code == 200
    assert disabled.json()["audit_retention_days"] == 0

    store = get_store()
    snapshot = store.identity_config_repository.load_active_snapshot()
    assert snapshot is not None
    assert snapshot.platform_settings.audit_retention_days == 0
    assert snapshot.platform_settings.usage_retention_days == 90


# --- provider deletion (owner-only, confirmed, cascading) -------------------


def _seed_disposable_provider() -> str:
    """A provider with one model and one stored key, referenced by nothing."""
    store = get_store()
    store.providers["provider-retired"] = Provider(
        id="provider-retired",
        name="Retired Vendor",
        kind="openai-compatible",
        region="us",
        base_url="https://retired.example/v1",
        auth_type="bearer",
        connected=True,
    )
    store.models["model-retired-1"] = ModelConfig(
        id="model-retired-1",
        provider_id="provider-retired",
        provider_name="Retired Vendor",
        name="Retired Model",
        platform_enabled=True,
    )
    store.create_provider_key(
        key_id="key-retired",
        provider=store.providers["provider-retired"],
        name="Retired Key",
        environment="Production",
        status="Active",
        expires="Not set",
        secret_value="retired-secret-value",
    )
    return "provider-retired"


def test_provider_delete_requires_the_exact_name_as_confirmation() -> None:
    provider_id = _seed_disposable_provider()

    unconfirmed = client.delete(
        f"/api/platform/providers/{provider_id}", headers=headers("user-owner")
    )
    assert unconfirmed.status_code == 400
    assert "Repeat the provider name" in unconfirmed.json()["detail"]

    wrong = client.delete(
        f"/api/platform/providers/{provider_id}?confirm=Retired",
        headers=headers("user-owner"),
    )
    assert wrong.status_code == 400
    # Nothing was destroyed while the confirmation was wrong.
    assert provider_id in get_store().providers
    assert "model-retired-1" in get_store().models


def test_provider_delete_removes_its_models_and_keys_for_the_owner() -> None:
    provider_id = _seed_disposable_provider()

    response = client.delete(
        f"/api/platform/providers/{provider_id}?confirm=Retired%20Vendor",
        headers=headers("user-owner"),
    )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "status": "deleted",
        "id": provider_id,
        "models_deleted": 1,
        "keys_deleted": 1,
    }
    store = get_store()
    assert provider_id not in store.providers
    assert "model-retired-1" not in store.models
    assert "key-retired" not in store.provider_keys
    # The stored ciphertext goes with the record; no orphaned secret survives.
    assert store.provider_key_secret_for_provider(provider_id) is None
    assert store.audit_events[-1].action == "platform.provider_deleted"


def test_provider_delete_refuses_to_silently_break_a_live_automation() -> None:
    provider_id = _seed_disposable_provider()
    store = get_store()
    store.automations["automation-uses-retired"] = Automation(
        id="automation-uses-retired",
        tenant_id="tenant-example",
        name="Nightly digest",
        steps=[AutomationStep(model_id="model-retired-1")],
        created_by="user-owner",
    )

    response = client.delete(
        f"/api/platform/providers/{provider_id}?confirm=Retired%20Vendor",
        headers=headers("user-owner"),
    )

    assert response.status_code == 409
    assert "Nightly digest" in response.json()["detail"]
    # The provider and its model survive an attempt that would have broken a run.
    assert provider_id in get_store().providers
    assert "model-retired-1" in get_store().models


def test_provider_delete_is_owner_only() -> None:
    provider_id = _seed_disposable_provider()
    for persona in ("user-admin", "user-jane"):
        response = client.delete(
            f"/api/platform/providers/{provider_id}?confirm=Retired%20Vendor",
            headers=headers(persona),
        )
        assert response.status_code in (403, 404)
    assert provider_id in get_store().providers


def test_provider_delete_refuses_to_take_agent_profiles_with_it() -> None:
    """Agent profiles are hand-authored models; a provider sync cannot rebuild
    them. Deleting a provider must never remove them as collateral."""
    provider_id = _seed_disposable_provider()
    store = get_store()
    store.models["agent-on-retired"] = ModelConfig(
        id="agent-on-retired",
        provider_id=provider_id,
        provider_name="Retired Vendor",
        name="Research Agent",
        platform_enabled=True,
        is_custom=True,
    )

    response = client.delete(
        f"/api/platform/providers/{provider_id}?confirm=Retired%20Vendor",
        headers=headers("user-owner"),
    )

    assert response.status_code == 409
    assert "Research Agent" in response.json()["detail"]
    assert provider_id in get_store().providers
    assert "agent-on-retired" in get_store().models
