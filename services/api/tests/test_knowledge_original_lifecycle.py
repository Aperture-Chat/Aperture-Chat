"""Stored bytes follow their document: no way of adding or removing one leaves
anything behind on disk."""

from __future__ import annotations

import io
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pypdf import PdfWriter

from app.core.box import BoxItem
from app.core.cloud_sources import CloudSourceError, CloudSourceItem
from app.core.knowledge_originals import DocumentRef, KnowledgeOriginalStore
from app.core.security import SecretVault
from app.main import app
from app.models.schemas import KnowledgeConfig, TenantCreate, User
from app.repositories import seed as seed_module
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes import knowledge as knowledge_route

client = TestClient(app)

TENANT_ID = "tenant-example"
UPLOAD_BASE = "knowledge-originals-upload"
BOX_BASE = "knowledge-box-matters"
ADMIN = {"x-aperture-user": "user-admin"}


def _pdf(pages: int = 1) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def _files_under(root: Path) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file()] if root.exists() else []


@pytest.fixture
def originals_root(tmp_path: Path) -> Path:
    return tmp_path / "originals"


@pytest.fixture
def store(originals_root: Path) -> Iterator[SeedStore]:
    get_store.cache_clear()
    seeded = get_store()
    seeded.knowledge_originals = KnowledgeOriginalStore(originals_root)
    seeded.knowledge_configs[UPLOAD_BASE] = KnowledgeConfig(
        id=UPLOAD_BASE,
        tenant_id=TENANT_ID,
        name="Upload base",
        source_type="upload",
        enabled=True,
        acl_group_ids=["group-litigation"],
    )
    yield seeded
    get_store.cache_clear()


def _upload(*files: tuple[str, bytes, str]) -> object:
    return client.post(
        f"/api/knowledge/{UPLOAD_BASE}/documents",
        files=[("files", item) for item in files],
        headers=ADMIN,
    )


def _ref(store: SeedStore, base: str, name: str) -> DocumentRef:
    document = next(item for item in store.knowledge_documents_for(base) if item.name == name)
    return DocumentRef(TENANT_ID, base, document.id)


# ------------------------------------------------------------------ uploads


def test_upload_keeps_the_exact_bytes_and_the_viewer_shows_them(store: SeedStore) -> None:
    content = _pdf(2)
    assert _upload(("survey.pdf", content, "application/pdf")).status_code == 200

    ref = _ref(store, UPLOAD_BASE, "survey.pdf")
    assert store.knowledge_originals.path(ref).read_bytes() == content

    view = client.get(
        f"/api/knowledge/{UPLOAD_BASE}/documents/{ref.document_id}/view", headers=ADMIN
    ).json()
    assert view["mode"] == "pdf"
    assert view["page_count"] == 2
    original = client.get(
        f"/api/knowledge/{UPLOAD_BASE}/documents/{ref.document_id}/original", headers=ADMIN
    )
    assert original.content == content


def test_upload_of_a_text_file_keeps_it_too(store: SeedStore) -> None:
    _upload(("notes.txt", b"Plain notes about the easement.", "text/plain"))
    ref = _ref(store, UPLOAD_BASE, "notes.txt")
    assert store.knowledge_originals.path(ref).read_bytes() == b"Plain notes about the easement."


def test_upload_of_an_image_keeps_it_after_extraction_has_read_it(store: SeedStore) -> None:
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (20, 30, 40)).save(buffer, "PNG")
    assert _upload(("stamp.png", buffer.getvalue(), "image/png")).status_code == 200
    ref = _ref(store, UPLOAD_BASE, "stamp.png")
    assert store.knowledge_originals.path(ref).read_bytes() == buffer.getvalue()


def test_failed_batch_upload_leaves_no_bytes(
    store: SeedStore, originals_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = knowledge_route._document_from_segments
    calls: list[str] = []

    def fail_on_second(*args: object, **kwargs: object) -> object:
        calls.append(str(kwargs.get("name")))
        if len(calls) == 2:
            raise RuntimeError("indexing failed")
        return real(*args, **kwargs)

    monkeypatch.setattr(knowledge_route, "_document_from_segments", fail_on_second)
    test_client = TestClient(app, raise_server_exceptions=False)
    response = test_client.post(
        f"/api/knowledge/{UPLOAD_BASE}/documents",
        files=[
            ("files", ("one.txt", b"first", "text/plain")),
            ("files", ("two.txt", b"second", "text/plain")),
        ],
        headers=ADMIN,
    )
    assert response.status_code == 500
    assert calls == ["one.txt", "two.txt"]
    assert _files_under(originals_root) == []


def test_upload_survives_a_disk_that_refuses_the_original(
    store: SeedStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(*_args: object, **_kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(store.knowledge_originals, "save", refuse)
    assert _upload(("notes.txt", b"Plain notes.", "text/plain")).status_code == 200
    ref = _ref(store, UPLOAD_BASE, "notes.txt")
    view = client.get(
        f"/api/knowledge/{UPLOAD_BASE}/documents/{ref.document_id}/view", headers=ADMIN
    ).json()
    assert view["mode"] == "text"
    assert view["notice"] == "original_missing"


# ------------------------------------------------------------------ removals


def test_deleting_a_document_removes_its_bytes(store: SeedStore, originals_root: Path) -> None:
    _upload(
        ("one.pdf", _pdf(), "application/pdf"),
        ("two.pdf", _pdf(2), "application/pdf"),
    )
    one = _ref(store, UPLOAD_BASE, "one.pdf")
    two = _ref(store, UPLOAD_BASE, "two.pdf")

    response = client.delete(
        f"/api/knowledge/{UPLOAD_BASE}/documents/{one.document_id}", headers=ADMIN
    )

    assert response.status_code == 200
    assert store.knowledge_originals.path(one) is None
    assert store.knowledge_originals.path(two) is not None
    assert len(_files_under(originals_root)) == 1


def test_deleting_a_knowledge_base_removes_its_bytes(store: SeedStore, originals_root: Path) -> None:
    _upload(("one.pdf", _pdf(), "application/pdf"))
    assert _files_under(originals_root)

    response = client.delete(f"/api/admin/knowledge-configs/{UPLOAD_BASE}", headers=ADMIN)

    assert response.status_code == 200
    assert _files_under(originals_root) == []


def _persistent_store(tmp_path: Path) -> SeedStore:
    return SeedStore(
        SecretVault("originals-test-signing-secret-0123456789"),
        runtime_state_path=str(tmp_path / "runtime.json"),
        seed_demo_data_enabled=True,
    )


def _second_tenant(store: SeedStore, slug: str) -> tuple[str, User]:
    owner = store.users["user-owner"]
    tenant = store.create_tenant(TenantCreate(name="Doomed tenant", slug=slug), owner)
    return tenant.id, owner


def test_in_memory_store_has_no_files_to_reconcile(store: SeedStore, monkeypatch) -> None:
    def forbidden(*_args: object) -> None:
        raise AssertionError("an in-memory store must not touch the shared temp directory")

    monkeypatch.setattr(seed_module, "clear_scratch", forbidden)
    store.reconcile_knowledge_files()


def test_startup_clears_leftovers_and_files_of_vanished_bases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cleared: list[bool] = []
    monkeypatch.setattr(seed_module, "clear_scratch", lambda: cleared.append(True))
    store = _persistent_store(tmp_path)
    try:
        kept = DocumentRef(TENANT_ID, "knowledge-litigation-playbook", "kept")
        orphan = DocumentRef(TENANT_ID, "base-purged-long-ago", "orphan")
        store.knowledge_originals.save(kept, b"keep me")
        store.knowledge_originals.save(orphan, b"nobody can delete me")

        store.resume_identity_cleanup_jobs()

        assert store.knowledge_originals.path(kept) is not None
        assert store.knowledge_originals.path(orphan) is None
        assert cleared == [True]
    finally:
        store.close()


def test_persistent_store_keeps_originals_beside_runtime_state(tmp_path: Path) -> None:
    store = _persistent_store(tmp_path)
    try:
        assert store.knowledge_originals.root == tmp_path / "knowledge_originals"
    finally:
        store.close()


def test_deleting_a_tenant_removes_all_of_its_bytes_and_nothing_else(tmp_path: Path) -> None:
    store = _persistent_store(tmp_path)
    try:
        tenant_id, owner = _second_tenant(store, "doomed-a")
        survivor = DocumentRef(TENANT_ID, "knowledge-litigation-playbook", "kept")
        doomed = DocumentRef(tenant_id, "doomed-base", "doomed-doc")
        store.knowledge_originals.save(survivor, b"keep me")
        store.knowledge_originals.save(doomed, b"delete me")

        store.delete_tenant(tenant_id, owner)

        assert store.knowledge_originals.path(doomed) is None
        assert store.knowledge_originals.path(survivor).read_bytes() == b"keep me"
    finally:
        store.close()


def test_interrupted_tenant_purge_finishes_on_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = _persistent_store(tmp_path)
    try:
        tenant_id, owner = _second_tenant(store, "doomed-b")
        doomed = DocumentRef(tenant_id, "doomed-base", "doomed-doc")
        store.knowledge_originals.save(doomed, b"delete me")
        real_delete = store.knowledge_originals.delete_tenant

        def crash(_tenant_id: str) -> None:
            raise OSError("volume went away")

        monkeypatch.setattr(store.knowledge_originals, "delete_tenant", crash)
        with pytest.raises(OSError, match="volume went away"):
            store.delete_tenant(tenant_id, owner)
        assert store.knowledge_originals.path(doomed) is not None

        monkeypatch.setattr(store.knowledge_originals, "delete_tenant", real_delete)
        assert store.resume_identity_cleanup_jobs() == 1
        assert store.knowledge_originals.path(doomed) is None
    finally:
        store.close()


# ---------------------------------------------------------------- connectors


class _FakeBox:
    """A folder whose listing and bytes each test can change between syncs."""

    def __init__(self, files: dict[str, bytes], unreadable: set[str] | None = None) -> None:
        self.files = files
        self.unreadable = unreadable or set()

    def list_folder_items(self, *, folder_id: str) -> list[BoxItem]:
        return [
            BoxItem(id=item_id, type="file", name=f"{item_id}.pdf", size=len(content), item_status="active")
            for item_id, content in self.files.items()
        ]

    def download_file(self, *, file_id: str) -> bytes:
        if file_id in self.unreadable:
            raise knowledge_route.BoxError("gone")
        return self.files[file_id]


def _sync_box(store: SeedStore, box: _FakeBox, monkeypatch: pytest.MonkeyPatch) -> None:
    store.connector_configs["conncfg-box-example"].auth_type = "developer-token"
    store.connector_configs["conncfg-box-example"].settings["auth_mode"] = "developer-token"
    store.connector_configs["conncfg-box-example"].settings["folder_id"] = "12345"
    store.set_configuration_secret("connector", "conncfg-box-example", "box-live-token")
    monkeypatch.setattr("app.routes.knowledge.get_box_client", lambda _token: box)
    response = client.post(f"/api/knowledge/{BOX_BASE}/sync", json={"force": True}, headers=ADMIN)
    assert response.status_code == 200


def _box_ref(item_id: str) -> DocumentRef:
    return DocumentRef(TENANT_ID, BOX_BASE, f"doc-box-{item_id}")


def test_box_sync_keeps_what_it_downloads(store: SeedStore, monkeypatch: pytest.MonkeyPatch) -> None:
    content = _pdf(2)
    _sync_box(store, _FakeBox({"100": content}), monkeypatch)
    assert store.knowledge_originals.path(_box_ref("100")).read_bytes() == content


def test_box_sync_drops_files_the_source_no_longer_lists(
    store: SeedStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _sync_box(store, _FakeBox({"100": _pdf(), "200": _pdf(2)}), monkeypatch)
    _sync_box(store, _FakeBox({"200": _pdf(2)}), monkeypatch)
    assert store.knowledge_originals.path(_box_ref("100")) is None
    assert store.knowledge_originals.path(_box_ref("200")) is not None


def test_box_sync_drops_a_file_it_can_no_longer_read(
    store: SeedStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _sync_box(store, _FakeBox({"100": _pdf()}), monkeypatch)
    _sync_box(store, _FakeBox({"100": _pdf()}, unreadable={"100"}), monkeypatch)
    assert store.knowledge_originals.path(_box_ref("100")) is None


def test_box_sync_replaces_changed_bytes(store: SeedStore, monkeypatch: pytest.MonkeyPatch) -> None:
    _sync_box(store, _FakeBox({"100": _pdf(1)}), monkeypatch)
    newer = _pdf(5)
    _sync_box(store, _FakeBox({"100": newer}), monkeypatch)
    assert store.knowledge_originals.path(_box_ref("100")).read_bytes() == newer


def test_late_save_cannot_recreate_a_deleted_knowledge_base(
    store: SeedStore, originals_root: Path
) -> None:
    config = store.knowledge_configs[UPLOAD_BASE]
    retain = knowledge_route._original_retainer(config, store)
    del store.knowledge_configs[UPLOAD_BASE]

    retain("doc-late", b"bytes that arrived after the purge")

    assert _files_under(originals_root) == []


def test_microsoft_graph_sync_keeps_what_it_downloads(store: SeedStore, monkeypatch) -> None:
    config = store.knowledge_configs[UPLOAD_BASE]
    kept: list[object] = []

    def documents_and_chunks(*_args: object, **kwargs: object) -> tuple[list, list, int, int]:
        kept.append(kwargs.get("retain"))
        return [], [], 0, 0

    class Graph:
        def list_drive_items(self, **_kwargs: object) -> list[object]:
            return []

        list_items = list_files = list_folder_items = list_drive_items

    monkeypatch.setattr(knowledge_route, "_cloud_documents_and_chunks", documents_and_chunks)
    monkeypatch.setattr(knowledge_route, "get_microsoft_graph_client", lambda _token: Graph())
    monkeypatch.setattr(
        knowledge_route,
        "_connector_config",
        lambda *_args, **_kwargs: SimpleNamespace(settings={"site_id": "s", "drive_id": "d", "folder_id": "f"}),
    )
    monkeypatch.setattr(knowledge_route, "_connector_access_token", lambda *_args: ("token", None))
    monkeypatch.setattr(knowledge_route, "_source_root_id", lambda *_args: "root")

    knowledge_route._sync_microsoft_graph_documents(config, store)

    assert kept and callable(kept[0])
    assert kept[0] is not knowledge_route._retain_nothing


def test_failed_listing_keeps_what_is_stored(store: SeedStore, monkeypatch: pytest.MonkeyPatch) -> None:
    _sync_box(store, _FakeBox({"100": _pdf()}), monkeypatch)

    class Broken(_FakeBox):
        def list_folder_items(self, *, folder_id: str) -> list[BoxItem]:
            raise knowledge_route.BoxError("provider down")

    _sync_box(store, Broken({}), monkeypatch)
    assert store.knowledge_originals.path(_box_ref("100")) is not None


def test_cloud_download_is_kept_and_a_failed_one_is_dropped(store: SeedStore) -> None:
    config = store.knowledge_configs["knowledge-litigation-playbook"]
    item = CloudSourceItem(
        id="file-1",
        type="file",
        name="memo.txt",
        source_type="google-drive",
        source_uri="gdrive://file-1",
    )
    ref = DocumentRef(TENANT_ID, config.id, "doc-google-drive-file-1")
    retain = knowledge_route._original_retainer(config, store)

    class Readable:
        def download_file(self, *, file_id: str) -> bytes:
            return b"Cloud memo words."

    class Unreadable:
        def download_file(self, *, file_id: str) -> bytes:
            raise CloudSourceError("revoked")

    knowledge_route._cloud_document_and_chunks(
        config, item, Readable(), download_kwargs={}, retain=retain
    )
    assert store.knowledge_originals.path(ref).read_bytes() == b"Cloud memo words."

    knowledge_route._cloud_document_and_chunks(
        config, item, Unreadable(), download_kwargs={}, retain=retain
    )
    assert store.knowledge_originals.path(ref) is None


def test_full_sync_with_an_empty_listing_clears_the_base(
    store: SeedStore, originals_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _sync_box(store, _FakeBox({"100": _pdf()}), monkeypatch)
    _sync_box(store, _FakeBox({}), monkeypatch)
    assert _files_under(originals_root) == []


