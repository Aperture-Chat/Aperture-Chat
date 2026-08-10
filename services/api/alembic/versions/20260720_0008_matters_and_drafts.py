"""Add explicit matter membership and private revisioned drafts.

Revision ID: 20260720_0008
Revises: 20260720_0007
Create Date: 2026-07-20
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0008"
down_revision: str | None = "20260720_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "matters",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        # Metadata only until A7 retention enforcement. NULL is intentionally
        # distinct from a configured positive policy.
        sa.Column("retention_days", sa.Integer(), nullable=True),
        sa.Column("created_by_user_id", sa.String(length=255), nullable=False),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(trim(name)) >= 1 AND length(name) <= 200",
            name=op.f("ck_matters_name_bounded"),
        ),
        sa.CheckConstraint(
            "retention_days IS NULL OR (retention_days >= 1 AND retention_days <= 36500)",
            name=op.f("ck_matters_retention_days_bounded"),
        ),
        sa.CheckConstraint(
            "version >= 1 AND version <= 9223372036854775807",
            name=op.f("ck_matters_version_signed_bigint"),
        ),
        sa.CheckConstraint(
            "updated_at >= created_at",
            name=op.f("ck_matters_updated_after_creation"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_matters")),
        sa.UniqueConstraint(
            "id",
            "tenant_id",
            name=op.f("uq_matters_id_tenant"),
        ),
    )
    op.create_index(
        "ix_matters_tenant_updated_id",
        "matters",
        ["tenant_id", "updated_at", "id"],
        unique=False,
    )

    op.create_table(
        "matter_memberships",
        sa.Column("matter_id", sa.String(length=255), nullable=False),
        sa.Column("member_user_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("added_by_user_id", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["matter_id", "tenant_id"],
            ["matters.id", "matters.tenant_id"],
            name=op.f("fk_matter_memberships_matter_tenant_matters"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "matter_id",
            "member_user_id",
            name=op.f("pk_matter_memberships"),
        ),
    )
    op.create_index(
        "ix_matter_memberships_tenant_member_matter",
        "matter_memberships",
        ["tenant_id", "member_user_id", "matter_id"],
        unique=False,
    )

    # This tombstone deliberately has no FK to matters: it must survive the
    # final container deletion so restart/retry can observe completion. It
    # contains only cleanup metadata and never work-product text or payloads.
    op.create_table(
        "matter_deletion_jobs",
        sa.Column("matter_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("requested_by_user_id", sa.String(length=255), nullable=False),
        sa.Column("requested_matter_version", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("attempt_count", sa.BigInteger(), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "application_refs_cleared_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("review_refs_cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "knowledge_refs_cleared_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("legacy_refs_cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_stage", sa.String(length=32), nullable=True),
        sa.CheckConstraint(
            "requested_matter_version >= 1 AND requested_matter_version <= 9223372036854775807",
            name=op.f("ck_matter_deletion_jobs_requested_version_signed_bigint"),
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 9223372036854775807",
            name=op.f("ck_matter_deletion_jobs_attempt_count_signed_bigint"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'failed', 'ready', 'complete')",
            name=op.f("ck_matter_deletion_jobs_status_valid"),
        ),
        sa.CheckConstraint(
            "updated_at >= requested_at",
            name=op.f("ck_matter_deletion_jobs_updated_after_request"),
        ),
        sa.CheckConstraint(
            "(attempt_count = 0 AND last_attempt_at IS NULL) OR "
            "(attempt_count >= 1 AND last_attempt_at IS NOT NULL)",
            name=op.f("ck_matter_deletion_jobs_attempt_clock_consistent"),
        ),
        sa.CheckConstraint(
            "last_attempt_at IS NULL OR last_attempt_at >= requested_at",
            name=op.f("ck_matter_deletion_jobs_attempt_after_request"),
        ),
        sa.CheckConstraint(
            "(status = 'running' AND lease_expires_at IS NOT NULL) OR "
            "(status != 'running' AND lease_expires_at IS NULL)",
            name=op.f("ck_matter_deletion_jobs_lease_status_consistent"),
        ),
        sa.CheckConstraint(
            "lease_expires_at IS NULL OR lease_expires_at > last_attempt_at",
            name=op.f("ck_matter_deletion_jobs_lease_after_attempt"),
        ),
        sa.CheckConstraint(
            "last_error_stage IS NULL OR "
            "last_error_stage IN ('application', 'review', 'knowledge', 'legacy')",
            name=op.f("ck_matter_deletion_jobs_error_stage_valid"),
        ),
        sa.CheckConstraint(
            "(status = 'failed' AND last_error_stage IS NOT NULL) OR "
            "(status != 'failed' AND last_error_stage IS NULL)",
            name=op.f("ck_matter_deletion_jobs_failure_stage_consistent"),
        ),
        sa.CheckConstraint(
            "status NOT IN ('ready', 'complete') OR "
            "(application_refs_cleared_at IS NOT NULL "
            "AND review_refs_cleared_at IS NOT NULL "
            "AND knowledge_refs_cleared_at IS NOT NULL "
            "AND legacy_refs_cleared_at IS NOT NULL)",
            name=op.f("ck_matter_deletion_jobs_ready_stages_complete"),
        ),
        sa.CheckConstraint(
            "(status = 'complete' AND completed_at IS NOT NULL) OR "
            "(status != 'complete' AND completed_at IS NULL)",
            name=op.f("ck_matter_deletion_jobs_completion_status_consistent"),
        ),
        sa.CheckConstraint(
            "(application_refs_cleared_at IS NULL "
            "OR application_refs_cleared_at >= requested_at) "
            "AND (review_refs_cleared_at IS NULL "
            "OR review_refs_cleared_at >= requested_at) "
            "AND (knowledge_refs_cleared_at IS NULL "
            "OR knowledge_refs_cleared_at >= requested_at) "
            "AND (legacy_refs_cleared_at IS NULL "
            "OR legacy_refs_cleared_at >= requested_at)",
            name=op.f("ck_matter_deletion_jobs_stage_clocks_after_request"),
        ),
        sa.CheckConstraint(
            "completed_at IS NULL OR completed_at >= requested_at",
            name=op.f("ck_matter_deletion_jobs_completed_after_request"),
        ),
        sa.PrimaryKeyConstraint("matter_id", name=op.f("pk_matter_deletion_jobs")),
    )
    op.create_index(
        "ix_matter_deletion_jobs_tenant_status_updated",
        "matter_deletion_jobs",
        ["tenant_id", "status", "updated_at"],
        unique=False,
    )
    op.create_index(
        "ix_matter_deletion_jobs_status_lease",
        "matter_deletion_jobs",
        ["status", "lease_expires_at"],
        unique=False,
    )

    op.create_table(
        "draft_documents",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("owner_user_id", sa.String(length=255), nullable=False),
        sa.Column("matter_id", sa.String(length=255), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("current_revision", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(trim(title)) >= 1 AND length(title) <= 240",
            name=op.f("ck_draft_documents_title_bounded"),
        ),
        sa.CheckConstraint(
            "current_revision >= 1 AND current_revision <= 200",
            name=op.f("ck_draft_documents_current_revision_bounded"),
        ),
        sa.CheckConstraint(
            "updated_at >= created_at",
            name=op.f("ck_draft_documents_updated_after_creation"),
        ),
        sa.ForeignKeyConstraint(
            ["matter_id"],
            ["matters.id"],
            name=op.f("fk_draft_documents_matter_id_matters"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_draft_documents")),
        sa.UniqueConstraint(
            "id",
            "tenant_id",
            "owner_user_id",
            name=op.f("uq_draft_documents_id_tenant_owner"),
        ),
    )
    op.create_index(
        "ix_draft_documents_tenant_owner_updated",
        "draft_documents",
        ["tenant_id", "owner_user_id", "updated_at"],
        unique=False,
    )
    op.create_index(
        "ix_draft_documents_tenant_matter_owner_updated",
        "draft_documents",
        ["tenant_id", "matter_id", "owner_user_id", "updated_at"],
        unique=False,
    )

    op.create_table(
        "draft_revisions",
        sa.Column("draft_id", sa.String(length=255), nullable=False),
        sa.Column("revision", sa.BigInteger(), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("owner_user_id", sa.String(length=255), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("sanitizer_version", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "revision >= 1 AND revision <= 200",
            name=op.f("ck_draft_revisions_revision_bounded"),
        ),
        sa.CheckConstraint(
            "length(trim(title)) >= 1 AND length(title) <= 240",
            name=op.f("ck_draft_revisions_title_bounded"),
        ),
        sa.CheckConstraint(
            "octet_length(content) <= 2000000",
            name=op.f("ck_draft_revisions_content_utf8_bytes_bounded"),
        ),
        sa.CheckConstraint(
            "length(content_sha256) = 64",
            name=op.f("ck_draft_revisions_content_sha256_length"),
        ),
        sa.CheckConstraint(
            "sanitizer_version = 'sanitized-html-v1'",
            name=op.f("ck_draft_revisions_sanitizer_version_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["draft_id", "tenant_id", "owner_user_id"],
            [
                "draft_documents.id",
                "draft_documents.tenant_id",
                "draft_documents.owner_user_id",
            ],
            name=op.f("fk_draft_revisions_draft_tenant_owner_documents"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "draft_id",
            "revision",
            name=op.f("pk_draft_revisions"),
        ),
    )
    op.create_index(
        "ix_draft_revisions_tenant_owner_draft_revision",
        "draft_revisions",
        ["tenant_id", "owner_user_id", "draft_id", "revision"],
        unique=False,
    )

    if op.get_context().dialect.name == "sqlite":
        _snapshot_sqlite_chat_sequences()
    _add_matter_reference(
        "chat_threads",
        constraint_name="fk_chat_threads_matter_id_matters",
    )
    op.create_index(
        "ix_chat_threads_tenant_matter_owner_sequence",
        "chat_threads",
        ["tenant_id", "matter_id", "owner_user_id", "sequence"],
        unique=False,
    )
    _add_matter_reference(
        "chat_folders",
        constraint_name="fk_chat_folders_matter_id_matters",
    )
    op.create_index(
        "ix_chat_folders_tenant_matter_owner_sequence",
        "chat_folders",
        ["tenant_id", "matter_id", "owner_user_id", "sequence"],
        unique=False,
    )
    if op.get_context().dialect.name == "sqlite":
        _restore_sqlite_chat_sequences()


def downgrade() -> None:
    if op.get_context().dialect.name == "sqlite":
        _snapshot_sqlite_chat_sequences()
    op.drop_index(
        "ix_chat_folders_tenant_matter_owner_sequence",
        table_name="chat_folders",
    )
    _drop_matter_reference(
        "chat_folders",
        constraint_name="fk_chat_folders_matter_id_matters",
    )
    op.drop_index(
        "ix_chat_threads_tenant_matter_owner_sequence",
        table_name="chat_threads",
    )
    _drop_matter_reference(
        "chat_threads",
        constraint_name="fk_chat_threads_matter_id_matters",
    )
    if op.get_context().dialect.name == "sqlite":
        _restore_sqlite_chat_sequences()

    op.drop_index(
        "ix_draft_revisions_tenant_owner_draft_revision",
        table_name="draft_revisions",
    )
    op.drop_table("draft_revisions")
    op.drop_index(
        "ix_draft_documents_tenant_matter_owner_updated",
        table_name="draft_documents",
    )
    op.drop_index(
        "ix_draft_documents_tenant_owner_updated",
        table_name="draft_documents",
    )
    op.drop_table("draft_documents")
    op.drop_index(
        "ix_matter_deletion_jobs_status_lease",
        table_name="matter_deletion_jobs",
    )
    op.drop_index(
        "ix_matter_deletion_jobs_tenant_status_updated",
        table_name="matter_deletion_jobs",
    )
    op.drop_table("matter_deletion_jobs")
    op.drop_index(
        "ix_matter_memberships_tenant_member_matter",
        table_name="matter_memberships",
    )
    op.drop_table("matter_memberships")
    op.drop_index("ix_matters_tenant_updated_id", table_name="matters")
    op.drop_table("matters")


def _add_matter_reference(table_name: str, *, constraint_name: str) -> None:
    dialect = op.get_context().dialect.name
    if dialect == "sqlite":
        # SQLite's ALTER TABLE ADD COLUMN accepts REFERENCES, but its
        # reflection loses the constraint name and ON DELETE option. Recreate
        # from an explicit table definition so migrated metadata is identical
        # to a fresh Postgres schema and to the ORM. copy_from also makes this
        # deterministic in Alembic's offline --sql mode.
        with op.batch_alter_table(
            table_name,
            recreate="always",
            copy_from=_sqlite_chat_table(table_name, include_matter=False),
        ) as batch_op:
            batch_op.add_column(sa.Column("matter_id", sa.String(length=255), nullable=True))
            batch_op.create_foreign_key(
                constraint_name,
                "matters",
                ["matter_id"],
                ["id"],
                ondelete="SET NULL",
            )
        return
    if dialect == "postgresql":
        op.add_column(
            table_name,
            sa.Column("matter_id", sa.String(length=255), nullable=True),
        )
        op.create_foreign_key(
            constraint_name,
            table_name,
            "matters",
            ["matter_id"],
            ["id"],
            ondelete="SET NULL",
        )
        return
    raise RuntimeError(f"Unsupported database dialect for matter migration: {dialect}")


def _drop_matter_reference(table_name: str, *, constraint_name: str) -> None:
    dialect = op.get_context().dialect.name
    if dialect == "sqlite":
        with op.batch_alter_table(
            table_name,
            recreate="always",
            copy_from=_sqlite_chat_table(table_name, include_matter=True),
        ) as batch_op:
            batch_op.drop_constraint(constraint_name, type_="foreignkey")
            batch_op.drop_column("matter_id")
        return
    if dialect == "postgresql":
        op.drop_constraint(constraint_name, table_name, type_="foreignkey")
        op.drop_column(table_name, "matter_id")
        return
    raise RuntimeError(f"Unsupported database dialect for matter migration: {dialect}")


def _sqlite_chat_table(table_name: str, *, include_matter: bool) -> sa.Table:
    """Return the exact 0007/0008 chat table shape for offline batch DDL."""
    metadata = sa.MetaData()
    if include_matter:
        sa.Table(
            "matters",
            metadata,
            sa.Column("id", sa.String(length=255), primary_key=True),
        )

    if table_name == "chat_threads":
        columns: list[sa.SchemaItem] = [
            sa.Column(
                "sequence",
                sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
                autoincrement=True,
                nullable=False,
            ),
            sa.Column("id", sa.String(length=255), nullable=False),
            sa.Column("tenant_id", sa.String(length=255), nullable=False),
            sa.Column("owner_user_id", sa.String(length=255), nullable=False),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column("model_id", sa.Text(), nullable=False),
            sa.Column("group_id", sa.String(length=255), nullable=False),
            sa.Column("pinned", sa.Boolean(), nullable=False),
            sa.Column("archived", sa.Boolean(), nullable=False),
            sa.Column("folder_id", sa.String(length=255), nullable=True),
        ]
        if include_matter:
            columns.append(sa.Column("matter_id", sa.String(length=255), nullable=True))
        columns.extend(
            [
                sa.Column("used_agent", sa.Boolean(), nullable=False),
                sa.Column("updated_at", sa.Text(), nullable=False),
                sa.Column("messages", sa.JSON(), nullable=False),
                sa.PrimaryKeyConstraint("sequence", name="pk_chat_threads"),
                sa.UniqueConstraint("id", name="uq_chat_threads_id"),
            ]
        )
        if include_matter:
            columns.append(
                sa.ForeignKeyConstraint(
                    ["matter_id"],
                    ["matters.id"],
                    name="fk_chat_threads_matter_id_matters",
                    ondelete="SET NULL",
                )
            )
        table = sa.Table(
            table_name,
            metadata,
            *columns,
            sqlite_autoincrement=True,
        )
        sa.Index(
            "ix_chat_threads_owner_sequence",
            table.c.owner_user_id,
            table.c.sequence,
        )
        sa.Index(
            "ix_chat_threads_tenant_owner_archived_sequence",
            table.c.tenant_id,
            table.c.owner_user_id,
            table.c.archived,
            table.c.sequence,
        )
        sa.Index(
            "ix_chat_threads_tenant_owner_folder_sequence",
            table.c.tenant_id,
            table.c.owner_user_id,
            table.c.folder_id,
            table.c.sequence,
        )
        sa.Index(
            "ix_chat_threads_tenant_owner_sequence",
            table.c.tenant_id,
            table.c.owner_user_id,
            table.c.sequence,
        )
        return table

    if table_name == "chat_folders":
        columns = [
            sa.Column(
                "sequence",
                sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
                autoincrement=True,
                nullable=False,
            ),
            sa.Column("id", sa.String(length=255), nullable=False),
            sa.Column("tenant_id", sa.String(length=255), nullable=False),
            sa.Column("owner_user_id", sa.String(length=255), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
        ]
        if include_matter:
            columns.append(sa.Column("matter_id", sa.String(length=255), nullable=True))
        columns.extend(
            [
                sa.Column("created_at", sa.Text(), nullable=False),
                sa.PrimaryKeyConstraint("sequence", name="pk_chat_folders"),
                sa.UniqueConstraint("id", name="uq_chat_folders_id"),
            ]
        )
        if include_matter:
            columns.append(
                sa.ForeignKeyConstraint(
                    ["matter_id"],
                    ["matters.id"],
                    name="fk_chat_folders_matter_id_matters",
                    ondelete="SET NULL",
                )
            )
        table = sa.Table(
            table_name,
            metadata,
            *columns,
            sqlite_autoincrement=True,
        )
        sa.Index(
            "ix_chat_folders_owner_sequence",
            table.c.owner_user_id,
            table.c.sequence,
        )
        sa.Index(
            "ix_chat_folders_tenant_owner_sequence",
            table.c.tenant_id,
            table.c.owner_user_id,
            table.c.sequence,
        )
        return table

    raise RuntimeError(f"Unsupported SQLite chat table: {table_name}")


def _snapshot_sqlite_chat_sequences() -> None:
    # A batch rebuild derives AUTOINCREMENT from surviving rows. Preserve a
    # larger historic high-water mark so deleted IDs can never be reused.
    op.execute(
        sa.text(
            "CREATE TEMPORARY TABLE _m9_chat_sequence_hwm "
            "(name TEXT PRIMARY KEY, seq INTEGER NOT NULL)"
        )
    )
    op.execute(
        sa.text(
            "INSERT INTO _m9_chat_sequence_hwm (name, seq) "
            "SELECT name, seq FROM sqlite_sequence "
            "WHERE name IN ('chat_threads', 'chat_folders')"
        )
    )


def _restore_sqlite_chat_sequences() -> None:
    op.execute(
        sa.text(
            "UPDATE sqlite_sequence SET seq = ("
            "SELECT MAX(sqlite_sequence.seq, saved.seq) "
            "FROM _m9_chat_sequence_hwm AS saved "
            "WHERE saved.name = sqlite_sequence.name"
            ") WHERE name IN (SELECT name FROM _m9_chat_sequence_hwm)"
        )
    )
    op.execute(
        sa.text(
            "INSERT INTO sqlite_sequence (name, seq) "
            "SELECT saved.name, saved.seq FROM _m9_chat_sequence_hwm AS saved "
            "WHERE NOT EXISTS ("
            "SELECT 1 FROM sqlite_sequence AS current "
            "WHERE current.name = saved.name"
            ")"
        )
    )
    op.execute(sa.text("DROP TABLE _m9_chat_sequence_hwm"))
