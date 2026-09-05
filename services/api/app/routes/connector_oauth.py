"""Public OAuth callback for connector authorization flows.

Two flows land here, distinguished by the signed OIDC-style state token:

- Workspace flow (Google Drive knowledge sync): started by a platform owner from the
  connector configuration; the outcome redirects back to the web app.
- Per-user flow (chat attachments): started by any user from the attach menu
  in a popup window; tokens are stored per (config, user) so each user only
  ever lists their own files. The outcome renders a small page that closes
  the popup.

The provider redirects the browser here, so the route is unauthenticated; the
signed state proves the flow was started inside this deployment. Outcomes are
reported honestly — no fake success states.
"""

from __future__ import annotations

from html import escape
from urllib.parse import quote

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from app.core.config import get_settings
from app.core.connector_auth import (
    exchange_google_authorization_code,
    exchange_user_authorization_code,
    user_oauth_provider,
)
from app.core.sessions import verify_oidc_state
from app.models.schemas import Role
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore

router = APIRouter(prefix="/api/connector-oauth", tags=["connector-oauth"])


@router.get("/callback")
def connector_oauth_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    store: SeedStore = Depends(get_store),
) -> Response:
    if not state:
        return _error_redirect("The OAuth callback is missing its state parameter.")
    payload = verify_oidc_state(state, get_settings().secret_key)
    if payload is None:
        return _error_redirect("The OAuth state is invalid or expired; restart the connect flow.")
    if str(payload.get("subject") or "") == "user":
        return _user_callback(payload, code, error, store)
    return _workspace_callback(payload, code, error, store)


def _workspace_callback(
    payload: dict, code: str | None, error: str | None, store: SeedStore
) -> RedirectResponse:
    if error:
        return _error_redirect(f"The provider denied authorization: {error}.")
    config = store.connector_configs.get(str(payload.get("config_id") or ""))
    if config is None or config.connector_id != "google-drive":
        return _error_redirect("The OAuth callback does not match a Google Drive connector configuration.")
    # Signed state proves who started consent, but their current privilege may
    # have changed before the provider returned. Shared credentials stay owner-only.
    actor = store.users.get(str(payload.get("actor_id") or ""))
    if actor is None or not actor.active or actor.role != Role.PLATFORM_OWNER:
        return _error_redirect("Only an active platform owner can connect workspace credentials.")
    if not code:
        return _error_redirect("The provider did not return an authorization code.")

    exchange_error = exchange_google_authorization_code(store, config, code)
    if exchange_error is not None:
        return _error_redirect(exchange_error)

    settings = dict(config.settings)
    settings["oauth_status"] = "connected"
    settings["oauth_connected_at"] = "Saved now"
    config.settings = settings
    store.record_audit(
        actor,
        "admin.connector_oauth_connected",
        config.id,
        {"connector_id": config.connector_id, "refresh_token": "[redacted]"},
    )
    store.save_runtime_state()
    return RedirectResponse(url=f"{_web_origin()}/?connector_oauth=success", status_code=302)


def _user_callback(payload: dict, code: str | None, error: str | None, store: SeedStore) -> HTMLResponse:
    config = store.connector_configs.get(str(payload.get("config_id") or ""))
    brand = store.brand_name(config.tenant_id if config is not None else None)
    if error:
        return _popup_page(f"The provider denied authorization: {error}.", success=False, brand=brand)
    if config is None or user_oauth_provider(config) is None:
        return _popup_page(
            "The OAuth callback does not match a connector that supports per-user connections.",
            success=False,
            brand=brand,
        )
    actor = store.users.get(str(payload.get("actor_id") or ""))
    if actor is None:
        return _popup_page(
            "The OAuth state does not match a known user; restart the connect flow.",
            success=False,
            brand=brand,
        )
    if not code:
        return _popup_page("The provider did not return an authorization code.", success=False, brand=brand)

    exchange_error = exchange_user_authorization_code(store, config, actor.id, code)
    if exchange_error is not None:
        return _popup_page(exchange_error, success=False, brand=brand)

    store.record_audit(
        actor,
        "chat.connector_user_oauth_connected",
        config.id,
        {"connector_id": config.connector_id, "refresh_token": "[redacted]"},
    )
    store.save_runtime_state()
    label = user_oauth_provider(config).label if user_oauth_provider(config) else config.connector_id
    return _popup_page(
        f"Your {label} account is connected. Return to {brand} — the file list loads automatically.",
        success=True,
        brand=brand,
    )


def _popup_page(message: str, *, success: bool, brand: str = "Aperture Chat") -> HTMLResponse:
    """Minimal page for the per-user popup: report the outcome, then try to close."""
    heading = "Account connected" if success else "Connection failed"
    return HTMLResponse(
        content=(
            "<!doctype html><html><head><meta charset=\"utf-8\">"
            f"<title>{escape(brand)} — {escape(heading)}</title>"
            "<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;"
            "color:#1c2430}h1{font-size:18px}p{font-size:14px;line-height:1.5;color:#3d4757}</style>"
            "</head><body>"
            f"<h1>{escape(heading)}</h1><p>{escape(message)}</p>"
            "<p>You can close this window.</p>"
            + ("<script>setTimeout(function(){window.close();},1500);</script>" if success else "")
            + "</body></html>"
        ),
        status_code=200 if success else 400,
    )


def _error_redirect(message: str) -> RedirectResponse:
    return RedirectResponse(
        url=f"{_web_origin()}/?connector_oauth=error&message={quote(message[:600])}",
        status_code=302,
    )


def _web_origin() -> str:
    origins = get_settings().web_origin_list
    return origins[0] if origins else "http://localhost:5173"
