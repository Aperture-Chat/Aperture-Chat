"""Add budget units, UTC periods, and provider-reported spend accounting.

Revision ID: 20260721_0012
Revises: 20260721_0011
Create Date: 2026-07-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260721_0012"
down_revision: str | None = "20260721_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tenant_usage_budgets",
        sa.Column("budget_unit", sa.String(length=16), nullable=False, server_default="tokens"),
    )
    op.add_column(
        "tenant_usage_budgets",
        sa.Column("budget_period", sa.String(length=16), nullable=False, server_default="day"),
    )
    op.add_column(
        "tenant_usage_budgets",
        sa.Column("spend_limit_nanos", sa.BigInteger(), nullable=False, server_default="0"),
    )

    op.add_column(
        "tenant_daily_usage",
        sa.Column("reported_cost_nanos", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.add_column(
        "tenant_daily_usage",
        sa.Column("reported_cost_overflowed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "tenant_daily_usage",
        sa.Column("cost_metered_completions", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.add_column(
        "tenant_daily_usage",
        sa.Column("cost_unmetered_completions", sa.BigInteger(), nullable=False, server_default="0"),
    )
    # Historical completions predate exact cost capture. Label every one as
    # cost-unreported instead of presenting a misleading zero denominator.
    op.execute(
        sa.text(
            "UPDATE tenant_daily_usage "
            "SET cost_unmetered_completions = metered_completions + unmetered_completions"
        )
    )

    op.add_column(
        "tenant_usage_completion_events",
        sa.Column("reported_cost_nanos", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "principal_usage_budgets",
        sa.Column("budget_period", sa.String(length=16), nullable=False, server_default="day"),
    )

    with op.batch_alter_table("tenant_usage_budgets") as batch:
        batch.create_check_constraint(
            op.f("ck_tenant_usage_budgets_budget_unit_valid"),
            "budget_unit IN ('tokens', 'usd')",
        )
        batch.create_check_constraint(
            op.f("ck_tenant_usage_budgets_budget_period_valid"),
            "budget_period IN ('day', 'week', 'month')",
        )
        batch.create_check_constraint(
            op.f("ck_tenant_usage_budgets_spend_limit_nanos_nonnegative"),
            "spend_limit_nanos >= 0",
        )
        batch.create_check_constraint(
            op.f("ck_tenant_usage_budgets_spend_limit_nanos_bigint_max"),
            "spend_limit_nanos <= 9223372036854775807",
        )

    with op.batch_alter_table("tenant_daily_usage") as batch:
        batch.create_check_constraint(
            op.f("ck_tenant_daily_usage_reported_cost_nanos_nonnegative"),
            "reported_cost_nanos >= 0",
        )
        batch.create_check_constraint(
            op.f("ck_tenant_daily_usage_reported_cost_nanos_bigint_max"),
            "reported_cost_nanos <= 9223372036854775807",
        )
        batch.create_check_constraint(
            op.f("ck_tenant_daily_usage_reported_cost_overflow_consistent"),
            "reported_cost_overflowed = false OR reported_cost_nanos = 9223372036854775807",
        )
        for column in ("cost_metered_completions", "cost_unmetered_completions"):
            batch.create_check_constraint(
                op.f(f"ck_tenant_daily_usage_{column}_nonnegative"),
                f"{column} >= 0",
            )
            batch.create_check_constraint(
                op.f(f"ck_tenant_daily_usage_{column}_bigint_max"),
                f"{column} <= 9223372036854775807",
            )

    with op.batch_alter_table("tenant_usage_completion_events") as batch:
        batch.create_check_constraint(
            op.f("ck_tenant_usage_completion_events_reported_cost_nanos_nonnegative"),
            "reported_cost_nanos IS NULL OR reported_cost_nanos >= 0",
        )
        batch.create_check_constraint(
            op.f("ck_tenant_usage_completion_events_reported_cost_nanos_bigint_max"),
            "reported_cost_nanos IS NULL OR reported_cost_nanos <= 9223372036854775807",
        )

    with op.batch_alter_table("principal_usage_budgets") as batch:
        batch.create_check_constraint(
            op.f("ck_principal_usage_budgets_principal_budget_period_valid"),
            "budget_period IN ('day', 'week', 'month')",
        )


def downgrade() -> None:
    with op.batch_alter_table("principal_usage_budgets") as batch:
        batch.drop_constraint(
            op.f("ck_principal_usage_budgets_principal_budget_period_valid"),
            type_="check",
        )
    with op.batch_alter_table("tenant_usage_completion_events") as batch:
        batch.drop_constraint(
            op.f("ck_tenant_usage_completion_events_reported_cost_nanos_bigint_max"),
            type_="check",
        )
        batch.drop_constraint(
            op.f("ck_tenant_usage_completion_events_reported_cost_nanos_nonnegative"),
            type_="check",
        )
    with op.batch_alter_table("tenant_daily_usage") as batch:
        for column in ("cost_unmetered_completions", "cost_metered_completions"):
            batch.drop_constraint(
                op.f(f"ck_tenant_daily_usage_{column}_bigint_max"),
                type_="check",
            )
            batch.drop_constraint(
                op.f(f"ck_tenant_daily_usage_{column}_nonnegative"),
                type_="check",
            )
        batch.drop_constraint(
            op.f("ck_tenant_daily_usage_reported_cost_overflow_consistent"),
            type_="check",
        )
        batch.drop_constraint(
            op.f("ck_tenant_daily_usage_reported_cost_nanos_bigint_max"),
            type_="check",
        )
        batch.drop_constraint(
            op.f("ck_tenant_daily_usage_reported_cost_nanos_nonnegative"),
            type_="check",
        )
    with op.batch_alter_table("tenant_usage_budgets") as batch:
        batch.drop_constraint(
            op.f("ck_tenant_usage_budgets_spend_limit_nanos_bigint_max"),
            type_="check",
        )
        batch.drop_constraint(
            op.f("ck_tenant_usage_budgets_spend_limit_nanos_nonnegative"),
            type_="check",
        )
        batch.drop_constraint(
            op.f("ck_tenant_usage_budgets_budget_period_valid"),
            type_="check",
        )
        batch.drop_constraint(
            op.f("ck_tenant_usage_budgets_budget_unit_valid"),
            type_="check",
        )
    op.drop_column("principal_usage_budgets", "budget_period")
    op.drop_column("tenant_usage_completion_events", "reported_cost_nanos")
    op.drop_column("tenant_daily_usage", "cost_unmetered_completions")
    op.drop_column("tenant_daily_usage", "cost_metered_completions")
    op.drop_column("tenant_daily_usage", "reported_cost_overflowed")
    op.drop_column("tenant_daily_usage", "reported_cost_nanos")
    op.drop_column("tenant_usage_budgets", "spend_limit_nanos")
    op.drop_column("tenant_usage_budgets", "budget_period")
    op.drop_column("tenant_usage_budgets", "budget_unit")
