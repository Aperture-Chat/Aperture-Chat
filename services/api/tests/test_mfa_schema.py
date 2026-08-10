from __future__ import annotations

from datetime import UTC, datetime, timedelta
from io import StringIO
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.exc import IntegrityError
from sqlalchemy.schema import CreateTable

from app.core.config import get_settings
from app.core.security import SecretVault
from app.db import (
    APPLICATION_STATE_IMPORT_REVISION,
    CHAT_STATE_IMPORT_REVISION,
    HEAD_REVISION,
    Base,
    MfaPreauthChallengeRow,
    RevokedSessionRow,
    TenantMfaPolicyRow,
    TotpPendingEnrollmentRow,
    TotpRecoveryCodeRow,
    UserTotpFactorRow,
    create_application_engine,
    create_session_factory,
    current_schema_revision,
    session_scope,
    upgrade_database,
)
from app.db.engine import alembic_config


MFA_TABLES = {
    "tenant_mfa_policies",
    "user_totp_factors",
    "totp_pending_enrollments",
    "mfa_preauth_challenges",
    "totp_recovery_codes",
}


def _sqlite_url(path: Path) -> str:
    return f"sqlite:///{path}"


def _downgrade(engine: object, revision: str) -> None:
    config = alembic_config()
    with engine.begin() as connection:  # type: ignore[union-attr]
        config.attributes["connection"] = connection
        command.downgrade(config, revision)


def test_mfa_fresh_upgrade_has_exact_tables_columns_indexes_and_no_identity_fks(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "mfa-fresh.sqlite3"))
    try:
        upgrade_database(engine, "20260720_0006")
        inspector = inspect(engine)

        assert current_schema_revision(engine) == "20260720_0006"
        assert APPLICATION_STATE_IMPORT_REVISION == "20260720_0003"
        assert CHAT_STATE_IMPORT_REVISION == "20260720_0004"
        assert MFA_TABLES <= set(inspector.get_table_names())

        assert {column["name"] for column in inspector.get_columns("tenant_mfa_policies")} == {
            "tenant_id",
            "required",
            "generation",
            "updated_at",
            "updated_by",
        }
        assert {column["name"] for column in inspector.get_columns("user_totp_factors")} == {
            "user_id",
            "tenant_id",
            "generation",
            "encrypted_secret_ciphertext",
            "confirmed_at",
            "last_used_step",
        }
        assert {
            column["name"]
            for column in inspector.get_columns("totp_pending_enrollments")
        } == {
            "enrollment_token_hash",
            "user_id",
            "tenant_id",
            "factor_generation",
            "auth_method",
            "sso_config_id",
            "source_challenge_hash",
            "encrypted_secret_ciphertext",
            "created_at",
            "expires_at",
            "attempts",
            "max_attempts",
            "consumed_at",
        }
        assert {
            column["name"] for column in inspector.get_columns("mfa_preauth_challenges")
        } == {
            "token_hash",
            "user_id",
            "tenant_id",
            "auth_method",
            "sso_config_id",
            "purpose",
            "expected_factor_generation",
            "created_at",
            "expires_at",
            "attempts",
            "max_attempts",
            "consumed_at",
        }
        assert {column["name"] for column in inspector.get_columns("totp_recovery_codes")} == {
            "code_hash",
            "user_id",
            "tenant_id",
            "factor_generation",
            "created_at",
            "used_at",
        }
        reflected_types = {
            table: {column["name"]: str(column["type"]).upper() for column in inspector.get_columns(table)}
            for table in MFA_TABLES
        }
        assert reflected_types["tenant_mfa_policies"]["generation"] == "INTEGER"
        assert reflected_types["user_totp_factors"]["generation"] == "BIGINT"
        assert reflected_types["totp_pending_enrollments"]["factor_generation"] == "BIGINT"
        assert (
            reflected_types["mfa_preauth_challenges"]["expected_factor_generation"]
            == "BIGINT"
        )
        assert reflected_types["totp_recovery_codes"]["factor_generation"] == "BIGINT"

        expected_indexes = {
            "user_totp_factors": {"ix_user_totp_factors_tenant_user"},
            "totp_pending_enrollments": {
                "ix_totp_pending_enrollments_expires_at",
                "ix_totp_pending_enrollments_tenant_expires_at",
            },
            "mfa_preauth_challenges": {
                "ix_mfa_preauth_challenges_expires_at",
                "ix_mfa_preauth_challenges_user_expires_at",
                "ix_mfa_preauth_challenges_tenant_expires_at",
            },
            "totp_recovery_codes": {
                "ix_totp_recovery_codes_user_generation_used",
                "ix_totp_recovery_codes_tenant_user",
            },
        }
        for table, names in expected_indexes.items():
            assert {index["name"] for index in inspector.get_indexes(table)} >= names
        assert {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("mfa_preauth_challenges")
        } == {"uq_mfa_preauth_challenges_user_id"}
        for table in MFA_TABLES:
            assert inspector.get_foreign_keys(table) == []

        upgrade_database(engine)
        assert current_schema_revision(engine) == HEAD_REVISION
        with engine.connect() as connection:
            context = MigrationContext.configure(connection)
            assert compare_metadata(context, Base.metadata) == []
    finally:
        engine.dispose()


def test_mfa_0005_up_down_up_preserves_preexisting_session_state(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "mfa-linear.sqlite3"))
    factory = create_session_factory(engine)
    revoked_at = datetime(2026, 7, 20, 18, tzinfo=UTC)
    try:
        upgrade_database(engine, "20260720_0005")
        with session_scope(factory) as session:
            session.add(
                RevokedSessionRow(
                    sid="mfa-linear-session",
                    user_id="mfa-linear-user",
                    tenant_id="mfa-linear-tenant",
                    issued_at=100,
                    expires_at=200,
                    revoked_at=revoked_at,
                    reason="test",
                )
            )

        upgrade_database(engine)
        assert current_schema_revision(engine) == HEAD_REVISION
        assert MFA_TABLES <= set(inspect(engine).get_table_names())

        _downgrade(engine, "20260720_0005")
        assert current_schema_revision(engine) == "20260720_0005"
        assert MFA_TABLES.isdisjoint(inspect(engine).get_table_names())
        with session_scope(factory) as session:
            assert session.get(RevokedSessionRow, "mfa-linear-session") is not None

        upgrade_database(engine)
        assert current_schema_revision(engine) == HEAD_REVISION
        assert MFA_TABLES <= set(inspect(engine).get_table_names())
        with session_scope(factory) as session:
            assert session.get(RevokedSessionRow, "mfa-linear-session") is not None
    finally:
        engine.dispose()


def test_mfa_schema_accepts_only_hashed_tokens_and_v3_encrypted_seed_ciphertext(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "mfa-secrets.sqlite3"))
    factory = create_session_factory(engine)
    now = datetime(2026, 7, 20, 18, tzinfo=UTC)
    plaintext_seed = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
    vault = SecretVault("mfa-schema-test-signing-secret")
    factor_aad = b"mfa-schema-factor-aad"
    pending_aad = b"mfa-schema-pending-aad"
    factor_ciphertext = vault.encrypt_scoped(plaintext_seed, aad=factor_aad)
    pending_ciphertext = vault.encrypt_scoped(plaintext_seed, aad=pending_aad)
    try:
        upgrade_database(engine)
        inspector = inspect(engine)
        forbidden_raw_columns = {
            "secret",
            "seed",
            "token",
            "challenge_token",
            "enrollment_token",
            "code",
            "recovery_code",
            "provisioning_uri",
            "otpauth_uri",
        }
        for table in MFA_TABLES:
            columns = {column["name"] for column in inspector.get_columns(table)}
            assert columns.isdisjoint(forbidden_raw_columns)

        for rejected_ciphertext in ("JBSWY3DPEHPK3PXP", "v2.legacy-ciphertext"):
            with pytest.raises(IntegrityError):
                with session_scope(factory) as session:
                    session.add(
                        UserTotpFactorRow(
                            user_id=f"rejected-{rejected_ciphertext[:2]}",
                            tenant_id="tenant-mfa",
                            generation=1,
                            encrypted_secret_ciphertext=rejected_ciphertext,
                            confirmed_at=now,
                            last_used_step=None,
                        )
                    )

        with session_scope(factory) as session:
            session.add_all(
                [
                    UserTotpFactorRow(
                        user_id="user-factor",
                        tenant_id="tenant-mfa",
                        generation=1,
                        encrypted_secret_ciphertext=factor_ciphertext,
                        confirmed_at=now,
                        last_used_step=123,
                    ),
                    TotpPendingEnrollmentRow(
                        enrollment_token_hash="a" * 64,
                        user_id="user-pending",
                        tenant_id="tenant-mfa",
                        factor_generation=1,
                        auth_method="local",
                        sso_config_id=None,
                        source_challenge_hash=None,
                        encrypted_secret_ciphertext=pending_ciphertext,
                        created_at=now,
                        expires_at=now + timedelta(minutes=10),
                        attempts=0,
                        max_attempts=5,
                        consumed_at=None,
                    ),
                    MfaPreauthChallengeRow(
                        token_hash="b" * 64,
                        user_id="user-factor",
                        tenant_id="tenant-mfa",
                        auth_method="local",
                        sso_config_id=None,
                        purpose="verify",
                        expected_factor_generation=1,
                        created_at=now,
                        expires_at=now + timedelta(minutes=5),
                        attempts=0,
                        max_attempts=5,
                        consumed_at=None,
                    ),
                    TotpRecoveryCodeRow(
                        code_hash="c" * 64,
                        user_id="user-factor",
                        tenant_id="tenant-mfa",
                        factor_generation=1,
                        created_at=now,
                        used_at=None,
                    ),
                ]
            )

        restarted = create_application_engine(_sqlite_url(tmp_path / "mfa-secrets.sqlite3"))
        restarted_factory = create_session_factory(restarted)
        try:
            with session_scope(restarted_factory) as session:
                factor = session.get(UserTotpFactorRow, "user-factor")
                pending = session.get(TotpPendingEnrollmentRow, "a" * 64)
                assert factor is not None
                assert factor.encrypted_secret_ciphertext == factor_ciphertext
                assert plaintext_seed not in factor.encrypted_secret_ciphertext
                assert (
                    vault.decrypt_scoped(factor.encrypted_secret_ciphertext, aad=factor_aad)
                    == plaintext_seed
                )
                assert pending is not None
                assert pending.encrypted_secret_ciphertext == pending_ciphertext
                assert plaintext_seed not in pending.encrypted_secret_ciphertext
                assert (
                    vault.decrypt_scoped(pending.encrypted_secret_ciphertext, aad=pending_aad)
                    == plaintext_seed
                )
        finally:
            restarted.dispose()
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("row"),
    [
        UserTotpFactorRow(
            user_id="negative-step",
            tenant_id="tenant-mfa",
            generation=1,
            encrypted_secret_ciphertext="v3.encrypted",
            confirmed_at=datetime(2026, 7, 20, tzinfo=UTC),
            last_used_step=-1,
        ),
        TotpPendingEnrollmentRow(
            enrollment_token_hash="d" * 64,
            user_id="bad-pending-context",
            tenant_id="tenant-mfa",
            factor_generation=1,
            auth_method="local",
            sso_config_id="must-be-null-for-local",
            source_challenge_hash=None,
            encrypted_secret_ciphertext="v3.encrypted",
            created_at=datetime(2026, 7, 20, tzinfo=UTC),
            expires_at=datetime(2026, 7, 20, 0, 5, tzinfo=UTC),
            attempts=0,
            max_attempts=5,
            consumed_at=None,
        ),
        TotpPendingEnrollmentRow(
            enrollment_token_hash="e" * 64,
            user_id="too-many-pending-attempts",
            tenant_id="tenant-mfa",
            factor_generation=1,
            auth_method="sso",
            sso_config_id="sso-one",
            source_challenge_hash=None,
            encrypted_secret_ciphertext="v3.encrypted",
            created_at=datetime(2026, 7, 20, tzinfo=UTC),
            expires_at=datetime(2026, 7, 20, 0, 5, tzinfo=UTC),
            attempts=6,
            max_attempts=5,
            consumed_at=None,
        ),
        MfaPreauthChallengeRow(
            token_hash="f" * 64,
            user_id="bad-enroll-generation",
            tenant_id="tenant-mfa",
            auth_method="sso",
            sso_config_id="sso-one",
            purpose="enroll",
            expected_factor_generation=1,
            created_at=datetime(2026, 7, 20, tzinfo=UTC),
            expires_at=datetime(2026, 7, 20, 0, 5, tzinfo=UTC),
            attempts=0,
            max_attempts=5,
            consumed_at=None,
        ),
        MfaPreauthChallengeRow(
            token_hash="0" * 64,
            user_id="missing-sso-context",
            tenant_id="tenant-mfa",
            auth_method="sso",
            sso_config_id=None,
            purpose="verify",
            expected_factor_generation=1,
            created_at=datetime(2026, 7, 20, tzinfo=UTC),
            expires_at=datetime(2026, 7, 20, 0, 5, tzinfo=UTC),
            attempts=0,
            max_attempts=5,
            consumed_at=None,
        ),
        TotpRecoveryCodeRow(
            code_hash="short",
            user_id="bad-recovery-hash",
            tenant_id="tenant-mfa",
            factor_generation=1,
            created_at=datetime(2026, 7, 20, tzinfo=UTC),
            used_at=None,
        ),
    ],
)
def test_mfa_schema_rejects_invalid_replay_attempt_and_auth_context_state(
    tmp_path: Path,
    row: object,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "mfa-constraints.sqlite3"))
    factory = create_session_factory(engine)
    try:
        upgrade_database(engine)
        with pytest.raises(IntegrityError):
            with session_scope(factory) as session:
                session.add(row)  # type: ignore[arg-type]
    finally:
        engine.dispose()


def test_mfa_orm_compiles_for_sqlite_and_postgresql() -> None:
    tables = [
        TenantMfaPolicyRow.__table__,
        UserTotpFactorRow.__table__,
        TotpPendingEnrollmentRow.__table__,
        MfaPreauthChallengeRow.__table__,
        TotpRecoveryCodeRow.__table__,
    ]
    for dialect in (sqlite.dialect(), postgresql.dialect()):
        for table in tables:
            compiled = str(CreateTable(table).compile(dialect=dialect))
            assert table.name in compiled
            assert "FOREIGN KEY" not in compiled


def test_mfa_postgresql_upgrade_and_downgrade_render_offline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    upgrade_buffer = StringIO()
    monkeypatch.setenv("APERTURE_DATABASE_URL", "postgresql://offline.invalid/aperture")
    get_settings.cache_clear()
    config = alembic_config()
    config.output_buffer = upgrade_buffer
    try:
        command.upgrade(config, "20260720_0005:20260720_0006", sql=True)
    finally:
        get_settings.cache_clear()

    rendered_upgrade = upgrade_buffer.getvalue()
    for table in MFA_TABLES:
        assert f"CREATE TABLE {table}" in rendered_upgrade
    assert "encrypted_secret_ciphertext LIKE 'v3.%'" in rendered_upgrade
    assert "auth_method IN ('local', 'sso')" in rendered_upgrade
    assert "_alembic_tmp_" not in rendered_upgrade

    downgrade_buffer = StringIO()
    monkeypatch.setenv("APERTURE_DATABASE_URL", "postgresql://offline.invalid/aperture")
    get_settings.cache_clear()
    config = alembic_config()
    config.output_buffer = downgrade_buffer
    try:
        command.downgrade(config, "20260720_0006:20260720_0005", sql=True)
    finally:
        get_settings.cache_clear()

    rendered_downgrade = downgrade_buffer.getvalue()
    for table in MFA_TABLES:
        assert f"DROP TABLE {table}" in rendered_downgrade
    assert "_alembic_tmp_" not in rendered_downgrade
