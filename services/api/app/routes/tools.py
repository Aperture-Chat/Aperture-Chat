from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse

from app.core.config import get_settings
from app.core.generated_artifacts import generated_artifact_file
from app.core.mcp_runtime import call_mcp_tool, check_mcp_server, mcp_env_from_auth
from app.core.net_guard import EgressBlocked, validate_public_url
from app.core.policy import assert_group_permission, assert_tool_access, require_admin_or_owner
from app.core.script_tools import clamp_timeout_seconds, run_custom_script
from app.core.sessions import (
    sign_approval_token,
    sign_oidc_state,
    verify_asset_token,
    verify_oidc_state,
)
from app.models.schemas import (
    CustomScriptRunRequest,
    CustomScriptRunResponse,
    McpHealthResponse,
    McpToolCallRequest,
    McpToolCallResponse,
    Role,
    ToolConfig,
    User,
)
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/tools", tags=["tools"])


@router.get("/generated-artifacts/{artifact_name}")
def generated_response_action_artifact(
    artifact_name: str,
    token: str = Query(),
    filename: str | None = Query(default=None),
) -> FileResponse:
    settings = get_settings()
    if not verify_asset_token(token, artifact_name, settings.secret_key):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Generated artifact link is invalid or expired.",
        )
    resolved = generated_artifact_file(artifact_name)
    if resolved is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Generated artifact not found.")
    path, media_type = resolved
    safe_filename = re.sub(
        r"[^A-Za-z0-9._ -]+", "-", Path(filename or artifact_name).name
    ).strip(" .-") or artifact_name
    return FileResponse(
        path,
        media_type=media_type,
        headers={
            "Cache-Control": "private, max-age=86400",
            "Content-Disposition": f'attachment; filename="{safe_filename}"',
        },
    )


@router.get("/{config_id}/oauth/authorize-url")
def mcp_oauth_authorize_url(
    config_id: str,
    request: Request,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    """Return an IdP authorize URL carrying signed state bound to this tool.

    The callback below rejects any code exchange whose state was not minted here,
    so an attacker cannot drive the token exchange for a known config id.
    """
    require_admin_or_owner(actor)
    tool = _get_configurable_tool(config_id, actor, store)
    authorization_url = str(tool.settings.get("oauth_authorization_url") or "").strip()
    client_id = str(tool.settings.get("client_id") or "").strip()
    if not authorization_url or not client_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This tool is missing its OAuth authorization URL or client ID.",
        )
    state = sign_oidc_state({"config_id": tool.id, "actor_id": actor.id}, get_settings().secret_key)
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": _configured_callback_url(tool),
        "state": state,
    }
    scope = _oauth_scope(tool)
    if scope:
        params["scope"] = scope
    separator = "&" if "?" in authorization_url else "?"
    return {"authorize_url": f"{authorization_url}{separator}{urlencode(params)}", "state": state}


@router.get("/{config_id}/oauth/callback")
def mcp_oauth_callback(
    config_id: str,
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    tool = store.tool_configs.get(config_id)
    if tool is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tool configuration.")
    if error:
        return {
            "status": "error",
            "tool_config_id": tool.id,
            "name": tool.name,
            "error": error,
            "state": state,
        }
    if code and _oauth_token_url(tool):
        if not state:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The OAuth callback is missing its state parameter.",
            )
        state_payload = verify_oidc_state(state, get_settings().secret_key)
        if state_payload is None or str(state_payload.get("config_id") or "") != tool.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The OAuth state is invalid or expired; restart the MCP connection.",
            )
        token_payload = _exchange_oauth_code(tool, code, _callback_url(request), store)
        store.set_configuration_secret("tool-oauth-token", tool.id, json.dumps(token_payload))
        settings = dict(tool.settings)
        settings["oauth_token_status"] = "stored"
        settings["oauth_last_callback_state"] = state
        settings["oauth_token_type"] = token_payload.get("token_type")
        settings["oauth_scope"] = token_payload.get("scope")
        tool.settings = settings
        return {
            "status": "token_stored",
            "tool_config_id": tool.id,
            "name": tool.name,
            "code": "exchanged",
            "state": state,
            "token_type": token_payload.get("token_type"),
            "scope": token_payload.get("scope"),
        }
    return {
        "status": "received" if code else "ready",
        "tool_config_id": tool.id,
        "name": tool.name,
        "code": "received" if code else None,
        "state": state,
    }


@router.post("/{config_id}/approve")
def approve_mcp_tool(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    """Issue a signed, short-lived approval token for an approval-required MCP tool.

    The chat runtime accepts this token (bound to the approving user + tool) as
    the proof of approval, instead of trusting a client-asserted id list.
    """
    tool = _get_configurable_tool(config_id, actor, store)
    if tool.tool_type != "mcp":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only MCP tools require approval.")
    mcp_connector = store.connectors.get("mcp")
    if mcp_connector is None or not (mcp_connector.platform_enabled and mcp_connector.tenant_enabled):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="MCP servers are turned off for this workspace.",
        )
    if not tool.approval_required:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This tool does not require approval.")
    token = sign_approval_token(actor.id, tool.id, get_settings().secret_key)
    store.record_audit(actor, "tool.mcp_approval_granted", tool.id, {"name": tool.name})
    return {"tool_config_id": tool.id, "name": tool.name, "approval_token": token}


@router.post("/{config_id}/mcp/health")
def mcp_health(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> McpHealthResponse:
    require_admin_or_owner(actor)
    tool = _get_configurable_tool(config_id, actor, store)
    response = check_mcp_server(tool, extra_env=_mcp_oauth_env(store, tool))
    store.record_audit(
        actor,
        "tool.mcp_health_checked",
        tool.id,
        {
            "status": response.status,
            "transport": response.transport,
            "command": response.command,
            "tool_count": len(response.tools),
        },
    )
    return response


@router.post("/{config_id}/mcp/call")
def mcp_call(
    config_id: str,
    payload: McpToolCallRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> McpToolCallResponse:
    require_admin_or_owner(actor)
    tool = _get_configurable_tool(config_id, actor, store)
    response = call_mcp_tool(
        tool,
        tool_name=payload.tool_name,
        arguments=payload.arguments,
        label=payload.label,
        extra_env=_mcp_oauth_env(store, tool),
    )
    store.record_audit(
        actor,
        "tool.mcp_tool_called",
        tool.id,
        {
            "status": response.status,
            "transport": response.transport,
            "tool_name": response.tool_name,
            "label": response.label,
            "is_error": response.is_error,
            "result_chars": len(response.result_text or ""),
        },
    )
    return response


@router.post("/{config_id}/run-script")
def run_script_tool(
    config_id: str,
    payload: CustomScriptRunRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> CustomScriptRunResponse:
    """Run an admin-authored custom script tool over caller-supplied text.

    Access follows the same policy as every other tool: the tool must be
    enabled, in the caller's tenant, and open to one of the caller's groups.
    The script executes in the sandbox described in app/core/script_tools.py.
    """
    tool = _get_configurable_tool(config_id, actor, store)
    if tool.tool_type != "custom_script":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only custom script tools can be run this way.",
        )
    assert_group_permission(actor, store.groups, "tools_access", "Tool access")
    assert_tool_access(actor, tool)
    script = str(tool.settings.get("script") or "")
    if not script.strip():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This tool has no script configured yet.",
        )
    outcome = run_custom_script(
        script,
        payload.input,
        clamp_timeout_seconds(tool.settings.get("timeout_seconds")),
    )
    store.record_audit(
        actor,
        "tool.custom_script_executed",
        tool.id,
        {
            "name": tool.name,
            "status": outcome.status,
            "duration_ms": outcome.duration_ms,
            "input_chars": len(payload.input),
            "output_chars": len(outcome.output),
            "truncated": outcome.truncated,
        },
    )
    return CustomScriptRunResponse(
        tool_config_id=tool.id,
        name=tool.name,
        status=outcome.status,
        output=outcome.output,
        error=outcome.error,
        exit_code=outcome.exit_code,
        duration_ms=outcome.duration_ms,
        truncated=outcome.truncated,
        artifacts=[artifact.__dict__ for artifact in outcome.artifacts],
    )


def _oauth_token_url(tool: ToolConfig) -> str:
    return str(tool.settings.get("oauth_token_url") or "").strip()


def _configured_callback_url(tool: ToolConfig) -> str:
    configured = str(tool.settings.get("oauth_callback_url") or "").strip()
    if configured:
        return configured
    base = get_settings().api_base_url.rstrip("/")
    return f"{base}/api/tools/{tool.id}/oauth/callback"


def _oauth_scope(tool: ToolConfig) -> str:
    scopes = tool.settings.get("scopes")
    if isinstance(scopes, list) and scopes:
        return " ".join(str(scope) for scope in scopes)
    if isinstance(scopes, str):
        return scopes.strip()
    return ""


def _mcp_oauth_env(store: SeedStore, tool: ToolConfig) -> dict[str, str]:
    return mcp_env_from_auth(
        tool,
        stored_secret=store.configuration_secret("tool", tool.id),
        raw_oauth_token_json=store.configuration_secret("tool-oauth-token", tool.id),
    )


def _callback_url(request: Request) -> str:
    return str(request.url).split("?", 1)[0]


def _exchange_oauth_code(tool: ToolConfig, code: str, callback_url: str, store: SeedStore) -> dict[str, Any]:
    token_url = _oauth_token_url(tool)
    client_id = str(tool.settings.get("client_id") or "").strip()
    if not client_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="OAuth client ID is required.")
    client_secret = store.configuration_secret("tool", tool.id)
    try:
        validate_public_url(token_url)
    except EgressBlocked as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"OAuth token endpoint is not permitted: {exc}",
        ) from exc
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": callback_url,
        "client_id": client_id,
    }
    if client_secret:
        payload["client_secret"] = client_secret
    try:
        with httpx.Client(timeout=15.0) as client:
            response = client.post(token_url, data=payload, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"OAuth token exchange failed: {exc}",
        ) from exc
    if response.status_code >= 400:
        detail = response.text[:500] if response.text else response.reason_phrase
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"OAuth token endpoint returned {response.status_code}: {detail}",
        )
    try:
        token_payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OAuth token endpoint did not return JSON.",
        ) from exc
    access_token = token_payload.get("access_token")
    if not isinstance(access_token, str) or not access_token.strip():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OAuth token endpoint did not return an access token.",
        )
    return token_payload


def _get_configurable_tool(config_id: str, actor: User, store: SeedStore) -> ToolConfig:
    tool = store.tool_configs.get(config_id)
    if tool is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown tool configuration.")
    if actor.role != Role.PLATFORM_OWNER and actor.tenant_id != tool.tenant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Tool access is restricted by tenant policy.")
    return tool
