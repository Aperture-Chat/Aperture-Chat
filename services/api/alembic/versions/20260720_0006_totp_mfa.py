"""Add durable TOTP enrollment, challenge, and recovery state.

Revision ID: 20260720_0006
Revises: 20260720_0005
Create Date: 2026-07-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260720_0006"
down_revision: str | None = "20260720_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "tenant_mfa_policies",
        sa.Column("tenant_id", sa.String(length=255), nullable=False),
        sa.Column("required", sa.Boolean(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_by", sa.String(length=255), nullable=True),
        sa.CheckConstraint(
            "generation >= 1",
            name=op.f("ck_tenant_mfa_policies_generation_positive"),
        ),
        sa.PrimaryKeyConstraint("tenant_id", name=op.f("pk_tenant_mfa_policies")),
    )

    op.create_table(
        "user_totp_factors",
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("generation", sa.BigInteger(), nullable=False),
        sa.Column("encrypted_secret_ciphertext", sa.Text(), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_step", sa.BigInteger(), nullable=True),
        sa.CheckConstraint(
            "generation >= 1",
            name=op.f("ck_user_totp_factors_generation_positive"),
        ),
        sa.CheckConstraint(
            "encrypted_secret_ciphertext LIKE 'v3.%' "
            "AND length(encrypted_secret_ciphertext) > 3",
            name=op.f("ck_user_totp_factors_ciphertext_v3_encrypted"),
        ),
        sa.CheckConstraint(
            "last_used_step IS NULL OR last_used_step >= 0",
            name=op.f("ck_user_totp_factors_last_used_step_nonnegative"),
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_user_totp_factors")),
    )
    op.create_index(
        "ix_user_totp_factors_tenant_user",
        "user_totp_factors",
        ["tenant_id", "user_id"],
        unique=False,
    )

    op.create_table(
        "totp_pending_enrollments",
        sa.Column("enrollment_token_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("factor_generation", sa.BigInteger(), nullable=False),
        sa.Column("auth_method", sa.String(length=32), nullable=False),
        sa.Column("sso_config_id", sa.String(length=255), nullable=True),
        sa.Column("source_challenge_hash", sa.String(length=64), nullable=True),
        sa.Column("encrypted_secret_ciphertext", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "length(enrollment_token_hash) = 64",
            name=op.f(
                "ck_totp_pending_enrollments_enrollment_token_hash_sha256_length"
            ),
        ),
        sa.CheckConstraint(
            "factor_generation >= 1",
            name=op.f("ck_totp_pending_enrollments_factor_generation_positive"),
        ),
        sa.CheckConstraint(
            "auth_method IN ('local', 'sso')",
            name=op.f("ck_totp_pending_enrollments_auth_method_valid"),
        ),
        sa.CheckConstraint(
            "(auth_method = 'local' AND sso_config_id IS NULL) OR "
            "(auth_method = 'sso' AND sso_config_id IS NOT NULL)",
            name=op.f("ck_totp_pending_enrollments_auth_context_consistent"),
        ),
        sa.CheckConstraint(
            "source_challenge_hash IS NULL OR length(source_challenge_hash) = 64",
            name=op.f(
                "ck_totp_pending_enrollments_source_challenge_hash_sha256_length"
            ),
        ),
        sa.CheckConstraint(
            "encrypted_secret_ciphertext LIKE 'v3.%' "
            "AND length(encrypted_secret_ciphertext) > 3",
            name=op.f("ck_totp_pending_enrollments_ciphertext_v3_encrypted"),
        ),
        sa.CheckConstraint(
            "expires_at > created_at",
            name=op.f("ck_totp_pending_enrollments_expiry_after_creation"),
        ),
        sa.CheckConstraint(
            "max_attempts >= 1",
            name=op.f("ck_totp_pending_enrollments_max_attempts_positive"),
        ),
        sa.CheckConstraint(
            "attempts >= 0 AND attempts <= max_attempts",
            name=op.f("ck_totp_pending_enrollments_attempts_within_limit"),
        ),
        sa.CheckConstraint(
            "consumed_at IS NULL OR consumed_at >= created_at",
            name=op.f("ck_totp_pending_enrollments_consumed_after_creation"),
        ),
        sa.PrimaryKeyConstraint(
            "enrollment_token_hash",
            name=op.f("pk_totp_pending_enrollments"),
        ),
        sa.UniqueConstraint(
            "source_challenge_hash",
            name=op.f("uq_totp_pending_enrollments_source_challenge_hash"),
        ),
        sa.UniqueConstraint(
            "user_id",
            name=op.f("uq_totp_pending_enrollments_user_id"),
        ),
    )
    op.create_index(
        "ix_totp_pending_enrollments_expires_at",
        "totp_pending_enrollments",
        ["expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_totp_pending_enrollments_tenant_expires_at",
        "totp_pending_enrollments",
        ["tenant_id", "expires_at"],
        unique=False,
    )

    op.create_table(
        "mfa_preauth_challenges",
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("auth_method", sa.String(length=32), nullable=False),
        sa.Column("sso_config_id", sa.String(length=255), nullable=True),
        sa.Column("purpose", sa.String(length=16), nullable=False),
        sa.Column("expected_factor_generation", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "length(token_hash) = 64",
            name=op.f("ck_mfa_preauth_challenges_token_hash_sha256_length"),
        ),
        sa.CheckConstraint(
            "auth_method IN ('local', 'sso')",
            name=op.f("ck_mfa_preauth_challenges_auth_method_valid"),
        ),
        sa.CheckConstraint(
            "(auth_method = 'local' AND sso_config_id IS NULL) OR "
            "(auth_method = 'sso' AND sso_config_id IS NOT NULL)",
            name=op.f("ck_mfa_preauth_challenges_auth_context_consistent"),
        ),
        sa.CheckConstraint(
            "purpose IN ('verify', 'enroll')",
            name=op.f("ck_mfa_preauth_challenges_purpose_valid"),
        ),
        sa.CheckConstraint(
            "(purpose = 'verify' AND expected_factor_generation IS NOT NULL) OR "
            "(purpose = 'enroll' AND expected_factor_generation IS NULL)",
            name=op.f(
                "ck_mfa_preauth_challenges_factor_generation_matches_purpose"
            ),
        ),
        sa.CheckConstraint(
            "expected_factor_generation IS NULL OR expected_factor_generation >= 1",
            name=op.f(
                "ck_mfa_preauth_challenges_expected_factor_generation_positive"
            ),
        ),
        sa.CheckConstraint(
            "expires_at > created_at",
            name=op.f("ck_mfa_preauth_challenges_expiry_after_creation"),
        ),
        sa.CheckConstraint(
            "max_attempts >= 1",
            name=op.f("ck_mfa_preauth_challenges_max_attempts_positive"),
        ),
        sa.CheckConstraint(
            "attempts >= 0 AND attempts <= max_attempts",
            name=op.f("ck_mfa_preauth_challenges_attempts_within_limit"),
        ),
        sa.CheckConstraint(
            "consumed_at IS NULL OR consumed_at >= created_at",
            name=op.f("ck_mfa_preauth_challenges_consumed_after_creation"),
        ),
        sa.PrimaryKeyConstraint(
            "token_hash",
            name=op.f("pk_mfa_preauth_challenges"),
        ),
        sa.UniqueConstraint(
            "user_id",
            name=op.f("uq_mfa_preauth_challenges_user_id"),
        ),
    )
    op.create_index(
        "ix_mfa_preauth_challenges_expires_at",
        "mfa_preauth_challenges",
        ["expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_mfa_preauth_challenges_user_expires_at",
        "mfa_preauth_challenges",
        ["user_id", "expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_mfa_preauth_challenges_tenant_expires_at",
        "mfa_preauth_challenges",
        ["tenant_id", "expires_at"],
        unique=False,
    )

    op.create_table(
        "totp_recovery_codes",
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("tenant_id", sa.String(length=255), nullable=True),
        sa.Column("factor_generation", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "length(code_hash) = 64",
            name=op.f("ck_totp_recovery_codes_code_hash_sha256_length"),
        ),
        sa.CheckConstraint(
            "factor_generation >= 1",
            name=op.f("ck_totp_recovery_codes_factor_generation_positive"),
        ),
        sa.CheckConstraint(
            "used_at IS NULL OR used_at >= created_at",
            name=op.f("ck_totp_recovery_codes_used_after_creation"),
        ),
        sa.PrimaryKeyConstraint("code_hash", name=op.f("pk_totp_recovery_codes")),
    )
    op.create_index(
        "ix_totp_recovery_codes_user_generation_used",
        "totp_recovery_codes",
        ["user_id", "factor_generation", "used_at"],
        unique=False,
    )
    op.create_index(
        "ix_totp_recovery_codes_tenant_user",
        "totp_recovery_codes",
        ["tenant_id", "user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_totp_recovery_codes_tenant_user",
        table_name="totp_recovery_codes",
    )
    op.drop_index(
        "ix_totp_recovery_codes_user_generation_used",
        table_name="totp_recovery_codes",
    )
    op.drop_table("totp_recovery_codes")
    op.drop_index(
        "ix_mfa_preauth_challenges_tenant_expires_at",
        table_name="mfa_preauth_challenges",
    )
    op.drop_index(
        "ix_mfa_preauth_challenges_user_expires_at",
        table_name="mfa_preauth_challenges",
    )
    op.drop_index(
        "ix_mfa_preauth_challenges_expires_at",
        table_name="mfa_preauth_challenges",
    )
    op.drop_table("mfa_preauth_challenges")
    op.drop_index(
        "ix_totp_pending_enrollments_tenant_expires_at",
        table_name="totp_pending_enrollments",
    )
    op.drop_index(
        "ix_totp_pending_enrollments_expires_at",
        table_name="totp_pending_enrollments",
    )
    op.drop_table("totp_pending_enrollments")
    op.drop_index(
        "ix_user_totp_factors_tenant_user",
        table_name="user_totp_factors",
    )
    op.drop_table("user_totp_factors")
    op.drop_table("tenant_mfa_policies")
