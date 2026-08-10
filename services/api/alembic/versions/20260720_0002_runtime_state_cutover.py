"""Add runtime-state cutover and alert delivery tables.

Revision ID: 20260720_0002
Revises: 20260720_0001
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0002"
down_revision: str | None = "20260720_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "runtime_state_imports",
        sa.Column("source_digest", sa.String(length=64), nullable=False),
        sa.Column("source_version", sa.Integer(), nullable=False),
        sa.Column("target_version", sa.Integer(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("audit_count", sa.Integer(), nullable=False),
        sa.Column("usage_count", sa.Integer(), nullable=False),
        sa.Column("outbox_count", sa.Integer(), nullable=False),
        sa.Column("alert_notification_count", sa.Integer(), nullable=False),
        sa.Column("alert_runtime_count", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "alert_notification_count >= 0",
            name=op.f("ck_runtime_state_imports_alert_notification_count_nonnegative"),
        ),
        sa.CheckConstraint(
            "alert_runtime_count >= 0",
            name=op.f("ck_runtime_state_imports_alert_runtime_count_nonnegative"),
        ),
        sa.CheckConstraint(
            "audit_count >= 0",
            name=op.f("ck_runtime_state_imports_audit_count_nonnegative"),
        ),
        sa.CheckConstraint(
            "outbox_count >= 0",
            name=op.f("ck_runtime_state_imports_outbox_count_nonnegative"),
        ),
        sa.CheckConstraint(
            "usage_count >= 0",
            name=op.f("ck_runtime_state_imports_usage_count_nonnegative"),
        ),
        sa.PrimaryKeyConstraint("source_digest", name=op.f("pk_runtime_state_imports")),
    )

    op.create_table(
        "alert_rule_runtime",
        sa.Column("rule_id", sa.String(length=255), nullable=False),
        sa.Column("last_triggered_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("rule_id", name=op.f("pk_alert_rule_runtime")),
    )

    op.create_table(
        "alert_notifications",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("rule_id", sa.String(length=255), nullable=False),
        sa.Column("rule_name", sa.Text(), nullable=False),
        sa.Column("scope", sa.String(length=32), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("event_id", sa.String(length=255), nullable=False),
        sa.Column("event_action", sa.Text(), nullable=False),
        sa.Column("event_severity", sa.String(length=32), nullable=False),
        sa.Column("actor_id", sa.String(length=255), nullable=False),
        sa.Column("actor_name", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("matched_count", sa.Integer(), nullable=False),
        sa.Column("recipients", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("status_detail", sa.Text(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "attempts >= 0",
            name=op.f("ck_alert_notifications_attempts_nonnegative"),
        ),
        sa.CheckConstraint(
            "event_severity IN ('info', 'warning', 'critical')",
            name=op.f("ck_alert_notifications_event_severity_valid"),
        ),
        sa.CheckConstraint(
            "matched_count >= 1",
            name=op.f("ck_alert_notifications_matched_count_positive"),
        ),
        sa.CheckConstraint(
            "scope IN ('platform', 'tenant')",
            name=op.f("ck_alert_notifications_scope_valid"),
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'sent', 'failed', 'not_configured', 'logged')",
            name=op.f("ck_alert_notifications_status_valid"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_alert_notifications")),
    )
    op.create_index(
        "ix_alert_notifications_status_created_at_id",
        "alert_notifications",
        ["status", "created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_alert_notifications_tenant_created_at_id",
        "alert_notifications",
        ["tenant_id", "created_at", "id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_alert_notifications_tenant_created_at_id",
        table_name="alert_notifications",
    )
    op.drop_index(
        "ix_alert_notifications_status_created_at_id",
        table_name="alert_notifications",
    )
    op.drop_table("alert_notifications")
    op.drop_table("alert_rule_runtime")
    op.drop_table("runtime_state_imports")
