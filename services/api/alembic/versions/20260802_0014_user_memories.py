"""Add per-user personalization memory tables.

Three snapshot collections back the memory feature: the memories themselves,
one policy row per tenant, and one settings row per user. Content lives in the
JSON payload like every other identity/config collection; the projected
columns exist for integrity and cascade, never for reading memory content on
behalf of another account.

Revision ID: 20260802_0014
Revises: 20260731_0013
Create Date: 2026-08-02
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260802_0014"
down_revision: str | None = "20260731_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _ordered_payload_table(
    name: str,
    *columns: sa.Column[object],
    constraints: Sequence[sa.Constraint] = (),
) -> None:
    op.create_table(
        name,
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        *columns,
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.CheckConstraint(
            "ordinal >= 0",
            name=op.f(f"ck_{name}_ordinal_nonnegative"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{name}")),
        sa.UniqueConstraint("ordinal", name=op.f(f"uq_{name}_ordinal")),
        *constraints,
    )


def upgrade() -> None:
    _ordered_payload_table(
        "user_memories",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("owner_user_id", sa.String(length=255), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_user_memories_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["owner_user_id"],
                ["identity_users.id"],
                name=op.f("fk_user_memories_owner_user_id_identity_users"),
                ondelete="CASCADE",
            ),
        ),
    )
    op.create_index(
        "ix_user_memories_tenant_owner",
        "user_memories",
        ["tenant_id", "owner_user_id"],
        unique=False,
    )

    _ordered_payload_table(
        "tenant_memory_policies",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_tenant_memory_policies_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint("tenant_id", name=op.f("uq_tenant_memory_policies_tenant")),
        ),
    )

    _ordered_payload_table(
        "user_memory_settings",
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["identity_users.id"],
                name=op.f("fk_user_memory_settings_user_id_identity_users"),
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint("user_id", name=op.f("uq_user_memory_settings_user")),
        ),
    )


def downgrade() -> None:
    op.drop_table("user_memory_settings")
    op.drop_table("tenant_memory_policies")
    op.drop_index("ix_user_memories_tenant_owner", table_name="user_memories")
    op.drop_table("user_memories")
