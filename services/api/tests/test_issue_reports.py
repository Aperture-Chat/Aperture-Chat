"""User-submitted platform issue reports and administrator visibility."""

from __future__ import annotations

from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.core import attachment_previews
from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        attachment_previews,
        "get_settings",
        lambda: SimpleNamespace(runtime_state_path=str(tmp_path / "runtime_state.json")),
    )
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def screenshot_bytes() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (900, 600), color=(13, 128, 141)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_user_report_with_screenshot_is_visible_to_admin_and_owner() -> None:
    response = client.post(
        "/api/issue-reports",
        data={
            "subject": "  Export button freezes  ",
            "body": "The export button stays on Preparing after I select PDF.",
        },
        files={"screenshot": ("freeze.png", screenshot_bytes(), "image/png")},
        headers=headers("user-jane"),
    )

    assert response.status_code == 201
    report = response.json()
    assert report["subject"] == "Export button freezes"
    assert report["user_name"] == "Jane Smith"
    assert report["screenshot_filename"] == "freeze.png"
    assert report["screenshot_size_bytes"] > 0

    admin_response = client.get(
        "/api/admin/issue-reports", headers=headers("user-admin")
    )
    assert admin_response.status_code == 200
    assert [item["id"] for item in admin_response.json()] == [report["id"]]

    owner_response = client.get(
        "/api/admin/issue-reports", headers=headers("user-owner")
    )
    assert owner_response.status_code == 200
    assert [item["id"] for item in owner_response.json()] == [report["id"]]

    preview = client.get(
        f"/api/admin/issue-reports/{report['id']}/screenshot",
        headers=headers("user-admin"),
    )
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/webp"
    assert preview.content.startswith(b"RIFF")

    blocked = client.get(
        "/api/admin/issue-reports", headers=headers("user-casey")
    )
    assert blocked.status_code == 403

    assert get_store().audit_events_newest_first(limit=1)[0].action == "support.issue_reported"


def test_admin_visibility_matches_feedback_and_hides_owner_reports() -> None:
    client.post(
        "/api/issue-reports",
        data={"subject": "User issue", "body": "Visible to the tenant admin."},
        headers=headers("user-jane"),
    )
    client.post(
        "/api/issue-reports",
        data={"subject": "Owner issue", "body": "Visible only in the owner console."},
        headers=headers("user-owner"),
    )

    admin_rows = client.get(
        "/api/admin/issue-reports", headers=headers("user-admin")
    ).json()
    owner_rows = client.get(
        "/api/admin/issue-reports", headers=headers("user-owner")
    ).json()

    assert [item["subject"] for item in admin_rows] == ["User issue"]
    assert {item["subject"] for item in owner_rows} == {"User issue", "Owner issue"}


def test_issue_report_rejects_non_image_and_empty_fields() -> None:
    invalid_file = client.post(
        "/api/issue-reports",
        data={"subject": "Bad attachment", "body": "This should be rejected."},
        files={"screenshot": ("notes.txt", b"not an image", "text/plain")},
        headers=headers("user-jane"),
    )
    assert invalid_file.status_code == 415

    missing_subject = client.post(
        "/api/issue-reports",
        data={"subject": "   ", "body": "Message"},
        headers=headers("user-jane"),
    )
    assert missing_subject.status_code == 400
    assert missing_subject.json()["detail"] == "Subject is required."
