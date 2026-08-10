"""Real OIDC relying-party client: discovery, code exchange, ID-token validation.

The HTTP helpers are module-level so tests can monkeypatch them with a fake IdP;
production behaviour is plain httpx against the issuer's published endpoints.
"""

from __future__ import annotations

import jwt
import httpx
from jwt import PyJWKClient

from app.core.net_guard import REDIRECT_GUARD_HOOKS, EgressBlocked, validate_public_url

DISCOVERY_TIMEOUT_SECONDS = 10.0
TOKEN_TIMEOUT_SECONDS = 15.0

_jwk_clients: dict[str, PyJWKClient] = {}


class OidcError(Exception):
    """Raised when any step of the OIDC flow fails; message is safe to surface."""


def discovery_url_for(issuer_url: str) -> str:
    return issuer_url.rstrip("/") + "/.well-known/openid-configuration"


def fetch_discovery_document(issuer_url: str) -> dict:
    url = discovery_url_for(issuer_url)
    try:
        validate_public_url(url)
    except EgressBlocked as exc:
        raise OidcError(f"OIDC issuer URL is not permitted: {exc}") from exc
    try:
        with httpx.Client(follow_redirects=True, event_hooks=REDIRECT_GUARD_HOOKS) as client:
            response = client.get(url, timeout=DISCOVERY_TIMEOUT_SECONDS)
        response.raise_for_status()
        document = response.json()
    except (httpx.HTTPError, EgressBlocked) as exc:
        raise OidcError(f"Could not fetch OIDC discovery document from {url}: {exc}") from exc
    except ValueError as exc:
        raise OidcError(f"OIDC discovery document at {url} is not valid JSON.") from exc
    for key in ("issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not isinstance(document.get(key), str) or not document[key].strip():
            raise OidcError(f"OIDC discovery document is missing required field '{key}'.")
    return document


def exchange_authorization_code(
    token_endpoint: str,
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
    code_verifier: str | None = None,
) -> dict:
    try:
        validate_public_url(token_endpoint)
    except EgressBlocked as exc:
        raise OidcError(f"OIDC token endpoint is not permitted: {exc}") from exc
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    # PKCE rides alongside the client secret: some providers require it for
    # every authorization-code exchange, and it blocks code substitution.
    if code_verifier:
        data["code_verifier"] = code_verifier
    try:
        response = httpx.post(
            token_endpoint,
            data=data,
            headers={"Accept": "application/json"},
            timeout=TOKEN_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise OidcError(f"Token endpoint request failed: {exc}") from exc
    if response.status_code != 200:
        detail = _safe_error_detail(response)
        raise OidcError(f"Token endpoint returned {response.status_code}: {detail}")
    try:
        payload = response.json()
    except ValueError as exc:
        raise OidcError("Token endpoint response is not valid JSON.") from exc
    if not isinstance(payload.get("id_token"), str):
        raise OidcError("Token endpoint response did not include an id_token. Ensure the 'openid' scope is granted.")
    return payload


def validate_id_token(
    id_token: str,
    jwks_uri: str,
    issuer: str,
    client_id: str,
    expected_nonce: str | None,
) -> dict:
    try:
        validate_public_url(jwks_uri)
    except EgressBlocked as exc:
        raise OidcError(f"OIDC JWKS URI is not permitted: {exc}") from exc
    try:
        signing_key = _jwk_client(jwks_uri).get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256", "ES256", "PS256", "RS384", "RS512"],
            audience=client_id,
            issuer=issuer,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.PyJWTError as exc:
        raise OidcError(f"ID token validation failed: {exc}") from exc
    if expected_nonce is not None and claims.get("nonce") != expected_nonce:
        raise OidcError("ID token nonce does not match the login request.")
    return claims


def _jwk_client(jwks_uri: str) -> PyJWKClient:
    client = _jwk_clients.get(jwks_uri)
    if client is None:
        client = PyJWKClient(jwks_uri, cache_keys=True, lifespan=300)
        _jwk_clients[jwks_uri] = client
    return client


def _safe_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            return str(payload.get("error_description") or payload.get("error") or "unknown error")
    except ValueError:
        pass
    return (response.text or "unknown error")[:300]
