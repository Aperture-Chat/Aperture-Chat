"""Timezone-aware schedule math for automations.

One implementation serves the scheduler (is this automation due?), the API
(when does it run next?), and the editor's live preview, so what the console
promises is exactly what the scheduler does.

An automation without a ``timezone`` keeps the historical behavior: every
schedule time is interpreted in UTC. With a timezone, "daily at 09:00" means
09:00 on the wall clock of that zone, including across daylight-saving
changes, and a naive ``run_at`` is read as local time in that zone.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter

WEEKDAY_INDEX = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}
VALID_TRIGGERS = {"once", "daily", "weekly", "cron"}
MAX_TIMEZONE_LENGTH = 64


@dataclass(frozen=True, slots=True)
class Schedule:
    """The schedule-shaped fields of an automation."""

    trigger_type: str
    run_at: str | None = None
    weekly_day: str | None = None
    time_of_day: str | None = None
    cron_expression: str | None = None
    timezone: str | None = None

    @classmethod
    def of(cls, automation: object) -> Schedule:
        return cls(
            trigger_type=str(getattr(automation, "trigger_type", "") or ""),
            run_at=getattr(automation, "run_at", None),
            weekly_day=getattr(automation, "weekly_day", None),
            time_of_day=getattr(automation, "time_of_day", None),
            cron_expression=getattr(automation, "cron_expression", None),
            timezone=getattr(automation, "timezone", None),
        )


def resolve_zone(name: str | None) -> tzinfo | None:
    """The zone for an IANA name; UTC when unset; None when unknown."""
    if not name or not name.strip():
        return UTC
    candidate = name.strip()
    if len(candidate) > MAX_TIMEZONE_LENGTH:
        return None
    if candidate.upper() == "UTC":
        return UTC
    try:
        return ZoneInfo(candidate)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def parse_time_of_day(value: str | None) -> tuple[int, int] | None:
    parts = (value or "").strip().split(":")
    if len(parts) != 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return hour, minute


def parse_instant(value: str | None, zone: tzinfo = UTC) -> datetime | None:
    """Parse an ISO timestamp; a naive value is wall-clock time in `zone`."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)
    return parsed


def validate_schedule(schedule: Schedule) -> str | None:
    """A human-readable reason the schedule can never fire, or None if valid."""
    if schedule.trigger_type not in VALID_TRIGGERS:
        return f"Trigger must be one of: {', '.join(sorted(VALID_TRIGGERS))}."
    zone = resolve_zone(schedule.timezone)
    if zone is None:
        return f"Unknown time zone '{schedule.timezone}'."
    if schedule.trigger_type == "once":
        if parse_instant(schedule.run_at, zone) is None:
            return "Choose a date and time for a one-time run."
        return None
    if schedule.trigger_type in {"daily", "weekly"}:
        if parse_time_of_day(schedule.time_of_day) is None:
            return "Choose a time of day (HH:MM, 24-hour)."
        if schedule.trigger_type == "weekly" and (
            (schedule.weekly_day or "").strip().lower() not in WEEKDAY_INDEX
        ):
            return "Choose a day of the week."
        return None
    expression = (schedule.cron_expression or "").strip()
    if not expression:
        return "Enter a cron expression, for example 0 9 * * 1-5."
    if len(expression.split()) != 5 or not croniter.is_valid(expression):
        return (
            f"'{expression}' is not a valid five-field cron expression "
            "(minute hour day-of-month month day-of-week)."
        )
    return None


def _local_at(day: datetime, hour: int, minute: int, zone: tzinfo) -> datetime:
    """Wall-clock `hour:minute` on `day`'s date in `zone`, as an aware datetime.

    A wall time skipped by a spring-forward gap resolves to the first valid
    instant after it (fold handling via UTC round trip), so it still fires once.
    """
    naive = datetime(day.year, day.month, day.day, hour, minute)
    local = naive.replace(tzinfo=zone)
    # Normalize through UTC so nonexistent wall times land on a real instant.
    return local.astimezone(UTC).astimezone(zone)


def latest_occurrence(schedule: Schedule, now: datetime) -> datetime | None:
    """The most recent scheduled occurrence at or before `now` (daily/weekly)."""
    zone = resolve_zone(schedule.timezone)
    time_of_day = parse_time_of_day(schedule.time_of_day)
    if zone is None or time_of_day is None:
        return None
    local_now = now.astimezone(zone)
    if schedule.trigger_type == "daily":
        for back in range(0, 3):
            candidate = _local_at(local_now - timedelta(days=back), *time_of_day, zone)
            if candidate <= now:
                return candidate
        return None
    if schedule.trigger_type == "weekly":
        day = WEEKDAY_INDEX.get((schedule.weekly_day or "").strip().lower())
        if day is None:
            return None
        offset = (local_now.weekday() - day) % 7
        for back in (offset, offset + 7):
            candidate = _local_at(local_now - timedelta(days=back), *time_of_day, zone)
            if candidate <= now:
                return candidate
        return None
    return None


def next_occurrence(schedule: Schedule, after: datetime) -> datetime | None:
    """The first scheduled occurrence strictly after `after`."""
    zone = resolve_zone(schedule.timezone)
    if zone is None or validate_schedule(schedule) is not None:
        return None
    if schedule.trigger_type == "once":
        run_at = parse_instant(schedule.run_at, zone)
        return run_at if run_at is not None and run_at > after else None
    if schedule.trigger_type == "cron":
        expression = (schedule.cron_expression or "").strip()
        return croniter(expression, after.astimezone(zone)).get_next(datetime)
    time_of_day = parse_time_of_day(schedule.time_of_day)
    assert time_of_day is not None
    local_after = after.astimezone(zone)
    step_days = 1 if schedule.trigger_type == "daily" else 7
    if schedule.trigger_type == "daily":
        start = local_after
    else:
        day = WEEKDAY_INDEX[(schedule.weekly_day or "").strip().lower()]
        start = local_after + timedelta(days=(day - local_after.weekday()) % 7)
    for ahead in range(0, 3):
        candidate = _local_at(start + timedelta(days=ahead * step_days), *time_of_day, zone)
        if candidate > after:
            return candidate
    return None


def upcoming_runs(schedule: Schedule, now: datetime, count: int = 3) -> list[datetime]:
    """The next `count` occurrences after `now`, for previews."""
    runs: list[datetime] = []
    cursor = now
    for _ in range(max(0, count)):
        upcoming = next_occurrence(schedule, cursor)
        if upcoming is None:
            break
        runs.append(upcoming)
        cursor = upcoming
    return runs


def is_due(
    schedule: Schedule,
    now: datetime,
    *,
    last_fire: datetime | None,
    baseline: datetime | None,
) -> bool:
    """Whether a fire is pending at `now`.

    Fires at most once per occurrence: `last_fire` is the marker, so restarts
    and long passes never double-fire, and missed occurrences collapse into a
    single catch-up run rather than a storm. `baseline` (last fire, else last
    edit, else creation) keeps an edited schedule from firing for an
    occurrence that passed before the edit.
    """
    zone = resolve_zone(schedule.timezone)
    if zone is None:
        return False
    if schedule.trigger_type == "once":
        run_at = parse_instant(schedule.run_at, zone)
        return run_at is not None and run_at <= now and last_fire is None
    if baseline is None:
        return False
    if schedule.trigger_type in {"daily", "weekly"}:
        occurrence = latest_occurrence(schedule, now)
        return occurrence is not None and occurrence > baseline
    if schedule.trigger_type == "cron":
        expression = (schedule.cron_expression or "").strip()
        if not expression or not croniter.is_valid(expression):
            return False
        next_fire = croniter(expression, baseline.astimezone(zone)).get_next(datetime)
        return next_fire <= now
    return False
