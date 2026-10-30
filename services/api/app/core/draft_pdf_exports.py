"""Server-side PDF export jobs for the Drafts editor.

A thousand-page export takes from seconds to a few minutes and up to a few
GB of renderer memory, so it runs as a job instead of inside one request: the
browser uploads the print surface, polls the job, and downloads the finished
file. The renderer slots bound memory (one render at a time by default), the
queue and per-person caps keep one account from starving the rest, every
render has a deadline, and finished files are deleted after a short window.

All job state belongs to the API's event loop. Every public method is called
from async route handlers, and the jobs run as tasks on the same loop, so
there is exactly one writer and no lock. Jobs live in the process that
started them; the shipped image runs a single API worker.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
import unicodedata
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from app.core.draft_pdf_render import (
    PdfRenderError,
    bundled_font_css,
    heading_texts,
    print_document_html,
    render_print_document,
)
from app.core.pdf_archival import (
    PDFA_CONFORMANCE,
    ArchivalMetadata,
    ArchivalSummary,
    finish_archival_pdf,
)
from app.models.draft_pdf_export import DraftPdfExportJob, DraftPdfExportStatus, DraftPdfSource

logger = logging.getLogger("aperture.drafts.pdf")

_ACTIVE: frozenset[DraftPdfExportStatus] = frozenset({"queued", "rendering", "finishing"})
_GENERIC_FAILURE = "The PDF could not be built. Try again."

Render = Callable[[str, Path], Awaitable[None]]
Finish = Callable[[Path, Path, ArchivalMetadata], ArchivalSummary]
OnReady = Callable[[DraftPdfExportJob], Awaitable[None]]


class DraftPdfExportNotFound(LookupError):
    """No export with that id belongs to this person."""


class DraftPdfExportNotReady(RuntimeError):
    """The export exists but has no finished file."""


class DraftPdfExportLimit(RuntimeError):
    """This person already has the most exports in progress allowed."""


class DraftPdfExportBusy(RuntimeError):
    """The queue is full."""


@dataclass(frozen=True, slots=True)
class ExportOwner:
    tenant_id: str
    user_id: str
    display_name: str


@dataclass(frozen=True, slots=True)
class ExportLimits:
    concurrency: int
    queue_max: int
    per_user_active: int
    timeout_seconds: float
    retention_seconds: float


@dataclass(slots=True)
class _Job:
    id: str
    owner: ExportOwner
    title: str
    sequence: int
    workdir: Path
    status: DraftPdfExportStatus = "queued"
    summary: ArchivalSummary | None = None
    error: str | None = None
    finished_at: float | None = None
    task: asyncio.Task[None] | None = None


def export_filename(title: str) -> str:
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-")[:80].rstrip("-")
    return f"{slug or 'draft'}.pdf"


class DraftPdfExportService:
    def __init__(
        self,
        root: Path,
        limits: ExportLimits,
        *,
        render: Render = render_print_document,
        finish: Finish = finish_archival_pdf,
        font_css: Callable[[], str] = bundled_font_css,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        # Files left by an earlier process can never be claimed again.
        shutil.rmtree(root, ignore_errors=True)
        root.mkdir(parents=True, exist_ok=True)
        self._root = root
        self._limits = limits
        self._render = render
        self._finish = finish
        self._font_css = font_css
        self._clock = clock
        self._slots = asyncio.Semaphore(limits.concurrency)
        self._jobs: dict[str, _Job] = {}
        self._sequence = 0

    # --- public API (event loop only) ----------------------------------------

    def submit(
        self,
        owner: ExportOwner,
        source: DraftPdfSource,
        *,
        on_ready: OnReady | None = None,
    ) -> DraftPdfExportJob:
        self._sweep()
        active = [job for job in self._jobs.values() if job.status in _ACTIVE]
        if sum(job.owner == owner for job in active) >= self._limits.per_user_active:
            raise DraftPdfExportLimit
        if sum(job.status == "queued" for job in active) >= self._limits.queue_max:
            raise DraftPdfExportBusy
        self._sequence += 1
        job_id = f"pdf-{uuid4().hex}"
        job = _Job(
            id=job_id,
            owner=owner,
            title=source.title,
            sequence=self._sequence,
            workdir=self._root / job_id,
        )
        job.workdir.mkdir()
        self._jobs[job_id] = job
        job.task = asyncio.get_running_loop().create_task(self._run(job, source, on_ready))
        return self._view(job)

    def status(self, owner: ExportOwner, job_id: str) -> DraftPdfExportJob:
        return self._view(self._owned(owner, job_id))

    def ready_file(self, owner: ExportOwner, job_id: str) -> tuple[Path, str]:
        job = self._owned(owner, job_id)
        if job.status != "ready":
            raise DraftPdfExportNotReady
        return job.workdir / "export.pdf", export_filename(job.title)

    def discard(self, owner: ExportOwner, job_id: str) -> None:
        """Cancel a running export or free a finished one."""
        job = self._owned(owner, job_id)
        if job.task is not None and not job.task.done():
            job.task.cancel()
        self._forget(job)

    # --- internals -------------------------------------------------------------

    def _owned(self, owner: ExportOwner, job_id: str) -> _Job:
        self._sweep()
        job = self._jobs.get(job_id)
        if job is None or job.owner.tenant_id != owner.tenant_id or job.owner.user_id != owner.user_id:
            raise DraftPdfExportNotFound
        return job

    def _view(self, job: _Job) -> DraftPdfExportJob:
        summary = job.summary
        return DraftPdfExportJob(
            id=job.id,
            status=job.status,
            queue_position=self._ahead_of(job) if job.status == "queued" else None,
            page_count=summary.page_count if summary else None,
            size_bytes=summary.size_bytes if summary else None,
            bookmark_count=summary.bookmark_count if summary else None,
            conformance=PDFA_CONFORMANCE if summary else None,
            error=job.error,
        )

    def _ahead_of(self, job: _Job) -> int:
        return sum(
            other.status in {"rendering", "finishing"}
            or (other.status == "queued" and other.sequence < job.sequence)
            for other in self._jobs.values()
        )

    def _forget(self, job: _Job) -> None:
        self._jobs.pop(job.id, None)
        shutil.rmtree(job.workdir, ignore_errors=True)

    def _sweep(self) -> None:
        cutoff = self._clock() - self._limits.retention_seconds
        expired = [
            job
            for job in self._jobs.values()
            if job.finished_at is not None and job.finished_at < cutoff
        ]
        for job in expired:
            self._forget(job)

    def _fail(self, job: _Job, message: str) -> None:
        job.status = "failed"
        job.error = message
        job.finished_at = self._clock()
        for leftover in job.workdir.glob("*.pdf"):
            leftover.unlink(missing_ok=True)

    async def _run(self, job: _Job, source: DraftPdfSource, on_ready: OnReady | None) -> None:
        lang = source.lang
        try:
            async with self._slots:
                job.status = "rendering"
                document_html = print_document_html(source, self._font_css())
                headings = heading_texts(source.body_html)
                del source
                rendered = job.workdir / "render.pdf"
                async with asyncio.timeout(self._limits.timeout_seconds):
                    await self._render(document_html, rendered)
                del document_html
                job.status = "finishing"
                metadata = ArchivalMetadata(
                    title=job.title,
                    author=job.owner.display_name,
                    lang=lang,
                    created=datetime.now(UTC),
                    headings=headings,
                )
                job.summary = await asyncio.to_thread(
                    self._finish, rendered, job.workdir / "export.pdf", metadata
                )
                rendered.unlink(missing_ok=True)
        except TimeoutError:
            minutes = max(1, round(self._limits.timeout_seconds / 60))
            self._fail(
                job,
                f"The PDF took longer than {minutes} minute{'' if minutes == 1 else 's'} to build, "
                "so it was stopped. Try exporting the document in parts.",
            )
            return
        except PdfRenderError as exc:
            self._fail(job, str(exc))
            return
        except Exception:
            logger.exception("Draft PDF export %s failed", job.id)
            self._fail(job, _GENERIC_FAILURE)
            return
        job.status = "ready"
        job.finished_at = self._clock()
        if on_ready is not None:
            try:
                await on_ready(self._view(job))
            except Exception:  # noqa: BLE001 - the file is good; only the follow-up failed
                logger.exception("Draft PDF export %s finished but its follow-up failed", job.id)
