"""Add server-side chat response feedback with optional comments.

Thumbs feedback previously lived only in browser localStorage, so admins
could never read another user's sentiment. One row per (user, message): a
later thumb click updates the rating, a later note updates the comment. No
foreign keys — threads are client-authored and may not be saved yet when the
thumb is clicked.

Revision ID: 20260817_0017
Revises: 20260816_0016
Create Date: 2026-08-17
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260817_0017"
down_revision: str | None = "20260816_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chat_feedback",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("user_name", sa.Text(), nullable=False),
        sa.Column("thread_id", sa.String(length=255), nullable=False),
        sa.Column("thread_title", sa.Text(), nullable=False),
        sa.Column("message_id", sa.String(length=255), nullable=False),
        sa.Column("rating", sa.String(length=16), nullable=False),
        sa.Column("comment", sa.Text(), nullable=False),
        sa.Column("message_preview", sa.Text(), nullable=False),
        sa.Column("model_id", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("rating IN ('positive', 'negative')", name=op.f("ck_chat_feedback_rating_known")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_feedback")),
        sa.UniqueConstraint("user_id", "message_id", name="uq_chat_feedback_user_message"),
    )
    op.create_index(
        "ix_chat_feedback_tenant_created",
        "chat_feedback",
        ["tenant_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_chat_feedback_tenant_created", table_name="chat_feedback")
    op.drop_table("chat_feedback")
