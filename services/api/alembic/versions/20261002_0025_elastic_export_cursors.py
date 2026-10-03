"""Elastic export stream cursors.

The Elastic export grew from audit-only (delivered through the durable
``audit_outbox``) to also mirroring chats, uploaded documents, and usage.
Those streams read their canonical tables in ``sequence`` order, so
``elastic_export_cursors`` records the highest sequence Elastic has
acknowledged per stream. Restarts resume where delivery stopped instead of
re-sending history, and ``target_signature`` restarts a stream from the
beginning when the export is pointed at a different cluster or index prefix.

Revision ID: 20261002_0025
Revises: 20260923_0024
Create Date: 2026-10-02
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261002_0025"
down_revision: str | None = "20260923_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "elastic_export_cursors",
        sa.Column("stream", sa.String(length=64), nullable=False),
        sa.Column("target_signature", sa.String(length=64), nullable=False),
        sa.Column("position", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "position >= 0",
            name=op.f("ck_elastic_export_cursors_position_nonnegative"),
        ),
        sa.PrimaryKeyConstraint("stream", name=op.f("pk_elastic_export_cursors")),
    )


def downgrade() -> None:
    op.drop_table("elastic_export_cursors")
