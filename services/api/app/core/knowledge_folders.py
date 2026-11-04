"""Folders uploaded from a person's computer into a knowledge base.

Glossary:
- folder path: where a file sits inside the folder that was uploaded,
  starting with that folder's own name ("Matter 12/Pleadings/brief.pdf").
  It is the file's identity: one document per folder path in a base.
- folder: the first segment of a folder path. Uploading a folder with the
  same name again is a sync of that folder.
- removed path: a folder file someone deleted in Aperture. Syncs skip it, so
  a deleted file is not brought back from the person's computer.

The browser reads the folder and decides what to send; the server keeps the
truth about what each folder already holds.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Literal

from app.models.schemas import KnowledgeDocument

FolderChange = Literal["added", "updated", "unchanged"]

# Settings key holding removed folder paths for a knowledge base.
REMOVED_FOLDER_PATHS_KEY = "folder_removed_paths"
MAX_REMOVED_PATHS = 2000
MAX_SEGMENT_CHARS = 255
MAX_PATH_CHARS = 1024
MAX_DEPTH = 32


class FolderPathError(ValueError):
    """A folder path that is unsafe, too long, or names no folder."""


def parse_folder_path(raw: str) -> str:
    """Normalize a browser-reported relative path, or refuse it.

    Backslashes count as separators, empty and "." segments are dropped, and
    ".." or control characters are refused outright rather than resolved.
    """
    segments = [segment.strip() for segment in raw.replace("\\", "/").split("/")]
    segments = [segment for segment in segments if segment and segment != "."]
    if len(segments) < 2:
        raise FolderPathError("A folder file needs the folder it came from.")
    if any(segment == ".." for segment in segments):
        raise FolderPathError("A folder path cannot step outside its folder.")
    if any(_has_control_character(segment) for segment in segments):
        raise FolderPathError("A folder path cannot contain control characters.")
    if any(len(segment) > MAX_SEGMENT_CHARS for segment in segments):
        raise FolderPathError("A folder or file name in the path is too long.")
    if len(segments) > MAX_DEPTH:
        raise FolderPathError(f"Folders more than {MAX_DEPTH} levels deep are not supported.")
    path = "/".join(segments)
    if len(path) > MAX_PATH_CHARS:
        raise FolderPathError("The folder path is too long.")
    return path


def _has_control_character(value: str) -> bool:
    return any(ord(character) < 32 or ord(character) == 127 for character in value)


def folder_name(path: str) -> str:
    return path.split("/", 1)[0]


def folder_of(path: str) -> str:
    """The folders above a file, shown and searched as its "Folder" property."""
    return path.rsplit("/", 1)[0]


def file_name(path: str) -> str:
    return path.split("/")[-1]


def folder_change(existing: KnowledgeDocument | None, *, size: int, modified: int) -> FolderChange:
    """Whether a file sent for a folder path adds, updates, or repeats a document."""
    if existing is None or existing.folder_file is None:
        return "added"
    if existing.folder_file.size == size and existing.folder_file.modified == modified:
        return "unchanged"
    return "updated"


def document_at_path(documents: Iterable[KnowledgeDocument], path: str) -> KnowledgeDocument | None:
    return next(
        (
            document
            for document in documents
            if document.folder_file is not None and document.folder_file.path == path
        ),
        None,
    )


def removed_paths(settings: dict[str, object]) -> list[str]:
    raw = settings.get(REMOVED_FOLDER_PATHS_KEY)
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, str)]


def remember_removed(paths: list[str], path: str) -> list[str]:
    """Add ``path`` once, keeping the newest ``MAX_REMOVED_PATHS``."""
    if path in paths:
        return list(paths)
    return [*paths, path][-MAX_REMOVED_PATHS:]


def folder_manifest(
    documents: Iterable[KnowledgeDocument], *, removed: Iterable[str]
) -> list[dict[str, object]]:
    """Each folder with its files (by path) and its removed paths, sorted by name."""
    files: dict[str, list[dict[str, object]]] = {}
    for document in documents:
        if document.folder_file is None:
            continue
        entry = document.folder_file
        files.setdefault(folder_name(entry.path), []).append(
            {
                "path": entry.path,
                "size": entry.size,
                "modified": entry.modified,
                "document_id": document.id,
            }
        )
    gone: dict[str, list[str]] = {}
    for path in removed:
        gone.setdefault(folder_name(path), []).append(path)
    return [
        {
            "name": name,
            "files": sorted(files.get(name, []), key=lambda item: str(item["path"])),
            "removed": gone.get(name, []),
        }
        for name in sorted(set(files) | set(gone))
    ]
