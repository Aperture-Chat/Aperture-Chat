"""Create relational application-state foundation.

Revision ID: 20260720_0001
Revises:
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "audit_events",
        sa.Column(
            "sequence",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("actor_id", sa.String(length=255), nullable=False),
        sa.Column("actor_name", sa.Text(), nullable=False),
        sa.Column("actor_role", sa.String(length=100), nullable=False),
        sa.Column("action", sa.String(length=255), nullable=False),
        sa.Column("action_type", sa.String(length=255), nullable=False),
        sa.Column("target", sa.Text(), nullable=False),
        sa.Column("target_type", sa.String(length=255), nullable=False),
        sa.Column("target_name", sa.Text(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("redacted", sa.Boolean(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("sequence", name=op.f("pk_audit_events")),
        sa.UniqueConstraint("id", name=op.f("uq_audit_events_id")),
        sqlite_autoincrement=True,
    )
    op.create_index(
        "ix_audit_events_action_created_at",
        "audit_events",
        ["action", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_audit_events_actor_created_at",
        "audit_events",
        ["actor_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_audit_events_created_at_sequence",
        "audit_events",
        ["created_at", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_audit_events_tenant_created_at_sequence",
        "audit_events",
        ["tenant_id", "created_at", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_audit_events_tenant_sequence",
        "audit_events",
        ["tenant_id", "sequence"],
        unique=False,
    )

    op.create_table(
        "usage_records",
        sa.Column(
            "sequence",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("user_name", sa.Text(), nullable=False),
        sa.Column("user_role", sa.String(length=100), nullable=False),
        sa.Column("model_id", sa.Text(), nullable=False),
        sa.Column("provider_name", sa.Text(), nullable=False),
        sa.Column("surface", sa.String(length=100), nullable=False),
        sa.Column("message_count", sa.Integer(), nullable=False),
        sa.Column("prompt_tokens", sa.BigInteger(), nullable=True),
        sa.Column("completion_tokens", sa.BigInteger(), nullable=True),
        sa.Column("total_tokens", sa.BigInteger(), nullable=True),
        sa.Column("thread_id", sa.String(length=255), nullable=True),
        sa.Column("source", sa.String(length=100), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "completion_tokens IS NULL OR completion_tokens >= 0",
            name=op.f("ck_usage_records_completion_tokens_nonnegative"),
        ),
        sa.CheckConstraint(
            "message_count >= 1",
            name=op.f("ck_usage_records_message_count_positive"),
        ),
        sa.CheckConstraint(
            "prompt_tokens IS NULL OR prompt_tokens >= 0",
            name=op.f("ck_usage_records_prompt_tokens_nonnegative"),
        ),
        sa.CheckConstraint(
            "total_tokens IS NULL OR total_tokens >= 0",
            name=op.f("ck_usage_records_total_tokens_nonnegative"),
        ),
        sa.PrimaryKeyConstraint("sequence", name=op.f("pk_usage_records")),
        sa.UniqueConstraint("id", name=op.f("uq_usage_records_id")),
        sqlite_autoincrement=True,
    )
    op.create_index(
        "ix_usage_records_created_at_sequence",
        "usage_records",
        ["created_at", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_usage_records_tenant_created_at_sequence",
        "usage_records",
        ["tenant_id", "created_at", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_usage_records_tenant_sequence",
        "usage_records",
        ["tenant_id", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_usage_records_user_created_at_sequence",
        "usage_records",
        ["user_id", "created_at", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_usage_records_user_sequence",
        "usage_records",
        ["user_id", "sequence"],
        unique=False,
    )

    op.create_table(
        "revoked_sessions",
        sa.Column("sid", sa.String(length=128), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("issued_at", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reason", sa.String(length=255), nullable=False),
        sa.CheckConstraint(
            "expires_at >= issued_at",
            name=op.f("ck_revoked_sessions_expiry_after_issue"),
        ),
        sa.PrimaryKeyConstraint("sid", name=op.f("pk_revoked_sessions")),
    )
    op.create_index(
        "ix_revoked_sessions_expires_at",
        "revoked_sessions",
        ["expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_revoked_sessions_tenant_revoked_at",
        "revoked_sessions",
        ["tenant_id", "revoked_at"],
        unique=False,
    )
    op.create_index(
        "ix_revoked_sessions_user_expires_at",
        "revoked_sessions",
        ["user_id", "expires_at"],
        unique=False,
    )

    op.create_table(
        "audit_outbox",
        sa.Column(
            "sequence",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("dedupe_key", sa.String(length=320), nullable=False),
        sa.Column("event_id", sa.String(length=255), nullable=True),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("sequence", name=op.f("pk_audit_outbox")),
        sa.UniqueConstraint("dedupe_key", name=op.f("uq_audit_outbox_dedupe_key")),
        sqlite_autoincrement=True,
    )
    op.create_index(
        "ix_audit_outbox_delivered_sequence",
        "audit_outbox",
        ["delivered_at", "sequence"],
        unique=False,
    )
    op.create_index(
        "ix_audit_outbox_tenant_delivered_sequence",
        "audit_outbox",
        ["tenant_id", "delivered_at", "sequence"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_audit_outbox_tenant_delivered_sequence",
        table_name="audit_outbox",
    )
    op.drop_index("ix_audit_outbox_delivered_sequence", table_name="audit_outbox")
    op.drop_table("audit_outbox")
    op.drop_index("ix_revoked_sessions_user_expires_at", table_name="revoked_sessions")
    op.drop_index("ix_revoked_sessions_tenant_revoked_at", table_name="revoked_sessions")
    op.drop_index("ix_revoked_sessions_expires_at", table_name="revoked_sessions")
    op.drop_table("revoked_sessions")
    op.drop_index("ix_usage_records_user_sequence", table_name="usage_records")
    op.drop_index("ix_usage_records_user_created_at_sequence", table_name="usage_records")
    op.drop_index("ix_usage_records_tenant_sequence", table_name="usage_records")
    op.drop_index("ix_usage_records_tenant_created_at_sequence", table_name="usage_records")
    op.drop_index("ix_usage_records_created_at_sequence", table_name="usage_records")
    op.drop_table("usage_records")
    op.drop_index("ix_audit_events_tenant_sequence", table_name="audit_events")
    op.drop_index("ix_audit_events_tenant_created_at_sequence", table_name="audit_events")
    op.drop_index("ix_audit_events_created_at_sequence", table_name="audit_events")
    op.drop_index("ix_audit_events_actor_created_at", table_name="audit_events")
    op.drop_index("ix_audit_events_action_created_at", table_name="audit_events")
    op.drop_table("audit_events")
