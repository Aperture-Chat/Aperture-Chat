"""Turn issue reports into tracked support tickets with a community hub link.

Adds ticket fields to ``issue_reports`` (per-organization number, type,
priority, status, assignee, diagnostics, activity markers), a timeline table,
the instance-side link to the community intake hub, single-row support
settings, and the hub's own intake queue. Existing reports become ``new``
tickets numbered by submission time; their reporters are treated as having
seen them so nothing appears unread after the upgrade.

Revision ID: 20261021_0027
Revises: 20261004_0026
Create Date: 2026-10-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261021_0027"
down_revision: str | None = "20261004_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _backfill_ticket_numbers() -> None:
    # Offline --sql rendering covers schema only; numbering reads live rows.
    if op.get_context().as_sql:
        return
    bind = op.get_bind()
    reports = sa.table(
        "issue_reports",
        sa.column("id", sa.String()),
        sa.column("tenant_id", sa.String()),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("number", sa.Integer()),
        sa.column("updated_at", sa.DateTime(timezone=True)),
        sa.column("last_public_activity_at", sa.DateTime(timezone=True)),
        sa.column("reporter_seen_at", sa.DateTime(timezone=True)),
    )
    rows = bind.execute(
        sa.select(reports.c.id, reports.c.tenant_id, reports.c.created_at).order_by(
            reports.c.tenant_id, reports.c.created_at, reports.c.id
        )
    ).all()
    next_number: dict[str, int] = {}
    for report_id, tenant_id, created_at in rows:
        number = next_number.get(tenant_id, 0) + 1
        next_number[tenant_id] = number
        bind.execute(
            reports.update()
            .where(reports.c.id == report_id)
            .values(
                number=number,
                updated_at=created_at,
                last_public_activity_at=created_at,
                reporter_seen_at=created_at,
            )
        )


def upgrade() -> None:
    op.add_column("issue_reports", sa.Column("number", sa.Integer(), nullable=True))
    op.add_column(
        "issue_reports",
        sa.Column("kind", sa.String(length=16), nullable=False, server_default="bug"),
    )
    op.add_column(
        "issue_reports",
        sa.Column("priority", sa.String(length=16), nullable=False, server_default="normal"),
    )
    op.add_column(
        "issue_reports",
        sa.Column("status", sa.String(length=16), nullable=False, server_default="new"),
    )
    op.add_column(
        "issue_reports", sa.Column("assignee_user_id", sa.String(length=255), nullable=True)
    )
    op.add_column("issue_reports", sa.Column("assignee_name", sa.Text(), nullable=True))
    op.add_column(
        "issue_reports", sa.Column("diagnostics", sa.JSON(none_as_null=True), nullable=True)
    )
    for column in ("updated_at", "resolved_at", "last_public_activity_at", "reporter_seen_at"):
        op.add_column(
            "issue_reports", sa.Column(column, sa.DateTime(timezone=True), nullable=True)
        )
    op.add_column(
        "issue_reports", sa.Column("last_activity_by", sa.String(length=16), nullable=True)
    )
    _backfill_ticket_numbers()
    op.create_index(
        "ix_issue_reports_tenant_number", "issue_reports", ["tenant_id", "number"], unique=True
    )
    op.create_index(
        "ix_issue_reports_tenant_status", "issue_reports", ["tenant_id", "status"], unique=False
    )
    op.create_index(
        "ix_issue_reports_user_created", "issue_reports", ["user_id", "created_at"], unique=False
    )

    op.create_table(
        "issue_report_events",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("report_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("visibility", sa.String(length=16), nullable=False),
        sa.Column("actor_user_id", sa.String(length=255), nullable=True),
        sa.Column("actor_name", sa.Text(), nullable=False),
        sa.Column("actor_kind", sa.String(length=16), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("from_value", sa.String(length=64), nullable=True),
        sa.Column("to_value", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["issue_reports.id"],
            name=op.f("fk_issue_report_events_report_id_issue_reports"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_issue_report_events")),
    )
    op.create_index(
        "ix_issue_report_events_report_created",
        "issue_report_events",
        ["report_id", "created_at"],
        unique=False,
    )

    op.create_table(
        "issue_report_upstream",
        sa.Column("report_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("state", sa.String(length=24), nullable=False),
        sa.Column("hub_url", sa.Text(), nullable=False),
        sa.Column("hub_report_id", sa.String(length=255), nullable=True),
        sa.Column("receipt_token", sa.Text(), nullable=True),
        sa.Column("issue_number", sa.Integer(), nullable=True),
        sa.Column("issue_url", sa.Text(), nullable=True),
        sa.Column("issue_state", sa.String(length=16), nullable=True),
        sa.Column("issue_state_reason", sa.String(length=32), nullable=True),
        sa.Column("maintainer_note", sa.Text(), nullable=True),
        sa.Column("shared_by_user_id", sa.String(length=255), nullable=True),
        sa.Column("shared_by_name", sa.Text(), nullable=False),
        sa.Column("sent_title", sa.Text(), nullable=False),
        sa.Column("sent_body", sa.Text(), nullable=False),
        sa.Column("sent_diagnostics", sa.JSON(none_as_null=True), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("queued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["report_id"],
            ["issue_reports.id"],
            name=op.f("fk_issue_report_upstream_report_id_issue_reports"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("report_id", name=op.f("pk_issue_report_upstream")),
    )
    op.create_index(
        "ix_issue_report_upstream_state_next",
        "issue_report_upstream",
        ["state", "next_attempt_at"],
        unique=False,
    )

    op.create_table(
        "support_settings",
        sa.Column("singleton_id", sa.Integer(), nullable=False),
        sa.Column("upstream_mode", sa.String(length=16), nullable=False),
        sa.Column("instance_id", sa.String(length=64), nullable=False),
        sa.Column("ai_model_id", sa.String(length=255), nullable=True),
        sa.Column("notify_reporters", sa.Boolean(), nullable=False),
        sa.Column("hub_enabled", sa.Boolean(), nullable=False),
        sa.Column("hub_repository", sa.String(length=255), nullable=False),
        sa.Column("hub_auto_publish", sa.Boolean(), nullable=False),
        sa.Column("hub_ai_triage", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("singleton_id = 1", name=op.f("ck_support_settings_singleton_id_one")),
        sa.PrimaryKeyConstraint("singleton_id", name=op.f("pk_support_settings")),
    )

    op.create_table(
        "support_hub_reports",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("receipt_hash", sa.String(length=64), nullable=False),
        sa.Column("instance_id", sa.String(length=64), nullable=False),
        sa.Column("instance_version", sa.String(length=32), nullable=False),
        sa.Column("source_hash", sa.String(length=64), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("priority", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("diagnostics", sa.JSON(none_as_null=True), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("issue_number", sa.Integer(), nullable=True),
        sa.Column("issue_url", sa.Text(), nullable=True),
        sa.Column("issue_state", sa.String(length=16), nullable=True),
        sa.Column("issue_state_reason", sa.String(length=32), nullable=True),
        sa.Column("issue_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("triage", sa.JSON(none_as_null=True), nullable=True),
        sa.Column("maintainer_note", sa.Text(), nullable=True),
        sa.Column("reviewed_by_name", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_support_hub_reports")),
    )
    op.create_index(
        "ix_support_hub_reports_status_received",
        "support_hub_reports",
        ["status", "received_at"],
        unique=False,
    )
    op.create_index(
        "ix_support_hub_reports_instance_received",
        "support_hub_reports",
        ["instance_id", "received_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_support_hub_reports_instance_received", table_name="support_hub_reports")
    op.drop_index("ix_support_hub_reports_status_received", table_name="support_hub_reports")
    op.drop_table("support_hub_reports")
    op.drop_table("support_settings")
    op.drop_index("ix_issue_report_upstream_state_next", table_name="issue_report_upstream")
    op.drop_table("issue_report_upstream")
    op.drop_index("ix_issue_report_events_report_created", table_name="issue_report_events")
    op.drop_table("issue_report_events")
    op.drop_index("ix_issue_reports_user_created", table_name="issue_reports")
    op.drop_index("ix_issue_reports_tenant_status", table_name="issue_reports")
    op.drop_index("ix_issue_reports_tenant_number", table_name="issue_reports")
    with op.batch_alter_table("issue_reports") as batch:
        for column in (
            "last_activity_by",
            "reporter_seen_at",
            "last_public_activity_at",
            "resolved_at",
            "updated_at",
            "diagnostics",
            "assignee_name",
            "assignee_user_id",
            "status",
            "priority",
            "kind",
            "number",
        ):
            batch.drop_column(column)
