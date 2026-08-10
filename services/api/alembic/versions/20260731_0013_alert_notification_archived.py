"""Add the archived flag to alert notifications.

Archiving is view management only: archived deliveries stay in the durable
history and exports, they are just hidden from the default console list.

Revision ID: 20260731_0013
Revises: 20260721_0012
Create Date: 2026-07-31
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260731_0013"
down_revision: str | None = "20260721_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "alert_notifications",
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("alert_notifications", "archived")
