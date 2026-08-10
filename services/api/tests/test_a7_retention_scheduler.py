"""Scheduler integration for owner-configured SQL retention policy."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.core import scheduler
from app.core.config import Settings
from app.models.schemas import PlatformSettings
from app.repositories.application_state import ApplicationStateRepository


NOW = datetime(2026, 7, 20, 18, 0, tzinfo=UTC)


class _IdentityRepository:
    def __init__(self, settings: PlatformSettings) -> None:
        self.settings = settings
        self.read_count = 0

    def load_active_snapshot(self) -> SimpleNamespace:
        self.read_count += 1
        return SimpleNamespace(platform_settings=self.settings.model_copy(deep=True))


def _store(settings: PlatformSettings) -> tuple[SimpleNamespace, _IdentityRepository]:
    identity = _IdentityRepository(settings)
    application = object.__new__(ApplicationStateRepository)
    return (
        SimpleNamespace(
            automations={},
            application_state_repository=application,
            identity_config_repository=identity,
            # Deliberately contradictory: scheduler policy must come from the
            # fresh SQL snapshot, not this in-process cache.
            platform_settings=PlatformSettings(
                audit_retention_days=99,
                usage_retention_days=99,
            ),
        ),
        identity,
    )


def _silence_other_scheduler_work(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler.clock, "now", lambda: NOW)
    monkeypatch.setattr(scheduler, "flush_elastic_events", lambda *_args: None)
    monkeypatch.setattr(scheduler, "deliver_alert_notifications", lambda *_args: 0)
    monkeypatch.setattr(scheduler, "purge_expired_revoked_sessions", lambda *_args: 0)
    monkeypatch.setattr(scheduler, "purge_expired_mfa_state", lambda *_args: 0)


def test_retention_days_are_strict_nonnegative_owner_settings() -> None:
    assert PlatformSettings().audit_retention_days == 0
    assert PlatformSettings().usage_retention_days == 0
    with pytest.raises(ValidationError):
        PlatformSettings(audit_retention_days=-1)
    with pytest.raises(ValidationError):
        PlatformSettings(usage_retention_days=True)


def test_scheduler_refreshes_sql_policy_and_zero_disables_purge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, identity = _store(PlatformSettings())
    audit_calls: list[tuple[datetime, int]] = []
    usage_calls: list[tuple[datetime, int]] = []
    monkeypatch.setattr(
        store.application_state_repository,
        "purge_audit_before",
        lambda cutoff, limit: audit_calls.append((cutoff, limit)) or 0,
        raising=False,
    )
    monkeypatch.setattr(
        store.application_state_repository,
        "purge_usage_before",
        lambda cutoff, limit: usage_calls.append((cutoff, limit)) or 0,
        raising=False,
    )
    _silence_other_scheduler_work(monkeypatch)

    scheduler.scheduler_pass(store, Settings())
    assert identity.read_count == 1
    assert audit_calls == []
    assert usage_calls == []

    identity.settings = PlatformSettings(
        audit_retention_days=2,
        usage_retention_days=3,
    )
    scheduler.scheduler_pass(store, Settings())

    assert identity.read_count == 2
    assert audit_calls == [(NOW - timedelta(days=2), 500)]
    assert usage_calls == [(NOW - timedelta(days=3), 500)]


def test_audit_failure_does_not_block_usage_retention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, _identity = _store(
        PlatformSettings(audit_retention_days=1, usage_retention_days=1)
    )
    usage_calls: list[datetime] = []

    def reject_audit(_cutoff: datetime, _limit: int) -> int:
        raise RuntimeError("audit retention unavailable")

    monkeypatch.setattr(
        store.application_state_repository,
        "purge_audit_before",
        reject_audit,
        raising=False,
    )
    monkeypatch.setattr(
        store.application_state_repository,
        "purge_usage_before",
        lambda cutoff, limit: usage_calls.append(cutoff) or limit,
        raising=False,
    )
    _silence_other_scheduler_work(monkeypatch)

    scheduler.scheduler_pass(store, Settings())

    assert usage_calls == [NOW - timedelta(days=1)]


@pytest.mark.parametrize("retention_days", [-1, True, 1.5])
def test_retention_helper_rejects_invalid_policy_values(retention_days: object) -> None:
    store, _identity = _store(PlatformSettings())
    with pytest.raises(ValueError, match="nonnegative integer"):
        scheduler.purge_retained_audit_history(
            store,
            NOW,
            retention_days=retention_days,  # type: ignore[arg-type]
        )
