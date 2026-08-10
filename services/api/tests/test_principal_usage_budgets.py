from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.usage_budget import UsageBudgetExceeded, new_accounting_id
from app.db import create_application_engine, upgrade_database
from app.main import app
from app.models.schemas import UsageRecord
from app.repositories.usage_budgets import TenantUsageBudgetRepository


TENANT = "tenant-example"
ADMIN_AUTH = {"x-aperture-user": "user-admin"}
USER_AUTH = {"x-aperture-user": "user-member"}


def _sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _repository(tmp_path: Path) -> TenantUsageBudgetRepository:
    engine = create_application_engine(_sqlite_url(tmp_path / "principal-budgets.sqlite3"))
    upgrade_database(engine)
    repository = TenantUsageBudgetRepository(engine)
    repository.provision_budget(TENANT, daily_token_limit=0)
    return repository


def _usage_record(user_id: str = "user-a") -> UsageRecord:
    return UsageRecord(
        id="ignored",
        tenant_id=None,
        user_id=user_id,
        user_name="User A",
        user_role="USER",
        model_id="model-x",
        provider_name="Provider",
        surface="chat",
        message_count=1,
        thread_id="thread-1",
    )


def _settle_tokens(
    repository: TenantUsageBudgetRepository,
    *,
    tokens: int,
    principals: list[tuple[str, str]],
    request_id: str | None = None,
) -> None:
    del request_id  # accounting ids are always server-generated UUIDs
    permit = repository.acquire_permit(
        tenant_id=TENANT, request_id=new_accounting_id(), principals=principals
    ).permit
    repository.record_provider_completion(
        permit_id=permit.permit_id,
        completion_id=new_accounting_id(),
        usage={"prompt_tokens": 0, "completion_tokens": tokens, "total_tokens": tokens},
        usage_record=_usage_record(),
        principals=principals,
    )
    repository.complete_permit(permit.permit_id)


def test_principal_budget_crud_round_trip(tmp_path: Path) -> None:
    repository = _repository(tmp_path)
    saved = repository.set_principal_budget(
        tenant_id=TENANT,
        principal_type="user",
        principal_id="user-a",
        daily_token_limit=500,
        updated_by="user-admin",
    )
    assert saved.daily_token_limit == 500
    assert [b.principal_id for b in repository.list_principal_budgets(TENANT)] == ["user-a"]
    # Upsert overwrites.
    repository.set_principal_budget(
        tenant_id=TENANT, principal_type="user", principal_id="user-a", daily_token_limit=900
    )
    assert repository.list_principal_budgets(TENANT)[0].daily_token_limit == 900
    assert repository.delete_principal_budget(
        tenant_id=TENANT, principal_type="user", principal_id="user-a"
    )
    assert repository.list_principal_budgets(TENANT) == []


def test_user_allocation_denies_admission_when_spent(tmp_path: Path) -> None:
    repository = _repository(tmp_path)
    principals = [("user", "user-a"), ("group", "group-legal")]
    repository.set_principal_budget(
        tenant_id=TENANT, principal_type="user", principal_id="user-a", daily_token_limit=100
    )

    _settle_tokens(repository, tokens=100, principals=principals, request_id=new_accounting_id())

    with pytest.raises(UsageBudgetExceeded) as excinfo:
        repository.acquire_permit(
            tenant_id=TENANT, request_id=new_accounting_id(), principals=principals
        )
    assert excinfo.value.scope == "user"
    assert excinfo.value.daily_token_limit == 100
    assert excinfo.value.reported_tokens == 100

    # Another user without a cap is still admitted.
    other = repository.acquire_permit(
        tenant_id=TENANT, request_id=new_accounting_id(), principals=[("user", "user-b")]
    )
    assert other.acquired


def test_group_allocation_denies_all_group_members(tmp_path: Path) -> None:
    repository = _repository(tmp_path)
    repository.set_principal_budget(
        tenant_id=TENANT, principal_type="group", principal_id="group-legal", daily_token_limit=80
    )
    _settle_tokens(
        repository,
        tokens=80,
        principals=[("user", "user-a"), ("group", "group-legal")],
        request_id=new_accounting_id(),
    )

    with pytest.raises(UsageBudgetExceeded) as excinfo:
        repository.acquire_permit(
            tenant_id=TENANT,
            request_id=new_accounting_id(),
            principals=[("user", "user-b"), ("group", "group-legal")],
        )
    assert excinfo.value.scope == "group"


def test_weekly_user_allocation_resets_on_next_utc_monday(tmp_path: Path) -> None:
    repository = _repository(tmp_path)
    monday = datetime(2026, 7, 20, 10, tzinfo=UTC)
    principals = [("user", "user-a")]
    repository.set_principal_budget(
        tenant_id=TENANT,
        principal_type="user",
        principal_id="user-a",
        budget_period="week",
        daily_token_limit=25,
    )
    permit = repository.acquire_permit(
        tenant_id=TENANT,
        request_id=new_accounting_id(),
        principals=principals,
        now=monday,
    ).permit
    repository.record_provider_completion(
        permit_id=permit.permit_id,
        completion_id=new_accounting_id(),
        usage={"total_tokens": 25},
        usage_record=_usage_record(),
        principals=principals,
        completed_at=monday,
    )
    repository.complete_permit(permit.permit_id, now=monday)

    with pytest.raises(UsageBudgetExceeded) as raised:
        repository.acquire_permit(
            tenant_id=TENANT,
            request_id=new_accounting_id(),
            principals=principals,
            now=monday + timedelta(days=3),
        )
    assert raised.value.budget_period == "week"

    assert repository.acquire_permit(
        tenant_id=TENANT,
        request_id=new_accounting_id(),
        principals=principals,
        now=monday + timedelta(days=7),
    ).acquired


def test_zero_limit_allocation_does_not_constrain(tmp_path: Path) -> None:
    repository = _repository(tmp_path)
    principals = [("user", "user-a")]
    repository.set_principal_budget(
        tenant_id=TENANT, principal_type="user", principal_id="user-a", daily_token_limit=0
    )
    _settle_tokens(repository, tokens=5_000, principals=principals, request_id=new_accounting_id())
    assert repository.acquire_permit(
        tenant_id=TENANT, request_id=new_accounting_id(), principals=principals
    ).acquired


def test_settlement_increments_user_and_group_aggregates(tmp_path: Path) -> None:
    repository = _repository(tmp_path)
    principals = [("user", "user-a"), ("group", "group-legal"), ("group", "group-ops")]
    _settle_tokens(repository, tokens=40, principals=principals, request_id=new_accounting_id())
    _settle_tokens(repository, tokens=10, principals=principals, request_id=new_accounting_id())

    from app.core.usage_budget import utc_usage_date
    from datetime import UTC, datetime

    rows = repository.get_principal_daily_usage(TENANT, utc_usage_date(datetime.now(UTC)))
    by_key = {(row.principal_type, row.principal_id): row for row in rows}
    assert by_key[("user", "user-a")].reported_tokens == 50
    assert by_key[("group", "group-legal")].reported_tokens == 50
    assert by_key[("group", "group-ops")].reported_tokens == 50
    assert by_key[("user", "user-a")].metered_completions == 2


def test_admin_allocation_api_and_me_endpoint() -> None:
    client = TestClient(app)

    # Admin sets a user allocation for a real tenant member.
    listed = client.get("/api/admin/users", headers=ADMIN_AUTH)
    assert listed.status_code == 200
    member = next(
        user for user in listed.json() if user["id"] not in ("user-admin",) and user.get("group_ids")
    )

    set_response = client.put(
        "/api/admin/usage-allocations",
        headers=ADMIN_AUTH,
        json={
            "principal_type": "user",
            "principal_id": member["id"],
            "daily_token_limit": 12345,
        },
    )
    assert set_response.status_code == 200
    assert set_response.json()["daily_token_limit"] == 12345

    unknown = client.put(
        "/api/admin/usage-allocations",
        headers=ADMIN_AUTH,
        json={"principal_type": "user", "principal_id": "no-such-user", "daily_token_limit": 5},
    )
    assert unknown.status_code == 404

    allocations = client.get("/api/admin/usage-allocations", headers=ADMIN_AUTH)
    assert allocations.status_code == 200
    payload = allocations.json()
    rows = payload["allocations"]
    assert any(
        row["principal_id"] == member["id"] and row["daily_token_limit"] == 12345
        for row in rows
    )
    assert rows[0]["display_name"]

    # The member sees their own cap; label is honest.
    me = client.get("/api/auth/me/usage-budget", headers={"x-aperture-user": member["id"]})
    assert me.status_code == 200
    caps = me.json()["caps"]
    assert any(cap["scope"] == "user" and cap["daily_token_limit"] == 12345 for cap in caps)

    removed = client.delete(
        f"/api/admin/usage-allocations/user/{member['id']}", headers=ADMIN_AUTH
    )
    assert removed.status_code == 200
    me_after = client.get("/api/auth/me/usage-budget", headers={"x-aperture-user": member["id"]})
    assert me_after.status_code == 200
    assert all(cap["scope"] != "user" for cap in me_after.json()["caps"])


def test_platform_owner_manages_allocations_via_sole_tenant() -> None:
    client = TestClient(app)
    owner_auth = {"x-aperture-user": "user-owner"}
    listed = client.get("/api/admin/usage-allocations", headers=owner_auth)
    assert listed.status_code == 200
    assert "allocations" in listed.json()
