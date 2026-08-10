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
