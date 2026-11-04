"""Folder uploads: a file sent with its place in a folder is one document per
path, so uploading or syncing the same folder again adds what is new, updates
what changed, and leaves the rest alone."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.knowledge_folders import (
    MAX_REMOVED_PATHS,
    FolderPathError,
    file_name,
    folder_change,
    folder_manifest,
    folder_of,
    parse_folder_path,
    remember_removed,
)
from app.core.knowledge_originals import DocumentRef, KnowledgeOriginalStore
from app.main import app
from app.models.schemas import KnowledgeConfig, KnowledgeDocument, KnowledgeFolderFile
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.knowledge import _passages_label

client = TestClient(app)

TENANT_ID = "tenant-example"
BASE = "knowledge-folder-sync"
ADMIN = {"x-aperture-user": "user-admin"}


@pytest.fixture
def store(tmp_path: Path) -> Iterator[SeedStore]:
    get_store.cache_clear()
    seeded = get_store()
    seeded.knowledge_originals = KnowledgeOriginalStore(tmp_path / "originals")
    seeded.knowledge_configs[BASE] = KnowledgeConfig(
        id=BASE,
        tenant_id=TENANT_ID,
        name="Matter folders",
        source_type="upload",
        enabled=True,
        acl_group_ids=["group-litigation"],
    )
    yield seeded
    get_store.cache_clear()


def _send(path: str, content: bytes, *, modified: int = 1_700_000_000_000, headers=ADMIN):
    name = path.replace("\\", "/").split("/")[-1]
    return client.post(
        f"/api/knowledge/{BASE}/folder-files",
        files={"file": (name, content, "text/plain")},
        data={"path": path, "modified": str(modified)},
        headers=headers,
    )


def _documents(store: SeedStore) -> list[KnowledgeDocument]:
    return store.knowledge_documents_for(BASE)


def _chunk_text(store: SeedStore, document_id: str) -> str:
    return " ".join(chunk.text for chunk in store.knowledge_document_chunks(BASE, document_id))


# ------------------------------------------------------------------ paths


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Matter 12/Pleadings/brief.pdf", "Matter 12/Pleadings/brief.pdf"),
        ("Matter 12\\Pleadings\\brief.pdf", "Matter 12/Pleadings/brief.pdf"),
        ("/Matter 12/./brief.pdf", "Matter 12/brief.pdf"),
        ("Matter 12//brief.pdf ", "Matter 12/brief.pdf"),
    ],
)
def test_folder_paths_are_normalized(raw: str, expected: str) -> None:
    assert parse_folder_path(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "brief.pdf",
        "",
        "Matter/../secrets.txt",
        "../outside.txt",
        "Matter/\x00evil.txt",
        "Matter/" + "x" * 256 + ".txt",
        "/".join(["d"] * 40) + "/f.txt",
        "/".join(["x" * 250] * 5) + "/f.txt",
    ],
)
def test_unsafe_or_folderless_paths_are_refused(raw: str) -> None:
    with pytest.raises(FolderPathError):
        parse_folder_path(raw)


@pytest.mark.parametrize(
    "raw",
    [
        "Matter/" + "x" * 251 + ".txt",
        "/".join(["d"] * 31) + "/f.txt",
        "/".join(["y" * 204] * 5),
    ],
)
def test_paths_at_each_limit_are_accepted(raw: str) -> None:
    assert parse_folder_path(raw) == raw


def test_file_name_is_the_last_segment() -> None:
    assert file_name("Matter 12/Pleadings/brief.pdf") == "brief.pdf"


def test_passage_counts_read_naturally() -> None:
    assert _passages_label(1) == "1 passage"
    assert _passages_label(2) == "2 passages"
    assert _passages_label(1200) == "1,200 passages"


def test_folder_of_names_the_folders_above_the_file() -> None:
    assert folder_of("Matter 12/Pleadings/brief.pdf") == "Matter 12/Pleadings"
    assert folder_of("Matter 12/brief.pdf") == "Matter 12"


def _folder_document(
    path: str, *, size: int = 10, modified: int = 5, document_id: str = "doc-1"
) -> KnowledgeDocument:
    return KnowledgeDocument(
        id=document_id,
        knowledge_config_id=BASE,
        tenant_id=TENANT_ID,
        name=path.split("/")[-1],
        source_uri="upload://x",
        source_type="upload",
        updated_at="now",
        folder_file=KnowledgeFolderFile(path=path, size=size, modified=modified),
    )


def test_a_file_is_new_changed_or_unchanged_by_its_size_and_modified_time() -> None:
    existing = _folder_document("A/b.txt", size=10, modified=5)
    assert folder_change(None, size=10, modified=5) == "added"
    assert folder_change(existing, size=10, modified=5) == "unchanged"
    assert folder_change(existing, size=11, modified=5) == "updated"
    assert folder_change(existing, size=10, modified=6) == "updated"


def test_manifest_groups_folder_files_by_top_folder_and_lists_removed_paths() -> None:
    plain = _folder_document("A/x.txt", document_id="doc-plain").model_copy(
        update={"folder_file": None}
    )
    documents = [
        _folder_document("Beta/one.txt", document_id="doc-b1"),
        _folder_document("Alpha/sub/two.txt", size=3, modified=9, document_id="doc-a2"),
        plain,
        _folder_document("Alpha/one.txt", document_id="doc-a1"),
    ]
    manifest = folder_manifest(documents, removed=["Alpha/gone.txt", "Gamma/old.txt"])
    assert [folder["name"] for folder in manifest] == ["Alpha", "Beta", "Gamma"]
    alpha = manifest[0]
    assert alpha["files"] == [
        {"path": "Alpha/one.txt", "size": 10, "modified": 5, "document_id": "doc-a1"},
        {"path": "Alpha/sub/two.txt", "size": 3, "modified": 9, "document_id": "doc-a2"},
    ]
    assert alpha["removed"] == ["Alpha/gone.txt"]
    assert manifest[2] == {"name": "Gamma", "files": [], "removed": ["Gamma/old.txt"]}


def test_removed_paths_are_kept_once_and_bounded() -> None:
    assert remember_removed(["A/x.txt"], "A/x.txt") == ["A/x.txt"]
    assert remember_removed(["A/x.txt"], "A/y.txt") == ["A/x.txt", "A/y.txt"]
    full = [f"A/{index}.txt" for index in range(MAX_REMOVED_PATHS)]
    bounded = remember_removed(full, "A/new.txt")
    assert len(bounded) == MAX_REMOVED_PATHS
    assert bounded[-1] == "A/new.txt"
    assert bounded[0] == "A/1.txt"


# ------------------------------------------------------------------ routes


def test_a_folder_file_is_added_with_its_place_in_the_folder(store: SeedStore) -> None:
    response = _send("Matter 12/Pleadings/brief.txt", b"The easement runs along the north fence.")
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "added"
    assert body["provider_message"] == "Added Matter 12/Pleadings/brief.txt (2 passages)."
    document = body["document"]
    assert document["name"] == "brief.txt"
    assert document["source_type"] == "upload"
    assert document["folder_file"] == {
        "path": "Matter 12/Pleadings/brief.txt",
        "size": len(b"The easement runs along the north fence."),
        "modified": 1_700_000_000_000,
    }
    assert document["metadata"]["Folder"] == "Matter 12/Pleadings"
    assert body["config"]["settings"]["document_count"] == 1
    assert "north fence" in _chunk_text(store, document["id"])
    ref = DocumentRef(TENANT_ID, BASE, document["id"])
    assert (
        store.knowledge_originals.path(ref).read_bytes()
        == b"The easement runs along the north fence."
    )


def test_sending_a_changed_file_again_updates_the_same_document(store: SeedStore) -> None:
    first = _send("Matter 12/notes.txt", b"Draft one mentions the old survey.").json()["document"]
    response = _send(
        "Matter 12/notes.txt", b"Draft two cites the new survey only.", modified=1_700_000_500_000
    )
    assert response.status_code == 200
    body = response.json()
    assert body["action"] == "updated"
    assert body["provider_message"] == "Updated Matter 12/notes.txt (2 passages)."
    assert body["document"]["id"] == first["id"]
    assert [document.id for document in _documents(store)] == [first["id"]]
    text = _chunk_text(store, first["id"])
    assert "new survey" in text
    assert "old survey" not in text
    ref = DocumentRef(TENANT_ID, BASE, first["id"])
    assert (
        store.knowledge_originals.path(ref).read_bytes() == b"Draft two cites the new survey only."
    )


def test_sending_an_unchanged_file_again_changes_nothing(store: SeedStore) -> None:
    first = _send("Matter 12/notes.txt", b"Same words.").json()["document"]
    chunks_before = store.knowledge_document_chunks(BASE, first["id"])
    response = _send("Matter 12/notes.txt", b"Same words.")
    assert response.status_code == 200
    assert response.json()["action"] == "unchanged"
    assert response.json()["document"]["id"] == first["id"]
    assert len(_documents(store)) == 1
    assert store.knowledge_document_chunks(BASE, first["id"]) == chunks_before


def test_the_folder_list_reports_each_folder_and_its_files(store: SeedStore) -> None:
    added = _send("Matter 12/a.txt", b"alpha", modified=11).json()["document"]
    _send("Matter 12/deeper/b.txt", b"bravo", modified=12)
    _send("Estate/c.txt", b"charlie", modified=13)
    plain = client.post(
        f"/api/knowledge/{BASE}/documents",
        files=[("files", ("loose.txt", b"loose file", "text/plain"))],
        headers=ADMIN,
    )
    assert plain.status_code == 200

    response = client.get(f"/api/knowledge/{BASE}/folders", headers=ADMIN)
    assert response.status_code == 200
    folders = response.json()["folders"]
    assert [folder["name"] for folder in folders] == ["Estate", "Matter 12"]
    assert folders[1]["files"][0] == {
        "path": "Matter 12/a.txt",
        "size": 5,
        "modified": 11,
        "document_id": added["id"],
    }
    assert [item["path"] for item in folders[1]["files"]] == [
        "Matter 12/a.txt",
        "Matter 12/deeper/b.txt",
    ]


def test_removing_a_folder_file_keeps_later_syncs_from_bringing_it_back(store: SeedStore) -> None:
    added = _send("Matter 12/a.txt", b"alpha").json()["document"]
    deleted = client.delete(f"/api/knowledge/{BASE}/documents/{added['id']}", headers=ADMIN)
    assert deleted.status_code == 200

    folders = client.get(f"/api/knowledge/{BASE}/folders", headers=ADMIN).json()["folders"]
    assert folders == [{"name": "Matter 12", "files": [], "removed": ["Matter 12/a.txt"]}]


def test_a_file_without_a_modified_time_is_accepted_and_a_negative_one_refused(
    store: SeedStore,
) -> None:
    assert _send("Matter 12/a.txt", b"alpha", modified=0).status_code == 200
    assert _send("Matter 12/b.txt", b"bravo", modified=-1).status_code == 422
    assert [document.name for document in _documents(store)] == ["a.txt"]


def test_an_unreadable_folder_file_is_one_passage_with_a_note(store: SeedStore) -> None:
    body = _send("Matter 12/blank.txt", b"").json()
    assert body["document"]["status"] == "metadata-only"
    assert body["provider_message"] == (
        "Added Matter 12/blank.txt (2 passages). "
        "No readable text was found in blank.txt, so only its name is searchable."
    )


def test_unsafe_folder_paths_are_refused_by_the_route(store: SeedStore) -> None:
    response = _send("Matter/../../etc/passwd", b"nope")
    assert response.status_code == 422
    assert "folder" in response.json()["detail"].lower()
    assert _documents(store) == []


def test_people_who_cannot_manage_the_base_cannot_add_or_list_folder_files(
    store: SeedStore,
) -> None:
    jane = {"x-aperture-user": "user-jane"}
    assert _send("Matter 12/a.txt", b"alpha", headers=jane).status_code == 403
    assert client.get(f"/api/knowledge/{BASE}/folders", headers=jane).status_code == 403
    assert _documents(store) == []


def test_an_audit_event_records_each_synced_folder_file(store: SeedStore) -> None:
    _send("Matter 12/a.txt", b"alpha")
    _send("Matter 12/a.txt", b"alpha, revised", modified=99)
    events = [
        event for event in store.audit_events if event.action == "knowledge.folder_file_synced"
    ]
    assert [event.metadata["action"] for event in events[-2:]] == ["added", "updated"]
    assert all(event.target == BASE for event in events[-2:])
