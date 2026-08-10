"""Authoritative platform clock.

A single source of "now" the whole platform reads, so scheduled work
(automations), audit stamps, and any run-time metadata agree on the time and
can be frozen in tests. Always timezone-aware UTC.
"""

from __future__ import annotations

from datetime import UTC, datetime


def now() -> datetime:
    """Current time as a timezone-aware UTC datetime."""
    return datetime.now(UTC)


def now_iso() -> str:
    """Current time as an ISO-8601 string (UTC)."""
    return now().isoformat()


def now_unix() -> int:
    """Current time as whole seconds since the Unix epoch."""
    return int(now().timestamp())
