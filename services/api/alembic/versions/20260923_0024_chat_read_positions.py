"""Server-side chat read positions.

Chat threads gain ``last_read_message_id``: the id of the newest message the
owner has seen. Unread state previously lived only in each browser, so a new
browser could not tell read history from genuinely new replies. Existing
threads are backfilled as read through their current last message, so the
upgrade itself never lights up a whole history; replies that arrive afterward
(for example, from scheduled automations) are unread until opened.

Revision ID: 20260923_0024
Revises: 20260917_0023
Create Date: 2026-09-23
"""

from __future__ import annotations

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260923_0024"
down_revision: str | None = "20260917_0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _backfill_read_positions() -> None:
    # Offline --sql rendering covers schema only; the backfill reads the
    # messages documents and therefore needs a live connection.
    if op.get_context().as_sql:
        return
    bind = op.get_bind()
    threads = sa.table(
        "chat_threads",
        sa.column("sequence", sa.BigInteger()),
        sa.column("messages", sa.JSON()),
        sa.column("last_read_message_id", sa.String()),
    )
    rows = bind.execute(sa.select(threads.c.sequence, threads.c.messages)).all()
    for sequence, messages in rows:
        if isinstance(messages, str):
            messages = json.loads(messages)
        if not isinstance(messages, list) or not messages:
            continue
        last = messages[-1]
        message_id = last.get("id") if isinstance(last, dict) else None
        if not isinstance(message_id, str) or not message_id:
            continue
        bind.execute(
            threads.update()
            .where(threads.c.sequence == sequence)
            .values(last_read_message_id=message_id)
        )


def upgrade() -> None:
    op.add_column(
        "chat_threads",
        sa.Column("last_read_message_id", sa.String(length=255), nullable=True),
    )
    _backfill_read_positions()


def downgrade() -> None:
    op.drop_column("chat_threads", "last_read_message_id")
