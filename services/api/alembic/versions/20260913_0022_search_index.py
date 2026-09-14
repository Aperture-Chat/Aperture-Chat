"""Relational search index inside the application database.

``search_index_entries`` holds derived, owner/tenant-tagged plain text for
chats, drafts, agents, automations, matters, and review grids so global
search narrows candidates in SQL instead of loading every record in Python.
It is never an authority: every candidate is re-verified against the live
record with the same policy functions before it is returned.

``search_index_state`` tracks per-tenant backfill progress and the text-match
mode in use. This revision ships the portable LIKE mode; dialect-specific
full-text acceleration (SQLite FTS5 shadow tables, Postgres tsvector) is left
for a follow-up so the schema stays identical across both dialects.

Revision ID: 20260913_0022
Revises: 20260913_0021
Create Date: 2026-09-13
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260913_0022"
down_revision: str | None = "20260913_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "search_index_entries",
        sa.Column("id", sa.String(length=300), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("resource_id", sa.String(length=255), nullable=False),
        sa.Column("owner_user_id", sa.String(length=255), nullable=True),
        sa.Column("visibility", sa.String(length=16), nullable=False),
        sa.Column("acl_group_ids", sa.JSON(), nullable=True),
        sa.Column("matter_id", sa.String(length=255), nullable=True),
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.Column("source_updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("index_version", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "kind IN ('chat', 'draft', 'agent', 'automation', 'matter', 'review', 'knowledge')",
            name=op.f("ck_search_index_entries_kind_valid"),
        ),
        sa.CheckConstraint(
            "visibility IN ('owner', 'tenant', 'groups', 'private', 'matter')",
            name=op.f("ck_search_index_entries_visibility_valid"),
        ),
        # No tenant foreign key, matching draft_documents/chat_threads: tenant
        # retirement removes index rows through the identity-cleanup stage.
        sa.PrimaryKeyConstraint("id", name=op.f("pk_search_index_entries")),
    )
    op.create_index(
        "ix_search_index_entries_tenant_kind_owner",
        "search_index_entries",
        ["tenant_id", "kind", "owner_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_search_index_entries_tenant_kind_updated",
        "search_index_entries",
        ["tenant_id", "kind", "source_updated_at"],
        unique=False,
    )
    op.create_table(
        "search_index_state",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("backfill_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("backfill_completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("fts_mode", sa.String(length=8), nullable=False, server_default="like"),
        sa.Column("entry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.CheckConstraint(
            "fts_mode IN ('fts5', 'tsv', 'like')",
            name=op.f("ck_search_index_state_fts_mode_valid"),
        ),
        sa.PrimaryKeyConstraint("tenant_id", name=op.f("pk_search_index_state")),
    )


def downgrade() -> None:
    op.drop_table("search_index_state")
    op.drop_index("ix_search_index_entries_tenant_kind_updated", table_name="search_index_entries")
    op.drop_index("ix_search_index_entries_tenant_kind_owner", table_name="search_index_entries")
    op.drop_table("search_index_entries")
