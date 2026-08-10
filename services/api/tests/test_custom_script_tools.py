from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


UPPERCASE_SCRIPT = 'import sys\nprint(sys.stdin.read().upper(), end="")\n'


def create_script_tool(
    *,
    script: str = UPPERCASE_SCRIPT,
    enabled: bool = True,
    allowed_group_ids: list[str] | None = None,
    user_id: str = "user-admin",
) -> dict:
    response = client.post(
        "/api/admin/tool-configs",
        json={
            "name": "Uppercase transformer",
            "tool_type": "custom_script",
            "enabled": enabled,
            "approval_required": False,
            "allowed_group_ids": allowed_group_ids or [],
            "settings": {
                "script": script,
                "timeout_seconds": 5,
                "description": "Uppercases chat output.",
            },
        },
        headers=headers(user_id),
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_admin_creates_and_user_runs_custom_script_tool() -> None:
    tool = create_script_tool()

    run = client.post(
        f"/api/tools/{tool['id']}/run-script",
        json={"input": "make this loud"},
        headers=headers("user-jane"),
    )
    assert run.status_code == 200, run.text
    body = run.json()
    assert body["status"] == "ok"
    assert body["output"] == "MAKE THIS LOUD"
    assert body["exit_code"] == 0

    store = get_store()
    executed = [event for event in store.audit_events if event.action == "tool.custom_script_executed"]
    assert executed and executed[-1].metadata["status"] == "ok"
    # The audit trail records that a script ran — never the content.
    created_events = [event for event in store.audit_events if event.action == "admin.tool_config_created"]
    assert "script" not in created_events[-1].metadata.get("settings", {})


def test_script_validation_rejects_syntax_errors_and_empty_scripts() -> None:
    response = client.post(
        "/api/admin/tool-configs",
        json={
            "name": "Broken tool",
            "tool_type": "custom_script",
            "settings": {"script": "def broken(:\n    pass"},
        },
        headers=headers("user-admin"),
    )
    assert response.status_code == 400
    assert "syntax error" in response.json()["detail"]

    response = client.post(
        "/api/admin/tool-configs",
        json={"name": "Empty tool", "tool_type": "custom_script", "settings": {"script": "   "}},
        headers=headers("user-admin"),
    )
    assert response.status_code == 400


def test_large_scripts_can_be_previewed_saved_and_run() -> None:
    padding = "# Open WebUI export helper padding\n" * 10_000
    script = f'{padding}import sys\nprint(sys.stdin.read().upper(), end="")\n'
    assert len(script) > 250_000

    preview = client.post(
        "/api/admin/tool-configs/script-preview",
        json={"script": script, "input": "large preview", "timeout_seconds": 5},
        headers=headers("user-admin"),
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["output"] == "LARGE PREVIEW"

    tool = create_script_tool(script=script)
    assert tool["settings"]["script"] == script

    run = client.post(
        f"/api/tools/{tool['id']}/run-script",
        json={"input": "large saved script"},
        headers=headers("user-jane"),
    )
    assert run.status_code == 200, run.text
    assert run.json()["output"] == "LARGE SAVED SCRIPT"


def test_script_artifacts_are_persisted_and_downloadable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "app.core.generated_artifacts.generated_artifacts_dir",
        lambda: tmp_path / "generated-artifacts",
    )
    script = """\
import os
from pathlib import Path

artifact_dir = Path(os.environ["APERTURE_ARTIFACT_DIR"])
(artifact_dir / "Aperture-deck.pptx").write_bytes(b"PK\\x03\\x04real-pptx-placeholder")
print("Created an editable PowerPoint deck.")
"""
    tool = create_script_tool(script=script)
    run = client.post(
        f"/api/tools/{tool['id']}/run-script",
        json={"input": "deck source"},
        headers=headers("user-jane"),
    )
    assert run.status_code == 200, run.text
    body = run.json()
    assert body["status"] == "ok"
    assert body["output"].startswith("Created an editable PowerPoint deck.")
    assert "To download your PowerPoint, copy this link into your browser:" in body["output"]
    assert len(body["artifacts"]) == 1
    artifact = body["artifacts"][0]
    assert artifact["filename"] == "Aperture-deck.pptx"
    assert artifact["mime_type"] == (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    )
    assert artifact["download_url"] in body["output"]

    download = client.get(artifact["download_url"])
    assert download.status_code == 200, download.text
    assert download.content == b"PK\x03\x04real-pptx-placeholder"
    assert 'filename="Aperture-deck.pptx"' in download.headers["content-disposition"]

    rejected = client.get(artifact["download_url"].replace("token=", "token=invalid"))
    assert rejected.status_code == 403


def test_script_runs_with_clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APERTURE_FAKE_PROVIDER_KEY", "sk-super-secret")
    tool = create_script_tool(
        script='import os\nprint(os.environ.get("APERTURE_FAKE_PROVIDER_KEY", "MISSING"), end="")\n'
    )
    run = client.post(
        f"/api/tools/{tool['id']}/run-script",
        json={"input": ""},
        headers=headers("user-jane"),
    )
    assert run.status_code == 200
    assert run.json()["output"] == "MISSING"


def test_script_timeout_is_enforced() -> None:
    tool = create_script_tool(script="while True:\n    pass\n")
    store = get_store()
    store.tool_configs[tool["id"]].settings["timeout_seconds"] = 1

    run = client.post(
        f"/api/tools/{tool['id']}/run-script",
        json={"input": "spin"},
        headers=headers("user-jane"),
    )
    assert run.status_code == 200
    body = run.json()
    assert body["status"] in {"timeout", "error"}
    assert body["output"] == ""


def test_script_errors_are_reported_honestly() -> None:
    tool = create_script_tool(script='import sys\nsys.exit("deliberate failure")\n')
    run = client.post(
        f"/api/tools/{tool['id']}/run-script",
        json={"input": "x"},
        headers=headers("user-jane"),
    )
    assert run.status_code == 200
    body = run.json()
    assert body["status"] == "error"
    assert "deliberate failure" in body["error"]


def test_run_rejects_non_script_and_disabled_tools() -> None:
    store = get_store()
    mcp_tool_id = next(
        (tool_id for tool_id, tool in store.tool_configs.items() if tool.tool_type == "mcp"),
        None,
    )
    if mcp_tool_id is not None:
        response = client.post(
            f"/api/tools/{mcp_tool_id}/run-script",
            json={"input": "x"},
            headers=headers("user-jane"),
        )
        assert response.status_code == 400

    disabled = create_script_tool(enabled=False)
    response = client.post(
        f"/api/tools/{disabled['id']}/run-script",
        json={"input": "x"},
        headers=headers("user-jane"),
    )
    assert response.status_code == 403


def test_group_acl_restricts_who_can_run() -> None:
    group = client.post(
        "/api/admin/groups",
        json={"name": "Script runners only"},
        headers=headers("user-admin"),
    )
    assert group.status_code == 201, group.text
    tool = create_script_tool(allowed_group_ids=[group.json()["id"]])

    response = client.post(
        f"/api/tools/{tool['id']}/run-script",
        json={"input": "x"},
        headers=headers("user-jane"),
    )
    assert response.status_code == 403


def test_regular_user_cannot_create_tools() -> None:
    response = client.post(
        "/api/admin/tool-configs",
        json={"name": "Nope", "tool_type": "custom_script", "settings": {"script": "print(1)"}},
        headers=headers("user-jane"),
    )
    assert response.status_code == 403


def test_admin_script_preview_runs_without_saving() -> None:
    before = set(get_store().tool_configs)
    response = client.post(
        "/api/admin/tool-configs/script-preview",
        json={"script": UPPERCASE_SCRIPT, "input": "preview me", "timeout_seconds": 5},
        headers=headers("user-admin"),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok"
    assert body["output"] == "PREVIEW ME"
    assert set(get_store().tool_configs) == before
    assert get_store().audit_events[-1].action == "admin.tool_script_previewed"
