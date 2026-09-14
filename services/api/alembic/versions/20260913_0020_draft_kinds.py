"""Store slide decks server-side alongside documents.

Adds ``draft_documents.kind`` (``document`` | ``deck``) and widens the revision
constraints so a deck revision can carry canonical deck JSON under the
``deck-json-v1`` sanitizer id with the 8,000,000-byte deck ceiling. The
2,000,000-byte HTML bound stays enforced in Python for documents; the database
CHECK is the outer ceiling for both kinds.

Downgrade refuses while any deck rows exist because they would violate the
restored constraints; roll forward instead.

Revision ID: 20260913_0020
Revises: 20260905_0019
Create Date: 2026-09-13
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260913_0020"
down_revision: str | None = "20260905_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Recreating this parent table on SQLite cascades deletion of revisions.
    # An inline column CHECK allows a direct, non-destructive ADD COLUMN.
    if op.get_bind().dialect.name == "sqlite":
        op.add_column("draft_documents", sa.Column(
            "kind", sa.String(length=16),
            sa.CheckConstraint("kind IN ('document', 'deck')", name=op.f("ck_draft_documents_kind_valid")),
            nullable=False, server_default="document",
        ))
    else:
        with op.batch_alter_table("draft_documents") as batch:
            batch.add_column(sa.Column("kind", sa.String(length=16), nullable=False, server_default="document"))
            batch.create_check_constraint(op.f("ck_draft_documents_kind_valid"), "kind IN ('document', 'deck')")
    op.create_index(
        "ix_draft_documents_tenant_owner_kind_updated",
        "draft_documents",
        ["tenant_id", "owner_user_id", "kind", "updated_at"],
        unique=False,
    )

    with op.batch_alter_table("draft_revisions") as batch:
        batch.drop_constraint(op.f("ck_draft_revisions_sanitizer_version_valid"), type_="check")
        batch.drop_constraint(op.f("ck_draft_revisions_content_utf8_bytes_bounded"), type_="check")
        batch.create_check_constraint(
            op.f("ck_draft_revisions_sanitizer_version_known"),
            "sanitizer_version IN ('sanitized-html-v1', 'deck-json-v1')",
        )
        batch.create_check_constraint(
            op.f("ck_draft_revisions_content_utf8_bytes_ceiling"),
            "octet_length(content) <= 8000000",
        )


def downgrade() -> None:
    bind = op.get_bind()
    deck_rows = bind.execute(
        sa.text("SELECT count(*) FROM draft_documents WHERE kind = 'deck'")
    ).scalar_one()
    if deck_rows:
        raise RuntimeError(
            f"Cannot downgrade: {deck_rows} deck draft(s) would violate the restored "
            "document-only constraints. Roll forward instead."
        )

    with op.batch_alter_table("draft_revisions") as batch:
        batch.drop_constraint(op.f("ck_draft_revisions_sanitizer_version_known"), type_="check")
        batch.drop_constraint(op.f("ck_draft_revisions_content_utf8_bytes_ceiling"), type_="check")
        batch.create_check_constraint(
            op.f("ck_draft_revisions_sanitizer_version_valid"),
            "sanitizer_version = 'sanitized-html-v1'",
        )
        batch.create_check_constraint(
            op.f("ck_draft_revisions_content_utf8_bytes_bounded"),
            "octet_length(content) <= 2000000",
        )

    op.drop_index("ix_draft_documents_tenant_owner_kind_updated", table_name="draft_documents")
    if bind.dialect.name == "sqlite":
        op.drop_column("draft_documents", "kind")
    else:
        with op.batch_alter_table("draft_documents") as batch:
            batch.drop_constraint(op.f("ck_draft_documents_kind_valid"), type_="check")
            batch.drop_column("kind")
