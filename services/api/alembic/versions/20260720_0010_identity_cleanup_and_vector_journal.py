"""Add restart-safe identity cleanup and temporary vector cutover state.

Revision ID: 20260720_0010
Revises: 20260720_0009
Create Date: 2026-07-20

Cleanup rows contain bounded coordination metadata only and deliberately have
no foreign keys to the resources they outlive. The temporary cutover journal
contains only the knowledge work product required to finish the vector half of
the v4 -> v5 authority transition and is never a serving store.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0010"
down_revision: str | None = "20260720_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "identity_cleanup_jobs",
        sa.Column("job_id", sa.String(length=255), nullable=False),
        sa.Column("resource_kind", sa.String(length=32), nullable=False),
        sa.Column("resource_id", sa.String(length=255), nullable=False),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("attempt_count", sa.BigInteger(), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("identity_committed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("application_cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "knowledge_vector_cleared_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("m9_cleared_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_stage", sa.String(length=32), nullable=True),
        sa.CheckConstraint(
            "resource_kind IN ('tenant', 'user', 'knowledge_config')",
            name=op.f("ck_identity_cleanup_jobs_resource_kind_valid"),
        ),
        sa.CheckConstraint(
            "length(job_id) >= 1 AND length(resource_id) >= 1 "
            "AND length(tenant_id) >= 1",
            name=op.f("ck_identity_cleanup_jobs_scope_ids_nonempty"),
        ),
        sa.CheckConstraint(
            "resource_kind != 'tenant' OR resource_id = tenant_id",
            name=op.f("ck_identity_cleanup_jobs_tenant_resource_matches_scope"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'failed', 'complete')",
            name=op.f("ck_identity_cleanup_jobs_status_valid"),
        ),
        sa.CheckConstraint(
            "generation >= 1 AND generation <= 9223372036854775807",
            name=op.f("ck_identity_cleanup_jobs_generation_signed_bigint"),
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 9223372036854775807",
            name=op.f("ck_identity_cleanup_jobs_attempt_count_signed_bigint"),
        ),
        sa.CheckConstraint(
            "updated_at >= requested_at",
            name=op.f("ck_identity_cleanup_jobs_updated_after_request"),
        ),
        sa.CheckConstraint(
            "(attempt_count = 0 AND status = 'pending' AND last_attempt_at IS NULL) OR "
            "(attempt_count >= 1 AND status != 'pending' AND last_attempt_at IS NOT NULL)",
            name=op.f("ck_identity_cleanup_jobs_attempt_clock_consistent"),
        ),
        sa.CheckConstraint(
            "last_attempt_at IS NULL OR "
            "(last_attempt_at >= requested_at AND last_attempt_at <= updated_at)",
            name=op.f("ck_identity_cleanup_jobs_attempt_clock_bounded"),
        ),
        sa.CheckConstraint(
            "(status = 'running' AND lease_expires_at IS NOT NULL) OR "
            "(status != 'running' AND lease_expires_at IS NULL)",
            name=op.f("ck_identity_cleanup_jobs_lease_status_consistent"),
        ),
        sa.CheckConstraint(
            "lease_expires_at IS NULL OR lease_expires_at > last_attempt_at",
            name=op.f("ck_identity_cleanup_jobs_lease_after_attempt"),
        ),
        sa.CheckConstraint(
            "status != 'running' OR lease_expires_at > updated_at",
            name=op.f("ck_identity_cleanup_jobs_active_lease_after_update"),
        ),
        sa.CheckConstraint(
            "last_error_stage IS NULL OR last_error_stage IN "
            "('identity', 'application', 'review', 'knowledge_vector', 'm9')",
            name=op.f("ck_identity_cleanup_jobs_error_stage_valid"),
        ),
        sa.CheckConstraint(
            "(status = 'failed' AND last_error_stage IS NOT NULL) OR "
            "(status != 'failed' AND last_error_stage IS NULL)",
            name=op.f("ck_identity_cleanup_jobs_failure_stage_consistent"),
        ),
        sa.CheckConstraint(
            "status != 'failed' OR "
            "(last_error_stage = 'identity' AND identity_committed_at IS NULL) OR "
            "(last_error_stage = 'application' AND identity_committed_at IS NOT NULL "
            "AND application_cleared_at IS NULL) OR "
            "(last_error_stage = 'review' AND application_cleared_at IS NOT NULL "
            "AND review_cleared_at IS NULL) OR "
            "(last_error_stage = 'knowledge_vector' AND review_cleared_at IS NOT NULL "
            "AND knowledge_vector_cleared_at IS NULL) OR "
            "(last_error_stage = 'm9' AND knowledge_vector_cleared_at IS NOT NULL "
            "AND m9_cleared_at IS NULL)",
            name=op.f("ck_identity_cleanup_jobs_failure_matches_next_stage"),
        ),
        sa.CheckConstraint(
            "(application_cleared_at IS NULL OR identity_committed_at IS NOT NULL) AND "
            "(review_cleared_at IS NULL OR application_cleared_at IS NOT NULL) AND "
            "(knowledge_vector_cleared_at IS NULL OR review_cleared_at IS NOT NULL) AND "
            "(m9_cleared_at IS NULL OR knowledge_vector_cleared_at IS NOT NULL)",
            name=op.f("ck_identity_cleanup_jobs_stage_prefix_ordered"),
        ),
        sa.CheckConstraint(
            "(identity_committed_at IS NULL OR "
            "(identity_committed_at >= requested_at AND identity_committed_at <= updated_at)) "
            "AND (application_cleared_at IS NULL OR "
            "(application_cleared_at >= identity_committed_at "
            "AND application_cleared_at <= updated_at)) "
            "AND (review_cleared_at IS NULL OR "
            "(review_cleared_at >= application_cleared_at "
            "AND review_cleared_at <= updated_at)) "
            "AND (knowledge_vector_cleared_at IS NULL OR "
            "(knowledge_vector_cleared_at >= review_cleared_at "
            "AND knowledge_vector_cleared_at <= updated_at)) "
            "AND (m9_cleared_at IS NULL OR "
            "(m9_cleared_at >= knowledge_vector_cleared_at "
            "AND m9_cleared_at <= updated_at))",
            name=op.f("ck_identity_cleanup_jobs_stage_clocks_ordered"),
        ),
        sa.CheckConstraint(
            "attempt_count != 0 OR "
            "(identity_committed_at IS NULL AND application_cleared_at IS NULL "
            "AND review_cleared_at IS NULL AND knowledge_vector_cleared_at IS NULL "
            "AND m9_cleared_at IS NULL)",
            name=op.f("ck_identity_cleanup_jobs_unclaimed_has_no_stages"),
        ),
        sa.CheckConstraint(
            "(status = 'complete' AND completed_at IS NOT NULL "
            "AND identity_committed_at IS NOT NULL "
            "AND application_cleared_at IS NOT NULL "
            "AND review_cleared_at IS NOT NULL "
            "AND knowledge_vector_cleared_at IS NOT NULL "
            "AND m9_cleared_at IS NOT NULL) OR "
            "(status != 'complete' AND completed_at IS NULL)",
            name=op.f("ck_identity_cleanup_jobs_completion_status_consistent"),
        ),
        sa.CheckConstraint(
            "completed_at IS NULL OR "
            "(completed_at >= m9_cleared_at AND completed_at <= updated_at)",
            name=op.f("ck_identity_cleanup_jobs_completed_clock_ordered"),
        ),
        sa.PrimaryKeyConstraint(
            "job_id",
            name=op.f("pk_identity_cleanup_jobs"),
        ),
        sa.UniqueConstraint(
            "job_id",
            "resource_kind",
            name=op.f("uq_identity_cleanup_jobs_job_kind"),
        ),
        sa.UniqueConstraint(
            "resource_kind",
            "resource_id",
            "generation",
            name=op.f("uq_identity_cleanup_jobs_resource_generation"),
        ),
    )
    op.create_index(
        "ix_identity_cleanup_jobs_tenant_status_updated",
        "identity_cleanup_jobs",
        ["tenant_id", "status", "updated_at", "job_id"],
        unique=False,
    )
    op.create_index(
        "ix_identity_cleanup_jobs_status_lease",
        "identity_cleanup_jobs",
        ["status", "lease_expires_at", "updated_at", "job_id"],
        unique=False,
    )
    op.create_index(
        "uq_identity_cleanup_jobs_active_resource",
        "identity_cleanup_jobs",
        ["resource_kind", "resource_id"],
        unique=True,
        postgresql_where=sa.text("status != 'complete'"),
        sqlite_where=sa.text("status != 'complete'"),
    )

    # Every tenant user is captured even when that user currently has no A5
    # rows. The cutoff is required to recreate the retained session watermark
    # after the identity row itself has been committed away.
    op.create_table(
        "identity_cleanup_job_users",
        sa.Column("job_id", sa.String(length=255), nullable=False),
        sa.Column("resource_kind", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("session_cutoff_ms", sa.BigInteger(), nullable=False),
        sa.CheckConstraint(
            "resource_kind IN ('tenant', 'user')",
            name=op.f("ck_identity_cleanup_job_users_identity_subject_jobs_only"),
        ),
        sa.CheckConstraint(
            "length(user_id) >= 1",
            name=op.f("ck_identity_cleanup_job_users_user_id_nonempty"),
        ),
        sa.CheckConstraint(
            "session_cutoff_ms >= 0 AND session_cutoff_ms <= 9223372036854775807",
            name=op.f("ck_identity_cleanup_job_users_cutoff_signed_bigint"),
        ),
        sa.ForeignKeyConstraint(
            ["job_id", "resource_kind"],
            [
                "identity_cleanup_jobs.job_id",
                "identity_cleanup_jobs.resource_kind",
            ],
            name=op.f(
                "fk_identity_cleanup_job_users_job_kind_identity_cleanup_jobs"
            ),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "job_id",
            "user_id",
            name=op.f("pk_identity_cleanup_job_users"),
        ),
    )

    op.create_table(
        "cutover_vector_source_journal",
        sa.Column("source_digest", sa.String(length=64), nullable=False),
        sa.Column("knowledge_digest", sa.String(length=64), nullable=False),
        sa.Column("journal_digest", sa.String(length=64), nullable=False),
        sa.Column("documents", sa.JSON(), nullable=False),
        sa.Column("chunks", sa.JSON(), nullable=False),
        sa.Column("document_count", sa.BigInteger(), nullable=False),
        sa.Column("chunk_count", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(source_digest) = 64",
            name=op.f("ck_cutover_vector_source_journal_source_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "length(knowledge_digest) = 64",
            name=op.f("ck_cutover_vector_source_journal_knowledge_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "length(journal_digest) = 64",
            name=op.f("ck_cutover_vector_source_journal_journal_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "document_count >= 0 AND document_count <= 9223372036854775807",
            name=op.f("ck_cutover_vector_source_journal_document_count_signed_bigint"),
        ),
        sa.CheckConstraint(
            "chunk_count >= 0 AND chunk_count <= 9223372036854775807",
            name=op.f("ck_cutover_vector_source_journal_chunk_count_signed_bigint"),
        ),
        sa.PrimaryKeyConstraint(
            "source_digest",
            name=op.f("pk_cutover_vector_source_journal"),
        ),
    )

    # A small one-use tombstone prevents a stale pre-cutover process from
    # recreating journal work product after verified consumption.
    op.create_table(
        "cutover_vector_source_consumed",
        sa.Column("source_digest", sa.String(length=64), nullable=False),
        sa.Column("knowledge_digest", sa.String(length=64), nullable=False),
        sa.Column("journal_digest", sa.String(length=64), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "length(source_digest) = 64",
            name=op.f("ck_cutover_vector_source_consumed_source_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "length(knowledge_digest) = 64",
            name=op.f("ck_cutover_vector_source_consumed_knowledge_digest_sha256_length"),
        ),
        sa.CheckConstraint(
            "length(journal_digest) = 64",
            name=op.f("ck_cutover_vector_source_consumed_journal_digest_sha256_length"),
        ),
        sa.PrimaryKeyConstraint(
            "source_digest",
            name=op.f("pk_cutover_vector_source_consumed"),
        ),
    )


def downgrade() -> None:
    op.drop_table("cutover_vector_source_consumed")
    op.drop_table("cutover_vector_source_journal")
    op.drop_table("identity_cleanup_job_users")
    op.drop_index(
        "uq_identity_cleanup_jobs_active_resource",
        table_name="identity_cleanup_jobs",
    )
    op.drop_index(
        "ix_identity_cleanup_jobs_status_lease",
        table_name="identity_cleanup_jobs",
    )
    op.drop_index(
        "ix_identity_cleanup_jobs_tenant_status_updated",
        table_name="identity_cleanup_jobs",
    )
    op.drop_table("identity_cleanup_jobs")
