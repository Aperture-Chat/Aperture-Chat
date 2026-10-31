"""Role-scoped usage analytics endpoints for the admin and owner consoles."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import Role
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def _seed_usage() -> None:
    store = get_store()
    store.usage_records.clear()
    owner = store.users["user-owner"]
    admin = store.users["user-admin"]
    jane = store.users["user-jane"]
    store.record_usage(
        actor=owner,
        model_id="gpt-4o",
        usage={"prompt_tokens": 100, "completion_tokens": 100, "total_tokens": 200},
    )
    store.record_usage(
        actor=admin,
        model_id="gpt-4o-mini",
        usage={"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
    )
    store.record_usage(actor=jane, model_id="gpt-4o-mini", usage=None)
    store.record_usage(
        actor=jane,
        model_id="claude-4-5-sonnet",
        surface="draft",
        usage={"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
    )


def test_admin_summary_excludes_platform_owner_usage() -> None:
    _seed_usage()
    response = client.get("/api/admin/usage-summary", headers=headers())
    assert response.status_code == 200
    summary = response.json()
    user_ids = {row["user_id"] for row in summary["by_user"]}
    assert "user-owner" not in user_ids
    assert {"user-admin", "user-jane"} <= user_ids
    # Owner tokens (200) must not leak into the tenant totals.
    assert summary["totals"]["total_tokens"] == 30
    assert summary["totals"]["messages"] == 3


def test_admin_cannot_query_an_owner_user_id() -> None:
    _seed_usage()
    response = client.get(
        "/api/admin/usage-summary", params={"user_id": "user-owner"}, headers=headers()
    )
    assert response.status_code == 404


def test_owner_summary_includes_owner_admin_and_user_rows() -> None:
    _seed_usage()
    response = client.get("/api/platform/usage-summary", headers=headers("user-owner"))
    assert response.status_code == 200
    summary = response.json()
    rows = {row["user_id"]: row for row in summary["by_user"]}
    assert {"user-owner", "user-admin", "user-jane"} <= set(rows)
    assert rows["user-owner"]["user_role"] == str(Role.PLATFORM_OWNER)
    assert summary["totals"]["total_tokens"] == 230
    # by_user is uncapped: every active usage row is returned.
    assert len(summary["by_user"]) >= 3


def test_regular_user_gets_403_on_both_surfaces() -> None:
    _seed_usage()
    assert client.get("/api/admin/usage-summary", headers=headers("user-jane")).status_code == 403
    assert (
        client.get("/api/platform/usage-summary", headers=headers("user-jane")).status_code == 403
    )
    assert (
        client.get("/api/platform/usage-summary", headers=headers("user-admin")).status_code == 403
    )


def test_user_filter_and_null_token_totals() -> None:
    _seed_usage()
    response = client.get(
        "/api/admin/usage-summary", params={"user_id": "user-jane"}, headers=headers()
    )
    assert response.status_code == 200
    summary = response.json()
    assert {row["user_id"] for row in summary["by_user"]} == {"user-jane"}
    assert summary["totals"]["messages"] == 2
    # One of Jane's records reported tokens, one did not.
    assert summary["totals"]["total_tokens"] == 10
    assert summary["totals"]["tokens_reported_messages"] == 1
    surfaces = {row["surface"] for row in summary["by_surface"]}
    assert surfaces == {"chat", "draft"}


def test_totals_are_null_when_nothing_reported() -> None:
    store = get_store()
    store.usage_records.clear()
    store.record_usage(actor=store.users["user-jane"], model_id="gpt-4o-mini", usage=None)
    response = client.get("/api/admin/usage-summary", headers=headers())
    assert response.status_code == 200
    totals = response.json()["totals"]
    assert totals["messages"] == 1
    assert totals["prompt_tokens"] is None
    assert totals["completion_tokens"] is None
    assert totals["total_tokens"] is None
    assert totals["tokens_reported_messages"] == 0


def test_date_range_filters_records() -> None:
    _seed_usage()
    store = get_store()
    # Move one record safely outside any plausible range.
    store.usage_records[1] = store.usage_records[1].model_copy(
        update={"created_at": datetime(2020, 1, 1, tzinfo=UTC)}
    )
    today = datetime.now(UTC).date().isoformat()
    response = client.get(
        "/api/admin/usage-summary",
        params={"from_date": today, "through_date": today},
        headers=headers(),
    )
    assert response.status_code == 200
    summary = response.json()
    assert summary["totals"]["messages"] == 2  # the 2020 admin record is excluded


def test_usage_records_listing_is_scoped_and_newest_first() -> None:
    _seed_usage()
    admin_records = client.get("/api/admin/usage-records", headers=headers()).json()
    assert [record["user_id"] for record in admin_records] == [
        "user-jane",
        "user-jane",
        "user-admin",
    ]
    owner_records = client.get(
        "/api/platform/usage-records", headers=headers("user-owner")
    ).json()
    assert len(owner_records) == 4
    assert owner_records[-1]["user_id"] == "user-owner"


# --- Personal usage: the Account drawer's "Usage this month" ------------------


def _record_at(user_id: str, when: datetime, *, tokens: int | None, thread_id: str | None = None) -> None:
    store = get_store()
    store.record_usage(
        actor=store.users[user_id],
        model_id="gpt-4o",
        usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": tokens} if tokens else None,
        thread_id=thread_id,
    )
    last = len(store.usage_records) - 1
    store.usage_records[last] = store.usage_records[last].model_copy(update={"created_at": when})


def _freeze_now(monkeypatch: pytest.MonkeyPatch, value: datetime) -> None:
    from app.core import clock

    monkeypatch.setattr(clock, "now", lambda: value)


def test_personal_summary_counts_only_this_utc_month(monkeypatch: pytest.MonkeyPatch) -> None:
    get_store().usage_records.clear()
    _freeze_now(monkeypatch, datetime(2026, 10, 30, 12, tzinfo=UTC))
    _record_at("user-jane", datetime(2026, 9, 30, 23, 59, 59, tzinfo=UTC), tokens=5000, thread_id="september")
    _record_at("user-jane", datetime(2026, 10, 1, 0, 0, tzinfo=UTC), tokens=60, thread_id="first")
    _record_at("user-jane", datetime(2026, 10, 30, 11, 0, tzinfo=UTC), tokens=40, thread_id="first")
    _record_at("user-jane", datetime(2026, 10, 30, 11, 30, tzinfo=UTC), tokens=None, thread_id="second")
    _record_at("user-jane", datetime(2026, 10, 30, 11, 45, tzinfo=UTC), tokens=None, thread_id=None)

    response = client.get("/api/auth/me/usage-summary", headers=headers("user-jane"))

    assert response.status_code == 200
    body = response.json()
    assert body["requests"] == 4
    assert body["chats"] == 2
    assert body["total_tokens"] == 100
    assert body["tokens_reported_requests"] == 2
    assert body["period_start"] == "2026-10-01"
    assert body["period_end"] == "2026-10-31"
    assert body["resets_at"].startswith("2026-11-01T00:00:00")


def test_personal_summary_resets_at_the_month_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    get_store().usage_records.clear()
    _record_at("user-jane", datetime(2026, 10, 31, 23, 59, 59, tzinfo=UTC), tokens=60, thread_id="october")

    _freeze_now(monkeypatch, datetime(2026, 10, 31, 23, 59, 59, tzinfo=UTC))
    last_second = client.get("/api/auth/me/usage-summary", headers=headers("user-jane")).json()
    assert (last_second["requests"], last_second["total_tokens"]) == (1, 60)

    _freeze_now(monkeypatch, datetime(2026, 11, 1, 0, 0, tzinfo=UTC))
    next_month = client.get("/api/auth/me/usage-summary", headers=headers("user-jane")).json()
    assert (next_month["requests"], next_month["chats"], next_month["total_tokens"]) == (0, 0, None)
    assert next_month["period_start"] == "2026-11-01"


def test_personal_summary_is_only_the_callers_own_usage() -> None:
    _seed_usage()

    body = client.get("/api/auth/me/usage-summary", headers=headers("user-admin")).json()

    assert body["requests"] == 1
    assert body["total_tokens"] == 20


def test_personal_summary_reports_null_not_zero_when_no_provider_reported_tokens() -> None:
    get_store().usage_records.clear()
    store = get_store()
    store.record_usage(actor=store.users["user-jane"], model_id="gpt-4o", usage=None)

    body = client.get("/api/auth/me/usage-summary", headers=headers("user-jane")).json()

    assert body["requests"] == 1
    assert body["total_tokens"] is None
    assert body["tokens_reported_requests"] == 0


def test_personal_summary_matches_the_admin_console_for_the_same_user() -> None:
    _seed_usage()

    mine = client.get("/api/auth/me/usage-summary", headers=headers("user-jane")).json()
    admin = client.get(
        "/api/admin/usage-summary", params={"user_id": "user-jane"}, headers=headers("user-admin")
    ).json()["totals"]

    assert mine["requests"] == admin["messages"]
    assert mine["total_tokens"] == admin["total_tokens"]
    assert mine["tokens_reported_requests"] == admin["tokens_reported_messages"]


def test_personal_summary_requires_a_signed_in_user() -> None:
    assert client.get("/api/auth/me/usage-summary").status_code == 401
