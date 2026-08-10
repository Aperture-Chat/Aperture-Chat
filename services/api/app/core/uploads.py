"""Bounded reads for multipart uploads.

Reading an ``UploadFile`` with ``await file.read()`` materializes the entire
(attacker-controlled) body into memory before any size check can run. These
helpers read in fixed-size chunks and abort as soon as the configured limit is
exceeded, so an oversized upload is rejected after a bounded amount of work
instead of consuming memory proportional to the request body.
"""

from __future__ import annotations

from fastapi import HTTPException, UploadFile, status

# Read granularity. Memory peaks at roughly this much above the limit before we
# reject, regardless of how large the client claims the upload is.
_CHUNK_BYTES = 1024 * 1024


def _megabytes(num_bytes: int) -> str:
    return f"{num_bytes / (1024 * 1024):.0f} MB"


async def read_upload_within_limit(
    file: UploadFile,
    max_bytes: int,
    *,
    detail: str | None = None,
) -> bytes:
    """Return the upload's bytes, or raise 413 once it exceeds ``max_bytes``.

    Reads in bounded chunks and stops at the first chunk that pushes the running
    total past the limit, so we never buffer an unbounded body just to reject it.
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=detail or f"Upload exceeds the {_megabytes(max_bytes)} limit.",
            )
        chunks.append(chunk)
    return b"".join(chunks)


async def validate_upload_within_limit(
    file: UploadFile,
    max_bytes: int,
    *,
    detail: str | None = None,
) -> int:
    """Validate a spooled upload without copying the whole file into memory.

    FastAPI exposes ``UploadFile.file`` as a spooled file object, so large
    uploads have already rolled to disk. This pass counts fixed-size chunks,
    rejects at the configured ceiling, and rewinds the file for extractors that
    need random access.
    """
    total = 0
    try:
        while True:
            chunk = await file.read(_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=detail or f"Upload exceeds the {_megabytes(max_bytes)} limit.",
                )
    finally:
        await file.seek(0)
    return total
