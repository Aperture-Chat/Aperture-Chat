from fastapi import APIRouter, Depends, HTTPException, status

from app.core import clock
from app.core.policy import assert_group_permission
from app.models.schemas import AgentRun, Role, User
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/agents", tags=["agents"])

AGENT_OPERATOR_ROLES = {Role.PLATFORM_OWNER, Role.TENANT_ADMIN, Role.AGENT_APPROVER, Role.POWER_USER}
TERMINAL_STATUSES = {"Notification approved", "Rejected", "Canceled"}


@router.get("/runs")
def runs(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[AgentRun]:
    assert_group_permission(actor, store.groups, "agents_access", "Agent access")
    if actor.role == Role.PLATFORM_OWNER:
        return list(store.agent_runs.values())
    return [run for run in store.agent_runs.values() if run.tenant_id == actor.tenant_id]


@router.post("/runs/{run_id}/approve")
def approve_run(
    run_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AgentRun:
    _require_agent_operator(actor)
    assert_group_permission(actor, store.groups, "agents_access", "Agent access")
    run = _get_visible_run(run_id, actor, store)
    _assert_not_terminal(run)
    for approval in run.approvals:
        approval.status = "Approved"
    run.status = "Notification approved"
    _set_step_status(run, "Review", "Completed", "Approved by reviewer")
    # Approval is recorded, but nothing delivers the notification. Marking that
    # step "Completed" read as delivered on the timeline even though the detail
    # said otherwise, so it stays blocked until a delivery path exists.
    _set_step_status(
        run,
        "Send Notification",
        "Blocked",
        "Approval recorded; email delivery is not configured in this environment",
    )
    run.logs.append({"time": _log_time(), "step": "Send Notification", "event": "Approval recorded; delivery not configured"})
    store.record_audit(actor, "agent.approval_granted", run_id, {"notification_token": "redacted", "delivery": "not-configured"})
    return run


@router.post("/runs/{run_id}/reject")
def reject_run(
    run_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AgentRun:
    _require_agent_operator(actor)
    assert_group_permission(actor, store.groups, "agents_access", "Agent access")
    run = _get_visible_run(run_id, actor, store)
    _assert_not_terminal(run)
    for approval in run.approvals:
        approval.status = "Rejected"
    run.status = "Rejected"
    _set_step_status(run, "Review", "Rejected", "Rejected by reviewer")
    _set_step_status(run, "Send Notification", "Canceled", "Email send blocked by reviewer")
    run.logs.append({"time": _log_time(), "step": "Review", "event": "Rejected by approver"})
    store.record_audit(actor, "agent.approval_rejected", run_id, {"notification_token": "redacted"})
    return run


@router.post("/runs/{run_id}/pause")
def pause_run(
    run_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AgentRun:
    _require_agent_operator(actor)
    assert_group_permission(actor, store.groups, "agents_access", "Agent access")
    run = _get_visible_run(run_id, actor, store)
    _assert_not_terminal(run)
    if run.status != "Paused":
        run.status = "Paused"
        run.logs.append({"time": _log_time(), "step": "Review", "event": "Paused by operator"})
        store.record_audit(actor, "agent.run_paused", run_id)
    return run


@router.post("/runs/{run_id}/resume")
def resume_run(
    run_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AgentRun:
    _require_agent_operator(actor)
    assert_group_permission(actor, store.groups, "agents_access", "Agent access")
    run = _get_visible_run(run_id, actor, store)
    _assert_not_terminal(run)
    if run.status != "Paused":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only paused runs can be resumed.")
    run.status = "Waiting for approval" if any(approval.status == "Pending" for approval in run.approvals) else "In progress"
    run.logs.append({"time": _log_time(), "step": "Review", "event": "Resumed by operator"})
    store.record_audit(actor, "agent.run_resumed", run_id)
    return run


# Scheduling and export were status-only: /schedule set the run to "Scheduled"
# without anything in the scheduler ever picking it up, and /export logged
# "Export package prepared" while producing no artifact and returning no
# download. Both are removed rather than left as controls that report work they
# never performed. Real exports live at /api/review/{id}/export.xlsx.


def _log_time() -> str:
    return clock.now().strftime("%I:%M:%S %p").lstrip("0")


def _require_agent_operator(actor: User) -> None:
    if actor.role not in AGENT_OPERATOR_ROLES:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Agent operator role is required.")


def _get_visible_run(run_id: str, actor: User, store: SeedStore) -> AgentRun:
    run = store.agent_runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent run.")
    if actor.role != Role.PLATFORM_OWNER and run.tenant_id != actor.tenant_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent run.")
    return run


def _assert_not_terminal(run: AgentRun) -> None:
    if run.status in TERMINAL_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This agent run is already complete.")


def _set_step_status(run: AgentRun, label: str, status_value: str, detail: str) -> None:
    for step in run.steps:
        if step.label == label:
            step.status = status_value
            step.detail = detail
            return
