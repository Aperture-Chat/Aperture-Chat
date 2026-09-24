"""Automations: scheduled/on-demand model-chain jobs delivered to chat or drafts.

Enabled schedules (once/daily/weekly/cron, in the automation's time zone) are
executed by the in-process scheduler (app/core/scheduler.py) through the exact
same chain runner this route uses, so "Run now" and a scheduled fire behave
identically: real gateway calls, real model-access checks, honest run
bookkeeping. Schedules are validated on save so one that can never fire is
rejected instead of silently sitting idle.
"""

from __future__ import annotations

import logging
import time
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status

from app.core import clock
from app.core.automation_runner import (
    deliver_run_output,
    execute_chain,
    record_run_failure,
    record_run_success,
    with_next_run,
)
from app.core.automation_schedule import Schedule, upcoming_runs, validate_schedule
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
    AutomationSchedulePreviewRequest,
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
SCHEDULE_FIELDS = {
    "trigger_type",
    "run_at",
    "weekly_day",
    "time_of_day",
    "cron_expression",
    "timezone",
}
logger = logging.getLogger("aperture.automations")


def _assert_valid_schedule(schedule: Schedule) -> None:
    problem = validate_schedule(schedule)
    if problem is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=problem)


def _record_run_failure_without_masking(
    store: SeedStore,
    automation: Automation,
    actor: User,
    error: str,
    *,
    trigger: str | None = None,
    duration_ms: int | None = None,
) -> None:
    """Best-effort failure bookkeeping that never replaces the run error."""

    try:
        record_run_failure(
            store, automation, actor, error, trigger=trigger, duration_ms=duration_ms
        )
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
    now = clock.now()
    return [with_next_run(automation, now) for automation in _visible(actor, store)]


@router.post("/schedule-preview")
def preview_schedule(
    payload: AutomationSchedulePreviewRequest,
    actor: User = Depends(current_user),
) -> dict[str, object]:
    """Validate a schedule and list its next runs, for the editor's live preview.

    Uses the scheduler's own math, so the preview is exactly what will fire.
    """
    del actor  # authenticated, but the preview touches no stored data
    schedule = Schedule(
        trigger_type=payload.trigger_type,
        run_at=payload.run_at,
        weekly_day=payload.weekly_day,
        time_of_day=payload.time_of_day,
        cron_expression=payload.cron_expression,
        timezone=payload.timezone,
    )
    problem = validate_schedule(schedule)
    if problem is not None:
        return {"valid": False, "error": problem, "next_runs": []}
    runs = upcoming_runs(schedule, clock.now(), count=3)
    return {"valid": True, "error": None, "next_runs": [run.isoformat() for run in runs]}


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
    _assert_valid_schedule(
        Schedule(
            trigger_type=payload.trigger_type,
            run_at=payload.run_at,
            weekly_day=payload.weekly_day,
            time_of_day=payload.time_of_day,
            cron_expression=payload.cron_expression,
            timezone=payload.timezone,
        )
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
        timezone=(payload.timezone or "").strip() or None,
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
    return with_next_run(automation)


@router.patch("/{automation_id}")
def update_automation(
    automation_id: str,
    payload: AutomationUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Automation:
    automation = _get_manageable(automation_id, actor, store)
    updates = payload.model_dump(exclude_unset=True)
    if "timezone" in updates:
        updates["timezone"] = (updates["timezone"] or "").strip() or None
    merged = automation.model_copy(update=updates)
    _validate_shape(
        surface=merged.surface,
        trigger_type=merged.trigger_type,
        steps=merged.steps,
        actor=actor,
        store=store,
        tenant_id=automation.tenant_id,
    )
    # A schedule is checked when it changes or is switched on, so a schedule
    # that can never fire is refused rather than left silently idle. Pausing
    # or renaming an older record with an unusable schedule stays possible.
    if SCHEDULE_FIELDS.intersection(updates) or updates.get("enabled") is True:
        _assert_valid_schedule(Schedule.of(merged))
    if updates.get("enabled") is True and not automation.enabled:
        # Turning an automation back on starts a fresh failure streak.
        merged.consecutive_failures = 0
    merged.updated_at = clock.now_iso()
    store.automations[automation.id] = merged
    store.record_audit(
        actor, "automation.updated", automation.id, {**updates, "updated_at": merged.updated_at}
    )
    store.save_runtime_state()
    return with_next_run(merged)


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
    deliver = bool(payload is not None and payload.deliver)
    # The chat ">" shortcut renders the run inside the open chat; a console run
    # delivers it like a scheduled one would.
    trigger = "manual" if deliver else "chat"
    thread_id: str | None = None
    draft_id: str | None = None
    started = time.monotonic()

    def elapsed_ms() -> int:
        return int((time.monotonic() - started) * 1000)

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
        if deliver:
            thread_id, draft_id = deliver_run_output(
                store,
                automation,
                actor,
                transcript,
                carry,
                prompt=prompt_override,
                scheduled=False,
            )
        persisted = record_run_success(
            store,
            automation,
            actor,
            trigger=trigger,
            duration_ms=elapsed_ms(),
            thread_id=thread_id,
            draft_id=draft_id,
        )
    except HTTPException as exc:
        _record_run_failure_without_masking(
            store, automation, actor, str(exc.detail), trigger=trigger, duration_ms=elapsed_ms()
        )
        raise
    except ModelGatewayError as exc:
        _record_run_failure_without_masking(
            store, automation, actor, str(exc), trigger=trigger, duration_ms=elapsed_ms()
        )
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
            trigger=trigger,
            duration_ms=elapsed_ms(),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Automation run failed unexpectedly.",
        ) from exc

    return {
        "automation": with_next_run(persisted or automation),
        "transcript": transcript,
        "final_output": carry,
        "thread_id": thread_id,
        "draft_id": draft_id,
    }
