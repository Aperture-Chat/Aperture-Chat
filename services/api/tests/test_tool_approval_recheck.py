"""An approval is consent, never permission.

The test from the field: queue a tool call, remove the user's group access,
then approve it. The tool must not run, because the user's access is checked
again at the moment the tool would run, not only when it was approved.
"""

from __future__ import annotations

from collections.abc import Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import McpHealthResponse, McpToolCallResponse, McpToolSummary, ToolConfig
from app.core.policy import tool_use_allowed
from app.repositories.deps import get_store
from tests.test_chat_openrouter import _activate_provider, _gateway

client = TestClient(app)

TOOL_ID = "tool-matter-lookup-mcp"
TOOL_GROUP = "group-finance"
USER = "user-jane"
ADMIN = "user-admin"
ACCESS_REMOVED = "Not run: the user no longer has access to this tool."


@pytest.fixture(autouse=True)
def reset_store() -> Iterator[None]:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


class FakeMcp:
    """Stands in for the MCP server and records every start and tool call."""

    def __init__(self) -> None:
        self.started: list[str] = []
        self.called: list[str] = []
        self.on_start = lambda: None
        self.status = "ready"
        self.message = "MCP server responded with 1 tool."

    def health(self, tool: ToolConfig, timeout_seconds: float = 3.0, **_: object) -> McpHealthResponse:
        self.started.append(tool.id)
        self.on_start()
        return McpHealthResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport="stdio",
            command="matter-lookup",
            status=self.status,
            message=self.message,
            tools=[McpToolSummary(name="lookup_matter")],
        )

    def call(self, tool: ToolConfig, *, tool_name: str, **_: object) -> McpToolCallResponse:
        self.called.append(tool.id)
        return McpToolCallResponse(
            tool_config_id=tool.id,
            name=tool.name,
            transport="stdio",
            command="matter-lookup",
            tool_name=tool_name,
            label=None,
            status="ready",
            message="MCP tool call completed.",
            result_text="Matter 1042 is active.",
        )


@pytest.fixture()
def mcp(monkeypatch: pytest.MonkeyPatch) -> FakeMcp:
    fake = FakeMcp()
    store = get_store()
    store.tool_configs[TOOL_ID] = ToolConfig(
        id=TOOL_ID,
        tenant_id="tenant-example",
        name="Matter Lookup MCP",
        tool_type="mcp",
        endpoint_url="stdio://matter-lookup",
        enabled=True,
        approval_required=True,
        allowed_group_ids=[TOOL_GROUP],
        settings={
            "transport": "stdio",
            "command": "matter-lookup",
            "runtime_invocations": [
                {"tool_name": "lookup_matter", "label": "Matter lookup", "arguments": {"q": "{{query}}"}}
            ],
        },
    )
    store.users[USER].group_ids = ["group-litigation", TOOL_GROUP]
    _activate_provider("provider-azure")

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-recheck",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "Done."}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11},
            },
        )

    monkeypatch.setattr("app.routes.chat.check_mcp_server", fake.health)
    monkeypatch.setattr("app.routes.chat.call_mcp_tool", fake.call)
    monkeypatch.setattr(
        "app.routes.chat.get_model_gateway_client",
        lambda: _gateway(transport=httpx.MockTransport(answer)),
    )
    return fake


def approve() -> httpx.Response:
    return client.post(f"/api/tools/{TOOL_ID}/approve", headers=headers(USER))


def send_approved_turn(tokens: list[str]) -> httpx.Response:
    return client.post(
        "/api/chat/complete",
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Check matter 1042."}],
            "agent_enabled": True,
            "tool_config_ids": [TOOL_ID],
            "approval_tokens": tokens,
        },
        headers=headers(USER),
    )


def admin_patch(path: str, body: dict[str, object]) -> None:
    assert client.patch(path, json=body, headers=headers(ADMIN)).status_code == 200


def remove_user_from_tool_group() -> None:
    admin_patch(f"/api/admin/users/{USER}", {"group_ids": ["group-litigation"]})


def take_group_off_tool() -> None:
    admin_patch(f"/api/admin/tool-configs/{TOOL_ID}", {"allowed_group_ids": ["group-corporate"]})


def turn_context() -> dict[str, object]:
    return get_store().audit_events[-1].metadata["runtime_context"]


def test_an_approved_tool_runs_while_the_user_keeps_access(mcp: FakeMcp) -> None:
    token = approve().json()["approval_token"]

    response = send_approved_turn([token])

    assert response.status_code == 200
    assert mcp.called == [TOOL_ID]
    assert turn_context()["approved_tool_config_ids"] == [TOOL_ID]
    assert call_outcomes() == [("Matter lookup", "ready", "MCP tool call completed.")]


@pytest.mark.parametrize("remove_access", [remove_user_from_tool_group, take_group_off_tool])
def test_a_queued_approval_does_not_run_the_tool_after_access_is_removed(
    mcp: FakeMcp, remove_access
) -> None:
    token = approve().json()["approval_token"]
    remove_access()

    response = send_approved_turn([token])

    assert response.status_code == 200
    assert mcp.started == []
    assert mcp.called == []
    context = turn_context()
    assert context["tool_config_ids"] == []
    assert context["skipped_tool_config_ids"] == [TOOL_ID]


def test_a_user_who_lost_access_cannot_approve_the_tool(mcp: FakeMcp) -> None:
    remove_user_from_tool_group()

    response = approve()

    assert response.status_code == 403
    assert response.json()["detail"] == "Tool access is restricted by tenant, group, or tool policy."
    granted = [
        event
        for event in get_store().audit_events
        if event.action == "tool.mcp_approval_granted" and event.target == TOOL_ID
    ]
    assert granted == []


def test_access_removed_before_the_server_starts_keeps_it_from_starting(
    mcp: FakeMcp, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = approve().json()["approval_token"]

    def revoke_while_gathering_context(urls: list[str]) -> list[object]:
        get_store().users[USER].group_ids = ["group-litigation"]
        return []

    monkeypatch.setattr("app.routes.chat._fetch_chat_urls", revoke_while_gathering_context)
    del get_store().tool_configs[TOOL_ID].settings["transport"]

    response = send_approved_turn([token])

    assert response.status_code == 200
    assert mcp.started == []
    assert mcp.called == []
    context = turn_context()
    assert [
        (server["transport"], server["status"], server["message"]) for server in context["mcp_servers"]
    ] == [("stdio", "skipped", ACCESS_REMOVED)]
    assert [(result["status"], result["message"]) for result in context["mcp_tool_results"]] == [
        ("skipped", ACCESS_REMOVED)
    ]


def leave_tool_group() -> None:
    get_store().users[USER].group_ids = ["group-litigation"]


def deactivate_user() -> None:
    get_store().users[USER].active = False


def turn_tool_off() -> None:
    get_store().tool_configs[TOOL_ID].enabled = False


def delete_tool() -> None:
    del get_store().tool_configs[TOOL_ID]


@pytest.mark.parametrize("revoke", [leave_tool_group, deactivate_user, turn_tool_off, delete_tool])
def test_access_removed_after_the_server_starts_stops_the_tool_call(mcp: FakeMcp, revoke) -> None:
    token = approve().json()["approval_token"]
    mcp.on_start = revoke

    response = send_approved_turn([token])

    assert response.status_code == 200
    assert mcp.started == [TOOL_ID]
    assert mcp.called == []
    assert [(result["status"], result["message"]) for result in turn_context()["mcp_tool_results"]] == [
        ("skipped", ACCESS_REMOVED)
    ]


# The configured calls' other outcomes, pinned before the call path was split up.


def configure_calls(*invocations: dict[str, object]) -> None:
    get_store().tool_configs[TOOL_ID].settings["runtime_invocations"] = list(invocations)


def call_outcomes() -> list[tuple[object, object, object]]:
    return [
        (result["label"], result["status"], result["message"])
        for result in turn_context()["mcp_tool_results"]
    ]


def test_configured_calls_that_cannot_run_say_why(mcp: FakeMcp) -> None:
    configure_calls({"label": "No name"}, {"tool_name": "unknown_tool"})
    token = approve().json()["approval_token"]

    send_approved_turn([token])

    assert mcp.called == []
    assert call_outcomes() == [
        ("No name", "skipped", "MCP runtime invocation is missing tool_name."),
        ("unknown_tool", "skipped", "MCP tool 'unknown_tool' was not advertised by this server."),
    ]


@pytest.mark.parametrize(
    ("server_message", "expected"),
    [
        ("Server exited.", "MCP server was not ready for chat-time tool execution. Server exited."),
        ("", "MCP server was not ready for chat-time tool execution."),
    ],
)
def test_a_server_that_is_not_ready_runs_no_calls(
    mcp: FakeMcp, server_message: str, expected: str
) -> None:
    mcp.status = "error"
    mcp.message = server_message
    token = approve().json()["approval_token"]

    send_approved_turn([token])

    assert mcp.called == []
    assert call_outcomes() == [("Matter lookup", "skipped", expected)]


def test_a_turn_runs_at_most_five_configured_calls(mcp: FakeMcp) -> None:
    configure_calls(*({"tool_name": "lookup_matter"} for _ in range(7)))
    token = approve().json()["approval_token"]

    send_approved_turn([token])

    assert mcp.called == [TOOL_ID] * 5
    assert call_outcomes() == [("lookup_matter", "ready", "MCP tool call completed.")] * 5


# One decision decides whether a user may run a tool: the approve route, the
# turn's tool list, and the execution-time recheck all ask tool_use_allowed.

HERMES_TOOL = "tool-hermes-agent-mcp"


def set_group_permission(permission: str, value: bool) -> None:
    for group_id in get_store().users[USER].group_ids:
        get_store().groups[group_id].permissions[permission] = value


def may_use(user_id: str, tool_id: str) -> bool:
    store = get_store()
    return tool_use_allowed(store.users[user_id], store.groups, store.tool_configs[tool_id])


def test_a_member_of_the_tools_group_may_use_it(mcp: FakeMcp) -> None:
    assert may_use(USER, TOOL_ID) is True


def test_tools_turned_off_for_the_users_groups_blocks_every_tool(mcp: FakeMcp) -> None:
    set_group_permission("tools_access", False)

    assert may_use(USER, TOOL_ID) is False
    assert approve().status_code == 403


def test_a_hermes_connection_needs_the_hermes_grant(mcp: FakeMcp) -> None:
    assert may_use(USER, HERMES_TOOL) is False

    set_group_permission("hermes_companion", True)

    assert may_use(USER, HERMES_TOOL) is True


def test_administrators_keep_hermes_connections_without_the_grant() -> None:
    assert may_use(ADMIN, HERMES_TOOL) is True
