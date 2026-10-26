"""Optional WorkOS AuthKit sign-in, using each deployment's own WorkOS account.

How it fits
-----------
WorkOS is one more identity-provider choice in the SSO configuration a
workspace already has (Admin console → SSO, or the owner's Organization
settings → Single Sign-On). A deployment that never saves a WorkOS
configuration never contacts WorkOS. Aperture Chat ships no shared WorkOS
account: whoever runs an instance enters their own client ID and API key, so
WorkOS bills that deployment, not the project.

A WorkOS configuration is an ordinary ``SsoConfig`` record:

    provider                         "workos"
    settings.protocol                "WORKOS"
    client_id                        the WorkOS client ID (client_...)
    vaulted secret                   the WorkOS API key (sk_...)
    settings.workos_organization_id  optional: pins sign-in to one WorkOS
                                     organization, which AuthKit then selects
                                     automatically
    settings.domains, jit_provisioning, enforced, require_platform_mfa,
    mapped_groups, group_claim       the same controls every provider uses

Sign-in flow
------------
1. ``/api/auth/sso/{id}/authorize`` redirects to WorkOS's hosted AuthKit page
   (:func:`authorization_url`) with the signed state and a PKCE challenge.
2. WorkOS runs the whole sign-in: the organization's SAML or OIDC
   connection, plus any social, password, or MFA steps the deployment turned
   on in its WorkOS dashboard.
3. WorkOS returns to the shared ``/api/auth/sso/callback`` with a code.
4. :func:`authenticate_with_code` redeems the code server to server with the
   API key. :func:`identity_claims` verifies the returned access token
   against the client's published signing keys and produces the same claim
   shape an OIDC ID token yields. Account matching, JIT provisioning, domain
   rules, group mapping, and MFA are therefore shared with OIDC.

The HTTP helpers are module-level so tests can monkeypatch them; production
behaviour is plain httpx against the WorkOS REST API, with no WorkOS SDK.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode

import httpx
import jwt
from jwt import PyJWKClient

from app.core.config import get_settings
from app.core.net_guard import EgressBlocked, validate_public_url

REQUEST_TIMEOUT_SECONDS = 15.0
# WorkOS mints the access token moments before it is verified here, so a
# server clock a few seconds behind WorkOS must not reject it as "not yet valid".
CLOCK_SKEW_SECONDS = 60

_jwk_clients: dict[str, PyJWKClient] = {}

# Messages for the follow-up steps the authenticate endpoint can ask for.
# Hosted AuthKit normally finishes these before it returns a code, so seeing
# one here means the WorkOS environment needs a setting changed.
_AUTHENTICATION_STEP_MESSAGES = {
    "organization_selection_required": (
        "This WorkOS account belongs to more than one organization. An administrator must add "
        "the WorkOS organization ID to this sign-in configuration."
    ),
    "email_verification_required": (
        "WorkOS needs this email address verified first. Finish the verification email from "
        "WorkOS, then sign in again."
    ),
    "mfa_enrollment": "WorkOS requires two-step verification setup. Sign in again to finish it.",
    "mfa_challenge": "WorkOS requires a two-step verification code. Sign in again to enter it.",
    "sso_required": "This organization requires its single sign-on connection. Sign in with your work account.",
    "organization_authentication_methods_required": (
        "This organization does not allow the sign-in method you chose. Use your work account."
    ),
}


class WorkOSError(Exception):
    """Raised when any WorkOS step fails; the message is safe to show a user."""


def api_base_url() -> str:
    return get_settings().workos_api_base_url.rstrip("/")


def organization_id(settings: dict[str, Any]) -> str | None:
    value = settings.get("workos_organization_id")
    return value.strip() if isinstance(value, str) and value.strip() else None


def authorization_url(
    *,
    client_id: str,
    redirect_uri: str,
    state: str,
    code_challenge: str,
    organization: str | None = None,
    login_hint: str | None = None,
) -> str:
    """The hosted AuthKit URL that starts one sign-in."""
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "provider": "authkit",
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    if organization:
        # With provider=authkit, WorkOS selects this organization for the
        # user, so its SSO connection or sign-in policy applies directly.
        params["organization_id"] = organization
    if login_hint:
        params["login_hint"] = login_hint
    return f"{api_base_url()}/user_management/authorize?{urlencode(params)}"


def authenticate_with_code(
    *,
    client_id: str,
    api_key: str,
    code: str,
    code_verifier: str | None,
) -> dict[str, Any]:
    """Redeem an authorization code; returns WorkOS's authentication response."""
    body = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "client_secret": api_key,
        "code": code,
    }
    # PKCE rides alongside the API key, as the official SDKs send it: it
    # binds the code to the browser that started this sign-in.
    if code_verifier:
        body["code_verifier"] = code_verifier
    response = _post(f"{api_base_url()}/user_management/authenticate", body)
    if response.status_code != 200:
        raise WorkOSError(_authentication_error_message(response))
    try:
        payload = response.json()
    except ValueError as exc:
        raise WorkOSError("WorkOS returned a response that is not valid JSON.") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("user"), dict):
        raise WorkOSError("WorkOS did not return a user for this sign-in.")
    return payload


def identity_claims(
    authentication: dict[str, Any],
    *,
    client_id: str,
    required_organization: str | None = None,
) -> dict[str, Any]:
    """Verified, OIDC-shaped claims for the shared sign-in code.

    The user comes from the authenticate response itself, which was fetched
    over TLS with the API key. The access token is still verified against the
    client's signing keys before its organization and role claims are used.
    """
    user = authentication["user"]
    subject = _user_subject(user)
    token_claims = verify_access_token(str(authentication.get("access_token") or ""), client_id)
    if token_claims.get("sub") != subject:
        raise WorkOSError("The WorkOS access token does not belong to the signed-in user.")
    organization = _signed_in_organization(token_claims, authentication, required_organization)
    return {
        "sub": subject,
        "email": user.get("email"),
        **_name_claims(user),
        **_verified_email_claim(user),
        "org_id": organization,
        "role": token_claims.get("role"),
        # Group mapping reads a list claim. WorkOS can assign roles from the
        # identity provider's groups, so roles are the mappable values.
        "roles": _role_slugs(token_claims),
        "permissions": token_claims.get("permissions") or [],
        "authentication_method": authentication.get("authentication_method"),
    }


def _user_subject(user: dict[str, Any]) -> str:
    subject = str(user.get("id") or "").strip()
    if not subject:
        raise WorkOSError("WorkOS did not return a user ID for this sign-in.")
    return subject


def _signed_in_organization(
    token_claims: dict[str, Any],
    authentication: dict[str, Any],
    required_organization: str | None,
) -> str | None:
    organization = token_claims.get("org_id") or authentication.get("organization_id")
    if required_organization and organization != required_organization:
        raise WorkOSError(
            "This sign-in did not come from the WorkOS organization configured for this workspace."
        )
    return organization


def _name_claims(user: dict[str, Any]) -> dict[str, str | None]:
    first_name = str(user.get("first_name") or "").strip()
    last_name = str(user.get("last_name") or "").strip()
    return {
        "name": " ".join(part for part in (first_name, last_name) if part),
        "given_name": first_name or None,
        "family_name": last_name or None,
    }


def _verified_email_claim(user: dict[str, Any]) -> dict[str, bool]:
    # Only an explicit answer from WorkOS becomes a claim; the shared sign-in
    # code refuses an explicit false and treats an absent value as unknown.
    verified = user.get("email_verified")
    return {"email_verified": verified} if isinstance(verified, bool) else {}


def _role_slugs(token_claims: dict[str, Any]) -> list[str]:
    roles = token_claims.get("roles")
    if isinstance(roles, list):
        return [str(role) for role in roles]
    role = token_claims.get("role")
    return [role] if isinstance(role, str) else []


def verify_access_token(access_token: str, client_id: str) -> dict[str, Any]:
    if not access_token:
        raise WorkOSError("WorkOS did not return an access token for this sign-in.")
    jwks_uri = jwks_url(client_id)
    try:
        validate_public_url(jwks_uri)
    except EgressBlocked as exc:
        raise WorkOSError(f"The WorkOS signing-key URL is not permitted: {exc}") from exc
    try:
        signing_key = _jwk_client(jwks_uri).get_signing_key_from_jwt(access_token)
        # The issuer is api.workos.com or the deployment's custom auth domain,
        # and WorkOS access tokens carry no audience. Keys published for this
        # client ID are what bind the token to this WorkOS application.
        return jwt.decode(
            access_token,
            signing_key.key,
            algorithms=["RS256"],
            options={"require": ["exp", "sub"], "verify_aud": False},
            leeway=CLOCK_SKEW_SECONDS,
        )
    except jwt.PyJWTError as exc:
        raise WorkOSError(f"The WorkOS access token failed verification: {exc}") from exc


def jwks_url(client_id: str) -> str:
    return f"{api_base_url()}/sso/jwks/{quote(client_id, safe='')}"


def check_connection(
    *,
    client_id: str,
    api_key: str | None,
    organization: str | None,
) -> list[dict[str, str]]:
    """Live checks for the admin Test connection button, in display order."""
    checks = [_check_api_key(api_key), _check_client_id(client_id.strip())]
    if organization:
        checks.append(_check_organization(organization, api_key))
    return checks


def _check_api_key(api_key: str | None) -> dict[str, str]:
    if not api_key:
        return _check("API key", "failed", "Save the WorkOS API key first.")
    try:
        response = _get(f"{api_base_url()}/organizations", api_key, params={"limit": "1"})
    except WorkOSError as exc:
        return _check("API key", "failed", str(exc))
    if response.status_code == 200:
        return _check("API key", "ok", "WorkOS accepted the API key.")
    if response.status_code == 401:
        return _check(
            "API key",
            "failed",
            "WorkOS rejected the API key. Copy it again from API Keys in the WorkOS dashboard.",
        )
    return _check("API key", "failed", f"WorkOS returned {response.status_code}: {_error_detail(response)}")


def _check_client_id(client_id: str) -> dict[str, str]:
    if not client_id:
        return _check("Client ID", "failed", "Enter the WorkOS client ID.")
    try:
        response = _get(jwks_url(client_id), None)
    except WorkOSError as exc:
        return _check("Client ID", "failed", str(exc))
    key_count = _key_count(response)
    if not key_count:
        return _check(
            "Client ID",
            "failed",
            "WorkOS has no signing keys for this client ID. Copy it again from the WorkOS dashboard.",
        )
    plural = "s" if key_count != 1 else ""
    return _check("Client ID", "ok", f"WorkOS publishes {key_count} signing key{plural} for this client.")


def _check_organization(organization: str, api_key: str | None) -> dict[str, str]:
    if not api_key:
        return _check("Organization", "failed", "Save the WorkOS API key to look up the organization.")
    try:
        response = _get(f"{api_base_url()}/organizations/{quote(organization, safe='')}", api_key)
    except WorkOSError as exc:
        return _check("Organization", "failed", str(exc))
    if response.status_code != 200:
        return _check(
            "Organization",
            "failed",
            f"WorkOS could not find organization {organization} with this API key.",
        )
    return _check("Organization", "ok", _organization_summary(_json_object(response), organization))


def _organization_summary(payload: dict[str, Any], organization: str) -> str:
    """The organization's name with its domains, as an admin recognizes it."""
    domains = [
        str(item["domain"])
        for item in payload.get("domains") or []
        if isinstance(item, dict) and item.get("domain")
    ]
    name = str(payload.get("name") or organization)
    return name + (f" ({', '.join(domains)})" if domains else "")


def _check(name: str, status: str, detail: str) -> dict[str, str]:
    return {"name": name, "status": status, "detail": detail}


def _jwk_client(jwks_uri: str) -> PyJWKClient:
    client = _jwk_clients.get(jwks_uri)
    if client is None:
        client = PyJWKClient(jwks_uri, cache_keys=True, lifespan=300)
        _jwk_clients[jwks_uri] = client
    return client


def _post(url: str, body: dict[str, str]) -> httpx.Response:
    _assert_permitted(url)
    try:
        return httpx.post(
            url,
            json=body,
            headers={"Accept": "application/json"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise WorkOSError(f"Could not reach WorkOS: {exc}") from exc


def _get(url: str, api_key: str | None, params: dict[str, str] | None = None) -> httpx.Response:
    _assert_permitted(url)
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    try:
        return httpx.get(url, headers=headers, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
    except httpx.HTTPError as exc:
        raise WorkOSError(f"Could not reach WorkOS: {exc}") from exc


def _assert_permitted(url: str) -> None:
    try:
        validate_public_url(url)
    except EgressBlocked as exc:
        raise WorkOSError(f"The WorkOS API URL is not permitted: {exc}") from exc


def _authentication_error_message(response: httpx.Response) -> str:
    payload = _json_object(response)
    code = str(payload.get("code") or payload.get("error") or "")
    if code in _AUTHENTICATION_STEP_MESSAGES:
        return _AUTHENTICATION_STEP_MESSAGES[code]
    if response.status_code == 401 or code in {"invalid_client", "unauthorized_client"}:
        return "WorkOS rejected the client ID or API key. An administrator must check this sign-in configuration."
    if code == "invalid_grant":
        return "The WorkOS sign-in code expired or was already used. Start the sign-in again."
    return f"WorkOS returned {response.status_code}: {_error_detail(response)}"


def _error_detail(response: httpx.Response) -> str:
    payload = _json_object(response)
    for key in ("error_description", "message", "error", "code"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:300]
    return (response.text or "unknown error")[:300]


def _json_object(response: httpx.Response) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _key_count(response: httpx.Response) -> int:
    keys = _json_object(response).get("keys") if response.status_code == 200 else None
    return len(keys) if isinstance(keys, list) else 0
