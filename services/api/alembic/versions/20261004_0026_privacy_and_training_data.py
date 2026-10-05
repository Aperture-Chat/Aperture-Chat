"""Personal-data protection policy and training-dataset capture.

``tenant_data_policies`` holds one JSON policy per (tenant, kind): ``privacy``
for personal-data concealment and ``training`` for what the organization
captures as possible fine-tuning data. ``training_datasets`` holds
administrator-defined routing rules and export formats, and
``training_examples`` holds de-identified learning signals (rated responses
and corrections) copied from saved chats. Examples carry no foreign keys
because threads are client-authored; chat deletion paths remove them
explicitly.

Revision ID: 20261004_0026
Revises: 20261002_0025
Create Date: 2026-10-04
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261004_0026"
down_revision: str | None = "20261002_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tenant_data_policies",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("payload", sa.JSON(none_as_null=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "kind IN ('privacy', 'training')",
            name=op.f("ck_tenant_data_policies_kind_known"),
        ),
        sa.PrimaryKeyConstraint("tenant_id", "kind", name=op.f("pk_tenant_data_policies")),
    )
    op.create_table(
        "training_datasets",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("archived", sa.Boolean(), nullable=False),
        sa.Column("payload", sa.JSON(none_as_null=True), nullable=False),
        sa.Column("created_by", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_training_datasets")),
    )
    op.create_index(
        "ix_training_datasets_tenant",
        "training_datasets",
        ["tenant_id", "created_at"],
        unique=False,
    )
    op.create_table(
        "training_examples",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("thread_id", sa.String(length=255), nullable=False),
        sa.Column("message_id", sa.String(length=255), nullable=False),
        sa.Column("signal", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("model_id", sa.Text(), nullable=False),
        sa.Column("practice_area", sa.String(length=64), nullable=False),
        sa.Column("task_type", sa.String(length=32), nullable=False),
        sa.Column("payload", sa.JSON(none_as_null=True), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "signal IN ('positive', 'negative', 'correction')",
            name=op.f("ck_training_examples_signal_known"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'excluded')",
            name=op.f("ck_training_examples_status_known"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_training_examples")),
        sa.UniqueConstraint(
            "tenant_id", "thread_id", "message_id", "signal", name="uq_training_examples_signal"
        ),
    )
    op.create_index(
        "ix_training_examples_tenant_captured",
        "training_examples",
        ["tenant_id", "captured_at"],
        unique=False,
    )
    op.create_index("ix_training_examples_thread", "training_examples", ["thread_id"], unique=False)
    op.create_index("ix_training_examples_user", "training_examples", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_training_examples_user", table_name="training_examples")
    op.drop_index("ix_training_examples_thread", table_name="training_examples")
    op.drop_index("ix_training_examples_tenant_captured", table_name="training_examples")
    op.drop_table("training_examples")
    op.drop_index("ix_training_datasets_tenant", table_name="training_datasets")
    op.drop_table("training_datasets")
    op.drop_table("tenant_data_policies")
