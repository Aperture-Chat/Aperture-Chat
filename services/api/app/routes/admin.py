from __future__ import annotations

import re
from typing import Any
from urllib.parse import unquote, urlencode
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse

from app.core import clock, connector_auth, hermes, oidc
from app.core.alerting import (
    normalize_action_patterns,
    validate_min_severity,
    validate_recipients,
)
from app.core.audit_severity import decorate_audit_events
from app.core.mailer import email_configured
from app.core.retention import batch_dispose_threads
from app.core.usage_analytics import build_usage_summary
from app.core.usage_budget import UsageBudgetError, UsageBudgetUnavailable, utc_usage_date
from app.core.usage_budget_runtime import (
    UsageTenantScopeError,
    map_usage_budget_error,
    resolve_usage_tenant_id,
)
from app.core.config import get_settings
from app.core.content_filters import (
    MAX_DESCRIPTION_LENGTH,
    MAX_NAME_LENGTH,
    MAX_PREVIEW_SAMPLE_CHARS,
    builtin_content_filters,
    evaluate_content_filters,
    is_builtin_filter_id,
    validate_content_filter_rules,
)
from app.core.script_tools import (
    DEFAULT_TIMEOUT_SECONDS,
    run_custom_script,
    validate_custom_script,
)
from app.core.model_discovery import DiscoveredModel, ModelDiscoveryError, discover_provider_models
from app.core.net_guard import EgressBlocked, validate_public_url
from app.core.policy import (
    agent_profile_authored_by,
    assert_agent_authoring,
    assert_can_create_role,
    assert_can_modify_user,
    assert_knowledge_authoring,
    assert_tool_authoring,
    hermes_companion_allowed,
    is_platform_owner,
    is_temp_user_model,
    is_workspace_agent_profile,
    require_admin_or_owner,
    same_tenant,
)
from app.core.sessions import sign_oidc_state
from app.models.schemas import (
    PrincipalBudgetAllocation,
    PrincipalUsageBudgetUpdateRequest,
    AdminMfaResetResponse,
    AdminPasswordResetRequest,
    AlertNotification,
    AlertNotificationArchiveRequest,
    AlertRule,
    AlertRuleCreateRequest,
    AlertRuleUpdateRequest,
    AuditEvent,
    CompanionMemory,
    Connector,
    ConnectorConfig,
    ConnectorConfigCreateRequest,
    ConnectorConfigUpdateRequest,
    ContentFilter,
    ContentFilterCreateRequest,
    ContentFilterPreviewRequest,
    ContentFilterPreviewResponse,
    ContentFilterRuleMatchSummary,
    ContentFilterUpdateRequest,
    CustomScriptPreviewRequest,
    CustomScriptRunResponse,
    Group,
    GroupBulkCreateRequest,
    GroupBulkDeleteRequest,
    GroupCreateRequest,
    GroupUpdateRequest,
    KnowledgeConfig,
    KnowledgeConfigCreateRequest,
    KnowledgeConfigUpdateRequest,
    AdminModelAccessUpdateRequest,
    MemoryUserStat,
    ModelConfig,
    ModelContentFiltersUpdateRequest,
    ModelCreateRequest,
    ModelUpdateRequest,
    PromptTemplate,
    PromptTemplateCreateRequest,
    PromptTemplateUpdateRequest,
    Provider,
    Role,
    SecurityAlert,
    SecurityAlertUpdateRequest,
    SkillFile,
    SkillFileCreateRequest,
    SkillFileUpdateRequest,
    SsoConfig,
    SsoConfigCreateRequest,
    SsoConfigUpdateRequest,
    TenantMemoryPolicy,
    TenantMemoryPolicyUpdateRequest,
    ChatFeedbackRecord,
    RetentionBatchRequest,
    RetentionBatchResult,
    RetentionRule,
    RetentionTaggedThread,
    TenantRetentionPolicy,
    TenantRetentionPolicyUpdateRequest,
    ToolConfig,
    ToolConfigCreateRequest,
    ToolConfigUpdateRequest,
    TenantMfaPolicyResponse,
    TenantMfaPolicyUpdateRequest,
    User,
    UserCreateRequest,
    AccessRequestReviewRequest,
    UsageRecord,
    UserPromptRecord,
    UserUpdateRequest,
    normalize_group_permissions,
    now_utc,
)
from app.repositories.deps import get_store, get_usage_budget_repository
from app.repositories.application_state import MfaStateConflictError
from app.repositories.seed import (
    LastActiveAdministrativeAccountError,
    SeedStore,
    SessionUserStateError,
)
from app.repositories.usage_budgets import TenantUsageBudgetRepository
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/admin", tags=["tenant-admin"])


@router.get("/users")
def users(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[User]:
    require_admin_or_owner(actor)
    return store.tenant_visible_users_for(actor)


@router.post("/access-requests/{user_id}/approve")
def approve_access_request(
    user_id: str,
    payload: AccessRequestReviewRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> User:
    require_admin_or_owner(actor)
    target = _get_user(user_id, store)
    if target.access_request_status != "pending" or target.active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This access request is no longer pending.",
        )
    if payload.role not in {Role.USER, Role.TEMP_USER, Role.TENANT_ADMIN}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Access requests can be approved as a user, temp user, or admin.",
        )
    assert_can_modify_user(
        actor,
        target,
        tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
    )
    assert_can_create_role(
        actor,
        payload.role,
        tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
    )
    if payload.role == Role.TEMP_USER and not any(
        model.platform_enabled
        and model.tenant_id in {None, target.tenant_id}
        and not is_workspace_agent_profile(model)
        and is_temp_user_model(model)
        for model in store.models.values()
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Enable a Luna model for this workspace before approving temporary access.",
        )
    group_ids: list[str] = []
    if target.tenant_id and store.platform_settings.default_user_group_enabled:
        store.ensure_default_user_group()
        default_group = store.default_group_for_tenant(target.tenant_id)
        if default_group is not None:
            group_ids = [default_group.id]
    with store._store_lock:
        if store.users.get(target.id) is not target or target.access_request_status != "pending":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This access request changed while it was being reviewed.",
            )
        target.role = payload.role
        target.group_ids = group_ids
        target.active = True
        target.access_request_status = "approved"
        target.access_reviewed_at = now_utc().isoformat()
        store.record_audit(
            actor,
            "admin.access_request_approved",
            target.id,
            {"approved_role": payload.role, "group_ids": group_ids},
        )
    return target


@router.delete("/access-requests/{user_id}")
def decline_access_request(
    user_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    target = _get_user(user_id, store)
    if target.access_request_status != "pending" or target.active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This access request is no longer pending.",
        )
    assert_can_modify_user(
        actor,
        target,
        tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
    )
    store.delete_user_account(
        target.id,
        updated_by=actor.id,
        expected_user=target,
        expected_role=target.role,
        expected_tenant_id=target.tenant_id,
        expected_active=False,
    )
    store.record_audit(
        actor,
        "admin.access_request_declined",
        target.id,
        {"display_name": target.display_name},
    )
    return {"status": "declined", "user_id": target.id}


@router.post("/users", status_code=201)
def create_user(
    payload: UserCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> User:
    require_admin_or_owner(actor)
    assert_can_create_role(
        actor,
        payload.role,
        tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
    )
    user_id = payload.id or f"user-{uuid4()}"
    if user_id in store.users:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="User already exists.")
    _assert_unique_user_identity(
        store, email=payload.email, entra_object_id=payload.entra_object_id
    )
    tenant_id = _tenant_id_for_user(actor, payload.tenant_id, payload.role, store)
    group_ids = list(payload.group_ids)
    if not group_ids and tenant_id and store.platform_settings.default_user_group_enabled:
        store.ensure_default_user_group()
        default_group = next(
            (
                group
                for group in store.groups.values()
                if group.tenant_id == tenant_id and group.default_group
            ),
            None,
        )
        if default_group is not None:
            group_ids = [default_group.id]
    _assert_group_scope(actor, group_ids, store, tenant_id=tenant_id)
    user = User(
        id=user_id,
        tenant_id=tenant_id,
        email=payload.email,
        display_name=payload.display_name,
        role=payload.role,
        entra_object_id=payload.entra_object_id,
        group_ids=group_ids,
        active=payload.active,
        auth_method=payload.auth_method,
    )
    store.users[user.id] = user
    store.record_audit(
        actor,
        "admin.user_created",
        user.id,
        {"email": user.email, "role": user.role, "group_ids": user.group_ids},
    )
    store.save_runtime_state()
    return user


@router.patch("/users/{user_id}")
def update_user(
    user_id: str,
    payload: UserUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> User:
    require_admin_or_owner(actor)
    expected_actor_role = actor.role
    expected_actor_tenant_id = actor.tenant_id
    target = _get_user(user_id, store)
    expected_role = target.role
    expected_tenant_id = target.tenant_id
    expected_group_ids = tuple(target.group_ids)
    expected_active = target.active
    if payload.active is False and target.id == actor.id:
        _assert_deactivation_allowed(actor, target, store)
    assert_can_modify_user(
        actor,
        target,
        tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
    )
    requested_role = payload.role or expected_role
    _assert_role_change_allowed(target, requested_role, store)
    assert_can_create_role(
        actor,
        requested_role,
        tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
    )
    if payload.tenant_id is not None:
        _assert_tenant_update_allowed(actor, payload.tenant_id, store)
    if requested_role == Role.PLATFORM_OWNER:
        effective_tenant_id = None
    elif payload.tenant_id is not None:
        effective_tenant_id = payload.tenant_id
    elif expected_tenant_id is not None:
        effective_tenant_id = expected_tenant_id
    else:
        # Platform owners have no tenant binding. A demotion must resolve the
        # sole available tenant or fail with the same explicit multi-tenant
        # error used by account creation.
        effective_tenant_id = _tenant_id_for_user(actor, None, requested_role, store)
    effective_group_ids = (
        list(payload.group_ids) if payload.group_ids is not None else list(expected_group_ids)
    )
    if requested_role == Role.PLATFORM_OWNER:
        effective_group_ids = []
    if effective_tenant_id != expected_tenant_id and payload.group_ids is None:
        default_group = store.default_group_for_tenant(effective_tenant_id or "")
        effective_group_ids = [default_group.id] if default_group is not None else []
    _assert_group_scope(actor, effective_group_ids, store, tenant_id=effective_tenant_id)
    if payload.email is not None or payload.entra_object_id is not None:
        _assert_unique_user_identity(
            store,
            email=payload.email,
            entra_object_id=payload.entra_object_id,
            exclude_user_id=target.id,
        )
    deactivating = payload.active is False
    final_active = payload.active if payload.active is not None else expected_active
    if payload.active is False:
        _assert_deactivation_allowed(actor, target, store)
    updates = payload.model_dump(exclude_unset=True)
    scope_changing = requested_role != expected_role or effective_tenant_id != expected_tenant_id
    identity_security_changing = any(
        field in updates for field in {"email", "entra_object_id", "auth_method", "group_ids"}
    )
    with store._store_lock:
        _assert_current_admin_actor(
            actor,
            store,
            expected_role=expected_actor_role,
            expected_tenant_id=expected_actor_tenant_id,
        )
        assert_can_modify_user(
            actor,
            target,
            tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
        )
        _assert_user_mutation_scope_or_503(
            store,
            target,
            expected_role=expected_role,
            expected_tenant_id=expected_tenant_id,
            expected_group_ids=expected_group_ids,
            expected_active=expected_active,
        )
        _assert_role_change_allowed(target, requested_role, store)
        assert_can_create_role(
            actor,
            requested_role,
            tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
        )
        if payload.tenant_id is not None:
            _assert_tenant_update_allowed(actor, payload.tenant_id, store)
        _assert_group_scope(actor, effective_group_ids, store, tenant_id=effective_tenant_id)
        if payload.email is not None or payload.entra_object_id is not None:
            _assert_unique_user_identity(
                store,
                email=payload.email,
                entra_object_id=payload.entra_object_id,
                exclude_user_id=target.id,
            )
        if deactivating:
            _assert_deactivation_allowed(actor, target, store)
        if scope_changing:
            _transition_user_access_scope_or_503(
                store,
                target,
                expected_role=expected_role,
                expected_tenant_id=expected_tenant_id,
                expected_group_ids=expected_group_ids,
                expected_active=expected_active,
                role=requested_role,
                tenant_id=effective_tenant_id,
                group_ids=effective_group_ids,
                active=final_active,
                updated_by=actor.id,
            )
        elif deactivating:
            _advance_user_session_watermark_or_503(
                store,
                target,
                reason="admin-user-deactivated",
                updated_by=actor.id,
                deactivate=True,
                expected_role=expected_role,
                expected_tenant_id=expected_tenant_id,
            )
        elif identity_security_changing:
            _advance_user_session_watermark_or_503(
                store,
                target,
                reason="admin-user-security-scope-changed",
                updated_by=actor.id,
                deactivate=False,
                expected_role=expected_role,
                expected_tenant_id=expected_tenant_id,
            )
        elif payload.active is not None:
            _set_user_active_state_or_503(
                store,
                target,
                expected_role=expected_role,
                expected_tenant_id=expected_tenant_id,
                expected_active=expected_active,
                active=final_active,
            )
        changed: list[str] = []
        for field, value in updates.items():
            if value is None:
                continue
            if field == "active" or (
                scope_changing and field in {"role", "tenant_id", "group_ids"}
            ):
                changed.append(field)
                continue
            if field == "tenant_id" and requested_role == Role.PLATFORM_OWNER:
                value = None
            setattr(target, field, value)
            changed.append(field)
        if not scope_changing:
            target.group_ids = effective_group_ids
        if target.role == Role.PLATFORM_OWNER:
            target.tenant_id = None
        action = (
            "admin.user_deactivated" if updates.get("active") is False else "admin.user_updated"
        )
        store.record_audit(actor, action, target.id, {"changed": changed, "role": target.role})
        store.save_runtime_state()
        return target


@router.post("/users/{user_id}/deactivate")
def deactivate_user(
    user_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    expected_actor_role = actor.role
    expected_actor_tenant_id = actor.tenant_id
    target = _get_user(user_id, store)
    expected_role = target.role
    expected_tenant_id = target.tenant_id
    if target.id == actor.id:
        _assert_deactivation_allowed(actor, target, store)
    assert_can_modify_user(
        actor,
        target,
        tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
    )
    _assert_deactivation_allowed(actor, target, store)
    with store._store_lock:
        _assert_current_admin_actor(
            actor,
            store,
            expected_role=expected_actor_role,
            expected_tenant_id=expected_actor_tenant_id,
        )
        assert_can_modify_user(
            actor,
            target,
            tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
        )
        _assert_deactivation_allowed(actor, target, store)
        _advance_user_session_watermark_or_503(
            store,
            target,
            reason="admin-user-deactivated",
            updated_by=actor.id,
            deactivate=True,
            expected_role=expected_role,
            expected_tenant_id=expected_tenant_id,
        )
        # Removing an account removes its personalization memory with it.
        # Nobody, including the admin doing this, sees the content on the way
        # out. Deactivation is reversible, so the user's own memory settings —
        # including a recorded opt-out — survive for their possible return
        # instead of silently resetting capture to the defaults.
        memory_settings = store.user_memory_settings_for(user_id)
        removed_memories = store.purge_user_memories(user_id)
        store.save_user_memory_settings(memory_settings)
        store.record_audit(
            actor,
            "admin.user_deactivated",
            user_id,
            {"active": False, "memories_removed": removed_memories},
        )
        store.save_runtime_state()
        return {"status": "deactivated", "user_id": user_id}


@router.post("/users/{user_id}/sessions/revoke")
def revoke_user_sessions(
    user_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str | int]:
    """Invalidate every browser session issued before this administrator action."""

    require_admin_or_owner(actor)
    expected_actor_role = actor.role
    expected_actor_tenant_id = actor.tenant_id
    target = _get_user(user_id, store)
    expected_role = target.role
    expected_tenant_id = target.tenant_id
    assert_can_modify_user(
        actor,
        target,
        tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
    )
    with store._store_lock:
        _assert_current_admin_actor(
            actor,
            store,
            expected_role=expected_actor_role,
            expected_tenant_id=expected_actor_tenant_id,
        )
        assert_can_modify_user(
            actor,
            target,
            tenant_admins_can_create_admins=store.platform_settings.tenant_admins_can_create_admins,
        )
        issued_before_ms = _advance_user_session_watermark_or_503(
            store,
            target,
            reason="admin-user-sessions-revoked",
            updated_by=actor.id,
            deactivate=False,
            expected_role=expected_role,
            expected_tenant_id=expected_tenant_id,
        )
        store.record_audit(
            actor,
            "admin.user_sessions_revoked",
            target.id,
            {"issued_before_ms": issued_before_ms},
            runtime_state_changed=False,
        )
        return {
            "status": "revoked",
            "user_id": target.id,
            "issued_before_ms": issued_before_ms,
        }


@router.delete("/users/{user_id}")
def delete_user(
    user_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    """Permanently remove an account. Owners may delete admins and users;
    tenant admins may delete regular users in their own tenant."""
    require_admin_or_owner(actor)
    expected_actor_role = actor.role
    expected_actor_tenant_id = actor.tenant_id
    target = _get_user(user_id, store)
    expected_role = target.role
    expected_tenant_id = target.tenant_id
    expected_active = target.active
    _assert_user_delete_allowed(actor, target)
    with store._store_lock:
        _assert_current_admin_actor(
            actor,
            store,
            expected_role=expected_actor_role,
            expected_tenant_id=expected_actor_tenant_id,
        )
        _assert_user_delete_allowed(actor, target)
        try:
            removed = store.delete_user_account(
                target.id,
                updated_by=actor.id,
                expected_user=target,
                expected_role=expected_role,
                expected_tenant_id=expected_tenant_id,
                expected_active=expected_active,
                preserve_last_active_admin=True,
            )
        except LastActiveAdministrativeAccountError as exc:
            detail = (
                "This service-managed account cannot be removed."
                if exc.role == Role.PLATFORM_OWNER
                else "This action is blocked by administrative continuity policy."
            )
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from exc
        except SessionUserStateError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The user account changed while it was being deleted. Retry the request.",
            ) from exc
        except Exception as exc:  # noqa: BLE001 - account deletion must fail closed
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Session revocation is temporarily unavailable.",
            ) from exc
        # The user record is gone (and delete_user_account purged their
        # personalization memory with it — the removed counts carry a
        # content-free "user_memories" tally into the audit trail).
        # The audit metadata carries the identity for the immutable trail.
        store.record_audit(
            actor,
            "admin.user_deleted",
            user_id,
            {
                "display_name": target.display_name,
                "email": target.email,
                "role": target.role,
                **removed,
            },
        )
        store.save_runtime_state()
        return {"status": "deleted", "user_id": user_id}


# Regular-user-tier roles a tenant admin may act on (reset passwords, delete):
# never other admins or owners, regardless of the admin-delegation policy.
USER_TIER_ROLES = {Role.USER, Role.TEMP_USER, Role.POWER_USER, Role.AUDITOR, Role.AGENT_APPROVER}


def _assert_user_delete_allowed(actor: User, target: User) -> None:
    if target.id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Accounts cannot delete themselves. Ask another administrator.",
        )
    if target.role == Role.PLATFORM_OWNER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This service-managed account cannot be deleted from the Admin Console.",
        )
    if not is_platform_owner(actor) and (
        not same_tenant(actor, target) or target.role not in USER_TIER_ROLES
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant admins can only delete regular users in their own tenant.",
        )


@router.post("/users/{user_id}/password")
def reset_user_password(
    user_id: str,
    payload: AdminPasswordResetRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    require_admin_or_owner(actor)
    target = _get_user(user_id, store)
    if target.id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Change your own password from the account panel, where your current password is required.",
        )
    if target.role == Role.PLATFORM_OWNER:
        if not is_platform_owner(actor):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This service-managed account cannot be changed from the Admin Console.",
            )
        if target.id in store.password_credentials:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This service-managed account must change its password from its own account panel.",
            )
    if not is_platform_owner(actor):
        if not same_tenant(actor, target) or target.role not in USER_TIER_ROLES:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admins can only reset passwords for regular users in their own tenant.",
            )
    if not target.active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reactivate the account before setting its password.",
        )
    if len(payload.password) < 12:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Use a password with at least 12 characters.",
        )
    with store._store_lock:
        try:
            store.advance_user_session_watermark(
                target.id,
                target.tenant_id,
                reason="admin-password-reset",
                updated_by=actor.id,
                expected_user=target,
                expected_role=target.role,
            )
        except SessionUserStateError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The user changed while the password reset was being applied.",
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Session revocation is temporarily unavailable.",
            ) from exc
        store.set_password_credential(target.id, payload.password, temporary=payload.temporary)
        # A password only helps if the account can use local sign-in.
        target.auth_method = "local"
        store.record_audit(
            actor,
            "admin.password_reset",
            target.id,
            {"temporary": payload.temporary, "target_role": target.role},
        )
        store.save_runtime_state()
    return {"status": "password_set", "user_id": target.id, "temporary": payload.temporary}


@router.get(
    "/tenants/{tenant_id}/mfa-policy",
    response_model=TenantMfaPolicyResponse,
)
def get_tenant_mfa_policy(
    tenant_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantMfaPolicyResponse:
    require_admin_or_owner(actor)
    if tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    if actor.role != Role.PLATFORM_OWNER and actor.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant administrators can only view their own MFA policy.",
        )
    try:
        policy = store.application_state_repository.get_tenant_mfa_policy(tenant_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA policy is temporarily unavailable.",
        ) from exc
    return TenantMfaPolicyResponse(
        tenant_id=tenant_id,
        required=policy.required,
        generation=policy.generation,
    )


@router.patch(
    "/tenants/{tenant_id}/mfa-policy",
    response_model=TenantMfaPolicyResponse,
)
def update_tenant_mfa_policy(
    tenant_id: str,
    payload: TenantMfaPolicyUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantMfaPolicyResponse:
    require_admin_or_owner(actor)
    if tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    try:
        policy = store.set_tenant_mfa_policy(
            tenant_id=tenant_id,
            required=payload.required,
            expected_generation=payload.expected_generation,
            actor=actor,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except MfaStateConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except SessionUserStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA policy is temporarily unavailable.",
        ) from exc
    store.record_audit(
        actor,
        "admin.tenant_mfa_policy_updated",
        tenant_id,
        {"required": policy.required, "generation": policy.generation},
        runtime_state_changed=False,
    )
    return TenantMfaPolicyResponse(
        tenant_id=tenant_id,
        required=policy.required,
        generation=policy.generation,
    )


@router.post("/users/{user_id}/mfa/reset", response_model=AdminMfaResetResponse)
def reset_user_mfa(
    user_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AdminMfaResetResponse:
    require_admin_or_owner(actor)
    target = _get_user(user_id, store)
    try:
        existed = store.reset_user_mfa_as_admin(target=target, actor=actor)
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except SessionUserStateError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA reset is temporarily unavailable.",
        ) from exc
    store.record_audit(
        actor,
        "admin.user_mfa_reset",
        target.id,
        {"factor_existed": existed, "tenant_id": target.tenant_id},
        runtime_state_changed=False,
    )
    return AdminMfaResetResponse(factor_existed=existed)


@router.get("/groups")
def groups(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[Group]:
    require_admin_or_owner(actor)
    visible = store.groups_with_live_counts()
    if actor.role == Role.PLATFORM_OWNER:
        return visible
    return [group for group in visible if group.tenant_id == actor.tenant_id]


@router.post("/groups", status_code=201)
def create_group(
    payload: GroupCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Group:
    require_admin_or_owner(actor)
    return _create_group(payload, actor, store)


@router.post("/groups/bulk", status_code=201)
def create_groups_bulk(
    payload: GroupBulkCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[Group]:
    require_admin_or_owner(actor)
    return [_create_group(group_payload, actor, store) for group_payload in payload.groups]


@router.patch("/groups/{group_id}")
def update_group(
    group_id: str,
    payload: GroupUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Group:
    require_admin_or_owner(actor)
    group = _get_group(group_id, actor, store)
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No group updates provided."
        )
    if payload.name is not None:
        _assert_unique_group_identity(
            store, group.tenant_id, name=payload.name, exclude_group_id=group.id
        )
    if payload.entra_object_id is not None:
        _assert_unique_group_identity(
            store,
            group.tenant_id,
            entra_object_id=payload.entra_object_id,
            exclude_group_id=group.id,
        )
    normalized_permissions = (
        # PATCH is a partial update: flags the caller did not send keep the
        # group's current value instead of falling back to the defaults.
        normalize_group_permissions(payload.permissions, base=group.permissions)
        if payload.permissions is not None
        else None
    )
    with store._store_lock:
        if normalized_permissions is not None:
            _assert_downstream_api_group_grant_allowed(
                store,
                current_enabled=bool(group.permissions.get("api_access", False)),
                replacement_enabled=bool(normalized_permissions.get("api_access", False)),
            )
        for field, value in updates.items():
            if value is not None:
                if field == "permissions":
                    value = normalized_permissions
                setattr(group, field, value)
        store.record_audit(actor, "admin.group_updated", group.id, updates)
        store.save_runtime_state()
        return group


@router.delete("/groups/{group_id}")
def delete_group(
    group_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    group = _get_group(group_id, actor, store)
    _assert_group_deletable(group)
    with store._store_lock:
        _delete_group_record(group.id, actor, store)
    store.save_runtime_state()
    return {"status": "deleted", "id": group.id}


@router.post("/groups/bulk-delete")
def delete_groups_bulk(
    payload: GroupBulkDeleteRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, list[str]]:
    require_admin_or_owner(actor)
    deleted: list[str] = []
    with store._store_lock:
        groups_to_delete = [_get_group(group_id, actor, store) for group_id in payload.group_ids]
        for group in groups_to_delete:
            _assert_group_deletable(group)
        deleting_ids = {group.id for group in groups_to_delete}
        affected_users = sorted(
            (user for user in store.users.values() if deleting_ids.intersection(user.group_ids)),
            key=lambda user: user.id,
        )
        try:
            for user in affected_users:
                store.advance_user_session_watermark(
                    user.id,
                    user.tenant_id,
                    reason="group-membership-removed",
                    updated_by=actor.id,
                    expected_user=user,
                    expected_role=user.role,
                )
        except SessionUserStateError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A group member changed while groups were being deleted.",
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Session revocation is temporarily unavailable.",
            ) from exc
        for group in groups_to_delete:
            _delete_group_record(group.id, actor, store, revoke_members=False)
            deleted.append(group.id)
    store.save_runtime_state()
    return {"deleted_group_ids": deleted}


@router.get("/model-access")
def model_access(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[ModelConfig]:
    require_admin_or_owner(actor)
    return _enabled_model_catalog(store, actor)


@router.post("/model-access-sync")
def sync_model_access(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[ModelConfig]:
    require_admin_or_owner(actor)
    _sync_provider_catalogs_for_admin(actor, store)
    return _enabled_model_catalog(store, actor)


@router.patch("/model-access/{model_id}")
def update_model_access(
    model_id: str,
    payload: AdminModelAccessUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ModelConfig:
    require_admin_or_owner(actor)
    model = _resolve_model_for_admin_access(model_id, actor, store)
    if model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown model.")
    if not model.platform_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Model is disabled by platform policy."
        )
    _assert_model_access_delegated(actor, model, store)
    _assert_group_scope(
        actor,
        payload.group_ids,
        store,
        tenant_id=model.tenant_id or actor.tenant_id,
    )
    previous_group_ids = list(model.group_ids)
    if actor.role == Role.PLATFORM_OWNER:
        model.group_ids = list(dict.fromkeys(payload.group_ids))
    else:
        own_group_ids = {
            group_id
            for group_id, group in store.groups.items()
            if group.tenant_id == actor.tenant_id
        }
        retained = [group_id for group_id in model.group_ids if group_id not in own_group_ids]
        model.group_ids = list(dict.fromkeys([*retained, *payload.group_ids]))
    model.tenant_restricted = True
    store.record_audit(
        actor,
        "admin.model_access_updated",
        model.id,
        {
            "group_ids": model.group_ids,
            "previous_group_ids": previous_group_ids,
            "provider_id": model.provider_id,
        },
    )
    store.save_runtime_state()
    return model


@router.get("/content-filters")
def content_filters(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[ContentFilter]:
    require_admin_or_owner(actor)
    return builtin_content_filters() + _visible_tenant_records(store.content_filters, actor)


def _validate_content_filter_fields(name: str, description: str, rules: list) -> None:
    if not name.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Filter name is required."
        )
    if len(name) > MAX_NAME_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Filter name is limited to {MAX_NAME_LENGTH} characters.",
        )
    if len(description) > MAX_DESCRIPTION_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Filter description is limited to {MAX_DESCRIPTION_LENGTH} characters.",
        )
    try:
        validate_content_filter_rules(rules)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/content-filters", status_code=201)
def create_content_filter(
    payload: ContentFilterCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ContentFilter:
    require_admin_or_owner(actor)
    _validate_content_filter_fields(payload.name, payload.description, payload.rules)
    tenant_id = _tenant_id_for_config(actor, payload.tenant_id, store)
    filter_id = payload.id or f"cf-{uuid4()}"
    if is_builtin_filter_id(filter_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Custom filter ids cannot use the built-in preset prefix.",
        )
    _assert_new_config_id(filter_id, store.content_filters)
    content_filter = ContentFilter(
        id=filter_id,
        tenant_id=tenant_id,
        name=payload.name.strip(),
        description=payload.description.strip(),
        builtin=False,
        rules=payload.rules,
        created_by=actor.id,
    )
    store.content_filters[content_filter.id] = content_filter
    store.record_audit(
        actor,
        "admin.content_filter_created",
        content_filter.id,
        {
            "name": content_filter.name,
            "rule_count": len(content_filter.rules),
            "rule_ids": [rule.id for rule in content_filter.rules],
        },
    )
    return content_filter


@router.patch("/content-filters/{filter_id}")
def update_content_filter(
    filter_id: str,
    payload: ContentFilterUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ContentFilter:
    require_admin_or_owner(actor)
    if is_builtin_filter_id(filter_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Preset filters are read-only. Create a custom filter to change the rules.",
        )
    content_filter = _get_tenant_record(filter_id, store.content_filters, actor)
    _validate_content_filter_fields(
        payload.name if payload.name is not None else content_filter.name,
        payload.description if payload.description is not None else content_filter.description,
        payload.rules if payload.rules is not None else content_filter.rules,
    )
    if payload.name is not None:
        content_filter.name = payload.name.strip()
    if payload.description is not None:
        content_filter.description = payload.description.strip()
    if payload.rules is not None:
        content_filter.rules = payload.rules
    content_filter.updated_at = "Just now"
    store.record_audit(
        actor,
        "admin.content_filter_updated",
        content_filter.id,
        {
            "name": content_filter.name,
            "rule_count": len(content_filter.rules),
            "rule_ids": [rule.id for rule in content_filter.rules],
        },
    )
    return content_filter


@router.delete("/content-filters/{filter_id}")
def delete_content_filter(
    filter_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    if is_builtin_filter_id(filter_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Preset filters cannot be deleted; detach them from models instead.",
        )
    content_filter = _get_tenant_record(filter_id, store.content_filters, actor)
    del store.content_filters[content_filter.id]
    for model in store.models.values():
        if content_filter.id in model.content_filter_ids:
            model.content_filter_ids = [
                existing_id
                for existing_id in model.content_filter_ids
                if existing_id != content_filter.id
            ]
    store.record_audit(
        actor,
        "admin.content_filter_deleted",
        content_filter.id,
        {"name": content_filter.name},
    )
    return {"status": "deleted", "id": content_filter.id}


@router.post("/content-filters/preview")
def preview_content_filter(
    payload: ContentFilterPreviewRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ContentFilterPreviewResponse:
    """Dry-run a rule set against sample text so admins can test before saving.

    Nothing is persisted and no alert is raised; scope is ignored so the admin
    sees every rule's behavior against the sample.
    """
    require_admin_or_owner(actor)
    try:
        validate_content_filter_rules(payload.rules)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    sample = payload.sample[:MAX_PREVIEW_SAMPLE_CHARS]
    preview_rules = [rule.model_copy(update={"applies_to": "both"}) for rule in payload.rules]
    draft = ContentFilter(id="cf-preview", name="Preview", rules=preview_rules)
    evaluation = evaluate_content_filters([draft], sample, "input")
    return ContentFilterPreviewResponse(
        matches=[
            ContentFilterRuleMatchSummary(
                rule_id=match.rule_id,
                label=match.label,
                action=match.action,
                match_count=match.match_count,
            )
            for match in evaluation.blocked + evaluation.redactions
        ],
        redacted_sample=evaluation.text,
        would_block=bool(evaluation.blocked),
    )


@router.put("/model-access/{model_id}/content-filters")
def update_model_content_filters(
    model_id: str,
    payload: ModelContentFiltersUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ModelConfig:
    require_admin_or_owner(actor)
    model = _resolve_model_for_admin_access(model_id, actor, store)
    if model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown model.")
    if not model.platform_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Model is disabled by platform policy."
        )
    _assert_model_access_delegated(actor, model, store)
    visible_custom_ids = {
        record.id for record in _visible_tenant_records(store.content_filters, actor)
    }
    builtin_ids = {preset.id for preset in builtin_content_filters()}
    unknown = [
        filter_id
        for filter_id in payload.content_filter_ids
        if filter_id not in visible_custom_ids and filter_id not in builtin_ids
    ]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown content filter: {unknown[0]}",
        )
    previous_filter_ids = list(model.content_filter_ids)
    model.content_filter_ids = list(dict.fromkeys(payload.content_filter_ids))
    store.record_audit(
        actor,
        "admin.model_content_filters_updated",
        model.id,
        {
            "content_filter_ids": model.content_filter_ids,
            "previous_content_filter_ids": previous_filter_ids,
            "provider_id": model.provider_id,
        },
    )
    store.save_runtime_state()
    return model


@router.post("/agent-profiles", status_code=201)
def create_agent_profile(
    payload: ModelCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ModelConfig:
    assert_agent_authoring(actor, store.groups, store.platform_settings)
    _assert_hermes_companion_permitted(actor, store, payload.agentic_companion)
    if not _is_agent_profile_admin(actor):
        # A granted user authors agents for themselves only: no group sharing,
        # no tenant-wide publication, and the creator is pinned to the actor so
        # ownership cannot be spoofed through the payload.
        payload.group_ids = []
        payload.visibility = "private"
        payload.created_by = actor.id
    tenant_id = _tenant_id_for_config(actor, payload.tenant_id, store)
    provider = _get_provider(payload.provider_id, store)
    _assert_agent_profile_references(actor, store, payload, tenant_id=tenant_id)
    is_owner = actor.role == Role.PLATFORM_OWNER
    # Non-owners cannot platform-enable a profile or route an unapproved upstream
    # model through the platform provider key.
    platform_enabled = payload.platform_enabled if is_owner else False
    if not is_owner:
        _assert_agent_profile_target_approved(actor, store, provider.id, payload.upstream_model_id)
    model_id = payload.id or f"agent-{uuid4()}"
    if model_id in store.models:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Agent profile already exists."
        )
    model = ModelConfig(
        id=model_id,
        tenant_id=tenant_id,
        provider_id=provider.id,
        provider_name=provider.name,
        name=payload.name,
        upstream_model_id=payload.upstream_model_id,
        system_prompt=payload.system_prompt,
        meta_prompt=payload.meta_prompt,
        knowledge_config_ids=payload.knowledge_config_ids,
        tool_config_ids=payload.tool_config_ids,
        platform_enabled=platform_enabled,
        tenant_restricted=payload.tenant_restricted,
        group_ids=payload.group_ids,
        notes=payload.notes,
        is_custom=True,
        created_by=payload.created_by or actor.display_name,
        context_window=payload.context_window
        or _inherited_context_window(store, provider.id, payload.upstream_model_id),
        visibility=payload.visibility,
        agentic_companion=payload.agentic_companion,
        prompt_template_ids=payload.prompt_template_ids,
        skill_file_ids=payload.skill_file_ids,
        admin_delete_locked=payload.admin_delete_locked
        if actor.role == Role.PLATFORM_OWNER
        else False,
        content_filter_ids=payload.content_filter_ids,
    )
    store.models[model.id] = model
    provider.model_count += 1
    if model.platform_enabled:
        provider.enabled_model_count += 1
    store.record_audit(
        actor,
        "admin.agent_profile_created",
        model.id,
        {"provider_id": model.provider_id, "name": model.name, "visibility": model.visibility},
    )
    return model


@router.patch("/agent-profiles/{model_id}")
def update_agent_profile(
    model_id: str,
    payload: ModelUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ModelConfig:
    assert_agent_authoring(actor, store.groups, store.platform_settings)
    model = _get_agent_profile_for_admin(model_id, actor, store)
    _assert_agent_profile_authoring_scope(actor, model)
    updates = payload.model_dump(exclude_unset=True)
    _assert_hermes_companion_permitted(actor, store, updates.get("agentic_companion"))
    if not _is_agent_profile_admin(actor):
        # Granted users edit the contents of their own agents; sharing and
        # ownership stay where the create route pinned them.
        for locked_field in ("group_ids", "visibility", "created_by"):
            updates.pop(locked_field, None)
        payload.group_ids = None
    if actor.role != Role.PLATFORM_OWNER:
        updates.pop("admin_delete_locked", None)
        if "tenant_id" in updates and updates["tenant_id"] != model.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Tenant admins cannot move agent profiles across tenants.",
            )
        updates.pop("tenant_id", None)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No agent profile updates provided."
        )
    effective_tenant_id = (
        str(updates["tenant_id"]) if updates.get("tenant_id") is not None else model.tenant_id
    )
    if effective_tenant_id is None:
        effective_tenant_id = _tenant_id_for_config(actor, None, store)
    if effective_tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    _assert_agent_profile_references(
        actor,
        store,
        payload,
        tenant_id=effective_tenant_id,
        existing=model,
    )
    if actor.role != Role.PLATFORM_OWNER:
        # Non-owners cannot flip platform-enablement or retarget to an unapproved
        # upstream model/provider.
        updates.pop("platform_enabled", None)
        effective_provider_id = (
            str(updates["provider_id"]) if updates.get("provider_id") else model.provider_id
        )
        effective_upstream = (
            updates["upstream_model_id"]
            if "upstream_model_id" in updates
            else model.upstream_model_id
        )
        _assert_agent_profile_target_approved(
            actor, store, effective_provider_id, effective_upstream
        )

    old_provider_id = model.provider_id
    old_platform_enabled = model.platform_enabled
    if "provider_id" in updates and updates["provider_id"] is not None:
        provider = _get_provider(str(updates["provider_id"]), store)
        model.provider_id = provider.id
        model.provider_name = provider.name
    for field, value in updates.items():
        if field == "provider_id" or value is None:
            continue
        setattr(model, field, value)
    model.tenant_id = effective_tenant_id
    model.is_custom = True
    if not model.created_by:
        model.created_by = actor.display_name
    _adjust_model_counts(store, old_provider_id, old_platform_enabled, model)
    store.record_audit(
        actor,
        "admin.agent_profile_updated",
        model.id,
        {"provider_id": model.provider_id, "name": model.name, "visibility": model.visibility},
    )
    return model


@router.delete("/agent-profiles/{model_id}")
def delete_agent_profile(
    model_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    assert_agent_authoring(actor, store.groups, store.platform_settings)
    model = _get_agent_profile_for_admin(model_id, actor, store)
    _assert_agent_profile_authoring_scope(actor, model)
    if model.admin_delete_locked and actor.role != Role.PLATFORM_OWNER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This agent profile is locked by organization policy.",
        )
    _delete_agent_profile_model(model, actor, store, "admin.agent_profile_deleted")
    return {"status": "deleted", "id": model.id}


def _assert_hermes_companion_permitted(
    actor: User, store: SeedStore, agentic_companion: object
) -> None:
    """Saving a Hermes-enabled profile requires the admin-granted permission.

    The gate applies to every role: the admin team enables the
    hermes_companion group permission first, then Hermes can be attached to
    agent profiles. Non-Hermes saves are never affected.
    """
    if agentic_companion != hermes.HERMES_COMPANION:
        return
    if not hermes_companion_allowed(actor, store.groups):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "The Hermes companion is disabled for this workspace. An admin can "
                "enable the 'Hermes companion' group permission under Admin → Users & groups."
            ),
        )


@router.get("/agent-profiles/{model_id}/hermes-memories")
def hermes_memories(
    model_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[CompanionMemory]:
    """Memories the Hermes companion saved for this profile, newest first."""
    require_admin_or_owner(actor)
    model = _get_agent_profile_for_admin(model_id, actor, store)
    return hermes.profile_memories(store, model.id)


@router.delete("/agent-profiles/{model_id}/hermes-memories/{memory_id}")
def delete_hermes_memory(
    model_id: str,
    memory_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    model = _get_agent_profile_for_admin(model_id, actor, store)
    memory = store.companion_memories.get(memory_id)
    if memory is None or memory.profile_id != model.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That Hermes memory does not exist for this profile.",
        )
    del store.companion_memories[memory_id]
    store.save_runtime_state()
    store.record_audit(actor, "hermes.memory_deleted", memory_id, {"profile_id": model.id})
    return {"status": "deleted", "id": memory_id}


@router.get("/connectors")
def connectors(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[Connector]:
    require_admin_or_owner(actor)
    return [
        connector.model_copy(update={"secret_visible_to_admin": False})
        for connector in store.connectors.values()
        if connector.platform_enabled
    ]


@router.get("/connector-configs")
def connector_configs(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[ConnectorConfig]:
    require_admin_or_owner(actor)
    return _visible_tenant_records(store.connector_configs, actor)


@router.post("/connector-configs", status_code=201)
def create_connector_config(
    payload: ConnectorConfigCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ConnectorConfig:
    require_admin_or_owner(actor)
    connector = store.connectors.get(payload.connector_id)
    if connector is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown connector.")
    if not connector.platform_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Connector is disabled by platform policy.",
        )
    tenant_id = _tenant_id_for_config(actor, payload.tenant_id, store)
    config_id = payload.id or f"conncfg-{uuid4()}"
    _assert_new_config_id(config_id, store.connector_configs)
    config = ConnectorConfig(
        id=config_id,
        tenant_id=tenant_id,
        connector_id=payload.connector_id,
        enabled=payload.enabled,
        auth_type=payload.auth_type,
        scopes=payload.scopes,
        settings=payload.settings,
        secret_set=False,
        masked_secret=None,
    )
    # Relational authority validates that every ciphertext has a live owner.
    # Attach the resource before writing any of its scoped secrets.
    store.connector_configs[config.id] = config
    masked_secret = _save_secret_if_present(store, "connector", config_id, payload.secret_value)
    if masked_secret is not None:
        config.secret_set = True
        config.masked_secret = masked_secret
    _save_secret_if_present(store, "connector-password", config.id, payload.service_password)
    store.record_audit(actor, "admin.connector_config_created", config.id, payload.model_dump())
    return config


@router.patch("/connector-configs/{config_id}")
def update_connector_config(
    config_id: str,
    payload: ConnectorConfigUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ConnectorConfig:
    require_admin_or_owner(actor)
    config = _get_tenant_record(config_id, store.connector_configs, actor)
    updates = payload.model_dump(exclude_unset=True)
    replace_settings = bool(updates.pop("replace_settings", False))
    clear_secret = bool(updates.pop("clear_secret", False))
    clear_oauth = bool(updates.pop("clear_oauth", False))
    clear_service_password = bool(updates.pop("clear_service_password", False))
    if payload.connector_id is not None and payload.connector_id not in store.connectors:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown connector.")
    if replace_settings and isinstance(updates.get("settings"), dict):
        config.settings = dict(updates.pop("settings"))
    _apply_config_updates(config, updates)
    if clear_secret:
        store.delete_configuration_secret("connector", config.id)
        config.secret_set = False
        config.masked_secret = None
    if clear_oauth:
        store.delete_configuration_secret("connector-oauth", config.id)
        store.delete_configuration_secret_prefix("connector-user-oauth", f"{config.id}:")
        for key in ("oauth_status", "oauth_connected_at", "oauth_user", "oauth_error"):
            config.settings.pop(key, None)
    if clear_service_password:
        store.delete_configuration_secret("connector-password", config.id)
    masked_secret = _save_secret_if_present(store, "connector", config.id, payload.secret_value)
    if masked_secret is not None:
        config.secret_set = True
        config.masked_secret = masked_secret
    _save_secret_if_present(store, "connector-password", config.id, payload.service_password)
    store.record_audit(actor, "admin.connector_config_updated", config.id, updates)
    return config


@router.delete("/connector-configs/{config_id}")
def delete_connector_config(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    config = _get_tenant_record(config_id, store.connector_configs, actor)
    linked_knowledge = [
        knowledge.name
        for knowledge in store.knowledge_configs.values()
        if knowledge.connector_config_id == config.id
    ]
    if linked_knowledge:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This connector configuration is used by knowledge bases: "
                + ", ".join(sorted(linked_knowledge))
                + ". Remove or repoint them first."
            ),
        )
    store.delete_configuration_secret("connector", config.id)
    store.delete_configuration_secret("connector-oauth", config.id)
    store.delete_configuration_secret_prefix("connector-user-oauth", f"{config.id}:")
    store.delete_configuration_secret("connector-password", config.id)
    del store.connector_configs[config.id]
    store.record_audit(
        actor,
        "admin.connector_config_deleted",
        config.id,
        {"connector_id": config.connector_id},
    )
    store.save_runtime_state()
    return {"status": "deleted", "id": config.id}


@router.get("/connector-configs/{config_id}/oauth/authorize")
def connector_oauth_authorize(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> RedirectResponse:
    """Start the Google Drive OAuth authorization flow for a connector config."""
    return RedirectResponse(
        url=_google_oauth_authorize_url(config_id, actor, store), status_code=302
    )


@router.get("/connector-configs/{config_id}/oauth/authorize-url")
def connector_oauth_authorize_url(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    """JSON variant for the SPA: it navigates to the returned consent URL itself."""
    return {"url": _google_oauth_authorize_url(config_id, actor, store)}


def _google_oauth_authorize_url(config_id: str, actor: User, store: SeedStore) -> str:
    require_admin_or_owner(actor)
    config = _get_tenant_record(config_id, store.connector_configs, actor)
    if config.connector_id != "google-drive":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Interactive OAuth authorization is only available for the Google Drive connector.",
        )
    auth_mode = connector_auth.connector_auth_mode(config)
    if auth_mode != "oauth-client":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Google Drive OAuth requires auth mode 'oauth-client'; this config uses '{auth_mode}'.",
        )
    missing: list[str] = []
    if not str(config.settings.get("client_id") or "").strip():
        missing.append("Client ID (client_id)")
    if not store.configuration_secret("connector", config.id):
        missing.append("Client secret (secret_value)")
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Save these before connecting Google Drive: {', '.join(missing)}.",
        )
    state = sign_oidc_state(
        {"config_id": config.id, "actor_id": actor.id}, get_settings().secret_key
    )
    authorization_url = (
        str(config.settings.get("authorization_url") or "").strip()
        or connector_auth.GOOGLE_AUTHORIZATION_URL
    )
    # access_type=offline + prompt=consent are required so Google re-issues a
    # refresh_token on every re-authorization, not just the first consent.
    params = urlencode(
        {
            "response_type": "code",
            "client_id": str(config.settings["client_id"]).strip(),
            "redirect_uri": connector_auth.connector_oauth_redirect_uri(),
            "scope": connector_auth.GOOGLE_DRIVE_SCOPE,
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        }
    )
    return f"{authorization_url}?{params}"


@router.post("/connector-configs/{config_id}/test")
def test_connector_config(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    """Live-verify connector credentials: required fields, token acquisition, API probe."""
    require_admin_or_owner(actor)
    config = _get_tenant_record(config_id, store.connector_configs, actor)
    result = connector_auth.run_connector_test(store, config)
    settings = dict(config.settings)
    settings["last_test_status"] = result["status"]
    settings["last_test_at"] = "Saved now"
    config.settings = settings
    store.record_audit(
        actor,
        "admin.connector_config_tested",
        config.id,
        {"status": result["status"], "connector_id": config.connector_id},
    )
    store.save_runtime_state()
    return result


@router.get("/sso-configs")
def sso_configs(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[SsoConfig]:
    require_admin_or_owner(actor)
    return _visible_tenant_records(store.sso_configs, actor)


@router.post("/sso-configs", status_code=201)
def create_sso_config(
    payload: SsoConfigCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SsoConfig:
    require_admin_or_owner(actor)
    _assert_sso_management_allowed(actor, store)
    with store._store_lock:
        _revalidate_sso_mutation_actor(actor, store)
        tenant_id = _tenant_id_for_config(actor, payload.tenant_id, store)
        config_id = payload.id or f"sso-{uuid4()}"
        _assert_new_config_id(config_id, store.sso_configs)
        # Record who authored the config so JIT provisioning can enforce the
        # tenant-admin-creation policy on a TENANT_ADMIN default_role.
        settings_payload = {**payload.settings, "authored_by_role": actor.role.value}
        config = SsoConfig(
            id=config_id,
            tenant_id=tenant_id,
            provider=payload.provider,
            issuer_url=payload.issuer_url,
            client_id=payload.client_id,
            enabled=payload.enabled,
            scopes=payload.scopes,
            mapped_groups=payload.mapped_groups,
            settings=settings_payload,
            secret_set=False,
            masked_secret=None,
        )
        store.sso_configs[config.id] = config
        masked_secret = _save_secret_if_present(store, "sso", config_id, payload.client_secret)
        if masked_secret is not None:
            config.secret_set = True
            config.masked_secret = masked_secret
        store.record_audit(actor, "admin.sso_config_created", config.id, payload.model_dump())
        return config


@router.patch("/sso-configs/{config_id}")
def update_sso_config(
    config_id: str,
    payload: SsoConfigUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SsoConfig:
    require_admin_or_owner(actor)
    _assert_sso_management_allowed(actor, store)
    with store._store_lock:
        _revalidate_sso_mutation_actor(actor, store)
        config = _get_tenant_record(config_id, store.sso_configs, actor)
        updates = payload.model_dump(exclude_unset=True)
        if updates:
            _invalidate_sso_configuration_context_or_503(store, config, actor)
        _apply_config_updates(config, updates)
        if actor.role != Role.PLATFORM_OWNER:
            # A tenant admin editing the config re-stamps authorship so they cannot
            # inherit an owner-authored stamp to smuggle in a TENANT_ADMIN default.
            config.settings = {**config.settings, "authored_by_role": actor.role.value}
        masked_secret = _save_secret_if_present(store, "sso", config.id, payload.client_secret)
        if masked_secret is not None:
            config.secret_set = True
            config.masked_secret = masked_secret
        store.record_audit(actor, "admin.sso_config_updated", config.id, updates)
        return config


@router.delete("/sso-configs/{config_id}")
def delete_sso_config(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    _assert_sso_management_allowed(actor, store)
    with store._store_lock:
        _revalidate_sso_mutation_actor(actor, store)
        config = _get_tenant_record(config_id, store.sso_configs, actor)
        _invalidate_sso_configuration_context_or_503(store, config, actor)
        store.delete_configuration_secret("sso", config.id)
        del store.sso_configs[config.id]
        store.record_audit(
            actor,
            "admin.sso_config_deleted",
            config.id,
            {"provider": config.provider, "issuer_url": config.issuer_url},
        )
        store.save_runtime_state()
        return {"status": "deleted", "id": config.id}


def _invalidate_sso_configuration_context_or_503(
    store: SeedStore,
    config: SsoConfig,
    actor: User,
) -> None:
    now = now_utc()
    user_ids = sorted(
        user.id
        for user in store.users.values()
        if user.tenant_id == config.tenant_id and user.auth_method == "sso"
    )
    try:
        store.application_state_repository.invalidate_sso_configuration_context(
            sso_config_id=config.id,
            tenant_id=config.tenant_id,
            user_ids=user_ids,
            now=now,
            issued_before_ms=int(now.timestamp() * 1000),
            updated_by=actor.id,
        )
    except Exception as exc:  # noqa: BLE001 - never mutate auth config without revocation
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SSO security-state revocation is temporarily unavailable.",
        ) from exc


def _revalidate_sso_mutation_actor(actor: User, store: SeedStore) -> None:
    if store.users.get(actor.id) is not actor or not actor.active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The SSO administrator changed while the update was being applied.",
        )
    require_admin_or_owner(actor)
    _assert_sso_management_allowed(actor, store)


@router.post("/sso-configs/{config_id}/test")
def test_sso_config(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    """Live-verify an OIDC configuration: fetch the discovery document and JWKS."""
    require_admin_or_owner(actor)
    _assert_sso_management_allowed(actor, store)
    config = _get_tenant_record(config_id, store.sso_configs, actor)

    protocol = str(config.settings.get("protocol") or "OIDC").upper()
    if protocol != "OIDC":
        return {
            "status": "unsupported",
            "message": "Live verification is only available for OIDC providers. SAML settings are stored but cannot be tested or used for sign-in yet.",
        }
    issuer = config.issuer_url.strip()
    if not issuer:
        return {"status": "failed", "message": "Set the issuer URL before testing."}

    checks: list[dict[str, str]] = []
    try:
        discovery = oidc.fetch_discovery_document(issuer)
        checks.append(
            {"name": "Discovery document", "status": "ok", "detail": oidc.discovery_url_for(issuer)}
        )
    except oidc.OidcError as exc:
        return {
            "status": "failed",
            "message": str(exc),
            "checks": [{"name": "Discovery document", "status": "failed", "detail": str(exc)}],
        }

    try:
        validate_public_url(discovery["jwks_uri"])
        # No redirect-following: a JWKS URI that redirects (e.g. to an internal
        # address) is rejected rather than followed past the egress check.
        jwks_response = httpx.get(discovery["jwks_uri"], timeout=10.0, follow_redirects=False)
        jwks_response.raise_for_status()
        key_count = len(jwks_response.json().get("keys", []))
        checks.append(
            {
                "name": "Signing keys (JWKS)",
                "status": "ok",
                "detail": f"{key_count} signing keys published",
            }
        )
    except (httpx.HTTPError, ValueError, EgressBlocked) as exc:
        checks.append({"name": "Signing keys (JWKS)", "status": "failed", "detail": str(exc)})
        return {"status": "failed", "message": f"JWKS fetch failed: {exc}", "checks": checks}

    missing: list[str] = []
    if not config.client_id.strip():
        missing.append("client ID")
    if not config.secret_set:
        missing.append("client secret")
    if not [d for d in (config.settings.get("domains") or []) if str(d).strip()]:
        missing.append("allowed email domains")
    status_value = "ok" if not missing else "incomplete"
    message = (
        "Issuer verified. Sign-in is ready: users on the allowed domains will be redirected to this provider."
        if not missing
        else "Issuer verified, but sign-in stays disabled until you add: "
        + ", ".join(missing)
        + "."
    )
    checks.append(
        {
            "name": "Sign-in readiness",
            "status": "ok" if not missing else "incomplete",
            "detail": message,
        }
    )
    store.record_audit(
        actor, "admin.sso_config_tested", config.id, {"status": status_value, "issuer": issuer}
    )
    return {
        "status": status_value,
        "message": message,
        "issuer": discovery["issuer"],
        "authorization_endpoint": discovery["authorization_endpoint"],
        "token_endpoint": discovery["token_endpoint"],
        "jwks_uri": discovery["jwks_uri"],
        "checks": checks,
    }


@router.get("/knowledge-configs")
def knowledge_configs(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[KnowledgeConfig]:
    require_admin_or_owner(actor)
    return _visible_tenant_records(store.knowledge_configs, actor)


@router.post("/knowledge-configs", status_code=201)
def create_knowledge_config(
    payload: KnowledgeConfigCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeConfig:
    assert_knowledge_authoring(actor, store.groups)
    if not _is_agent_profile_admin(actor):
        # A granted user authors knowledge bases for themselves only: no group
        # sharing, ownership pinned to the actor, and always in their own
        # tenant, so none of it can be spoofed through the payload.
        payload.tenant_id = None
        payload.acl_group_ids = []
        payload.owner_user_id = actor.id
    tenant_id = _tenant_id_for_config(actor, payload.tenant_id, store)
    _assert_group_scope(actor, payload.acl_group_ids, store, tenant_id=tenant_id)
    _assert_connector_config_scope(payload.connector_config_id, tenant_id, store)
    owner_user_id = payload.owner_user_id or actor.id
    _assert_knowledge_owner_scope(owner_user_id, tenant_id, store)
    config_id = payload.id or f"knowledge-{uuid4()}"
    _assert_new_config_id(config_id, store.knowledge_configs)
    config = KnowledgeConfig(
        id=config_id,
        tenant_id=tenant_id,
        name=payload.name,
        source_type=payload.source_type,
        connector_config_id=payload.connector_config_id,
        enabled=payload.enabled,
        acl_group_ids=payload.acl_group_ids,
        owner_user_id=owner_user_id,
        settings=payload.settings,
        secret_set=False,
        masked_secret=None,
    )
    store.knowledge_configs[config.id] = config
    masked_secret = _save_secret_if_present(store, "knowledge", config_id, payload.secret_value)
    if masked_secret is not None:
        config.secret_set = True
        config.masked_secret = masked_secret
    store.record_audit(actor, "admin.knowledge_config_created", config.id, payload.model_dump())
    return config


@router.patch("/knowledge-configs/{config_id}")
def update_knowledge_config(
    config_id: str,
    payload: KnowledgeConfigUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeConfig:
    config = _get_tenant_record(config_id, store.knowledge_configs, actor)
    if not _is_agent_profile_admin(actor):
        assert_knowledge_authoring(actor, store.groups)
        _assert_owned_config_scope(actor, config.owner_user_id, "knowledge base")
        # Granted users keep their records private and self-owned.
        if payload.acl_group_ids not in (None, []):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Sharing a knowledge base with groups is managed by administrators.",
            )
        if payload.owner_user_id not in (None, actor.id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Knowledge base ownership is managed by administrators.",
            )
    updates = payload.model_dump(exclude_unset=True)
    if payload.acl_group_ids is not None:
        _assert_group_scope(actor, payload.acl_group_ids, store, tenant_id=config.tenant_id)
    if payload.connector_config_id is not None:
        _assert_connector_config_scope(payload.connector_config_id, config.tenant_id, store)
    if payload.owner_user_id is not None:
        _assert_knowledge_owner_scope(payload.owner_user_id, config.tenant_id, store)
    _apply_config_updates(config, updates)
    masked_secret = _save_secret_if_present(store, "knowledge", config.id, payload.secret_value)
    if masked_secret is not None:
        config.secret_set = True
        config.masked_secret = masked_secret
    store.record_audit(actor, "admin.knowledge_config_updated", config.id, updates)
    return config


@router.delete("/knowledge-configs/{config_id}")
def delete_knowledge_config(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    config = _get_tenant_record(config_id, store.knowledge_configs, actor)
    if not _is_agent_profile_admin(actor):
        assert_knowledge_authoring(actor, store.groups)
        _assert_owned_config_scope(actor, config.owner_user_id, "knowledge base")
    store.delete_knowledge_config(config.id)
    store.record_audit(
        actor,
        "admin.knowledge_config_deleted",
        config.id,
        {"name": config.name, "source_type": config.source_type},
    )
    return {"status": "deleted", "id": config.id}


@router.get("/tool-configs")
def tool_configs(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[ToolConfig]:
    require_admin_or_owner(actor)
    return _visible_tenant_records(store.tool_configs, actor)


_STDIO_COMMAND_SETTING_KEYS = ("command", "args")


def _stdio_command_change_requested(
    incoming_settings: dict | None,
    existing_settings: dict | None = None,
) -> bool:
    """True if the payload introduces or changes an MCP stdio command/args/transport.

    Configuring a host command is equivalent to code execution on the API host,
    so only the platform owner may do it. A tenant-admin re-save that leaves the
    command untouched (or edits unrelated settings) returns False and is allowed.
    """
    if not isinstance(incoming_settings, dict):
        return False
    existing = existing_settings or {}
    for key in _STDIO_COMMAND_SETTING_KEYS:
        if key in incoming_settings and incoming_settings.get(key) != existing.get(key):
            return True
    incoming_transport = str(incoming_settings.get("transport") or "").strip().lower()
    existing_transport = str(existing.get("transport") or "").strip().lower()
    if incoming_transport == "stdio" and incoming_transport != existing_transport:
        return True
    return False


def _assert_valid_custom_script_settings(settings: dict | None) -> None:
    """Custom script tools are admin-creatable because — unlike MCP stdio
    commands — the script runs in a resource-limited subprocess with a clean
    environment, not with the API host's privileges and secrets."""
    settings = settings or {}
    try:
        validate_custom_script(
            str(settings.get("script") or ""),
            int(settings.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS),
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


def _tool_audit_metadata(metadata: dict) -> dict:
    """Audit trail records that a script exists and its size, never its code."""
    settings = metadata.get("settings")
    if isinstance(settings, dict) and "script" in settings:
        settings = dict(settings)
        script = settings.pop("script")
        settings["script_chars"] = len(script) if isinstance(script, str) else 0
        metadata = {**metadata, "settings": settings}
    return metadata


@router.post("/tool-configs", status_code=201)
def create_tool_config(
    payload: ToolConfigCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ToolConfig:
    assert_tool_authoring(actor, store.groups)
    if _stdio_command_change_requested(payload.settings) and not is_platform_owner(actor):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="MCP stdio commands are managed at the service level. "
            "Organization administrators can create HTTP or SSE MCP tools.",
        )
    if payload.tool_type == "custom_script":
        _assert_valid_custom_script_settings(payload.settings)
    if not _is_agent_profile_admin(actor):
        # A granted user authors tools for themselves only: no group sharing
        # and always in their own tenant, so neither can be spoofed through
        # the payload. Ownership is pinned below.
        payload.tenant_id = None
        payload.allowed_group_ids = []
    tenant_id = _tenant_id_for_config(actor, payload.tenant_id, store)
    _assert_group_scope(actor, payload.allowed_group_ids, store, tenant_id=tenant_id)
    config_id = payload.id or f"tool-{uuid4()}"
    _assert_new_config_id(config_id, store.tool_configs)
    config = ToolConfig(
        id=config_id,
        tenant_id=tenant_id,
        name=payload.name,
        tool_type=payload.tool_type,
        endpoint_url=payload.endpoint_url,
        enabled=payload.enabled,
        approval_required=payload.approval_required,
        allowed_group_ids=payload.allowed_group_ids,
        owner_user_id=None if _is_agent_profile_admin(actor) else actor.id,
        settings=payload.settings,
        secret_set=False,
        masked_secret=None,
    )
    store.tool_configs[config.id] = config
    masked_secret = _save_secret_if_present(store, "tool", config_id, payload.secret_value)
    if masked_secret is not None:
        config.secret_set = True
        config.masked_secret = masked_secret
    store.record_audit(
        actor, "admin.tool_config_created", config.id, _tool_audit_metadata(payload.model_dump())
    )
    return config


@router.patch("/tool-configs/{config_id}")
def update_tool_config(
    config_id: str,
    payload: ToolConfigUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ToolConfig:
    config = _get_tenant_record(config_id, store.tool_configs, actor)
    if not _is_agent_profile_admin(actor):
        assert_tool_authoring(actor, store.groups)
        _assert_owned_config_scope(actor, config.owner_user_id, "tool")
        if payload.allowed_group_ids not in (None, []):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Sharing a tool with groups is managed by administrators.",
            )
    updates = payload.model_dump(exclude_unset=True)
    if _stdio_command_change_requested(payload.settings, config.settings) and not is_platform_owner(
        actor
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="MCP stdio commands are managed at the service level.",
        )
    next_tool_type = payload.tool_type or config.tool_type
    if next_tool_type == "custom_script" and (
        payload.tool_type is not None or payload.settings is not None
    ):
        _assert_valid_custom_script_settings({**config.settings, **(payload.settings or {})})
    if payload.allowed_group_ids is not None:
        _assert_group_scope(actor, payload.allowed_group_ids, store, tenant_id=config.tenant_id)
    _apply_config_updates(config, updates)
    masked_secret = _save_secret_if_present(store, "tool", config.id, payload.secret_value)
    if masked_secret is not None:
        config.secret_set = True
        config.masked_secret = masked_secret
    store.record_audit(actor, "admin.tool_config_updated", config.id, _tool_audit_metadata(updates))
    return config


@router.delete("/tool-configs/{config_id}")
def delete_tool_config(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    config = _get_tenant_record(config_id, store.tool_configs, actor)
    if not _is_agent_profile_admin(actor):
        assert_tool_authoring(actor, store.groups)
        _assert_owned_config_scope(actor, config.owner_user_id, "tool")
    store.delete_configuration_secret("tool", config.id)
    store.delete_configuration_secret("tool-oauth-token", config.id)
    del store.tool_configs[config.id]
    for model in store.models.values():
        if config.id in model.tool_config_ids:
            model.tool_config_ids = [
                tool_id for tool_id in model.tool_config_ids if tool_id != config.id
            ]
    store.record_audit(
        actor,
        "admin.tool_config_deleted",
        config.id,
        {"name": config.name, "tool_type": config.tool_type},
    )
    return {"status": "deleted", "id": config.id}


@router.post("/tool-configs/script-preview")
def preview_tool_script(
    payload: CustomScriptPreviewRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> CustomScriptRunResponse:
    """Test-run a custom tool script before saving it. Runs in the same
    sandbox as saved tools; nothing is persisted."""
    assert_tool_authoring(actor, store.groups)
    try:
        validate_custom_script(payload.script, payload.timeout_seconds)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    outcome = run_custom_script(payload.script, payload.input, payload.timeout_seconds)
    store.record_audit(
        actor,
        "admin.tool_script_previewed",
        "custom-script-preview",
        {
            "status": outcome.status,
            "duration_ms": outcome.duration_ms,
            "script_chars": len(payload.script),
            "input_chars": len(payload.input),
        },
    )
    return CustomScriptRunResponse(
        tool_config_id="",
        name="Script preview",
        status=outcome.status,
        output=outcome.output,
        error=outcome.error,
        exit_code=outcome.exit_code,
        duration_ms=outcome.duration_ms,
        truncated=outcome.truncated,
        artifacts=[artifact.__dict__ for artifact in outcome.artifacts],
    )


@router.get("/prompt-templates")
def prompt_templates(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[PromptTemplate]:
    require_admin_or_owner(actor)
    return _visible_tenant_records(store.prompt_templates, actor)


@router.post("/prompt-templates", status_code=201)
def create_prompt_template(
    payload: PromptTemplateCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> PromptTemplate:
    require_admin_or_owner(actor)
    tenant_id = _tenant_id_for_config(actor, payload.tenant_id, store)
    _assert_group_scope(actor, payload.group_ids, store, tenant_id=tenant_id)
    template_id = payload.id or f"template-{uuid4()}"
    _assert_new_config_id(template_id, store.prompt_templates)
    template = PromptTemplate(
        id=template_id,
        tenant_id=tenant_id,
        name=payload.name,
        description=payload.description,
        content=payload.content,
        category=payload.category,
        variables=payload.variables,
        group_ids=payload.group_ids,
        enabled=payload.enabled,
    )
    store.prompt_templates[template.id] = template
    store.record_audit(
        actor, "admin.prompt_template_created", template.id, _template_audit_payload(template)
    )
    return template


@router.patch("/prompt-templates/{template_id}")
def update_prompt_template(
    template_id: str,
    payload: PromptTemplateUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> PromptTemplate:
    require_admin_or_owner(actor)
    template = _get_tenant_record(template_id, store.prompt_templates, actor)
    updates = payload.model_dump(exclude_unset=True)
    if payload.group_ids is not None:
        _assert_group_scope(actor, payload.group_ids, store, tenant_id=template.tenant_id)
    _apply_config_updates(template, updates)
    template.updated_at = "Just now"
    store.record_audit(
        actor, "admin.prompt_template_updated", template.id, _template_audit_payload(template)
    )
    return template


@router.delete("/prompt-templates/{template_id}")
def delete_prompt_template(
    template_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    template = _get_tenant_record(template_id, store.prompt_templates, actor)
    del store.prompt_templates[template.id]
    for model in store.models.values():
        if template.id in model.prompt_template_ids:
            model.prompt_template_ids = [
                prompt_template_id
                for prompt_template_id in model.prompt_template_ids
                if prompt_template_id != template.id
            ]
    store.record_audit(
        actor, "admin.prompt_template_deleted", template.id, _template_audit_payload(template)
    )
    return {"status": "deleted", "id": template.id}


@router.get("/skill-files")
def skill_files(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[SkillFile]:
    require_admin_or_owner(actor)
    return _visible_tenant_records(store.skill_files, actor)


@router.post("/skill-files", status_code=201)
def create_skill_file(
    payload: SkillFileCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SkillFile:
    require_admin_or_owner(actor)
    tenant_id = _tenant_id_for_config(actor, payload.tenant_id, store)
    _assert_group_scope(actor, payload.group_ids, store, tenant_id=tenant_id)
    skill_id = payload.id or f"skill-{uuid4()}"
    _assert_new_config_id(skill_id, store.skill_files)
    skill = SkillFile(
        id=skill_id,
        tenant_id=tenant_id,
        name=payload.name,
        description=payload.description,
        content=payload.content,
        category=payload.category,
        format=payload.format,
        version=payload.version,
        group_ids=payload.group_ids,
        enabled=payload.enabled,
    )
    store.skill_files[skill.id] = skill
    store.record_audit(actor, "admin.skill_file_created", skill.id, _skill_audit_payload(skill))
    return skill


@router.patch("/skill-files/{skill_id}")
def update_skill_file(
    skill_id: str,
    payload: SkillFileUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SkillFile:
    require_admin_or_owner(actor)
    skill = _get_tenant_record(skill_id, store.skill_files, actor)
    updates = payload.model_dump(exclude_unset=True)
    if payload.group_ids is not None:
        _assert_group_scope(actor, payload.group_ids, store, tenant_id=skill.tenant_id)
    _apply_config_updates(skill, updates)
    skill.updated_at = "Just now"
    store.record_audit(actor, "admin.skill_file_updated", skill.id, _skill_audit_payload(skill))
    return skill


@router.delete("/skill-files/{skill_id}")
def delete_skill_file(
    skill_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    skill = _get_tenant_record(skill_id, store.skill_files, actor)
    del store.skill_files[skill.id]
    for model in store.models.values():
        if skill.id in model.skill_file_ids:
            model.skill_file_ids = [
                skill_file_id for skill_file_id in model.skill_file_ids if skill_file_id != skill.id
            ]
    store.record_audit(actor, "admin.skill_file_deleted", skill.id, _skill_audit_payload(skill))
    return {"status": "deleted", "id": skill.id}


# --- memory administration --------------------------------------------------
# Admins govern memory; they never read it. Everything below returns policy or
# counts, and the purge path deletes without ever exposing content.


def _memory_admin_tenant_id(actor: User, store: SeedStore) -> str:
    require_admin_or_owner(actor)
    if actor.role != Role.PLATFORM_OWNER:
        if actor.tenant_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin privileges are required.",
            )
        return actor.tenant_id
    # An owner previewing the admin console governs the primary tenant.
    first_tenant = next(iter(store.tenants), None)
    if first_tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No organization exists yet.",
        )
    return first_tenant


@router.get("/memory/policy")
def memory_policy(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantMemoryPolicy:
    tenant_id = _memory_admin_tenant_id(actor, store)
    return store.tenant_memory_policy(tenant_id)


@router.patch("/memory/policy")
def update_memory_policy(
    payload: TenantMemoryPolicyUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantMemoryPolicy:
    tenant_id = _memory_admin_tenant_id(actor, store)
    updates = payload.model_dump(exclude_unset=True)
    if updates.get("enabled") and not store.platform_settings.memory_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Personalization memory is unavailable under the current service policy.",
        )
    policy = store.tenant_memory_policy(tenant_id)
    changed: list[str] = []
    for field, value in updates.items():
        if value is None:
            continue
        setattr(policy, field, value)
        changed.append(field)
    policy.updated_at = clock.now_iso()
    policy.updated_by = actor.id
    saved = store.save_tenant_memory_policy(policy)
    store.record_audit(
        actor,
        "memory.policy_updated",
        tenant_id,
        {"changed": changed, "enabled": saved.enabled},
    )
    return saved


@router.get("/memory/stats")
def memory_stats(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[MemoryUserStat]:
    """Per-user memory counts. Deliberately carries no memory content."""
    tenant_id = _memory_admin_tenant_id(actor, store)
    return store.memory_counts_for_tenant(tenant_id)


# --- data retention administration ------------------------------------------
# Admins govern the retention policy; disposition itself runs in the
# scheduler sweep. These endpoints carry policy only, never chat content.


@router.get("/retention/policy")
def retention_policy(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantRetentionPolicy:
    tenant_id = _memory_admin_tenant_id(actor, store)
    return store.tenant_retention_policy(tenant_id)


@router.patch("/retention/policy")
def update_retention_policy(
    payload: TenantRetentionPolicyUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantRetentionPolicy:
    tenant_id = _memory_admin_tenant_id(actor, store)
    updates = payload.model_dump(exclude_unset=True)
    policy = store.tenant_retention_policy(tenant_id)
    changed: list[str] = []
    for field, value in updates.items():
        if value is None:
            continue
        if field == "rules":
            value = [RetentionRule.model_validate(item) for item in value]
        setattr(policy, field, value)
        changed.append(field)
    policy.updated_at = clock.now_iso()
    policy.updated_by = actor.id
    saved = store.save_tenant_retention_policy(policy)
    store.record_audit(
        actor,
        "retention.policy_updated",
        tenant_id,
        {"changed": changed, "enabled": saved.enabled},
    )
    return saved


@router.get("/retention/tagged-threads")
def retention_tagged_threads(
    namespace: str | None = None,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[RetentionTaggedThread]:
    """Tagged threads for the retention drilldown. Metadata only, no content."""
    tenant_id = _memory_admin_tenant_id(actor, store)
    tags = store.list_chat_thread_tags(tenant_id=tenant_id, namespace=namespace)
    grouped: dict[str, list] = {}
    for tag in tags:
        grouped.setdefault(tag.thread_id, []).append(tag)
    rows: list[RetentionTaggedThread] = []
    for thread_id, thread_tags in grouped.items():
        thread = store.chat_threads.get(thread_id)
        # The tags are tenant-scoped above; re-check the thread's tenant
        # before exposing its title so a stale cross-tenant id leaks nothing.
        in_tenant = thread is not None and thread.tenant_id == tenant_id
        rows.append(
            RetentionTaggedThread(
                thread_id=thread_id,
                title=thread.title if in_tenant else None,
                owner_user_id=thread.owner_user_id if in_tenant else None,
                tags=thread_tags,
            )
        )
    rows.sort(key=lambda row: (row.title or "", row.thread_id))
    return rows


@router.get("/retention/threads")
def retention_threads(
    limit: int = Query(default=200, ge=1, le=500),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[RetentionTaggedThread]:
    """Every chat in the tenant with its retention tags merged in.

    Backs the batch delete/archive picker: not every chat that needs
    disposition is tagged, so this lists them all (newest first, metadata
    only, never message content).
    """
    tenant_id = _memory_admin_tenant_id(actor, store)
    tags_by_thread: dict[str, list] = {}
    for tag in store.list_chat_thread_tags(tenant_id=tenant_id):
        tags_by_thread.setdefault(tag.thread_id, []).append(tag)
    matter_labels = store.application_state_repository.matter_labels_for_tenant(tenant_id)
    threads = store.application_state_repository.list_chat_threads(
        tenant_id=tenant_id, newest_first=True, limit=limit
    )
    rows = [
        RetentionTaggedThread(
            thread_id=thread.id,
            title=thread.title,
            owner_user_id=thread.owner_user_id,
            archived=thread.archived,
            matter_id=thread.matter_id,
            matter_label=matter_labels.get(thread.matter_id) if thread.matter_id else None,
            tags=tags_by_thread.pop(thread.id, []),
        )
        for thread in threads
    ]
    # Tags whose thread fell outside the page (or was deleted) stay visible
    # so cleanup is never hidden by pagination.
    for thread_id, thread_tags in tags_by_thread.items():
        rows.append(RetentionTaggedThread(thread_id=thread_id, tags=thread_tags))
    return rows


@router.get("/chat-feedback")
def chat_feedback(
    limit: int = Query(default=200, ge=1, le=1000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[ChatFeedbackRecord]:
    """Response sentiment with user notes, newest first.

    Tenant admins see the users they can already audit; owners see everyone,
    matching the prompt-activity visibility rules.
    """
    tenant_id = _memory_admin_tenant_id(actor, store)
    records = store.list_chat_feedback(tenant_id=tenant_id, limit=limit)
    if actor.role == Role.PLATFORM_OWNER:
        return records
    visible_user_ids = _admin_visible_user_ids(actor, store)
    return [record for record in records if record.user_id in visible_user_ids]


@router.post("/retention/batch")
def retention_batch(
    payload: RetentionBatchRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> RetentionBatchResult:
    """Batch delete or archive chats. Held threads are never deleted."""
    tenant_id = _memory_admin_tenant_id(actor, store)
    return batch_dispose_threads(
        store,
        actor,
        tenant_id=tenant_id,
        thread_ids=payload.thread_ids,
        action=payload.action,
    )


@router.post("/memory/users/{user_id}/purge")
def purge_user_memory(
    user_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, int]:
    """Compliance purge: delete a user's memories without reading them."""
    tenant_id = _memory_admin_tenant_id(actor, store)
    target = _get_user(user_id, store)
    if target.role == Role.PLATFORM_OWNER or target.tenant_id != tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    settings = store.user_memory_settings_for(user_id)
    removed = store.purge_user_memories(user_id)
    store.save_user_memory_settings(settings)
    store.record_audit(actor, "memory.admin_purged", user_id, {"removed": removed})
    return {"removed": removed}


@router.get("/audit-events")
def tenant_audit_events(
    limit: int = Query(default=200, ge=1, le=1000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[AuditEvent]:
    require_admin_or_owner(actor)
    # Tenant admins only see their tenant's events; platform-owner-only actions
    # (key reveals, provider mutations) are recorded without a tenant and never
    # appear here. Owners previewing this surface see all tenant-scoped events.
    tenant_id = actor.tenant_id if actor.role != Role.PLATFORM_OWNER else None
    events = store.tenant_audit_events_newest_first(tenant_id, limit)
    return decorate_audit_events(events)


@router.get("/usage-summary")
def tenant_usage_summary(
    user_id: str | None = Query(default=None),
    from_date: str | None = Query(default=None),
    through_date: str | None = Query(default=None),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, object]:
    require_admin_or_owner(actor)
    tenant_id = _admin_tenant_id(actor)
    visible_user_ids = _admin_visible_user_ids(actor, store)
    if user_id is not None and user_id not in visible_user_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    records = store.usage_records_filtered(
        tenant_id=tenant_id,
        visible_user_ids=visible_user_ids,
        user_id=user_id,
        from_date=from_date,
        through_date=through_date,
    )
    return build_usage_summary(records)


@router.get("/usage-records")
def tenant_usage_records(
    user_id: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=2000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[UsageRecord]:
    require_admin_or_owner(actor)
    tenant_id = _admin_tenant_id(actor)
    visible_user_ids = _admin_visible_user_ids(actor, store)
    if user_id is not None and user_id not in visible_user_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    records = store.usage_records_filtered(
        tenant_id=tenant_id,
        visible_user_ids=visible_user_ids,
        user_id=user_id,
        newest_first=True,
        limit=limit,
    )
    return records


@router.get("/usage-budget")
def tenant_usage_budget(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: TenantUsageBudgetRepository = Depends(get_usage_budget_repository),
) -> dict[str, object]:
    """Expose this tenant's exact UTC daily budget counters read-only."""

    require_admin_or_owner(actor)
    try:
        tenant_id = resolve_usage_tenant_id(
            actor,
            known_tenant_ids=store.tenants.keys(),
        )
        budget = repository.get_budget(tenant_id)
        if budget is None:
            raise UsageBudgetUnavailable("Tenant usage budget is not provisioned.")
        current = clock.now()
        period_usage = repository.get_period_usage(
            tenant_id,
            budget.budget_period,
            now=current,
        )
    except UsageTenantScopeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except UsageBudgetError as exc:
        failure = map_usage_budget_error(exc)
        raise HTTPException(
            status_code=failure.status_code,
            detail=failure.detail,
            headers=dict(failure.headers),
        ) from exc
    return {
        **budget.model_dump(),
        "limit_value": (
            budget.spend_limit_nanos / 1_000_000_000
            if budget.budget_unit == "usd"
            else budget.daily_token_limit
        ),
        "usage_date": utc_usage_date(current),
        "period_start": period_usage.period_start,
        "period_end": period_usage.period_end,
        "reported_tokens": period_usage.reported_tokens,
        "reported_tokens_overflowed": period_usage.reported_tokens_overflowed,
        "reported_cost_nanos": period_usage.reported_cost_nanos,
        "reported_cost_usd": period_usage.reported_cost_nanos / 1_000_000_000,
        "reported_cost_overflowed": period_usage.reported_cost_overflowed,
        "metered_completions": period_usage.metered_completions,
        "unmetered_completions": period_usage.unmetered_completions,
        "cost_metered_completions": period_usage.cost_metered_completions,
        "cost_unmetered_completions": period_usage.cost_unmetered_completions,
        # These counters are what the cap is enforced against, so they cover
        # every principal billed to the tenant. /usage-records and
        # /usage-summary are narrower: they only include users this actor may
        # see, which excludes platform owners. Without saying so, an admin
        # comparing the two totals reads the difference as a counter that never
        # resets and sets the ceiling far too low.
        "counts_all_tenant_principals": True,
        "scope_note": (
            "Counted across every user billed to this tenant, including "
            "platform owners who are not listed in per-user usage views."
        ),
    }


def _usage_scope_tenant_id(actor: User, store: SeedStore) -> str:
    """Tenant scope for admin usage routes. Tenant admins use their own
    tenant; a platform owner inherits the deployment's sole tenant
    (single-tenant posture) and gets an explicit error when ambiguous."""

    explicit = None
    if actor.role == Role.PLATFORM_OWNER and not actor.tenant_id and len(store.tenants) == 1:
        explicit = next(iter(store.tenants.keys()))
    return resolve_usage_tenant_id(
        actor,
        explicit_tenant_id=explicit,
        known_tenant_ids=store.tenants.keys(),
    )


def _allocation_display_name(
    store: SeedStore,
    tenant_id: str,
    principal_type: str,
    principal_id: str,
) -> str:
    if principal_type == "user":
        user = store.users.get(principal_id)
        if user is not None and user.tenant_id == tenant_id:
            return user.display_name
    else:
        group = store.groups.get(principal_id)
        if group is not None and group.tenant_id == tenant_id:
            return group.name
    return principal_id


def _require_allocation_principal(
    store: SeedStore,
    tenant_id: str,
    principal_type: str,
    principal_id: str,
) -> None:
    if principal_type == "user":
        user = store.users.get(principal_id)
        if user is None or user.tenant_id != tenant_id or user.role == Role.PLATFORM_OWNER:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Unknown user for this workspace.",
            )
        return
    group = store.groups.get(principal_id)
    if group is None or group.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown group for this workspace.",
        )


def _allocation_rows(
    store: SeedStore,
    repository: TenantUsageBudgetRepository,
    tenant_id: str,
) -> tuple[list[PrincipalBudgetAllocation], object]:
    current = clock.now()
    usage_date = utc_usage_date(current)
    budgets = repository.list_principal_budgets(tenant_id)
    allocations: list[PrincipalBudgetAllocation] = []
    for budget in budgets:
        reported_tokens, metered_completions, period_start, period_end, _ = (
            repository.get_principal_period_usage(
                tenant_id,
                principal_type=budget.principal_type,
                principal_id=budget.principal_id,
                budget_period=budget.budget_period,
                now=current,
            )
        )
        allocations.append(PrincipalBudgetAllocation(
            principal_type=budget.principal_type,
            principal_id=budget.principal_id,
            display_name=_allocation_display_name(
                store, tenant_id, budget.principal_type, budget.principal_id
            ),
            budget_period=budget.budget_period,
            daily_token_limit=budget.daily_token_limit,
            period_start=period_start,
            period_end=period_end,
            reported_tokens=reported_tokens,
            metered_completions=metered_completions,
            updated_at=budget.updated_at,
            updated_by=budget.updated_by,
        ))
    return allocations, usage_date


@router.get("/usage-allocations")
def tenant_usage_allocations(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: TenantUsageBudgetRepository = Depends(get_usage_budget_repository),
) -> dict[str, object]:
    """Per-user/per-group daily allocations inside the workspace ceiling."""

    require_admin_or_owner(actor)
    try:
        tenant_id = _usage_scope_tenant_id(actor, store)
        ceiling = repository.get_budget(tenant_id)
        allocations, usage_date = _allocation_rows(store, repository, tenant_id)
    except UsageTenantScopeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except UsageBudgetError as exc:
        failure = map_usage_budget_error(exc)
        raise HTTPException(status_code=failure.status_code, detail=failure.detail) from exc
    return {
        "usage_date": usage_date,
        "budget_unit": ceiling.budget_unit if ceiling is not None else "tokens",
        "budget_period": ceiling.budget_period if ceiling is not None else "day",
        "limit_value": (
            ceiling.spend_limit_nanos / 1_000_000_000
            if ceiling is not None and ceiling.budget_unit == "usd"
            else ceiling.daily_token_limit if ceiling is not None else 0
        ),
        "daily_token_limit": ceiling.daily_token_limit if ceiling is not None else 0,
        "allocations": [allocation.model_dump() for allocation in allocations],
    }


@router.put("/usage-allocations")
def set_tenant_usage_allocation(
    payload: PrincipalUsageBudgetUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: TenantUsageBudgetRepository = Depends(get_usage_budget_repository),
) -> dict[str, object]:
    require_admin_or_owner(actor)
    try:
        tenant_id = _usage_scope_tenant_id(actor, store)
    except UsageTenantScopeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    _require_allocation_principal(store, tenant_id, payload.principal_type, payload.principal_id)
    try:
        budget = repository.set_principal_budget(
            tenant_id=tenant_id,
            principal_type=payload.principal_type,
            principal_id=payload.principal_id,
            budget_period=payload.budget_period,
            daily_token_limit=payload.daily_token_limit,
            updated_by=actor.id,
        )
    except UsageBudgetError as exc:
        failure = map_usage_budget_error(exc)
        raise HTTPException(status_code=failure.status_code, detail=failure.detail) from exc
    store.record_audit(
        actor,
        "usage.allocation_set",
        f"{payload.principal_type}:{payload.principal_id}",
        {
            "tenant_id": tenant_id,
            "principal_type": payload.principal_type,
            "principal_id": payload.principal_id,
            "budget_period": payload.budget_period,
            "daily_token_limit": payload.daily_token_limit,
        },
    )
    return budget.model_dump()


@router.delete("/usage-allocations/{principal_type}/{principal_id}")
def delete_tenant_usage_allocation(
    principal_type: str,
    principal_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: TenantUsageBudgetRepository = Depends(get_usage_budget_repository),
) -> dict[str, object]:
    require_admin_or_owner(actor)
    if principal_type not in ("user", "group"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown allocation type."
        )
    try:
        tenant_id = _usage_scope_tenant_id(actor, store)
    except UsageTenantScopeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    removed = repository.delete_principal_budget(
        tenant_id=tenant_id,
        principal_type=principal_type,
        principal_id=principal_id,
    )
    if not removed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No allocation to remove."
        )
    store.record_audit(
        actor,
        "usage.allocation_removed",
        f"{principal_type}:{principal_id}",
        {"tenant_id": tenant_id},
    )
    return {"removed": True}


def _admin_alert_rule_tenant_id(actor: User, store: SeedStore) -> str:
    return _tenant_id_for_config(actor, None, store)


def _apply_alert_rule_payload(
    rule: AlertRule,
    payload: AlertRuleCreateRequest | AlertRuleUpdateRequest,
    *,
    visible_user_ids: set[str] | None,
) -> AlertRule:
    """Copy validated request fields onto ``rule``; raises 400 on bad values."""
    try:
        if payload.name is not None:
            rule.name = payload.name.strip() or rule.name
        if payload.description is not None:
            rule.description = payload.description.strip()
        if payload.enabled is not None:
            rule.enabled = payload.enabled
        if payload.action_patterns is not None:
            rule.action_patterns = normalize_action_patterns(payload.action_patterns)
        if payload.min_severity is not None:
            rule.min_severity = validate_min_severity(payload.min_severity)
        if payload.actor_ids is not None:
            actor_ids = [value.strip() for value in payload.actor_ids if value.strip()]
            if visible_user_ids is not None:
                hidden = [value for value in actor_ids if value not in visible_user_ids]
                if hidden:
                    raise ValueError("Alert rules can only watch users visible to this admin.")
            rule.actor_ids = actor_ids
        if payload.threshold_count is not None:
            rule.threshold_count = payload.threshold_count
        if payload.window_minutes is not None:
            rule.window_minutes = payload.window_minutes
        if payload.cooldown_minutes is not None:
            rule.cooldown_minutes = payload.cooldown_minutes
        if payload.recipients is not None:
            rule.recipients = validate_recipients(payload.recipients)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    rule.updated_at = now_utc()
    return rule


def _alert_rule_audit_payload(rule: AlertRule) -> dict[str, object]:
    return {
        "name": rule.name,
        "scope": rule.scope,
        "tenant_id": rule.tenant_id,
        "enabled": rule.enabled,
        "action_patterns": list(rule.action_patterns),
        "min_severity": rule.min_severity,
        "threshold_count": rule.threshold_count,
        "recipient_count": len(rule.recipients),
    }


@router.get("/alert-rules")
def tenant_alert_rules(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[AlertRule]:
    require_admin_or_owner(actor)
    tenant_id = _admin_tenant_id(actor)
    return [
        rule.model_copy()
        for rule in store.alert_rules.values()
        if rule.scope == "tenant" and (tenant_id is None or rule.tenant_id == tenant_id)
    ]


@router.post("/alert-rules", status_code=status.HTTP_201_CREATED)
def create_tenant_alert_rule(
    payload: AlertRuleCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AlertRule:
    require_admin_or_owner(actor)
    rule = AlertRule(
        id=f"alertrule-{uuid4()}",
        scope="tenant",
        tenant_id=_admin_alert_rule_tenant_id(actor, store),
        name=payload.name.strip(),
        created_by=actor.id,
        created_by_name=actor.display_name,
    )
    _apply_alert_rule_payload(rule, payload, visible_user_ids=_admin_visible_user_ids(actor, store))
    store.alert_rules[rule.id] = rule
    store.record_audit(actor, "admin.alert_rule_created", rule.id, _alert_rule_audit_payload(rule))
    return rule


def _get_tenant_alert_rule(rule_id: str, actor: User, store: SeedStore) -> AlertRule:
    rule = store.alert_rules.get(rule_id)
    tenant_id = _admin_tenant_id(actor)
    if (
        rule is None
        or rule.scope != "tenant"
        or (tenant_id is not None and rule.tenant_id != tenant_id)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown alert rule.")
    return rule


@router.patch("/alert-rules/{rule_id}")
def update_tenant_alert_rule(
    rule_id: str,
    payload: AlertRuleUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AlertRule:
    require_admin_or_owner(actor)
    rule = _get_tenant_alert_rule(rule_id, actor, store)
    _apply_alert_rule_payload(rule, payload, visible_user_ids=_admin_visible_user_ids(actor, store))
    store.record_audit(actor, "admin.alert_rule_updated", rule.id, _alert_rule_audit_payload(rule))
    return rule


@router.delete("/alert-rules/{rule_id}")
def delete_tenant_alert_rule(
    rule_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_admin_or_owner(actor)
    rule = _get_tenant_alert_rule(rule_id, actor, store)
    del store.alert_rules[rule.id]
    store.application_state_repository.delete_alert_rule_runtime(rule.id)
    store.record_audit(actor, "admin.alert_rule_deleted", rule.id, _alert_rule_audit_payload(rule))
    return {"status": "deleted", "id": rule.id}


@router.get("/alert-notifications")
def tenant_alert_notifications(
    limit: int = Query(default=100, ge=1, le=500),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[AlertNotification]:
    require_admin_or_owner(actor)
    tenant_id = _admin_tenant_id(actor)
    return store.alert_notifications_newest_first(
        scope="tenant",
        tenant_id=tenant_id,
        limit=limit,
    )


@router.patch("/alert-notifications/{notification_id}")
def tenant_archive_alert_notification(
    notification_id: str,
    payload: AlertNotificationArchiveRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AlertNotification:
    require_admin_or_owner(actor)
    tenant_id = _admin_tenant_id(actor)
    # Tenant admins can only reach their own tenant-scope deliveries;
    # platform-scope notifications stay owner-only.
    notification = store.set_alert_notification_archived(
        notification_id, payload.archived, require_tenant_id=tenant_id
    )
    if notification is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown alert notification.")
    store.record_audit(
        actor,
        "admin.alert_notification_archived" if payload.archived else "admin.alert_notification_unarchived",
        notification.id,
        {"rule_name": notification.rule_name, "archived": notification.archived},
    )
    return notification


@router.get("/alert-email-status")
def tenant_alert_email_status(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, object]:
    require_admin_or_owner(actor)
    configured = email_configured(store.email_settings)
    return {
        "configured": configured,
        "from_address": store.email_settings.from_address if configured else "",
        "message": (
            "Email delivery is configured; matching alerts are emailed to rule recipients."
            if configured
            else (
                "Email delivery is not configured. Alerts are still logged in-app; "
                "email delivery configuration is managed at the service level."
            )
        ),
    }


@router.get("/prompt-activity")
def tenant_prompt_activity(
    user_id: str | None = Query(default=None),
    thread_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[UserPromptRecord]:
    require_admin_or_owner(actor)
    tenant_id = _admin_tenant_id(actor)
    visible_user_ids = _admin_visible_user_ids(actor, store)
    if user_id is not None and user_id not in visible_user_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    # thread_id narrows to one conversation so the audit preview can show
    # every exchange; tenant scope and the visible-user filter below still
    # apply, so an out-of-tenant or owner-owned thread yields nothing.
    records = store.user_prompt_records(
        tenant_id, user_id=user_id, thread_id=thread_id, limit=None
    )
    return [record for record in records if record.user_id in visible_user_ids][:limit]


@router.get("/security-alerts")
def tenant_security_alerts(
    user_id: str | None = Query(default=None),
    include_acknowledged: bool = Query(default=True),
    limit: int = Query(default=100, ge=1, le=500),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[SecurityAlert]:
    require_admin_or_owner(actor)
    tenant_id = _admin_tenant_id(actor)
    visible_user_ids = _admin_visible_user_ids(actor, store)
    if user_id is not None and user_id not in visible_user_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    alerts = store.security_alerts_newest_first(
        tenant_id,
        user_id=user_id,
        include_acknowledged=include_acknowledged,
        limit=None,
    )
    return [alert for alert in alerts if alert.user_id in visible_user_ids][:limit]


@router.patch("/security-alerts/{alert_id}")
def update_tenant_security_alert(
    alert_id: str,
    payload: SecurityAlertUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SecurityAlert:
    require_admin_or_owner(actor)
    alert = store.security_alerts.get(alert_id)
    if alert is None or not _admin_can_see_alert(actor, alert, store):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown security alert.")
    updated = store.update_security_alert_acknowledgement(
        alert_id,
        acknowledged=payload.acknowledged,
        actor=actor,
    )
    if updated is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown security alert.")
    return updated


@router.get("/analytics")
def analytics(
    limit: int = Query(default=200, ge=1, le=2000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, object]:
    require_admin_or_owner(actor)
    # Counts are derived from the live application stores instead of fabricated
    # usage numbers; a tenant with no activity honestly reports zeros.
    tenant_id = actor.tenant_id
    tenant_threads = [
        thread
        for thread in store.chat_threads.values()
        if tenant_id is None or thread.tenant_id == tenant_id
    ]
    tenant_runs = [
        run for run in store.agent_runs.values() if tenant_id is None or run.tenant_id == tenant_id
    ]
    tenant_audit_count = store.audit_event_count(
        tenant_id=tenant_id,
        tenant_scoped=True,
    )
    active_users = [
        user
        for user in store.tenant_visible_users_for(actor)
        if user.active and (tenant_id is None or user.tenant_id == tenant_id)
    ]
    pending_events = store.elastic_pending_events(tenant_id)
    newest_events = pending_events[-limit:]
    return {
        "tenantId": tenant_id,
        "source": "hybrid-application-store",
        "elasticCredentialsVisible": False,
        "usage": [
            {"label": "Chats", "value": len(tenant_threads)},
            {
                "label": "Chat messages",
                "value": sum(len(thread.messages) for thread in tenant_threads),
            },
            {"label": "Agent runs", "value": len(tenant_runs)},
            {"label": "Audit events", "value": tenant_audit_count},
            {"label": "Active users", "value": len(active_users)},
        ],
        # The pending-export backlog is unbounded and never trimmed while
        # retention is unlimited, so this used to return every event ever
        # recorded -- megabytes, growing forever. Only the newest page is
        # returned, and the total is reported alongside it so a caller can see
        # what was left out instead of assuming it has everything.
        "events": newest_events,
        "eventsReturned": len(newest_events),
        "eventsPending": len(pending_events),
        "eventsTruncated": len(pending_events) > len(newest_events),
    }


def _get_user(user_id: str, store: SeedStore) -> User:
    user = store.users.get(user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    return user


def _advance_user_session_watermark_or_503(
    store: SeedStore,
    target: User,
    *,
    reason: str,
    updated_by: str,
    deactivate: bool,
    expected_role: Role,
    expected_tenant_id: str | None,
) -> int:
    try:
        return store.advance_user_session_watermark(
            target.id,
            expected_tenant_id,
            reason=reason,
            updated_by=updated_by,
            expected_user=target,
            expected_role=expected_role,
            deactivate=deactivate,
            preserve_last_active_admin=deactivate,
        )
    except LastActiveAdministrativeAccountError as exc:
        detail = (
            "This service-managed account cannot be deactivated."
            if exc.role == Role.PLATFORM_OWNER
            else "This action is blocked by administrative continuity policy."
        )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from exc
    except Exception as exc:  # noqa: BLE001 - security mutation must fail closed
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session revocation is temporarily unavailable.",
        ) from exc


def _transition_user_access_scope_or_503(
    store: SeedStore,
    target: User,
    *,
    expected_role: Role,
    expected_tenant_id: str | None,
    expected_group_ids: tuple[str, ...],
    expected_active: bool,
    role: Role,
    tenant_id: str | None,
    group_ids: list[str],
    active: bool,
    updated_by: str,
) -> int:
    try:
        return store.transition_user_access_scope(
            target,
            expected_role=expected_role,
            expected_tenant_id=expected_tenant_id,
            expected_group_ids=expected_group_ids,
            expected_active=expected_active,
            role=role,
            tenant_id=tenant_id,
            group_ids=group_ids,
            active=active,
            reason="admin-user-access-scope-changed",
            updated_by=updated_by,
        )
    except LastActiveAdministrativeAccountError as exc:
        detail = (
            "This service-managed account cannot be changed."
            if exc.role == Role.PLATFORM_OWNER
            else "This action is blocked by administrative continuity policy."
        )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from exc
    except Exception as exc:  # noqa: BLE001 - access mutation must fail closed
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session revocation is temporarily unavailable.",
        ) from exc


def _set_user_active_state_or_503(
    store: SeedStore,
    target: User,
    *,
    expected_role: Role,
    expected_tenant_id: str | None,
    expected_active: bool,
    active: bool,
) -> None:
    try:
        store.set_user_active_state(
            target,
            expected_role=expected_role,
            expected_tenant_id=expected_tenant_id,
            expected_active=expected_active,
            active=active,
        )
    except Exception as exc:  # noqa: BLE001 - access mutation must fail closed
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session revocation is temporarily unavailable.",
        ) from exc


def _assert_user_mutation_scope_or_503(
    store: SeedStore,
    target: User,
    *,
    expected_role: Role,
    expected_tenant_id: str | None,
    expected_group_ids: tuple[str, ...],
    expected_active: bool,
) -> None:
    try:
        store.assert_user_mutation_scope(
            target,
            expected_role=expected_role,
            expected_tenant_id=expected_tenant_id,
            expected_group_ids=expected_group_ids,
            expected_active=expected_active,
        )
    except Exception as exc:  # noqa: BLE001 - stale authorization must fail closed
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session revocation is temporarily unavailable.",
        ) from exc


def _assert_current_admin_actor(
    actor: User,
    store: SeedStore,
    *,
    expected_role: Role,
    expected_tenant_id: str | None,
) -> None:
    if (
        store.users.get(actor.id) is not actor
        or not actor.active
        or actor.role != expected_role
        or actor.tenant_id != expected_tenant_id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator authorization changed. Retry the request.",
        )
    require_admin_or_owner(actor)


def _admin_tenant_id(actor: User) -> str | None:
    return actor.tenant_id if actor.role != Role.PLATFORM_OWNER else None


def _admin_visible_user_ids(actor: User, store: SeedStore) -> set[str]:
    tenant_id = _admin_tenant_id(actor)
    return {
        user.id
        for user in store.tenant_visible_users_for(actor)
        if user.role != Role.PLATFORM_OWNER
        and (tenant_id is None or user.tenant_id == tenant_id)
        and (
            actor.role == Role.PLATFORM_OWNER
            or user.id == actor.id
            or user.role != Role.TENANT_ADMIN
        )
    }


def _admin_can_see_alert(actor: User, alert: SecurityAlert, store: SeedStore) -> bool:
    tenant_id = _admin_tenant_id(actor)
    if tenant_id is not None and alert.tenant_id != tenant_id:
        return False
    return alert.user_id in _admin_visible_user_ids(actor, store)


def _create_group(payload: GroupCreateRequest, actor: User, store: SeedStore) -> Group:
    tenant_id = _tenant_id_for_config(actor, payload.tenant_id, store)
    name = payload.name.strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Group name is required."
        )
    group_id = _group_id_for_payload(payload, store)
    if group_id in store.groups:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Group already exists.")
    _assert_unique_group_identity(
        store, tenant_id, name=name, entra_object_id=payload.entra_object_id
    )
    permissions = normalize_group_permissions(payload.permissions)
    with store._store_lock:
        _assert_downstream_api_group_grant_allowed(
            store,
            current_enabled=False,
            replacement_enabled=bool(permissions.get("api_access", False)),
        )
        group = Group(
            id=group_id,
            tenant_id=tenant_id,
            name=name,
            distinguished_name=payload.distinguished_name or "Platform-managed group",
            entra_object_id=payload.entra_object_id or f"platform-{group_id}",
            synced=payload.synced,
            user_count=max(0, payload.user_count),
            permissions=permissions,
        )
        store.groups[group.id] = group
        store.record_audit(
            actor,
            "admin.group_created",
            group.id,
            {
                "tenant_id": group.tenant_id,
                "name": group.name,
                "entra_object_id": group.entra_object_id,
            },
        )
        store.save_runtime_state()
        return group


def _assert_downstream_api_group_grant_allowed(
    store: SeedStore,
    *,
    current_enabled: bool,
    replacement_enabled: bool = False,
) -> None:
    """Do not let a group grant bypass the organization policy ceiling."""

    if current_enabled or not replacement_enabled or store.platform_settings.downstream_api_enabled:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(
            "Downstream API access is unavailable under the current service policy."
        ),
    )


def _get_group(group_id: str, actor: User, store: SeedStore) -> Group:
    group = store.groups.get(group_id)
    if group is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown group.")
    if actor.role != Role.PLATFORM_OWNER and group.tenant_id != actor.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Group is outside your tenant."
        )
    return group


def _get_provider(provider_id: str, store: SeedStore) -> Provider:
    provider = store.providers.get(provider_id)
    if provider is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown provider.")
    return provider


def _is_agent_profile_admin(actor: User) -> bool:
    return actor.role in {Role.PLATFORM_OWNER, Role.TENANT_ADMIN}


def _assert_agent_profile_authoring_scope(actor: User, model: ModelConfig) -> None:
    """Keep a granted non-admin author inside the profiles they created.

    404 rather than 403 so the response does not confirm that another user's
    agent profile exists.
    """
    if _is_agent_profile_admin(actor):
        return
    if not agent_profile_authored_by(actor, model):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent profile."
        )


def _get_agent_profile_for_admin(model_id: str, actor: User, store: SeedStore) -> ModelConfig:
    model = _resolve_model_identifier(model_id, store)
    if model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent profile.")
    if not _is_agent_profile_model(model):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only agent profiles can be deleted from this surface.",
        )
    if actor.role != Role.PLATFORM_OWNER:
        if model.tenant_id != actor.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Unknown agent profile.",
            )
        _assert_group_scope(actor, model.group_ids, store, tenant_id=model.tenant_id)
    return model


def _approved_upstream_targets(store: SeedStore) -> set[tuple[str, str]]:
    """(provider_id, upstream_model_id) pairs the owner has platform-enabled.

    Tenant admins may only build agent profiles on top of models the owner has
    already approved into the catalog, so their profiles cannot route arbitrary
    upstream models through the platform provider key.
    """
    return {
        (model.provider_id, (model.upstream_model_id or "").strip())
        for model in store.models.values()
        if model.platform_enabled and (model.upstream_model_id or "").strip()
    }


def _assert_agent_profile_target_approved(
    actor: User,
    store: SeedStore,
    provider_id: str,
    upstream_model_id: str | None,
) -> None:
    if actor.role == Role.PLATFORM_OWNER:
        return
    target = (provider_id, (upstream_model_id or "").strip())
    if not target[1] or target not in _approved_upstream_targets(store):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Agent profiles must reuse a model available to this organization.",
        )


def _assert_agent_profile_references(
    actor: User,
    store: SeedStore,
    payload: ModelCreateRequest | ModelUpdateRequest,
    *,
    tenant_id: str,
    existing: ModelConfig | None = None,
) -> None:
    group_ids = (
        payload.group_ids
        if payload.group_ids is not None
        else existing.group_ids
        if existing
        else []
    )
    _assert_group_scope(actor, group_ids, store, tenant_id=tenant_id)
    references = (
        (
            "knowledge configuration",
            payload.knowledge_config_ids
            if payload.knowledge_config_ids is not None
            else existing.knowledge_config_ids
            if existing
            else [],
            store.knowledge_configs,
        ),
        (
            "tool configuration",
            payload.tool_config_ids
            if payload.tool_config_ids is not None
            else existing.tool_config_ids
            if existing
            else [],
            store.tool_configs,
        ),
        (
            "prompt template",
            payload.prompt_template_ids
            if payload.prompt_template_ids is not None
            else existing.prompt_template_ids
            if existing
            else [],
            store.prompt_templates,
        ),
        (
            "skill file",
            payload.skill_file_ids
            if payload.skill_file_ids is not None
            else existing.skill_file_ids
            if existing
            else [],
            store.skill_files,
        ),
        (
            "content filter",
            payload.content_filter_ids
            if payload.content_filter_ids is not None
            else existing.content_filter_ids
            if existing
            else [],
            store.content_filters,
        ),
    )
    for label, record_ids, collection in references:
        for record_id in record_ids:
            if label == "content filter" and is_builtin_filter_id(record_id):
                continue
            record = collection.get(record_id)
            if record is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail=f"Unknown {label}."
                )
            if record.tenant_id != tenant_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"Agent profile {label} is outside the target tenant.",
                )


def _is_agent_profile_model(model: ModelConfig) -> bool:
    return bool(
        model.is_custom
        or model.created_by
        or model.agentic_companion
        or model.system_prompt
        or model.meta_prompt
        or model.knowledge_config_ids
        or model.tool_config_ids
        or model.prompt_template_ids
        or model.skill_file_ids
    )


def _delete_agent_profile_model(
    model: ModelConfig, actor: User, store: SeedStore, action: str
) -> None:
    store.models.pop(model.id, None)
    provider = store.providers.get(model.provider_id)
    if provider is not None:
        provider_models = _provider_models(store, provider.id)
        provider.model_count = len(provider_models)
        provider.enabled_model_count = sum(
            1 for provider_model in provider_models if provider_model.platform_enabled
        )
    store.record_audit(
        actor,
        action,
        model.id,
        {
            "provider_id": model.provider_id,
            "name": model.name,
            "visibility": model.visibility,
            "agentic_companion": model.agentic_companion,
        },
    )


def _adjust_model_counts(
    store: SeedStore,
    old_provider_id: str,
    old_platform_enabled: bool,
    model: ModelConfig,
) -> None:
    old_provider = store.providers.get(old_provider_id)
    new_provider = store.providers.get(model.provider_id)
    if old_provider_id != model.provider_id:
        if old_provider is not None:
            old_provider.model_count = max(0, old_provider.model_count - 1)
            if old_platform_enabled:
                old_provider.enabled_model_count = max(0, old_provider.enabled_model_count - 1)
        if new_provider is not None:
            new_provider.model_count += 1
            if model.platform_enabled:
                new_provider.enabled_model_count += 1
        return
    if new_provider is not None and old_platform_enabled != model.platform_enabled:
        delta = 1 if model.platform_enabled else -1
        new_provider.enabled_model_count = max(0, new_provider.enabled_model_count + delta)


def _delete_group_record(
    group_id: str,
    actor: User,
    store: SeedStore,
    *,
    revoke_members: bool = True,
) -> None:
    with store._store_lock:
        group = _get_group(group_id, actor, store)
        affected_users = sorted(
            (user for user in store.users.values() if group.id in user.group_ids),
            key=lambda user: user.id,
        )
        if revoke_members:
            try:
                for user in affected_users:
                    store.advance_user_session_watermark(
                        user.id,
                        user.tenant_id,
                        reason="group-membership-removed",
                        updated_by=actor.id,
                        expected_user=user,
                        expected_role=user.role,
                    )
            except SessionUserStateError as exc:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="A group member changed while the group was being deleted.",
                ) from exc
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="Session revocation is temporarily unavailable.",
                ) from exc
        del store.groups[group.id]
        for user in affected_users:
            user.group_ids = [item for item in user.group_ids if item != group.id]
    for model in store.models.values():
        if group.id in model.group_ids:
            model.group_ids = [item for item in model.group_ids if item != group.id]
    for config in store.knowledge_configs.values():
        if group.id in config.acl_group_ids:
            config.acl_group_ids = [item for item in config.acl_group_ids if item != group.id]
    for config in store.tool_configs.values():
        if group.id in config.allowed_group_ids:
            config.allowed_group_ids = [
                item for item in config.allowed_group_ids if item != group.id
            ]
    for template in store.prompt_templates.values():
        if group.id in template.group_ids:
            template.group_ids = [item for item in template.group_ids if item != group.id]
    for skill in store.skill_files.values():
        if group.id in skill.group_ids:
            skill.group_ids = [item for item in skill.group_ids if item != group.id]
    for config in store.sso_configs.values():
        if group.id in config.mapped_groups:
            config.mapped_groups = {
                mapped_group_id: name
                for mapped_group_id, name in config.mapped_groups.items()
                if mapped_group_id != group.id
            }
        default_group_ids = config.settings.get("default_group_ids")
        if isinstance(default_group_ids, list) and group.id in default_group_ids:
            config.settings = {
                **config.settings,
                "default_group_ids": [item for item in default_group_ids if item != group.id],
            }
    store.record_audit(
        actor,
        "admin.group_deleted",
        group.id,
        {
            "tenant_id": group.tenant_id,
            "name": group.name,
            "entra_object_id": group.entra_object_id,
        },
    )


def _assert_group_deletable(group: Group) -> None:
    if group.default_group:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The default user group is protected by organization policy and cannot be deleted.",
        )


def _group_id_for_payload(payload: GroupCreateRequest, store: SeedStore) -> str:
    if payload.id:
        return payload.id
    slug = re.sub(r"[^a-z0-9]+", "-", payload.name.strip().lower()).strip("-") or "group"
    candidate = f"group-{slug}"
    if candidate not in store.groups:
        return candidate
    return f"{candidate}-{uuid4().hex[:8]}"


def _assert_unique_group_identity(
    store: SeedStore,
    tenant_id: str,
    *,
    name: str | None = None,
    entra_object_id: str | None = None,
    exclude_group_id: str | None = None,
) -> None:
    normalized_name = _normalize_identity_value(name)
    normalized_entra_id = _normalize_identity_value(entra_object_id)
    for group in store.groups.values():
        if group.id == exclude_group_id or group.tenant_id != tenant_id:
            continue
        if normalized_name and _normalize_identity_value(group.name) == normalized_name:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Group name already exists."
            )
        if (
            normalized_entra_id
            and _normalize_identity_value(group.entra_object_id) == normalized_entra_id
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Group Entra object ID already exists."
            )


def _assert_unique_user_identity(
    store: SeedStore,
    *,
    email: str | None,
    entra_object_id: str | None,
    exclude_user_id: str | None = None,
) -> None:
    normalized_email = _normalize_identity_value(email)
    normalized_entra_id = _normalize_identity_value(entra_object_id)
    for user in store.users.values():
        if user.id == exclude_user_id:
            continue
        if normalized_email and _normalize_identity_value(user.email) == normalized_email:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="User email already exists."
            )
        if (
            normalized_entra_id
            and _normalize_identity_value(user.entra_object_id) == normalized_entra_id
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="User Entra object ID already exists."
            )


def _enabled_model_catalog(store: SeedStore, actor: User) -> list[ModelConfig]:
    return [
        model
        for model in store.models.values()
        if model.platform_enabled
        and (
            actor.role == Role.PLATFORM_OWNER
            or model.tenant_id is None
            or model.tenant_id == actor.tenant_id
        )
    ]


def _sync_provider_catalogs_for_admin(actor: User, store: SeedStore) -> None:
    for provider in list(store.providers.values()):
        _sync_provider_catalog_for_admin(provider, actor, store)


def _resolve_model_for_admin_access(
    model_id: str, actor: User, store: SeedStore
) -> ModelConfig | None:
    model = _resolve_model_identifier(model_id, store)
    if model is not None:
        return model
    _sync_provider_catalogs_for_admin(actor, store)
    return _resolve_model_identifier(model_id, store)


def _resolve_model_identifier(model_id: str, store: SeedStore) -> ModelConfig | None:
    raw_model_id = unquote(model_id).strip()
    if not raw_model_id:
        return None
    direct = store.models.get(raw_model_id)
    if direct is not None:
        return direct

    lookup_key = _model_lookup_key(raw_model_id)
    matches = [
        model
        for model in store.models.values()
        if lookup_key in _model_lookup_keys_for_config(model, store)
    ]
    return matches[0] if len(matches) == 1 else None


def _model_lookup_keys_for_config(model: ModelConfig, store: SeedStore) -> set[str]:
    values = {model.id, model.upstream_model_id or "", model.name}
    provider = store.providers.get(model.provider_id)
    upstream_model_id = (model.upstream_model_id or "").strip()
    if provider is not None and upstream_model_id:
        values.add(_model_config_id(provider, upstream_model_id, set()))
    return {_model_lookup_key(value) for value in values if value}


def _model_lookup_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", unquote(value).strip().lower()).strip("-")


def _sync_provider_catalog_for_admin(provider: Provider, actor: User, store: SeedStore) -> None:
    # Provider model rows are a shared platform catalog. A tenant-scoped
    # credential may expose only a key-specific subset and must never rename
    # or delete global rows used by other tenants. Only a platform owner using
    # the platform credential performs destructive catalog reconciliation.
    if actor.tenant_id is not None:
        return
    secret = store.provider_key_secret_for_provider(
        provider.id,
        tenant_id=None,
    )
    if secret is None:
        return
    try:
        discovered_models, source = discover_provider_models(provider, secret.secret_value)
    except ModelDiscoveryError as exc:
        provider.status_message = f"Model sync failed: {exc}"
        store.record_audit(
            actor,
            "admin.model_catalog_sync_failed",
            provider.id,
            {"provider_id": provider.id, "provider_kind": provider.kind, "error": str(exc)},
        )
        return

    imported_count, updated_count, removed_count = _reconcile_provider_models(
        store, provider, discovered_models
    )
    provider.connected = True
    provider.last_sync = "Just synced"
    provider.status_message = _provider_sync_source_label(provider, source)
    store.record_audit(
        actor,
        "admin.model_catalog_synced",
        provider.id,
        {
            "provider_id": provider.id,
            "provider_kind": provider.kind,
            "source": source,
            "imported_count": imported_count,
            "updated_count": updated_count,
            "removed_count": removed_count,
            "model_count": len(_provider_models(store, provider.id)),
        },
    )


def _reconcile_provider_models(
    store: SeedStore,
    provider: Provider,
    discovered_models: list[DiscoveredModel],
) -> tuple[int, int, int]:
    existing_models = _provider_models(store, provider.id)
    # Custom models (agent profiles) often share an upstream id with a
    # catalog row; they are admin-authored, so a sync must never rename or
    # overwrite them. Only true catalog rows participate in reconciliation.
    existing_by_upstream = {
        (model.upstream_model_id or model.name): model
        for model in existing_models
        if not model.is_custom and (model.upstream_model_id or model.name)
    }
    discovered_upstreams: set[str] = set()
    used_model_ids = set(store.models)
    imported_count = 0
    updated_count = 0

    for discovered in discovered_models:
        upstream_model_id = discovered.id.strip()
        if not upstream_model_id or upstream_model_id in discovered_upstreams:
            continue
        discovered_upstreams.add(upstream_model_id)
        model = existing_by_upstream.get(upstream_model_id)
        if model is None:
            model = ModelConfig(
                id=_model_config_id(provider, upstream_model_id, used_model_ids),
                provider_id=provider.id,
                provider_name=provider.name,
                name=discovered.name or upstream_model_id,
                upstream_model_id=upstream_model_id,
                notes=discovered.notes,
                context_window=discovered.context_window,
                capabilities=discovered.capabilities,
                # Provider catalog syncs surface availability to owners; they
                # do not grant platform access until the owner enables a model.
                platform_enabled=False,
                group_ids=[],
                visibility="organization",
            )
            store.models[model.id] = model
            used_model_ids.add(model.id)
            imported_count += 1
            continue

        model.provider_name = provider.name
        model.name = discovered.name or upstream_model_id
        model.upstream_model_id = upstream_model_id
        model.notes = discovered.notes
        model.context_window = discovered.context_window
        if discovered.capabilities is not None:
            model.capabilities = discovered.capabilities
        updated_count += 1

    # Custom models (agent profiles) stay admin-authored, but their context
    # window is a property of the upstream model they ride; refresh that one
    # field from the catalog so context meters stay truthful for agents too.
    discovered_by_upstream = {
        discovered.id.strip(): discovered for discovered in discovered_models if discovered.id.strip()
    }
    for model in existing_models:
        if not model.is_custom or not model.upstream_model_id:
            continue
        discovered = discovered_by_upstream.get(model.upstream_model_id)
        if discovered is not None and discovered.context_window is not None:
            model.context_window = discovered.context_window

    stale_ids = [
        model.id
        for model in existing_models
        if not model.is_custom
        and (model.upstream_model_id or model.name) not in discovered_upstreams
    ]
    for model_id in stale_ids:
        store.models.pop(model_id, None)

    provider_models = _provider_models(store, provider.id)
    provider.model_count = len(provider_models)
    provider.enabled_model_count = sum(1 for model in provider_models if model.platform_enabled)
    return imported_count, updated_count, len(stale_ids)


def _provider_models(store: SeedStore, provider_id: str) -> list[ModelConfig]:
    return [model for model in store.models.values() if model.provider_id == provider_id]


def _inherited_context_window(
    store: SeedStore, provider_id: str, upstream_model_id: str | None
) -> int | None:
    """A custom model rides an upstream the catalog already measured; without
    an explicit override its context window is the catalog row's."""
    if not upstream_model_id:
        return None
    for model in store.models.values():
        if (
            model.provider_id == provider_id
            and not model.is_custom
            and model.upstream_model_id == upstream_model_id
            and model.context_window
        ):
            return model.context_window
    return None


def _model_config_id(provider: Provider, upstream_model_id: str, used_model_ids: set[str]) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", upstream_model_id.lower()).strip("-") or "model"
    base = f"{provider.id}-{slug}"[:96].strip("-")
    candidate = base
    suffix = 2
    while candidate in used_model_ids:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def _provider_sync_source_label(provider: Provider, source: str) -> str:
    if source == "openrouter:/models/user":
        return (
            "Synced from OpenRouter key-scoped catalog; provider preferences, privacy settings, "
            "guardrails, and ZDR eligibility were applied upstream."
        )
    if source == "openrouter:/models?zdr=true":
        return "Synced from OpenRouter ZDR-filtered catalog."
    return f"Synced from {provider.name} model catalog."


def _assert_deactivation_allowed(actor: User, target: User, store: SeedStore) -> None:
    if target.id == actor.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot deactivate your own account.",
        )
    if not target.active:
        return
    if target.role == Role.PLATFORM_OWNER:
        active_owners = [
            user
            for user in store.users.values()
            if user.active and user.role == Role.PLATFORM_OWNER
        ]
        if len(active_owners) <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This service-managed account cannot be deactivated.",
            )
    if target.role == Role.TENANT_ADMIN and target.tenant_id is not None:
        # Owners are administrators for every tenant, so the last tenant admin
        # is removable while any active owner remains.
        remaining_administrators = [
            user
            for user in store.users.values()
            if user.id != target.id
            and user.active
            and (
                user.role == Role.PLATFORM_OWNER
                or (user.role == Role.TENANT_ADMIN and user.tenant_id == target.tenant_id)
            )
        ]
        if not remaining_administrators:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This action is blocked by administrative continuity policy.",
            )


def _assert_role_change_allowed(target: User, requested_role: Role, store: SeedStore) -> None:
    if requested_role == target.role or not target.active:
        return
    if target.role == Role.PLATFORM_OWNER:
        active_owners = [
            user
            for user in store.users.values()
            if user.active and user.role == Role.PLATFORM_OWNER
        ]
        if len(active_owners) <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This service-managed account cannot be changed.",
            )
    if target.role == Role.TENANT_ADMIN and target.tenant_id is not None:
        # Owners are administrators for every tenant, so the last tenant admin
        # is removable while any active owner remains.
        remaining_administrators = [
            user
            for user in store.users.values()
            if user.id != target.id
            and user.active
            and (
                user.role == Role.PLATFORM_OWNER
                or (user.role == Role.TENANT_ADMIN and user.tenant_id == target.tenant_id)
            )
        ]
        if not remaining_administrators:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This action is blocked by administrative continuity policy.",
            )


def _normalize_identity_value(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    return normalized or None


def _tenant_id_for_user(
    actor: User,
    requested_tenant_id: str | None,
    requested_role: Role,
    store: SeedStore,
) -> str | None:
    if requested_role == Role.PLATFORM_OWNER:
        return None
    if actor.role == Role.TENANT_ADMIN:
        if actor.tenant_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Tenant scope is required."
            )
        if requested_tenant_id is not None and requested_tenant_id != actor.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Tenant admins can only create users in their tenant.",
            )
        return actor.tenant_id
    if requested_tenant_id is not None:
        tenant_id = requested_tenant_id
    elif len(store.tenants) == 1:
        tenant_id = next(iter(store.tenants))
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="tenant_id is required when the platform has multiple tenants.",
        )
    if tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    return tenant_id


def _assert_sso_management_allowed(actor: User, store: SeedStore) -> None:
    if actor.role == Role.TENANT_ADMIN and not store.platform_settings.tenant_admins_can_manage_sso:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Organization policy does not permit SSO changes from this console.",
        )


def _assert_tenant_update_allowed(actor: User, tenant_id: str, store: SeedStore) -> None:
    if tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    if actor.role == Role.TENANT_ADMIN and tenant_id != actor.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant admins cannot move users across tenants.",
        )


def _tenant_id_for_config(
    actor: User,
    requested_tenant_id: str | None,
    store: SeedStore,
) -> str:
    if actor.role == Role.PLATFORM_OWNER:
        if requested_tenant_id is not None:
            tenant_id = requested_tenant_id
        elif len(store.tenants) == 1:
            tenant_id = next(iter(store.tenants))
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="tenant_id is required when the platform has multiple tenants.",
            )
    else:
        if actor.tenant_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Tenant scope is required."
            )
        if requested_tenant_id is not None and requested_tenant_id != actor.tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Tenant admins can only configure their tenant.",
            )
        tenant_id = actor.tenant_id
    if tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    return tenant_id


def _assert_group_scope(
    actor: User,
    group_ids: list[str],
    store: SeedStore,
    *,
    tenant_id: str | None = None,
) -> None:
    missing = [group_id for group_id in group_ids if group_id not in store.groups]
    if missing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown group.")
    target_tenant_id = tenant_id or actor.tenant_id
    if actor.role == Role.PLATFORM_OWNER and target_tenant_id is None:
        return
    if target_tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Tenant scope is required."
        )
    if actor.role != Role.PLATFORM_OWNER and target_tenant_id != actor.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant admins can only assign groups from their tenant.",
        )
    outside_tenant = [
        group_id for group_id in group_ids if store.groups[group_id].tenant_id != target_tenant_id
    ]
    if outside_tenant:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant admins can only assign groups from their tenant.",
        )


def _assert_model_access_delegated(actor: User, model: ModelConfig, store: SeedStore) -> None:
    """Delegation ceiling for tenant-admin model-access edits.

    Owners are unrestricted. A tenant admin may scope groups on a model only when
    it is delegable to their tenant: either it is not tenant-restricted yet (an
    open platform model the owner exposed for tenant group-scoping), or it is
    already restricted to their own tenant (carries at least one of their tenant's
    groups). A model restricted solely to another tenant's groups is off-limits.
    """
    if actor.role == Role.PLATFORM_OWNER:
        return
    if model.tenant_id is not None and model.tenant_id != actor.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This model belongs to another tenant.",
        )
    if not model.tenant_restricted:
        return
    tenant_group_ids = {
        group_id for group_id, group in store.groups.items() if group.tenant_id == actor.tenant_id
    }
    if any(group_id in tenant_group_ids for group_id in model.group_ids):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="This model is not available to this organization.",
    )


def _assert_new_config_id(config_id: str, records: dict[str, Any]) -> None:
    if config_id in records:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Configuration already exists."
        )


def _visible_tenant_records(records: dict[str, Any], actor: User) -> list[Any]:
    if actor.role == Role.PLATFORM_OWNER:
        return list(records.values())
    return [record for record in records.values() if record.tenant_id == actor.tenant_id]


def _get_tenant_record(record_id: str, records: dict[str, Any], actor: User) -> Any:
    record = records.get(record_id)
    if record is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown configuration.")
    if actor.role != Role.PLATFORM_OWNER and record.tenant_id != actor.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Configuration is outside your tenant."
        )
    return record


def _assert_owned_config_scope(actor: User, owner_user_id: str | None, capability: str) -> None:
    """Keep a granted non-admin author inside the records they own."""
    if owner_user_id == actor.id:
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=f"Only administrators can manage a {capability} owned by someone else.",
    )


def _assert_knowledge_owner_scope(
    owner_user_id: str,
    tenant_id: str,
    store: SeedStore,
) -> None:
    # Rejecting bad owners here keeps the durable-state validator from failing
    # mid-save, which would surface as a 500 and strand the in-memory store.
    owner = store.users.get(owner_user_id)
    if owner is None or (owner.role != Role.PLATFORM_OWNER and owner.tenant_id != tenant_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "owner_user_id is not valid for this organization's knowledge configuration."
            ),
        )


def _assert_connector_config_scope(
    connector_config_id: str | None,
    tenant_id: str,
    store: SeedStore,
) -> None:
    if connector_config_id is None:
        return
    config = store.connector_configs.get(connector_config_id)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown connector configuration."
        )
    if config.tenant_id != tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Connector configuration is outside the target tenant.",
        )


def _save_secret_if_present(
    store: SeedStore,
    namespace: str,
    record_id: str,
    secret_value: str | None,
) -> str | None:
    if secret_value is None:
        return None
    return store.set_configuration_secret(namespace, record_id, secret_value)


def _apply_config_updates(record: Any, updates: dict[str, Any]) -> None:
    for field, value in updates.items():
        if field in {"secret_value", "client_secret", "service_password"} or value is None:
            continue
        if field == "settings" and isinstance(value, dict):
            # Merge instead of replace so partial form saves (e.g. the owner SSO
            # panel) cannot silently drop unrelated keys like jit_provisioning.
            merged = dict(getattr(record, "settings", {}) or {})
            merged.update(value)
            setattr(record, field, merged)
            continue
        setattr(record, field, value)


def _template_audit_payload(template: PromptTemplate) -> dict[str, Any]:
    return {
        "tenant_id": template.tenant_id,
        "name": template.name,
        "category": template.category,
        "variables": template.variables,
        "group_ids": template.group_ids,
        "enabled": template.enabled,
        "content_chars": len(template.content),
    }


def _skill_audit_payload(skill: SkillFile) -> dict[str, Any]:
    return {
        "tenant_id": skill.tenant_id,
        "name": skill.name,
        "category": skill.category,
        "format": skill.format,
        "version": skill.version,
        "group_ids": skill.group_ids,
        "enabled": skill.enabled,
        "content_chars": len(skill.content),
    }
