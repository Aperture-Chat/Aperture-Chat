from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.core.draft_pdf_exports import (
    DraftPdfExportBusy,
    DraftPdfExportLimit,
    DraftPdfExportNotFound,
    DraftPdfExportNotReady,
    DraftPdfExportService,
    ExportLimits,
    ExportOwner,
)
from app.core.draft_pdf_render import PdfRenderError
from app.core.pdf_archival import ArchivalMetadata, ArchivalSummary
from app.models.draft_pdf_export import DraftPdfExportJob, DraftPdfSource

JORDAN = ExportOwner(tenant_id="tenant-harbor", user_id="user-jordan", display_name="Jordan Avery")
CASEY = ExportOwner(tenant_id="tenant-harbor", user_id="user-casey", display_name="Casey Lin")
OTHER_TENANT_JORDAN = ExportOwner(tenant_id="tenant-other", user_id="user-jordan", display_name="Jordan Avery")

SOURCE = DraftPdfSource(
    title="Synthetic Harbor Lease",
    lang="en-US",
    body_html='<div class="draft-print-root"><h1>Lease</h1></div>',
    css="h1 { color: #111; }",
)


class FakeRenderer:
    def __init__(self, *, gated: bool = False, error: Exception | None = None) -> None:
        self.gate = asyncio.Event() if gated else None
        self.error = error
        self.documents: list[str] = []
        self.canceled = False

    async def __call__(self, document_html: str, destination: Path) -> None:
        self.documents.append(document_html)
        try:
            if self.gate is not None:
                await self.gate.wait()
        except asyncio.CancelledError:
            self.canceled = True
            raise
        if self.error is not None:
            raise self.error
        destination.write_bytes(b"%PDF-1.7 raw")


class FakeFinisher:
    def __init__(self) -> None:
        self.metadata: list[ArchivalMetadata] = []

    def __call__(self, source: Path, destination: Path, metadata: ArchivalMetadata) -> ArchivalSummary:
        assert source.read_bytes() == b"%PDF-1.7 raw"
        self.metadata.append(metadata)
        destination.write_bytes(b"%PDF-1.7 finished")
        return ArchivalSummary(page_count=12, bookmark_count=3, size_bytes=destination.stat().st_size)


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def _service(
    tmp_path: Path,
    renderer: FakeRenderer,
    *,
    concurrency: int = 1,
    queue_max: int = 8,
    per_user_active: int = 2,
    timeout_seconds: float = 60,
    retention_seconds: float = 900,
    clock: Clock | None = None,
    finisher: FakeFinisher | None = None,
) -> DraftPdfExportService:
    return DraftPdfExportService(
        tmp_path / "exports",
        ExportLimits(
            concurrency=concurrency,
            queue_max=queue_max,
            per_user_active=per_user_active,
            timeout_seconds=timeout_seconds,
            retention_seconds=retention_seconds,
        ),
        render=renderer,
        finish=finisher or FakeFinisher(),
        font_css=lambda: "/* bundled faces */",
        clock=clock or Clock(),
    )


async def _settle(service: DraftPdfExportService, owner: ExportOwner, job_id: str) -> DraftPdfExportJob:
    for _ in range(200):
        job = service.status(owner, job_id)
        if job.status not in {"queued", "rendering", "finishing"}:
            return job
        await asyncio.sleep(0.01)
    raise AssertionError("export never finished")


async def _until(predicate) -> None:  # noqa: ANN001
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never held")


def test_a_queued_export_becomes_a_ready_archival_pdf(tmp_path: Path) -> None:
    renderer = FakeRenderer()
    finisher = FakeFinisher()
    service = _service(tmp_path, renderer, finisher=finisher)
    announced: list[DraftPdfExportJob] = []

    async def scenario() -> None:
        async def on_ready(job: DraftPdfExportJob) -> None:
            announced.append(job)

        queued = service.submit(JORDAN, SOURCE, on_ready=on_ready)
        assert queued.status == "queued"
        done = await _settle(service, JORDAN, queued.id)

        assert done.status == "ready"
        assert done.page_count == 12
        assert done.bookmark_count == 3
        assert done.conformance == "PDF/A-2b"
        assert done.size_bytes == len(b"%PDF-1.7 finished")
        path, filename = service.ready_file(JORDAN, queued.id)
        assert path.read_bytes() == b"%PDF-1.7 finished"
        assert filename == "synthetic-harbor-lease.pdf"
        assert not (path.parent / "render.pdf").exists()
        assert announced == [done]

    asyncio.run(scenario())
    document = renderer.documents[0]
    assert '<div class="draft-print-root"><h1>Lease</h1></div>' in document
    assert "/* bundled faces */" in document
    assert finisher.metadata[0].title == "Synthetic Harbor Lease"
    assert finisher.metadata[0].author == "Jordan Avery"
    assert finisher.metadata[0].lang == "en-US"
    assert finisher.metadata[0].headings == ("Lease",)


def test_no_one_else_can_see_or_take_an_export(tmp_path: Path) -> None:
    service = _service(tmp_path, FakeRenderer())

    async def scenario() -> None:
        job = service.submit(JORDAN, SOURCE)
        await _settle(service, JORDAN, job.id)
        for stranger in (CASEY, OTHER_TENANT_JORDAN):
            with pytest.raises(DraftPdfExportNotFound):
                service.status(stranger, job.id)
            with pytest.raises(DraftPdfExportNotFound):
                service.ready_file(stranger, job.id)
            with pytest.raises(DraftPdfExportNotFound):
                service.discard(stranger, job.id)
        assert service.status(JORDAN, job.id).status == "ready"

    asyncio.run(scenario())


def test_exports_wait_their_turn_and_say_how_many_are_ahead(tmp_path: Path) -> None:
    renderer = FakeRenderer(gated=True)
    service = _service(tmp_path, renderer, concurrency=1, per_user_active=3)

    async def scenario() -> None:
        first = service.submit(JORDAN, SOURCE)
        await _until(lambda: service.status(JORDAN, first.id).status == "rendering")
        second = service.submit(CASEY, SOURCE)
        await asyncio.sleep(0.02)

        waiting = service.status(CASEY, second.id)
        assert waiting.status == "queued"
        assert waiting.queue_position == 1
        assert len(renderer.documents) == 1

        third = service.submit(CASEY, SOURCE)
        assert service.status(CASEY, third.id).queue_position == 2

        renderer.gate.set()
        assert (await _settle(service, JORDAN, first.id)).status == "ready"
        assert (await _settle(service, CASEY, second.id)).status == "ready"
        assert (await _settle(service, CASEY, third.id)).status == "ready"

    asyncio.run(scenario())


def test_one_person_cannot_fill_the_queue(tmp_path: Path) -> None:
    renderer = FakeRenderer(gated=True)
    service = _service(tmp_path, renderer, per_user_active=2)

    async def scenario() -> None:
        service.submit(JORDAN, SOURCE)
        service.submit(JORDAN, SOURCE)
        with pytest.raises(DraftPdfExportLimit):
            service.submit(JORDAN, SOURCE)
        assert service.submit(CASEY, SOURCE).status == "queued"
        renderer.gate.set()

    asyncio.run(scenario())


def test_a_full_queue_turns_new_exports_away(tmp_path: Path) -> None:
    renderer = FakeRenderer(gated=True)
    service = _service(tmp_path, renderer, queue_max=1, per_user_active=5)

    async def scenario() -> None:
        first = service.submit(JORDAN, SOURCE)
        await _until(lambda: service.status(JORDAN, first.id).status == "rendering")
        service.submit(JORDAN, SOURCE)
        with pytest.raises(DraftPdfExportBusy):
            service.submit(CASEY, SOURCE)
        renderer.gate.set()

    asyncio.run(scenario())


def test_canceling_stops_the_render_and_removes_its_files(tmp_path: Path) -> None:
    renderer = FakeRenderer(gated=True)
    service = _service(tmp_path, renderer)

    async def scenario() -> None:
        job = service.submit(JORDAN, SOURCE)
        await _until(lambda: service.status(JORDAN, job.id).status == "rendering")
        workdir = tmp_path / "exports" / job.id
        assert workdir.is_dir()

        service.discard(JORDAN, job.id)
        await _until(lambda: renderer.canceled)

        assert not workdir.exists()
        with pytest.raises(DraftPdfExportNotFound):
            service.status(JORDAN, job.id)

    asyncio.run(scenario())


def test_canceling_a_queued_export_frees_its_place(tmp_path: Path) -> None:
    renderer = FakeRenderer(gated=True)
    service = _service(tmp_path, renderer, per_user_active=2)

    async def scenario() -> None:
        first = service.submit(JORDAN, SOURCE)
        await _until(lambda: service.status(JORDAN, first.id).status == "rendering")
        second = service.submit(JORDAN, SOURCE)
        service.discard(JORDAN, second.id)

        assert not (tmp_path / "exports" / second.id).exists()
        assert service.submit(JORDAN, SOURCE).status == "queued"
        renderer.gate.set()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (
            PdfRenderError("The PDF renderer could not lay out this document."),
            "The PDF renderer could not lay out this document.",
        ),
        (RuntimeError("/srv/secret/path exploded"), "The PDF could not be built. Try again."),
    ],
)
def test_a_failed_render_says_why_without_leaking_internals(tmp_path: Path, error: Exception, message: str) -> None:
    service = _service(tmp_path, FakeRenderer(error=error))

    async def scenario() -> None:
        job = service.submit(JORDAN, SOURCE)
        done = await _settle(service, JORDAN, job.id)
        assert done.status == "failed"
        assert done.error == message
        with pytest.raises(DraftPdfExportNotReady):
            service.ready_file(JORDAN, job.id)

    asyncio.run(scenario())


def test_a_render_that_runs_past_the_deadline_is_stopped(tmp_path: Path) -> None:
    renderer = FakeRenderer(gated=True)
    service = _service(tmp_path, renderer, timeout_seconds=0.05)

    async def scenario() -> None:
        job = service.submit(JORDAN, SOURCE)
        done = await _settle(service, JORDAN, job.id)
        assert done.status == "failed"
        assert done.error == (
            "The PDF took longer than 1 minute to build, so it was stopped. "
            "Try exporting the document in parts."
        )
        assert renderer.canceled

    asyncio.run(scenario())


def test_an_audit_failure_never_loses_the_pdf(tmp_path: Path) -> None:
    service = _service(tmp_path, FakeRenderer())

    async def scenario() -> None:
        async def on_ready(_job: DraftPdfExportJob) -> None:
            raise RuntimeError("audit store offline")

        job = service.submit(JORDAN, SOURCE, on_ready=on_ready)
        assert (await _settle(service, JORDAN, job.id)).status == "ready"

    asyncio.run(scenario())


def test_finished_exports_expire_after_the_retention_window(tmp_path: Path) -> None:
    clock = Clock()
    service = _service(tmp_path, FakeRenderer(), retention_seconds=900, clock=clock)

    async def scenario() -> None:
        job = service.submit(JORDAN, SOURCE)
        await _settle(service, JORDAN, job.id)
        clock.now += 900
        assert service.status(JORDAN, job.id).status == "ready"
        clock.now += 1
        with pytest.raises(DraftPdfExportNotFound):
            service.status(JORDAN, job.id)
        assert not (tmp_path / "exports" / job.id).exists()

    asyncio.run(scenario())


def test_a_restarted_service_clears_files_left_by_an_earlier_process(tmp_path: Path) -> None:
    leftover = tmp_path / "exports" / "pdf-stale"
    leftover.mkdir(parents=True)
    (leftover / "export.pdf").write_bytes(b"%PDF-1.7 old")

    _service(tmp_path, FakeRenderer())

    assert not leftover.exists()


def test_a_service_can_start_in_a_folder_that_does_not_exist_yet(tmp_path: Path) -> None:
    root = tmp_path / "nested" / "exports"

    DraftPdfExportService(
        root,
        ExportLimits(concurrency=1, queue_max=1, per_user_active=1, timeout_seconds=60, retention_seconds=60),
        render=FakeRenderer(),
        finish=FakeFinisher(),
        font_css=lambda: "",
    )

    assert root.is_dir()
