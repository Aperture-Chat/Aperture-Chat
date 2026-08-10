from __future__ import annotations

import pyotp
import pytest

from app.core.mfa import (
    MFA_TOTP_INTERVAL_SECONDS,
    factor_seed_aad,
    hash_recovery_code,
    matching_totp_step,
    new_recovery_codes,
    pending_seed_aad,
    provisioning_uri,
)
from app.core.security import SecretVault
from app.core.sessions import issue_session_token, verify_session_token


def test_totp_accepts_only_the_explicit_six_digit_adjacent_window_and_returns_step() -> None:
    secret = pyotp.random_base32(length=32)
    timestamp = 1_800_000_015
    step = timestamp // MFA_TOTP_INTERVAL_SECONDS
    totp = pyotp.TOTP(secret, digits=6, interval=MFA_TOTP_INTERVAL_SECONDS)

    assert matching_totp_step(secret, totp.at(timestamp), at_time=timestamp) == step
    assert matching_totp_step(
        secret,
        totp.at(timestamp - MFA_TOTP_INTERVAL_SECONDS),
        at_time=timestamp,
    ) == step - 1
    assert matching_totp_step(
        secret,
        totp.at(timestamp + MFA_TOTP_INTERVAL_SECONDS),
        at_time=timestamp,
    ) == step + 1
    assert matching_totp_step(
        secret,
        totp.at(timestamp + (2 * MFA_TOTP_INTERVAL_SECONDS)),
        at_time=timestamp,
    ) is None
    assert matching_totp_step(secret, "１２３４５６", at_time=timestamp) is None
    assert matching_totp_step(secret, "1234567", at_time=timestamp) is None


def test_recovery_codes_are_ten_unique_high_entropy_show_once_values() -> None:
    codes = new_recovery_codes()
    assert len(codes) == len(set(codes)) == 10
    assert all(len(code.replace("-", "")) == 24 for code in codes)
    assert hash_recovery_code(codes[0]) == hash_recovery_code(
        codes[0].lower().replace("-", " ")
    )


def test_scoped_vault_binds_kind_tenant_user_generation_and_enrollment() -> None:
    vault = SecretVault("mfa-scoped-vault-signing-secret")
    pending_aad = pending_seed_aad(
        tenant_id=None,
        user_id="user-one",
        factor_generation=10,
        enrollment_token_hash="a" * 64,
    )
    ciphertext = vault.encrypt_scoped("BASE32SEED", aad=pending_aad)
    assert ciphertext.startswith("v3.")
    assert vault.decrypt_scoped(ciphertext, aad=pending_aad) == "BASE32SEED"

    wrong_contexts = [
        pending_seed_aad(
            tenant_id="__platform__",
            user_id="user-one",
            factor_generation=10,
            enrollment_token_hash="a" * 64,
        ),
        pending_seed_aad(
            tenant_id=None,
            user_id="user-two",
            factor_generation=10,
            enrollment_token_hash="a" * 64,
        ),
        pending_seed_aad(
            tenant_id=None,
            user_id="user-one",
            factor_generation=11,
            enrollment_token_hash="a" * 64,
        ),
        pending_seed_aad(
            tenant_id=None,
            user_id="user-one",
            factor_generation=10,
            enrollment_token_hash="b" * 64,
        ),
        factor_seed_aad(
            tenant_id=None,
            user_id="user-one",
            factor_generation=10,
        ),
    ]
    for aad in wrong_contexts:
        with pytest.raises(ValueError, match="integrity"):
            vault.decrypt_scoped(ciphertext, aad=aad)
    with pytest.raises(ValueError, match="v3"):
        vault.decrypt_scoped(vault.encrypt("BASE32SEED"), aad=pending_aad)


def test_session_claims_enforce_signed_bigint_generation_and_legacy_defaults() -> None:
    secret = "mfa-session-signing-secret"
    token, _expires = issue_session_token("user-one", secret)
    claims = verify_session_token(token, secret)
    assert claims is not None
    assert claims.mfa is False
    assert claims.mfg is None

    assured, _expires = issue_session_token(
        "user-one",
        secret,
        mfa_assured=True,
        mfa_factor_generation=(1 << 63) - 1,
    )
    assured_claims = verify_session_token(assured, secret)
    assert assured_claims is not None
    assert assured_claims.mfa is True
    assert assured_claims.mfg == (1 << 63) - 1

    for generation in (True, 0, -1, 1.5, "1", 1 << 63):
        with pytest.raises(ValueError):
            issue_session_token(
                "user-one",
                secret,
                mfa_assured=True,
                mfa_factor_generation=generation,  # type: ignore[arg-type]
            )


def test_provisioning_uri_sanitizes_colons_and_uses_authoritative_brand() -> None:
    uri = provisioning_uri(
        pyotp.random_base32(length=32),
        account_name="user:name@example.test",
        issuer_name="Tenant:AI",
    )
    assert "Tenant%20AI" in uri
    assert "user%20name%40example.test" in uri
    assert "Tenant%3AAI" not in uri
