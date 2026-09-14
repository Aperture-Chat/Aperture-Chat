"""Per-model access requests that administrators can review.

A signed-in person who cannot use an organization model can ask for it; the
row is advisory (nothing else references it) and tenant-scoped. Uniqueness of
one pending request per (tenant, user, model) is enforced by the repository
under the engine write lock rather than by a partial index, which SQLite batch
mode and metadata comparison handle inconsistently.

Revision ID: 20260913_0021
Revises: 20260913_0020
Create Date: 2026-09-13
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260913_0021"
down_revision: str | None = "20260913_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "model_access_requests",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("model_id", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_by_user_id", sa.String(length=255), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.Column("granted_group_id", sa.String(length=255), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'declined', 'withdrawn')",
            name=op.f("ck_model_access_requests_status_valid"),
        ),
        sa.CheckConstraint(
            "note IS NULL OR length(note) <= 500",
            name=op.f("ck_model_access_requests_note_bounded"),
        ),
        sa.CheckConstraint(
            "resolution_note IS NULL OR length(resolution_note) <= 500",
            name=op.f("ck_model_access_requests_resolution_note_bounded"),
        ),
        sa.CheckConstraint("updated_at >= created_at", name=op.f("ck_model_access_requests_updated_after_creation")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_model_access_requests_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_model_access_requests")),
    )
    op.create_index(
        "ix_model_access_requests_tenant_status_created",
        "model_access_requests",
        ["tenant_id", "status", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_model_access_requests_tenant_user_model",
        "model_access_requests",
        ["tenant_id", "user_id", "model_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_model_access_requests_tenant_user_model", table_name="model_access_requests")
    op.drop_index("ix_model_access_requests_tenant_status_created", table_name="model_access_requests")
    op.drop_table("model_access_requests")
