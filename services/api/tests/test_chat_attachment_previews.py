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


def headers(user_id: str = "user-admin") -> dict[str, str]:
    return {"x-aperture-user": user_id}


def image_bytes(*, size: tuple[int, int] = (2400, 1200)) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", size, color=(18, 130, 142)).save(buffer, format="JPEG", quality=94)
    return buffer.getvalue()


def test_image_upload_creates_owner_scoped_bounded_preview() -> None:
    upload = client.post(
        "/api/chat/attachments",
        files={"file": ("matter-photo.jpeg", image_bytes(), "image/jpeg")},
        headers=headers(),
    )

    assert upload.status_code == 200
    attachment = upload.json()
    assert attachment["kind"] == "Image"

    preview = client.get(
        f"/api/chat/attachments/{attachment['id']}/preview",
        headers=headers(),
    )
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/webp"
    assert preview.headers["cache-control"] == "private, max-age=86400"
    with Image.open(BytesIO(preview.content)) as decoded:
        assert decoded.format == "WEBP"
        assert decoded.size == (1600, 800)

    inaccessible = client.get(
        f"/api/chat/attachments/{attachment['id']}/preview",
        headers=headers("user-casey"),
    )
    assert inaccessible.status_code == 404


def test_non_image_and_invalid_image_uploads_keep_generic_preview_fallback() -> None:
    text_upload = client.post(
        "/api/chat/attachments",
        files={"file": ("notes.txt", b"Matter notes", "text/plain")},
        headers=headers(),
    )
    invalid_image_upload = client.post(
        "/api/chat/attachments",
        files={"file": ("broken.jpeg", b"not-an-image", "image/jpeg")},
        headers=headers(),
    )

    assert text_upload.status_code == 200
    assert invalid_image_upload.status_code == 200
    for attachment in (text_upload.json(), invalid_image_upload.json()):
        preview = client.get(
            f"/api/chat/attachments/{attachment['id']}/preview",
            headers=headers(),
        )
        assert preview.status_code == 404


def test_hard_deleting_a_user_removes_their_preview_files() -> None:
    upload = client.post(
        "/api/chat/attachments",
        files={"file": ("matter-photo.jpeg", image_bytes(), "image/jpeg")},
        headers=headers("user-jane"),
    )
    assert upload.status_code == 200
    attachment_id = upload.json()["id"]
    resolved = attachment_previews.attachment_preview_file(attachment_id)
    assert resolved is not None
    preview_path = resolved[0]
    assert preview_path.is_file()

    deleted = client.delete("/api/admin/users/user-jane", headers=headers("user-admin"))
    assert deleted.status_code == 200

    # The preview is the only stored copy of the upload; leaving it on the
    # data volume after a hard delete would orphan the user's image content.
    assert not preview_path.exists()
    assert attachment_previews.attachment_preview_file(attachment_id) is None
