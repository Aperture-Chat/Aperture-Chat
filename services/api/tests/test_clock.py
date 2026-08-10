"""Authoritative platform clock endpoint."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_server_time_returns_consistent_utc_fields() -> None:
    response = client.get("/api/time")
    assert response.status_code == 200
    body = response.json()
    assert body["timezone"] == "UTC"

    parsed = datetime.fromisoformat(body["iso"])
    assert parsed.tzinfo is not None  # timezone-aware
    # iso and unix describe the same instant (allow a second of skew).
    assert abs(int(parsed.timestamp()) - body["unix"]) <= 1
    # And that instant is genuinely "now" (within a generous window).
    assert abs(datetime.now(UTC).timestamp() - body["unix"]) < 30
