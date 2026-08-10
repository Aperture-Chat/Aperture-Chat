"""Server-side token acquisition and connection testing for knowledge connectors.

Every helper reports honest results: missing credentials name the exact fields to
fill, vendor failures surface the HTTP status and the provider's error message,
and no code path fabricates connectivity. Secrets are read from the SeedStore
vault namespaces ("connector", "connector-password") and cached service tokens
live in the "connector-oauth" namespace; delegated chat-attachment tokens live
in "connector-user-oauth" keyed by config and user so no user can read another
user's files. Nothing here ever puts a secret in a message.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

import httpx

from app.core.box import BoxError, get_box_client
from app.core.cloud_sources import (
    CloudSourceError,
    get_google_drive_client,
    get_imanage_client,
    get_microsoft_graph_client,
)
from app.core.config import get_settings
from app.core.net_guard import EgressBlocked, validate_public_url
from app.core.sessions import sign_oidc_state
from app.core.web_search import (
    KEYED_SEARCH_ENGINE_KINDS,
    KEYED_SEARCH_ENGINE_LABELS,
    WebSearchError,
    resolve_search_provider_key,
    web_search_client_from_config,
)
from app.models.schemas import ConnectorConfig
from app.repositories.seed import SeedStore

TOKEN_TIMEOUT_SECONDS = 15.0
TOKEN_EXPIRY_MARGIN_SECONDS = 60

CONNECTOR_SECRET_NAMESPACE = "connector"
OAUTH_TOKEN_NAMESPACE = "connector-oauth"
SERVICE_PASSWORD_NAMESPACE = "connector-password"
USER_OAUTH_TOKEN_NAMESPACE = "connector-user-oauth"

GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
GRAPH_SCOPE = "https://graph.microsoft.com/.default"
GRAPH_DELEGATED_SCOPE = "offline_access Files.Read.All Sites.Read.All"
GRAPH_API_BASE_URL = "https://graph.microsoft.com/v1.0"
GOOGLE_DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3"
BOX_AUTHORIZATION_URL = "https://account.box.com/api/oauth2/authorize"

_PROVIDER_LABELS = {
    "google-drive": "Google Drive",
    "microsoft-graph": "Microsoft Graph",
    "box": "Box",
    "imanage": "iManage",
}


@dataclass
class TokenResult:
    access_token: str | None
    status: str  # "live" | "missing-credentials" | "not-connected" | "error"
    message: str | None = None


@dataclass(frozen=True)
class UserOAuthProvider:
    """Authorization-code endpoints for a user connecting their own account."""

    provider: str
    label: str
    authorization_url: str
    token_url: str
    scope: str | None
    authorize_params: dict[str, str]
    refresh_params: dict[str, str]


def connector_auth_mode(config: ConnectorConfig) -> str:
    configured_mode = str(config.settings.get("auth_mode") or "").strip().lower()
    return configured_mode or config.auth_type.strip().lower()


def provider_label(connector_id: str) -> str:
    return _PROVIDER_LABELS.get(connector_id, connector_id)


def connector_oauth_redirect_uri() -> str:
    return f"{get_settings().api_base_url.rstrip('/')}/api/connector-oauth/callback"


def acquire_connector_token(store: SeedStore, config: ConnectorConfig) -> TokenResult:
    """Return a usable bearer token for the connector, or an honest failure."""
    mode = connector_auth_mode(config)
    if config.connector_id == "microsoft-graph" and mode == "client-credentials":
        return _graph_client_credentials_token(store, config)
    if config.connector_id == "box" and mode == "client-credentials":
        return _box_client_credentials_token(store, config)
    if config.connector_id == "google-drive" and mode == "oauth-client":
        return _google_oauth_token(store, config)
    if config.connector_id == "imanage" and mode == "password":
        return _imanage_password_token(store, config)
    if config.connector_id == "imanage" and mode == "oauth-client":
        return TokenResult(
            access_token=None,
            status="not-connected",
            message=(
                "iManage per-user OAuth does not create a shared workspace token. "
                "Open iManage from the chat attachment menu and sign in with your own account."
            ),
        )
    # Everything else (manual-token, developer-token, and access-token modes)
    # uses the pasted connector secret.
    return _pasted_token(store, config, mode)


def missing_credential_fields(store: SeedStore, config: ConnectorConfig) -> list[str]:
    """List required credential fields, by UI name, that are not filled in yet."""
    mode = connector_auth_mode(config)
    missing: list[str] = []

    def need_setting(key: str, label: str) -> None:
        if not str(config.settings.get(key) or "").strip():
            missing.append(f"{label} ({key})")

    def need_client_secret() -> None:
        if not store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id):
            missing.append("Client secret (secret_value)")

    if config.connector_id == "microsoft-graph" and mode == "client-credentials":
        need_setting("tenant_id", "Tenant ID")
        need_setting("client_id", "Client ID")
        need_client_secret()
    elif config.connector_id == "box" and mode == "client-credentials":
        need_setting("client_id", "Client ID")
        need_setting("enterprise_id", "Enterprise ID")
        need_client_secret()
    elif config.connector_id == "google-drive" and mode == "oauth-client":
        need_setting("client_id", "Client ID")
        need_client_secret()
    elif config.connector_id == "imanage" and mode == "password":
        need_setting("base_url", "iManage base URL")
        need_setting("client_id", "Client ID")
        need_setting("service_username", "Service username")
        need_client_secret()
        if not store.configuration_secret(SERVICE_PASSWORD_NAMESPACE, config.id):
            missing.append("Service account password (service_password)")
    elif config.connector_id == "imanage" and mode == "oauth-client":
        need_setting("base_url", "iManage base URL")
        need_setting("client_id", "Client ID")
        need_client_secret()
    else:
        if not store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id):
            missing.append("Access token (secret_value)")
    return missing


def missing_user_oauth_fields(store: SeedStore, config: ConnectorConfig) -> list[str]:
    """Fields required to start a user's delegated OAuth flow.

    These are intentionally separate from service-account requirements. A Box
    enterprise ID and an iManage service username can power background indexing,
    but neither is a prerequisite for a person to authorize the registered app
    against their own account.
    """
    missing: list[str] = []

    def need_setting(key: str, label: str) -> None:
        if not str(config.settings.get(key) or "").strip():
            missing.append(f"{label} ({key})")

    need_setting("client_id", "Client ID")
    if config.connector_id == "microsoft-graph":
        need_setting("tenant_id", "Tenant ID")
    if config.connector_id == "imanage":
        need_setting("base_url", "iManage base URL")
    if not store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id):
        missing.append("Client secret (secret_value)")
    return missing


def exchange_google_authorization_code(store: SeedStore, config: ConnectorConfig, code: str) -> str | None:
    """Exchange a Google authorization code and store the tokens; return an error message on failure."""
    client_id = str(config.settings.get("client_id") or "").strip()
    client_secret = store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id)
    if not client_id or not client_secret:
        return (
            "Google Drive OAuth callback arrived but the connector is missing its "
            "Client ID (client_id) or client secret; save both and reconnect."
        )
    token_url = str(config.settings.get("token_url") or "").strip() or GOOGLE_TOKEN_URL
    payload, error = _post_token(
        token_url,
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": connector_oauth_redirect_uri(),
            "client_id": client_id,
            "client_secret": client_secret,
        },
    )
    if payload is None:
        return f"Google token exchange failed: {error}"
    refresh_token = payload.get("refresh_token")
    if not isinstance(refresh_token, str) or not refresh_token.strip():
        # Google only re-issues refresh tokens with prompt=consent; keep a
        # previously stored one instead of silently discarding it.
        refresh_token = _cached_oauth_payload(store, config.id).get("refresh_token")
    _store_oauth_payload(
        store,
        config.id,
        {
            "access_token": payload["access_token"],
            "refresh_token": refresh_token,
            "expires_at": _expires_at(payload),
        },
    )
    return None


def _run_web_search_test(store: SeedStore, config: ConnectorConfig) -> dict[str, Any]:
    """Live-verify the platform web search engine with a real query."""
    client = web_search_client_from_config(dict(config.settings))
    checks: list[dict[str, str]] = []

    if client.engine in KEYED_SEARCH_ENGINE_KINDS:
        label = KEYED_SEARCH_ENGINE_LABELS[client.engine]
        client.api_key = resolve_search_provider_key(store, client.engine)
        if not client.api_key:
            checks.append(
                {
                    "name": "Provider key",
                    "status": "incomplete",
                    "detail": f"No active {label} provider key is stored for this workspace.",
                }
            )
            return {
                "status": "incomplete",
                "message": (
                    f"{label} web search reuses the workspace's {label} provider key. Add an "
                    f"active {label} key under Providers, or switch to a keyless engine."
                ),
                "checks": checks,
            }
        checks.append(
            {
                "name": "Provider key",
                "status": "ok",
                "detail": f"Reusing the workspace's active {label} provider key.",
            }
        )
        checks.append(
            {
                "name": "Engine",
                "status": "ok",
                "detail": f"{label} hosted web search (billed per search to the {label} account).",
            }
        )
    elif client.engine == "searxng":
        base_url = str(config.settings.get("searxng_base_url") or "").strip() or get_settings().searxng_base_url
        if not base_url:
            checks.append(
                {
                    "name": "Engine",
                    "status": "incomplete",
                    "detail": "SearXNG is selected but no instance URL is set.",
                }
            )
            return {
                "status": "incomplete",
                "message": "Set the SearXNG instance URL before testing, or switch the engine to DuckDuckGo.",
                "checks": checks,
            }
        checks.append({"name": "Engine", "status": "ok", "detail": f"SearXNG at {base_url}."})
    else:
        checks.append({"name": "Engine", "status": "ok", "detail": f"{client.engine} (keyless, no credentials required)."})

    try:
        results = client.search("Aperture Chat web search connectivity test")
    except WebSearchError as exc:
        checks.append({"name": "Live query", "status": "failed", "detail": str(exc)})
        return {
            "status": "failed",
            "message": f"Web search test failed: {exc}",
            "checks": checks,
        }

    if not results:
        checks.append(
            {
                "name": "Live query",
                "status": "failed",
                "detail": "The engine responded but returned zero results for the test query.",
            }
        )
        return {
            "status": "failed",
            "message": "The search engine responded without results; check the instance configuration.",
            "checks": checks,
        }

    checks.append(
        {
            "name": "Live query",
            "status": "ok",
            "detail": f"{len(results)} results; first: {results[0].title[:80]} ({results[0].url[:100]})",
        }
    )
    return {
        "status": "ok",
        "message": f"Web search is working through {client.engine}.",
        "checks": checks,
    }


def run_connector_test(store: SeedStore, config: ConnectorConfig) -> dict[str, Any]:
    """SSO-test-shaped connection check: required fields, auth, API probe, source root."""
    if config.connector_id == "web":
        return _run_web_search_test(store, config)
    label = provider_label(config.connector_id)
    mode = connector_auth_mode(config)
    checks: list[dict[str, str]] = []

    missing = missing_credential_fields(store, config)
    if missing:
        detail = f"Missing: {', '.join(missing)}."
        checks.append({"name": "Required fields", "status": "incomplete", "detail": detail})
        return {
            "status": "incomplete",
            "message": f"{label} '{mode}' authentication needs these fields before testing: {', '.join(missing)}.",
            "checks": checks,
        }
    checks.append(
        {"name": "Required fields", "status": "ok", "detail": f"All required '{mode}' fields are set."}
    )

    if config.connector_id == "imanage" and mode == "oauth-client":
        checks.append(
            {
                "name": "User isolation",
                "status": "ok",
                "detail": (
                    "Chat access requires a token stored for the signed-in user; shared connector "
                    "credentials are never used to list iManage files."
                ),
            }
        )
        return {
            "status": "incomplete",
            "message": (
                "iManage delegated OAuth settings are saved. Complete the live verification by "
                "opening iManage from chat and signing in with an allowed iManage account."
            ),
            "checks": checks,
        }

    token = acquire_connector_token(store, config)
    if token.status == "missing-credentials":
        checks.append({"name": "Authentication", "status": "incomplete", "detail": token.message or ""})
        return {"status": "incomplete", "message": token.message, "checks": checks}
    if token.access_token is None:
        checks.append({"name": "Authentication", "status": "failed", "detail": token.message or ""})
        return {"status": "failed", "message": token.message, "checks": checks}
    checks.append(
        {
            "name": "Authentication",
            "status": "ok",
            "detail": (
                "Using the stored access token."
                if token.status == "live" and mode not in {"client-credentials", "oauth-client", "password"}
                else f"Acquired an access token via the '{mode}' flow."
            ),
        }
    )

    probe_ok, probe_detail = _probe_api_access(config, token.access_token)
    if not probe_ok:
        checks.append({"name": "API access", "status": "failed", "detail": probe_detail})
        return {"status": "failed", "message": probe_detail, "checks": checks}
    checks.append({"name": "API access", "status": "ok", "detail": probe_detail})

    root_check = _source_root_check(config, token.access_token)
    if root_check is not None:
        root_status, root_detail = root_check
        checks.append({"name": "Source folder", "status": root_status, "detail": root_detail})
        if root_status != "ok":
            # Auth works but the configured root does not: incomplete, not failed.
            return {"status": "incomplete", "message": root_detail, "checks": checks}

    return {"status": "ok", "message": f"{label} connection verified. {probe_detail}", "checks": checks}


# --- per-user OAuth (chat attachments) ---------------------------------------


def user_oauth_provider(config: ConnectorConfig) -> UserOAuthProvider | None:
    """Descriptor for the per-user authorization-code flow, or None when the
    connector/auth mode only supports a shared manual/testing credential."""
    mode = connector_auth_mode(config)
    settings = config.settings
    if config.connector_id == "google-drive" and mode == "oauth-client":
        return UserOAuthProvider(
            provider="google",
            label=provider_label(config.connector_id),
            authorization_url=str(settings.get("authorization_url") or "").strip() or GOOGLE_AUTHORIZATION_URL,
            token_url=str(settings.get("token_url") or "").strip() or GOOGLE_TOKEN_URL,
            scope=GOOGLE_DRIVE_SCOPE,
            authorize_params={"access_type": "offline", "prompt": "consent"},
            refresh_params={},
        )
    if config.connector_id == "microsoft-graph" and mode == "client-credentials":
        tenant_id = str(settings.get("tenant_id") or "").strip()
        base = f"https://login.microsoftonline.com/{quote(tenant_id, safe='')}/oauth2/v2.0"
        return UserOAuthProvider(
            provider="microsoft",
            label=provider_label(config.connector_id),
            authorization_url=str(settings.get("user_authorization_url") or "").strip() or f"{base}/authorize",
            token_url=str(settings.get("user_token_url") or "").strip() or f"{base}/token",
            scope=GRAPH_DELEGATED_SCOPE,
            authorize_params={"response_mode": "query"},
            # Azure AD refresh grants need the scope restated to mint a Graph token.
            refresh_params={"scope": GRAPH_DELEGATED_SCOPE},
        )
    if config.connector_id == "box" and mode == "client-credentials":
        return UserOAuthProvider(
            provider="box",
            label=provider_label(config.connector_id),
            authorization_url=str(settings.get("user_authorization_url") or "").strip() or BOX_AUTHORIZATION_URL,
            token_url=str(settings.get("token_url") or "").strip() or _box_token_url(),
            # Box grants the scopes configured on the app; no scope param.
            scope=None,
            authorize_params={},
            refresh_params={},
        )
    if config.connector_id == "imanage" and mode in {"oauth-client", "password"}:
        base_url = str(settings.get("base_url") or "").strip().rstrip("/")
        return UserOAuthProvider(
            provider="imanage",
            label=provider_label(config.connector_id),
            authorization_url=(
                str(settings.get("user_authorization_url") or "").strip()
                or f"{base_url}/auth/oauth2/authorize"
            ),
            token_url=(
                str(settings.get("user_token_url") or settings.get("token_url") or "").strip()
                or f"{base_url}/auth/oauth2/token"
            ),
            scope=str(settings.get("user_scope") or "").strip() or None,
            authorize_params={},
            refresh_params={},
        )
    return None


def build_user_authorize_url(
    store: SeedStore, config: ConnectorConfig, actor_id: str
) -> tuple[str | None, str | None]:
    """(consent URL, error message). The signed state ties the provider redirect
    back to this config and the user who started the flow."""
    provider = user_oauth_provider(config)
    if provider is None:
        return None, (
            f"{provider_label(config.connector_id)} does not support per-user connections with auth mode "
            f"'{connector_auth_mode(config)}'."
        )
    missing = missing_user_oauth_fields(store, config)
    if missing:
        return None, (
            f"{provider.label} needs these connector fields saved by an admin before you can "
            f"connect your account: {', '.join(missing)}."
        )
    state = sign_oidc_state(
        {"config_id": config.id, "actor_id": actor_id, "subject": "user"},
        get_settings().secret_key,
    )
    params: dict[str, str] = {
        "response_type": "code",
        "client_id": str(config.settings.get("client_id") or "").strip(),
        "redirect_uri": connector_oauth_redirect_uri(),
        "state": state,
    }
    if provider.scope:
        params["scope"] = provider.scope
    params.update(provider.authorize_params)
    return f"{provider.authorization_url}?{urlencode(params)}", None


def exchange_user_authorization_code(
    store: SeedStore, config: ConnectorConfig, user_id: str, code: str
) -> str | None:
    """Exchange a per-user authorization code and store the tokens; return an error message on failure."""
    provider = user_oauth_provider(config)
    if provider is None:
        return (
            f"{provider_label(config.connector_id)} does not support per-user connections with auth mode "
            f"'{connector_auth_mode(config)}'."
        )
    client_id = str(config.settings.get("client_id") or "").strip()
    client_secret = store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id)
    if not client_id or not client_secret:
        return (
            f"{provider.label} OAuth callback arrived but the connector is missing its Client ID "
            "(client_id) or client secret; ask an admin to save both, then reconnect."
        )
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": connector_oauth_redirect_uri(),
        "client_id": client_id,
        "client_secret": client_secret,
    }
    if provider.scope and provider.provider == "microsoft":
        data["scope"] = provider.scope
    payload, error = _post_token(provider.token_url, data)
    if payload is None:
        return f"{provider.label} token exchange failed: {error}"
    refresh_token = payload.get("refresh_token")
    if not isinstance(refresh_token, str) or not refresh_token.strip():
        refresh_token = _cached_user_oauth_payload(store, config.id, user_id).get("refresh_token")
    _store_user_oauth_payload(
        store,
        config.id,
        user_id,
        {
            "access_token": payload["access_token"],
            "refresh_token": refresh_token,
            "expires_at": _expires_at(payload),
        },
    )
    return None


def acquire_user_connector_token(store: SeedStore, config: ConnectorConfig, user_id: str) -> TokenResult:
    """Return a bearer token for this user's own account, or an honest failure."""
    provider = user_oauth_provider(config)
    if provider is None:
        return TokenResult(
            access_token=None,
            status="error",
            message=(
                f"{provider_label(config.connector_id)} does not support per-user connections with auth "
                f"mode '{connector_auth_mode(config)}'."
            ),
        )
    stored = _cached_user_oauth_payload(store, config.id, user_id)
    access_token = stored.get("access_token")
    if isinstance(access_token, str) and access_token and not _is_expired(stored.get("expires_at")):
        return TokenResult(access_token=access_token, status="live")
    refresh_token = stored.get("refresh_token")
    if not isinstance(refresh_token, str) or not refresh_token.strip():
        return TokenResult(
            access_token=None,
            status="not-connected",
            message=f"Connect your {provider.label} account to attach files from it.",
        )
    client_id = str(config.settings.get("client_id") or "").strip()
    client_secret = store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id)
    if not client_id or not client_secret:
        return TokenResult(
            access_token=None,
            status="missing-credentials",
            message=(
                f"{provider.label} connector is missing its Client ID (client_id) or client secret; "
                "ask an admin to save both."
            ),
        )
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    data.update(provider.refresh_params)
    payload, error = _post_token(provider.token_url, data)
    if payload is None:
        return TokenResult(
            None,
            "error",
            f"{provider.label} token refresh failed: {error}. Reconnect your account from the attach menu.",
        )
    new_refresh = payload.get("refresh_token")
    _store_user_oauth_payload(
        store,
        config.id,
        user_id,
        {
            "access_token": payload["access_token"],
            "refresh_token": new_refresh if isinstance(new_refresh, str) and new_refresh.strip() else refresh_token,
            "expires_at": _expires_at(payload),
        },
    )
    return TokenResult(access_token=payload["access_token"], status="live")


def _user_token_key(config_id: str, user_id: str) -> str:
    return f"{config_id}:{user_id}"


def _cached_user_oauth_payload(store: SeedStore, config_id: str, user_id: str) -> dict[str, Any]:
    raw = store.configuration_secret(USER_OAUTH_TOKEN_NAMESPACE, _user_token_key(config_id, user_id))
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _store_user_oauth_payload(store: SeedStore, config_id: str, user_id: str, payload: dict[str, Any]) -> None:
    store.set_configuration_secret(
        USER_OAUTH_TOKEN_NAMESPACE, _user_token_key(config_id, user_id), json.dumps(payload)
    )


# --- token flows -------------------------------------------------------------


def _pasted_token(store: SeedStore, config: ConnectorConfig, mode: str) -> TokenResult:
    secret = store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id)
    if secret:
        return TokenResult(access_token=secret, status="live")
    return TokenResult(
        access_token=None,
        status="missing-credentials",
        message=(
            f"{provider_label(config.connector_id)} access token is not stored for auth mode "
            f"'{mode}'. Paste an access token into the connector credential (secret_value) field."
        ),
    )


def _graph_client_credentials_token(store: SeedStore, config: ConnectorConfig) -> TokenResult:
    cached = _unexpired_cached_token(store, config.id)
    if cached is not None:
        return TokenResult(access_token=cached, status="live")
    missing = missing_credential_fields(store, config)
    if missing:
        return _missing_credentials_result(config, missing)
    tenant_id = str(config.settings["tenant_id"]).strip()
    token_url = (
        str(config.settings.get("token_url") or "").strip()
        or f"https://login.microsoftonline.com/{quote(tenant_id, safe='')}/oauth2/v2.0/token"
    )
    payload, error = _post_token(
        token_url,
        {
            "grant_type": "client_credentials",
            "client_id": str(config.settings["client_id"]).strip(),
            "client_secret": store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id) or "",
            "scope": GRAPH_SCOPE,
        },
    )
    if payload is None:
        return TokenResult(None, "error", f"Microsoft Graph token request failed: {error}")
    _store_oauth_payload(
        store, config.id, {"access_token": payload["access_token"], "expires_at": _expires_at(payload)}
    )
    return TokenResult(access_token=payload["access_token"], status="live")


def _box_client_credentials_token(store: SeedStore, config: ConnectorConfig) -> TokenResult:
    cached = _unexpired_cached_token(store, config.id)
    if cached is not None:
        return TokenResult(access_token=cached, status="live")
    missing = missing_credential_fields(store, config)
    if missing:
        return _missing_credentials_result(config, missing)
    token_url = str(config.settings.get("token_url") or "").strip() or _box_token_url()
    payload, error = _post_token(
        token_url,
        {
            "grant_type": "client_credentials",
            "client_id": str(config.settings["client_id"]).strip(),
            "client_secret": store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id) or "",
            "box_subject_type": str(config.settings.get("box_subject_type") or "enterprise").strip(),
            "box_subject_id": str(config.settings["enterprise_id"]).strip(),
        },
    )
    if payload is None:
        return TokenResult(None, "error", f"Box token request failed: {error}")
    _store_oauth_payload(
        store, config.id, {"access_token": payload["access_token"], "expires_at": _expires_at(payload)}
    )
    return TokenResult(access_token=payload["access_token"], status="live")


def _google_oauth_token(store: SeedStore, config: ConnectorConfig) -> TokenResult:
    stored = _cached_oauth_payload(store, config.id)
    access_token = stored.get("access_token")
    if isinstance(access_token, str) and access_token and not _is_expired(stored.get("expires_at")):
        return TokenResult(access_token=access_token, status="live")
    refresh_token = stored.get("refresh_token")
    if not isinstance(refresh_token, str) or not refresh_token.strip():
        return TokenResult(
            access_token=None,
            status="missing-credentials",
            message=(
                "Google Drive is not connected: no refresh token is stored. Save the Client ID "
                "(client_id) and client secret, then click \"Connect Google Drive\" to authorize "
                "access."
            ),
        )
    missing = missing_credential_fields(store, config)
    if missing:
        return _missing_credentials_result(config, missing)
    token_url = str(config.settings.get("token_url") or "").strip() or GOOGLE_TOKEN_URL
    payload, error = _post_token(
        token_url,
        {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": str(config.settings["client_id"]).strip(),
            "client_secret": store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id) or "",
        },
    )
    if payload is None:
        return TokenResult(None, "error", f"Google Drive token refresh failed: {error}")
    _store_oauth_payload(
        store,
        config.id,
        {
            "access_token": payload["access_token"],
            "refresh_token": str(payload.get("refresh_token") or refresh_token),
            "expires_at": _expires_at(payload),
        },
    )
    return TokenResult(access_token=payload["access_token"], status="live")


def _imanage_password_token(store: SeedStore, config: ConnectorConfig) -> TokenResult:
    stored = _cached_oauth_payload(store, config.id)
    access_token = stored.get("access_token")
    if isinstance(access_token, str) and access_token and not _is_expired(stored.get("expires_at")):
        return TokenResult(access_token=access_token, status="live")
    missing = missing_credential_fields(store, config)
    if missing:
        return _missing_credentials_result(config, missing)
    base_url = str(config.settings["base_url"]).strip().rstrip("/")
    token_url = str(config.settings.get("token_url") or "").strip() or f"{base_url}/auth/oauth2/token"
    client_id = str(config.settings["client_id"]).strip()
    client_secret = store.configuration_secret(CONNECTOR_SECRET_NAMESPACE, config.id) or ""

    payload = None
    error: str | None = None
    refresh_token = stored.get("refresh_token")
    if isinstance(refresh_token, str) and refresh_token.strip():
        payload, error = _post_token(
            token_url,
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": client_id,
                "client_secret": client_secret,
            },
        )
    if payload is None:
        payload, error = _post_token(
            token_url,
            {
                "grant_type": "password",
                "username": str(config.settings["service_username"]).strip(),
                "password": store.configuration_secret(SERVICE_PASSWORD_NAMESPACE, config.id) or "",
                "client_id": client_id,
                "client_secret": client_secret,
            },
        )
    if payload is None:
        return TokenResult(None, "error", f"iManage token request failed: {error}")
    new_payload: dict[str, Any] = {"access_token": payload["access_token"], "expires_at": _expires_at(payload)}
    new_refresh = payload.get("refresh_token")
    if isinstance(new_refresh, str) and new_refresh.strip():
        new_payload["refresh_token"] = new_refresh
    elif isinstance(refresh_token, str) and refresh_token.strip():
        new_payload["refresh_token"] = refresh_token
    _store_oauth_payload(store, config.id, new_payload)
    return TokenResult(access_token=payload["access_token"], status="live")


def _missing_credentials_result(config: ConnectorConfig, missing: list[str]) -> TokenResult:
    return TokenResult(
        access_token=None,
        status="missing-credentials",
        message=(
            f"{provider_label(config.connector_id)} {connector_auth_mode(config)} authentication "
            f"is missing required fields: {', '.join(missing)}. Save them on the connector "
            "configuration."
        ),
    )


# --- API probes ---------------------------------------------------------------


def _probe_api_access(config: ConnectorConfig, access_token: str) -> tuple[bool, str]:
    if config.connector_id == "google-drive":
        return _probe_google_drive(access_token)
    if config.connector_id == "microsoft-graph":
        return _probe_microsoft_graph(config, access_token)
    if config.connector_id == "box":
        return _probe_box(access_token)
    if config.connector_id == "imanage":
        return _probe_imanage(config, access_token)
    return True, "No API probe is defined for this connector; the stored credential was not validated."


def _probe_google_drive(access_token: str) -> tuple[bool, str]:
    response, error = _probe_get(
        f"{GOOGLE_DRIVE_API_BASE_URL}/about",
        access_token,
        params={"fields": "user(displayName,emailAddress)"},
    )
    if response is None:
        return False, f"Google Drive API probe failed: {error}"
    if response.status_code != 200:
        return False, f"Google Drive API probe returned HTTP {response.status_code}: {_error_detail(response)}"
    user = response.json().get("user") if isinstance(_safe_json(response), dict) else None
    user = user if isinstance(user, dict) else {}
    identity = str(user.get("emailAddress") or user.get("displayName") or "unknown account")
    return True, f"Connected as {identity}."


def _probe_microsoft_graph(config: ConnectorConfig, access_token: str) -> tuple[bool, str]:
    site_id = str(config.settings.get("site_id") or "").strip()
    drive_id = str(config.settings.get("drive_id") or "").strip()
    if site_id:
        url = f"{GRAPH_API_BASE_URL}/sites/{quote(site_id, safe='')}/drive"
        target = f"site {site_id} default drive"
    elif drive_id:
        url = f"{GRAPH_API_BASE_URL}/drives/{quote(drive_id, safe='')}"
        target = f"drive {drive_id}"
    else:
        url = f"{GRAPH_API_BASE_URL}/sites/root"
        target = "root SharePoint site"
    response, error = _probe_get(url, access_token)
    if response is None:
        return False, f"Microsoft Graph API probe failed: {error}"
    if response.status_code == 403:
        return False, (
            "Microsoft Graph returned HTTP 403 for the API probe: the app registration is missing "
            "the Files.Read.All or Sites.Read.All application permission, or an administrator has "
            "not granted admin consent for the tenant."
        )
    if response.status_code != 200:
        return False, f"Microsoft Graph API probe returned HTTP {response.status_code}: {_error_detail(response)}"
    payload = _safe_json(response)
    name = str(payload.get("displayName") or payload.get("name") or target) if isinstance(payload, dict) else target
    return True, f"Reached {target}: {name}."


def _probe_box(access_token: str) -> tuple[bool, str]:
    response, error = _probe_get(f"{get_settings().box_base_url.rstrip('/')}/users/me", access_token)
    if response is None:
        return False, f"Box API probe failed: {error}"
    if response.status_code != 200:
        return False, f"Box API probe returned HTTP {response.status_code}: {_error_detail(response)}"
    payload = _safe_json(response)
    payload = payload if isinstance(payload, dict) else {}
    name = str(payload.get("name") or "unknown user")
    login = str(payload.get("login") or "unknown login")
    return True, f"Connected as {name} ({login})."


def _probe_imanage(config: ConnectorConfig, access_token: str) -> tuple[bool, str]:
    base_url = str(config.settings.get("base_url") or "").strip().rstrip("/")
    customer_id = str(config.settings.get("customer_id") or "").strip()
    if customer_id:
        url = f"{base_url}/work/api/v2/customers/{quote(customer_id, safe='')}/libraries"
    else:
        url = f"{base_url}/api"
    response, error = _probe_get(url, access_token)
    if response is None:
        return False, f"iManage API probe failed: {error}"
    if response.status_code != 200:
        return False, f"iManage API probe returned HTTP {response.status_code}: {_error_detail(response)}"
    payload = _safe_json(response)
    if customer_id:
        library_ids = _imanage_library_ids(payload)
        if library_ids:
            return True, f"Found {len(library_ids)} libraries: {', '.join(library_ids)}."
        return True, f"Reached customer {customer_id} but no libraries were listed."
    version = ""
    if isinstance(payload, dict):
        version = str(payload.get("version") or payload.get("api_version") or "").strip()
    return True, f"Reached the iManage API{f' (version {version})' if version else ''}."


def _imanage_library_ids(payload: object) -> list[str]:
    entries: list[Any] = []
    if isinstance(payload, list):
        entries = payload
    elif isinstance(payload, dict):
        for key in ("data", "libraries", "results", "items"):
            candidate = payload.get(key)
            if isinstance(candidate, list):
                entries = candidate
                break
    ids: list[str] = []
    for entry in entries:
        if isinstance(entry, dict) and entry.get("id") is not None:
            ids.append(str(entry["id"]))
        elif isinstance(entry, str):
            ids.append(entry)
    return ids


def _source_root_check(config: ConnectorConfig, access_token: str) -> tuple[str, str] | None:
    """List the configured root via the ingestion client; None when no root is set."""
    try:
        if config.connector_id == "google-drive":
            folder_id = _first_setting(config, "folder_id", "drive_folder_id", "source_root_id", "root_folder_id")
            if folder_id is None:
                return None
            items = get_google_drive_client(access_token).list_files(folder_id=folder_id)
            return "ok", f"Listed {len(items)} items in Google Drive folder {folder_id}."
        if config.connector_id == "microsoft-graph":
            item_id = _first_setting(config, "drive_item_id", "source_root_id", "root_folder_id", "folder_id")
            if item_id is None:
                return None
            items = get_microsoft_graph_client(access_token).list_drive_items(
                item_id=item_id,
                drive_id=_first_setting(config, "drive_id"),
                site_id=_first_setting(config, "site_id"),
            )
            return "ok", f"Listed {len(items)} items under drive item {item_id}."
        if config.connector_id == "box":
            folder_id = _first_setting(config, "folder_id", "root_folder_id")
            if folder_id is None:
                return None
            items = get_box_client(access_token).list_folder_items(folder_id=folder_id)
            return "ok", f"Listed {len(items)} items in Box folder {folder_id}."
        if config.connector_id == "imanage":
            workspace_id = _first_setting(config, "workspace_id", "source_root_id", "root_folder_id")
            base_url = _first_setting(config, "base_url")
            if workspace_id is None or base_url is None:
                return None
            items = get_imanage_client(access_token, base_url).list_documents(
                workspace_id=workspace_id,
                documents_endpoint=_first_setting(config, "documents_endpoint"),
                customer_id=_first_setting(config, "customer_id"),
                library_id=_first_setting(config, "library_id"),
            )
            return "ok", f"Listed {len(items)} documents in iManage workspace {workspace_id}."
    except (BoxError, CloudSourceError) as exc:
        return "incomplete", f"Authentication succeeded but the configured source root could not be listed: {exc}"
    return None


def _first_setting(config: ConnectorConfig, *keys: str) -> str | None:
    for key in keys:
        value = str(config.settings.get(key) or "").strip()
        if value:
            return value
    return None


# --- HTTP + cache helpers -------------------------------------------------------


def _post_token(token_url: str, data: dict[str, str]) -> tuple[dict[str, Any] | None, str | None]:
    try:
        validate_public_url(token_url)
    except EgressBlocked as exc:
        return None, f"token endpoint is not permitted by egress policy: {exc}"
    try:
        response = httpx.post(
            token_url,
            data=data,
            headers={"Accept": "application/json"},
            timeout=TOKEN_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        return None, f"request to {token_url} failed: {exc}"
    if response.status_code != 200:
        return None, f"token endpoint returned HTTP {response.status_code}: {_error_detail(response)}"
    payload = _safe_json(response)
    if not isinstance(payload, dict):
        return None, "token endpoint response is not valid JSON."
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token.strip():
        return None, "token endpoint response did not include an access_token."
    return payload, None


def _probe_get(
    url: str,
    access_token: str,
    *,
    params: dict[str, str] | None = None,
) -> tuple[httpx.Response | None, str | None]:
    try:
        validate_public_url(url)
    except EgressBlocked as exc:
        return None, f"endpoint is not permitted by egress policy: {exc}"
    try:
        response = httpx.get(
            url,
            headers={"Authorization": f"Bearer {access_token}"},
            params=params,
            timeout=TOKEN_TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        return None, f"request to {url} failed: {exc}"
    return response, None


def _error_detail(response: httpx.Response) -> str:
    # Mirrors oidc._safe_error_detail: prefer the vendor's structured error fields.
    payload = _safe_json(response)
    if isinstance(payload, dict):
        detail = payload.get("error_description") or payload.get("error") or payload.get("message")
        if detail:
            return str(detail)
    return (response.text or "unknown error")[:300]


def _safe_json(response: httpx.Response) -> object | None:
    try:
        return response.json()
    except ValueError:
        return None


def _box_token_url() -> str:
    parts = urlsplit(get_settings().box_base_url)
    if parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc}/oauth2/token"
    return "https://api.box.com/oauth2/token"


def _expires_at(payload: dict[str, Any]) -> int:
    try:
        expires_in = int(payload.get("expires_in") or 3600)
    except (TypeError, ValueError):
        expires_in = 3600
    return int(time.time()) + expires_in - TOKEN_EXPIRY_MARGIN_SECONDS


def _is_expired(expires_at: object) -> bool:
    if not isinstance(expires_at, (int, float)):
        return True
    return time.time() >= float(expires_at)


def _unexpired_cached_token(store: SeedStore, config_id: str) -> str | None:
    payload = _cached_oauth_payload(store, config_id)
    access_token = payload.get("access_token")
    if isinstance(access_token, str) and access_token and not _is_expired(payload.get("expires_at")):
        return access_token
    return None


def _cached_oauth_payload(store: SeedStore, config_id: str) -> dict[str, Any]:
    raw = store.configuration_secret(OAUTH_TOKEN_NAMESPACE, config_id)
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _store_oauth_payload(store: SeedStore, config_id: str, payload: dict[str, Any]) -> None:
    store.set_configuration_secret(OAUTH_TOKEN_NAMESPACE, config_id, json.dumps(payload))
