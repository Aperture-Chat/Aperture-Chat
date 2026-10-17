from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from tests.test_pdf_document_import import _pdf_bytes

AUTH = {"x-aperture-user": "user-admin"}
PDF_MIME = "application/pdf"


def _simple_pdf() -> bytes:
    return _pdf_bytes(
        [
            (
                612,
                792,
                [
                    (
                        "text",
                        {
                            "text": "Hello PDF import",
                            "x": 72,
                            "y": 700,
                        },
                    )
                ],
            )
        ]
    )


def test_pdf_import_route_returns_editable_html() -> None:
    client = TestClient(app)

    response = client.post(
        "/api/drafts/document-import/pdf",
        files={"file": ("sample.pdf", _simple_pdf(), PDF_MIME)},
        headers=AUTH,
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["filename"] == "sample.pdf"
    assert payload["page_count"] == 1
    assert payload["html"].startswith('<div class="document-page-setup"')
    assert "Hello PDF import" in payload["html"]
    assert payload["warnings"] == []


def test_pdf_import_route_rejects_wrong_extension_and_non_pdf_bytes() -> None:
    client = TestClient(app)

    wrong_extension = client.post(
        "/api/drafts/document-import/pdf",
        files={"file": ("sample.txt", b"%PDF- pretend", "text/plain")},
        headers=AUTH,
    )
    assert wrong_extension.status_code == 415
    assert wrong_extension.json()["detail"] == "Upload a PDF file."

    not_pdf = client.post(
        "/api/drafts/document-import/pdf",
        files={"file": ("sample.pdf", b"not a pdf", PDF_MIME)},
        headers=AUTH,
    )
    assert not_pdf.status_code == 422
    assert not_pdf.json()["detail"] == "The file is not a PDF."


def test_pdf_import_route_requires_authentication() -> None:
    client = TestClient(app)

    response = client.post(
        "/api/drafts/document-import/pdf",
        files={"file": ("sample.pdf", _simple_pdf(), PDF_MIME)},
    )

    assert response.status_code in (401, 403)


def test_pdf_import_route_reports_busy_honestly() -> None:
    from app.core import pdf_document_import as module

    client = TestClient(app)
    module._IMPORT_SLOTS.acquire()
    module._IMPORT_SLOTS.acquire()
    try:
        response = client.post(
            "/api/drafts/document-import/pdf",
            files={"file": ("sample.pdf", _simple_pdf(), PDF_MIME)},
            headers=AUTH,
        )
    finally:
        module._IMPORT_SLOTS.release()
        module._IMPORT_SLOTS.release()
    assert response.status_code == 503
    assert response.headers.get("retry-after") == "10"
