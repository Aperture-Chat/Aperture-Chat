"""Stored bytes of knowledge documents, kept beside runtime state.

Ingestion keeps text and throws the file away, so nothing can show a document
as it was written. This store keeps the file itself, and anything derived from
it, keyed by tenant, knowledge base, and document.

A directory name is the SHA-256 of an id, never the id: no id, however crafted,
can name a path, and two ids cannot collide on a case-insensitive disk. Files
are written to a work area on the same volume and renamed into place, so a
reader sees the old bytes or the new ones and a crash leaves nothing half
written. Derived files carry the fingerprint of the bytes they came from, so
one built from a version that has since been replaced is never served.

Uploaded files stay as uploaded and are not encrypted, the same as generated
images, exports, and indexed text; the directories are private to the service.
The API runs one worker, so one lock is the single writer for this tree.
"""

from __future__ import annotations

import atexit
import filecmp
import hashlib
import os
import re
import shutil
import tempfile
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO
from uuid import uuid4

ORIGINAL_NAME = "original"
ROOT_DIRECTORY = "knowledge_originals"
_WORK_DIRECTORY = ".work"
_DERIVED_NAME = re.compile(r"[a-z][a-z0-9.-]*")
_COPY_BYTES = 1024 * 1024
# Longer than the slowest conversion, so a live run is never swept.
_STALE_WORK_SECONDS = 60 * 60


@dataclass(frozen=True, slots=True)
class DocumentRef:
    tenant_id: str
    config_id: str
    document_id: str


def _directory_name(identifier: str) -> str:
    if not identifier:
        raise ValueError("A stored document needs a tenant, knowledge base, and document id.")
    return hashlib.sha256(identifier.encode("utf-8", "surrogatepass")).hexdigest()


def _checked_derived_name(name: str) -> str:
    if name == ORIGINAL_NAME or _DERIVED_NAME.fullmatch(name) is None:
        raise ValueError("Derived file names are fixed by the code that writes them.")
    return name


def _fingerprint(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_mtime_ns:x}-{stat.st_size:x}"


def _derived_file_name(fingerprint: str, name: str) -> str:
    return f"{fingerprint}.{_checked_derived_name(name)}"


def _remove_tree(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass


class KnowledgeOriginalStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._lock = threading.Lock()

    @classmethod
    def ephemeral(cls) -> KnowledgeOriginalStore:
        """For a store with no data directory: gone when the process ends."""
        root = Path(tempfile.gettempdir()) / f"aperture-knowledge-originals-{uuid4().hex}"
        atexit.register(_remove_tree, root)
        return cls(root)

    def _tenant_directory(self, tenant_id: str) -> Path:
        return self.root / _directory_name(tenant_id)

    def _config_directory(self, tenant_id: str, config_id: str) -> Path:
        return self._tenant_directory(tenant_id) / _directory_name(config_id)

    def _document_directory(self, ref: DocumentRef) -> Path:
        return self._config_directory(ref.tenant_id, ref.config_id) / _directory_name(ref.document_id)

    def _work_root(self) -> Path:
        """The private root and scratch area, cleared of whatever a crash left."""
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        work = self.root / _WORK_DIRECTORY
        work.mkdir(exist_ok=True, mode=0o700)
        self._sweep_stale_work(work)
        return work

    # ---------------------------------------------------------------- reads

    def path(self, ref: DocumentRef) -> Path | None:
        original = self._document_directory(ref) / ORIGINAL_NAME
        return original if original.is_file() else None

    def fingerprint(self, ref: DocumentRef) -> str | None:
        """Changes whenever the bytes do; names the files derived from them."""
        original = self.path(ref)
        return _fingerprint(original) if original is not None else None

    def derived(self, ref: DocumentRef, name: str) -> Path | None:
        """A file built from the current bytes, or None."""
        _checked_derived_name(name)
        fingerprint = self.fingerprint(ref)
        if fingerprint is None:
            return None
        path = self._document_directory(ref) / _derived_file_name(fingerprint, name)
        return path if path.is_file() else None

    # --------------------------------------------------------------- writes

    def save(self, ref: DocumentRef, source: BinaryIO | bytes) -> None:
        """Atomically replace a document's bytes. Identical bytes change nothing,
        so a connector re-downloading an unchanged file keeps its rendition."""
        directory = self._document_directory(ref)
        incoming = self._work_root() / f"incoming-{uuid4().hex}"
        try:
            _write_private(incoming, source)
            original = directory / ORIGINAL_NAME
            if original.is_file() and filecmp.cmp(incoming, original, shallow=False):
                return
            with self._lock:
                directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.replace(incoming, original)
                for entry in directory.iterdir():
                    if entry.name != ORIGINAL_NAME:
                        entry.unlink()
        finally:
            incoming.unlink(missing_ok=True)

    def publish(
        self, ref: DocumentRef, name: str, produced: Path, *, fingerprint: str | None = None
    ) -> bool:
        """Move a finished derived file into place, consuming ``produced``.

        False, with the file dropped, when the document is gone or its bytes
        changed while the file was being built: a late conversion can neither
        recreate a deleted document nor pose as the new version.
        """
        _checked_derived_name(name)
        with self._lock:
            current = self.fingerprint(ref)
            if current is None or (fingerprint is not None and fingerprint != current):
                produced.unlink()
                return False
            target = self._document_directory(ref) / _derived_file_name(current, name)
            os.replace(produced, target)
            return True

    @contextmanager
    def work_directory(self) -> Iterator[Path]:
        """Private scratch space on this volume, removed when the block ends."""
        work = Path(tempfile.mkdtemp(prefix="convert-", dir=self._work_root()))
        try:
            yield work
        finally:
            _remove_tree(work)

    def _sweep_stale_work(self, work_root: Path) -> None:
        cutoff = time.time() - _STALE_WORK_SECONDS
        for entry in work_root.iterdir():
            try:
                if entry.stat().st_mtime < cutoff:
                    _remove_entry(entry)
            except FileNotFoundError:
                continue

    # ------------------------------------------------------------- removals

    def delete_document(self, ref: DocumentRef) -> None:
        with self._lock:
            _remove_tree(self._document_directory(ref))

    def delete_config(self, tenant_id: str, config_id: str) -> None:
        with self._lock:
            _remove_tree(self._config_directory(tenant_id, config_id))

    def delete_tenant(self, tenant_id: str) -> None:
        with self._lock:
            _remove_tree(self._tenant_directory(tenant_id))

    def retain_only(self, tenant_id: str, config_id: str, document_ids: set[str]) -> None:
        """Drop every document a full sync no longer lists."""
        keep = {_directory_name(document_id) for document_id in document_ids}
        directory = self._config_directory(tenant_id, config_id)
        with self._lock:
            if not directory.is_dir():
                return
            for entry in directory.iterdir():
                if entry.name not in keep:
                    _remove_tree(entry)

    def clear(self) -> None:
        with self._lock:
            _remove_tree(self.root)

    def reconcile(self, known_configs: set[tuple[str, str]]) -> None:
        """Startup, with nothing in flight. A crash can leave full document copies
        in the work area, and a sync racing a purge can recreate a folder after its
        base is gone. Nothing else would ever look at either again."""
        keep = {
            (_directory_name(tenant_id), _directory_name(config_id))
            for tenant_id, config_id in known_configs
        }
        with self._lock:
            _remove_tree(self.root / _WORK_DIRECTORY)
            # No base at all is a failed load until proven otherwise, and this
            # cannot be undone. A real orphan can wait for the next start.
            if not keep or not self.root.is_dir():
                return
            for config in self.root.glob("*/*"):
                if (config.parent.name, config.name) not in keep:
                    _remove_tree(config)


def _remove_entry(entry: Path) -> None:
    if entry.is_dir():
        _remove_tree(entry)
    else:
        entry.unlink()


def _write_private(path: Path, source: BinaryIO | bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as target:
        if isinstance(source, bytes):
            target.write(source)
        else:
            source.seek(0)
            shutil.copyfileobj(source, target, _COPY_BYTES)
        target.flush()
        os.fsync(target.fileno())
