"""Add per-user/per-group daily token allocations inside the tenant ceiling.

Revision ID: 20260721_0011
Revises: 20260720_0010
Create Date: 2026-07-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260721_0011"
down_revision: str | None = "20260720_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "principal_usage_budgets",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("principal_type", sa.String(length=16), nullable=False),
        sa.Column("principal_id", sa.String(length=255), nullable=False),
        sa.Column("daily_token_limit", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.String(length=255), nullable=True),
        sa.CheckConstraint(
            "principal_type IN ('user', 'group')",
            name=op.f("ck_principal_usage_budgets_principal_budget_type_valid"),
        ),
        sa.CheckConstraint(
            "daily_token_limit >= 0",
            name=op.f("ck_principal_usage_budgets_principal_daily_token_limit_nonnegative"),
        ),
        sa.CheckConstraint(
            "daily_token_limit <= 9223372036854775807",
            name=op.f("ck_principal_usage_budgets_principal_daily_token_limit_bigint_max"),
        ),
        sa.PrimaryKeyConstraint(
            "tenant_id",
            "principal_type",
            "principal_id",
            name=op.f("pk_principal_usage_budgets"),
        ),
    )

    op.create_table(
        "principal_daily_usage",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("principal_type", sa.String(length=16), nullable=False),
        sa.Column("principal_id", sa.String(length=255), nullable=False),
        sa.Column("usage_date", sa.Date(), nullable=False),
        sa.Column("reported_tokens", sa.BigInteger(), nullable=False),
        sa.Column("reported_tokens_overflowed", sa.Boolean(), nullable=False),
        sa.Column("metered_completions", sa.BigInteger(), nullable=False),
        sa.Column("unmetered_completions", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "principal_type IN ('user', 'group')",
            name=op.f("ck_principal_daily_usage_principal_usage_type_valid"),
        ),
        sa.CheckConstraint(
            "reported_tokens >= 0",
            name=op.f("ck_principal_daily_usage_principal_reported_tokens_nonnegative"),
        ),
        sa.CheckConstraint(
            "reported_tokens <= 9223372036854775807",
            name=op.f("ck_principal_daily_usage_principal_reported_tokens_bigint_max"),
        ),
        sa.CheckConstraint(
            "metered_completions >= 0",
            name=op.f("ck_principal_daily_usage_principal_metered_completions_nonnegative"),
        ),
        sa.CheckConstraint(
            "unmetered_completions >= 0",
            name=op.f("ck_principal_daily_usage_principal_unmetered_completions_nonnegative"),
        ),
        sa.PrimaryKeyConstraint(
            "tenant_id",
            "principal_type",
            "principal_id",
            "usage_date",
            name=op.f("pk_principal_daily_usage"),
        ),
    )
    op.create_index(
        "ix_principal_daily_usage_date_tenant",
        "principal_daily_usage",
        ["usage_date", "tenant_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_principal_daily_usage_date_tenant", table_name="principal_daily_usage")
    op.drop_table("principal_daily_usage")
    op.drop_table("principal_usage_budgets")
