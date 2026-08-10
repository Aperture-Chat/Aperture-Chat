"""Add tenant token budgets and idempotent provider-completion accounting.

Revision ID: 20260720_0007
Revises: 20260720_0006
Create Date: 2026-07-20
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0007"
down_revision: str | None = "20260720_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tenant_usage_budgets",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("daily_token_limit", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.String(length=255), nullable=True),
        sa.CheckConstraint(
            "daily_token_limit >= 0",
            name=op.f("ck_tenant_usage_budgets_daily_token_limit_nonnegative"),
        ),
        sa.CheckConstraint(
            "daily_token_limit <= 9223372036854775807",
            name=op.f("ck_tenant_usage_budgets_daily_token_limit_bigint_max"),
        ),
        sa.PrimaryKeyConstraint("tenant_id", name=op.f("pk_tenant_usage_budgets")),
    )

    op.create_table(
        "tenant_daily_usage",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("usage_date", sa.Date(), nullable=False),
        sa.Column("reported_tokens", sa.BigInteger(), nullable=False),
        sa.Column("reported_tokens_overflowed", sa.Boolean(), nullable=False),
        sa.Column("metered_completions", sa.BigInteger(), nullable=False),
        sa.Column("unmetered_completions", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "reported_tokens >= 0",
            name=op.f("ck_tenant_daily_usage_reported_tokens_nonnegative"),
        ),
        sa.CheckConstraint(
            "reported_tokens <= 9223372036854775807",
            name=op.f("ck_tenant_daily_usage_reported_tokens_bigint_max"),
        ),
        sa.CheckConstraint(
            "reported_tokens_overflowed = false OR reported_tokens = 9223372036854775807",
            name=op.f("ck_tenant_daily_usage_reported_overflow_consistent"),
        ),
        sa.CheckConstraint(
            "metered_completions >= 0",
            name=op.f("ck_tenant_daily_usage_metered_completions_nonnegative"),
        ),
        sa.CheckConstraint(
            "metered_completions <= 9223372036854775807",
            name=op.f("ck_tenant_daily_usage_metered_completions_bigint_max"),
        ),
        sa.CheckConstraint(
            "unmetered_completions >= 0",
            name=op.f("ck_tenant_daily_usage_unmetered_completions_nonnegative"),
        ),
        sa.CheckConstraint(
            "unmetered_completions <= 9223372036854775807",
            name=op.f("ck_tenant_daily_usage_unmetered_completions_bigint_max"),
        ),
        sa.PrimaryKeyConstraint(
            "tenant_id",
            "usage_date",
            name=op.f("pk_tenant_daily_usage"),
        ),
    )
    op.create_index(
        "ix_tenant_daily_usage_date_tenant",
        "tenant_daily_usage",
        ["usage_date", "tenant_id"],
        unique=False,
    )

    # The admission ledger intentionally excludes actor, model, provider,
    # surface, thread, and free-text failure details. Those belong only in the
    # retention-governed usage detail table. Internal UUIDv4 request IDs are
    # hashed before persistence and scoped to the tenant.
    op.create_table(
        "tenant_usage_permits",
        sa.Column("permit_id", sa.String(length=64), nullable=False),
        sa.Column("request_id_hash", sa.String(length=64), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("admission_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "length(request_id_hash) = 64",
            name=op.f("ck_tenant_usage_permits_request_id_hash_sha256_length"),
        ),
        sa.CheckConstraint(
            "status IN ('started', 'completed', 'failed', 'abandoned')",
            name=op.f("ck_tenant_usage_permits_status_valid"),
        ),
        sa.CheckConstraint(
            "(status = 'started' AND closed_at IS NULL) OR "
            "(status = 'completed' AND closed_at IS NOT NULL) OR "
            "(status IN ('failed', 'abandoned') AND closed_at IS NOT NULL)",
            name=op.f("ck_tenant_usage_permits_lifecycle_consistent"),
        ),
        sa.CheckConstraint(
            "closed_at IS NULL OR closed_at >= acquired_at",
            name=op.f("ck_tenant_usage_permits_closed_after_acquire"),
        ),
        sa.PrimaryKeyConstraint("permit_id", name=op.f("pk_tenant_usage_permits")),
        sa.UniqueConstraint(
            "tenant_id",
            "request_id_hash",
            name=op.f("uq_tenant_usage_permits_tenant_request_id_hash"),
        ),
    )
    op.create_index(
        "ix_tenant_usage_permits_tenant_admission_status_acquired",
        "tenant_usage_permits",
        ["tenant_id", "admission_date", "status", "acquired_at"],
        unique=False,
    )
    op.create_index(
        "ix_tenant_usage_permits_status_acquired",
        "tenant_usage_permits",
        ["status", "acquired_at"],
        unique=False,
    )

    # A request may make several real provider calls (continuations, validation
    # revisions, or image fan-out). Each successful call receives one child
    # event so its UsageRecord and aggregate delta can commit exactly once.
    op.create_table(
        "tenant_usage_completion_events",
        sa.Column("permit_id", sa.String(length=64), nullable=False),
        sa.Column("completion_id_hash", sa.String(length=64), nullable=False),
        sa.Column("usage_record_id", sa.String(length=255), nullable=False),
        sa.Column("usage_record_binding_hash", sa.String(length=64), nullable=False),
        sa.Column("completion_date", sa.Date(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("metering_status", sa.String(length=32), nullable=False),
        sa.Column("prompt_tokens", sa.BigInteger(), nullable=True),
        sa.Column("completion_tokens", sa.BigInteger(), nullable=True),
        sa.Column("total_tokens", sa.BigInteger(), nullable=True),
        sa.CheckConstraint(
            "length(completion_id_hash) = 64",
            name=op.f("ck_tenant_usage_completion_events_completion_id_hash_sha256_length"),
        ),
        sa.CheckConstraint(
            "length(usage_record_binding_hash) = 64",
            name=op.f("ck_tenant_usage_completion_events_usage_record_binding_hash_sha256_length"),
        ),
        sa.CheckConstraint(
            "metering_status IN ('reported', 'unmetered')",
            name=op.f("ck_tenant_usage_completion_events_metering_status_valid"),
        ),
        sa.CheckConstraint(
            "prompt_tokens IS NULL OR prompt_tokens >= 0",
            name=op.f("ck_tenant_usage_completion_events_prompt_tokens_nonnegative"),
        ),
        sa.CheckConstraint(
            "prompt_tokens IS NULL OR prompt_tokens <= 9223372036854775807",
            name=op.f("ck_tenant_usage_completion_events_prompt_tokens_bigint_max"),
        ),
        sa.CheckConstraint(
            "completion_tokens IS NULL OR completion_tokens >= 0",
            name=op.f("ck_tenant_usage_completion_events_completion_tokens_nonnegative"),
        ),
        sa.CheckConstraint(
            "completion_tokens IS NULL OR completion_tokens <= 9223372036854775807",
            name=op.f("ck_tenant_usage_completion_events_completion_tokens_bigint_max"),
        ),
        sa.CheckConstraint(
            "total_tokens IS NULL OR total_tokens >= 0",
            name=op.f("ck_tenant_usage_completion_events_total_tokens_nonnegative"),
        ),
        sa.CheckConstraint(
            "total_tokens IS NULL OR total_tokens <= 9223372036854775807",
            name=op.f("ck_tenant_usage_completion_events_total_tokens_bigint_max"),
        ),
        sa.CheckConstraint(
            "(metering_status = 'reported' AND total_tokens IS NOT NULL) OR "
            "(metering_status = 'unmetered' AND total_tokens IS NULL)",
            name=op.f("ck_tenant_usage_completion_events_metering_total_consistent"),
        ),
        sa.CheckConstraint(
            "total_tokens IS NULL OR prompt_tokens IS NULL OR "
            "completion_tokens IS NULL OR "
            "total_tokens = prompt_tokens + completion_tokens",
            name=op.f("ck_tenant_usage_completion_events_token_totals_consistent"),
        ),
        sa.ForeignKeyConstraint(
            ["permit_id"],
            ["tenant_usage_permits.permit_id"],
            name=op.f("fk_tenant_usage_completion_events_permit_id_tenant_usage_permits"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint(
            "completion_id_hash",
            name=op.f("pk_tenant_usage_completion_events"),
        ),
        sa.UniqueConstraint(
            "usage_record_id",
            name=op.f("uq_tenant_usage_completion_events_usage_record_id"),
        ),
    )
    op.create_index(
        "ix_tenant_usage_completion_events_date_permit",
        "tenant_usage_completion_events",
        ["completion_date", "permit_id"],
        unique=False,
    )
    op.create_index(
        "ix_tenant_usage_completion_events_completed_at",
        "tenant_usage_completion_events",
        ["completed_at"],
        unique=False,
    )

    _backfill_daily_usage()


def downgrade() -> None:
    op.drop_index(
        "ix_tenant_usage_completion_events_completed_at",
        table_name="tenant_usage_completion_events",
    )
    op.drop_index(
        "ix_tenant_usage_completion_events_date_permit",
        table_name="tenant_usage_completion_events",
    )
    op.drop_table("tenant_usage_completion_events")
    op.drop_index(
        "ix_tenant_usage_permits_status_acquired",
        table_name="tenant_usage_permits",
    )
    op.drop_index(
        "ix_tenant_usage_permits_tenant_admission_status_acquired",
        table_name="tenant_usage_permits",
    )
    op.drop_table("tenant_usage_permits")
    op.drop_index(
        "ix_tenant_daily_usage_date_tenant",
        table_name="tenant_daily_usage",
    )
    op.drop_table("tenant_daily_usage")
    op.drop_table("tenant_usage_budgets")


def _backfill_daily_usage() -> None:
    """Seed today's best-known totals from the bounded legacy detail table.

    This is intentionally a retained-detail cutover seed, not a claim that the
    globally bounded ``usage_records`` table contains complete history. Existing
    tenant budgets must be provisioned explicitly, and enforcement should not
    be enabled mid-day without accepting that retained-detail boundary.

    Every legacy row represents one provider completion; ``message_count`` is
    the prompt-message count and is therefore never used as a completion count.
    Legacy all-zero token payloads were the old "provider did not report" shape
    and remain unmetered. No negative-value coercion or token estimation occurs.
    """

    dialect = op.get_context().dialect.name
    if dialect == "postgresql":
        _backfill_postgresql()
        return
    if dialect == "sqlite":
        _backfill_sqlite()
        return
    raise RuntimeError(f"Unsupported database dialect for usage backfill: {dialect}")


def _backfill_postgresql() -> None:
    """Use NUMERIC while grouping so retained detail cannot overflow BIGINT."""

    usage_date = "CAST(created_at AT TIME ZONE 'UTC' AS DATE)"
    reported_total = _legacy_reported_total_expression(numeric=True)
    metered = _legacy_metered_expression()
    unmetered = _legacy_unmetered_expression()
    op.execute(
        sa.text(
            f"""
            WITH classified AS (
                SELECT
                    tenant_id,
                    {usage_date} AS usage_date,
                    {reported_total} AS reported_tokens,
                    {metered} AS metered_completions,
                    {unmetered} AS unmetered_completions
                FROM usage_records
                WHERE tenant_id IS NOT NULL
            ), grouped AS (
                SELECT
                    tenant_id,
                    usage_date,
                    SUM(reported_tokens) AS reported_tokens,
                    SUM(metered_completions) AS metered_completions,
                    SUM(unmetered_completions) AS unmetered_completions
                FROM classified
                GROUP BY tenant_id, usage_date
            )
            INSERT INTO tenant_daily_usage (
                tenant_id,
                usage_date,
                reported_tokens,
                reported_tokens_overflowed,
                metered_completions,
                unmetered_completions,
                updated_at
            )
            SELECT
                tenant_id,
                usage_date,
                CAST(
                    LEAST(reported_tokens, CAST(9223372036854775807 AS NUMERIC))
                    AS BIGINT
                ),
                reported_tokens > CAST(9223372036854775807 AS NUMERIC),
                metered_completions,
                unmetered_completions,
                CURRENT_TIMESTAMP
            FROM grouped
            """
        )
    )


def _backfill_sqlite() -> None:
    """Saturate row-by-row because SQLite integer SUM raises on overflow."""

    usage_date = "date(created_at)"
    all_zero = _legacy_all_zero_expression()
    reported_total = _legacy_reported_total_expression(numeric=False)
    row_overflowed = (
        f"CASE WHEN {all_zero} THEN 0 "
        "WHEN total_tokens IS NOT NULL THEN 0 "
        "WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL "
        "AND prompt_tokens > 9223372036854775807 - completion_tokens "
        "THEN 1 ELSE 0 END"
    )
    metered = _legacy_metered_expression()
    unmetered = _legacy_unmetered_expression()
    op.execute(
        sa.text(
            f"""
            WITH RECURSIVE classified AS (
                SELECT
                    tenant_id,
                    {usage_date} AS usage_date,
                    sequence,
                    ROW_NUMBER() OVER (
                        PARTITION BY tenant_id, {usage_date}
                        ORDER BY sequence
                    ) AS row_number,
                    COUNT(*) OVER (
                        PARTITION BY tenant_id, {usage_date}
                    ) AS row_count,
                    {reported_total} AS reported_tokens,
                    {row_overflowed} AS reported_tokens_overflowed,
                    {metered} AS metered_completions,
                    {unmetered} AS unmetered_completions
                FROM usage_records
                WHERE tenant_id IS NOT NULL
            ), running AS (
                SELECT
                    tenant_id,
                    usage_date,
                    row_number,
                    row_count,
                    reported_tokens,
                    reported_tokens_overflowed,
                    metered_completions,
                    unmetered_completions
                FROM classified
                WHERE row_number = 1

                UNION ALL

                SELECT
                    classified.tenant_id,
                    classified.usage_date,
                    classified.row_number,
                    classified.row_count,
                    CASE
                        WHEN running.reported_tokens_overflowed = 1
                          OR classified.reported_tokens_overflowed = 1
                          OR classified.reported_tokens
                             > 9223372036854775807 - running.reported_tokens
                        THEN 9223372036854775807
                        ELSE running.reported_tokens + classified.reported_tokens
                    END,
                    CASE
                        WHEN running.reported_tokens_overflowed = 1
                          OR classified.reported_tokens_overflowed = 1
                          OR classified.reported_tokens
                             > 9223372036854775807 - running.reported_tokens
                        THEN 1 ELSE 0
                    END,
                    running.metered_completions + classified.metered_completions,
                    running.unmetered_completions + classified.unmetered_completions
                FROM running
                JOIN classified
                  ON classified.tenant_id = running.tenant_id
                 AND classified.usage_date = running.usage_date
                 AND classified.row_number = running.row_number + 1
            )
            INSERT INTO tenant_daily_usage (
                tenant_id,
                usage_date,
                reported_tokens,
                reported_tokens_overflowed,
                metered_completions,
                unmetered_completions,
                updated_at
            )
            SELECT
                tenant_id,
                usage_date,
                reported_tokens,
                reported_tokens_overflowed,
                metered_completions,
                unmetered_completions,
                CURRENT_TIMESTAMP
            FROM running
            WHERE row_number = row_count
            """
        )
    )


def _legacy_all_zero_expression() -> str:
    return (
        "COALESCE(total_tokens, 0) = 0 "
        "AND COALESCE(prompt_tokens, 0) = 0 "
        "AND COALESCE(completion_tokens, 0) = 0"
    )


def _legacy_reported_total_expression(*, numeric: bool) -> str:
    all_zero = _legacy_all_zero_expression()
    if numeric:
        return (
            f"CASE WHEN {all_zero} THEN CAST(0 AS NUMERIC) "
            "WHEN total_tokens IS NOT NULL THEN CAST(total_tokens AS NUMERIC) "
            "WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL "
            "THEN CAST(prompt_tokens AS NUMERIC) + CAST(completion_tokens AS NUMERIC) "
            "ELSE CAST(0 AS NUMERIC) END"
        )
    return (
        f"CASE WHEN {all_zero} THEN 0 "
        "WHEN total_tokens IS NOT NULL THEN total_tokens "
        "WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL "
        "AND prompt_tokens > 9223372036854775807 - completion_tokens "
        "THEN 9223372036854775807 "
        "WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL "
        "THEN prompt_tokens + completion_tokens ELSE 0 END"
    )


def _legacy_metered_expression() -> str:
    all_zero = _legacy_all_zero_expression()
    return (
        f"CASE WHEN {all_zero} THEN 0 "
        "WHEN total_tokens IS NOT NULL THEN 1 "
        "WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN 1 "
        "ELSE 0 END"
    )


def _legacy_unmetered_expression() -> str:
    all_zero = _legacy_all_zero_expression()
    return (
        f"CASE WHEN {all_zero} THEN 1 WHEN total_tokens IS NULL AND "
        "(prompt_tokens IS NULL OR completion_tokens IS NULL) THEN 1 ELSE 0 END"
    )
