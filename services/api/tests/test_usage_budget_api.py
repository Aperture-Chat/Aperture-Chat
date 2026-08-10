"""Control-plane and tenant-lifecycle coverage for UTC token budgets."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.usage_budget import new_accounting_id
from app.core.usage_budget_runtime import ProviderUsageAttribution
from app.main import app
from app.models.schemas import TenantCreate
from app.repositories.deps import get_store, get_usage_budget_orchestrator


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def _headers(user_id: str, *, tenant_slug: str | None = None) -> dict[str, str]:
    headers = {"x-aperture-user": user_id}
    if tenant_slug is not None:
        headers["x-aperture-tenant"] = tenant_slug
    return headers


def test_owner_scope_is_explicit_even_with_one_tenant() -> None:
    # Single-tenant posture: with exactly one tenant, the deployment pins to
    # it, so an owner needs no X-Aperture-Tenant header.
    missing = client.get(
        "/api/platform/usage-budget",
        headers=_headers("user-owner"),
    )
    assert missing.status_code == 200
    assert missing.json()["tenant_id"] == "tenant-example"

    unknown = client.get(
        "/api/platform/usage-budget",
        headers=_headers("user-owner", tenant_slug="missing"),
    )
    assert unknown.status_code == 404

    selected = client.get(
        "/api/platform/usage-budget",
        headers=_headers("user-owner", tenant_slug="example"),
    )
    assert selected.status_code == 200
    assert selected.json() == {
        "tenant_id": "tenant-example",
        "budget_unit": "tokens",
        "budget_period": "day",
        "limit_value": 0,
        "daily_token_limit": 0,
        "spend_limit_nanos": 0,
        "updated_at": selected.json()["updated_at"],
        "updated_by": None,
        "usage_date": selected.json()["usage_date"],
        "period_start": selected.json()["period_start"],
        "period_end": selected.json()["period_end"],
        "reported_tokens": 0,
        "reported_tokens_overflowed": False,
        "reported_cost_nanos": 0,
        "reported_cost_usd": 0,
        "reported_cost_overflowed": False,
        "metered_completions": 0,
        "unmetered_completions": 0,
        "cost_metered_completions": 0,
        "cost_unmetered_completions": 0,
    }


def test_owner_can_update_and_tenant_admin_can_read_exact_daily_counters() -> None:
    updated = client.patch(
        "/api/platform/usage-budget",
        headers=_headers("user-owner", tenant_slug="example"),
        json={"daily_token_limit": 2_000},
    )
    assert updated.status_code == 200
    assert updated.json()["daily_token_limit"] == 2_000
    assert updated.json()["updated_by"] == "user-owner"

    store = get_store()
    actor = store.users["user-admin"]
    context = get_usage_budget_orchestrator().begin_request(
        actor=actor,
        request_id=new_accounting_id(),
        known_tenant_ids=store.tenants.keys(),
    )
    context.settle_provider_child(
        completion_id=new_accounting_id(),
        usage={"prompt_tokens": 13, "completion_tokens": 8, "total_tokens": 21},
        attribution=ProviderUsageAttribution(
            model_id="openrouter-openai-gpt-4o-mini",
            provider_name="OpenRouter",
            surface="chat",
        ),
    )
    context.complete_success()

    response = client.get(
        "/api/admin/usage-budget",
        headers=_headers("user-admin"),
    )
    assert response.status_code == 200
    assert response.json()["tenant_id"] == "tenant-example"
    assert response.json()["reported_tokens"] == 21
    assert response.json()["metered_completions"] == 1
    assert response.json()["unmetered_completions"] == 0

    assert (
        client.get(
            "/api/admin/usage-budget",
            headers=_headers("user-jane"),
        ).status_code
        == 403
    )


def test_owner_can_choose_usd_and_monthly_budget_policy() -> None:
    updated = client.patch(
        "/api/platform/usage-budget",
        headers=_headers("user-owner", tenant_slug="example"),
        json={
            "budget_unit": "usd",
            "budget_period": "month",
            "limit_value": 125.50,
        },
    )
    assert updated.status_code == 200
    payload = updated.json()
    assert payload["budget_unit"] == "usd"
    assert payload["budget_period"] == "month"
    assert payload["limit_value"] == 125.5
    assert payload["spend_limit_nanos"] == 125_500_000_000
    assert payload["daily_token_limit"] == 0


def test_tenant_lifecycle_provisions_then_deletes_only_active_budget() -> None:
    store = get_store()
    owner = store.users["user-owner"]
    tenant = store.create_tenant(
        TenantCreate(name="Budget Tenant", slug="budget-tenant"),
        owner,
    )
    repository = store.usage_budget_repository
    assert repository.get_budget(tenant.id) is not None

    context = get_usage_budget_orchestrator().begin_request(
        actor=owner,
        request_id=new_accounting_id(),
        explicit_tenant_id=tenant.id,
        known_tenant_ids=store.tenants.keys(),
    )
    context.settle_provider_child(
        completion_id=new_accounting_id(),
        usage=None,
        attribution=ProviderUsageAttribution(
            model_id="openrouter-openai-gpt-4o-mini",
            provider_name="OpenRouter",
            surface="chat",
        ),
    )
    context.complete_success()
    usage_date = context.permit.admission_date

    store.delete_tenant(tenant.id, owner)

    assert repository.get_budget(tenant.id) is None
    daily = repository.get_daily_usage(tenant.id, usage_date)
    assert daily is not None
    assert daily.unmetered_completions == 1
