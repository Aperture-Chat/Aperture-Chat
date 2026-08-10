"""End-to-end tests for the real OIDC SSO flow.

A fake identity provider is simulated by monkeypatching the discovery fetch and
code exchange, while ID-token signature validation runs the REAL PyJWT path
against an RSA keypair generated per test session — so issuer, audience, nonce,
expiry, and signature checks are all genuinely exercised.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlparse

import jwt
import pyotp
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.core import oidc
from app.core.config import Settings, get_settings
from app.core.sessions import issue_session_token
from app.main import app
from app.models.schemas import DEFAULT_USER_GROUP_ID
from app.repositories.deps import get_store

client = TestClient(app, follow_redirects=False)

ISSUER = "https://login.microsoftonline.com/example/v2.0"
CLIENT_ID = "aperture-example-client"
JWKS_URI = f"{ISSUER}/discovery/v2.0/keys"
DISCOVERY = {
    "issuer": ISSUER,
    "authorization_endpoint": f"{ISSUER}/oauth2/v2.0/authorize",
    "token_endpoint": f"{ISSUER}/oauth2/v2.0/token",
    "jwks_uri": JWKS_URI,
}

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_KEY = _PRIVATE_KEY.public_key()


class _FakeJwkClient:
    def get_signing_key_from_jwt(self, token: str) -> SimpleNamespace:
        return SimpleNamespace(key=_PUBLIC_KEY)


@pytest.fixture(autouse=True)
def reset_store(monkeypatch: pytest.MonkeyPatch):
    get_settings.cache_clear()
    get_store.cache_clear()
    monkeypatch.setitem(oidc._jwk_clients, JWKS_URI, _FakeJwkClient())
    yield
    get_store.cache_clear()
    get_settings.cache_clear()


def _sign_id_token(
    email: str,
    nonce: str,
    *,
    name: str = "Test Person",
    issuer: str = ISSUER,
    audience: str = CLIENT_ID,
    expires_in: int = 600,
    # Matches the seeded binding for jane.smith@example.com: existing SSO
    # accounts are subject-bound, so tokens must present the linked subject.
    subject: str = "entra-user-001",
    extra_claims: dict | None = None,
) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "iss": issuer,
            "aud": audience,
            "sub": subject,
            "iat": now,
            "exp": now + expires_in,
            "email": email,
            "name": name,
            "nonce": nonce,
            **(extra_claims or {}),
        },
        _PRIVATE_KEY,
        algorithm="RS256",
    )


def _start_authorize(monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    """Run the authorize redirect and return (state, nonce) from the IdP URL."""
    monkeypatch.setattr(oidc, "fetch_discovery_document", lambda issuer_url: DISCOVERY)
    response = client.get("/api/auth/sso/sso-entra-example/authorize")
    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith(DISCOVERY["authorization_endpoint"])
    params = parse_qs(urlparse(location).query)
    assert params["client_id"] == [CLIENT_ID]
    assert params["response_type"] == ["code"]
    assert params["redirect_uri"][0].endswith("/api/auth/sso/callback")
    assert "openid" in params["scope"][0]
    # PKCE is always attached: S256 challenge derived from a per-flow verifier.
    assert params["code_challenge_method"] == ["S256"]
    assert len(params["code_challenge"][0]) >= 43
    return params["state"][0], params["nonce"][0]


def _run_callback(
    monkeypatch: pytest.MonkeyPatch,
    id_token: str,
    state: str,
    expected_secret: str = "entra-client-secret-651df904",
):
    def fake_exchange(token_endpoint, client_id, client_secret, code, redirect_uri, code_verifier=None):
        assert token_endpoint == DISCOVERY["token_endpoint"]
        assert client_id == CLIENT_ID
        assert client_secret == expected_secret
        assert code == "fake-auth-code"
        assert redirect_uri.endswith("/api/auth/sso/callback")
        # PKCE: the verifier from the signed state must reach the exchange.
        assert isinstance(code_verifier, str) and len(code_verifier) >= 43
        return {"id_token": id_token, "access_token": "opaque"}

    monkeypatch.setattr(oidc, "exchange_authorization_code", fake_exchange)
    return client.get("/api/auth/sso/callback", params={"code": "fake-auth-code", "state": state})


def _fragment(response) -> str:
    return urlparse(response.headers["location"]).fragment


def test_full_oidc_flow_signs_in_existing_user(monkeypatch: pytest.MonkeyPatch) -> None:
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("jane.smith@example.com", nonce, name="Jane Smith")

    response = _run_callback(monkeypatch, id_token, state)

    assert response.status_code == 302
    fragment = _fragment(response)
    assert fragment.startswith("sso_session=")
    session_token = fragment.split("=", 1)[1]

    session = client.get("/api/auth/session", headers={"x-aperture-session": session_token})
    assert session.status_code == 200
    payload = session.json()
    assert payload["user"]["id"] == "user-jane"
    assert payload["user"]["auth_method"] == "sso"
    assert payload["bootstrap"]["me"]["id"] == "user-jane"
    assert get_store().audit_events[-1].action == "auth.login"


def test_oidc_required_mfa_returns_only_preauth_fragment_and_completes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    policy = client.patch(
        "/api/admin/tenants/tenant-example/mfa-policy",
        headers={"x-aperture-user": "user-admin"},
        json={"required": True, "expected_generation": 0},
    )
    assert policy.status_code == 200
    # Platform MFA on top of SSO is opt-in per config; enable it here so the
    # pre-session challenge path is exercised.
    get_store().sso_configs["sso-entra-example"].settings["require_platform_mfa"] = True
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("jane.smith@example.com", nonce, name="Jane Smith")

    callback = _run_callback(monkeypatch, id_token, state)

    assert callback.status_code == 302
    fragment = _fragment(callback)
    assert fragment.startswith("sso_mfa=")
    assert "sso_session=" not in fragment
    assert callback.headers["cache-control"] == "no-store"
    challenge_token = unquote(fragment.split("=", 1)[1])
    restored = client.post(
        "/api/auth/mfa/preauth/status",
        json={"challenge_token": challenge_token},
    )
    assert restored.status_code == 200
    assert restored.json()["purpose"] == "enroll"
    assert restored.json()["methods"] == ["totp"]

    enrollment = client.post(
        "/api/auth/mfa/enroll",
        json={"challenge_token": challenge_token},
    )
    assert enrollment.status_code == 201
    completed = client.post(
        "/api/auth/mfa/enroll/confirm",
        json={
            "enrollment_token": enrollment.json()["enrollment_token"],
            "code": pyotp.TOTP(enrollment.json()["secret"]).now(),
        },
    )
    assert completed.status_code == 200
    assert completed.json()["session"]["auth_method"] == "sso"
    assert completed.json()["session"]["mfa_assured"] is True
    assert completed.json()["session"]["mfa_factor_generation"] > 0


def test_oidc_callback_rejects_config_deleted_during_identity_provider_exchange(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state, _nonce = _start_authorize(monkeypatch)
    email = "race-created-user@example.com"

    def delete_config_before_returning_claims(*_args, **_kwargs):
        del get_store().sso_configs["sso-entra-example"]
        return {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "sub": "race-created-subject",
            "email": email,
            "name": "Race User",
        }

    monkeypatch.setattr(oidc, "validate_id_token", delete_config_before_returning_claims)
    callback = _run_callback(monkeypatch, "validation-is-monkeypatched", state)

    assert callback.status_code == 302
    fragment = _fragment(callback)
    assert fragment.startswith("sso_error=")
    assert "sso_session=" not in fragment
    assert "sso_mfa=" not in fragment
    assert not any(user.email == email for user in get_store().users.values())
    assert not any(
        event.action == "auth.login" and event.metadata.get("email") == email
        for event in get_store().audit_events
    )


def test_sso_config_replacement_invalidates_existing_mfa_challenge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    policy = client.patch(
        "/api/admin/tenants/tenant-example/mfa-policy",
        headers={"x-aperture-user": "user-admin"},
        json={"required": True, "expected_generation": 0},
    )
    assert policy.status_code == 200
    get_store().sso_configs["sso-entra-example"].settings["require_platform_mfa"] = True
    state, nonce = _start_authorize(monkeypatch)
    callback = _run_callback(
        monkeypatch,
        _sign_id_token("jane.smith@example.com", nonce),
        state,
    )
    challenge_token = unquote(_fragment(callback).split("=", 1)[1])

    # SSO management is owner-first by default; tenant admins need the
    # explicit platform-settings delegation to touch configs.
    updated = client.patch(
        "/api/admin/sso-configs/sso-entra-example",
        headers={"x-aperture-user": "user-owner"},
        json={"client_id": "replacement-client-id"},
    )
    assert updated.status_code == 200
    stale = client.post(
        "/api/auth/mfa/preauth/status",
        json={"challenge_token": challenge_token},
    )
    assert stale.status_code == 401
    assert "session" not in stale.json()


def test_full_oidc_flow_jit_provisions_new_user(monkeypatch: pytest.MonkeyPatch) -> None:
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("new.attorney@example.com", nonce, name="New Attorney", subject="oid-777")

    response = _run_callback(monkeypatch, id_token, state)

    assert response.status_code == 302
    assert _fragment(response).startswith("sso_session=")
    store = get_store()
    created = next(user for user in store.users.values() if user.email == "new.attorney@example.com")
    assert created.display_name == "New Attorney"
    assert created.role == "USER"
    assert created.entra_object_id == "oid-777"
    assert created.auth_method == "sso"
    assert created.group_ids == [DEFAULT_USER_GROUP_ID]


def test_full_oidc_flow_respects_default_group_policy_off(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    store.platform_settings.default_user_group_enabled = False
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("manual.assignment@example.com", nonce, name="Manual Assignment", subject="oid-778")

    response = _run_callback(monkeypatch, id_token, state)

    assert response.status_code == 302
    assert _fragment(response).startswith("sso_session=")
    created = next(user for user in store.users.values() if user.email == "manual.assignment@example.com")
    assert created.group_ids == []


def test_callback_rejects_wrong_issuer(monkeypatch: pytest.MonkeyPatch) -> None:
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("jane.smith@example.com", nonce, issuer="https://evil.example.test")

    response = _run_callback(monkeypatch, id_token, state)

    assert response.status_code == 302
    assert "sso_error=" in _fragment(response)
    assert "validation%20failed" in _fragment(response) or "validation" in _fragment(response)


def test_callback_rejects_wrong_audience(monkeypatch: pytest.MonkeyPatch) -> None:
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("jane.smith@example.com", nonce, audience="some-other-app")

    response = _run_callback(monkeypatch, id_token, state)
    assert "sso_error=" in _fragment(response)


def test_callback_rejects_wrong_nonce(monkeypatch: pytest.MonkeyPatch) -> None:
    state, _nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("jane.smith@example.com", "attacker-chosen-nonce")

    response = _run_callback(monkeypatch, id_token, state)
    assert "sso_error=" in _fragment(response)
    assert "nonce" in _fragment(response)


def test_callback_rejects_expired_id_token(monkeypatch: pytest.MonkeyPatch) -> None:
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("jane.smith@example.com", nonce, expires_in=-300)

    response = _run_callback(monkeypatch, id_token, state)
    assert "sso_error=" in _fragment(response)


def test_callback_rejects_email_outside_allowed_domains(monkeypatch: pytest.MonkeyPatch) -> None:
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("intruder@outside.test", nonce)

    response = _run_callback(monkeypatch, id_token, state)
    assert "sso_error=" in _fragment(response)
    assert "outside%20the%20domains" in _fragment(response)


def test_callback_rejects_tampered_state(monkeypatch: pytest.MonkeyPatch) -> None:
    _state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("jane.smith@example.com", nonce)

    response = _run_callback(monkeypatch, id_token, "v1.dGFtcGVyZWQ.dGFtcGVyZWQ")
    assert response.status_code == 302
    assert "sso_error=" in _fragment(response)


def test_callback_reports_idp_error_honestly(monkeypatch: pytest.MonkeyPatch) -> None:
    response = client.get(
        "/api/auth/sso/callback",
        params={"error": "access_denied", "error_description": "User cancelled sign-in."},
    )
    assert response.status_code == 302
    assert "sso_error=" in _fragment(response)
    assert "cancelled" in _fragment(response).replace("%20", " ")


def test_authorize_requires_fully_configured_provider() -> None:
    store = get_store()
    store.sso_configs["sso-entra-example"].secret_set = False

    response = client.get("/api/auth/sso/sso-entra-example/authorize")
    assert response.status_code == 404
    assert "not fully configured" in response.json()["detail"]

    missing = client.get("/api/auth/sso/never-existed/authorize")
    assert missing.status_code == 404


def test_saml_config_is_not_exposed_as_public_login_option() -> None:
    config = get_store().sso_configs["sso-entra-example"]
    config.provider = "saml"
    config.settings = {**config.settings, "protocol": "SAML"}

    response = client.get("/api/auth/options")

    assert response.status_code == 200
    assert response.json()["providers"] == []


def test_saml_authorize_returns_explicit_not_implemented() -> None:
    config = get_store().sso_configs["sso-entra-example"]
    config.provider = "saml"
    config.settings = {**config.settings, "protocol": "SAML"}

    response = client.get("/api/auth/sso/sso-entra-example/authorize")

    assert response.status_code == 501
    assert response.json()["detail"] == (
        "Only OIDC sign-in is supported for live login. "
        "SAML configurations are stored but cannot authenticate users yet."
    )


def test_admin_saml_test_reports_unsupported_without_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = get_store().sso_configs["sso-entra-example"]
    config.provider = "saml"
    config.settings = {**config.settings, "protocol": "SAML"}

    def unexpected_network(*_args, **_kwargs):
        pytest.fail("SAML honesty check must not make an OIDC network request.")

    import app.routes.admin as admin_module

    monkeypatch.setattr(oidc, "fetch_discovery_document", unexpected_network)
    monkeypatch.setattr(admin_module.httpx, "get", unexpected_network)

    response = client.post(
        "/api/admin/sso-configs/sso-entra-example/test",
        headers={"x-aperture-user": "user-owner"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "unsupported",
        "message": (
            "Live verification is only available for OIDC providers. "
            "SAML settings are stored but cannot be tested or used for sign-in yet."
        ),
    }


def test_local_login_issues_signed_session_token() -> None:
    store = get_store()
    store.set_password_credential("user-owner", "owner-password-123")

    response = client.post(
        "/api/auth/login",
        json={"email": "owner@aperture.local", "auth_method": "local", "password": "owner-password-123"},
    )
    assert response.status_code == 200
    session = response.json()["session"]
    assert session["token"]
    assert session["expires_at"] > time.time()

    me = client.get("/api/auth/session", headers={"x-aperture-session": session["token"]})
    assert me.status_code == 200
    assert me.json()["user"]["id"] == "user-owner"


def test_session_resume_rotates_token_into_sliding_window() -> None:
    secret = get_settings().secret_key
    # Present a token partway through a short life; the rotated replacement
    # must be a different token whose expiry moves forward to a full TTL.
    aging_token, aging_expires_at = issue_session_token("user-owner", secret, ttl_seconds=3600)

    resumed = client.get("/api/auth/session", headers={"x-aperture-session": aging_token})
    assert resumed.status_code == 200
    session = resumed.json()["session"]
    assert session["token"]
    assert session["token"] != aging_token
    assert session["expires_at"] > aging_expires_at

    rotated = client.get("/api/auth/session", headers={"x-aperture-session": session["token"]})
    assert rotated.status_code == 200
    assert rotated.json()["user"]["id"] == "user-owner"


def test_session_tokens_reject_tampering_and_expiry(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = get_settings().secret_key
    token, _ = issue_session_token("user-owner", secret)

    tampered = token[:-4] + ("aaaa" if not token.endswith("aaaa") else "bbbb")
    rejected = client.get("/api/auth/session", headers={"x-aperture-session": tampered})
    assert rejected.status_code == 401

    expired, _ = issue_session_token("user-owner", secret, ttl_seconds=-10)
    stale = client.get("/api/auth/session", headers={"x-aperture-session": expired})
    assert stale.status_code == 401
    assert "expired" in stale.json()["detail"].lower() or "invalid" in stale.json()["detail"].lower()


def test_dev_header_auth_can_be_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APERTURE_DEV_HEADER_AUTH_ENABLED", "false")
    get_settings.cache_clear()

    header_auth = client.get("/api/bootstrap", headers={"x-aperture-user": "user-owner"})
    assert header_auth.status_code == 401

    token, _ = issue_session_token("user-owner", get_settings().secret_key)
    session_auth = client.get("/api/bootstrap", headers={"x-aperture-session": token})
    assert session_auth.status_code == 200


def test_production_rejects_public_default_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APERTURE_ENVIRONMENT", "production")
    monkeypatch.setenv("APERTURE_SECRET_KEY", "change-me-before-production")

    with pytest.raises(RuntimeError, match="public default"):
        Settings()


def test_production_ignores_dev_header_but_accepts_signed_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APERTURE_ENVIRONMENT", "production")
    monkeypatch.setenv("APERTURE_SECRET_KEY", "x" * 40)
    get_settings.cache_clear()

    header_auth = client.get("/api/bootstrap", headers={"x-aperture-user": "user-owner"})
    assert header_auth.status_code == 401

    token, _ = issue_session_token("user-owner", get_settings().secret_key)
    session_auth = client.get("/api/bootstrap", headers={"x-aperture-session": token})
    assert session_auth.status_code == 200


def test_admin_sso_test_endpoint_verifies_issuer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(oidc, "fetch_discovery_document", lambda issuer_url: DISCOVERY)

    class _FakeJwksResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"keys": [{"kid": "a"}, {"kid": "b"}]}

    import app.routes.admin as admin_module

    monkeypatch.setattr(admin_module.httpx, "get", lambda *args, **kwargs: _FakeJwksResponse())

    response = client.post(
        "/api/admin/sso-configs/sso-entra-example/test",
        headers={"x-aperture-user": "user-owner"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["issuer"] == ISSUER
    assert payload["token_endpoint"] == DISCOVERY["token_endpoint"]
    assert any(check["name"] == "Signing keys (JWKS)" and check["status"] == "ok" for check in payload["checks"])


def test_admin_can_delete_sso_config() -> None:
    response = client.request(
        "DELETE",
        "/api/admin/sso-configs/sso-entra-example",
        headers={"x-aperture-user": "user-owner"},
    )
    assert response.status_code == 200
    assert response.json() == {"status": "deleted", "id": "sso-entra-example"}
    assert "sso-entra-example" not in get_store().sso_configs

    options = client.get("/api/auth/options")
    assert options.json()["providers"] == []


def test_admin_sso_test_endpoint_reports_unreachable_issuer(monkeypatch: pytest.MonkeyPatch) -> None:
    def failing_discovery(issuer_url: str) -> dict:
        raise oidc.OidcError(f"Could not fetch OIDC discovery document from {issuer_url}: connection refused")

    monkeypatch.setattr(oidc, "fetch_discovery_document", failing_discovery)

    response = client.post(
        "/api/admin/sso-configs/sso-entra-example/test",
        headers={"x-aperture-user": "user-owner"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "failed"
    assert "Could not fetch" in payload["message"]


def test_oidc_login_rejects_blocked_jwks_uri_before_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    blocked_discovery = {**DISCOVERY, "jwks_uri": "http://169.254.169.254/latest/meta-data/jwks"}

    state, nonce = _start_authorize(monkeypatch)
    monkeypatch.setattr(oidc, "fetch_discovery_document", lambda issuer_url: blocked_discovery)
    id_token = _sign_id_token("jane.smith@example.com", nonce)

    response = _run_callback(monkeypatch, id_token, state)

    assert response.status_code == 302
    fragment = _fragment(response)
    assert "sso_error=" in fragment
    assert "JWKS" in fragment
    assert "metadata" in fragment or "link-local" in fragment


# --- SSO JIT tenant-admin escalation guard (security finding #13) ---


def test_default_role_downgrades_tenant_admin_when_policy_forbids() -> None:
    from app.models.schemas import Role, SsoConfig
    from app.routes.auth import _default_role

    store = get_store()
    store.platform_settings.tenant_admins_can_create_admins = False
    cfg = SsoConfig(
        id="sso-jit-1",
        tenant_id="tenant-example",
        provider="oidc",
        issuer_url="https://issuer.example",
        client_id="cid",
        settings={"default_role": "TENANT_ADMIN", "authored_by_role": "TENANT_ADMIN"},
    )
    assert _default_role(cfg, store) == Role.USER


def test_default_role_honors_tenant_admin_when_owner_authored_and_policy_allows() -> None:
    from app.models.schemas import Role, SsoConfig
    from app.routes.auth import _default_role

    store = get_store()
    store.platform_settings.tenant_admins_can_create_admins = True
    cfg = SsoConfig(
        id="sso-jit-2",
        tenant_id="tenant-example",
        provider="oidc",
        issuer_url="https://issuer.example",
        client_id="cid",
        settings={"default_role": "TENANT_ADMIN", "authored_by_role": "PLATFORM_OWNER"},
    )
    assert _default_role(cfg, store) == Role.TENANT_ADMIN


def test_default_role_downgrades_tenant_admin_authored_even_when_policy_allows() -> None:
    from app.models.schemas import Role, SsoConfig
    from app.routes.auth import _default_role

    store = get_store()
    store.platform_settings.tenant_admins_can_create_admins = True
    cfg = SsoConfig(
        id="sso-jit-3",
        tenant_id="tenant-example",
        provider="oidc",
        issuer_url="https://issuer.example",
        client_id="cid",
        settings={"default_role": "TENANT_ADMIN", "authored_by_role": "TENANT_ADMIN"},
    )
    assert _default_role(cfg, store) == Role.USER


def test_sso_config_create_stamps_author_role() -> None:
    resp = client.post(
        "/api/admin/sso-configs",
        headers={"x-aperture-user": "user-owner"},
        json={
            "id": "sso-stamp",
            "provider": "oidc",
            "issuer_url": "https://issuer.example",
            "client_id": "cid",
            "settings": {"default_role": "USER"},
        },
    )
    assert resp.status_code == 201
    assert resp.json()["settings"]["authored_by_role"] == "PLATFORM_OWNER"


def test_sso_login_skips_platform_mfa_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """IdP MFA is trusted: tenant MFA policy alone never double-challenges SSO."""
    policy = client.patch(
        "/api/admin/tenants/tenant-example/mfa-policy",
        headers={"x-aperture-user": "user-admin"},
        json={"required": True, "expected_generation": 0},
    )
    assert policy.status_code == 200
    state, nonce = _start_authorize(monkeypatch)
    callback = _run_callback(monkeypatch, _sign_id_token("jane.smith@example.com", nonce), state)

    assert callback.status_code == 302
    fragment = _fragment(callback)
    assert fragment.startswith("sso_session=")
    assert "sso_mfa=" not in fragment


def test_callback_rejects_explicitly_unverified_email(monkeypatch: pytest.MonkeyPatch) -> None:
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token(
        "jane.smith@example.com",
        nonce,
        extra_claims={"email_verified": False},
    )
    callback = _run_callback(monkeypatch, id_token, state)
    fragment = _fragment(callback)
    assert fragment.startswith("sso_error=")
    assert "unverified" in unquote(fragment)


def test_callback_rejects_subject_mismatch_for_bound_sso_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A recycled email presenting a different IdP subject never takes over."""
    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token("jane.smith@example.com", nonce, subject="different-subject")
    callback = _run_callback(monkeypatch, id_token, state)
    fragment = _fragment(callback)
    assert fragment.startswith("sso_error=")
    assert "different identity" in unquote(fragment)
    # No session was issued and the binding is unchanged.
    assert get_store().users["user-jane"].entra_object_id == "entra-user-001"


def test_sso_group_claim_mapping_syncs_managed_groups(monkeypatch: pytest.MonkeyPatch) -> None:
    """mapped_groups is live: membership in mapped workspace groups follows the
    token's group claim, while unmapped groups stay admin-managed."""
    store = get_store()
    jane = store.users["user-jane"]
    assert jane.group_ids == ["group-litigation"]

    state, nonce = _start_authorize(monkeypatch)
    id_token = _sign_id_token(
        "jane.smith@example.com",
        nonce,
        extra_claims={"groups": ["entra-finance-group"]},
    )
    callback = _run_callback(monkeypatch, id_token, state)
    assert _fragment(callback).startswith("sso_session=")
    # Litigation is mapped but absent from the claim -> removed; finance is
    # mapped and present -> granted.
    assert store.users["user-jane"].group_ids == ["group-finance"]

    # A token with no group claim leaves membership untouched.
    state2, nonce2 = _start_authorize(monkeypatch)
    callback2 = _run_callback(monkeypatch, _sign_id_token("jane.smith@example.com", nonce2), state2)
    assert _fragment(callback2).startswith("sso_session=")
    assert store.users["user-jane"].group_ids == ["group-finance"]
