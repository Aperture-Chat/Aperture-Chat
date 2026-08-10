from __future__ import annotations

import json
import sys

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import ToolConfig
from app.repositories.deps import get_store
from app.routes import tools as tools_route

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def test_mcp_health_lists_stdio_tools(tmp_path) -> None:
    server = tmp_path / "fake_mcp_server.py"
    server.write_text(
        """
import json
import sys

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-mcp", "version": "1.0.0"},
            },
        }), flush=True)
    elif method == "tools/list":
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "tools": [{
                    "name": "lookup_matter",
                    "description": "Look up a matter by number.",
                    "inputSchema": {"type": "object", "properties": {"matter": {"type": "string"}}},
                }]
            },
        }), flush=True)
        break
""".strip()
    )
    store = get_store()
    store.tool_configs["tool-fake-mcp"] = ToolConfig(
        id="tool-fake-mcp",
        tenant_id="tenant-example",
        name="Fake MCP Server",
        tool_type="mcp",
        endpoint_url="stdio://fake",
        enabled=True,
        approval_required=False,
        allowed_group_ids=["group-litigation"],
        settings={"transport": "stdio", "command": sys.executable, "args": [str(server)]},
    )

    response = client.post("/api/tools/tool-fake-mcp/mcp/health", headers=headers("user-admin"))

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["message"] == "MCP server responded with 1 tool."
    assert body["server_info"] == {"name": "fake-mcp", "version": "1.0.0"}
    assert body["tools"][0]["name"] == "lookup_matter"
    assert get_store().audit_events[-1].action == "tool.mcp_health_checked"
    assert get_store().audit_events[-1].metadata["tool_count"] == 1


def test_mcp_health_passes_bearer_token_secret_to_stdio_server(tmp_path) -> None:
    server = tmp_path / "fake_mcp_auth_server.py"
    server.write_text(
        """
import json
import os
import sys

token = os.environ.get("MCP_BEARER_TOKEN")
header = os.environ.get("MCP_AUTHORIZATION_HEADER")

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": f"auth-{token}", "header": header},
            },
        }), flush=True)
    elif method == "tools/list":
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {"tools": []},
        }), flush=True)
        break
""".strip()
    )
    store = get_store()
    store.tool_configs["tool-auth-mcp"] = ToolConfig(
        id="tool-auth-mcp",
        tenant_id="tenant-example",
        name="Authenticated MCP Server",
        tool_type="mcp",
        endpoint_url="stdio://auth",
        enabled=True,
        approval_required=False,
        allowed_group_ids=["group-litigation"],
        settings={"transport": "stdio", "auth_type": "bearer-token", "command": sys.executable, "args": [str(server)]},
    )
    store.set_configuration_secret("tool", "tool-auth-mcp", "bearer-secret-123")

    response = client.post("/api/tools/tool-auth-mcp/mcp/health", headers=headers("user-admin"))

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["server_info"] == {
        "name": "auth-bearer-secret-123",
        "header": "Bearer bearer-secret-123",
    }


def test_mcp_oauth_callback_url_resolves_for_tool_config() -> None:
    response = client.get(
        "/api/tools/tool-hermes-agent-mcp/oauth/callback",
        params={"code": "oauth-code", "state": "state-123"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "received",
        "tool_config_id": "tool-hermes-agent-mcp",
        "name": "Hermes Agent MCP",
        "code": "received",
        "state": "state-123",
    }


def test_mcp_oauth_callback_exchanges_code_and_vaults_token(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeOAuthClient:
        def __init__(self, timeout: float) -> None:
            captured["timeout"] = timeout

        def __enter__(self) -> "FakeOAuthClient":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def post(self, url: str, *, data: dict[str, str], headers: dict[str, str]) -> httpx.Response:
            captured["url"] = url
            captured["data"] = data
            captured["headers"] = headers
            return httpx.Response(
                200,
                json={
                    "access_token": "oauth-access-token",
                    "refresh_token": "oauth-refresh-token",
                    "token_type": "Bearer",
                    "scope": "files.read tools.call",
                },
            )

    monkeypatch.setattr(tools_route.httpx, "Client", FakeOAuthClient)
    store = get_store()
    store.tool_configs["tool-oauth-mcp"] = ToolConfig(
        id="tool-oauth-mcp",
        tenant_id="tenant-example",
        name="OAuth MCP",
        tool_type="mcp",
        endpoint_url="https://mcp.example.test/sse",
        enabled=True,
        approval_required=False,
        allowed_group_ids=["group-litigation"],
        settings={
            "auth_type": "oauth-2.1-static",
            "client_id": "client-123",
            "oauth_token_url": "https://auth.example.test/oauth/token",
        },
    )
    store.set_configuration_secret("tool", "tool-oauth-mcp", "client-secret")

    from app.core.config import get_settings
    from app.core.sessions import sign_oidc_state

    state = sign_oidc_state({"config_id": "tool-oauth-mcp", "actor_id": "user-admin"}, get_settings().secret_key)
    response = client.get(
        "/api/tools/tool-oauth-mcp/oauth/callback",
        params={"code": "oauth-code", "state": state},
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "token_stored",
        "tool_config_id": "tool-oauth-mcp",
        "name": "OAuth MCP",
        "code": "exchanged",
        "state": state,
        "token_type": "Bearer",
        "scope": "files.read tools.call",
    }
    assert captured["url"] == "https://auth.example.test/oauth/token"
    assert captured["data"] == {
        "grant_type": "authorization_code",
        "code": "oauth-code",
        "redirect_uri": "http://testserver/api/tools/tool-oauth-mcp/oauth/callback",
        "client_id": "client-123",
        "client_secret": "client-secret",
    }
    assert captured["headers"] == {"Accept": "application/json"}
    assert store.configuration_secret("tool", "tool-oauth-mcp") == "client-secret"
    token_payload = json.loads(store.configuration_secret("tool-oauth-token", "tool-oauth-mcp") or "{}")
    assert token_payload["access_token"] == "oauth-access-token"
    assert token_payload["refresh_token"] == "oauth-refresh-token"
    assert store.tool_configs["tool-oauth-mcp"].settings["oauth_token_status"] == "stored"


def test_mcp_call_invokes_stdio_tool(tmp_path) -> None:
    server = tmp_path / "fake_mcp_call_server.py"
    server.write_text(
        """
import json
import sys

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-mcp", "version": "1.0.0"},
            },
        }), flush=True)
    elif method == "tools/list":
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "tools": [{
                    "name": "lookup_matter",
                    "description": "Look up a matter by number.",
                    "inputSchema": {"type": "object", "properties": {"matter": {"type": "string"}}},
                }]
            },
        }), flush=True)
    elif method == "tools/call":
        matter = message.get("params", {}).get("arguments", {}).get("matter", "unknown")
        print(json.dumps({
            "jsonrpc": "2.0",
            "id": message["id"],
            "result": {
                "content": [{"type": "text", "text": f"Matter {matter} is active."}],
                "structuredContent": {"matter": matter, "status": "active"},
            },
        }), flush=True)
        break
""".strip()
    )
    store = get_store()
    store.tool_configs["tool-fake-mcp-call"] = ToolConfig(
        id="tool-fake-mcp-call",
        tenant_id="tenant-example",
        name="Fake MCP Call Server",
        tool_type="mcp",
        endpoint_url="stdio://fake-call",
        enabled=True,
        approval_required=False,
        allowed_group_ids=["group-litigation"],
        settings={"transport": "stdio", "command": sys.executable, "args": [str(server)]},
    )

    response = client.post(
        "/api/tools/tool-fake-mcp-call/mcp/call",
        headers=headers("user-admin"),
        json={"tool_name": "lookup_matter", "label": "Matter lookup", "arguments": {"matter": "1042"}},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["tool_name"] == "lookup_matter"
    assert body["label"] == "Matter lookup"
    assert body["result_text"] == "Matter 1042 is active."
    assert body["structured_content"] == {"matter": "1042", "status": "active"}
    assert get_store().audit_events[-1].action == "tool.mcp_tool_called"
    assert get_store().audit_events[-1].metadata["result_chars"] == len("Matter 1042 is active.")


def test_mcp_call_survives_a_slow_tool_on_an_eof_cancelling_server(tmp_path) -> None:
    """FastMCP-family servers cancel in-flight work when stdin closes.

    The old communicate() pattern closed stdin immediately after writing, so
    any tool that did real work (network fetch, file parse) was cancelled
    before it could answer — only instant responses like tools/list survived.
    This stub emulates that cancellation: if stdin reaches EOF before the
    tools/call reply has been written, it exits without replying.
    """
    server = tmp_path / "eof_cancelling_mcp_server.py"
    server.write_text(
        """
import json
import os
import sys
import threading
import time

messages = [json.loads(sys.stdin.readline()) for _ in range(4)]
init = next(m for m in messages if m.get("method") == "initialize")
print(json.dumps({
    "jsonrpc": "2.0",
    "id": init["id"],
    "result": {
        "protocolVersion": "2025-03-26",
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "slow-mcp", "version": "1.0.0"},
    },
}), flush=True)

replied = threading.Event()

def cancel_on_eof():
    if sys.stdin.readline() == "" and not replied.is_set():
        os._exit(1)

threading.Thread(target=cancel_on_eof, daemon=True).start()

call = next(m for m in messages if m.get("method") == "tools/call")
time.sleep(1.2)  # the "network fetch"
print(json.dumps({
    "jsonrpc": "2.0",
    "id": call["id"],
    "result": {"content": [{"type": "text", "text": "slow but real"}]},
}), flush=True)
replied.set()
sys.stdin.read()
""".strip()
    )
    store = get_store()
    store.tool_configs["tool-slow-mcp"] = ToolConfig(
        id="tool-slow-mcp",
        tenant_id="tenant-example",
        name="Slow MCP Server",
        tool_type="mcp",
        endpoint_url="stdio://slow",
        enabled=True,
        approval_required=False,
        allowed_group_ids=["group-litigation"],
        settings={"transport": "stdio", "command": sys.executable, "args": [str(server)]},
    )

    response = client.post(
        "/api/tools/tool-slow-mcp/mcp/call",
        headers=headers("user-admin"),
        json={"tool_name": "anything_slow", "arguments": {}},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["result_text"] == "slow but real"


def test_mcp_health_reports_missing_command_without_leaking_as_500() -> None:
    store = get_store()
    store.tool_configs["tool-missing-command"] = ToolConfig(
        id="tool-missing-command",
        tenant_id="tenant-example",
        name="Missing MCP Server",
        tool_type="mcp",
        endpoint_url="stdio://missing",
        enabled=True,
        approval_required=True,
        allowed_group_ids=["group-litigation"],
        settings={"transport": "stdio", "command": "definitely-not-a-real-mcp-command-7b481"},
    )

    response = client.post("/api/tools/tool-missing-command/mcp/health", headers=headers("user-admin"))

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "error"
    assert body["message"] == "MCP command not found: definitely-not-a-real-mcp-command-7b481"
    assert body["tools"] == []


def test_mcp_health_is_admin_scoped() -> None:
    response = client.post("/api/tools/tool-hermes-agent-mcp/mcp/health", headers=headers("user-jane"))

    assert response.status_code == 403


# --- MCP stdio command-execution trust boundary (security finding #4) ---


def _stdio_settings() -> dict:
    return {"transport": "stdio", "command": "/bin/sh", "args": ["-c", "echo hi"]}


def test_tenant_admin_cannot_create_stdio_command_tool() -> None:
    resp = client.post(
        "/api/admin/tool-configs",
        headers=headers("user-admin"),
        json={"name": "Evil MCP", "tool_type": "mcp", "settings": _stdio_settings()},
    )
    assert resp.status_code == 403
    assert not any(t.name == "Evil MCP" for t in get_store().tool_configs.values())


def test_platform_owner_can_create_stdio_command_tool() -> None:
    resp = client.post(
        "/api/admin/tool-configs",
        headers=headers("user-owner"),
        json={"id": "tool-owner-stdio", "name": "Owner MCP", "tool_type": "mcp", "settings": _stdio_settings()},
    )
    assert resp.status_code == 201


def test_tenant_admin_can_still_create_non_stdio_mcp_tool() -> None:
    resp = client.post(
        "/api/admin/tool-configs",
        headers=headers("user-admin"),
        json={
            "id": "tool-admin-http",
            "name": "Admin HTTP MCP",
            "tool_type": "mcp",
            "endpoint_url": "https://mcp.example.com/sse",
            "settings": {"transport": "sse"},
        },
    )
    assert resp.status_code == 201


def test_tenant_admin_cannot_add_stdio_command_via_patch() -> None:
    create = client.post(
        "/api/admin/tool-configs",
        headers=headers("user-admin"),
        json={"id": "tool-patch-target", "name": "Patchable", "tool_type": "mcp", "settings": {"transport": "sse"}},
    )
    assert create.status_code == 201

    bad = client.patch(
        "/api/admin/tool-configs/tool-patch-target",
        headers=headers("user-admin"),
        json={"settings": {"transport": "stdio", "command": "/bin/sh"}},
    )
    assert bad.status_code == 403

    # A benign edit that does not touch the command stays allowed.
    ok = client.patch(
        "/api/admin/tool-configs/tool-patch-target",
        headers=headers("user-admin"),
        json={"name": "Renamed Tool"},
    )
    assert ok.status_code == 200
    assert ok.json()["name"] == "Renamed Tool"


def test_stdio_runtime_allowlist_enforced_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.mcp_runtime import McpRuntimeError, _assert_command_allowed

    monkeypatch.setenv("APERTURE_MCP_ALLOWED_COMMANDS", "hermes, /usr/bin/allowed")
    _assert_command_allowed("hermes")  # exact match
    _assert_command_allowed("/usr/bin/allowed")  # exact match

    monkeypatch.setenv("APERTURE_MCP_ALLOWED_COMMANDS", "python3")
    _assert_command_allowed("/usr/local/bin/python3")  # basename match

    monkeypatch.setenv("APERTURE_MCP_ALLOWED_COMMANDS", "onlythis")
    with pytest.raises(McpRuntimeError):
        _assert_command_allowed("/bin/sh")


def test_stdio_deployed_without_allowlist_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.config import get_settings
    from app.core.mcp_runtime import McpRuntimeError, _assert_command_allowed

    monkeypatch.delenv("APERTURE_MCP_ALLOWED_COMMANDS", raising=False)
    monkeypatch.setenv("APERTURE_ENVIRONMENT", "production")
    monkeypatch.setenv("APERTURE_SECRET_KEY", "x" * 40)
    get_settings.cache_clear()
    try:
        with pytest.raises(McpRuntimeError):
            _assert_command_allowed("hermes")
        # Local stays permissive without an allowlist (owner's Hermes demo).
        monkeypatch.setenv("APERTURE_ENVIRONMENT", "local")
        get_settings.cache_clear()
        _assert_command_allowed("hermes")
    finally:
        get_settings.cache_clear()


# --- MCP approval tokens replace client-asserted approval (finding #10) ---


def test_mcp_approval_token_is_signed_and_user_bound() -> None:
    from app.core.config import get_settings
    from app.core.sessions import verify_approval_token

    resp = client.post("/api/tools/tool-hermes-agent-mcp/approve", headers=headers("user-admin"))
    assert resp.status_code == 200
    token = resp.json()["approval_token"]

    secret = get_settings().secret_key
    assert verify_approval_token(token, "user-admin", secret) == "tool-hermes-agent-mcp"
    # A token minted for one user cannot approve for another.
    assert verify_approval_token(token, "user-jane", secret) is None
    # A forged / garbage token is rejected.
    assert verify_approval_token("v1.forged.token", "user-admin", secret) is None


def test_approve_rejects_tool_that_does_not_require_approval() -> None:
    store = get_store()
    store.tool_configs["tool-noapprove"] = ToolConfig(
        id="tool-noapprove",
        tenant_id="tenant-example",
        name="No Approval",
        tool_type="mcp",
        enabled=True,
        approval_required=False,
        allowed_group_ids=["group-litigation"],
        settings={"transport": "sse"},
    )
    resp = client.post("/api/tools/tool-noapprove/approve", headers=headers("user-admin"))
    assert resp.status_code == 400


def _http_tool_config(tool_id: str = "tool-http-mcp", transport: str = "http") -> ToolConfig:
    return ToolConfig(
        id=tool_id,
        tenant_id="tenant-example",
        name="Remote MCP Server",
        tool_type="mcp",
        endpoint_url="https://mcp.example.test/mcp",
        enabled=True,
        approval_required=False,
        allowed_group_ids=["group-litigation"],
        settings={"transport": transport},
    )


def _jsonrpc_response(message_id: int, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def test_mcp_http_health_lists_tools_over_streamable_http() -> None:
    from app.core.mcp_runtime import check_mcp_server

    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        message = json.loads(request.content.decode("utf-8"))
        method = message.get("method")
        seen.append((method, request.headers.get("mcp-session-id")))
        if method == "initialize":
            return httpx.Response(
                200,
                headers={"Mcp-Session-Id": "session-abc123"},
                json=_jsonrpc_response(
                    1,
                    {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "remote-mcp", "version": "2.0.0"},
                    },
                ),
            )
        if method == "notifications/initialized":
            return httpx.Response(202)
        if method == "tools/list":
            return httpx.Response(
                200,
                json=_jsonrpc_response(
                    2,
                    {
                        "tools": [
                            {
                                "name": "search_docs",
                                "description": "Search remote documents.",
                                "inputSchema": {"type": "object"},
                            }
                        ]
                    },
                ),
            )
        return httpx.Response(400, text="unexpected method")

    response = check_mcp_server(
        _http_tool_config(), httpx_transport=httpx.MockTransport(handler)
    )

    assert response.status == "ready"
    assert response.message == "MCP server responded with 1 tool."
    assert response.server_info == {"name": "remote-mcp", "version": "2.0.0"}
    assert response.tools[0].name == "search_docs"
    # The Mcp-Session-Id from initialize must ride every follow-up request.
    assert seen == [
        ("initialize", None),
        ("notifications/initialized", "session-abc123"),
        ("tools/list", "session-abc123"),
    ]


def test_mcp_http_call_passes_bearer_header_and_returns_structured_content() -> None:
    from app.core.mcp_runtime import call_mcp_tool

    auth_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        message = json.loads(request.content.decode("utf-8"))
        method = message.get("method")
        auth_headers.append(request.headers.get("authorization"))
        if method == "initialize":
            return httpx.Response(
                200, json=_jsonrpc_response(1, {"protocolVersion": "2025-03-26"})
            )
        if method == "notifications/initialized":
            return httpx.Response(202)
        if method == "tools/call":
            assert message["params"] == {
                "name": "search_docs",
                "arguments": {"query": "indemnification"},
            }
            return httpx.Response(
                200,
                json=_jsonrpc_response(
                    3,
                    {
                        "content": [{"type": "text", "text": "Found 2 documents."}],
                        "structuredContent": {"total": 2},
                    },
                ),
            )
        return httpx.Response(400, text="unexpected method")

    response = call_mcp_tool(
        _http_tool_config(),
        tool_name="search_docs",
        arguments={"query": "indemnification"},
        extra_env={"MCP_BEARER_TOKEN": "remote-secret"},
        httpx_transport=httpx.MockTransport(handler),
    )

    assert response.status == "ready"
    assert response.result_text == "Found 2 documents."
    assert response.structured_content == {"total": 2}
    assert response.is_error is False
    assert auth_headers == ["Bearer remote-secret"] * 3


def test_mcp_http_health_parses_sse_encoded_response_body() -> None:
    from app.core.mcp_runtime import check_mcp_server

    def handler(request: httpx.Request) -> httpx.Response:
        message = json.loads(request.content.decode("utf-8"))
        method = message.get("method")
        if method == "initialize":
            payload = json.dumps(
                _jsonrpc_response(
                    1, {"serverInfo": {"name": "sse-body-mcp", "version": "1.0"}}
                )
            )
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                content=f"event: message\ndata: {payload}\n\n".encode("utf-8"),
            )
        if method == "notifications/initialized":
            return httpx.Response(202)
        payload = json.dumps(_jsonrpc_response(2, {"tools": [{"name": "ping"}]}))
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=f"event: message\ndata: {payload}\n\n".encode("utf-8"),
        )

    response = check_mcp_server(
        _http_tool_config(), httpx_transport=httpx.MockTransport(handler)
    )

    assert response.status == "ready"
    assert response.tools[0].name == "ping"
    assert response.server_info == {"name": "sse-body-mcp", "version": "1.0"}


def test_mcp_http_auth_failure_reports_honest_error() -> None:
    from app.core.mcp_runtime import check_mcp_server

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="missing bearer token")

    response = check_mcp_server(
        _http_tool_config(), httpx_transport=httpx.MockTransport(handler)
    )

    assert response.status == "error"
    assert "HTTP 401" in response.message
    assert "authentication" in response.message


def test_mcp_sse_health_negotiates_endpoint_and_lists_tools() -> None:
    from app.core.mcp_runtime import check_mcp_server

    posted_methods: list[str] = []
    initialize_response = json.dumps(
        _jsonrpc_response(
            1,
            {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "legacy-sse-mcp", "version": "0.9"},
            },
        )
    )
    tools_response = json.dumps(
        _jsonrpc_response(2, {"tools": [{"name": "lookup_matter"}]})
    )
    stream_body = (
        "event: endpoint\n"
        "data: /messages?sessionId=sse-1\n\n"
        f"event: message\ndata: {initialize_response}\n\n"
        f"event: message\ndata: {tools_response}\n\n"
    ).encode("utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=stream_body
            )
        assert request.url.path == "/messages"
        assert request.url.params.get("sessionId") == "sse-1"
        posted_methods.append(json.loads(request.content.decode("utf-8"))["method"])
        return httpx.Response(202)

    response = check_mcp_server(
        _http_tool_config(transport="sse"), httpx_transport=httpx.MockTransport(handler)
    )

    assert response.status == "ready"
    assert response.tools[0].name == "lookup_matter"
    assert response.server_info == {"name": "legacy-sse-mcp", "version": "0.9"}
    assert posted_methods == ["initialize", "notifications/initialized", "tools/list"]


def test_mcp_sse_call_returns_tool_result() -> None:
    from app.core.mcp_runtime import call_mcp_tool

    call_response = json.dumps(
        _jsonrpc_response(3, {"content": [{"type": "text", "text": "matter 1847 found"}]})
    )
    stream_body = (
        "event: endpoint\n"
        "data: /messages?sessionId=sse-2\n\n"
        f"event: message\ndata: {json.dumps(_jsonrpc_response(1, {}))}\n\n"
        f"event: message\ndata: {call_response}\n\n"
    ).encode("utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=stream_body
            )
        return httpx.Response(202)

    response = call_mcp_tool(
        _http_tool_config(transport="sse"),
        tool_name="lookup_matter",
        arguments={"query": "1847"},
        httpx_transport=httpx.MockTransport(handler),
    )

    assert response.status == "ready"
    assert response.result_text == "matter 1847 found"
    assert response.is_error is False


def test_mcp_http_transport_rejects_disallowed_url_scheme() -> None:
    from app.core.mcp_runtime import check_mcp_server

    tool = _http_tool_config()
    tool.endpoint_url = "ftp://mcp.example.test/mcp"

    response = check_mcp_server(tool)

    assert response.status == "error"
    assert "not permitted" in response.message


def test_mcp_unknown_transport_reports_unsupported() -> None:
    from app.core.mcp_runtime import check_mcp_server

    response = check_mcp_server(_http_tool_config(transport="carrier-pigeon"))

    assert response.status == "unsupported"
    assert "Supported transports are stdio, http (streamable), and sse" in response.message


def test_approve_rejects_when_mcp_connector_is_off() -> None:
    store = get_store()
    store.connectors["mcp"].tenant_enabled = False
    resp = client.post("/api/tools/tool-hermes-agent-mcp/approve", headers=headers("user-admin"))
    assert resp.status_code == 409
    assert "turned off for this workspace" in resp.json()["detail"]

    store.connectors["mcp"].tenant_enabled = True
    restored = client.post("/api/tools/tool-hermes-agent-mcp/approve", headers=headers("user-admin"))
    assert restored.status_code == 200
