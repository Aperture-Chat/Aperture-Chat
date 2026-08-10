from __future__ import annotations

import json
import os
import queue
import shlex
import subprocess
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin

import httpx

from app.core.config import get_settings
from app.core.net_guard import REDIRECT_GUARD_HOOKS, EgressBlocked, validate_public_url
from app.models.schemas import McpHealthResponse, McpToolCallResponse, McpToolSummary, ToolConfig

_MCP_PROTOCOL_VERSION = "2025-03-26"
_HTTP_TRANSPORTS = {"http", "https", "streamable-http", "streamable_http"}
_SSE_TRANSPORTS = {"sse", "http+sse", "http-sse"}
_MAX_MCP_HTTP_BYTES = 2 * 1024 * 1024


class McpRuntimeError(Exception):
    pass


def _allowed_stdio_commands() -> set[str]:
    """Operator-approved MCP executables from APERTURE_MCP_ALLOWED_COMMANDS."""
    raw = os.environ.get("APERTURE_MCP_ALLOWED_COMMANDS", "")
    return {part for part in shlex.split(raw.replace(",", " ")) if part.strip()}


def _assert_command_allowed(command: str) -> None:
    """Fail closed on unapproved MCP executables in deployed environments.

    An allowlist, when set, is enforced in every environment. With no allowlist,
    stdio execution is permitted in local/dev (the owner's Hermes demo) but
    refused in deployed environments so a stray config cannot spawn arbitrary
    host processes.
    """
    allowlist = _allowed_stdio_commands()
    if allowlist:
        if command in allowlist or os.path.basename(command) in allowlist:
            return
        raise McpRuntimeError(f"MCP command is not on the allowed executables list: {command}")
    if not get_settings().is_local_environment:
        raise McpRuntimeError(
            "MCP stdio execution is disabled in this environment. "
            "Set APERTURE_MCP_ALLOWED_COMMANDS to permit specific executables."
        )


def oauth_env_from_token_payload(raw_token_json: str | None) -> dict[str, str]:
    """Build the MCP subprocess env vars from a stored OAuth token payload.

    The token is exchanged by the tool OAuth callback and stored as JSON in the
    vault; MCP servers consume it as MCP_OAUTH_ACCESS_TOKEN.
    """
    if not raw_token_json:
        return {}
    try:
        payload = json.loads(raw_token_json)
    except ValueError:
        return {}
    if not isinstance(payload, dict):
        return {}
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token.strip():
        return {}
    env = {"MCP_OAUTH_ACCESS_TOKEN": access_token.strip()}
    token_type = payload.get("token_type")
    if isinstance(token_type, str) and token_type.strip():
        env["MCP_OAUTH_TOKEN_TYPE"] = token_type.strip()
    return env


def mcp_env_from_auth(
    tool: ToolConfig,
    *,
    stored_secret: str | None = None,
    raw_oauth_token_json: str | None = None,
) -> dict[str, str]:
    env = oauth_env_from_token_payload(raw_oauth_token_json)
    auth_type = str(tool.settings.get("auth_type") or "none").strip().lower()
    if auth_type == "bearer-token" and stored_secret and stored_secret.strip():
        token = stored_secret.strip()
        env.update(
            {
                "MCP_BEARER_TOKEN": token,
                "MCP_AUTH_TOKEN": token,
                "MCP_AUTHORIZATION_HEADER": f"Bearer {token}",
            }
        )
    return env


def _subprocess_env(extra_env: dict[str, str] | None) -> dict[str, str] | None:
    if not extra_env:
        return None
    return {**os.environ, **extra_env}


@dataclass
class McpRuntimeResult:
    status: str
    message: str
    tools: list[McpToolSummary] = field(default_factory=list)
    server_info: dict[str, Any] = field(default_factory=dict)


@dataclass
class McpToolRuntimeResult:
    status: str
    message: str
    tool_name: str
    result_text: str | None = None
    structured_content: dict[str, Any] | list[Any] | str | int | float | bool | None = None
    is_error: bool = False


def check_mcp_server(
    tool: ToolConfig,
    *,
    timeout_seconds: float = 6.0,
    extra_env: dict[str, str] | None = None,
    httpx_transport: httpx.BaseTransport | None = None,
) -> McpHealthResponse:
    settings = tool.settings
    transport = str(settings.get("transport") or "stdio").strip().lower()
    command = str(settings.get("command") or "").strip()
    if transport in _HTTP_TRANSPORTS or transport in _SSE_TRANSPORTS:
        url = _endpoint_url(tool)
        if not url:
            return McpHealthResponse(
                tool_config_id=tool.id,
                name=tool.name,
                transport=transport,
                command=None,
                status="error",
                message="MCP endpoint URL is required before this server can be tested.",
            )
        runner = _run_http_health if transport in _HTTP_TRANSPORTS else _run_sse_health
        try:
            result = runner(
                url,
                timeout_seconds=timeout_seconds,
                headers=_http_headers_from_env(extra_env),
                httpx_transport=httpx_transport,
            )
        except McpRuntimeError as exc:
            result = McpRuntimeResult(status="error", message=str(exc))
        return McpHealthResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport=transport,
            command=None,
            status=result.status,
            message=result.message,
            tools=result.tools,
            server_info=result.server_info,
        )
    if transport != "stdio":
        return McpHealthResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport=transport,
            command=command or None,
            status="unsupported",
            message=(
                f"Unknown MCP transport '{transport}'. "
                "Supported transports are stdio, http (streamable), and sse."
            ),
        )
    if not command:
        return McpHealthResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport=transport,
            command=None,
            status="error",
            message="MCP stdio command is required before this server can be tested.",
        )
    try:
        result = _run_stdio_health(command, _args_from_settings(settings), timeout_seconds=timeout_seconds, extra_env=extra_env)
    except FileNotFoundError:
        result = McpRuntimeResult(status="error", message=f"MCP command not found: {command}")
    except subprocess.TimeoutExpired:
        result = McpRuntimeResult(status="error", message=f"MCP server did not respond within {timeout_seconds:g}s.")
    except McpRuntimeError as exc:
        result = McpRuntimeResult(status="error", message=str(exc))
    return McpHealthResponse(
        tool_config_id=tool.id,
        name=tool.name,
        transport=transport,
        command=command,
        status=result.status,
        message=result.message,
        tools=result.tools,
        server_info=result.server_info,
    )


def call_mcp_tool(
    tool: ToolConfig,
    *,
    tool_name: str,
    arguments: dict[str, Any] | None = None,
    label: str | None = None,
    timeout_seconds: float = 8.0,
    extra_env: dict[str, str] | None = None,
    httpx_transport: httpx.BaseTransport | None = None,
) -> McpToolCallResponse:
    settings = tool.settings
    transport = str(settings.get("transport") or "stdio").strip().lower()
    command = str(settings.get("command") or "").strip()
    clean_tool_name = tool_name.strip()
    if transport in _HTTP_TRANSPORTS or transport in _SSE_TRANSPORTS:
        url = _endpoint_url(tool)
        if not url:
            return McpToolCallResponse(
                tool_config_id=tool.id,
                name=tool.name,
                transport=transport,
                command=None,
                tool_name=clean_tool_name,
                label=label,
                status="error",
                message="MCP endpoint URL is required before this server can run tools.",
                is_error=True,
            )
        if not clean_tool_name:
            return McpToolCallResponse(
                tool_config_id=tool.id,
                name=tool.name,
                transport=transport,
                command=None,
                tool_name=clean_tool_name,
                label=label,
                status="error",
                message="MCP tool_name is required.",
                is_error=True,
            )
        runner = _run_http_tool_call if transport in _HTTP_TRANSPORTS else _run_sse_tool_call
        try:
            result = runner(
                url,
                tool_name=clean_tool_name,
                arguments=arguments or {},
                timeout_seconds=timeout_seconds,
                headers=_http_headers_from_env(extra_env),
                httpx_transport=httpx_transport,
            )
        except McpRuntimeError as exc:
            result = McpToolRuntimeResult(
                status="error",
                message=str(exc),
                tool_name=clean_tool_name,
                is_error=True,
            )
        return McpToolCallResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport=transport,
            command=None,
            tool_name=clean_tool_name,
            label=label,
            status=result.status,
            message=result.message,
            result_text=result.result_text,
            structured_content=result.structured_content,
            is_error=result.is_error,
        )
    if transport != "stdio":
        return McpToolCallResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport=transport,
            command=command or None,
            tool_name=clean_tool_name,
            label=label,
            status="unsupported",
            message=(
                f"Unknown MCP transport '{transport}'. "
                "Supported transports are stdio, http (streamable), and sse."
            ),
        )
    if not command:
        return McpToolCallResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport=transport,
            command=None,
            tool_name=clean_tool_name,
            label=label,
            status="error",
            message="MCP stdio command is required before this server can run tools.",
            is_error=True,
        )
    if not clean_tool_name:
        return McpToolCallResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport=transport,
            command=command,
            tool_name=clean_tool_name,
            label=label,
            status="error",
            message="MCP tool_name is required.",
            is_error=True,
        )
    try:
        result = _run_stdio_tool_call(
            command,
            _args_from_settings(settings),
            tool_name=clean_tool_name,
            arguments=arguments or {},
            timeout_seconds=timeout_seconds,
            extra_env=extra_env,
        )
    except FileNotFoundError:
        result = McpToolRuntimeResult(
            status="error",
            message=f"MCP command not found: {command}",
            tool_name=clean_tool_name,
            is_error=True,
        )
    except subprocess.TimeoutExpired:
        result = McpToolRuntimeResult(
            status="error",
            message=f"MCP tool call did not complete within {timeout_seconds:g}s.",
            tool_name=clean_tool_name,
            is_error=True,
        )
    except McpRuntimeError as exc:
        result = McpToolRuntimeResult(
            status="error",
            message=str(exc),
            tool_name=clean_tool_name,
            is_error=True,
        )
    return McpToolCallResponse(
        tool_config_id=tool.id,
        name=tool.name,
        transport=transport,
        command=command,
        tool_name=clean_tool_name,
        label=label,
        status=result.status,
        message=result.message,
        result_text=result.result_text,
        structured_content=result.structured_content,
        is_error=result.is_error,
    )


def _run_stdio_health(
    command: str,
    args: list[str],
    *,
    timeout_seconds: float,
    extra_env: dict[str, str] | None = None,
) -> McpRuntimeResult:
    _assert_command_allowed(command)
    payload = _mcp_payload()
    process = subprocess.Popen(
        [command, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_subprocess_env(extra_env),
    )
    try:
        stdout, stderr = process.communicate(payload, timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        raise
    messages = _parse_mcp_messages(stdout)
    if not messages:
        stderr_text = stderr.decode("utf-8", errors="replace").strip()
        raise McpRuntimeError(stderr_text or "MCP server returned no JSON-RPC messages.")
    return _health_result_from_messages(messages)


def _health_result_from_messages(messages: list[dict[str, Any]]) -> McpRuntimeResult:
    initialize = _message_by_id(messages, 1)
    tool_list = _message_by_id(messages, 2)
    if tool_list is None:
        error_message = _error_message(initialize) or _first_error(messages)
        raise McpRuntimeError(error_message or "MCP server did not return a tools/list response.")
    if "error" in tool_list:
        raise McpRuntimeError(_error_message(tool_list) or "MCP tools/list returned an error.")
    result = tool_list.get("result") if isinstance(tool_list.get("result"), dict) else {}
    tools = [_tool_summary(tool) for tool in result.get("tools") or [] if isinstance(tool, dict)]
    server_info = {}
    if initialize and isinstance(initialize.get("result"), dict):
        raw_info = initialize["result"].get("serverInfo")
        if isinstance(raw_info, dict):
            server_info = raw_info
    return McpRuntimeResult(
        status="ready",
        message=f"MCP server responded with {len(tools)} tool{'' if len(tools) == 1 else 's'}.",
        tools=tools,
        server_info=server_info,
    )


def _run_stdio_tool_call(
    command: str,
    args: list[str],
    *,
    tool_name: str,
    arguments: dict[str, Any],
    timeout_seconds: float,
    extra_env: dict[str, str] | None = None,
) -> McpToolRuntimeResult:
    _assert_command_allowed(command)
    payload = _mcp_tool_call_payload(tool_name, arguments)
    process = subprocess.Popen(
        [command, *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_subprocess_env(extra_env),
    )
    try:
        messages, stderr_text = _exchange_stdio_messages(
            process, payload, target_id=3, timeout_seconds=timeout_seconds
        )
    finally:
        _reap_stdio_process(process)
    if not messages:
        raise McpRuntimeError(stderr_text or "MCP server returned no JSON-RPC messages.")
    return _tool_result_from_messages(messages, tool_name=tool_name)


def _exchange_stdio_messages(
    process: subprocess.Popen[bytes],
    payload: bytes,
    *,
    target_id: int,
    timeout_seconds: float,
) -> tuple[list[dict[str, Any]], str]:
    """Write the request batch, then read replies with stdin held open.

    FastMCP-family servers treat stdin EOF as shutdown and cancel in-flight
    requests, so the communicate() pattern (write everything, close stdin,
    wait for exit) silently killed every tool call that performed real work —
    only instant responses such as tools/list won the race. stdin therefore
    stays open until the target response arrives, the server exits on its
    own, or the timeout lapses.
    """
    lines: queue.Queue[bytes | None] = queue.Queue()
    stderr_chunks: list[bytes] = []

    def _drain_stdout() -> None:
        assert process.stdout is not None
        for raw_line in process.stdout:
            lines.put(raw_line)
        lines.put(None)

    def _drain_stderr() -> None:
        assert process.stderr is not None
        stderr_chunks.append(process.stderr.read() or b"")

    threading.Thread(target=_drain_stdout, daemon=True).start()
    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    assert process.stdin is not None
    try:
        process.stdin.write(payload)
        process.stdin.flush()
    except (BrokenPipeError, OSError):
        # The server exited before reading; its messages/stderr tell the story.
        pass

    messages: list[dict[str, Any]] = []
    answered = False
    stdout_closed = False
    deadline = time.monotonic() + timeout_seconds
    while not answered:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            process.kill()
            raise subprocess.TimeoutExpired(process.args, timeout_seconds)
        try:
            raw_line = lines.get(timeout=min(remaining, 0.25))
        except queue.Empty:
            continue
        if raw_line is None:
            stdout_closed = True
            break
        for parsed in _parse_mcp_messages(raw_line):
            messages.append(parsed)
            if parsed.get("id") == target_id:
                answered = True
    if stdout_closed:
        # The server exited without answering; let stderr finish so the
        # caller can surface the real failure text.
        stderr_thread.join(timeout=1.5)
    stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace").strip()
    return messages, stderr_text


def _reap_stdio_process(process: subprocess.Popen[bytes]) -> None:
    """Close stdin (EOF requests orderly shutdown), then make sure it is gone."""
    try:
        if process.stdin is not None:
            process.stdin.close()
    except OSError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


def _tool_result_from_messages(
    messages: list[dict[str, Any]], *, tool_name: str
) -> McpToolRuntimeResult:
    tool_call = _message_by_id(messages, 3)
    if tool_call is None:
        error_message = _first_error(messages)
        raise McpRuntimeError(error_message or "MCP server did not return a tools/call response.")
    if "error" in tool_call:
        raise McpRuntimeError(_error_message(tool_call) or "MCP tools/call returned an error.")
    result = tool_call.get("result") if isinstance(tool_call.get("result"), dict) else {}
    is_error = bool(result.get("isError"))
    result_text = _tool_result_text(result)
    structured_content = result.get("structuredContent")
    message = "MCP tool returned an error result." if is_error else "MCP tool call completed."
    if not result_text and structured_content is None:
        message = f"{message} No text or structured content was returned."
    return McpToolRuntimeResult(
        status="error" if is_error else "ready",
        message=message,
        tool_name=tool_name,
        result_text=result_text,
        structured_content=structured_content,
        is_error=is_error,
    )


def _args_from_settings(settings: dict[str, Any]) -> list[str]:
    raw_args = settings.get("args") or []
    if isinstance(raw_args, list):
        return [str(arg) for arg in raw_args if str(arg).strip()]
    if isinstance(raw_args, str):
        return [part.strip() for part in raw_args.split(",") if part.strip()]
    return []


def _initialize_message() -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": _MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "aperture-chat", "version": "0.1.0"},
        },
    }


def _initialized_notification() -> dict[str, Any]:
    return {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}


def _tools_list_message() -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}


def _tools_call_message(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    }


def _encode_stdio_payload(messages: list[dict[str, Any]]) -> bytes:
    return (
        "\n".join(json.dumps(message, separators=(",", ":")) for message in messages) + "\n"
    ).encode("utf-8")


def _mcp_tool_call_payload(tool_name: str, arguments: dict[str, Any]) -> bytes:
    return _encode_stdio_payload(
        [
            _initialize_message(),
            _initialized_notification(),
            _tools_list_message(),
            _tools_call_message(tool_name, arguments),
        ]
    )


def _mcp_payload() -> bytes:
    return _encode_stdio_payload(
        [_initialize_message(), _initialized_notification(), _tools_list_message()]
    )


def _endpoint_url(tool: ToolConfig) -> str:
    candidates = (
        tool.endpoint_url,
        tool.settings.get("url"),
        tool.settings.get("endpoint_url"),
        tool.settings.get("endpoint"),
    )
    for candidate in candidates:
        value = str(candidate or "").strip()
        if value:
            return value
    return ""


def _http_headers_from_env(extra_env: dict[str, str] | None) -> dict[str, str]:
    """Translate the stdio env-var auth contract into HTTP request headers."""
    if not extra_env:
        return {}
    authorization = (extra_env.get("MCP_AUTHORIZATION_HEADER") or "").strip()
    if not authorization:
        token = (
            extra_env.get("MCP_OAUTH_ACCESS_TOKEN") or extra_env.get("MCP_BEARER_TOKEN") or ""
        ).strip()
        if token:
            authorization = f"Bearer {token}"
    return {"Authorization": authorization} if authorization else {}


def _validated_mcp_url(url: str) -> str:
    try:
        validate_public_url(url)
    except EgressBlocked as exc:
        raise McpRuntimeError(f"MCP endpoint URL is not permitted: {exc}") from exc
    return url


def _mcp_http_client(
    *, timeout_seconds: float, httpx_transport: httpx.BaseTransport | None
) -> httpx.Client:
    # Every hop, including redirects, re-validates against the egress guard so
    # an operator-entered endpoint cannot pivot into private address space.
    return httpx.Client(
        timeout=max(timeout_seconds, 1.0),
        follow_redirects=True,
        event_hooks=REDIRECT_GUARD_HOOKS,
        transport=httpx_transport,
    )


def _http_status_error(status_code: int, body_text: str) -> McpRuntimeError:
    hint = (
        " Check the configured authentication for this MCP endpoint."
        if status_code in {401, 403}
        else ""
    )
    detail = body_text.strip()[:300]
    return McpRuntimeError(
        f"MCP endpoint returned HTTP {status_code}.{hint}{f' {detail}' if detail else ''}"
    )


def _messages_from_json_body(messages: list[dict[str, Any]], body: bytes) -> None:
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return
    if isinstance(value, dict):
        messages.append(value)
    elif isinstance(value, list):
        messages.extend(item for item in value if isinstance(item, dict))


def _sse_events_from_text(text: str) -> list[tuple[str, str]]:
    """Parse a complete SSE document into (event, data) pairs."""
    events: list[tuple[str, str]] = []
    event_name = "message"
    data_lines: list[str] = []
    for raw_line in text.splitlines() + [""]:
        line = raw_line.rstrip("\r")
        if not line:
            if data_lines:
                events.append((event_name, "\n".join(data_lines)))
            event_name = "message"
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        name, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if name == "event":
            event_name = value
        elif name == "data":
            data_lines.append(value)
    return events


def _http_post_message(
    client: httpx.Client,
    url: str,
    message: dict[str, Any],
    *,
    headers: dict[str, str],
    session_id: str | None,
) -> tuple[list[dict[str, Any]], str | None]:
    """POST one JSON-RPC message over streamable HTTP and parse any responses."""
    request_headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": _MCP_PROTOCOL_VERSION,
        **headers,
    }
    if session_id:
        request_headers["Mcp-Session-Id"] = session_id
    try:
        response = client.post(
            url,
            content=json.dumps(message, separators=(",", ":")).encode("utf-8"),
            headers=request_headers,
        )
    except EgressBlocked as exc:
        raise McpRuntimeError(f"MCP endpoint URL is not permitted: {exc}") from exc
    except httpx.TimeoutException as exc:
        raise McpRuntimeError(f"MCP endpoint did not respond in time: {exc}") from exc
    except httpx.HTTPError as exc:
        raise McpRuntimeError(f"MCP endpoint request failed: {exc}") from exc
    new_session_id = response.headers.get("mcp-session-id") or session_id
    if response.status_code in {202, 204}:
        return [], new_session_id
    if response.status_code >= 400:
        raise _http_status_error(response.status_code, response.text)
    body = response.content[:_MAX_MCP_HTTP_BYTES]
    content_type = (response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    messages: list[dict[str, Any]] = []
    if content_type == "text/event-stream":
        for _event_name, data in _sse_events_from_text(body.decode("utf-8", errors="replace")):
            _messages_from_json_body(messages, data.encode("utf-8"))
    else:
        _messages_from_json_body(messages, body)
    return messages, new_session_id


def _run_http_health(
    url: str,
    *,
    timeout_seconds: float,
    headers: dict[str, str],
    httpx_transport: httpx.BaseTransport | None = None,
) -> McpRuntimeResult:
    target = _validated_mcp_url(url)
    messages: list[dict[str, Any]] = []
    with _mcp_http_client(
        timeout_seconds=timeout_seconds, httpx_transport=httpx_transport
    ) as client:
        init_messages, session_id = _http_post_message(
            client, target, _initialize_message(), headers=headers, session_id=None
        )
        messages.extend(init_messages)
        notify_messages, session_id = _http_post_message(
            client, target, _initialized_notification(), headers=headers, session_id=session_id
        )
        messages.extend(notify_messages)
        list_messages, _session_id = _http_post_message(
            client, target, _tools_list_message(), headers=headers, session_id=session_id
        )
        messages.extend(list_messages)
    if not messages:
        raise McpRuntimeError("MCP endpoint returned no JSON-RPC messages.")
    return _health_result_from_messages(messages)


def _run_http_tool_call(
    url: str,
    *,
    tool_name: str,
    arguments: dict[str, Any],
    timeout_seconds: float,
    headers: dict[str, str],
    httpx_transport: httpx.BaseTransport | None = None,
) -> McpToolRuntimeResult:
    target = _validated_mcp_url(url)
    messages: list[dict[str, Any]] = []
    with _mcp_http_client(
        timeout_seconds=timeout_seconds, httpx_transport=httpx_transport
    ) as client:
        init_messages, session_id = _http_post_message(
            client, target, _initialize_message(), headers=headers, session_id=None
        )
        messages.extend(init_messages)
        notify_messages, session_id = _http_post_message(
            client, target, _initialized_notification(), headers=headers, session_id=session_id
        )
        messages.extend(notify_messages)
        call_messages, _session_id = _http_post_message(
            client,
            target,
            _tools_call_message(tool_name, arguments),
            headers=headers,
            session_id=session_id,
        )
        messages.extend(call_messages)
    if not messages:
        raise McpRuntimeError("MCP endpoint returned no JSON-RPC messages.")
    return _tool_result_from_messages(messages, tool_name=tool_name)


def _post_sse_message(
    client: httpx.Client, url: str, message: dict[str, Any], headers: dict[str, str]
) -> None:
    try:
        response = client.post(
            url,
            content=json.dumps(message, separators=(",", ":")).encode("utf-8"),
            headers={"Content-Type": "application/json", **headers},
        )
    except EgressBlocked as exc:
        raise McpRuntimeError(f"MCP endpoint URL is not permitted: {exc}") from exc
    except httpx.TimeoutException as exc:
        raise McpRuntimeError(f"MCP SSE message post did not complete in time: {exc}") from exc
    except httpx.HTTPError as exc:
        raise McpRuntimeError(f"MCP SSE message post failed: {exc}") from exc
    if response.status_code >= 400:
        raise _http_status_error(response.status_code, response.text)


def _iter_sse_stream(response: httpx.Response, *, deadline: float) -> Iterator[tuple[str, str]]:
    event_name = "message"
    data_lines: list[str] = []
    consumed = 0
    for raw_line in response.iter_lines():
        if time.monotonic() > deadline:
            raise McpRuntimeError("MCP SSE session timed out before all responses arrived.")
        consumed += len(raw_line) + 1
        if consumed > _MAX_MCP_HTTP_BYTES:
            raise McpRuntimeError("MCP SSE stream exceeded the response size limit.")
        line = raw_line.rstrip("\r")
        if not line:
            if data_lines:
                yield event_name, "\n".join(data_lines)
            event_name = "message"
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        name, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if name == "event":
            event_name = value
        elif name == "data":
            data_lines.append(value)
    if data_lines:
        yield event_name, "\n".join(data_lines)


def _sse_session_exchange(
    url: str,
    stages: list[tuple[list[dict[str, Any]], int]],
    *,
    timeout_seconds: float,
    headers: dict[str, str],
    httpx_transport: httpx.BaseTransport | None,
) -> list[dict[str, Any]]:
    """Run a legacy HTTP+SSE session: GET the stream, POST staged messages.

    Each stage is (messages to POST, response id that must arrive before the
    next stage is sent). The final stage's id completes the session.
    """
    target = _validated_mcp_url(url)
    deadline = time.monotonic() + max(timeout_seconds, 1.0)
    collected: list[dict[str, Any]] = []
    stage_index = 0
    post_url: str | None = None
    try:
        with _mcp_http_client(
            timeout_seconds=timeout_seconds, httpx_transport=httpx_transport
        ) as client:
            with client.stream(
                "GET", target, headers={"Accept": "text/event-stream", **headers}
            ) as stream:
                if stream.status_code >= 400:
                    stream.read()
                    raise _http_status_error(
                        stream.status_code, stream.text if stream.content else ""
                    )
                for event_name, data in _iter_sse_stream(stream, deadline=deadline):
                    if event_name == "endpoint" and post_url is None:
                        post_url = _validated_mcp_url(urljoin(str(stream.url), data.strip()))
                        for message in stages[stage_index][0]:
                            _post_sse_message(client, post_url, message, headers)
                        continue
                    if event_name != "message":
                        continue
                    _messages_from_json_body(collected, data.encode("utf-8"))
                    received_ids = {message.get("id") for message in collected}
                    while (
                        post_url is not None
                        and stage_index < len(stages)
                        and stages[stage_index][1] in received_ids
                    ):
                        stage_index += 1
                        if stage_index >= len(stages):
                            return collected
                        for message in stages[stage_index][0]:
                            _post_sse_message(client, post_url, message, headers)
    except EgressBlocked as exc:
        raise McpRuntimeError(f"MCP endpoint URL is not permitted: {exc}") from exc
    except httpx.TimeoutException as exc:
        raise McpRuntimeError(f"MCP SSE session did not complete in time: {exc}") from exc
    except httpx.HTTPError as exc:
        raise McpRuntimeError(f"MCP SSE session failed: {exc}") from exc
    if post_url is None:
        raise McpRuntimeError(
            "MCP SSE server did not provide an endpoint event; "
            "it may be a streamable HTTP server (use the http transport)."
        )
    raise McpRuntimeError("MCP SSE stream ended before every response arrived.")


def _run_sse_health(
    url: str,
    *,
    timeout_seconds: float,
    headers: dict[str, str],
    httpx_transport: httpx.BaseTransport | None = None,
) -> McpRuntimeResult:
    messages = _sse_session_exchange(
        url,
        [
            ([_initialize_message()], 1),
            ([_initialized_notification(), _tools_list_message()], 2),
        ],
        timeout_seconds=timeout_seconds,
        headers=headers,
        httpx_transport=httpx_transport,
    )
    return _health_result_from_messages(messages)


def _run_sse_tool_call(
    url: str,
    *,
    tool_name: str,
    arguments: dict[str, Any],
    timeout_seconds: float,
    headers: dict[str, str],
    httpx_transport: httpx.BaseTransport | None = None,
) -> McpToolRuntimeResult:
    messages = _sse_session_exchange(
        url,
        [
            ([_initialize_message()], 1),
            ([_initialized_notification(), _tools_call_message(tool_name, arguments)], 3),
        ],
        timeout_seconds=timeout_seconds,
        headers=headers,
        httpx_transport=httpx_transport,
    )
    return _tool_result_from_messages(messages, tool_name=tool_name)


def _parse_mcp_messages(raw: bytes) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    offset = 0
    while offset < len(raw):
        if raw[offset:].lstrip().startswith(b"Content-Length:"):
            offset = len(raw) - len(raw[offset:].lstrip())
            header_end = raw.find(b"\r\n\r\n", offset)
            separator_length = 4
            if header_end == -1:
                header_end = raw.find(b"\n\n", offset)
                separator_length = 2
            if header_end == -1:
                break
            header = raw[offset:header_end].decode("ascii", errors="ignore")
            length = _content_length(header)
            if length is None:
                break
            body_start = header_end + separator_length
            body = raw[body_start : body_start + length]
            _append_json_message(messages, body)
            offset = body_start + length
            continue
        newline = raw.find(b"\n", offset)
        if newline == -1:
            line = raw[offset:]
            offset = len(raw)
        else:
            line = raw[offset:newline]
            offset = newline + 1
        _append_json_message(messages, line.strip())
    return messages


def _content_length(header: str) -> int | None:
    for line in header.splitlines():
        name, _, value = line.partition(":")
        if name.lower() == "content-length":
            try:
                return int(value.strip())
            except ValueError:
                return None
    return None


def _append_json_message(messages: list[dict[str, Any]], payload: bytes) -> None:
    if not payload:
        return
    try:
        value = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError:
        return
    if isinstance(value, dict):
        messages.append(value)


def _message_by_id(messages: list[dict[str, Any]], message_id: int) -> dict[str, Any] | None:
    return next((message for message in messages if message.get("id") == message_id), None)


def _error_message(message: dict[str, Any] | None) -> str | None:
    if not message or not isinstance(message.get("error"), dict):
        return None
    error = message["error"]
    return str(error.get("message") or "MCP server returned an error.")


def _first_error(messages: list[dict[str, Any]]) -> str | None:
    for message in messages:
        error = _error_message(message)
        if error:
            return error
    return None


def _tool_summary(raw_tool: dict[str, Any]) -> McpToolSummary:
    input_schema = raw_tool.get("inputSchema")
    return McpToolSummary(
        name=str(raw_tool.get("name") or "unnamed_tool"),
        description=str(raw_tool["description"]) if raw_tool.get("description") is not None else None,
        input_schema=input_schema if isinstance(input_schema, dict) else None,
    )


def _tool_result_text(result: dict[str, Any]) -> str | None:
    parts: list[str] = []
    content = result.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "").strip()
            if item_type == "text" and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif item_type:
                parts.append(f"[{item_type} content]")
    text = "\n".join(part.strip() for part in parts if part.strip())
    return text or None
