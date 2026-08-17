"""Chat retention foundations: real thread clocks, tags, holds, and policy.

Chat threads gain authoritative UTC ``created_at``/``last_activity_at``
columns backfilled from the message ISO clocks (``createdAtIso``); the public
``updated_at`` display label is untouched. Threads with no parseable message
clock honestly receive the migration timestamp rather than an invented age.
Attachments gain a server-derived ``thread_id`` backfilled by walking each
thread's messages, so purges can find a thread's attachments with SQL.

New tables: ``chat_thread_tags`` (retention/classification tags, outside the
client-authored thread payload), ``retention_holds`` +
``retention_hold_threads`` (legal holds with materialized membership), and
the ``tenant_retention_policies`` identity/config payload collection.
``thread_id`` columns are deliberately not foreign keys: the workspace upsert
re-inserts thread rows in place, and a cascading constraint would drop tags
and hold membership on every save.

Revision ID: 20260816_0016
Revises: 20260807_0015
Create Date: 2026-08-16
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op


revision: str = "20260816_0016"
down_revision: str | None = "20260807_0015"
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


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _backfill_thread_clocks_and_attachment_links() -> None:
    # Offline --sql rendering covers schema only; the data backfill reads the
    # messages documents and therefore needs a live connection.
    if op.get_context().as_sql:
        return
    bind = op.get_bind()
    threads = sa.table(
        "chat_threads",
        sa.column("sequence", sa.BigInteger()),
        sa.column("id", sa.String()),
        sa.column("messages", sa.JSON()),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("last_activity_at", sa.DateTime(timezone=True)),
    )
    attachments = sa.table(
        "chat_attachments",
        sa.column("id", sa.String()),
        sa.column("thread_id", sa.String()),
    )
    fallback = datetime.now(UTC)
    rows = bind.execute(
        sa.select(threads.c.sequence, threads.c.id, threads.c.messages)
    ).all()
    for sequence, thread_id, messages in rows:
        if isinstance(messages, str):
            messages = json.loads(messages)
        if not isinstance(messages, list):
            messages = []
        clocks = sorted(
            clock
            for clock in (
                _parse_iso(message.get("createdAtIso"))
                for message in messages
                if isinstance(message, dict)
            )
            if clock is not None
        )
        bind.execute(
            threads.update()
            .where(threads.c.sequence == sequence)
            .values(
                created_at=clocks[0] if clocks else fallback,
                last_activity_at=clocks[-1] if clocks else fallback,
            )
        )
        attachment_ids = sorted(
            {
                attachment["id"]
                for message in messages
                if isinstance(message, dict)
                for attachment in message.get("attachments") or []
                if isinstance(attachment, dict) and attachment.get("id")
            }
        )
        if attachment_ids:
            bind.execute(
                attachments.update()
                .where(attachments.c.id.in_(attachment_ids))
                .values(thread_id=thread_id)
            )


def upgrade() -> None:
    op.add_column(
        "chat_threads",
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "chat_threads",
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "chat_threads",
        sa.Column("disposition_state", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "chat_threads",
        sa.Column("disposition_pending_since", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_chat_threads_tenant_last_activity",
        "chat_threads",
        ["tenant_id", "last_activity_at"],
        unique=False,
    )

    op.add_column(
        "chat_attachments",
        sa.Column("thread_id", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "ix_chat_attachments_thread_id",
        "chat_attachments",
        ["thread_id"],
        unique=False,
    )

    op.create_table(
        "chat_thread_tags",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("thread_id", sa.String(length=255), nullable=False),
        sa.Column("namespace", sa.String(length=100), nullable=False),
        sa.Column("key", sa.String(length=255), nullable=False),
        sa.Column("value", sa.Text(), nullable=True),
        sa.Column("source", sa.String(length=100), nullable=False),
        sa.Column("applied_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("applied_by", sa.String(length=255), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_thread_tags")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_chat_thread_tags_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint(
            "thread_id",
            "namespace",
            "key",
            name="uq_chat_thread_tags_thread_namespace_key",
        ),
    )
    op.create_index(
        "ix_chat_thread_tags_tenant_namespace_key",
        "chat_thread_tags",
        ["tenant_id", "namespace", "key"],
        unique=False,
    )
    op.create_index(
        "ix_chat_thread_tags_thread",
        "chat_thread_tags",
        ["thread_id"],
        unique=False,
    )

    op.create_table(
        "retention_holds",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("released_by", sa.String(length=255), nullable=True),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_retention_holds")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_retention_holds_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_retention_holds_tenant",
        "retention_holds",
        ["tenant_id"],
        unique=False,
    )

    op.create_table(
        "retention_hold_threads",
        sa.Column("hold_id", sa.String(length=255), nullable=False),
        sa.Column("thread_id", sa.String(length=255), nullable=False),
        sa.PrimaryKeyConstraint("hold_id", "thread_id", name=op.f("pk_retention_hold_threads")),
        sa.ForeignKeyConstraint(
            ["hold_id"],
            ["retention_holds.id"],
            name=op.f("fk_retention_hold_threads_hold_id_retention_holds"),
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_retention_hold_threads_thread",
        "retention_hold_threads",
        ["thread_id"],
        unique=False,
    )

    _ordered_payload_table(
        "tenant_retention_policies",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        constraints=(
            sa.ForeignKeyConstraint(
                ["tenant_id"],
                ["tenants.id"],
                name=op.f("fk_tenant_retention_policies_tenant_id_tenants"),
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint(
                "tenant_id",
                name=op.f("uq_tenant_retention_policies_tenant"),
            ),
        ),
    )

    _backfill_thread_clocks_and_attachment_links()


def downgrade() -> None:
    op.drop_table("tenant_retention_policies")
    op.drop_index("ix_retention_hold_threads_thread", table_name="retention_hold_threads")
    op.drop_table("retention_hold_threads")
    op.drop_index("ix_retention_holds_tenant", table_name="retention_holds")
    op.drop_table("retention_holds")
    op.drop_index("ix_chat_thread_tags_thread", table_name="chat_thread_tags")
    op.drop_index("ix_chat_thread_tags_tenant_namespace_key", table_name="chat_thread_tags")
    op.drop_table("chat_thread_tags")
    op.drop_index("ix_chat_attachments_thread_id", table_name="chat_attachments")
    op.drop_column("chat_attachments", "thread_id")
    op.drop_index("ix_chat_threads_tenant_last_activity", table_name="chat_threads")
    op.drop_column("chat_threads", "disposition_pending_since")
    op.drop_column("chat_threads", "disposition_state")
    op.drop_column("chat_threads", "last_activity_at")
    op.drop_column("chat_threads", "created_at")
