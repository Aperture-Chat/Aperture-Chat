from __future__ import annotations

import gzip
import json
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.routes.draft_pdf_export as routes
from app.core.draft_pdf_exports import DraftPdfExportService, ExportLimits
from app.core.pdf_archival import ArchivalMetadata, ArchivalSummary
from app.repositories.deps import get_store

ADMIN = {"x-aperture-user": "user-admin"}
JANE = {"x-aperture-user": "user-jane"}
BASE = "/api/drafts/pdf-exports"

SOURCE = {
    "title": "Synthetic Harbor Lease",
    "lang": "en-US",
    "body_html": '<div class="draft-print-root"><h1>Lease</h1></div>',
    "css": "h1 { color: #111; }",
}


class Gate:
    def __init__(self) -> None:
        self.open = True

    async def render(self, _document_html: str, destination: Path) -> None:
        import asyncio

        while not self.open:
            await asyncio.sleep(0.01)
        destination.write_bytes(b"%PDF-1.7 raw")


def _finish(_source: Path, destination: Path, _metadata: ArchivalMetadata) -> ArchivalSummary:
    destination.write_bytes(b"%PDF-1.7 synthetic archival bytes")
    return ArchivalSummary(page_count=4, bookmark_count=2, size_bytes=destination.stat().st_size)


@pytest.fixture()
def gate() -> Gate:
    return Gate()


@pytest.fixture()
def client(tmp_path: Path, gate: Gate) -> Iterator[TestClient]:
    service = DraftPdfExportService(
        tmp_path / "exports",
        ExportLimits(concurrency=1, queue_max=1, per_user_active=2, timeout_seconds=30, retention_seconds=900),
        render=gate.render,
        finish=_finish,
        font_css=lambda: "",
    )
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[routes.get_draft_pdf_export_service] = lambda: service
    # The full app's lifespan closes the shared store; this router needs none.
    with TestClient(app) as test_client:
        yield test_client


def _upload(client: TestClient, payload: bytes, headers: dict[str, str] = ADMIN):
    return client.post(BASE, files={"source": ("draft-print.json", payload, "application/gzip")}, headers=headers)


def _gzip(source: dict[str, str]) -> bytes:
    return gzip.compress(json.dumps(source).encode("utf-8"))


def _wait_ready(client: TestClient, job_id: str, headers: dict[str, str] = ADMIN) -> dict:
    for _ in range(300):
        job = client.get(f"{BASE}/{job_id}", headers=headers).json()
        if job["status"] not in {"queued", "rendering", "finishing"}:
            return job
        time.sleep(0.01)
    raise AssertionError("export never finished")


def test_a_gzipped_print_surface_becomes_a_downloadable_pdf(client: TestClient) -> None:
    created = _upload(client, _gzip(SOURCE))

    assert created.status_code == 202
    job = _wait_ready(client, created.json()["id"])
    assert job["status"] == "ready"
    assert job["page_count"] == 4
    assert job["bookmark_count"] == 2
    assert job["conformance"] == "PDF/A-2b"

    download = client.get(f"{BASE}/{job['id']}/file", headers=ADMIN)
    assert download.status_code == 200
    assert download.headers["content-type"] == "application/pdf"
    assert download.headers["cache-control"] == "no-store"
    assert 'filename="synthetic-harbor-lease.pdf"' in download.headers["content-disposition"]
    assert download.content == b"%PDF-1.7 synthetic archival bytes"


def test_a_finished_export_is_recorded_in_the_audit_trail(client: TestClient) -> None:
    job = _wait_ready(client, _upload(client, _gzip(SOURCE)).json()["id"])

    events = [event for event in get_store().audit_events_newest_first(50) if event.target == job["id"]]
    assert [event.action for event in events] == ["draft.pdf_exported"]
    assert events[0].actor_id == "user-admin"
    assert events[0].metadata["pages"] == 4
    assert events[0].metadata["conformance"] == "PDF/A-2b"
    assert events[0].metadata["title"] == "Synthetic Harbor Lease"


def test_plain_json_is_accepted_too(client: TestClient) -> None:
    created = _upload(client, json.dumps(SOURCE).encode("utf-8"))

    assert created.status_code == 202
    assert _wait_ready(client, created.json()["id"])["status"] == "ready"


def test_exports_need_a_signed_in_person(client: TestClient) -> None:
    response = client.post(BASE, files={"source": ("draft-print.json", _gzip(SOURCE), "application/gzip")})

    assert response.status_code == 401


def test_someone_else_cannot_read_download_or_cancel_an_export(client: TestClient) -> None:
    job = _wait_ready(client, _upload(client, _gzip(SOURCE)).json()["id"])

    assert client.get(f"{BASE}/{job['id']}", headers=JANE).status_code == 404
    assert client.get(f"{BASE}/{job['id']}/file", headers=JANE).status_code == 404
    assert client.delete(f"{BASE}/{job['id']}", headers=JANE).status_code == 404
    assert client.get(f"{BASE}/{job['id']}/file", headers=ADMIN).status_code == 200


def test_canceling_frees_the_export(client: TestClient, gate: Gate) -> None:
    gate.open = False
    job_id = _upload(client, _gzip(SOURCE)).json()["id"]

    assert client.delete(f"{BASE}/{job_id}", headers=ADMIN).status_code == 204
    assert client.get(f"{BASE}/{job_id}", headers=ADMIN).status_code == 404
    gate.open = True


def test_the_file_is_refused_until_the_pdf_is_ready(client: TestClient, gate: Gate) -> None:
    gate.open = False
    job_id = _upload(client, _gzip(SOURCE)).json()["id"]

    response = client.get(f"{BASE}/{job_id}/file", headers=ADMIN)

    assert response.status_code == 409
    assert response.json()["detail"] == "This PDF is not ready yet."
    gate.open = True


def test_too_many_exports_are_turned_away_with_a_reason(client: TestClient, gate: Gate) -> None:
    gate.open = False
    first = _upload(client, _gzip(SOURCE)).json()["id"]
    for _ in range(100):
        if client.get(f"{BASE}/{first}", headers=ADMIN).json()["status"] == "rendering":
            break
        time.sleep(0.01)
    assert _upload(client, _gzip(SOURCE)).status_code == 202  # fills the one queue place

    own_limit = _upload(client, _gzip(SOURCE))
    busy = _upload(client, _gzip(SOURCE), headers=JANE)

    assert own_limit.status_code == 429
    assert "2 PDF exports" in own_limit.json()["detail"]
    assert busy.status_code == 503
    assert busy.headers["retry-after"] == "30"
    gate.open = True


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        (b"not json", "The document could not be read for PDF export."),
        (_gzip({"title": "Lease", "lang": "en"}), "The document could not be read for PDF export."),
        (b"\x1f\x8b\x08\x00broken", "The document could not be read for PDF export."),
        (_gzip({**SOURCE, "lang": "en; drop"}), "The document could not be read for PDF export."),
    ],
)
def test_unreadable_uploads_are_refused(client: TestClient, payload: bytes, detail: str) -> None:
    response = _upload(client, payload)

    assert response.status_code == 422
    assert response.json()["detail"] == detail


def test_a_source_that_inflates_past_the_limit_is_refused(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes, "get_settings", lambda: SimpleNamespace(draft_pdf_export_source_max_mb=1))
    bomb = gzip.compress(json.dumps({**SOURCE, "body_html": "x" * (2 * 1024 * 1024)}).encode())
    assert len(bomb) < 1024 * 1024

    response = _upload(client, bomb)

    assert response.status_code == 413
    assert response.json()["detail"] == "This document is larger than the 1 MB PDF export limit."
