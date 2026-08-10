"""Signed session tokens and OIDC state signing.

Tokens are stateless HMAC-SHA256 signed payloads so they survive API restarts
as long as APERTURE_SECRET_KEY is stable. Format: ``v1.<payload-b64url>.<sig-b64url>``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass

SESSION_TOKEN_PREFIX = "v1"
# Keep in sync with Settings.session_ttl_seconds: sessions are rotated on
# every app load, so the TTL acts as an idle window rather than a hard cap.
DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
STATE_MAX_AGE_SECONDS = 10 * 60
MAX_MFA_FACTOR_GENERATION = (1 << 63) - 1


@dataclass(frozen=True, slots=True)
class SessionClaims:
    """Strict signed-session claims with semantic aliases for request code."""

    uid: str
    sid: str
    iat: int
    iat_ms: int
    exp: int
    # Claims minted before TOTP support intentionally remain parseable. SQL
    # policy/factor validation decides whether an unassured legacy session is
    # still current for its user.
    mfa: bool = False
    mfg: int | None = None

    @property
    def user_id(self) -> str:
        return self.uid

    @property
    def session_id(self) -> str:
        return self.sid

    @property
    def issued_at(self) -> int:
        return self.iat

    @property
    def issued_at_ms(self) -> int:
        return self.iat_ms

    @property
    def expires_at(self) -> int:
        return self.exp

    @property
    def mfa_assured(self) -> bool:
        return self.mfa

    @property
    def mfa_factor_generation(self) -> int | None:
        return self.mfg


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _sign(payload_b64: str, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    return _b64encode(digest)


def _pack(payload: dict, secret: str) -> str:
    payload_b64 = _b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{SESSION_TOKEN_PREFIX}.{payload_b64}.{_sign(payload_b64, secret)}"


def _unpack(token: str, secret: str) -> dict | None:
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != SESSION_TOKEN_PREFIX:
        return None
    payload_b64, signature = parts[1], parts[2]
    if not hmac.compare_digest(_sign(payload_b64, secret), signature):
        return None
    try:
        payload = json.loads(_b64decode(payload_b64))
    except (ValueError, UnicodeDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def issue_session_token(
    user_id: str,
    secret: str,
    ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
    *,
    session_id: str | None = None,
    issued_after_ms: int | None = None,
    mfa_assured: bool = False,
    mfa_factor_generation: int | None = None,
) -> tuple[str, int]:
    """Issue a v1 token, preserving a session id when rotating.

    ``iat`` and ``exp`` stay in epoch seconds for wire compatibility. ``iat_ms``
    supplies the precision required by per-user revocation watermarks. Tokens
    issued before that claim existed remain verifiable through the legacy
    fallback in :func:`verify_session_token`.
    """

    if (
        not isinstance(user_id, str)
        or not user_id
        or user_id != user_id.strip()
        or len(user_id) > 255
    ):
        raise ValueError("user_id must be a nonempty string")
    if session_id is not None and (
        not isinstance(session_id, str)
        or not session_id
        or session_id != session_id.strip()
        or len(session_id) > 128
    ):
        raise ValueError("session_id must be a nonempty string no longer than 128 characters")
    if issued_after_ms is not None and (
        type(issued_after_ms) is not int or issued_after_ms < 0
    ):
        raise ValueError("issued_after_ms must be a nonnegative integer")
    if type(mfa_assured) is not bool:
        raise ValueError("mfa_assured must be a boolean")
    if mfa_assured:
        if (
            type(mfa_factor_generation) is not int
            or not 1 <= mfa_factor_generation <= MAX_MFA_FACTOR_GENERATION
        ):
            raise ValueError(
                "mfa_factor_generation must be a positive integer for an assured session"
            )
    elif mfa_factor_generation is not None:
        raise ValueError("an unassured session cannot carry an MFA factor generation")

    issued_at_ms = int(time.time() * 1000)
    if issued_after_ms is not None:
        issued_at_ms = max(issued_at_ms, issued_after_ms + 1)
    issued_at = issued_at_ms // 1000
    expires_at = issued_at + ttl_seconds
    payload = {
        "typ": "session",
        "uid": user_id,
        "iat": issued_at,
        "iat_ms": issued_at_ms,
        "exp": expires_at,
        "jti": secrets.token_hex(16),
        # New sessions use 128 bits. A supplied id may be a shorter legacy sid
        # that must remain stable across a post-upgrade rotation.
        "sid": session_id or secrets.token_hex(16),
        "mfa": mfa_assured,
        "mfg": mfa_factor_generation,
    }
    return _pack(payload, secret), expires_at


def verify_session_token(token: str, secret: str) -> SessionClaims | None:
    """Return strict claims for one authentic, unexpired session token."""

    payload = _unpack(token, secret)
    if payload is None or payload.get("typ") != "session":
        return None
    user_id = payload.get("uid")
    session_id = payload.get("sid")
    issued_at = payload.get("iat")
    issued_at_ms = payload.get("iat_ms")
    expires_at = payload.get("exp")
    mfa_assured = payload.get("mfa", False)
    mfa_factor_generation = payload.get("mfg")
    if (
        not isinstance(user_id, str)
        or not user_id
        or user_id != user_id.strip()
        or len(user_id) > 255
    ):
        return None
    if (
        not isinstance(session_id, str)
        or not session_id
        or session_id != session_id.strip()
        or len(session_id) > 128
    ):
        return None
    if type(issued_at) is not int or issued_at < 0:
        return None
    if type(expires_at) is not int or expires_at <= issued_at:
        return None
    if issued_at_ms is None:
        # Every pre-M8 v1 token already carried second-precision iat/sid/exp.
        issued_at_ms = issued_at * 1000
    elif (
        type(issued_at_ms) is not int
        or issued_at_ms < 0
        or issued_at_ms // 1000 != issued_at
    ):
        return None
    if time.time() >= expires_at:
        return None
    if type(mfa_assured) is not bool:
        return None
    if mfa_assured:
        if (
            type(mfa_factor_generation) is not int
            or not 1 <= mfa_factor_generation <= MAX_MFA_FACTOR_GENERATION
        ):
            return None
    elif mfa_factor_generation is not None:
        return None
    return SessionClaims(
        uid=user_id,
        sid=session_id,
        iat=issued_at,
        iat_ms=issued_at_ms,
        exp=expires_at,
        mfa=mfa_assured,
        mfg=mfa_factor_generation,
    )


def verify_session_claims(token: str, secret: str) -> SessionClaims | None:
    """Compatibility alias for the canonical strict token verifier."""

    return verify_session_token(token, secret)


def sign_oidc_state(data: dict, secret: str) -> str:
    payload = {"typ": "oidc-state", "iat": int(time.time()), **data}
    return _pack(payload, secret)


def verify_oidc_state(state: str, secret: str, max_age_seconds: int = STATE_MAX_AGE_SECONDS) -> dict | None:
    payload = _unpack(state, secret)
    if payload is None or payload.get("typ") != "oidc-state":
        return None
    issued_at = payload.get("iat")
    if not isinstance(issued_at, int) or time.time() - issued_at > max_age_seconds:
        return None
    return payload


APPROVAL_TOKEN_MAX_AGE_SECONDS = 15 * 60
GENERATED_ASSET_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60


def sign_approval_token(user_id: str, tool_config_id: str, secret: str) -> str:
    """Signed proof that ``user_id`` approved running ``tool_config_id``.

    The chat runtime trusts this token (not a client-supplied id list) as the
    approval artifact for an approval-required MCP tool.
    """
    payload = {"typ": "tool-approval", "iat": int(time.time()), "uid": user_id, "tcid": tool_config_id}
    return _pack(payload, secret)


def verify_approval_token(
    token: str,
    user_id: str,
    secret: str,
    max_age_seconds: int = APPROVAL_TOKEN_MAX_AGE_SECONDS,
) -> str | None:
    """Return the approved tool-config id if the token is valid for ``user_id``."""
    payload = _unpack(token, secret)
    if payload is None or payload.get("typ") != "tool-approval":
        return None
    issued_at = payload.get("iat")
    if not isinstance(issued_at, int) or time.time() - issued_at > max_age_seconds:
        return None
    if payload.get("uid") != user_id:
        return None
    tool_config_id = payload.get("tcid")
    return tool_config_id if isinstance(tool_config_id, str) and tool_config_id else None


def sign_asset_token(
    name: str,
    secret: str,
    ttl_seconds: int = GENERATED_ASSET_TOKEN_TTL_SECONDS,
) -> str:
    """Sign a short-lived capability token for one generated asset name."""
    now = int(time.time())
    return _pack(
        {
            "typ": "generated-asset",
            "name": name,
            "iat": now,
            "exp": now + ttl_seconds,
        },
        secret,
    )


def verify_asset_token(token: str, name: str, secret: str) -> bool:
    """Return whether ``token`` authorizes this exact, unexpired asset."""
    payload = _unpack(token, secret)
    if payload is None or payload.get("typ") != "generated-asset":
        return False
    if payload.get("name") != name:
        return False
    expires_at = payload.get("exp")
    return isinstance(expires_at, int) and time.time() <= expires_at


def asset_token_matches(token: str, name: str, secret: str) -> bool:
    """Return whether ``token`` was genuinely signed for this asset name.

    Expiry is deliberately ignored: link refresh re-signs URLs the server
    once issued, and an expired-but-authentic token is exactly the case
    refresh exists for. A forged token, or one signed for another asset,
    never matches — so a bare filename can never be laundered into a
    working link.
    """
    payload = _unpack(token, secret)
    if payload is None or payload.get("typ") != "generated-asset":
        return False
    return payload.get("name") == name
