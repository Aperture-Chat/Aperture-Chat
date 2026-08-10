from __future__ import annotations

import re
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, status

from app.core.config import get_settings
from app.core.model_discovery import DiscoveredModel, ModelDiscoveryError, discover_provider_models
from app.core.model_gateway import (
    OPENAI_COMPATIBLE_KINDS,
    UNSUPPORTED_PROVIDER_KINDS,
    ModelGatewayAuthError,
    ModelGatewayError,
    get_model_gateway_client,
    resolve_model_route,
)
from app.core import hermes
from app.core import clock
from app.core.alerting import (
    EMAIL_PATTERN,
    normalize_action_patterns,
    validate_min_severity,
    validate_recipients,
)
from app.core.audit_severity import decorate_audit_events
from app.core.mailer import MailerError, email_configured, send_email
from app.core.policy import hermes_companion_allowed, require_platform_owner
from app.core.usage_analytics import build_usage_summary
from app.core.usage_budget import UsageBudgetError, UsageBudgetUnavailable, utc_usage_date
from app.core.usage_budget_runtime import (
    UsageTenantScopeError,
    map_usage_budget_error,
    resolve_usage_tenant_id,
)
from app.models.schemas import (
    AlertNotification,
    AlertNotificationArchiveRequest,
    AlertRule,
    AlertRuleCreateRequest,
    AlertRuleUpdateRequest,
    AuditEvent,
    Connector,
    ConnectorUpdateRequest,
    EmailSettings,
    EmailSettingsUpdateRequest,
    EmailTestRequest,
    ModelConfig,
    ModelCreateRequest,
    ModelUpdateRequest,
    PlatformSettings,
    PlatformSettingsUpdateRequest,
    Provider,
    ProviderCreateRequest,
    ProviderKey,
    ProviderKeyCreateRequest,
    ProviderKeySecret,
    ProviderModelSyncResponse,
    ProviderUpdateRequest,
    SecurityAlert,
    SecurityAlertUpdateRequest,
    ScimTokenCreateResponse,
    ScimTokenSummary,
    Tenant,
    TenantBrandingUpdateRequest,
    TenantCreate,
    TenantSummary,
    TenantUpdate,
    TenantUsageBudgetUpdateRequest,
    User,
    UsageRecord,
    UserPromptRecord,
    now_utc,
)
from app.repositories.deps import get_store, get_usage_budget_repository
from app.repositories.seed import (
    FinalTenantDeletionError,
    SeedStore,
    TenantConflictError,
    TenantStoreError,
)
from app.repositories.usage_budgets import TenantUsageBudgetRepository
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/platform", tags=["platform-owner"])

PROVIDER_RUNTIME_TEST_PROMPT = "Reply with exactly: OK"
PROVIDER_RUNTIME_TEST_TOKEN_BUDGET = 256


@router.get("/providers")
def providers(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[Provider]:
    require_platform_owner(actor)
    return list(store.providers.values())


@router.post("/providers", status_code=201)
def create_provider(
    payload: ProviderCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Provider:
    require_platform_owner(actor)
    provider_id = payload.id or f"provider-{uuid4()}"
    if provider_id in store.providers:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Provider already exists.")
    provider = Provider(
        id=provider_id,
        name=payload.name,
        kind=payload.kind,
        region=payload.region,
        base_url=payload.base_url,
        auth_type=payload.auth_type,
        auth_metadata=payload.auth_metadata,
        connected=False,
        model_count=payload.model_count,
        enabled_model_count=payload.enabled_model_count,
        last_sync=payload.last_sync,
        status_message=payload.status_message
        or "Provider metadata saved; add a key and pass runtime validation before chat.",
    )
    store.providers[provider.id] = provider
    store.record_audit(actor, "platform.provider_created", provider.id, payload.model_dump())
    return provider


@router.patch("/providers/{provider_id}")
def update_provider(
    provider_id: str,
    payload: ProviderUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Provider:
    require_platform_owner(actor)
    provider = _get_provider(provider_id, store)
    updates = payload.model_dump(exclude_unset=True)
    for field, value in updates.items():
        if value is not None:
            setattr(provider, field, value)
    if "name" in updates:
        for model in store.models.values():
            if model.provider_id == provider.id:
                model.provider_name = provider.name
        for key in store.provider_keys.values():
            if key.provider_id == provider.id:
                key.provider_name = provider.name
    store.record_audit(actor, "platform.provider_updated", provider.id, updates)
    return provider


def _provider_deletion_blockers(provider_id: str, store: SeedStore) -> list[str]:
    """Live references that deleting this provider's models would break.

    Chat history is deliberately not a blocker: past threads keep their
    recorded model id as a historical fact and are never re-run. Automations
    and agent profiles are, because removing a model they depend on turns a
    working configuration into a run-time failure with no warning.
    """
    model_ids = {model.id for model in store.models.values() if model.provider_id == provider_id}
    if not model_ids:
        return []
    blockers: list[str] = []
    for automation in store.automations.values():
        used = sorted({step.model_id for step in automation.steps if step.model_id in model_ids})
        if used:
            blockers.append(f"automation '{automation.name}' uses {', '.join(used)}")
    for model in store.models.values():
        if model.provider_id == provider_id or not model.tool_config_ids:
            continue
        # An agent profile routed through one of these models breaks too.
        if model.upstream_model_id in model_ids or model.id in model_ids:
            blockers.append(f"agent profile '{model.name}'")
    return blockers


@router.delete("/providers/{provider_id}")
def delete_provider(
    provider_id: str,
    confirm: str | None = None,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, object]:
    """Permanently remove a provider with its models and stored keys.

    Owner-only and irreversible. ``confirm`` must repeat the provider name
    exactly, so a mistyped or replayed URL cannot destroy a provider. Live
    automation/agent references block the delete instead of being silently
    broken; the response names them so the owner can clear them first.
    """
    require_platform_owner(actor)
    provider = _get_provider(provider_id, store)

    blockers = _provider_deletion_blockers(provider_id, store)
    if blockers:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"'{provider.name}' still has models in use by: {'; '.join(blockers)}. "
                "Remove or repoint those first, then delete the provider."
            ),
        )
    if (confirm or "").strip() != provider.name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Deleting a provider is permanent. Repeat the provider name exactly "
                f"('{provider.name}') to confirm."
            ),
        )

    removed_models = [model.id for model in store.models.values() if model.provider_id == provider_id]
    removed_keys = [key.id for key in store.provider_keys.values() if key.provider_id == provider_id]
    # Custom agent profiles are models too, so a provider delete silently took
    # them with it. They are hand-authored and unrecoverable, so they block the
    # delete by name instead of disappearing inside a model count.
    custom_profiles = [
        model.name
        for model in store.models.values()
        if model.provider_id == provider_id and getattr(model, "is_custom", False)
    ]
    if custom_profiles:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"'{provider.name}' still backs {len(custom_profiles)} agent profile(s): "
                f"{', '.join(sorted(custom_profiles))}. Delete or repoint them first — "
                "agent profiles cannot be rebuilt from a provider sync."
            ),
        )
    for model_id in removed_models:
        store.models.pop(model_id, None)
    for key_id in removed_keys:
        # Drops the ciphertext with the record, so no orphaned secret survives.
        store.delete_provider_key(key_id)
    store.providers.pop(provider_id, None)
    store.record_audit(
        actor,
        "platform.provider_deleted",
        provider_id,
        {
            "name": provider.name,
            "kind": provider.kind,
            "models_deleted": len(removed_models),
            "keys_deleted": len(removed_keys),
        },
    )
    store.save_runtime_state(urgent=True)
    return {
        "status": "deleted",
        "id": provider_id,
        "models_deleted": len(removed_models),
        "keys_deleted": len(removed_keys),
    }


@router.get("/models")
def models(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[ModelConfig]:
    require_platform_owner(actor)
    return list(store.models.values())


def _assert_platform_hermes_permitted(
    actor: User, store: SeedStore, agentic_companion: object
) -> None:
    """Hermes is an admin-team approval: even the owner console cannot attach
    it to a model until the hermes_companion group permission is enabled."""
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


@router.post("/models", status_code=201)
def create_model(
    payload: ModelCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ModelConfig:
    require_platform_owner(actor)
    _assert_platform_hermes_permitted(actor, store, payload.agentic_companion)
    tenant_id = payload.tenant_id
    tenant_bound = bool(
        payload.is_custom
        or payload.agentic_companion
        or payload.knowledge_config_ids
        or payload.tool_config_ids
        or payload.prompt_template_ids
        or payload.skill_file_ids
        or payload.content_filter_ids
    )
    if tenant_id is None and tenant_bound:
        if len(store.tenants) == 1:
            tenant_id = next(iter(store.tenants))
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="tenant_id is required for tenant-owned model configuration.",
            )
    if tenant_id is not None and tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    provider = _get_provider(payload.provider_id, store)
    _assert_model_config_references(
        payload.knowledge_config_ids,
        payload.tool_config_ids,
        payload.prompt_template_ids,
        payload.skill_file_ids,
        store,
        tenant_id=tenant_id,
    )
    _assert_platform_group_scope(payload.group_ids, tenant_id, store)
    model_id = payload.id or f"model-{uuid4()}"
    if model_id in store.models:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Model already exists.")
    group_ids = (
        _with_default_user_group(store, list(payload.group_ids), tenant_id=tenant_id)
        if payload.platform_enabled
        else list(payload.group_ids)
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
        platform_enabled=payload.platform_enabled,
        tenant_restricted=payload.tenant_restricted,
        group_ids=group_ids,
        notes=payload.notes,
        is_custom=payload.is_custom,
        created_by=payload.created_by,
        context_window=payload.context_window
        or _inherited_context_window(store, provider.id, payload.upstream_model_id),
        visibility=payload.visibility,
        agentic_companion=payload.agentic_companion,
        prompt_template_ids=payload.prompt_template_ids,
        skill_file_ids=payload.skill_file_ids,
        admin_delete_locked=payload.admin_delete_locked,
    )
    store.models[model.id] = model
    provider.model_count += 1
    if model.platform_enabled:
        provider.enabled_model_count += 1
    store.record_audit(actor, "platform.model_created", model.id, payload.model_dump())
    store.save_runtime_state()
    return model


@router.patch("/models/{model_id}")
def update_model(
    model_id: str,
    payload: ModelUpdateRequest | None = Body(default=None),
    platform_enabled: bool | None = Query(default=None),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ModelConfig:
    require_platform_owner(actor)
    model = _get_model(model_id, store)
    updates = payload.model_dump(exclude_unset=True) if payload is not None else {}
    _assert_platform_hermes_permitted(actor, store, updates.get("agentic_companion"))
    if platform_enabled is not None:
        updates["platform_enabled"] = platform_enabled
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No model updates provided."
        )

    old_provider_id = model.provider_id
    old_platform_enabled = model.platform_enabled
    effective_tenant_id = updates["tenant_id"] if "tenant_id" in updates else model.tenant_id
    if effective_tenant_id is not None and effective_tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    _assert_model_config_references(
        updates.get("knowledge_config_ids", model.knowledge_config_ids),
        updates.get("tool_config_ids", model.tool_config_ids),
        updates.get("prompt_template_ids", model.prompt_template_ids),
        updates.get("skill_file_ids", model.skill_file_ids),
        store,
        tenant_id=effective_tenant_id,
    )
    _assert_platform_group_scope(
        updates.get("group_ids", model.group_ids),
        effective_tenant_id,
        store,
    )
    if "provider_id" in updates and updates["provider_id"] is not None:
        provider = _get_provider(str(updates["provider_id"]), store)
        model.provider_id = provider.id
        model.provider_name = provider.name
    for field, value in updates.items():
        if field == "provider_id" or value is None:
            continue
        setattr(model, field, value)
    if updates.get("platform_enabled") is True and not old_platform_enabled:
        model.group_ids = _with_default_user_group(
            store,
            model.group_ids,
            tenant_id=effective_tenant_id,
        )
    _adjust_model_counts(store, old_provider_id, old_platform_enabled, model)
    action = (
        "platform.model_status_changed"
        if set(updates) == {"platform_enabled"}
        else "platform.model_updated"
    )
    store.record_audit(actor, action, model.id, updates)
    store.save_runtime_state()
    return model


@router.delete("/models/{model_id}")
def delete_model(
    model_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_platform_owner(actor)
    model = _get_model(model_id, store)
    if not _is_agent_profile_model(model):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only agent profiles can be deleted from this surface.",
        )
    store.models.pop(model.id, None)
    provider = store.providers.get(model.provider_id)
    if provider is not None:
        provider.model_count = max(0, provider.model_count - 1)
        if model.platform_enabled:
            provider.enabled_model_count = max(0, provider.enabled_model_count - 1)
    store.record_audit(
        actor,
        "platform.model_deleted",
        model.id,
        {
            "provider_id": model.provider_id,
            "name": model.name,
            "visibility": model.visibility,
            "agentic_companion": model.agentic_companion,
        },
    )
    return {"status": "deleted", "id": model.id}


@router.post("/providers/{provider_id}/sync-models")
def sync_provider_models(
    provider_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ProviderModelSyncResponse:
    require_platform_owner(actor)
    provider = _get_provider(provider_id, store)
    secret = store.provider_key_secret_for_provider(provider.id)
    try:
        discovered_models, source = discover_provider_models(
            provider, secret.secret_value if secret else None
        )
    except ModelDiscoveryError as exc:
        provider.status_message = str(exc)
        provider.connected = False
        if exc.status_code in {401, 403}:
            _mark_provider_keys_invalid(store, provider.id)
        store.record_audit(
            actor,
            "platform.provider_models_sync_failed",
            provider.id,
            {"provider_id": provider.id, "provider_kind": provider.kind, "error": str(exc)},
        )
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    imported_count, updated_count, removed_count = _reconcile_provider_models(
        store, provider, discovered_models
    )
    provider.connected = True
    provider_models = _provider_models(store, provider.id)
    source_label = _provider_sync_source_label(provider, source)
    try:
        runtime_model = _validate_provider_runtime(store, provider)
    except ModelGatewayAuthError as exc:
        detail = _provider_runtime_auth_failure(store, provider, exc)
        store.record_audit(
            actor,
            "platform.provider_runtime_validation_failed",
            provider.id,
            {
                "provider_id": provider.id,
                "provider_kind": provider.kind,
                "status_code": exc.status_code,
                "model_count": len(provider_models),
            },
        )
        store.save_runtime_state()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail) from exc
    except ModelGatewayError as exc:
        detail = _provider_runtime_validation_failure(provider, exc)
        provider.connected = False
        provider.last_sync = "Runtime test failed"
        provider.status_message = detail
        store.record_audit(
            actor,
            "platform.provider_runtime_validation_failed",
            provider.id,
            {
                "provider_id": provider.id,
                "provider_kind": provider.kind,
                "error": str(exc),
                "model_count": len(provider_models),
            },
        )
        store.save_runtime_state()
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=detail) from exc

    provider.last_sync = "Just synced"
    provider.status_message = f"{source_label} Runtime test passed with {runtime_model.name}."
    message = (
        f"Synced {len(provider_models)} {provider.name} model"
        f"{'' if len(provider_models) == 1 else 's'} from the provider API. Runtime test passed with {runtime_model.name}."
    )
    store.record_audit(
        actor,
        "platform.provider_models_synced",
        provider.id,
        {
            "provider_id": provider.id,
            "provider_kind": provider.kind,
            "source": source,
            "imported_count": imported_count,
            "updated_count": updated_count,
            "removed_count": removed_count,
            "model_count": len(provider_models),
            "runtime_test_model_id": runtime_model.id,
            "runtime_test_model_name": runtime_model.name,
        },
    )
    store.save_runtime_state()
    return ProviderModelSyncResponse(
        provider=provider,
        models=provider_models,
        imported_count=imported_count,
        updated_count=updated_count,
        removed_count=removed_count,
        source=source,
        message=message,
    )


@router.get("/provider-keys")
def provider_keys(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[ProviderKey]:
    require_platform_owner(actor)
    return store.provider_key_records()


@router.post("/provider-keys", status_code=201)
def create_provider_key(
    payload: ProviderKeyCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ProviderKey:
    require_platform_owner(actor)
    provider = _get_provider(payload.provider_id, store)
    if payload.tenant_id is not None and payload.tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    key_id = payload.id or f"key-{uuid4()}"
    if key_id in store.provider_keys:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Provider key already exists."
        )
    secret_value = payload.secret_value.strip()
    if not secret_value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Provider key secret is required."
        )
    key = store.create_provider_key(
        key_id=key_id,
        provider=provider,
        name=payload.name,
        environment=payload.environment,
        status=payload.status,
        expires=payload.expires,
        secret_value=secret_value,
        tenant_id=payload.tenant_id,
    )
    is_platform_credential = key.tenant_id is None
    if is_platform_credential:
        provider.connected = key.status.lower() == "active"
        provider.last_sync = "Key saved now"
    if (
        is_platform_credential
        and _provider_supports_model_sync(provider)
        and provider.connected
    ):
        try:
            discovered_models, source = discover_provider_models(provider, secret_value)
        except ModelDiscoveryError as exc:
            provider.connected = False
            provider.last_sync = "Model sync failed"
            if exc.status_code in {401, 403}:
                key.status = "Inactive"
            provider.status_message = f"Key saved; model sync failed: {exc}"
            store.record_audit(
                actor,
                "platform.provider_models_sync_failed",
                provider.id,
                {
                    "provider_id": provider.id,
                    "provider_kind": provider.kind,
                    "trigger": "provider_key_created",
                    "error": str(exc),
                },
            )
        else:
            imported_count, updated_count, removed_count = _reconcile_provider_models(
                store, provider, discovered_models
            )
            provider.connected = True
            provider_models = _provider_models(store, provider.id)
            try:
                runtime_model = _validate_provider_runtime(
                    store,
                    provider,
                    tenant_id=key.tenant_id,
                )
            except ModelGatewayAuthError as exc:
                _provider_runtime_auth_failure(
                    store,
                    provider,
                    exc,
                    tenant_id=key.tenant_id,
                )
                key.status = "Inactive"
                store.record_audit(
                    actor,
                    "platform.provider_runtime_validation_failed",
                    provider.id,
                    {
                        "provider_id": provider.id,
                        "provider_kind": provider.kind,
                        "trigger": "provider_key_created",
                        "status_code": exc.status_code,
                        "model_count": len(provider_models),
                    },
                )
            except ModelGatewayError as exc:
                provider.connected = False
                provider.last_sync = "Runtime test failed"
                provider.status_message = _provider_runtime_validation_failure(provider, exc)
                store.record_audit(
                    actor,
                    "platform.provider_runtime_validation_failed",
                    provider.id,
                    {
                        "provider_id": provider.id,
                        "provider_kind": provider.kind,
                        "trigger": "provider_key_created",
                        "error": str(exc),
                        "model_count": len(provider_models),
                    },
                )
            else:
                provider.last_sync = "Just synced"
                provider.status_message = f"{_provider_sync_source_label(provider, source)} Runtime test passed with {runtime_model.name}."
                store.record_audit(
                    actor,
                    "platform.provider_models_synced",
                    provider.id,
                    {
                        "provider_id": provider.id,
                        "provider_kind": provider.kind,
                        "source": source,
                        "trigger": "provider_key_created",
                        "imported_count": imported_count,
                        "updated_count": updated_count,
                        "removed_count": removed_count,
                        "model_count": len(provider_models),
                        "runtime_test_model_id": runtime_model.id,
                        "runtime_test_model_name": runtime_model.name,
                    },
                )
    store.record_audit(
        actor,
        "platform.provider_key_created",
        key.id,
        {
            "provider_id": provider.id,
            "provider_name": provider.name,
            "environment": key.environment,
            "masked_value": key.masked_value,
        },
    )
    store.save_runtime_state()
    return key


def _mark_provider_keys_invalid(
    store: SeedStore,
    provider_id: str,
    *,
    tenant_id: str | None = None,
) -> None:
    for key in store.provider_keys.values():
        if (
            key.provider_id == provider_id
            and key.tenant_id == tenant_id
            and key.status.lower() == "active"
        ):
            key.status = "Inactive"


def _provider_runtime_auth_failure(
    store: SeedStore,
    provider: Provider,
    exc: ModelGatewayAuthError,
    *,
    tenant_id: str | None = None,
) -> str:
    if tenant_id is None:
        provider.connected = False
        provider.last_sync = "Credential rejected"
    message = (
        f"{provider.name} rejected its provider key with HTTP {exc.status_code}. "
        "Paste a valid provider-generated key, make sure billing or credits are available, then sync models again."
    )
    if tenant_id is None:
        provider.status_message = message
    _mark_provider_keys_invalid(store, provider.id, tenant_id=tenant_id)
    return message


def _provider_runtime_validation_failure(provider: Provider, exc: ModelGatewayError) -> str:
    return (
        f"{provider.name} model sync succeeded, but live chat validation failed: {exc}. "
        "Check the provider key, billing or credits, base URL, and model access, then save a valid key and sync again."
    )


def _validate_provider_runtime(
    store: SeedStore,
    provider: Provider,
    *,
    tenant_id: str | None = None,
) -> ModelConfig:
    client = get_model_gateway_client()
    failures: list[str] = []
    candidates = _provider_runtime_test_candidates(store, provider)
    if not candidates:
        raise ModelGatewayError(
            f"{provider.name} has no synced models available for a live chat test."
        )

    for model in candidates:
        try:
            route = resolve_model_route(store, model, tenant_id=tenant_id)
            payload = client.complete(
                route=route,
                messages=[{"role": "user", "content": PROVIDER_RUNTIME_TEST_PROMPT}],
                max_tokens=PROVIDER_RUNTIME_TEST_TOKEN_BUDGET,
            )
        except ModelGatewayAuthError:
            raise
        except ModelGatewayError as exc:
            failures.append(f"{model.name}: {exc}")
            continue
        if _completion_payload_has_text(payload):
            return model
        failures.append(f"{model.name}: no text returned")

    detail = "; ".join(failures[:4])
    if len(failures) > 4:
        detail = f"{detail}; {len(failures) - 4} more failed"
    raise ModelGatewayError(detail or "No provider model returned text.")


def _completion_payload_has_text(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False
    choices = payload.get("choices")
    if not isinstance(choices, list):
        return False
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        if isinstance(message, dict) and str(message.get("content") or "").strip():
            return True
        if str(choice.get("text") or "").strip():
            return True
    content = payload.get("content")
    if isinstance(content, list):
        return any(
            isinstance(item, dict) and str(item.get("text") or "").strip() for item in content
        )
    return False


def _provider_runtime_test_candidates(store: SeedStore, provider: Provider) -> list[ModelConfig]:
    models = [
        model
        for model in _provider_models(store, provider.id)
        if not model.is_custom and (model.upstream_model_id or model.name)
    ]
    return sorted(models, key=_runtime_test_model_sort_key)


def _runtime_test_model_sort_key(model: ModelConfig) -> tuple[int, str]:
    route = f"{model.upstream_model_id or ''} {model.name}".lower()
    score = 100
    if "gpt-4o-mini" in route:
        score = 0
    elif "gpt-4.1-mini" in route or "gpt-4-1-mini" in route:
        score = 5
    elif "gemini" in route and "flash" in route and "image" not in route:
        score = 10
    elif "claude" in route and "haiku" in route:
        score = 15
    elif "llama" in route and ("8b" in route or "3.1" in route):
        score = 20
    elif "flash" in route and "image" not in route:
        score = 30
    elif "image" in route or "vision" in route:
        score = 200
    return (score, model.name.lower())


def _provider_supports_model_sync(provider: Provider) -> bool:
    """True when saving a key should automatically sync the model catalog.

    Known vendors and Anthropic reliably expose a model-list endpoint, so a
    sync failure there is a real signal worth flipping the provider health
    bit. Unknown/custom kinds stay manual: they still route at runtime (and
    the owner can trigger sync explicitly), but a gateway without /models
    must not be marked disconnected just because discovery is unavailable.
    """
    kind = provider.kind.strip().lower()
    if kind in UNSUPPORTED_PROVIDER_KINDS or kind in {"azure-openai", "azure-foundry"}:
        return False
    return kind in OPENAI_COMPATIBLE_KINDS or kind in {"openrouter", "anthropic"}


@router.post("/provider-keys/{key_id}/reveal")
def reveal_provider_key(
    key_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ProviderKeySecret:
    require_platform_owner(actor)
    if key_id not in store.provider_keys:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown provider key.")
    if store.provider_key_is_expired(store.provider_keys[key_id]):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Provider key is expired. Add a replacement key before revealing or using it.",
        )
    secret = store.provider_key_secret(key_id)
    store.record_audit(
        actor, "platform.provider_key_revealed", key_id, {"secret_value": secret.secret_value}
    )
    return secret


@router.post("/provider-keys/{key_id}/rotate")
def rotate_provider_key(
    key_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ProviderKey:
    require_platform_owner(actor)
    if key_id not in store.provider_keys:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown provider key.")
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            f"Provider keys cannot be rotated automatically by {store.brand_name()}. "
            "Create a new key in the provider portal, then add it as a replacement key."
        ),
    )


@router.delete("/provider-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_provider_key(
    key_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> None:
    require_platform_owner(actor)
    if key_id not in store.provider_keys:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown provider key.")
    key = store.delete_provider_key(key_id)
    provider = store.providers.get(key.provider_id)
    if provider is not None and key.tenant_id is None:
        provider.connected = store.provider_key_secret_for_provider(provider.id) is not None
    store.record_audit(
        actor,
        "platform.provider_key_deleted",
        key_id,
        {
            "name": key.name,
            "provider_id": key.provider_id,
            "provider_name": key.provider_name,
            "masked_value": key.masked_value,
        },
    )
    return None


@router.get("/connectors")
def platform_connectors(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[Connector]:
    require_platform_owner(actor)
    return list(store.connectors.values())


@router.patch("/connectors/{connector_id}")
def update_platform_connector(
    connector_id: str,
    payload: ConnectorUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Connector:
    require_platform_owner(actor)
    connector = store.connectors.get(connector_id)
    if connector is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown connector.")
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No connector updates provided."
        )
    for field, value in updates.items():
        if value is not None:
            setattr(connector, field, value)
    if connector.platform_enabled is False:
        connector.tenant_enabled = False
    store.record_audit(actor, "platform.connector_updated", connector.id, updates)
    return connector


@router.get("/audit-events")
def audit_events(
    limit: int = Query(default=200, ge=1, le=1000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[AuditEvent]:
    require_platform_owner(actor)
    return decorate_audit_events(store.audit_events_newest_first(limit))


@router.get("/usage-summary")
def platform_usage_summary(
    user_id: str | None = Query(default=None),
    from_date: str | None = Query(default=None),
    through_date: str | None = Query(default=None),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, object]:
    # Platform-wide usage, deliberately including platform owners: the owner
    # surface tracks owner, admin, and user activity alike.
    require_platform_owner(actor)
    records = store.usage_records_filtered(
        user_id=user_id,
        from_date=from_date,
        through_date=through_date,
    )
    return build_usage_summary(records)


@router.get("/usage-records")
def platform_usage_records(
    user_id: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=2000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[UsageRecord]:
    require_platform_owner(actor)
    return store.usage_records_filtered(
        user_id=user_id,
        newest_first=True,
        limit=limit,
    )


@router.get("/usage-budget")
def platform_usage_budget(
    tenant_slug: str | None = Header(default=None, alias="X-Aperture-Tenant"),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: TenantUsageBudgetRepository = Depends(get_usage_budget_repository),
) -> dict[str, object]:
    """Read one explicitly selected tenant's live UTC budget state."""

    require_platform_owner(actor)
    tenant_id = _owner_usage_tenant_id(actor, store, tenant_slug)
    return _usage_budget_snapshot(repository, tenant_id)


@router.patch("/usage-budget")
def update_platform_usage_budget(
    payload: TenantUsageBudgetUpdateRequest,
    tenant_slug: str | None = Header(default=None, alias="X-Aperture-Tenant"),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: TenantUsageBudgetRepository = Depends(get_usage_budget_repository),
) -> dict[str, object]:
    """Change one tenant's token or provider-reported-spend ceiling."""

    require_platform_owner(actor)
    tenant_id = _owner_usage_tenant_id(actor, store, tenant_slug)
    try:
        repository.set_budget(
            tenant_id,
            payload.resolved_token_limit(),
            budget_unit=payload.budget_unit,
            budget_period=payload.budget_period,
            spend_limit_nanos=payload.resolved_spend_limit_nanos(),
            updated_by=actor.id,
        )
    except UsageBudgetError as exc:
        raise _usage_budget_http_exception(exc) from exc
    store.record_audit(
        actor,
        "platform.tenant_usage_budget_updated",
        tenant_id,
        {
            "tenant_id": tenant_id,
            "budget_unit": payload.budget_unit,
            "budget_period": payload.budget_period,
            "limit_value": str(payload.resolved_limit_value()),
        },
    )
    return _usage_budget_snapshot(repository, tenant_id)


def _apply_platform_alert_rule_payload(
    rule: AlertRule,
    payload: AlertRuleCreateRequest | AlertRuleUpdateRequest,
) -> AlertRule:
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
            rule.actor_ids = [value.strip() for value in payload.actor_ids if value.strip()]
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


def _platform_alert_rule_audit_payload(rule: AlertRule) -> dict[str, object]:
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
def platform_alert_rules(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[AlertRule]:
    # Owners see every rule — platform-scope and tenant-scope alike — each
    # labeled by its scope field.
    require_platform_owner(actor)
    return [rule.model_copy() for rule in store.alert_rules.values()]


@router.post("/alert-rules", status_code=status.HTTP_201_CREATED)
def create_platform_alert_rule(
    payload: AlertRuleCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AlertRule:
    require_platform_owner(actor)
    rule = AlertRule(
        id=f"alertrule-{uuid4()}",
        scope="platform",
        tenant_id=None,
        name=payload.name.strip(),
        created_by=actor.id,
        created_by_name=actor.display_name,
    )
    _apply_platform_alert_rule_payload(rule, payload)
    store.alert_rules[rule.id] = rule
    store.record_audit(
        actor, "platform.alert_rule_created", rule.id, _platform_alert_rule_audit_payload(rule)
    )
    return rule


def _get_platform_alert_rule(rule_id: str, store: SeedStore) -> AlertRule:
    rule = store.alert_rules.get(rule_id)
    if rule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown alert rule.")
    return rule


@router.patch("/alert-rules/{rule_id}")
def update_platform_alert_rule(
    rule_id: str,
    payload: AlertRuleUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AlertRule:
    require_platform_owner(actor)
    rule = _get_platform_alert_rule(rule_id, store)
    _apply_platform_alert_rule_payload(rule, payload)
    store.record_audit(
        actor, "platform.alert_rule_updated", rule.id, _platform_alert_rule_audit_payload(rule)
    )
    return rule


@router.delete("/alert-rules/{rule_id}")
def delete_platform_alert_rule(
    rule_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_platform_owner(actor)
    rule = _get_platform_alert_rule(rule_id, store)
    del store.alert_rules[rule.id]
    store.application_state_repository.delete_alert_rule_runtime(rule.id)
    store.record_audit(
        actor, "platform.alert_rule_deleted", rule.id, _platform_alert_rule_audit_payload(rule)
    )
    return {"status": "deleted", "id": rule.id}


@router.get("/alert-notifications")
def platform_alert_notifications(
    limit: int = Query(default=100, ge=1, le=500),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[AlertNotification]:
    require_platform_owner(actor)
    return store.alert_notifications_newest_first(limit=limit)


@router.patch("/alert-notifications/{notification_id}")
def platform_archive_alert_notification(
    notification_id: str,
    payload: AlertNotificationArchiveRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AlertNotification:
    require_platform_owner(actor)
    notification = store.set_alert_notification_archived(notification_id, payload.archived)
    if notification is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown alert notification.")
    store.record_audit(
        actor,
        "platform.alert_notification_archived" if payload.archived else "platform.alert_notification_unarchived",
        notification.id,
        {"rule_name": notification.rule_name, "archived": notification.archived},
    )
    return notification


@router.get("/email-settings")
def platform_email_settings(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> EmailSettings:
    require_platform_owner(actor)
    # The SMTP password never leaves the encrypted vault; only its mask does.
    return store.email_settings.model_copy()


_EMAIL_SECURITY_MODES = ("starttls", "ssl", "none")


@router.put("/email-settings")
def update_platform_email_settings(
    payload: EmailSettingsUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> EmailSettings:
    require_platform_owner(actor)
    settings = store.email_settings
    changed: list[str] = []
    if payload.host is not None and payload.host.strip() != settings.host:
        settings.host = payload.host.strip()
        changed.append("host")
    if payload.port is not None and payload.port != settings.port:
        settings.port = payload.port
        changed.append("port")
    if payload.security is not None:
        security = payload.security.strip().lower()
        if security not in _EMAIL_SECURITY_MODES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"security must be one of {', '.join(_EMAIL_SECURITY_MODES)}.",
            )
        if security != settings.security:
            settings.security = security
            changed.append("security")
    if payload.username is not None and payload.username.strip() != settings.username:
        settings.username = payload.username.strip()
        changed.append("username")
    if payload.from_address is not None:
        from_address = payload.from_address.strip()
        if from_address and not EMAIL_PATTERN.match(from_address):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"'{from_address}' is not a valid from address.",
            )
        if from_address != settings.from_address:
            settings.from_address = from_address
            changed.append("from_address")
    if payload.password is not None:
        if payload.password == "":
            store.delete_configuration_secret("smtp", "primary")
            settings.password_set = False
            settings.masked_password = ""
        else:
            settings.masked_password = store.set_configuration_secret(
                "smtp", "primary", payload.password
            )
            settings.password_set = True
        changed.append("password")
    if changed:
        settings.updated_at = clock.now_iso()
        store.record_audit(
            actor,
            "platform.email_settings_updated",
            "email-settings",
            # Field names only — never values; the password never reaches audit.
            {"changed": changed},
        )
    store.save_runtime_state()
    return settings.model_copy()


@router.post("/email-settings/test")
def test_platform_email_settings(
    payload: EmailTestRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    """Send a real test email; returns the honest result either way.

    Sync route on purpose: FastAPI serves it from the threadpool, so the
    blocking SMTP call (15s timeout) cannot stall the event loop.
    """
    require_platform_owner(actor)
    recipient = payload.recipient.strip()
    if not EMAIL_PATTERN.match(recipient):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"'{recipient}' is not a valid email address.",
        )
    settings = store.email_settings
    if not email_configured(settings):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email delivery is not configured. Set the SMTP host and from address first.",
        )
    try:
        send_email(
            host=settings.host,
            port=settings.port,
            security=settings.security,
            username=settings.username,
            password=store.configuration_secret("smtp", "primary"),
            from_address=settings.from_address,
            recipients=[recipient],
            subject=f"{store.brand_name()} alert email test",
            body_text=(
                f"This is a test email from {store.brand_name()}.\n\n"
                "If you received it, alert email delivery is working for this platform."
            ),
        )
    except MailerError as exc:
        settings.last_test_at = clock.now_iso()
        settings.last_test_status = f"failed: {exc}"
        store.record_audit(
            actor, "platform.email_test_failed", "email-settings", {"recipient": recipient}
        )
        store.save_runtime_state()
        return {"status": "failed", "detail": str(exc)}
    settings.last_test_at = clock.now_iso()
    settings.last_test_status = "sent"
    store.record_audit(
        actor, "platform.email_test_sent", "email-settings", {"recipient": recipient}
    )
    store.save_runtime_state()
    return {"status": "sent", "detail": f"Test email sent to {recipient}."}


@router.get("/prompt-activity")
def prompt_activity(
    user_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[UserPromptRecord]:
    require_platform_owner(actor)
    # Platform owners audit each other too: every owner sees every user's
    # prompts and outputs, peer owners included, so owners stay mutually
    # accountable. Tenant admin surfaces still never expose owner activity.
    visible_user_ids = set(store.users)
    if user_id is not None and user_id not in visible_user_ids:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    records = store.user_prompt_records(None, user_id=user_id, limit=None)
    return [record for record in records if record.user_id in visible_user_ids][:limit]


@router.get("/security-alerts")
def security_alerts(
    user_id: str | None = Query(default=None),
    include_acknowledged: bool = Query(default=True),
    limit: int = Query(default=100, ge=1, le=500),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[SecurityAlert]:
    require_platform_owner(actor)
    if user_id is not None and user_id not in store.users:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    return store.security_alerts_newest_first(
        None,
        user_id=user_id,
        include_acknowledged=include_acknowledged,
        limit=limit,
    )


@router.patch("/security-alerts/{alert_id}")
def update_security_alert(
    alert_id: str,
    payload: SecurityAlertUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SecurityAlert:
    require_platform_owner(actor)
    alert = store.update_security_alert_acknowledgement(
        alert_id,
        acknowledged=payload.acknowledged,
        actor=actor,
    )
    if alert is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown security alert.")
    return alert


@router.get("/settings")
def platform_settings(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> PlatformSettings:
    require_platform_owner(actor)
    return store.platform_settings


@router.patch("/settings")
def update_platform_settings(
    payload: PlatformSettingsUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> PlatformSettings:
    require_platform_owner(actor)
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No platform setting updates provided."
        )
    previous = store.platform_settings.model_dump()
    for field, value in updates.items():
        if value is not None:
            setattr(store.platform_settings, field, value)
    store.record_audit(
        actor,
        "platform.settings_updated",
        "platform-settings",
        {
            "changed": sorted(updates),
            "previous": {field: previous[field] for field in updates},
            "current": {field: getattr(store.platform_settings, field) for field in updates},
        },
    )
    store.save_runtime_state()
    return store.platform_settings


@router.get("/tenants")
def list_tenants(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[TenantSummary]:
    require_platform_owner(actor)
    return [store.tenant_summary(tenant) for tenant in store.tenants.values()]


@router.get("/tenants/{tenant_id}")
def get_tenant(
    tenant_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantSummary:
    require_platform_owner(actor)
    tenant = store.tenants.get(tenant_id)
    if tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    return store.tenant_summary(tenant)


@router.post("/tenants", status_code=status.HTTP_201_CREATED)
def create_tenant(
    payload: TenantCreate,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantSummary:
    require_platform_owner(actor)
    try:
        return store.create_tenant(payload, actor)
    except TenantStoreError as exc:
        raise _tenant_store_http_error(exc) from exc


@router.patch("/tenants/{tenant_id}")
def update_tenant(
    tenant_id: str,
    payload: TenantUpdate,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> TenantSummary:
    require_platform_owner(actor)
    try:
        return store.update_tenant(tenant_id, payload, actor)
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant."
        ) from exc
    except TenantStoreError as exc:
        raise _tenant_store_http_error(exc) from exc


@router.delete("/tenants/{tenant_id}")
def delete_tenant(
    tenant_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_platform_owner(actor)
    try:
        tenant = store.delete_tenant(tenant_id, actor)
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant."
        ) from exc
    except FinalTenantDeletionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return {"status": "deleted", "id": tenant.id}


@router.get("/tenants/{tenant_id}/scim-tokens")
def list_scim_tokens(
    tenant_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[ScimTokenSummary]:
    require_platform_owner(actor)
    if tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    return store.scim_token_summaries(tenant_id)


@router.post(
    "/tenants/{tenant_id}/scim-tokens",
    response_model=ScimTokenCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_scim_token(
    tenant_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ScimTokenCreateResponse:
    require_platform_owner(actor)
    try:
        summary, secret_value = store.mint_scim_token(tenant_id, actor)
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant."
        ) from exc
    return ScimTokenCreateResponse(**summary.model_dump(), secret_value=secret_value)


@router.delete("/tenants/{tenant_id}/scim-tokens/{token_id}")
def revoke_scim_token(
    tenant_id: str,
    token_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ScimTokenSummary:
    require_platform_owner(actor)
    try:
        return store.revoke_scim_token(tenant_id, token_id, actor)
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown SCIM token."
        ) from exc


@router.patch("/tenants/{tenant_id}/branding")
def update_tenant_branding(
    tenant_id: str,
    payload: TenantBrandingUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Tenant:
    require_platform_owner(actor)
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No branding updates provided."
        )
    try:
        return store.update_tenant(
            tenant_id,
            TenantUpdate(**updates),
            actor,
            audit_action="platform.branding_updated",
        )
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant."
        ) from exc
    except TenantStoreError as exc:
        raise _tenant_store_http_error(exc) from exc


def _tenant_store_http_error(exc: TenantStoreError) -> HTTPException:
    code = (
        status.HTTP_409_CONFLICT
        if isinstance(exc, TenantConflictError)
        else status.HTTP_400_BAD_REQUEST
    )
    return HTTPException(status_code=code, detail=str(exc))


def _owner_usage_tenant_id(
    actor: User,
    store: SeedStore,
    tenant_slug: str | None,
) -> str:
    normalized_slug = (tenant_slug or "").strip()
    if not normalized_slug:
        # Single-tenant posture: a deployment with exactly one tenant needs no
        # header. Ambiguity (multiple tenant rows) still fails explicitly.
        if len(store.tenants) == 1:
            sole_tenant_id = next(iter(store.tenants.keys()))
            try:
                return resolve_usage_tenant_id(
                    actor,
                    explicit_tenant_id=sole_tenant_id,
                    known_tenant_ids=store.tenants.keys(),
                )
            except UsageTenantScopeError as exc:
                raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-Aperture-Tenant is required for platform-owner usage budgets.",
        )
    tenant = store.tenant_by_slug(normalized_slug)
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown tenant slug.",
        )
    try:
        return resolve_usage_tenant_id(
            actor,
            explicit_tenant_id=tenant.id,
            known_tenant_ids=store.tenants.keys(),
        )
    except UsageTenantScopeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _usage_budget_snapshot(
    repository: TenantUsageBudgetRepository,
    tenant_id: str,
) -> dict[str, object]:
    try:
        budget = repository.get_budget(tenant_id)
        if budget is None:
            raise UsageBudgetUnavailable("Tenant usage budget is not provisioned.")
        current = clock.now()
        period_usage = repository.get_period_usage(
            tenant_id,
            budget.budget_period,
            now=current,
        )
    except UsageBudgetError as exc:
        raise _usage_budget_http_exception(exc) from exc
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
    }


def _usage_budget_http_exception(error: UsageBudgetError) -> HTTPException:
    failure = map_usage_budget_error(error)
    return HTTPException(
        status_code=failure.status_code,
        detail=failure.detail,
        headers=dict(failure.headers),
    )


@router.get("/elastic/status")
def elastic_status(
    actor: User = Depends(current_user), store: SeedStore = Depends(get_store)
) -> dict[str, object]:
    require_platform_owner(actor)
    settings = get_settings()
    configured = bool(settings.elastic_url and settings.elastic_api_key)
    last_delivery = store.elastic_last_delivery_at
    delivery_error = store.elastic_last_delivery_error
    if not configured:
        message = (
            "Elastic analytics export is not configured. Set APERTURE_ELASTIC_URL "
            "and APERTURE_ELASTIC_API_KEY to enable background delivery."
        )
    elif delivery_error:
        message = f"Elastic export is configured but the last delivery failed: {delivery_error}"
    elif last_delivery:
        message = "Elastic export is active; buffered audit events are delivered in the background."
    else:
        message = (
            "Elastic export is configured; buffered audit events will be delivered "
            "on the next scheduler pass."
        )
    return {
        "configured": configured,
        "connected": configured and delivery_error is None,
        "endpoint": settings.elastic_url,
        "lastSync": last_delivery or ("Not connected" if not configured else "No delivery yet"),
        "eventsBuffered": store.elastic_pending_count(),
        "lastDeliveryError": delivery_error,
        "message": message,
    }


def _get_provider(provider_id: str, store: SeedStore) -> Provider:
    provider = store.providers.get(provider_id)
    if provider is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown provider.")
    return provider


def _get_model(model_id: str, store: SeedStore) -> ModelConfig:
    model = store.models.get(model_id)
    if model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown model.")
    return model


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
                # Newly discovered catalog models wait for an explicit owner
                # enable; the enable flow grants the default user group.
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


def _with_default_user_group(
    store: SeedStore,
    group_ids: list[str],
    *,
    tenant_id: str | None,
) -> list[str]:
    group_ids = list(dict.fromkeys(group_ids))
    if not store.platform_settings.default_user_group_enabled:
        return group_ids
    store.ensure_default_user_group()
    default_groups = [
        group
        for group in store.groups.values()
        if group.default_group and (tenant_id is None or group.tenant_id == tenant_id)
    ]
    for default_group in default_groups:
        if default_group.id not in group_ids:
            group_ids.append(default_group.id)
    return group_ids


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


def _assert_model_config_references(
    knowledge_config_ids: list[str] | None,
    tool_config_ids: list[str] | None,
    prompt_template_ids: list[str] | None,
    skill_file_ids: list[str] | None,
    store: SeedStore,
    *,
    tenant_id: str | None,
) -> None:
    scoped_references: list[tuple[str, list[str] | None, dict[str, object]]] = [
        ("knowledge configuration", knowledge_config_ids, store.knowledge_configs),
        ("tool configuration", tool_config_ids, store.tool_configs),
        ("prompt template", prompt_template_ids, store.prompt_templates),
        ("skill file", skill_file_ids, store.skill_files),
    ]
    for label, record_ids, records in scoped_references:
        if not record_ids:
            continue
        if any(record_id not in records for record_id in record_ids):
            # The detailed missing-id checks below preserve the established 404
            # response instead of masking it as a tenant-scope error.
            continue
        if tenant_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"tenant_id is required when attaching a {label}.",
            )
        outside = [
            record_id
            for record_id in record_ids
            if record_id in records and getattr(records[record_id], "tenant_id", None) != tenant_id
        ]
        if outside:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"{label.title()} is outside the target tenant.",
            )
    if knowledge_config_ids is not None:
        missing_knowledge_ids = [
            config_id
            for config_id in knowledge_config_ids
            if config_id not in store.knowledge_configs
        ]
        if missing_knowledge_ids:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Unknown knowledge configuration: {', '.join(missing_knowledge_ids)}.",
            )
    if tool_config_ids is not None:
        missing_tool_ids = [
            config_id for config_id in tool_config_ids if config_id not in store.tool_configs
        ]
        if missing_tool_ids:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Unknown tool configuration: {', '.join(missing_tool_ids)}.",
            )
    if prompt_template_ids is not None:
        missing_template_ids = [
            template_id
            for template_id in prompt_template_ids
            if template_id not in store.prompt_templates
        ]
        if missing_template_ids:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Unknown prompt template: {', '.join(missing_template_ids)}.",
            )
    if skill_file_ids is not None:
        missing_skill_ids = [
            skill_id for skill_id in skill_file_ids if skill_id not in store.skill_files
        ]
        if missing_skill_ids:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Unknown skill file: {', '.join(missing_skill_ids)}.",
            )


def _assert_platform_group_scope(
    group_ids: list[str],
    tenant_id: str | None,
    store: SeedStore,
) -> None:
    missing = [group_id for group_id in group_ids if group_id not in store.groups]
    if missing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown group.")
    if tenant_id is None:
        return
    if any(store.groups[group_id].tenant_id != tenant_id for group_id in group_ids):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Model groups must belong to the target tenant.",
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
