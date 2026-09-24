"""Automation schedules in time zones, schedule validation, agent steps,
delivery to chat or drafts, run history, and scheduled auto-pause."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import scheduler
from app.core.automation_schedule import Schedule, next_occurrence, upcoming_runs
from app.core.config import Settings
from app.core.markdown_document import markdown_to_document_html
from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.models.schemas import (
    Automation,
    AutomationStep,
    KnowledgeChunk,
    ModelConfig,
    SkillFile,
)
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-owner") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _activate_openrouter() -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    store.create_provider_key(
        key_id="key-openrouter-upgrades-test",
        provider=provider,
        name="OpenRouter Upgrades Test",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="openrouter-test-key",
    )


def _model_id() -> str:
    store = get_store()
    return next(
        m.id
        for m in store.models.values()
        if m.platform_enabled and m.provider_id == "provider-openrouter" and not m.is_custom
    )


def _payload(**overrides: object) -> dict:
    payload: dict[str, object] = {
        "tenant_id": "tenant-example",
        "name": "Morning brief",
        "surface": "chat",
        "trigger_type": "daily",
        "time_of_day": "09:00",
        "prompt": "Summarize overnight news.",
        "steps": [{"model_id": _model_id(), "instruction": ""}],
        "enabled": True,
    }
    payload.update(overrides)
    return payload


def _gateway(capture: list[dict] | None = None, reply: str = "run-output") -> ModelGatewayClient:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.read())
        if capture is not None:
            capture.append(body)
        return httpx.Response(
            200,
            json={
                "id": "gen-upgrades",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": reply},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
            },
        )

    return ModelGatewayClient(transport=httpx.MockTransport(handler))


# --- Schedule math ---------------------------------------------------------


def test_daily_schedule_follows_the_automation_time_zone() -> None:
    chicago = Schedule(trigger_type="daily", time_of_day="09:00", timezone="America/Chicago")
    # July: Chicago is UTC-5, so 09:00 local is 14:00 UTC.
    upcoming = next_occurrence(chicago, datetime(2026, 7, 6, 13, 0, tzinfo=UTC))
    assert upcoming is not None
    assert upcoming.astimezone(UTC) == datetime(2026, 7, 6, 14, 0, tzinfo=UTC)
    # January: UTC-6, so the same wall time is 15:00 UTC.
    winter = next_occurrence(chicago, datetime(2026, 1, 5, 13, 0, tzinfo=UTC))
    assert winter is not None
    assert winter.astimezone(UTC) == datetime(2026, 1, 5, 15, 0, tzinfo=UTC)


def test_scheduler_fires_zoned_daily_run_at_local_time() -> None:
    automation = Automation(
        id="automation-zoned",
        tenant_id="tenant-example",
        name="Zoned",
        trigger_type="daily",
        time_of_day="09:00",
        timezone="America/Chicago",
        enabled=True,
        created_at="2026-07-01T00:00:00+00:00",
        updated_at="2026-07-01T00:00:00+00:00",
        last_scheduled_fire_at="2026-07-05T14:00:10+00:00",
        steps=[AutomationStep(model_id="m")],
    )
    assert scheduler.is_due(automation, datetime(2026, 7, 6, 13, 30, tzinfo=UTC)) is False
    assert scheduler.is_due(automation, datetime(2026, 7, 6, 14, 1, tzinfo=UTC)) is True


def test_legacy_automation_without_time_zone_stays_utc() -> None:
    utc = Schedule(trigger_type="weekly", weekly_day="monday", time_of_day="09:00")
    runs = upcoming_runs(utc, datetime(2026, 7, 6, 10, 0, tzinfo=UTC), count=2)
    assert [run.astimezone(UTC) for run in runs] == [
        datetime(2026, 7, 13, 9, 0, tzinfo=UTC),
        datetime(2026, 7, 20, 9, 0, tzinfo=UTC),
    ]


def test_naive_one_time_run_is_read_in_the_automation_time_zone() -> None:
    once = Schedule(trigger_type="once", run_at="2026-07-06T09:00", timezone="America/New_York")
    upcoming = next_occurrence(once, datetime(2026, 7, 6, 0, 0, tzinfo=UTC))
    assert upcoming is not None
    assert upcoming.astimezone(UTC) == datetime(2026, 7, 6, 13, 0, tzinfo=UTC)


# --- Validation and preview --------------------------------------------------


def test_invalid_cron_is_rejected_on_save() -> None:
    response = client.post(
        "/api/automations",
        json=_payload(trigger_type="cron", cron_expression="every monday"),
        headers=headers(),
    )
    assert response.status_code == 400
    assert "not a valid five-field cron expression" in response.json()["detail"]


def test_unknown_time_zone_is_rejected() -> None:
    response = client.post(
        "/api/automations", json=_payload(timezone="Mars/Olympus_Mons"), headers=headers()
    )
    assert response.status_code == 400
    assert "Unknown time zone" in response.json()["detail"]


def test_enabling_an_unusable_schedule_is_refused_but_pausing_is_allowed() -> None:
    store = get_store()
    store.automations["automation-legacy"] = Automation(
        id="automation-legacy",
        tenant_id="tenant-example",
        name="Legacy",
        trigger_type="cron",
        cron_expression="not a cron",
        enabled=True,
        created_by="user-owner",
        steps=[AutomationStep(model_id=_model_id())],
    )
    paused = client.patch(
        "/api/automations/automation-legacy", json={"enabled": False}, headers=headers()
    )
    assert paused.status_code == 200
    enabled = client.patch(
        "/api/automations/automation-legacy", json={"enabled": True}, headers=headers()
    )
    assert enabled.status_code == 400


def test_schedule_preview_lists_next_runs_and_reports_problems() -> None:
    ok = client.post(
        "/api/automations/schedule-preview",
        json={"trigger_type": "cron", "cron_expression": "0 9 * * 1-5", "timezone": "UTC"},
        headers=headers(),
    )
    assert ok.status_code == 200
    body = ok.json()
    assert body["valid"] is True
    assert len(body["next_runs"]) == 3
    bad = client.post(
        "/api/automations/schedule-preview",
        json={"trigger_type": "weekly", "time_of_day": "25:00", "weekly_day": "monday"},
        headers=headers(),
    )
    assert bad.json()["valid"] is False
    assert bad.json()["next_runs"] == []


def test_list_reports_next_run_for_enabled_automations_only() -> None:
    created = client.post(
        "/api/automations", json=_payload(timezone="Europe/London"), headers=headers()
    ).json()
    assert created["timezone"] == "Europe/London"
    assert created["next_run_at"] is not None
    paused = client.patch(
        f"/api/automations/{created['id']}", json={"enabled": False}, headers=headers()
    ).json()
    assert paused["next_run_at"] is None


# --- Agent steps --------------------------------------------------------------


def _agent_profile(**overrides: object) -> str:
    store = get_store()
    store.skill_files["skill-upgrades"] = SkillFile(
        id="skill-upgrades",
        tenant_id="tenant-example",
        name="House style",
        content="Always lead with a one-line summary.",
    )
    fields: dict[str, object] = {
        "id": "agent-upgrades",
        "tenant_id": "tenant-example",
        "provider_id": "provider-openrouter",
        "provider_name": "OpenRouter",
        "name": "Research Analyst",
        "upstream_model_id": "openai/gpt-4o-mini",
        "system_prompt": "You are a careful research analyst.",
        "meta_prompt": "Cite every claim.",
        "skill_file_ids": ["skill-upgrades"],
        "knowledge_config_ids": ["knowledge-policy-library"],
        "platform_enabled": True,
        "is_custom": True,
        "created_by": "user-owner",
        "visibility": "tenant",
    }
    fields.update(overrides)
    store.models["agent-upgrades"] = ModelConfig(**fields)
    return "agent-upgrades"


def test_agent_step_brings_instructions_skills_and_knowledge(monkeypatch) -> None:
    _activate_openrouter()
    agent_id = _agent_profile()
    store = get_store()
    queries: list[str] = []

    def fake_retrieve(actor, config_ids, query, *, limit=4):
        queries.append(query)
        assert config_ids == ["knowledge-policy-library"]
        return [
            KnowledgeChunk(
                id="chunk-1",
                knowledge_config_id="knowledge-policy-library",
                document_id="doc-1",
                tenant_id="tenant-example",
                source_name="Travel Policy.pdf",
                source_uri="kb://travel",
                source_type="file",
                text="Economy class is required for flights under six hours.",
                updated_at="2026-07-01T00:00:00+00:00",
            )
        ]

    monkeypatch.setattr(store, "retrieve_knowledge", fake_retrieve)
    captured: list[dict] = []
    monkeypatch.setattr(
        "app.routes.automations.get_model_gateway_client", lambda: _gateway(captured)
    )
    created = client.post(
        "/api/automations",
        json=_payload(
            steps=[{"model_id": agent_id, "instruction": "Answer in three bullets."}],
            prompt="What is the flight class policy?",
        ),
        headers=headers(),
    ).json()
    run = client.post(f"/api/automations/{created['id']}/run", headers=headers())
    assert run.status_code == 200, run.text
    system = next(m["content"] for m in captured[0]["messages"] if m["role"] == "system")
    assert "You are a careful research analyst." in system
    assert "Cite every claim." in system
    assert "Always lead with a one-line summary." in system
    assert "Travel Policy.pdf" in system and "Economy class is required" in system
    # The step's own instruction is the most specific direction, so it is last.
    assert system.rstrip().endswith("Answer in three bullets.")
    assert queries == ["What is the flight class policy?"]
    step = run.json()["transcript"][0]
    assert step["agent"] is True
    assert step["knowledge_sources"] == ["Travel Policy.pdf"]


def test_agent_step_with_disabled_skill_fails_with_the_reason(monkeypatch) -> None:
    _activate_openrouter()
    agent_id = _agent_profile()
    get_store().skill_files["skill-upgrades"].enabled = False
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: _gateway())
    created = client.post(
        "/api/automations",
        json=_payload(steps=[{"model_id": agent_id, "instruction": ""}]),
        headers=headers(),
    ).json()
    run = client.post(f"/api/automations/{created['id']}/run", headers=headers())
    assert run.status_code == 403
    assert run.json()["detail"] == "Step 1 (Research Analyst): Skill file is disabled."


# --- Delivery and history -----------------------------------------------------


def test_run_now_with_delivery_creates_a_chat_thread_and_records_history(monkeypatch) -> None:
    _activate_openrouter()
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: _gateway())
    created = client.post("/api/automations", json=_payload(), headers=headers()).json()
    run = client.post(
        f"/api/automations/{created['id']}/run", json={"deliver": True}, headers=headers()
    )
    assert run.status_code == 200, run.text
    body = run.json()
    thread = get_store().chat_threads[body["thread_id"]]
    assert thread.messages[-1].content == "run-output"
    history = body["automation"]["run_history"]
    assert history[0]["status"] == "succeeded"
    assert history[0]["trigger"] == "manual"
    assert history[0]["thread_id"] == body["thread_id"]
    assert history[0]["duration_ms"] is not None


def test_chat_shortcut_run_does_not_create_a_second_thread(monkeypatch) -> None:
    _activate_openrouter()
    monkeypatch.setattr("app.routes.automations.get_model_gateway_client", lambda: _gateway())
    created = client.post("/api/automations", json=_payload(), headers=headers()).json()
    before = len(get_store().chat_threads)
    run = client.post(
        f"/api/automations/{created['id']}/run", json={"input": "Hello"}, headers=headers()
    )
    assert run.status_code == 200
    assert run.json()["thread_id"] is None
    assert len(get_store().chat_threads) == before
    assert run.json()["automation"]["run_history"][0]["trigger"] == "chat"


def test_draft_surface_delivers_a_formatted_draft(monkeypatch) -> None:
    _activate_openrouter()
    captured: list[dict] = []
    monkeypatch.setattr(
        "app.routes.automations.get_model_gateway_client",
        lambda: _gateway(captured, reply="# Weekly Report\n\n- First point\n- **Second** point"),
    )
    store = get_store()
    # Grant the tenant admin's group the OpenRouter model the test gateway serves.
    admin_model = _model_id()
    store.models[admin_model].group_ids = [*store.models[admin_model].group_ids, "group-litigation"]
    created = client.post(
        "/api/automations",
        json=_payload(surface="draft", steps=[{"model_id": admin_model, "instruction": ""}]),
        headers=headers("user-admin"),
    )
    assert created.status_code == 201, created.text
    run = client.post(
        f"/api/automations/{created.json()['id']}/run",
        json={"deliver": True},
        headers=headers("user-admin"),
    )
    assert run.status_code == 200, run.text
    draft_id = run.json()["draft_id"]
    assert draft_id and run.json()["thread_id"] is None
    system = next(m["content"] for m in captured[0]["messages"] if m["role"] == "system")
    assert "becomes a new draft document" in system

    from app.repositories.matters import MatterDraftRepository

    repository = MatterDraftRepository(store.application_state_repository.engine)
    snapshot = repository.get_draft(
        draft_id, tenant_id="tenant-example", owner_user_id="user-admin"
    )
    content = snapshot.revision.content
    assert "<h1>Weekly Report</h1>" in content
    assert "<li><strong>Second</strong> point</li>" in content


def test_scheduled_failures_pause_the_automation_after_three_in_a_row(monkeypatch) -> None:
    _activate_openrouter()

    def failing() -> ModelGatewayClient:
        return ModelGatewayClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(500, json={}))
        )

    monkeypatch.setattr("app.core.scheduler.get_model_gateway_client", failing)
    created = client.post(
        "/api/automations",
        json=_payload(trigger_type="cron", cron_expression="* * * * *"),
        headers=headers(),
    ).json()
    store = get_store()
    for _ in range(3):
        automation = store.automations[created["id"]]
        # Rewind the fire marker so every pass has an occurrence due.
        store.automations[created["id"]] = automation.model_copy(
            update={"last_scheduled_fire_at": "2026-01-01T00:00:00+00:00"}
        )
        scheduler.scheduler_pass(store, Settings())
    automation = store.automations[created["id"]]
    assert automation.enabled is False
    assert automation.consecutive_failures == 3
    assert "paused after 3 failed scheduled runs" in (automation.last_run_status or "")
    assert [entry.status for entry in automation.run_history] == ["failed"] * 3
    assert all(entry.trigger == "scheduled" for entry in automation.run_history)

    # Turning it back on starts a fresh streak.
    resumed = client.patch(
        f"/api/automations/{created['id']}", json={"enabled": True}, headers=headers()
    ).json()
    assert resumed["consecutive_failures"] == 0


# --- Markdown to draft HTML -------------------------------------------------


def test_markdown_document_conversion_covers_common_blocks() -> None:
    html = markdown_to_document_html(
        "# Title\n\nIntro with `code` and [a link](https://example.com/a?b=1&c=2).\n\n"
        "1. One\n2. Two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> Quoted\n\n```\nx < y\n```\n"
    )
    assert html.startswith("<h1>Title</h1>")
    assert '<a href="https://example.com/a?b=1&amp;c=2"' in html
    assert "<code>code</code>" in html
    assert "<ol><li>One</li><li>Two</li></ol>" in html
    assert "<th>A</th>" in html and "<td>2</td>" in html
    assert "<blockquote>Quoted</blockquote>" in html
    assert "x &lt; y" in html
    assert "<script>" not in markdown_to_document_html("<script>alert(1)</script>")


def test_bootstrap_carries_next_run_for_owners_and_admins() -> None:
    created = client.post(
        "/api/automations", json=_payload(timezone="America/Chicago"), headers=headers()
    ).json()
    for user in ("user-owner", "user-admin"):
        automations = client.get("/api/bootstrap", headers=headers(user)).json()["automations"]
        match = next(item for item in automations if item["id"] == created["id"])
        assert match["next_run_at"] is not None, user
