"""The stored bytes behind knowledge documents.

A crafted id can never name a path, a write is all-or-nothing, and every
removal leaves nothing behind on disk.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import pytest

from app.core.knowledge_originals import DocumentRef, KnowledgeOriginalStore

REF = DocumentRef("tenant-a", "config-a", "doc-a")


@pytest.fixture
def store(tmp_path: Path) -> KnowledgeOriginalStore:
    return KnowledgeOriginalStore(tmp_path / "originals")


def _files(root: Path) -> list[Path]:
    return [path for path in root.rglob("*") if path.is_file()] if root.exists() else []


def test_saved_bytes_read_back_from_bytes_and_from_a_stream(store: KnowledgeOriginalStore) -> None:
    store.save(REF, b"from bytes")
    assert store.path(REF).read_bytes() == b"from bytes"

    other = DocumentRef("tenant-a", "config-a", "doc-b")
    stream = io.BytesIO(b"from a stream")
    stream.seek(5)
    store.save(other, stream)
    assert store.path(other).read_bytes() == b"from a stream"


def test_missing_document_has_no_path(store: KnowledgeOriginalStore) -> None:
    assert store.path(REF) is None
    assert store.fingerprint(REF) is None


@pytest.mark.parametrize(
    "hostile",
    [
        "../../../etc/passwd",
        "..",
        ".",
        "/etc/passwd",
        "a/../../b",
        "a\\..\\b",
        "nul\x00byte",
        "ümläut/%2e%2e",
        "x" * 5000,
    ],
)
def test_crafted_ids_stay_inside_the_root(tmp_path: Path, hostile: str) -> None:
    root = tmp_path / "deep" / "originals"
    store = KnowledgeOriginalStore(root)
    for ref in (
        DocumentRef(hostile, "config", "doc"),
        DocumentRef("tenant", hostile, "doc"),
        DocumentRef("tenant", "config", hostile),
    ):
        store.save(ref, b"secret")
        stored = store.path(ref)
        assert stored is not None
        assert stored.resolve().is_relative_to(root.resolve())
        assert stored.read_bytes() == b"secret"
    assert sorted(path.relative_to(tmp_path).parts[0] for path in tmp_path.iterdir()) == ["deep"]


def test_ids_differing_only_by_case_or_separator_do_not_collide(
    store: KnowledgeOriginalStore,
) -> None:
    store.save(DocumentRef("t", "c", "Doc"), b"upper")
    store.save(DocumentRef("t", "c", "doc"), b"lower")
    store.save(DocumentRef("t", "c/d", "e"), b"slash")
    store.save(DocumentRef("t", "c", "d/e"), b"other slash")
    assert store.path(DocumentRef("t", "c", "Doc")).read_bytes() == b"upper"
    assert store.path(DocumentRef("t", "c", "doc")).read_bytes() == b"lower"
    assert store.path(DocumentRef("t", "c/d", "e")).read_bytes() == b"slash"
    assert store.path(DocumentRef("t", "c", "d/e")).read_bytes() == b"other slash"


def test_blank_id_is_refused(store: KnowledgeOriginalStore) -> None:
    with pytest.raises(ValueError):
        store.save(DocumentRef("", "c", "d"), b"x")


def test_stored_files_are_private_to_the_service(store: KnowledgeOriginalStore) -> None:
    store.save(REF, b"private")
    stored = store.path(REF)
    assert stored.stat().st_mode & 0o777 == 0o600
    assert store.root.stat().st_mode & 0o777 == 0o700


def test_failed_write_keeps_the_previous_bytes_and_no_temp_file(
    store: KnowledgeOriginalStore, tmp_path: Path
) -> None:
    store.save(REF, b"good")

    class Broken(io.RawIOBase):
        def readable(self) -> bool:
            return True

        def seek(self, *_args: object) -> int:
            return 0

        def read(self, *_args: object) -> bytes:
            raise OSError("disk went away")

    with pytest.raises(OSError):
        store.save(REF, Broken())
    assert store.path(REF).read_bytes() == b"good"
    assert [path.name for path in _files(tmp_path / "originals")] == ["original"]


def test_identical_bytes_keep_the_fingerprint_and_derived_files(
    store: KnowledgeOriginalStore, tmp_path: Path
) -> None:
    store.save(REF, b"same")
    fingerprint = store.fingerprint(REF)
    produced = tmp_path / "made.pdf"
    produced.write_bytes(b"%PDF-1")
    assert store.publish(REF, "rendition.pdf", produced) is True

    store.save(REF, b"same")

    assert store.fingerprint(REF) == fingerprint
    assert store.derived(REF, "rendition.pdf").read_bytes() == b"%PDF-1"


def test_new_bytes_retire_derived_files_of_the_old_bytes(
    store: KnowledgeOriginalStore, tmp_path: Path
) -> None:
    store.save(REF, b"version one")
    fingerprint = store.fingerprint(REF)
    produced = tmp_path / "made.pdf"
    produced.write_bytes(b"%PDF-old")
    store.publish(REF, "rendition.pdf", produced)

    store.save(REF, b"version two is different")

    assert store.fingerprint(REF) != fingerprint
    assert store.derived(REF, "rendition.pdf") is None
    assert [path.name for path in _files(tmp_path / "originals")] == ["original"]


def test_derived_file_built_from_superseded_bytes_is_not_served(
    store: KnowledgeOriginalStore, tmp_path: Path
) -> None:
    store.save(REF, b"version one")
    stale_fingerprint = store.fingerprint(REF)
    store.save(REF, b"version two is different")
    produced = tmp_path / "late.pdf"
    produced.write_bytes(b"%PDF-stale")

    assert store.publish(REF, "rendition.pdf", produced, fingerprint=stale_fingerprint) is False
    assert store.derived(REF, "rendition.pdf") is None
    assert not produced.exists()


def test_publish_after_delete_cannot_recreate_the_document(
    store: KnowledgeOriginalStore, tmp_path: Path
) -> None:
    store.save(REF, b"bytes")
    store.delete_document(REF)
    produced = tmp_path / "late.pdf"
    produced.write_bytes(b"%PDF-late")

    assert store.publish(REF, "rendition.pdf", produced) is False
    assert _files(tmp_path / "originals") == []


def test_derived_names_cannot_escape_the_document(store: KnowledgeOriginalStore, tmp_path: Path) -> None:
    store.save(REF, b"bytes")
    produced = tmp_path / "evil"
    produced.write_bytes(b"x")
    with pytest.raises(ValueError):
        store.publish(REF, "../../evil", produced)
    with pytest.raises(ValueError):
        store.derived(REF, "../original")


def test_delete_document_removes_original_and_derived_only_for_that_document(
    store: KnowledgeOriginalStore, tmp_path: Path
) -> None:
    other = DocumentRef("tenant-a", "config-a", "doc-b")
    store.save(REF, b"one")
    store.save(other, b"two")
    produced = tmp_path / "made.pdf"
    produced.write_bytes(b"%PDF-1")
    store.publish(REF, "rendition.pdf", produced)

    store.delete_document(REF)
    store.delete_document(REF)

    assert store.path(REF) is None
    assert store.path(other).read_bytes() == b"two"


def test_delete_config_and_tenant_are_scoped_and_idempotent(
    store: KnowledgeOriginalStore, tmp_path: Path
) -> None:
    keep = DocumentRef("tenant-b", "config-a", "doc-a")
    sibling = DocumentRef("tenant-a", "config-b", "doc-a")
    store.save(REF, b"gone")
    store.save(sibling, b"stays until the tenant goes")
    store.save(keep, b"other tenant")

    store.delete_config("tenant-a", "config-a")
    store.delete_config("tenant-a", "config-a")
    assert store.path(REF) is None
    assert store.path(sibling) is not None

    store.delete_tenant("tenant-a")
    store.delete_tenant("tenant-a")
    assert store.path(sibling) is None
    assert store.path(keep).read_bytes() == b"other tenant"


def test_retain_only_drops_documents_a_sync_no_longer_lists(store: KnowledgeOriginalStore) -> None:
    stays = DocumentRef("t", "c", "stays")
    goes = DocumentRef("t", "c", "goes")
    elsewhere = DocumentRef("t", "other", "goes")
    for ref in (stays, goes, elsewhere):
        store.save(ref, b"bytes")

    store.retain_only("t", "c", {"stays"})

    assert store.path(stays) is not None
    assert store.path(goes) is None
    assert store.path(elsewhere) is not None


def test_retain_only_with_no_directory_is_a_no_op(store: KnowledgeOriginalStore) -> None:
    store.retain_only("t", "c", {"stays"})


def test_clear_removes_everything(store: KnowledgeOriginalStore, tmp_path: Path) -> None:
    store.save(REF, b"bytes")
    store.clear()
    store.clear()
    assert _files(tmp_path / "originals") == []


def test_work_directory_is_removed_after_use_even_on_failure(
    store: KnowledgeOriginalStore, tmp_path: Path
) -> None:
    with pytest.raises(RuntimeError):
        with store.work_directory() as work:
            assert work.is_dir()
            (work / "input.docx").write_bytes(b"copy of a document")
            raise RuntimeError("conversion crashed")
    assert _files(tmp_path / "originals") == []


def test_stale_work_left_by_a_crash_is_swept(store: KnowledgeOriginalStore, tmp_path: Path) -> None:
    with store.work_directory() as live:
        crashed = live.parent / "crashed"
        crashed.mkdir()
        (crashed / "input.docx").write_bytes(b"left behind")
        os.utime(crashed, (1, 1))
        partial = live.parent / "incoming-partial"
        partial.write_bytes(b"half an upload")
        os.utime(partial, (1, 1))
        fresh = live.parent / "fresh"
        fresh.mkdir()
        store.save(REF, b"any later write sweeps")
        assert not crashed.exists()
        assert not partial.exists()
        assert fresh.exists()


def test_startup_removes_what_a_crash_left_in_the_work_area(store: KnowledgeOriginalStore) -> None:
    with store.work_directory() as work:
        (work / "input.docx").write_bytes(b"a full copy of a document")
        leftover = work
        store.reconcile(set())
        assert not leftover.exists()
        leftover.mkdir(parents=True)


def test_startup_removes_folders_no_knowledge_base_owns(store: KnowledgeOriginalStore) -> None:
    kept = DocumentRef("tenant-a", "config-a", "doc")
    orphan = DocumentRef("tenant-a", "config-gone", "doc")
    other_tenant = DocumentRef("tenant-gone", "config-a", "doc")
    for ref in (kept, orphan, other_tenant):
        store.save(ref, b"bytes")

    store.reconcile({("tenant-a", "config-a")})

    assert store.path(kept) is not None
    assert store.path(orphan) is None
    assert store.path(other_tenant) is None


def test_startup_with_no_known_base_deletes_no_originals(store: KnowledgeOriginalStore) -> None:
    """Nothing loaded must never read as nothing exists: that would erase every file."""
    ref = DocumentRef("tenant-a", "config-a", "doc")
    store.save(ref, b"bytes")
    store.reconcile(set())
    assert store.path(ref).read_bytes() == b"bytes"


def test_startup_on_a_fresh_volume_is_a_no_op(store: KnowledgeOriginalStore) -> None:
    store.reconcile(set())
    assert not store.root.exists()


def test_ephemeral_store_is_removed_at_exit_and_touches_nothing_until_used() -> None:
    store = KnowledgeOriginalStore.ephemeral()
    assert not store.root.exists()
    store.save(REF, b"bytes")
    assert store.path(REF).read_bytes() == b"bytes"
    store.clear()
