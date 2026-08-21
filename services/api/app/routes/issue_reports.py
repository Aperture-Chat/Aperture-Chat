"""User issue reporting and administrator review endpoints."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from app.core import clock
from app.core.attachment_previews import (
    attachment_preview_file,
    delete_attachment_preview,
    save_attachment_preview,
)
from app.core.policy import require_admin_or_owner
from app.core.uploads import read_upload_within_limit
from app.models.schemas import IssueReportRecord, Role, User
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user

router = APIRouter(tags=["issue-reports"])

MAX_ISSUE_SCREENSHOT_BYTES = 10 * 1024 * 1024


@router.post("/api/issue-reports", status_code=201)
async def submit_issue_report(
    subject: str = Form(...),
    body: str = Form(...),
    screenshot: UploadFile | None = File(default=None),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportRecord:
    normalized_subject = " ".join(subject.split())
    normalized_body = body.strip()
    if not normalized_subject:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Subject is required.")
    if len(normalized_subject) > 200:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Subject must be 200 characters or fewer.",
        )
    if not normalized_body:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message is required.")
    if len(normalized_body) > 5000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Message must be 5,000 characters or fewer.",
        )

    tenant_id = actor.tenant_id or next(iter(store.tenants), None)
    if tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No organization exists to record this report in.",
        )

    report_id = f"issue-{uuid4()}"
    screenshot_filename: str | None = None
    screenshot_mime_type: str | None = None
    screenshot_size_bytes: int | None = None
    if screenshot is not None:
        screenshot_filename = _safe_filename(screenshot.filename)
        screenshot_mime_type = (screenshot.content_type or "").split(";", 1)[0].strip().lower()
        if not screenshot_mime_type.startswith("image/") or screenshot_mime_type == "image/svg+xml":
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="Screenshot attachments must be PNG, JPEG, GIF, or WebP images.",
            )
        content = await read_upload_within_limit(
            screenshot,
            MAX_ISSUE_SCREENSHOT_BYTES,
            detail="Screenshot exceeds the 10 MB upload limit.",
        )
        screenshot_size_bytes = len(content)
        saved = await run_in_threadpool(
            save_attachment_preview,
            report_id,
            content,
            screenshot_mime_type,
        )
        if not saved:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="The screenshot could not be read as a supported image.",
            )

    try:
        report = store.save_issue_report(
            IssueReportRecord(
                id=report_id,
                tenant_id=tenant_id,
                user_id=actor.id,
                user_name=actor.display_name,
                subject=normalized_subject,
                body=normalized_body,
                screenshot_filename=screenshot_filename,
                screenshot_mime_type=screenshot_mime_type,
                screenshot_size_bytes=screenshot_size_bytes,
                created_at=clock.now(),
            )
        )
    except Exception:
        delete_attachment_preview(report_id)
        raise

    store.record_audit(
        actor,
        "support.issue_reported",
        report.id,
        {
            "has_screenshot": screenshot_filename is not None,
            "screenshot_size_bytes": screenshot_size_bytes,
        },
        runtime_state_changed=False,
    )
    return report


@router.get("/api/admin/issue-reports")
def list_issue_reports(
    limit: int = Query(default=200, ge=1, le=1000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[IssueReportRecord]:
    tenant_id = _admin_tenant_id(actor, store)
    reports = store.list_issue_reports(tenant_id=tenant_id, limit=limit)
    if actor.role == Role.PLATFORM_OWNER:
        return reports
    visible_user_ids = _admin_visible_user_ids(actor, store)
    return [report for report in reports if report.user_id in visible_user_ids]


@router.get("/api/admin/issue-reports/{report_id}/screenshot")
def issue_report_screenshot(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> FileResponse:
    tenant_id = _admin_tenant_id(actor, store)
    report = store.get_issue_report(report_id)
    if (
        report is None
        or report.tenant_id != tenant_id
        or report.screenshot_filename is None
        or (
            actor.role != Role.PLATFORM_OWNER
            and report.user_id not in _admin_visible_user_ids(actor, store)
        )
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Screenshot not found.")
    resolved = attachment_preview_file(report.id)
    if resolved is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Screenshot not found.")
    path, media_type = resolved
    return FileResponse(
        path,
        media_type=media_type,
        filename=report.screenshot_filename,
        headers={"Cache-Control": "private, max-age=300"},
    )


def _admin_tenant_id(actor: User, store: SeedStore) -> str:
    require_admin_or_owner(actor)
    if actor.role != Role.PLATFORM_OWNER:
        if actor.tenant_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Admin privileges are required.",
            )
        return actor.tenant_id
    first_tenant = next(iter(store.tenants), None)
    if first_tenant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No organization exists yet.")
    return first_tenant


def _admin_visible_user_ids(actor: User, store: SeedStore) -> set[str]:
    return {
        user.id
        for user in store.tenant_visible_users_for(actor)
        if user.role != Role.PLATFORM_OWNER
        and (actor.role == Role.PLATFORM_OWNER or user.tenant_id == actor.tenant_id)
        and (
            actor.role == Role.PLATFORM_OWNER
            or user.id == actor.id
            or user.role != Role.TENANT_ADMIN
        )
    }


def _safe_filename(filename: str | None) -> str:
    name = Path((filename or "screenshot").replace("\\", "/")).name
    return name.replace("\x00", "").strip()[:180] or "screenshot"
