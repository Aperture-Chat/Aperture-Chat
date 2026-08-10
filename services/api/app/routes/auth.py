from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import re
import secrets as py_secrets
from io import BytesIO
from urllib.parse import quote, urlencode, urlsplit
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import RedirectResponse

from app.core import oidc
from app.core.config import get_settings
from app.core.policy import api_access_allowed
from app.core.rate_limit import ProcessLocalTokenBucket
from app.core.sessions import (
    SessionClaims,
    sign_oidc_state,
    verify_oidc_state,
)
from app.models.schemas import (
    AuthBootstrapOwnerRequest,
    AuthMfaChallengeRequest,
    AuthMfaEnrollRequest,
    AuthMfaEnrollmentConfirmRequest,
    AuthMfaEnrollmentConfirmResponse,
    AuthMfaEnrollmentResponse,
    AuthMfaPreauthResponse,
    AuthMfaPreauthStatusResponse,
    AuthMfaRecoveryCodesResponse,
    AuthMfaSensitiveActionRequest,
    AuthMfaStatus,
    AuthMfaVerifyRequest,
    AuthLoginRequest,
    AuthLoginResponse,
    AuthOptionsResponse,
    AuthPasswordUpdateRequest,
    AuthProfileUpdateRequest,
    AuthProviderOption,
    AuthSession,
    Role,
    SsoConfig,
    Tenant,
    User,
    UserApiKeyCreateResponse,
    UserApiKeyStatus,
    now_utc,
)
from app.repositories.deps import get_store
from app.repositories.application_state import MfaChallengeState, MfaStateConflictError
from app.repositories.seed import (
    MfaTemporarilyLockedError,
    MfaVerificationError,
    SeedStore,
    SessionUserStateError,
)
from app.routes.bootstrap import bootstrap_payload
from app.core import clock as clock  # noqa: PLC0414 — shared UTC clock
from app.core.usage_budget import utc_usage_date
from app.models.schemas import MyUsageBudgetCap, MyUsageBudgetResponse
from app.repositories.deps import get_usage_budget_repository
from app.repositories.usage_budgets import TenantUsageBudgetRepository
from app.routes.dependencies import (
    AuthenticatedSession,
    current_signed_session,
    current_user,
    optional_signed_session,
)
from app.core.tenancy import require_request_tenant

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger("aperture.auth")

# Credential stuffing targets one account at a time, so the strict sign-in
# budget belongs to the account rather than to the network address: a whole
# office behind one NAT (or every user behind this deployment's reverse proxy)
# would otherwise share a single bucket and lock each other out. Only failed
# attempts spend a token, so a user who genuinely signs in repeatedly is never
# throttled, while repeated guesses against one email are.
_LOGIN_FAILURE_BUCKETS = ProcessLocalTokenBucket(
    max_entries=get_settings().rate_limit_max_buckets,
    idle_ttl_seconds=get_settings().rate_limit_idle_ttl_seconds,
)


def _assert_login_attempts_available(email: str) -> None:
    """Reject a locked-out account before spending time on password hashing."""
    per_minute = get_settings().auth_rate_limit_per_minute
    allowed, retry_after = _LOGIN_FAILURE_BUCKETS.peek(f"login:{email}", per_minute)
    if allowed:
        return
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many failed sign-in attempts for this account. Try again shortly.",
        headers={"Retry-After": str(retry_after), "Cache-Control": "no-store"},
    )


def _record_login_failure(email: str) -> None:
    """Spend one of this account's attempts. Successful sign-ins spend none."""
    _LOGIN_FAILURE_BUCKETS.consume(
        f"login:{email}", get_settings().auth_rate_limit_per_minute
    )


PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024
# Avatars render at most a few dozen CSS pixels; this leaves headroom for HiDPI
# without carrying a photograph in every user record.
PROFILE_IMAGE_MAX_EDGE_PIXELS = 256
PROFILE_IMAGE_MAX_DATA_URL_CHARS = ((PROFILE_IMAGE_MAX_BYTES + 2) // 3) * 4 + 256
PROFILE_IMAGE_MAX_REMOTE_URL_CHARS = 2048


@router.get("/options", response_model=AuthOptionsResponse)
def auth_options(
    tenant: Tenant = Depends(require_request_tenant),
    store: SeedStore = Depends(get_store),
) -> AuthOptionsResponse:
    return AuthOptionsResponse(
        local_auth_enabled=get_settings().local_auth_enabled,
        bootstrap_required=store.bootstrap_required(),
        password_auth_enabled=(
            get_settings().local_auth_enabled
            and store.password_sign_in_available(tenant.id)
        ),
        providers=[
            _auth_provider_option(config)
            for config in store.sso_configs.values()
            if config.tenant_id == tenant.id and _sso_config_ready_for_login(config)
        ],
        tenant_branding=tenant,
        supported_sso_protocols=["OIDC"],
        deferred_sso_protocols=["SAML"],
    )


@router.post("/login", response_model=AuthLoginResponse | AuthMfaPreauthResponse)
def login(
    payload: AuthLoginRequest,
    response: Response,
    tenant: Tenant = Depends(require_request_tenant),
    store: SeedStore = Depends(get_store),
) -> AuthLoginResponse | AuthMfaPreauthResponse:
    email = _normalize_email(payload.email)
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email is required.")

    method = payload.auth_method.strip().lower() or "sso"
    if method == "sso":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="SSO sign-in uses the identity provider redirect flow. Start at /api/auth/sso/{config_id}/authorize.",
        )
    if method != "local":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported auth method.")

    _assert_login_attempts_available(email)
    try:
        user, credential_snapshot = _login_local(email, payload, tenant, store)
    except HTTPException as exc:
        # Charge only the outcomes an attacker can drive: a wrong password or an
        # unknown account. Policy refusals (SSO enforced, local sign-in off) are
        # deterministic for a given email and would just lock out the account.
        if exc.status_code == status.HTTP_401_UNAUTHORIZED:
            _record_login_failure(email)
        raise
    # Credential hashing runs outside the store lock. Bind its successful
    # result to the exact stored hash, then atomically recheck that hash and the
    # user before the durable MFA decision/session issuance. Security mutations
    # can proceed while hashing, but an old result cannot cross their cutoff.
    with store._store_lock:
        live_credential = store.password_credentials.get(user.id)
        credential_is_current = (
            live_credential is None and credential_snapshot is None
        ) or (
            live_credential is not None
            and credential_snapshot is not None
            and py_secrets.compare_digest(live_credential, credential_snapshot)
        )
        if store.users.get(user.id) is not user or not user.active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Session is invalid or expired. Sign in again.",
            )
        if not credential_is_current:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid local credentials.",
            )
        return _complete_local_primary_auth(
            user=user,
            response=response,
            store=store,
        )


@router.get("/session", response_model=AuthLoginResponse)
def current_session(
    response: Response,
    authenticated: AuthenticatedSession = Depends(current_signed_session),
    store: SeedStore = Depends(get_store),
) -> AuthLoginResponse:
    """Resume a session from a signed session token and rotate it.

    Returning a freshly signed token on every resume turns the session TTL
    into a sliding idle window: users who come back within the TTL stay
    signed in, while a token left unused past the TTL still expires honestly.
    """
    actor = authenticated.user
    _no_store(response)
    return AuthLoginResponse(
        user=actor,
        session=_issue_session(
            actor,
            actor.auth_method or "local",
            None,
            store,
            session_id=authenticated.claims.sid,
            presented_claims=authenticated.claims,
        ),
        bootstrap=bootstrap_payload(actor, store),
        must_change_password=store.password_is_temporary(actor.id),
    )


@router.post("/logout")
def logout(
    authenticated: AuthenticatedSession = Depends(current_signed_session),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    """Revoke the presented signed session family before reporting success."""

    actor = authenticated.user
    try:
        store.revoke_session_claims(
            authenticated.claims,
            tenant_id=actor.tenant_id,
            reason="logout",
        )
    except Exception as exc:  # noqa: BLE001 - logout must never report false success
        logger.exception("Session logout revocation failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session revocation is temporarily unavailable.",
        ) from exc
    store.record_audit(
        actor,
        "auth.logout",
        actor.id,
        {"scope": "current_session", "tenant_id": actor.tenant_id},
        runtime_state_changed=False,
    )
    return {"status": "logged_out"}


@router.post("/mfa/preauth/status", response_model=AuthMfaPreauthStatusResponse)
def mfa_preauth_status(
    payload: AuthMfaChallengeRequest,
    response: Response,
    store: SeedStore = Depends(get_store),
) -> AuthMfaPreauthStatusResponse:
    _no_store(response)
    try:
        challenge = store.mfa_challenge_status(payload.challenge_token)
    except MfaTemporarilyLockedError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={
                "Retry-After": str(exc.retry_after_seconds),
                "Cache-Control": "no-store",
            },
        ) from exc
    except MfaVerificationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.error("MFA challenge status lookup failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA verification is temporarily unavailable.",
        ) from exc
    pending = _mfa_preauth_response(payload.challenge_token, challenge)
    return AuthMfaPreauthStatusResponse(
        purpose=pending.purpose,
        expires_at=pending.expires_at,
        methods=pending.methods,
        attempts_remaining=pending.attempts_remaining,
    )


@router.post("/mfa/preauth/verify", response_model=AuthLoginResponse)
def mfa_preauth_verify(
    payload: AuthMfaVerifyRequest,
    response: Response,
    store: SeedStore = Depends(get_store),
) -> AuthLoginResponse:
    _no_store(response)
    with store._store_lock:
        return _verify_primary_mfa_and_finalize(payload, store)


@router.get("/mfa/status", response_model=AuthMfaStatus)
def mfa_status(
    response: Response,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> AuthMfaStatus:
    _no_store(response)
    try:
        policy, factor, unused = store.mfa_posture_for_user(actor)
    except Exception as exc:  # noqa: BLE001
        logger.error("MFA status lookup failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA status is temporarily unavailable.",
        ) from exc
    return AuthMfaStatus(
        enabled=factor is not None,
        tenant_required=policy.required,
        confirmed_at=factor.confirmed_at if factor is not None else None,
        recovery_codes_remaining=unused,
        can_disable=factor is not None and not policy.required,
    )


@router.post(
    "/mfa/enroll",
    response_model=AuthMfaEnrollmentResponse,
    status_code=status.HTTP_201_CREATED,
)
def mfa_enroll(
    payload: AuthMfaEnrollRequest,
    response: Response,
    authenticated: AuthenticatedSession | None = Depends(optional_signed_session),
    store: SeedStore = Depends(get_store),
) -> AuthMfaEnrollmentResponse:
    _no_store(response)
    with store._store_lock:
        return _begin_mfa_enrollment(payload, authenticated, store)


def _begin_mfa_enrollment(
    payload: AuthMfaEnrollRequest,
    authenticated: AuthenticatedSession | None,
    store: SeedStore,
) -> AuthMfaEnrollmentResponse:
    actor = authenticated.user if authenticated is not None else None
    if payload.challenge_token is None:
        if actor is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
        try:
            _policy, factor, _unused = store.mfa_posture_for_user(actor)
        except Exception as exc:  # noqa: BLE001
            logger.error("MFA enrollment posture lookup failed")
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="MFA enrollment is temporarily unavailable.",
            ) from exc
        if factor is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="MFA is already enabled. Disable it before enrolling a replacement factor.",
            )
        if store.password_is_temporary(actor.id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Change the temporary password before enrolling MFA.",
            )
        if actor.auth_method == "local":
            if not store.verify_password_credential(actor.id, payload.current_password):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Current password is incorrect.",
                )
        else:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Voluntary SSO enrollment requires a fresh identity-provider sign-in flow, which is not yet available.",
            )
    elif actor is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Use either a signed session or an enrollment challenge, not both.",
        )
    try:
        tenant = store.tenants.get(actor.tenant_id) if actor is not None and actor.tenant_id else None
        if tenant is None and payload.challenge_token is not None:
            challenge = store.mfa_challenge_status(payload.challenge_token)
            tenant = store.tenants.get(challenge.tenant_id or "")
        result = store.begin_totp_enrollment(
            expected_user=actor,
            auth_method=(actor.auth_method or "local") if actor is not None else "local",
            sso_config_id=None,
            source_challenge_token=payload.challenge_token,
            issuer_name=(tenant.chat_brand_name or tenant.name) if tenant is not None else "Aperture Chat",
        )
        return AuthMfaEnrollmentResponse.model_validate(result)
    except MfaTemporarilyLockedError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={
                "Retry-After": str(exc.retry_after_seconds),
                "Cache-Control": "no-store",
            },
        ) from exc
    except MfaVerificationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except MfaStateConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.error("MFA enrollment creation failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA enrollment is temporarily unavailable.",
        ) from exc


@router.post("/mfa/enroll/confirm", response_model=AuthMfaEnrollmentConfirmResponse)
def mfa_enroll_confirm(
    payload: AuthMfaEnrollmentConfirmRequest,
    response: Response,
    store: SeedStore = Depends(get_store),
) -> AuthMfaEnrollmentConfirmResponse:
    _no_store(response)
    with store._store_lock:
        return _confirm_totp_enrollment_and_finalize(payload, store)


@router.post("/mfa/recovery-codes/regenerate", response_model=AuthMfaRecoveryCodesResponse)
def regenerate_mfa_recovery_codes(
    payload: AuthMfaSensitiveActionRequest,
    response: Response,
    authenticated: AuthenticatedSession = Depends(current_signed_session),
    store: SeedStore = Depends(get_store),
) -> AuthMfaRecoveryCodesResponse:
    _no_store(response)
    if not authenticated.claims.mfa:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="An MFA-assured session is required.")
    try:
        codes = store.apply_mfa_sensitive_action(
            authenticated.user,
            action="regenerate-recovery",
            method=payload.method,
            code=payload.code,
        )
    except MfaVerificationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except MfaStateConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.error("MFA recovery-code regeneration failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA recovery codes are temporarily unavailable.",
        ) from exc
    store.record_audit(
        authenticated.user,
        "auth.mfa_recovery_codes_regenerated",
        authenticated.user.id,
        {"tenant_id": authenticated.user.tenant_id},
        runtime_state_changed=False,
    )
    return AuthMfaRecoveryCodesResponse(recovery_codes=codes)


@router.post("/mfa/disable")
def disable_mfa(
    payload: AuthMfaSensitiveActionRequest,
    response: Response,
    authenticated: AuthenticatedSession = Depends(current_signed_session),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    _no_store(response)
    if not authenticated.claims.mfa:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="An MFA-assured session is required.")
    try:
        store.apply_mfa_sensitive_action(
            authenticated.user,
            action="disable",
            method=payload.method,
            code=payload.code,
        )
    except MfaVerificationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except MfaStateConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.error("MFA disable failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA settings are temporarily unavailable.",
        ) from exc
    store.record_audit(
        authenticated.user,
        "auth.mfa_disabled",
        authenticated.user.id,
        {"tenant_id": authenticated.user.tenant_id},
        runtime_state_changed=False,
    )
    return {"status": "disabled"}


@router.get("/sso/{config_id}/authorize")
def sso_authorize(
    config_id: str,
    return_to: str | None = None,
    tenant: Tenant = Depends(require_request_tenant),
    store: SeedStore = Depends(get_store),
) -> RedirectResponse:
    """Begin the real OIDC authorization-code flow: redirect the browser to the IdP."""
    settings = get_settings()
    config = store.sso_configs.get(config_id)
    if config is None or config.tenant_id != tenant.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This SSO provider is not fully configured. An administrator must save the issuer URL, client ID, and client secret first.",
        )
    protocol = _config_protocol(config)
    if protocol != "OIDC":
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Only OIDC sign-in is supported for live login. SAML configurations are stored but cannot authenticate users yet.",
        )
    if not _sso_config_ready_for_login(config):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This SSO provider is not fully configured. An administrator must save the issuer URL, client ID, and client secret first.",
        )
    web_origin = _validate_return_origin(return_to, tenant, store)
    try:
        discovery = oidc.fetch_discovery_document(config.issuer_url)
    except oidc.OidcError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    nonce = py_secrets.token_urlsafe(16)
    # PKCE (S256). The verifier travels inside the HMAC-signed state, so the
    # callback can complete on any API instance without server-side storage.
    # With a confidential client this is defense-in-depth against code
    # substitution and satisfies providers that mandate PKCE outright.
    code_verifier = py_secrets.token_urlsafe(48)
    code_challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("ascii")).digest())
        .rstrip(b"=")
        .decode("ascii")
    )
    state = sign_oidc_state(
        {
            "config_id": config.id,
            "tenant_id": tenant.id,
            "nonce": nonce,
            "return_to": web_origin,
            "pkce": code_verifier,
        },
        settings.secret_key,
    )
    query = urlencode(
        {
            "response_type": "code",
            "client_id": config.client_id,
            "redirect_uri": _sso_redirect_uri(),
            "scope": " ".join(config.scopes or ["openid", "email", "profile"]),
            "state": state,
            "nonce": nonce,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
    )
    return RedirectResponse(url=f"{discovery['authorization_endpoint']}?{query}", status_code=302)


@router.get("/sso/callback")
def sso_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
    store: SeedStore = Depends(get_store),
) -> RedirectResponse:
    """OIDC redirect URI: exchange the code, validate the ID token, and hand the SPA a session."""
    settings = get_settings()
    state_payload = verify_oidc_state(state, settings.secret_key) if state else None
    state_tenant = (
        store.tenants.get(str(state_payload.get("tenant_id")))
        if state_payload and state_payload.get("tenant_id")
        else None
    )
    try:
        return_to = _validate_return_origin(
            state_payload.get("return_to") if state_payload else None,
            state_tenant,
            store,
        )
    except HTTPException:
        return_to = _fallback_return_origin(state_tenant, store)

    if error:
        detail = error_description or error
        return _sso_error_redirect(return_to, f"The identity provider returned an error: {detail}")
    if not code or state_payload is None or state_tenant is None:
        return _sso_error_redirect(return_to, "The sign-in link is invalid or has expired. Start the sign-in again.")

    config = store.sso_configs.get(str(state_payload.get("config_id")))
    if (
        config is None
        or config.tenant_id != state_tenant.id
        or not _sso_config_ready_for_login(config)
    ):
        return _sso_error_redirect(return_to, "The SSO configuration used to start this sign-in is no longer available.")
    client_secret = store.configuration_secret("sso", config.id)
    if not client_secret:
        return _sso_error_redirect(return_to, "The SSO client secret is missing. An administrator must re-save it.")
    callback_config_id = config.id
    callback_tenant_id = config.tenant_id
    callback_issuer_url = config.issuer_url
    callback_client_id = config.client_id

    try:
        discovery = oidc.fetch_discovery_document(config.issuer_url)
        tokens = oidc.exchange_authorization_code(
            discovery["token_endpoint"],
            config.client_id,
            client_secret,
            code,
            _sso_redirect_uri(),
            code_verifier=(
                str(state_payload.get("pkce")) if state_payload.get("pkce") else None
            ),
        )
        claims = oidc.validate_id_token(
            tokens["id_token"],
            discovery["jwks_uri"],
            discovery["issuer"],
            config.client_id,
            expected_nonce=str(state_payload.get("nonce")) if state_payload.get("nonce") else None,
        )
    except oidc.OidcError as exc:
        return _sso_error_redirect(return_to, str(exc))

    email = _email_from_claims(claims)
    if not email:
        return _sso_error_redirect(
            return_to,
            "The identity provider did not return an email claim. Grant the 'email' scope to this application.",
        )
    # Only an explicit false is rejected: many providers (including Entra)
    # simply omit the claim for accounts they fully manage.
    if claims.get("email_verified") is False:
        return _sso_error_redirect(
            return_to,
            f"The identity provider reports {email} as unverified. Verify the email address at the provider and sign in again.",
        )
    domains = _config_domains(config)
    if domains and email.rsplit("@", 1)[-1] not in domains:
        return _sso_error_redirect(
            return_to,
            f"{email} is outside the domains allowed for this SSO provider.",
        )

    display_name = str(claims.get("name") or "").strip() or None
    with store._store_lock:
        live_config = store.sso_configs.get(callback_config_id)
        live_secret = (
            store.configuration_secret("sso", callback_config_id)
            if live_config is not None
            else None
        )
        if (
            live_config is None
            or live_config.tenant_id != callback_tenant_id
            or live_config.issuer_url != callback_issuer_url
            or live_config.client_id != callback_client_id
            or not _sso_config_ready_for_login(live_config)
            or live_secret is None
            or not py_secrets.compare_digest(live_secret, client_secret)
        ):
            return _sso_error_redirect(
                return_to,
                "The SSO configuration changed during sign-in. Start the sign-in again.",
            )
        live_domains = _config_domains(live_config)
        if live_domains and email.rsplit("@", 1)[-1] not in live_domains:
            return _sso_error_redirect(
                return_to,
                f"{email} is outside the domains allowed for this SSO provider.",
            )
        try:
            user = _login_sso(email, display_name, claims, live_config, store)
        except HTTPException as exc:
            return _sso_error_redirect(return_to, str(exc.detail))
        _sync_sso_mapped_groups(user, claims, live_config, store)

        # The identity provider already authenticated this user, including any
        # MFA its own policy demands (e.g. Entra Conditional Access). The
        # platform's local authenticator is layered on top only when the SSO
        # config explicitly opts in — never as a silent double challenge.
        pending = None
        if bool(live_config.settings.get("require_platform_mfa", False)):
            try:
                pending = store.begin_primary_mfa_challenge(
                    user,
                    auth_method="sso",
                    sso_config_id=live_config.id,
                )
            except Exception:  # noqa: BLE001 - never bypass MFA on durable-state failure
                logger.error("OIDC MFA decision failed after primary authentication")
                return _sso_error_redirect(return_to, "Authentication is temporarily unavailable.")
        if pending is not None:
            challenge_token, _challenge = pending
            store.save_runtime_state()
            response = RedirectResponse(
                url=f"{return_to}/#sso_mfa={quote(challenge_token)}",
                status_code=302,
            )
            response.headers["Cache-Control"] = "no-store"
            return response

        issued = _issue_session(user, "sso", live_config.id, store)
        user.last_active = "Now"
        user.auth_method = "sso"
        store.record_audit(
            user,
            "auth.login",
            user.id,
            {
                "auth_method": "sso",
                "sso_config_id": live_config.id,
                "email": user.email,
                "issuer": discovery["issuer"],
            },
        )
        store.save_runtime_state()
        token = issued.token
        if token is None:  # AuthSession keeps token optional for non-login payloads.
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Session issuance is temporarily unavailable.",
            )
        response = RedirectResponse(
            url=f"{return_to}/#sso_session={quote(token)}",
            status_code=302,
        )
        response.headers["Cache-Control"] = "no-store"
        return response


@router.post("/bootstrap-owner", response_model=AuthLoginResponse, status_code=status.HTTP_201_CREATED)
def bootstrap_owner(
    payload: AuthBootstrapOwnerRequest,
    response: Response,
    store: SeedStore = Depends(get_store),
) -> AuthLoginResponse:
    _no_store(response)
    if not store.bootstrap_required():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="A platform owner already exists.")
    if not get_settings().local_auth_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bootstrap credentials are disabled.")

    email = _normalize_email(payload.email)
    display_name = payload.display_name.strip()
    _assert_bootstrap_identity(email, display_name, payload.password)

    user = User(
        id=_next_user_id(email, store),
        email=email,
        display_name=display_name,
        role=Role.PLATFORM_OWNER,
        active=True,
        last_active="Now",
        auth_method="local",
    )
    store.users[user.id] = user
    store.set_password_credential(user.id, payload.password)
    store.record_audit(
        user,
        "auth.bootstrap_owner_created",
        user.id,
        {"email": user.email, "role": user.role},
    )
    store.save_runtime_state()
    return AuthLoginResponse(
        user=user,
        session=_issue_session(user, "local", None, store),
        bootstrap=bootstrap_payload(user, store),
    )


@router.patch("/profile", response_model=User)
def update_profile(
    payload: AuthProfileUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> User:
    user = store.users.get(actor.id)
    if user is None or not user.active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unknown or inactive user.",
        )

    display_name = _optional_trim(payload.display_name)
    bio = _optional_trim(payload.bio)
    firm_name = _optional_trim(payload.firm_name)
    website_url = _optional_trim(payload.website_url)
    phone = _optional_trim(payload.phone)
    avatar_url = _optional_trim(payload.avatar_url)

    if display_name is not None:
        if not display_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Display name is required.")
        if len(display_name) > 120:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Display name is too long.")
        user.display_name = display_name
    if bio is not None:
        if len(bio) > 500:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bio must be 500 characters or fewer.")
        user.bio = bio or None
    if firm_name is not None:
        if len(firm_name) > 160:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Firm name must be 160 characters or fewer.")
        user.firm_name = firm_name or None
    if website_url is not None:
        if len(website_url) > 2048:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Website URL is too long.")
        if website_url and re.fullmatch(r"https?://\S+", website_url, flags=re.IGNORECASE) is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Website must use an http(s) URL.")
        user.website_url = website_url or None
    if phone is not None:
        if len(phone) > 40:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Phone number is too long.")
        user.phone = phone or None
    if avatar_url is not None:
        if avatar_url and not _looks_like_profile_image_reference(avatar_url):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Profile photo must be an http(s), relative, or data:image URL.",
            )
        if avatar_url:
            _assert_profile_image_size(avatar_url)
            avatar_url = _normalized_profile_image(avatar_url)
        user.avatar_url = avatar_url or None

    store.record_audit(
        user,
        "auth.profile_updated",
        user.id,
        {
            "display_name": user.display_name,
            "firm_set": bool(user.firm_name),
            "website_set": bool(user.website_url),
            "phone_set": bool(user.phone),
            "avatar_set": bool(user.avatar_url),
        },
    )
    store.save_runtime_state()
    return user


@router.post("/first-run-guide/seen", response_model=User)
def mark_first_run_guide_seen(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> User:
    user = store.users.get(actor.id)
    if user is None or not user.active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown or inactive user.")

    if user.first_run_guide_seen_at:
        return user

    user.first_run_guide_seen_at = now_utc().isoformat()
    store.record_audit(
        user,
        "auth.first_run_guide_seen",
        user.id,
        {"role": user.role, "seen_at": user.first_run_guide_seen_at},
    )
    store.save_runtime_state()
    return user


@router.post("/password")
def update_password(
    payload: AuthPasswordUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    with store._store_lock:
        return _update_password_locked(payload, actor, store)


def _update_password_locked(
    payload: AuthPasswordUpdateRequest,
    actor: User,
    store: SeedStore,
) -> dict[str, str]:
    user = store.users.get(actor.id)
    if user is None or not user.active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown or inactive user.")
    if user.auth_method != "local" or user.id not in store.password_credentials:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Password changes are only available for local password accounts.",
        )
    if not store.verify_password_credential(user.id, payload.current_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Current password is incorrect.")
    if len(payload.new_password) < 12:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Use a password with at least 12 characters.")
    if payload.current_password == payload.new_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Choose a new password.")

    try:
        store.advance_user_session_watermark(
            user.id,
            user.tenant_id,
            reason="self-password-change",
            updated_by=user.id,
            expected_user=user,
            expected_role=user.role,
        )
    except Exception as exc:  # noqa: BLE001 - never change credentials without revocation
        logger.exception("Password-change session revocation failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password change is temporarily unavailable.",
        ) from exc
    store.set_password_credential(user.id, payload.new_password)
    store.record_audit(user, "auth.password_updated", user.id, {"auth_method": user.auth_method})
    store.save_runtime_state()
    return {"status": "updated"}


@router.get("/api-key", response_model=UserApiKeyStatus)
def api_key_status(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> UserApiKeyStatus:
    record = store.user_api_keys.get(actor.id)
    return UserApiKeyStatus(
        enabled=api_access_allowed(actor, store.groups, store.platform_settings),
        has_key=record is not None,
        masked_value=record.masked_value if record else None,
        created_at=record.created_at if record else None,
        last_used_at=record.last_used_at if record else None,
    )


@router.post("/api-key", response_model=UserApiKeyCreateResponse)
def create_api_key(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> UserApiKeyCreateResponse:
    if not api_access_allowed(actor, store.groups, store.platform_settings):
        detail = (
            "Personal API access is unavailable under the current service policy."
            if not store.platform_settings.downstream_api_enabled
            else "An administrator must enable API access for one of your platform groups first."
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=detail,
        )
    replacing = actor.id in store.user_api_keys
    record, secret_value = store.create_user_api_key(actor)
    store.record_audit(
        actor,
        "auth.api_key_rotated" if replacing else "auth.api_key_created",
        actor.id,
        {"key_prefix": record.key_prefix, "tenant_id": actor.tenant_id},
        runtime_state_changed=False,
    )
    return UserApiKeyCreateResponse(
        enabled=True,
        has_key=True,
        masked_value=record.masked_value,
        created_at=record.created_at,
        last_used_at=record.last_used_at,
        secret_value=secret_value,
    )


@router.delete("/api-key", response_model=UserApiKeyStatus)
def revoke_api_key(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> UserApiKeyStatus:
    revoked = store.revoke_user_api_key(actor.id)
    if revoked is not None:
        store.record_audit(
            actor,
            "auth.api_key_revoked",
            actor.id,
            {"key_prefix": revoked.key_prefix, "tenant_id": actor.tenant_id},
            runtime_state_changed=False,
        )
    return UserApiKeyStatus(
        enabled=api_access_allowed(actor, store.groups, store.platform_settings),
        has_key=False,
    )


def _complete_local_primary_auth(
    *,
    user: User,
    response: Response,
    store: SeedStore,
) -> AuthLoginResponse | AuthMfaPreauthResponse:
    try:
        pending = store.begin_primary_mfa_challenge(
            user,
            auth_method="local",
            sso_config_id=None,
        )
    except MfaTemporarilyLockedError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={
                "Retry-After": str(exc.retry_after_seconds),
                "Cache-Control": "no-store",
            },
        ) from exc
    except SessionUserStateError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is invalid or expired. Sign in again.",
        ) from exc
    except Exception as exc:  # noqa: BLE001 - primary auth must fail closed on SQL state
        logger.error("MFA decision failed after primary authentication")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is temporarily unavailable.",
        ) from exc
    _no_store(response)
    if pending is not None:
        token, challenge = pending
        response.status_code = status.HTTP_202_ACCEPTED
        return _mfa_preauth_response(token, challenge)

    issued_session = _issue_session(user, "local", None, store)
    user.last_active = "Now"
    user.auth_method = "local"
    store.record_audit(
        user,
        "auth.login",
        user.id,
        {"auth_method": "local", "sso_config_id": None, "email": user.email},
    )
    store.save_runtime_state()
    return AuthLoginResponse(
        user=user,
        session=issued_session,
        bootstrap=bootstrap_payload(user, store),
        must_change_password=store.password_is_temporary(user.id),
    )


def _login_local(
    email: str,
    payload: AuthLoginRequest,
    tenant: Tenant,
    store: SeedStore,
) -> tuple[User, str | None]:
    if not get_settings().local_auth_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Local sign-in is disabled.")
    user = _find_user_by_email(email, store, tenant_id=tenant.id, include_platform_owner=True)
    if user is None or not user.active or user.auth_method != "local":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown local account.")
    credential_snapshot = store.password_credentials.get(user.id)
    if not store.verify_password_credential(user.id, payload.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid local credentials.")
    enforced_config = _enforced_sso_config_for_domain(email, tenant.id, store)
    if enforced_config is not None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="SSO is enforced for this email domain; local sign-in is disabled. Use the configured identity provider.",
        )
    if user.role == Role.TENANT_ADMIN and store.platform_settings.require_sso_for_admins:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Organization policy requires admin accounts to sign in through SSO.",
        )
    return user, credential_snapshot


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


def _mfa_preauth_response(
    challenge_token: str,
    challenge: MfaChallengeState,
) -> AuthMfaPreauthResponse:
    methods = ["totp"]
    if challenge.purpose == "verify" and challenge.recovery_codes_remaining > 0:
        methods.append("recovery_code")
    return AuthMfaPreauthResponse(
        challenge_token=challenge_token,
        purpose=challenge.purpose,
        expires_at=challenge.expires_at,
        methods=methods,
        attempts_remaining=max(0, challenge.max_attempts - challenge.attempts),
    )


def _verify_primary_mfa_and_finalize(
    payload: AuthMfaVerifyRequest,
    store: SeedStore,
) -> AuthLoginResponse:
    try:
        user, auth_method, sso_config_id, generation = store.verify_primary_mfa_challenge(
            challenge_token=payload.challenge_token,
            method=payload.method,
            code=payload.code,
        )
    except MfaTemporarilyLockedError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={
                "Retry-After": str(exc.retry_after_seconds),
                "Cache-Control": "no-store",
            },
        ) from exc
    except MfaVerificationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.error("MFA verification failed because durable state is unavailable")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA verification is temporarily unavailable.",
        ) from exc
    return _finalize_authenticated_login(
        user,
        auth_method=auth_method,
        sso_config_id=sso_config_id,
        store=store,
        mfa_factor_generation=generation,
    )


def _confirm_totp_enrollment_and_finalize(
    payload: AuthMfaEnrollmentConfirmRequest,
    store: SeedStore,
) -> AuthMfaEnrollmentConfirmResponse:
    try:
        user, auth_method, sso_config_id, generation, recovery_codes = (
            store.confirm_totp_enrollment(
                enrollment_token=payload.enrollment_token,
                code=payload.code,
            )
        )
    except MfaTemporarilyLockedError as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={
                "Retry-After": str(exc.retry_after_seconds),
                "Cache-Control": "no-store",
            },
        ) from exc
    except MfaVerificationError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.error("MFA enrollment confirmation failed")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MFA enrollment is temporarily unavailable.",
        ) from exc
    store.record_audit(
        user,
        "auth.mfa_enabled",
        user.id,
        {"tenant_id": user.tenant_id, "factor_generation": generation},
        runtime_state_changed=False,
    )
    login = _finalize_authenticated_login(
        user,
        auth_method=auth_method,
        sso_config_id=sso_config_id,
        store=store,
        mfa_factor_generation=generation,
    )
    return AuthMfaEnrollmentConfirmResponse(
        **login.model_dump(),
        recovery_codes=recovery_codes,
    )


def _finalize_authenticated_login(
    user: User,
    *,
    auth_method: str,
    sso_config_id: str | None,
    store: SeedStore,
    mfa_factor_generation: int,
) -> AuthLoginResponse:
    issued_session = _issue_session(
        user,
        auth_method,
        sso_config_id,
        store,
        mfa_assured=True,
        mfa_factor_generation=mfa_factor_generation,
    )
    user.last_active = "Now"
    user.auth_method = auth_method
    store.record_audit(
        user,
        "auth.login",
        user.id,
        {
            "auth_method": auth_method,
            "sso_config_id": sso_config_id,
            "email": user.email,
            "mfa_assured": True,
            "mfa_factor_generation": mfa_factor_generation,
        },
    )
    store.save_runtime_state()
    return AuthLoginResponse(
        user=user,
        session=issued_session,
        bootstrap=bootstrap_payload(user, store),
        must_change_password=store.password_is_temporary(user.id),
    )


def _enforced_sso_config_for_domain(
    email: str,
    tenant_id: str,
    store: SeedStore,
) -> SsoConfig | None:
    domain = email.rsplit("@", 1)[-1].lower()
    for config in store.sso_configs.values():
        if config.tenant_id != tenant_id:
            continue
        if not _sso_config_ready_for_login(config):
            continue
        if not bool(config.settings.get("enforced", False)):
            continue
        if domain in _config_domains(config):
            return config
    return None


def _login_sso(
    email: str,
    display_name: str | None,
    claims: dict,
    config: SsoConfig,
    store: SeedStore,
) -> User:
    """Resolve or JIT-provision a user from a cryptographically verified ID token."""
    subject = str(claims.get("sub") or "").strip()
    existing = _find_user_by_email(email, store)
    if existing is not None:
        if not existing.active:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account is inactive.")
        if existing.tenant_id != config.tenant_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="SSO tenant does not match this account.")
        if subject:
            # Bind the account to the provider's stable subject. A different
            # subject presenting the same email means the address was reissued
            # to someone else at the IdP — never silently hand the account
            # over. An admin password reset (auth_method flips to "local")
            # is the recovery path; the next SSO login re-binds cleanly.
            if (
                existing.auth_method == "sso"
                and existing.entra_object_id
                and existing.entra_object_id != subject
            ):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=(
                        "This email now belongs to a different identity at the provider. "
                        "An administrator must reset the account before SSO sign-in can continue."
                    ),
                )
            if existing.entra_object_id != subject:
                existing.entra_object_id = subject
        return existing

    if not bool(config.settings.get("jit_provisioning", False)):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="JIT provisioning is disabled for this SSO provider.")

    role = _default_role(config, store)
    group_ids = _default_group_ids(config, [], store)
    subject = subject or f"jit-{uuid4()}"
    user = User(
        id=_next_user_id(email, store),
        tenant_id=config.tenant_id,
        email=email,
        display_name=display_name.strip() if display_name and display_name.strip() else _name_from_email(email),
        role=role,
        entra_object_id=subject,
        group_ids=group_ids,
        active=True,
        last_active="Never",
        auth_method="sso",
    )
    store.users[user.id] = user
    store.record_audit(
        user,
        "auth.user_jit_created",
        user.id,
        {"email": user.email, "sso_config_id": config.id, "group_ids": group_ids, "role": role, "subject": subject},
    )
    return user


def _issue_session(
    user: User,
    method: str,
    sso_config_id: str | None,
    store: SeedStore,
    *,
    session_id: str | None = None,
    presented_claims: SessionClaims | None = None,
    mfa_assured: bool | None = None,
    mfa_factor_generation: int | None = None,
) -> AuthSession:
    settings = get_settings()
    try:
        token, expires_at = store.issue_session_token_for_user(
            user,
            settings.secret_key,
            settings.session_ttl_seconds,
            session_id=session_id,
            presented_claims=presented_claims,
            mfa_assured=mfa_assured,
            mfa_factor_generation=mfa_factor_generation,
            auth_method="sso" if method == "sso" else "local",
        )
    except SessionUserStateError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is invalid or expired. Sign in again.",
        ) from exc
    except Exception as exc:  # noqa: BLE001 - never issue across an unknown cutoff
        logger.exception("Session watermark lookup failed during issuance")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session issuance is temporarily unavailable.",
        ) from exc
    return AuthSession(
        user_id=user.id,
        auth_method=method,
        sso_config_id=sso_config_id,
        token=token,
        expires_at=expires_at,
        mfa_assured=(presented_claims.mfa if presented_claims is not None else bool(mfa_assured)),
        mfa_factor_generation=(
            presented_claims.mfg if presented_claims is not None else mfa_factor_generation
        ),
    )


def _allowed_web_origins() -> list[str]:
    return get_settings().web_origin_list


def _tenant_return_origins(tenant: Tenant | None, store: SeedStore) -> list[str]:
    origins = _allowed_web_origins()
    if tenant is None:
        return origins if len(store.tenants) == 1 else []
    if len(store.tenants) == 1:
        return origins
    allowed: list[str] = []
    for origin in origins:
        parsed = urlsplit(origin)
        matched = store.tenant_by_host(parsed.hostname)
        if matched is not None and matched.id == tenant.id:
            allowed.append(origin.rstrip("/"))
    if tenant.custom_domain:
        custom_origin = f"https://{tenant.custom_domain}"
        if custom_origin not in allowed:
            allowed.append(custom_origin)
    return allowed


def _fallback_return_origin(tenant: Tenant | None, store: SeedStore) -> str:
    origins = _tenant_return_origins(tenant, store)
    if origins:
        return origins[0]
    return "http://localhost:5173"


def _validate_return_origin(
    return_to: str | None,
    tenant: Tenant | None,
    store: SeedStore,
) -> str:
    origins = _tenant_return_origins(tenant, store)
    if not origins:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This tenant does not have a configured sign-in return origin.",
        )
    default = origins[0]
    if not return_to:
        return default
    candidate = return_to.rstrip("/")
    if candidate not in origins:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The sign-in return origin is outside this tenant.",
        )
    return candidate


def _sso_redirect_uri() -> str:
    return f"{get_settings().api_base_url.rstrip('/')}/api/auth/sso/callback"


def _sso_error_redirect(return_to: str, message: str) -> RedirectResponse:
    response = RedirectResponse(
        url=f"{return_to}/#sso_error={quote(message[:600])}",
        status_code=302,
    )
    response.headers["Cache-Control"] = "no-store"
    return response


def _email_from_claims(claims: dict) -> str | None:
    for key in ("email", "preferred_username", "upn"):
        value = claims.get(key)
        if isinstance(value, str) and "@" in value:
            return _normalize_email(value)
    return None


def _config_protocol(config: SsoConfig) -> str:
    return str(config.settings.get("protocol") or ("SAML" if "saml" in config.provider.lower() else "OIDC")).upper()


def _auth_provider_option(config: SsoConfig) -> AuthProviderOption:
    mfa_methods = _mfa_methods(config)
    return AuthProviderOption(
        id=config.id,
        name=_provider_name(config.provider),
        provider=config.provider,
        protocol=_config_protocol(config),
        tenant_id=config.tenant_id,
        domains=_config_domains(config),
        enforced=bool(config.enabled and config.settings.get("enforced", True)),
        mfa_methods=mfa_methods,
        mfa_enforced=bool(config.settings.get("mfa_enforced", bool(mfa_methods))),
        mfa_notes=_string_setting(config, "mfa_notes"),
        start_url=f"/api/auth/sso/{config.id}/authorize",
    )


def _sso_config_ready_for_login(config: SsoConfig) -> bool:
    if not config.enabled or not _config_domains(config):
        return False

    # Only OIDC can complete a real, verified login today. SAML configurations are
    # stored for future support but must not appear as working sign-in options.
    if _config_protocol(config) != "OIDC":
        return False
    return bool(config.issuer_url.strip() and config.client_id.strip() and config.secret_set)


def _config_domains(config: SsoConfig) -> list[str]:
    raw_domains = config.settings.get("domains", [])
    if not isinstance(raw_domains, list):
        return []
    return [str(domain).strip().lower() for domain in raw_domains if str(domain).strip()]


def _default_role(config: SsoConfig, store: SeedStore) -> Role:
    raw_role = config.settings.get("default_role", Role.USER)
    try:
        role = Role(str(raw_role))
    except ValueError:
        return Role.USER
    if role == Role.PLATFORM_OWNER:
        return Role.USER
    if role == Role.TENANT_ADMIN:
        # A TENANT_ADMIN JIT default is honored only when the platform owner
        # authored the SSO config AND policy allows tenant-admin creation.
        # Otherwise SSO login cannot mint tenant admins behind the owner's back.
        authored_by_owner = config.settings.get("authored_by_role") == Role.PLATFORM_OWNER.value
        if not (authored_by_owner and store.platform_settings.tenant_admins_can_create_admins):
            return Role.USER
    return role


def _sync_sso_mapped_groups(user: User, claims: dict, config: SsoConfig, store: SeedStore) -> None:
    """Apply the config's IdP-group → workspace-group mapping on every verified
    sign-in. SSO owns exactly the workspace groups that appear in
    ``mapped_groups``: membership in those follows the token's group claim,
    while every other group stays admin-managed and is never touched. A token
    that carries no group claim at all leaves membership unchanged — the claim
    may simply not be configured at the identity provider."""
    mapping = config.mapped_groups or {}
    if not mapping:
        return
    claim_name = str(config.settings.get("group_claim") or "groups").strip() or "groups"
    raw_values = claims.get(claim_name)
    if not isinstance(raw_values, list):
        return
    claim_values = {str(value) for value in raw_values}
    managed = {
        group_id
        for group_id in mapping.values()
        if group_id in store.groups and store.groups[group_id].tenant_id == config.tenant_id
    }
    if not managed:
        return
    granted = {
        group_id
        for claim_value, group_id in mapping.items()
        if claim_value in claim_values and group_id in managed
    }
    next_group_ids = [
        group_id for group_id in user.group_ids if group_id not in managed or group_id in granted
    ]
    next_group_ids.extend(group_id for group_id in sorted(granted) if group_id not in next_group_ids)
    if next_group_ids == user.group_ids:
        return
    previous = list(user.group_ids)
    user.group_ids = next_group_ids
    store.record_audit(
        user,
        "auth.sso_groups_synced",
        user.id,
        {
            "sso_config_id": config.id,
            "group_claim": claim_name,
            "previous_group_ids": previous,
            "group_ids": next_group_ids,
        },
    )


def _default_group_ids(config: SsoConfig, requested_group_ids: list[str], store: SeedStore) -> list[str]:
    if not store.platform_settings.default_user_group_enabled:
        return []
    store.ensure_default_user_group()
    default_group = next(
        (group for group in store.groups.values() if group.tenant_id == config.tenant_id and group.default_group),
        None,
    )
    return [default_group.id] if default_group is not None else []


def _find_user_by_email(
    email: str,
    store: SeedStore,
    *,
    tenant_id: str | None = None,
    include_platform_owner: bool = False,
) -> User | None:
    return next(
        (
            user
            for user in store.users.values()
            if user.email.lower() == email
            and (
                tenant_id is None
                or user.tenant_id == tenant_id
                or (include_platform_owner and user.role == Role.PLATFORM_OWNER)
            )
        ),
        None,
    )


def _next_user_id(email: str, store: SeedStore) -> str:
    base = f"user-{re.sub(r'[^a-z0-9]+', '-', email.split('@', 1)[0].lower()).strip('-') or 'jit'}"
    candidate = base
    suffix = 2
    while candidate in store.users:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _name_from_email(email: str) -> str:
    local = email.split("@", 1)[0]
    return " ".join(part.capitalize() for part in re.split(r"[._-]+", local) if part) or email


def _provider_name(provider: str) -> str:
    labels = {
        "entra-id": "Microsoft Entra ID",
        "azure-ad": "Microsoft Entra ID",
        "okta": "Okta",
        "auth0": "Auth0",
        "saml": "SAML",
    }
    return labels.get(provider.lower(), provider.replace("-", " ").title())


def _assert_bootstrap_identity(email: str, display_name: str, password: str) -> None:
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email is required.")
    if "@" not in email or email.startswith("@") or email.endswith("@"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Enter a valid email address.")
    if not display_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Display name is required.")
    if len(password) < 12:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 12 characters.")


def _mfa_methods(config: SsoConfig) -> list[str]:
    raw_methods = config.settings.get("mfa_methods", [])
    if not isinstance(raw_methods, list):
        return []
    return [str(method).strip() for method in raw_methods if str(method).strip()]


def _optional_trim(value: str | None) -> str | None:
    return value.strip() if value is not None else None


def _looks_like_profile_image_reference(value: str) -> bool:
    if value.startswith("data:image/"):
        return True
    if value.startswith("/"):
        return True
    return bool(re.match(r"^https?://", value, re.IGNORECASE))


def _normalized_profile_image(value: str) -> str:
    """Shrink an uploaded avatar before it is stored.

    Avatars are serialized inline into every payload that carries a user
    record, and the admin and owner directories carry one record per account.
    A single full-size upload therefore inflates the sign-in payload for
    everyone, and fifty of them would dominate it entirely. Downscaling once on
    write keeps every later read small. A remote URL, or an image that cannot be
    decoded, is returned unchanged -- validation has already bounded its size.
    """
    if not value.startswith("data:image/"):
        return value
    match = re.match(r"^data:image/[a-z0-9.+-]+;base64,(.+)$", value, re.IGNORECASE | re.DOTALL)
    if match is None:
        return value
    try:
        decoded = base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError):
        return value
    try:
        from PIL import Image, ImageOps

        with Image.open(BytesIO(decoded)) as image:
            image.load()
            # EXIF orientation must be applied before the pixels are resampled,
            # or a phone photo is stored rotated.
            oriented = ImageOps.exif_transpose(image) or image
            resized = ImageOps.contain(
                oriented.convert("RGB"),
                (PROFILE_IMAGE_MAX_EDGE_PIXELS, PROFILE_IMAGE_MAX_EDGE_PIXELS),
            )
            buffer = BytesIO()
            resized.save(buffer, format="WEBP", quality=82, method=4)
    except (OSError, ValueError, ImportError):
        return value
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    normalized = f"data:image/webp;base64,{encoded}"
    # Never make a small original larger by re-encoding it.
    return normalized if len(normalized) < len(value) else value


def _assert_profile_image_size(value: str) -> None:
    if value.startswith("data:image/"):
        if len(value) > PROFILE_IMAGE_MAX_DATA_URL_CHARS:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Profile photo must be 5 MB or smaller.")
        match = re.match(r"^data:image/[a-z0-9.+-]+;base64,(.+)$", value, re.IGNORECASE | re.DOTALL)
        if match is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded profile photos must be base64-encoded image data.",
            )
        try:
            decoded = base64.b64decode(match.group(1), validate=True)
        except (binascii.Error, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded profile photo data is invalid.",
            ) from exc
        if len(decoded) > PROFILE_IMAGE_MAX_BYTES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Profile photo must be 5 MB or smaller.")
        return

    if len(value) > PROFILE_IMAGE_MAX_REMOTE_URL_CHARS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Profile photo URL is too long.")


def _string_setting(config: SsoConfig, key: str) -> str | None:
    value = config.settings.get(key)
    return value if isinstance(value, str) and value.strip() else None


@router.get("/me/usage-budget")
def my_usage_budget(
    actor: User = Depends(current_user),
    repository: TenantUsageBudgetRepository = Depends(get_usage_budget_repository),
    store: SeedStore = Depends(get_store),
) -> MyUsageBudgetResponse:
    """The caps that genuinely apply to the requesting user, with today's use.

    Only finite caps are returned; a user with no configured allocation gets an
    empty list rather than an invented number.
    """

    tenant_id = actor.tenant_id
    usage_date = utc_usage_date(clock.now())
    if not tenant_id:
        return MyUsageBudgetResponse(caps=[], usage_date=usage_date)
    principals: list[tuple[str, str]] = [
        ("user", actor.id),
        *(("group", group_id) for group_id in actor.group_ids),
    ]
    budgets = repository.get_principal_budgets(tenant_id, principals)
    finite = [budget for budget in budgets if budget.daily_token_limit > 0]
    if not finite:
        return MyUsageBudgetResponse(caps=[], usage_date=usage_date)
    caps = []
    for budget in finite:
        reported_tokens, _, period_start, period_end, _ = (
            repository.get_principal_period_usage(
                tenant_id,
                principal_type=budget.principal_type,
                principal_id=budget.principal_id,
                budget_period=budget.budget_period,
                now=clock.now(),
            )
        )
        if budget.principal_type == "user":
            label = "Your budget"
        else:
            group = store.groups.get(budget.principal_id)
            label = group.name if group is not None else budget.principal_id
        caps.append(
            MyUsageBudgetCap(
                scope=budget.principal_type,
                label=label,
                budget_period=budget.budget_period,
                daily_token_limit=budget.daily_token_limit,
                reported_tokens=reported_tokens,
                period_start=period_start,
                period_end=period_end,
            )
        )
    return MyUsageBudgetResponse(caps=caps, usage_date=usage_date)
