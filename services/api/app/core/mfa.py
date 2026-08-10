"""TOTP and recovery-code primitives with no durable plaintext state."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time

import pyotp


MFA_CHALLENGE_TTL_SECONDS = 5 * 60
MFA_ENROLLMENT_TTL_SECONDS = 10 * 60
MFA_MAX_ATTEMPTS = 5
MFA_RECOVERY_CODE_COUNT = 10
MFA_TOTP_INTERVAL_SECONDS = 30
MFA_TOTP_VALID_WINDOW = 1

_RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_RECOVERY_GROUP_LENGTH = 4
_RECOVERY_GROUPS = 6
_RECOVERY_PATTERN = re.compile(r"^[A-Z2-9]{24}$")


def hash_opaque_secret(value: str) -> str:
    """Hash one high-entropy bearer value for durable comparison."""

    if not isinstance(value, str) or not value:
        raise ValueError("Opaque secret must be a nonempty string")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def new_challenge_token() -> str:
    return f"mfa_ch_{secrets.token_urlsafe(32)}"


def new_enrollment_token() -> str:
    return f"mfa_en_{secrets.token_urlsafe(32)}"


def new_totp_secret() -> str:
    # 32 base32 characters encode 160 random bits, matching RFC 4226's
    # recommended secret size.
    return pyotp.random_base32(length=32)


def provisioning_uri(
    secret: str,
    *,
    account_name: str,
    issuer_name: str = "Aperture Chat",
) -> str:
    issuer = _safe_totp_label(issuer_name, fallback="Aperture Chat")
    account = _safe_totp_label(account_name, fallback="Account")
    return pyotp.TOTP(
        secret,
        digits=6,
        interval=MFA_TOTP_INTERVAL_SECONDS,
    ).provisioning_uri(
        name=account,
        issuer_name=issuer,
    )


def _safe_totp_label(value: str, *, fallback: str) -> str:
    normalized = " ".join(
        "".join(
            " " if character == ":" else character
            for character in str(value)
            if character.isprintable()
        ).split()
    ).strip(" :")
    return (normalized or fallback)[:120]


def matching_totp_step(
    secret: str,
    code: str,
    *,
    at_time: float | int | None = None,
) -> int | None:
    """Return the matched RFC 6238 step within the bounded acceptance window."""

    normalized = code.strip() if isinstance(code, str) else ""
    if len(normalized) != 6 or not normalized.isascii() or not normalized.isdigit():
        return None
    timestamp = time.time() if at_time is None else float(at_time)
    current_step = int(timestamp) // MFA_TOTP_INTERVAL_SECONDS
    totp = pyotp.TOTP(secret, digits=6, interval=MFA_TOTP_INTERVAL_SECONDS)
    # Prefer the current step, then the past clock-skew step, then the future
    # step. The chosen value is persisted so the same step cannot be replayed.
    offsets = [0]
    for distance in range(1, MFA_TOTP_VALID_WINDOW + 1):
        offsets.extend((-distance, distance))
    for offset in offsets:
        step = current_step + offset
        if step < 0:
            continue
        candidate = totp.at(step * MFA_TOTP_INTERVAL_SECONDS)
        if hmac.compare_digest(candidate, normalized):
            return step
    return None


def new_recovery_codes(count: int = MFA_RECOVERY_CODE_COUNT) -> list[str]:
    if type(count) is not int or count < 1 or count > 50:
        raise ValueError("Recovery-code count must be between 1 and 50")
    values: set[str] = set()
    while len(values) < count:
        compact = "".join(
            secrets.choice(_RECOVERY_ALPHABET)
            for _ in range(_RECOVERY_GROUP_LENGTH * _RECOVERY_GROUPS)
        )
        values.add("-".join(
            compact[index : index + _RECOVERY_GROUP_LENGTH]
            for index in range(0, len(compact), _RECOVERY_GROUP_LENGTH)
        ))
    return sorted(values)


def normalize_recovery_code(value: str) -> str | None:
    compact = re.sub(r"[\s-]", "", value.strip().upper()) if isinstance(value, str) else ""
    if _RECOVERY_PATTERN.fullmatch(compact) is None:
        return None
    return compact


def hash_recovery_code(value: str) -> str | None:
    normalized = normalize_recovery_code(value)
    return hash_opaque_secret(normalized) if normalized is not None else None


def pending_seed_aad(
    *,
    tenant_id: str | None,
    user_id: str,
    factor_generation: int,
    enrollment_token_hash: str,
) -> bytes:
    return _mfa_aad(
        "pending",
        tenant_id=tenant_id,
        user_id=user_id,
        factor_generation=factor_generation,
        context_id=enrollment_token_hash,
    )


def factor_seed_aad(
    *,
    tenant_id: str | None,
    user_id: str,
    factor_generation: int,
) -> bytes:
    return _mfa_aad(
        "factor",
        tenant_id=tenant_id,
        user_id=user_id,
        factor_generation=factor_generation,
        context_id=None,
    )


def _mfa_aad(
    kind: str,
    *,
    tenant_id: str | None,
    user_id: str,
    factor_generation: int,
    context_id: str | None,
) -> bytes:
    if kind not in {"pending", "factor"}:
        raise ValueError("Unknown MFA AAD kind")
    authoritative = {
        "context_id": context_id,
        "factor_generation": factor_generation,
        "kind": kind,
        "tenant": (
            {"scope": "platform"}
            if tenant_id is None
            else {"id": tenant_id, "scope": "tenant"}
        ),
        "user_id": user_id,
        "version": 1,
    }
    return json.dumps(
        authoritative,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("ascii")
