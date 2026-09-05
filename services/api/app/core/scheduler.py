"""In-process background scheduler for automations and Elastic delivery.

Runs as an asyncio task inside the API process: runtime state is a
single-process, file-backed store, so a separate worker container cannot
safely share it. Every pass fires due automation schedules through the same
execution path as the "Run now" route, delivers each scheduled run's output
into a chat thread owned by the automation's creator, and flushes buffered
audit events to Elastic when configured.

All schedule times are interpreted in UTC (the authoritative platform clock).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from croniter import croniter
from fastapi import HTTPException

from app.core import clock, mailer
from app.core.automation_runner import (
    execute_chain,
    persist_automation_fields,
    record_run_failure,
    record_run_success,
)
from app.core.config import Settings, get_settings
from app.core.elastic_export import flush_elastic_events
from app.core.model_gateway import ModelGatewayError, get_model_gateway_client
from app.core.platform_updates import reconcile_updater_outcome, refresh_platform_update_check
from app.models.schemas import Automation, ChatMessage, ChatThread, PlatformSettings, User
from app.repositories.application_state import ApplicationStateRepository
from app.repositories.deps import get_usage_budget_orchestrator
from app.repositories.seed import SeedStore

logger = logging.getLogger("aperture.scheduler")

ALERT_DELIVERY_BATCH_LIMIT = 50
REVOKED_SESSION_PURGE_BATCH_LIMIT = 500
MFA_STATE_PURGE_BATCH_LIMIT = 500
RETENTION_PURGE_BATCH_LIMIT = 500
MAX_DELIVERY_ATTEMPTS = 5
NOT_CONFIGURED_DETAIL = (
    "Email delivery is not configured. This alert stays logged in-app; a platform "
    "owner can configure SMTP in the Owner portal → Alerts tab."
)

WEEKDAY_INDEX = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def _parse_time_of_day(value: str) -> tuple[int, int] | None:
    parts = value.strip().split(":")
    if len(parts) != 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour, minute


def _weekly_occurrence(automation: Automation, now: datetime) -> datetime | None:
    """The most recent scheduled weekly occurrence at or before `now` (UTC)."""
    day = WEEKDAY_INDEX.get((automation.weekly_day or "").strip().lower())
    time_of_day = _parse_time_of_day(automation.time_of_day or "")
    if day is None or time_of_day is None:
        return None
    candidate = now.replace(hour=time_of_day[0], minute=time_of_day[1], second=0, microsecond=0)
    candidate -= timedelta(days=(now.weekday() - day) % 7)
    if candidate > now:
        candidate -= timedelta(days=7)
    return candidate


def _daily_occurrence(automation: Automation, now: datetime) -> datetime | None:
    """The most recent scheduled daily occurrence at or before `now` (UTC)."""
    time_of_day = _parse_time_of_day(automation.time_of_day or "")
    if time_of_day is None:
        return None
    candidate = now.replace(hour=time_of_day[0], minute=time_of_day[1], second=0, microsecond=0)
    if candidate > now:
        candidate -= timedelta(days=1)
    return candidate


def is_due(automation: Automation, now: datetime) -> bool:
    """Whether an enabled automation's trigger has a fire pending at `now`.

    Fires at most once per occurrence: `last_scheduled_fire_at` is the marker,
    so restarts and long passes never double-fire, and missed occurrences
    collapse into a single catch-up run rather than a storm.
    """
    if not automation.enabled or not automation.steps:
        return False
    last_fire = _parse_iso(automation.last_scheduled_fire_at)
    if automation.trigger_type == "once":
        run_at = _parse_iso(automation.run_at)
        return run_at is not None and run_at <= now and last_fire is None
    baseline = last_fire or _parse_iso(automation.updated_at) or _parse_iso(automation.created_at)
    if baseline is None:
        return False
    if automation.trigger_type == "daily":
        occurrence = _daily_occurrence(automation, now)
        return occurrence is not None and occurrence > baseline
    if automation.trigger_type == "weekly":
        occurrence = _weekly_occurrence(automation, now)
        return occurrence is not None and occurrence > baseline
    if automation.trigger_type == "cron":
        expression = (automation.cron_expression or "").strip()
        if not expression or not croniter.is_valid(expression):
            return False
        next_fire = croniter(expression, baseline).get_next(datetime)
        return next_fire <= now
    return False


def _delivery_thread(
    automation: Automation,
    creator: User,
    transcript: list[dict[str, object]],
    final_output: str,
    now: datetime,
) -> ChatThread:
    """A chat thread carrying the scheduled run's real output to its creator."""
    stamp = now.strftime("%b %d, %Y %H:%M UTC")
    iso = now.isoformat()
    metadata = {
        "automation_id": automation.id,
        "automation_name": automation.name,
        "scheduled": True,
    }
    return ChatThread(
        id=f"thread-automation-{uuid4()}",
        tenant_id=automation.tenant_id,
        owner_user_id=creator.id,
        title=f"{automation.name} — {stamp}",
        model_id=automation.steps[-1].model_id if automation.steps else "",
        group_id="",
        updated_at=iso,
        messages=[
            ChatMessage(
                id=f"msg-{uuid4()}",
                role="user",
                content=automation.prompt or "Begin the automation.",
                createdAt=stamp,
                createdAtIso=iso,
                metadata=metadata,
            ),
            ChatMessage(
                id=f"msg-{uuid4()}",
                role="assistant",
                content=final_output,
                createdAt=stamp,
                createdAtIso=iso,
                metadata={**metadata, "steps": len(transcript)},
            ),
        ],
    )


def run_scheduled_automation(store: SeedStore, automation: Automation) -> None:
    """Fire one due automation with the creator as the acting identity."""
    # Stamp the fire before executing so a crash mid-run cannot double-fire.
    # persist_automation_fields survives snapshot write races and returns None
    # if a concurrent writer deleted the automation — nothing to fire then.
    fire_fields: dict[str, object] = {"last_scheduled_fire_at": clock.now_iso()}
    if automation.trigger_type == "once":
        # One-time schedules fire exactly once, then disarm honestly.
        fire_fields["enabled"] = False
    stamped = persist_automation_fields(store, automation.id, fire_fields)
    if stamped is None:
        return
    automation = stamped

    creator = store.users.get(automation.created_by or "")
    if creator is None or not creator.active:
        persist_automation_fields(
            store,
            automation.id,
            {
                "last_run_at": clock.now_iso(),
                "last_run_status": "skipped: creator is inactive or missing",
            },
        )
        if creator is not None:
            store.record_audit(
                creator,
                "automation.run_skipped",
                automation.id,
                {"reason": "creator_inactive", "scheduled": True},
            )
        logger.warning(
            "Skipped scheduled automation %s: creator %r is inactive or missing.",
            automation.id,
            automation.created_by,
        )
        return

    try:
        client = get_model_gateway_client()
        transcript, final_output = execute_chain(
            store,
            automation,
            creator,
            client,
            get_usage_budget_orchestrator(),
        )
        store.save_chat_thread(
            _delivery_thread(automation, creator, transcript, final_output, clock.now())
        )
        record_run_success(store, automation, creator, scheduled=True)
    except (HTTPException, ModelGatewayError) as exc:
        detail = str(getattr(exc, "detail", None) or exc)
        _record_scheduled_run_failure_without_masking(store, automation, creator, detail)
        logger.warning("Scheduled automation %s failed: %s", automation.id, detail)
        return
    except Exception as exc:  # noqa: BLE001 - persist an honest terminal state
        detail = f"unexpected {type(exc).__name__}"
        _record_scheduled_run_failure_without_masking(store, automation, creator, detail)
        logger.exception("Scheduled automation %s failed unexpectedly", automation.id)
        return
    logger.info(
        "Scheduled automation %s ran successfully (%d steps).", automation.id, len(transcript)
    )


def _record_scheduled_run_failure_without_masking(
    store: SeedStore,
    automation: Automation,
    creator: User,
    error: str,
) -> None:
    """Best-effort failure bookkeeping that preserves the execution error."""

    try:
        record_run_failure(store, automation, creator, error, scheduled=True)
    except Exception:  # noqa: BLE001 - scheduler must survive persistence failure
        logger.exception(
            "Could not persist failure status for scheduled automation %s",
            automation.id,
        )


def deliver_alert_notifications(store: SeedStore) -> int:
    """Deliver queued alert emails with retry; returns how many were sent.

    Runs on the scheduler thread (blocking SMTP is fine here). Honest status
    transitions only: unconfigured SMTP marks notifications
    ``not_configured`` (terminal — no silent infinite queue), a send failure
    keeps ``queued`` with the real error text until MAX_DELIVERY_ATTEMPTS,
    then ``failed``.
    """

    repository = _application_state_repository(store)
    queued = repository.queued_alert_notifications(limit=ALERT_DELIVERY_BATCH_LIMIT)
    if not queued:
        return 0

    settings = store.email_settings
    if not mailer.email_configured(settings):
        for notification in queued:
            repository.update_alert_notification(
                notification.model_copy(
                    update={
                        "status": "not_configured",
                        "status_detail": NOT_CONFIGURED_DETAIL,
                    }
                )
            )
        return 0

    password = store.configuration_secret("smtp", "primary")
    sent = 0
    for notification in queued:
        notification = notification.model_copy(update={"attempts": notification.attempts + 1})
        try:
            mailer.send_email(
                host=settings.host,
                port=settings.port,
                security=settings.security,
                username=settings.username,
                password=password,
                from_address=settings.from_address,
                recipients=notification.recipients,
                subject=(
                    f"[{store.brand_name(notification.tenant_id)} alert] "
                    f"{notification.rule_name}: {notification.event_action}"
                ),
                body_text=(
                    f"Alert rule: {notification.rule_name}\n"
                    f"Event: {notification.event_action} (severity: {notification.event_severity})\n"
                    f"Actor: {notification.actor_name or notification.actor_id}\n"
                    f"Summary: {notification.summary}\n"
                    f"Matched events in window: {notification.matched_count}\n"
                    f"Recorded at: {notification.created_at.isoformat()}\n\n"
                    f"Review the delivery log and audit trail in the "
                    f"{store.brand_name(notification.tenant_id)} console "
                    "for full context."
                ),
            )
            repository.update_alert_notification(
                notification.model_copy(
                    update={
                        "status": "sent",
                        "status_detail": "",
                        "delivered_at": clock.now(),
                    }
                )
            )
            sent += 1
        except mailer.MailerError as exc:
            status = notification.status
            if notification.attempts >= MAX_DELIVERY_ATTEMPTS:
                status = "failed"
                logger.warning(
                    "Alert email %s failed permanently after %d attempts: %s",
                    notification.id,
                    notification.attempts,
                    exc,
                )
            repository.update_alert_notification(
                notification.model_copy(update={"status": status, "status_detail": str(exc)})
            )
    return sent


def _application_state_repository(store: SeedStore) -> ApplicationStateRepository:
    repository = getattr(store, "application_state_repository", None)
    if not isinstance(repository, ApplicationStateRepository):
        raise RuntimeError("Application SQL state repository is not initialized.")
    return repository


def purge_expired_revoked_sessions(
    store: SeedStore,
    now: datetime,
    *,
    limit: int = REVOKED_SESSION_PURGE_BATCH_LIMIT,
) -> int:
    """Remove at most one bounded batch of expired revocation markers."""
    return _application_state_repository(store).purge_expired_sessions(
        int(now.timestamp()),
        limit=limit,
    )


def purge_expired_mfa_state(
    store: SeedStore,
    now: datetime,
    *,
    limit: int = MFA_STATE_PURGE_BATCH_LIMIT,
) -> int:
    """Remove at most one bounded mixed batch of expired MFA flows."""

    return _application_state_repository(store).purge_expired_mfa_state(
        now,
        limit=limit,
    )


def _active_retention_settings(store: SeedStore) -> PlatformSettings:
    """Read retention policy from SQL on every pass, never from stale cache."""

    repository = getattr(store, "identity_config_repository", None)
    if repository is None:
        raise RuntimeError("Identity/config SQL repository is not initialized.")
    snapshot = repository.load_active_snapshot()
    if snapshot is None:
        raise RuntimeError("Identity/config SQL authority is not active.")
    return snapshot.platform_settings


def _retention_cutoff(now: datetime, retention_days: int) -> datetime | None:
    if type(retention_days) is not int or retention_days < 0:
        raise ValueError("retention days must be a nonnegative integer")
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("retention time must be timezone-aware")
    if retention_days == 0:
        return None
    return now.astimezone(UTC) - timedelta(days=retention_days)


def purge_retained_audit_history(
    store: SeedStore,
    now: datetime,
    *,
    retention_days: int,
    limit: int = RETENTION_PURGE_BATCH_LIMIT,
) -> int:
    """Delete one bounded audit batch; zero days explicitly disables purge."""

    cutoff = _retention_cutoff(now, retention_days)
    if cutoff is None:
        return 0
    return _application_state_repository(store).purge_audit_before(cutoff, limit=limit)


def purge_retained_usage_history(
    store: SeedStore,
    now: datetime,
    *,
    retention_days: int,
    limit: int = RETENTION_PURGE_BATCH_LIMIT,
) -> int:
    """Delete one bounded usage batch; zero days explicitly disables purge."""

    cutoff = _retention_cutoff(now, retention_days)
    if cutoff is None:
        return 0
    return _application_state_repository(store).purge_usage_before(cutoff, limit=limit)


def scheduler_pass(store: SeedStore, settings: Settings) -> None:
    """One synchronous pass: fire due automations, flush Elastic, send alerts."""
    now = clock.now()
    for automation in list(store.automations.values()):
        try:
            if is_due(automation, now):
                run_scheduled_automation(store, automation)
        except Exception:  # noqa: BLE001 - one bad automation must not stall the rest
            logger.exception("Scheduler failed while processing automation %s", automation.id)
    try:
        flush_elastic_events(store, settings)
    except Exception:  # noqa: BLE001
        logger.exception("Elastic flush failed")
    try:
        deliver_alert_notifications(store)
    except Exception:  # noqa: BLE001
        logger.exception("Alert email delivery failed")
    try:
        purge_expired_revoked_sessions(store, now)
    except Exception:  # noqa: BLE001
        logger.exception("Expired session revocation purge failed")
    try:
        purge_expired_mfa_state(store, now)
    except Exception:  # noqa: BLE001
        logger.exception("Expired MFA state purge failed")
    try:
        retention = _active_retention_settings(store)
    except Exception:  # noqa: BLE001
        logger.exception("Retention policy refresh failed")
    else:
        try:
            purge_retained_audit_history(
                store,
                now,
                retention_days=retention.audit_retention_days,
            )
        except Exception:  # noqa: BLE001
            logger.exception("Audit retention purge failed")
        try:
            purge_retained_usage_history(
                store,
                now,
                retention_days=retention.usage_retention_days,
            )
        except Exception:  # noqa: BLE001
            logger.exception("Usage retention purge failed")
    # Release checks are cached for hours; this call is a no-op until stale.
    try:
        refresh_platform_update_check(settings)
    except Exception:  # noqa: BLE001
        logger.exception("Platform update check failed")
    try:
        reconcile_updater_outcome(store, settings)
    except Exception:  # noqa: BLE001
        logger.exception("Updater outcome reconciliation failed")


async def scheduler_loop() -> None:
    # Late import so the pass always sees the current store singleton (tests
    # clear the lru_cache between cases).
    from app.repositories.deps import get_store

    settings = get_settings()
    interval = max(5.0, settings.scheduler_interval_seconds)
    logger.info("Automation scheduler online (every %.0fs; schedule times are UTC).", interval)
    while True:
        try:
            await asyncio.to_thread(scheduler_pass, get_store(), settings)
        except Exception:  # noqa: BLE001 - the loop must survive any pass
            logger.exception("Scheduler pass crashed; continuing")
        await asyncio.sleep(interval)
