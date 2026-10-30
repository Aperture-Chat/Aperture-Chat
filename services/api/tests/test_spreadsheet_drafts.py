from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.core.search_index import entry_for_draft
from app.models.matters import DraftRevision
from app.models.sheet_document import canonicalize_sheet_json, sheet_content_sha256
from tests.test_matters_routes import _user, matters_api  # noqa: F401 - pytest fixture
from tests.test_search_matters import _section, matter_search_api  # noqa: F401 - pytest fixture


def _workbook(label: str = "Revenue") -> str:
    return json.dumps(
        {
            "sheets": [
                {
                    "name": "Plan",
                    "cells": {"a1": {"v": label}, "B1": {"f": "=SUM(A2:A9)", "v": 3}, "C1": {"v": 1250.0}},
                    "macro": "Sub AutoOpen()",
                }
            ],
            "vbaProject": "AAAA",
        }
    )


def test_spreadsheets_persist_as_canonical_workbook_drafts(matters_api) -> None:  # noqa: F811
    client, actor, repository, *_ = matters_api
    actor["value"] = _user("user-one")

    created = client.post(
        "/api/drafts", json={"title": "Budget", "content": _workbook(), "kind": "spreadsheet"}
    )
    assert created.status_code == 201, created.text
    snapshot = created.json()
    assert snapshot["document"]["kind"] == "spreadsheet"
    assert snapshot["revision"]["sanitizer_version"] == "sheet-json-v1"
    canonical = (
        '{"schema":"aperture-sheet-v1","sheets":[{"cells":{"A1":{"v":"Revenue"},'
        '"B1":{"f":"SUM(A2:A9)"},"C1":{"v":1250}},"id":"sheet-1","name":"Plan"}]}'
    )
    assert canonicalize_sheet_json(_workbook()) == canonical
    assert snapshot["revision"]["content"] == canonical
    assert snapshot["revision"]["content_sha256"] == sheet_content_sha256(canonical)
    sheet_id = snapshot["document"]["id"]
    assert client.get(f"/api/drafts/{sheet_id}").json()["revision"]["content"] == canonical

    # The kind filter separates spreadsheets from decks and documents.
    client.post("/api/drafts", json={"title": "Memo", "content": "<p>Hi</p>"})
    deck = json.dumps({"schema": "aperture-deck-v1", "title": "Deck", "slides": [{"layout": "title", "title": "Hi"}]})
    assert client.post("/api/drafts", json={"title": "Deck", "content": deck, "kind": "deck"}).status_code == 201
    listed = client.get("/api/drafts", params={"kind": "spreadsheet"})
    assert [item["id"] for item in listed.json()] == [sheet_id]
    assert {item["kind"] for item in client.get("/api/drafts").json()} == {"document", "deck", "spreadsheet"}

    # Kind is immutable: HTML, deck JSON, and broken workbooks are refused.
    for bad in ("<p>Not a workbook</p>", deck, '{"sheets":[]}'):
        refused = client.put(f"/api/drafts/{sheet_id}", json={"expected_revision": 1, "content": bad})
        assert refused.status_code == 422, bad
        assert refused.json()["detail"].startswith("Spreadsheet content is invalid: ")
    rejected_create = client.post(
        "/api/drafts", json={"title": "Bad", "content": "{nope", "kind": "spreadsheet"}
    )
    assert rejected_create.status_code == 422
    assert rejected_create.json()["detail"] == "Spreadsheet content is invalid: The workbook is not valid JSON."

    # CAS guards spreadsheets; a real edit creates revision 2.
    stale = client.put(f"/api/drafts/{sheet_id}", json={"expected_revision": 5, "content": _workbook("Costs")})
    assert stale.status_code == 409
    edited = client.put(f"/api/drafts/{sheet_id}", json={"expected_revision": 1, "content": _workbook("Costs")})
    assert edited.status_code == 200
    assert edited.json()["document"]["current_revision"] == 2
    assert '"v":"Costs"' in edited.json()["revision"]["content"]

    # Formulas typed with extra leading "=" signs or spaces save in their
    # stored form instead of failing, and read back unchanged.
    typed = json.dumps(
        {
            "sheets": [
                {
                    "name": "Plan",
                    "cells": {"A1": {"f": "==A2"}, " b02 ": {"f": "  =A1*2"}},
                    "conditional": [{"id": "r", "ref": "A1:A9", "type": "formula", "formula": " =$A1>0"}],
                }
            ]
        }
    )
    retyped = client.put(f"/api/drafts/{sheet_id}", json={"expected_revision": 2, "content": typed})
    assert retyped.status_code == 200, retyped.text
    stored = json.loads(retyped.json()["revision"]["content"])["sheets"][0]
    assert stored["cells"] == {"A1": {"f": "A2"}, "B2": {"f": "A1*2"}}
    assert stored["conditional"][0]["formula"] == "$A1>0"
    assert client.get(f"/api/drafts/{sheet_id}").json()["revision"]["content"] == retyped.json()["revision"]["content"]

    # Spreadsheets share the 8,000,000-byte deck ceiling.
    huge = client.post(
        "/api/drafts", json={"title": "Huge", "content": "{" + " " * 8_000_001 + "}", "kind": "spreadsheet"}
    )
    assert huge.status_code == 413

    # Other owners and tenants never see the spreadsheet.
    actor["value"] = _user("user-two")
    assert client.get(f"/api/drafts/{sheet_id}").status_code == 404
    actor["value"] = _user("tenant-b-user", tenant_id="tenant-b")
    assert client.get(f"/api/drafts/{sheet_id}").status_code == 404

    actor["value"] = _user("user-one")
    removed = repository.purge_user(tenant_id="tenant-a", user_id="user-one")
    assert removed["removed_drafts"] == 3


def test_spreadsheet_drafts_search_by_cell_text_and_never_leak_structure(matter_search_api) -> None:  # noqa: F811
    client, actor, repository = matter_search_api
    workbook = json.dumps(
        {
            "sheets": [
                {"name": "Marigold forecast", "cells": {"A1": {"v": "Tulipwood pilot"}, "B1": {"f": "SUM(Zinnia)"}}},
                {"name": "Notes", "cells": {"A1": {"v": 48213.5}}},
            ]
        }
    )
    snapshot = repository.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        draft_id="draft-sheet",
        title="Quarterly model",
        content=workbook,
        kind="spreadsheet",
    )
    assert entry_for_draft(snapshot.document, snapshot.revision).body == (
        "Marigold forecast Tulipwood pilot Notes 48213.5"
    )
    # A bounded cut can leave half an emoji; the draft and its index row still save.
    cut = json.dumps({"sheets": [{"name": "Cut", "cells": {"A1": {"v": "x" * 32766 + "\U0001F600"}}}]})
    saved = repository.create_draft(
        tenant_id="tenant-a", owner_user_id="user-one", draft_id="draft-cut", title="Cut", content=cut, kind="spreadsheet"
    )
    assert saved.revision.content.endswith('\\ud83d"}},"id":"sheet-1","name":"Cut"}]}')

    actor["value"] = _user("user-one")
    hits = _section(client.get("/api/search", params={"q": "tulipwood"}).json(), "draft")
    assert [item["id"] for item in hits] == ["draft-sheet"]
    assert hits[0]["navigation"] == {"view": "drafts", "draft_id": "draft-sheet", "kind": "spreadsheet"}
    assert "cells" not in hits[0]["snippet"]
    assert [item["id"] for item in _section(client.get("/api/search", params={"q": "48213.5"}).json(), "draft")] == [
        "draft-sheet"
    ]
    # Formulas and structural keys are not searchable text.
    for query in ("zinnia", "aperture-sheet-v1"):
        assert _section(client.get("/api/search", params={"q": query}).json(), "draft") == []
    actor["value"] = _user("user-two")
    assert _section(client.get("/api/search", params={"q": "tulipwood"}).json(), "draft") == []


def test_stored_spreadsheet_revisions_must_be_canonical_and_match_their_digest() -> None:
    canonical = canonicalize_sheet_json(_workbook())
    stored = {
        "draft_id": "draft-sheet",
        "tenant_id": "tenant-a",
        "owner_user_id": "user-one",
        "revision": 1,
        "title": "Budget",
        "content": canonical,
        "content_sha256": sheet_content_sha256(canonical),
        "sanitizer_version": "sheet-json-v1",
        "created_at": datetime(2026, 10, 29, tzinfo=UTC),
    }
    assert DraftRevision(**stored).kind == "spreadsheet"
    with pytest.raises(ValidationError, match="Spreadsheet content is not canonical spreadsheet JSON"):
        DraftRevision(**{**stored, "content": _workbook()})
    with pytest.raises(ValidationError, match="Spreadsheet content digest does not match"):
        DraftRevision(**{**stored, "content_sha256": "0" * 64})
    with pytest.raises(ValidationError, match="Unsupported draft sanitizer version"):
        DraftRevision(**{**stored, "sanitizer_version": "sheet-json-v2"})
