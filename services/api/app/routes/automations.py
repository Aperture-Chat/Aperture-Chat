"""Automations: scheduled/on-demand model-chain jobs over chat or drafts.

Enabled schedules (once/weekly/cron, UTC) are executed by the in-process
scheduler (app/core/scheduler.py) through the exact same chain runner this
route uses, so "Run now" and a scheduled fire behave identically: real gateway
calls, real model-access checks, honest run bookkeeping.
"""

from __future__ import annotations

import logging
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status

from app.core import clock
from app.core.automation_runner import (
    execute_chain,
    record_run_failure,
    record_run_success,
)
from app.core.model_gateway import ModelGatewayError, get_model_gateway_client
from app.core.policy import (
    assert_model_access,
    is_platform_owner,
    is_tenant_admin,
)
from app.models.schemas import (
    Automation,
    AutomationCreateRequest,
    AutomationRunRequest,
    AutomationStep,
    AutomationUpdateRequest,
    User,
)
from app.core.usage_budget_runtime import TenantUsageBudgetOrchestrator
from app.repositories.deps import get_store, get_usage_budget_orchestrator
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/automations", tags=["automations"])

VALID_SURFACES = {"chat", "draft"}
VALID_TRIGGERS = {"once", "daily", "weekly", "cron"}
logger = logging.getLogger("aperture.automations")


def _record_run_failure_without_masking(
    store: SeedStore,
    automation: Automation,
    actor: User,
    error: str,
) -> None:
    """Best-effort failure bookkeeping that never replaces the run error."""

    try:
        record_run_failure(store, automation, actor, error)
    except Exception:  # noqa: BLE001 - the original execution error is authoritative
        logger.exception("Could not persist failure status for automation %s", automation.id)


def _visible(actor: User, store: SeedStore) -> list[Automation]:
    if is_platform_owner(actor):
        return list(store.automations.values())
    same_tenant = [a for a in store.automations.values() if a.tenant_id == actor.tenant_id]
    if is_tenant_admin(actor):
        return same_tenant
    # Ordinary users only see the automations they created, not every workflow
    # (prompts/steps) authored by others in their tenant.
    return [a for a in same_tenant if a.created_by == actor.id]


def _get_visible(automation_id: str, actor: User, store: SeedStore) -> Automation:
    automation = store.automations.get(automation_id)
    if automation is None or (
        not is_platform_owner(actor) and automation.tenant_id != actor.tenant_id
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown automation.")
    return automation


def _get_manageable(automation_id: str, actor: User, store: SeedStore) -> Automation:
    """Fetch an automation the actor may run, edit, or delete.

    Same-tenant visibility is not enough for a mutating/executing action: only
    the creator, a tenant admin, or the platform owner may operate on it.
    """
    automation = _get_visible(automation_id, actor, store)
    if is_platform_owner(actor) or is_tenant_admin(actor) or automation.created_by == actor.id:
        return automation
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You can only manage automations you created.",
    )


def _validate_shape(
    *,
    surface: str,
    trigger_type: str,
    steps: list[AutomationStep],
    actor: User,
    store: SeedStore,
    tenant_id: str,
) -> None:
    if surface not in VALID_SURFACES:
        raise HTTPException(
            status_code=400, detail=f"Surface must be one of: {', '.join(sorted(VALID_SURFACES))}."
        )
    if trigger_type not in VALID_TRIGGERS:
        raise HTTPException(
            status_code=400, detail=f"Trigger must be one of: {', '.join(sorted(VALID_TRIGGERS))}."
        )
    if not steps:
        raise HTTPException(status_code=400, detail="An automation needs at least one model step.")
    for index, step in enumerate(steps, start=1):
        model = store.models.get(step.model_id)
        if model is None:
            raise HTTPException(
                status_code=404,
                detail=f"Step {index} references an unknown model '{step.model_id}'.",
            )
        if model.tenant_id is not None and model.tenant_id != tenant_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Step {index} references a model outside the automation tenant.",
            )
        # Only models the actor is approved to use may be chained in.
        assert_model_access(actor, model)


@router.get("")
def list_automations(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[Automation]:
    return _visible(actor, store)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_automation(
    payload: AutomationCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Automation:
    if is_platform_owner(actor):
        # Owners may name a tenant explicitly, but saving must also just work
        # without one: fall back to the owner's own tenant, then to the sole
        # tenant on single-tenant deployments. Only a genuinely ambiguous
        # multi-tenant platform still requires an explicit tenant_id.
        tenant_id = payload.tenant_id or actor.tenant_id
        if tenant_id is None and len(store.tenants) == 1:
            tenant_id = next(iter(store.tenants))
        if tenant_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="tenant_id is required when multiple tenants exist.",
            )
    else:
        if actor.tenant_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Tenant scope is required."
            )
        tenant_id = actor.tenant_id
    if tenant_id not in store.tenants:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tenant.")
    _validate_shape(
        surface=payload.surface,
        trigger_type=payload.trigger_type,
        steps=payload.steps,
        actor=actor,
        store=store,
        tenant_id=tenant_id,
    )
    automation_id = payload.id or f"automation-{uuid4()}"
    if automation_id in store.automations:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Automation already exists."
        )
    automation = Automation(
        id=automation_id,
        tenant_id=tenant_id,
        name=payload.name,
        surface=payload.surface,
        trigger_type=payload.trigger_type,
        run_at=payload.run_at,
        weekly_day=payload.weekly_day,
        time_of_day=payload.time_of_day,
        cron_expression=payload.cron_expression,
        prompt=payload.prompt,
        steps=payload.steps,
        enabled=payload.enabled,
        created_by=actor.id,
        created_at=clock.now_iso(),
        updated_at=clock.now_iso(),
    )
    store.automations[automation.id] = automation
    store.record_audit(
        actor,
        "automation.created",
        automation.id,
        {"surface": automation.surface, "created_at": automation.created_at},
    )
    store.save_runtime_state()
    return automation


@router.patch("/{automation_id}")
def update_automation(
    automation_id: str,
    payload: AutomationUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Automation:
    automation = _get_manageable(automation_id, actor, store)
    updates = payload.model_dump(exclude_unset=True)
    merged = automation.model_copy(update=updates)
    _validate_shape(
        surface=merged.surface,
        trigger_type=merged.trigger_type,
        steps=merged.steps,
        actor=actor,
        store=store,
        tenant_id=automation.tenant_id,
    )
    merged.updated_at = clock.now_iso()
    store.automations[automation.id] = merged
    store.record_audit(
        actor, "automation.updated", automation.id, {**updates, "updated_at": merged.updated_at}
    )
    store.save_runtime_state()
    return merged


@router.delete("/{automation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_automation(
    automation_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> None:
    automation = _get_manageable(automation_id, actor, store)
    del store.automations[automation.id]
    store.record_audit(actor, "automation.deleted", automation.id, {})
    store.save_runtime_state()


@router.post("/{automation_id}/run")
def run_automation(
    automation_id: str,
    payload: AutomationRunRequest | None = None,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    usage_budget_orchestrator: TenantUsageBudgetOrchestrator = Depends(
        get_usage_budget_orchestrator
    ),
) -> dict[str, object]:
    """Execute the model chain now. Each step's output feeds the next step.

    An optional ``input`` in the body replaces the stored prompt for this run
    only, so a chat-initiated run answers the user's actual question instead of
    re-running the canned schedule prompt.
    """
    automation = _get_manageable(automation_id, actor, store)
    if not automation.steps:
        raise HTTPException(status_code=400, detail="This automation has no steps to run.")

    prompt_override = None
    if payload is not None and payload.input is not None and payload.input.strip():
        prompt_override = payload.input

    try:
        client = get_model_gateway_client()
        transcript, carry = execute_chain(
            store,
            automation,
            actor,
            client,
            usage_budget_orchestrator,
            prompt_override=prompt_override,
        )
        record_run_success(store, automation, actor)
    except HTTPException as exc:
        _record_run_failure_without_masking(store, automation, actor, str(exc.detail))
        raise
    except ModelGatewayError as exc:
        _record_run_failure_without_masking(store, automation, actor, str(exc))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Automation run failed at the model gateway: {exc}",
        ) from exc
    except Exception as exc:
        _record_run_failure_without_masking(
            store,
            automation,
            actor,
            f"unexpected {type(exc).__name__}",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Automation run failed unexpectedly.",
        ) from exc

    return {"automation": automation, "transcript": transcript, "final_output": carry}
