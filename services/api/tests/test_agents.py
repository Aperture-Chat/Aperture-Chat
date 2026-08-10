from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def test_agent_actions_mutate_run_and_audit() -> None:
    run_id = "run-hermes-client-update"

    pause = client.post(f"/api/agents/runs/{run_id}/pause", headers=headers("user-admin"))
    assert pause.status_code == 200
    assert pause.json()["status"] == "Paused"
    assert pause.json()["logs"][-1]["event"] == "Paused by operator"

    resume = client.post(f"/api/agents/runs/{run_id}/resume", headers=headers("user-admin"))
    assert resume.status_code == 200
    assert resume.json()["status"] == "Waiting for approval"
    assert resume.json()["logs"][-1]["event"] == "Resumed by operator"

    # Scheduling and export were removed: they reported work no subsystem ever
    # performed. Nothing should answer on those paths again.
    assert client.post(f"/api/agents/runs/{run_id}/export", headers=headers("user-admin")).status_code == 404
    assert client.post(f"/api/agents/runs/{run_id}/schedule", headers=headers("user-admin")).status_code == 404

    actions = [event.action for event in get_store().audit_events]
    assert actions[-2:] == ["agent.run_paused", "agent.run_resumed"]


def test_agent_approval_and_rejection_are_controlled_actions() -> None:
    approve = client.post("/api/agents/runs/run-hermes-client-update/approve", headers=headers("user-admin"))
    assert approve.status_code == 200
    approved = approve.json()
    assert approved["status"] == "Notification approved"
    assert approved["approvals"][0]["status"] == "Approved"
    # Approval is recorded, but nothing sends the notification, so the delivery
    # step must not read as done.
    assert approved["steps"][-1]["status"] == "Blocked"
    assert "not configured" in approved["steps"][-1]["detail"]

    second_approval = client.post("/api/agents/runs/run-hermes-client-update/approve", headers=headers("user-admin"))
    assert second_approval.status_code == 409

    get_store.cache_clear()
    reject = client.post("/api/agents/runs/run-hermes-client-update/reject", headers=headers("user-admin"))
    assert reject.status_code == 200
    rejected = reject.json()
    assert rejected["status"] == "Rejected"
    assert rejected["approvals"][0]["status"] == "Rejected"
    assert rejected["steps"][-1]["status"] == "Canceled"


def test_agent_actions_are_role_and_run_scoped() -> None:
    forbidden = client.post("/api/agents/runs/run-hermes-client-update/pause", headers=headers("user-jane"))
    assert forbidden.status_code == 403
    assert forbidden.json()["detail"] == "Agent operator role is required."

    unknown = client.post("/api/agents/runs/missing-run/approve", headers=headers("user-admin"))
    assert unknown.status_code == 404
    assert unknown.json()["detail"] == "Unknown agent run."

    owner_runs = client.get("/api/agents/runs", headers=headers("user-owner"))
    assert owner_runs.status_code == 200
    assert any(run["id"] == "run-hermes-client-update" for run in owner_runs.json())
