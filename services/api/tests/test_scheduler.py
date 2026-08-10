"""Scheduler: due-trigger detection, scheduled execution, and Elastic flush."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import scheduler
from app.core.config import Settings
from app.core.elastic_export import flush_elastic_events
from app.core.model_gateway import ModelGatewayClient
from app.main import app
from app.models.schemas import Automation, AutomationStep
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-owner") -> dict[str, str]:
    return {"x-aperture-user": user_id}


# --- is_due -----------------------------------------------------------------

MONDAY_10 = datetime(2026, 7, 6, 10, 0, tzinfo=UTC)  # 2026-07-06 is a Monday


def _automation(**overrides: object) -> Automation:
    base: dict[str, object] = {
        "id": "automation-test",
        "tenant_id": "tenant-example",
        "name": "Digest",
        "trigger_type": "once",
        "enabled": True,
        "created_by": "user-owner",
        "created_at": "2026-07-01T00:00:00+00:00",
        "updated_at": "2026-07-01T00:00:00+00:00",
        "steps": [AutomationStep(model_id="gpt-4o-mini")],
    }
    base.update(overrides)
    return Automation(**base)


def test_once_trigger_due_only_before_first_fire() -> None:
    due = _automation(run_at="2026-07-06T09:00:00+00:00")
    assert scheduler.is_due(due, MONDAY_10) is True
    assert (
        scheduler.is_due(due.model_copy(update={"run_at": "2026-07-06T11:00:00+00:00"}), MONDAY_10)
        is False
    )
    fired = due.model_copy(update={"last_scheduled_fire_at": "2026-07-06T09:00:30+00:00"})
    assert scheduler.is_due(fired, MONDAY_10) is False
    assert scheduler.is_due(due.model_copy(update={"enabled": False}), MONDAY_10) is False
    assert scheduler.is_due(due.model_copy(update={"steps": []}), MONDAY_10) is False


def test_weekly_trigger_fires_once_per_occurrence() -> None:
    weekly = _automation(trigger_type="weekly", weekly_day="monday", time_of_day="09:00")
    assert scheduler.is_due(weekly, MONDAY_10) is True
    fired = weekly.model_copy(update={"last_scheduled_fire_at": "2026-07-06T09:00:30+00:00"})
    assert scheduler.is_due(fired, MONDAY_10) is False
    # Edited after this week's occurrence: waits for the next one.
    edited = weekly.model_copy(update={"updated_at": "2026-07-06T09:30:00+00:00"})
    assert scheduler.is_due(edited, MONDAY_10) is False
    # Fired last week, occurrence pending this week.
    last_week = weekly.model_copy(update={"last_scheduled_fire_at": "2026-06-29T09:00:30+00:00"})
    assert scheduler.is_due(last_week, MONDAY_10) is True


def test_daily_trigger_fires_once_per_occurrence() -> None:
    daily = _automation(trigger_type="daily", time_of_day="09:00")
    assert scheduler.is_due(daily, MONDAY_10) is True
    fired = daily.model_copy(update={"last_scheduled_fire_at": "2026-07-06T09:00:30+00:00"})
    assert scheduler.is_due(fired, MONDAY_10) is False
    # Fired yesterday, today's occurrence pending.
    yesterday = daily.model_copy(update={"last_scheduled_fire_at": "2026-07-05T09:00:30+00:00"})
    assert scheduler.is_due(yesterday, MONDAY_10) is True
    # Today's occurrence is still ahead of `now`: waits for tomorrow only if
    # yesterday's occurrence already fired; otherwise it catches up once.
    later_today = daily.model_copy(update={"time_of_day": "11:00"})
    fired_yesterday = later_today.model_copy(
        update={"last_scheduled_fire_at": "2026-07-05T11:00:30+00:00"}
    )
    assert scheduler.is_due(fired_yesterday, MONDAY_10) is False
    # No usable time means the schedule honestly never fires.
    assert scheduler.is_due(daily.model_copy(update={"time_of_day": None}), MONDAY_10) is False


def test_cron_trigger_uses_expression() -> None:
    cron = _automation(trigger_type="cron", cron_expression="0 9 * * *")
    assert scheduler.is_due(cron, MONDAY_10) is True
    fired = cron.model_copy(update={"last_scheduled_fire_at": "2026-07-06T09:00:30+00:00"})
    assert scheduler.is_due(fired, MONDAY_10) is False
    assert (
        scheduler.is_due(cron.model_copy(update={"cron_expression": "not a cron"}), MONDAY_10)
        is False
    )


# --- scheduled execution ----------------------------------------------------


def _activate_openrouter() -> None:
    store = get_store()
    provider = store.providers["provider-openrouter"]
    provider.connected = True
    store.create_provider_key(
        key_id="key-openrouter-scheduler-test",
        provider=provider,
        name="OpenRouter Scheduler Test",
        environment="Test",
        status="Active",
        expires="Not set",
        secret_value="openrouter-test-key",
    )


def _approved_model_id() -> str:
    store = get_store()
    return next(
        m.id
        for m in store.models.values()
        if m.platform_enabled and m.provider_id == "provider-openrouter"
    )


def _create_due_automation(model_id: str) -> str:
    payload = {
        "tenant_id": "tenant-example",
        "name": "Nightly summary",
        "surface": "chat",
        "trigger_type": "once",
        "run_at": "2026-01-01T00:00:00+00:00",
        "prompt": "Summarize yesterday.",
        "steps": [{"model_id": model_id, "instruction": "Be brief."}],
        "enabled": True,
    }
    created = client.post("/api/automations", json=payload, headers=headers())
    assert created.status_code == 201
    return created.json()["id"]


def _gateway(reply_status: int = 200) -> ModelGatewayClient:
    def handler(request: httpx.Request) -> httpx.Response:
        if reply_status != 200:
            return httpx.Response(reply_status, json={"error": "upstream boom"})
        return httpx.Response(
            200,
            json={
                "id": "gen-sched",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "scheduled-output"},
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    return ModelGatewayClient(transport=httpx.MockTransport(handler))


def test_scheduler_pass_runs_due_automation_and_delivers_thread(monkeypatch) -> None:
    _activate_openrouter()
    automation_id = _create_due_automation(_approved_model_id())
    monkeypatch.setattr("app.core.scheduler.get_model_gateway_client", lambda: _gateway())

    store = get_store()
    scheduler.scheduler_pass(store, Settings())

    automation = store.automations[automation_id]
    assert automation.last_run_status == "succeeded"
    assert automation.last_scheduled_fire_at is not None
    assert automation.enabled is False  # one-time schedule disarms after firing

    threads = [
        t
        for t in store.chat_threads.values()
        if t.owner_user_id == "user-owner" and t.title.startswith("Nightly summary")
    ]
    assert len(threads) == 1
    assert threads[0].messages[-1].role == "assistant"
    assert threads[0].messages[-1].content == "scheduled-output"

    # A second pass must not re-fire the same occurrence.
    scheduler.scheduler_pass(store, Settings())
    again = [
        t
        for t in store.chat_threads.values()
        if t.owner_user_id == "user-owner" and t.title.startswith("Nightly summary")
    ]
    assert len(again) == 1


def test_scheduler_records_honest_failure(monkeypatch) -> None:
    _activate_openrouter()
    automation_id = _create_due_automation(_approved_model_id())
    monkeypatch.setattr("app.core.scheduler.get_model_gateway_client", lambda: _gateway(500))

    store = get_store()
    scheduler.scheduler_pass(store, Settings())

    automation = store.automations[automation_id]
    assert automation.last_run_status is not None
    assert automation.last_run_status.startswith("failed")
    assert not any(t.title.startswith("Nightly summary") for t in store.chat_threads.values())


def test_scheduler_delivery_failure_records_failed_and_preserves_provider_usage(
    monkeypatch,
) -> None:
    _activate_openrouter()
    model_id = _approved_model_id()
    automation_id = _create_due_automation(model_id)
    monkeypatch.setattr("app.core.scheduler.get_model_gateway_client", lambda: _gateway())

    store = get_store()

    def fail_delivery(_thread) -> None:
        raise RuntimeError("scheduled delivery persistence failed")

    monkeypatch.setattr(store, "save_chat_thread", fail_delivery)

    scheduler.scheduler_pass(store, Settings())

    automation = store.automations[automation_id]
    assert automation.last_run_status is not None
    assert automation.last_run_status.startswith("failed")
    assert "unexpected RuntimeError" in automation.last_run_status
    run_audits = [event for event in store.audit_events if event.target == automation_id]
    assert [event.action for event in run_audits if event.action.startswith("automation.run")] == [
        "automation.run_failed"
    ]
    assert run_audits[-1].metadata["error"] == "unexpected RuntimeError"
    usage = [record for record in store.usage_records if record.surface == "automation"]
    assert len(usage) == 1
    assert usage[0].model_id == model_id
    assert usage[0].total_tokens is None
    assert not any(t.title.startswith("Nightly summary") for t in store.chat_threads.values())


def test_scheduler_skips_inactive_creator(monkeypatch) -> None:
    _activate_openrouter()
    automation_id = _create_due_automation(_approved_model_id())
    monkeypatch.setattr("app.core.scheduler.get_model_gateway_client", lambda: _gateway())

    store = get_store()
    store.users["user-owner"].active = False
    scheduler.scheduler_pass(store, Settings())

    automation = store.automations[automation_id]
    assert automation.last_run_status == "skipped: creator is inactive or missing"
    assert not any(t.title.startswith("Nightly summary") for t in store.chat_threads.values())


def test_scheduler_pass_purges_one_bounded_expired_session_batch(monkeypatch) -> None:
    store = get_store()
    now = datetime(2026, 7, 20, 12, 34, 56, tzinfo=UTC)
    calls: list[tuple[int, int]] = []

    def purge(expires_through: int, *, limit: int = 500) -> int:
        calls.append((expires_through, limit))
        return limit

    monkeypatch.setattr(scheduler.clock, "now", lambda: now)
    monkeypatch.setattr(store.application_state_repository, "purge_expired_sessions", purge)

    scheduler.scheduler_pass(store, Settings())

    assert calls == [(int(now.timestamp()), scheduler.REVOKED_SESSION_PURGE_BATCH_LIMIT)]


# --- Elastic flush ----------------------------------------------------------


def _elastic_settings() -> Settings:
    return Settings(elastic_url="http://elastic.test:9200", elastic_api_key="test-key")


def test_elastic_flush_delivers_and_clears_buffer() -> None:
    store = get_store()
    store.elastic_events.extend([{"event": "one"}, {"event": "two"}])
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"errors": False, "items": []})

    delivered = flush_elastic_events(
        store, _elastic_settings(), transport=httpx.MockTransport(handler)
    )
    assert delivered == 2
    assert list(store.elastic_events) == []
    assert store.elastic_last_delivery_at is not None
    assert store.elastic_last_delivery_error is None
    assert seen[0].url.path == "/_bulk"
    assert seen[0].headers["authorization"] == "ApiKey test-key"


def test_elastic_flush_keeps_buffer_on_failure() -> None:
    store = get_store()
    store.elastic_events.append({"event": "one"})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "unavailable"})

    delivered = flush_elastic_events(
        store, _elastic_settings(), transport=httpx.MockTransport(handler)
    )
    assert delivered == 0
    assert len(store.elastic_events) == 1
    assert store.elastic_last_delivery_error is not None


def test_elastic_flush_noop_when_unconfigured() -> None:
    store = get_store()
    store.elastic_events.append({"event": "one"})

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not be called
        raise AssertionError("No HTTP call expected when Elastic is unconfigured.")

    delivered = flush_elastic_events(store, Settings(), transport=httpx.MockTransport(handler))
    assert delivered == 0
    assert len(store.elastic_events) == 1
