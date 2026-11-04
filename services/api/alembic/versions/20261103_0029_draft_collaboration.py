"""Let a draft's owner share it, and let collaborators edit one live copy.

Adds ``draft_shares`` (the people and groups an owner shared a draft with),
``draft_live_states`` (one shared working copy per draft that every editor
autosaves into with compare-and-set on ``seq``), and
``draft_revision_authors`` so the version history says who saved each
version. Every new row hangs off its draft or revision with ``ON DELETE
CASCADE``, so deleting a draft removes its shares, live copy and authorship.

Nothing existing is rewritten: a version with no author row was saved by the
owner, and a draft has no live copy until someone edits it live.

Revision ID: 20261103_0029
Revises: 20261029_0028
Create Date: 2026-11-03
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20261103_0029"
down_revision: str | None = "20261029_0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_DRAFT_FK_COLUMNS = ["draft_id", "tenant_id", "owner_user_id"]
_DRAFT_FK_TARGETS = [
    "draft_documents.id",
    "draft_documents.tenant_id",
    "draft_documents.owner_user_id",
]


def upgrade() -> None:
    op.create_table(
        "draft_revision_authors",
        sa.Column("draft_id", sa.String(length=255), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("author_user_id", sa.String(length=255), nullable=True),
        sa.ForeignKeyConstraint(
            ["draft_id", "revision"],
            ["draft_revisions.draft_id", "draft_revisions.revision"],
            name="fk_draft_revision_authors_draft_revision",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("draft_id", "revision", name=op.f("pk_draft_revision_authors")),
    )

    op.create_table(
        "draft_shares",
        sa.Column("draft_id", sa.String(length=255), nullable=False),
        sa.Column("principal_kind", sa.String(length=8), nullable=False),
        sa.Column("principal_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("owner_user_id", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_user_id", sa.String(length=255), nullable=False),
        sa.CheckConstraint(
            "principal_kind IN ('group', 'user')",
            name=op.f("ck_draft_shares_principal_kind_valid"),
        ),
        sa.ForeignKeyConstraint(
            _DRAFT_FK_COLUMNS,
            _DRAFT_FK_TARGETS,
            name="fk_draft_shares_draft_tenant_owner_documents",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "draft_id", "principal_kind", "principal_id", name=op.f("pk_draft_shares")
        ),
    )
    op.create_index(
        "ix_draft_shares_tenant_principal",
        "draft_shares",
        ["tenant_id", "principal_kind", "principal_id"],
    )

    op.create_table(
        "draft_live_states",
        sa.Column("draft_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("owner_user_id", sa.String(length=255), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("base_revision", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("sanitizer_version", sa.String(length=32), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by_user_id", sa.String(length=255), nullable=True),
        sa.Column("updated_by_client", sa.String(length=64), nullable=True),
        sa.CheckConstraint("seq >= 1", name=op.f("ck_draft_live_states_seq_positive")),
        sa.CheckConstraint(
            "base_revision >= 1 AND base_revision <= 200",
            name=op.f("ck_draft_live_states_base_revision_bounded"),
        ),
        sa.CheckConstraint(
            "length(trim(title)) >= 1 AND length(title) <= 240",
            name=op.f("ck_draft_live_states_title_bounded"),
        ),
        sa.CheckConstraint(
            "octet_length(content) <= 8000000",
            name=op.f("ck_draft_live_states_content_utf8_bytes_ceiling"),
        ),
        sa.CheckConstraint(
            "length(content_sha256) = 64",
            name=op.f("ck_draft_live_states_content_sha256_length"),
        ),
        sa.CheckConstraint(
            "sanitizer_version IN ('sanitized-html-v1', 'deck-json-v1', 'sheet-json-v1')",
            name=op.f("ck_draft_live_states_sanitizer_version_known"),
        ),
        sa.ForeignKeyConstraint(
            _DRAFT_FK_COLUMNS,
            _DRAFT_FK_TARGETS,
            name="fk_draft_live_states_draft_tenant_owner_documents",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("draft_id", name=op.f("pk_draft_live_states")),
    )


def downgrade() -> None:
    op.drop_table("draft_live_states")
    op.drop_index("ix_draft_shares_tenant_principal", table_name="draft_shares")
    op.drop_table("draft_shares")
    op.drop_table("draft_revision_authors")
