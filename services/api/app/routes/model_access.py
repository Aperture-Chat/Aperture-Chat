"""Explainable model access and reviewable per-model access requests.

User-facing routes tell a signed-in person which organization models exist,
why each one is or is not usable (server-owned wording), and let them ask for
access. Admin routes list and resolve those requests and expose a read-only
per-user access trace. Every decision comes from
:func:`app.core.policy.explain_model_access`; nothing here widens what the
policy already allows, and a pending request never changes a verdict.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from app.core.config import get_settings
from app.core.policy import (
    GATE_PLATFORM_ENABLED,
    REQUESTABLE_REASON_CODES,
    ModelAccessDecision,
    agent_profile_access_allowed,
    can_view_user,
    explain_model_access,
    is_platform_owner,
    is_tenant_admin,
    is_workspace_agent_profile,
    require_admin_or_owner,
)
from app.core.rate_limit import ProcessLocalTokenBucket
from app.models.schemas import (
    AdminModelAccessRequestView,
    ModelAccessDecisionResponse,
    ModelAccessGateResponse,
    ModelAccessRequest,
    ModelAccessRequestCreate,
    ModelAccessRequestResolution,
    ModelAccessRequestResolve,
    ModelAccessRequestStatus,
    ModelCatalogEntry,
    ModelCatalogModel,
    ModelCatalogResponse,
    ModelConfig,
    Role,
    User,
    UserModelAccessTrace,
    UserModelAccessTraceEntry,
)
from app.repositories.deps import get_store
from app.repositories.model_access_requests import (
    ModelAccessRequestConflict,
    ModelAccessRequestError,
    ModelAccessRequestNotFound,
    ModelAccessRequestRepository,
    ModelAccessRequestUnavailable,
)
from app.repositories.seed import SeedStore
from app.routes.admin import (
    _advance_user_session_watermark_or_503,
    _assert_group_scope,
    _assert_model_access_delegated,
)
from app.routes.dependencies import current_user

router = APIRouter(tags=["model-access"])

# One bucket per (tenant, user): a person can file a handful of requests per
# minute, never a flood. Mirrors the pre-account access-request limiter.
_REQUEST_BUCKETS = ProcessLocalTokenBucket(
    max_entries=get_settings().rate_limit_max_buckets,
    idle_ttl_seconds=get_settings().rate_limit_idle_ttl_seconds,
)
_REQUESTS_PER_MINUTE = 5


def get_model_access_request_repository(
    store: SeedStore = Depends(get_store),
) -> ModelAccessRequestRepository:
    return store.model_access_request_repository


# --- helpers -----------------------------------------------------------------


def _decision_response(decision: ModelAccessDecision) -> ModelAccessDecisionResponse:
    return ModelAccessDecisionResponse(
        allowed=decision.allowed,
        usable=decision.usable,
        reason_code=decision.reason_code,
        reason=decision.reason,
        gates=[
            ModelAccessGateResponse(key=gate.key, passed=gate.passed, detail=gate.detail)
            for gate in decision.gates
        ],
        requestable=(
            not decision.allowed and decision.reason_code in REQUESTABLE_REASON_CODES
        ),
    )


def _catalog_model(model: ModelConfig) -> ModelCatalogModel:
    return ModelCatalogModel(
        id=model.id,
        name=model.name,
        provider_id=model.provider_id,
        provider_name=model.provider_name,
        upstream_model_id=model.upstream_model_id,
        platform_enabled=model.platform_enabled,
        is_custom=model.is_custom,
        visibility=model.visibility,
        context_window=model.context_window,
    )


def _explain(store: SeedStore, user: User, model: ModelConfig) -> ModelAccessDecision:
    return explain_model_access(user, model, provider=store.providers.get(model.provider_id))


def _in_tenant_scope(model: ModelConfig, tenant_id: str | None) -> bool:
    return model.tenant_id is None or model.tenant_id == tenant_id


def _catalog_models_for(store: SeedStore, subject: User) -> list[ModelConfig]:
    """Models a tenant member may know exist: platform-enabled, in tenant scope.

    Private agent profiles the subject cannot see are excluded so the list never
    reveals another person's private agent by name. Owners get the full catalog.
    """

    if is_platform_owner(subject):
        return sorted(store.models.values(), key=lambda model: model.name.casefold())
    models: list[ModelConfig] = []
    for model in store.models.values():
        if not model.platform_enabled or not _in_tenant_scope(model, subject.tenant_id):
            continue
        if is_workspace_agent_profile(model):
            visibility = (model.visibility or "tenant").lower()
            if visibility == "private" and not agent_profile_access_allowed(subject, model):
                continue
        models.append(model)
    return sorted(models, key=lambda model: model.name.casefold())


def _visible_model_or_404(store: SeedStore, actor: User, model_id: str) -> ModelConfig:
    model = store.models.get(model_id.strip())
    if model is None or not _in_tenant_scope(model, actor.tenant_id) and not is_platform_owner(actor):
        # Do not confirm the existence of another organization's model.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown model.")
    if not model.platform_enabled and not is_platform_owner(actor):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown model.")
    return model


def _require_tenant_member(actor: User) -> str:
    if actor.tenant_id is None or not actor.tenant_id.strip():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A tenant-scoped account is required for model access requests.",
        )
    return actor.tenant_id


def _admin_tenant_scope(
    actor: User, store: SeedStore, tenant_slug: str | None
) -> str | None:
    """Tenant admins are pinned to their tenant; owners may name one or see all."""

    requested = (tenant_slug or "").strip()
    if is_platform_owner(actor):
        if not requested:
            return None
        tenant = store.tenant_by_slug(requested)
        if tenant is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant slug.")
        return tenant.id
    tenant_id = _require_tenant_member(actor)
    if requested:
        tenant = store.tenant_by_slug(requested)
        if tenant is None or tenant.id != tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="The requested tenant is outside the authenticated tenant scope.",
            )
    return tenant_id


def _admin_view(
    store: SeedStore, actor: User, request: ModelAccessRequest
) -> AdminModelAccessRequestView | None:
    requester = store.users.get(request.user_id)
    model = store.models.get(request.model_id)
    if requester is None or model is None or not can_view_user(actor, requester):
        return None
    tenant_group_ids = {
        group_id for group_id, group in store.groups.items() if group.tenant_id == request.tenant_id
    }
    eligible = [group_id for group_id in model.group_ids if group_id in tenant_group_ids]
    can_grant = True
    try:
        _assert_model_access_delegated(actor, model, store)
    except HTTPException:
        can_grant = False
    return AdminModelAccessRequestView(
        request=request,
        requester_display_name=requester.display_name,
        requester_email=requester.email,
        requester_group_ids=list(requester.group_ids),
        model_name=model.name,
        model_provider_name=model.provider_name,
        eligible_group_ids=eligible,
        can_grant_new_group=can_grant and model.platform_enabled,
        decision=_decision_response(_explain(store, requester, model)),
    )


def _repository_errors(exc: Exception) -> HTTPException:
    if isinstance(exc, ModelAccessRequestNotFound):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown access request.")
    if isinstance(exc, ModelAccessRequestConflict):
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    if isinstance(exc, ModelAccessRequestUnavailable):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Access requests are temporarily unavailable.",
        )
    raise exc


# --- signed-in person ----------------------------------------------------------


@router.get("/api/me/model-catalog")
def my_model_catalog(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: ModelAccessRequestRepository = Depends(get_model_access_request_repository),
) -> ModelCatalogResponse:
    browsing_enabled = bool(store.platform_settings.users_can_browse_model_catalog)
    open_requests: dict[str, ModelAccessRequest] = {}
    if actor.tenant_id:
        try:
            open_requests = repository.pending_for_user(tenant_id=actor.tenant_id, user_id=actor.id)
        except ModelAccessRequestUnavailable as exc:
            raise _repository_errors(exc) from exc
    entries: list[ModelCatalogEntry] = []
    for model in _catalog_models_for(store, actor):
        decision = _explain(store, actor, model)
        if not browsing_enabled and not decision.allowed and not is_platform_owner(actor):
            # Kill switch: hide what the person cannot already use.
            continue
        entries.append(
            ModelCatalogEntry(
                model=_catalog_model(model),
                decision=_decision_response(decision),
                open_request=open_requests.get(model.id),
            )
        )
    return ModelCatalogResponse(entries=entries, browsing_enabled=browsing_enabled)


@router.get("/api/me/model-access/{model_id}")
def my_model_access(
    model_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> ModelAccessDecisionResponse:
    model = _visible_model_or_404(store, actor, model_id)
    return _decision_response(_explain(store, actor, model))


@router.get("/api/me/model-access-requests")
def my_model_access_requests(
    actor: User = Depends(current_user),
    repository: ModelAccessRequestRepository = Depends(get_model_access_request_repository),
) -> list[ModelAccessRequest]:
    tenant_id = _require_tenant_member(actor)
    try:
        return repository.list_for_user(tenant_id=tenant_id, user_id=actor.id)
    except ModelAccessRequestError as exc:
        raise _repository_errors(exc) from exc


@router.post("/api/me/model-access-requests", status_code=status.HTTP_202_ACCEPTED)
def create_model_access_request(
    payload: ModelAccessRequestCreate,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: ModelAccessRequestRepository = Depends(get_model_access_request_repository),
) -> ModelCatalogEntry:
    if is_platform_owner(actor):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Platform owners already have access to every enabled model.",
        )
    tenant_id = _require_tenant_member(actor)
    if not store.platform_settings.users_can_browse_model_catalog:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Model access requests are disabled by organization policy.",
        )
    model = _visible_model_or_404(store, actor, payload.model_id)
    decision = _explain(store, actor, model)
    if decision.allowed and decision.usable:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You already have access.")
    if decision.allowed:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You already have access; the provider is not connected right now.",
        )
    if decision.reason_code not in REQUESTABLE_REASON_CODES:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This model cannot be requested for your account.",
        )
    allowed, retry_after = _REQUEST_BUCKETS.consume(f"{tenant_id}:{actor.id}", _REQUESTS_PER_MINUTE)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many access requests. Try again shortly.",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        request = repository.create(
            tenant_id=tenant_id, user_id=actor.id, model_id=model.id, note=payload.note
        )
    except ModelAccessRequestError as exc:
        raise _repository_errors(exc) from exc
    store.record_audit(
        actor,
        "user.model_access_requested",
        model.id,
        {"model_id": model.id, "reason_code": decision.reason_code, "request_id": request.id},
    )
    return ModelCatalogEntry(
        model=_catalog_model(model),
        decision=_decision_response(decision),
        open_request=request,
    )


@router.delete("/api/me/model-access-requests/{request_id}")
def withdraw_model_access_request(
    request_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: ModelAccessRequestRepository = Depends(get_model_access_request_repository),
) -> ModelAccessRequest:
    tenant_id = _require_tenant_member(actor)
    existing = repository.get(request_id, tenant_id=tenant_id)
    if existing is None or existing.user_id != actor.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown access request.")
    try:
        withdrawn = repository.resolve(
            request_id, tenant_id=tenant_id, status="withdrawn", resolved_by_user_id=actor.id
        )
    except ModelAccessRequestError as exc:
        raise _repository_errors(exc) from exc
    store.record_audit(
        actor, "user.model_access_request_withdrawn", existing.model_id, {"request_id": request_id}
    )
    return withdrawn


# --- administrators --------------------------------------------------------------


@router.get("/api/admin/model-access-requests")
def list_model_access_requests(
    request_status: ModelAccessRequestStatus | None = Query(default="pending", alias="status"),
    tenant_slug: str | None = Header(default=None, alias="X-Aperture-Tenant"),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: ModelAccessRequestRepository = Depends(get_model_access_request_repository),
) -> list[AdminModelAccessRequestView]:
    require_admin_or_owner(actor)
    tenant_id = _admin_tenant_scope(actor, store, tenant_slug)
    try:
        requests = repository.list_for_tenant(tenant_id=tenant_id, status=request_status)
    except ModelAccessRequestError as exc:
        raise _repository_errors(exc) from exc
    views = (_admin_view(store, actor, request) for request in requests)
    return [view for view in views if view is not None]


@router.post("/api/admin/model-access-requests/{request_id}/approve")
def approve_model_access_request(
    request_id: str,
    payload: ModelAccessRequestResolve,
    tenant_slug: str | None = Header(default=None, alias="X-Aperture-Tenant"),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: ModelAccessRequestRepository = Depends(get_model_access_request_repository),
) -> ModelAccessRequestResolution:
    require_admin_or_owner(actor)
    scope_tenant = _admin_tenant_scope(actor, store, tenant_slug)
    request = _pending_request_for_admin(repository, request_id, scope_tenant, store, actor)
    requester = store.users.get(request.user_id)
    model = store.models.get(request.model_id)
    if requester is None or model is None or not can_view_user(actor, requester):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown access request.")
    if not payload.group_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Approving requires the group that should carry the model.",
        )
    if not model.platform_enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The model is disabled by the platform owner; enable it before approving.",
        )
    group_id = payload.group_id.strip()
    _assert_group_scope(actor, [group_id], store, tenant_id=request.tenant_id)
    group = store.groups[group_id]
    if group.tenant_id != request.tenant_id or requester.tenant_id != request.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant admins can only assign groups from their tenant.",
        )
    if requester.role in {Role.PLATFORM_OWNER}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Owners need no grant.")

    model_group_ids_before = list(model.group_ids)
    if group_id not in model.group_ids:
        # Granting the model to a new group is the existing admin model-access
        # write with the existing delegation ceiling; nothing wider.
        _assert_model_access_delegated(actor, model, store)
        model.group_ids = list(dict.fromkeys([*model.group_ids, group_id]))
        model.tenant_restricted = True
        store.record_audit(
            actor,
            "admin.model_access_updated",
            model.id,
            {
                "group_ids": model.group_ids,
                "previous_group_ids": model_group_ids_before,
                "provider_id": model.provider_id,
                "request_id": request.id,
            },
        )

    expected_role = requester.role
    expected_tenant_id = requester.tenant_id
    if group_id not in requester.group_ids:
        with store._store_lock:
            _advance_user_session_watermark_or_503(
                store,
                requester,
                reason="admin-model-access-request-approved",
                updated_by=actor.id,
                deactivate=False,
                expected_role=expected_role,
                expected_tenant_id=expected_tenant_id,
            )
            requester.group_ids = list(dict.fromkeys([*requester.group_ids, group_id]))

    try:
        resolved = repository.resolve(
            request.id,
            tenant_id=request.tenant_id,
            status="approved",
            resolved_by_user_id=actor.id,
            resolution_note=payload.note,
            granted_group_id=group_id,
        )
    except ModelAccessRequestError as exc:
        raise _repository_errors(exc) from exc
    store.record_audit(
        actor,
        "admin.model_access_request_approved",
        request.user_id,
        {"model_id": model.id, "group_id": group_id, "request_id": request.id},
    )
    store.save_runtime_state()
    # Real post-state: the decision the requester will actually see now.
    return ModelAccessRequestResolution(
        request=resolved, decision=_decision_response(_explain(store, requester, model))
    )


@router.post("/api/admin/model-access-requests/{request_id}/decline")
def decline_model_access_request(
    request_id: str,
    payload: ModelAccessRequestResolve,
    tenant_slug: str | None = Header(default=None, alias="X-Aperture-Tenant"),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    repository: ModelAccessRequestRepository = Depends(get_model_access_request_repository),
) -> ModelAccessRequestResolution:
    require_admin_or_owner(actor)
    scope_tenant = _admin_tenant_scope(actor, store, tenant_slug)
    request = _pending_request_for_admin(repository, request_id, scope_tenant, store, actor)
    requester = store.users.get(request.user_id)
    model = store.models.get(request.model_id)
    try:
        resolved = repository.resolve(
            request.id,
            tenant_id=request.tenant_id,
            status="declined",
            resolved_by_user_id=actor.id,
            resolution_note=payload.note,
        )
    except ModelAccessRequestError as exc:
        raise _repository_errors(exc) from exc
    store.record_audit(
        actor,
        "admin.model_access_request_declined",
        request.user_id,
        {"model_id": request.model_id, "request_id": request.id},
    )
    decision = (
        _decision_response(_explain(store, requester, model))
        if requester is not None and model is not None
        else ModelAccessDecisionResponse(
            allowed=False,
            usable=False,
            reason_code=GATE_PLATFORM_ENABLED,
            reason="The model or account no longer exists.",
        )
    )
    return ModelAccessRequestResolution(request=resolved, decision=decision)


@router.get("/api/admin/users/{user_id}/model-access")
def trace_user_model_access(
    user_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> UserModelAccessTrace:
    require_admin_or_owner(actor)
    target = store.users.get(user_id)
    if target is None or not can_view_user(actor, target):
        # Tenant admins never learn whether an owner id exists.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    if is_tenant_admin(actor) and target.tenant_id != actor.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown user.")
    entries = [
        UserModelAccessTraceEntry(
            model=_catalog_model(model),
            decision=_decision_response(_explain(store, target, model)),
        )
        for model in _catalog_models_for(store, target)
    ]
    return UserModelAccessTrace(
        user_id=target.id,
        display_name=target.display_name,
        group_ids=list(target.group_ids),
        entries=entries,
    )


def _pending_request_for_admin(
    repository: ModelAccessRequestRepository,
    request_id: str,
    scope_tenant: str | None,
    store: SeedStore,
    actor: User,
) -> ModelAccessRequest:
    candidate: ModelAccessRequest | None = None
    try:
        if scope_tenant is not None:
            candidate = repository.get(request_id, tenant_id=scope_tenant)
        else:
            for tenant_id in store.tenants:
                candidate = repository.get(request_id, tenant_id=tenant_id)
                if candidate is not None:
                    break
    except ModelAccessRequestUnavailable as exc:
        raise _repository_errors(exc) from exc
    if candidate is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown access request.")
    if not is_platform_owner(actor) and candidate.tenant_id != actor.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown access request.")
    if candidate.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="This request has already been resolved."
        )
    return candidate

