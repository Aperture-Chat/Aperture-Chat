"""Add server-side platform issue reports with optional screenshot metadata.

Screenshot bytes are stored as sanitized previews on the durable data volume,
not in this table. The row holds only the reporter, message, and safe metadata.

Revision ID: 20260820_0018
Revises: 20260817_0017
Create Date: 2026-08-20
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260820_0018"
down_revision: str | None = "20260817_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "issue_reports",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("user_name", sa.Text(), nullable=False),
        sa.Column("subject", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("screenshot_filename", sa.Text(), nullable=True),
        sa.Column("screenshot_mime_type", sa.String(length=255), nullable=True),
        sa.Column("screenshot_size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_issue_reports")),
    )
    op.create_index(
        "ix_issue_reports_tenant_created",
        "issue_reports",
        ["tenant_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_issue_reports_tenant_created", table_name="issue_reports")
    op.drop_table("issue_reports")
