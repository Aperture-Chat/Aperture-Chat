"""Support tickets: reporting, the reporter's "My reports", and admin triage.

Visibility follows the existing feedback rules. A reporter sees only their own
tickets and only public timeline entries. A tenant admin sees tickets from the
people they administer (never another admin's, never the owner's). A platform
owner sees every organization's tickets and is the only role that can share a
ticket with the community hub, because that sends (redacted) text off the
platform.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from uuid import uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from app.core import clock, mailer, support_upstream
from app.core.attachment_previews import (
    attachment_preview_file,
    delete_attachment_preview,
    save_attachment_preview,
)
from app.core.config import get_settings
from app.core.policy import require_admin_or_owner, require_platform_owner
from app.core.privacy import conceal_for_tenant
from app.core.rate_limit import ProcessLocalTokenBucket
from app.core.uploads import read_upload_within_limit
from app.models.schemas import (
    ISSUE_REPORT_OPEN_STATUSES,
    IssueReportAssignee,
    IssueReportCommentRequest,
    IssueReportDetail,
    IssueReportEvent,
    IssueReportListItem,
    IssueReportQueue,
    IssueReportRecord,
    IssueReportReopenRequest,
    IssueReportUpdateRequest,
    IssueReportUpstreamDraft,
    IssueReportUpstreamDraftRequest,
    IssueReportUpstreamShareRequest,
    IssueReportUpstreamView,
    Role,
    User,
)
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.repositories.support_tickets import new_event_id
from app.routes.dependencies import current_user
from app.version import APP_VERSION

logger = logging.getLogger("aperture.issue_reports")

router = APIRouter(tags=["issue-reports"])

MAX_ISSUE_SCREENSHOT_BYTES = 10 * 1024 * 1024
MAX_DIAGNOSTICS_CHARS = 20_000

STATUS_LABELS = {
    "new": "Received",
    "in_review": "In review",
    "in_progress": "In progress",
    "on_hold": "On hold",
    "resolved": "Resolved",
    "closed": "Closed",
}
_IMPACT_PRIORITIES = {"low", "normal", "high"}

# A person can file a few reports or replies a minute, never a flood.
_REPORT_BUCKETS = ProcessLocalTokenBucket(
    max_entries=get_settings().rate_limit_max_buckets,
    idle_ttl_seconds=get_settings().rate_limit_idle_ttl_seconds,
)
_REPORTS_PER_MINUTE = 4
_REPLIES_PER_MINUTE = 10


# --- Reporter ---------------------------------------------------------------------


@router.post("/api/issue-reports", status_code=201)
async def submit_issue_report(
    subject: str = Form(...),
    body: str = Form(...),
    kind: str = Form(default="bug"),
    priority: str = Form(default="normal"),
    diagnostics: str | None = Form(default=None),
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
    if kind not in support_upstream.KIND_LABELS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Choose a report type.")
    # Reporters describe impact; only support can mark a ticket urgent.
    if priority not in _IMPACT_PRIORITIES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Choose an impact level.")

    tenant_id = actor.tenant_id or next(iter(store.tenants), None)
    if tenant_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No organization exists to record this report in.",
        )
    _consume(f"report:{tenant_id}:{actor.id}", _REPORTS_PER_MINUTE)

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
                kind=kind,
                priority=priority,
                subject=normalized_subject,
                body=normalized_body,
                screenshot_filename=screenshot_filename,
                screenshot_mime_type=screenshot_mime_type,
                screenshot_size_bytes=screenshot_size_bytes,
                diagnostics=_diagnostics(diagnostics, actor, store, tenant_id),
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
            "title": _ticket_title(report),
            "kind": report.kind,
            "priority": report.priority,
            "has_screenshot": screenshot_filename is not None,
            "screenshot_size_bytes": screenshot_size_bytes,
        },
        runtime_state_changed=False,
    )
    _auto_share(store, report)
    return report


@router.get("/api/issue-reports/mine")
def list_my_issue_reports(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[IssueReportListItem]:
    reports = store.support_ticket_repository.list_reports(user_id=actor.id, limit=500)
    return _list_items(store, reports, for_reporter=True)


@router.get("/api/issue-reports/mine/{report_id}")
def get_my_issue_report(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportDetail:
    report = _own_report(actor, store, report_id)
    return _detail(store, report, for_reporter=True)


@router.post("/api/issue-reports/mine/{report_id}/seen", status_code=204)
def mark_my_issue_report_seen(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> Response:
    report = _own_report(actor, store, report_id)
    store.support_ticket_repository.mark_seen(report.id, seen_at=clock.now())
    return Response(status_code=204)


@router.post("/api/issue-reports/mine/{report_id}/comments")
def comment_on_my_issue_report(
    report_id: str,
    payload: IssueReportCommentRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportDetail:
    report = _own_report(actor, store, report_id)
    if report.status not in ISSUE_REPORT_OPEN_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This report is closed. Reopen it to add more detail.",
        )
    text = _comment_text(store, report, payload.body)
    _consume(f"reply:{report.tenant_id}:{actor.id}", _REPLIES_PER_MINUTE)
    now = clock.now()
    updated = store.support_ticket_repository.update_report(
        report.id,
        changes={"reporter_seen_at": now},
        events=[
            _event(report, actor, kind="comment", body=text, actor_kind="reporter", now=now)
        ],
        now=now,
    )
    store.record_audit(
        actor,
        "support.issue_reporter_replied",
        report.id,
        {"title": _ticket_title(report)},
        runtime_state_changed=False,
    )
    return _detail(store, updated or report, for_reporter=True)


@router.post("/api/issue-reports/mine/{report_id}/reopen")
def reopen_my_issue_report(
    report_id: str,
    payload: IssueReportReopenRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportDetail:
    report = _own_report(actor, store, report_id)
    if report.status in ISSUE_REPORT_OPEN_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This report is still open.")
    _consume(f"reply:{report.tenant_id}:{actor.id}", _REPLIES_PER_MINUTE)
    now = clock.now()
    reason = _comment_text(store, report, payload.body) if payload.body.strip() else ""
    updated = store.support_ticket_repository.update_report(
        report.id,
        changes={"status": "new", "resolved_at": None, "reporter_seen_at": now},
        events=[
            _event(
                report,
                actor,
                kind="reopened",
                body=reason,
                actor_kind="reporter",
                from_value=report.status,
                to_value="new",
                now=now,
            )
        ],
        now=now,
    )
    store.record_audit(
        actor,
        "support.issue_reopened",
        report.id,
        {"title": _ticket_title(report), "previous_status": report.status},
        runtime_state_changed=False,
    )
    return _detail(store, updated or report, for_reporter=True)


@router.get("/api/issue-reports/mine/{report_id}/screenshot")
def my_issue_report_screenshot(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> FileResponse:
    return _screenshot_response(_own_report(actor, store, report_id))


# --- Admin and owner --------------------------------------------------------------


@router.get("/api/admin/issue-reports")
def list_issue_reports(
    limit: int = Query(default=200, ge=1, le=1000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[IssueReportListItem]:
    return _list_items(store, _admin_reports(actor, store, limit=limit), for_reporter=False)


@router.get("/api/admin/issue-reports/queue")
def issue_report_queue(
    limit: int = Query(default=500, ge=1, le=2000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportQueue:
    reports = _admin_reports(actor, store, limit=limit)
    counts: dict[str, int] = {key: 0 for key in STATUS_LABELS}
    counts.update({"open": 0, "needs_reply": 0, "unassigned": 0, "all": len(reports)})
    for report in reports:
        counts[report.status] = counts.get(report.status, 0) + 1
        if report.status in ISSUE_REPORT_OPEN_STATUSES:
            counts["open"] += 1
            if report.last_activity_by == "reporter":
                counts["needs_reply"] += 1
            if not report.assignee_user_id:
                counts["unassigned"] += 1
    return IssueReportQueue(
        items=_list_items(store, reports, for_reporter=False),
        counts=counts,
        assignees=_assignee_options(actor, store),
    )


@router.get("/api/admin/issue-reports/{report_id}")
def get_issue_report(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportDetail:
    return _detail(store, _admin_report(actor, store, report_id), for_reporter=False)


@router.patch("/api/admin/issue-reports/{report_id}")
def update_issue_report(
    report_id: str,
    payload: IssueReportUpdateRequest,
    background: BackgroundTasks,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportDetail:
    report = _admin_report(actor, store, report_id)
    now = clock.now()
    changes: dict[str, object] = {}
    events: list[IssueReportEvent] = []
    note = (payload.note or "").strip()
    if payload.status is not None and payload.status != report.status:
        changes["status"] = payload.status
        changes["resolved_at"] = now if payload.status in ("resolved", "closed") else None
        events.append(
            _event(
                report,
                actor,
                kind="status",
                body=_comment_text(store, report, note) if note else "",
                from_value=report.status,
                to_value=payload.status,
                now=now,
            )
        )
    elif note:
        events.append(_event(report, actor, kind="comment", body=_comment_text(store, report, note), now=now))
    if payload.priority is not None and payload.priority != report.priority:
        changes["priority"] = payload.priority
        events.append(
            _event(
                report,
                actor,
                kind="priority",
                visibility="internal",
                from_value=report.priority,
                to_value=payload.priority,
                now=now,
            )
        )
    if payload.kind is not None and payload.kind != report.kind:
        changes["kind"] = payload.kind
        events.append(
            _event(report, actor, kind="kind", from_value=report.kind, to_value=payload.kind, now=now)
        )
    if payload.assignee_user_id is not None:
        assignee_id = payload.assignee_user_id or None
        if assignee_id != report.assignee_user_id:
            assignee_name = None
            if assignee_id is not None:
                allowed = {option.id: option.name for option in _assignee_options(actor, store, report)}
                if assignee_id not in allowed:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Assign the ticket to an administrator of this organization.",
                    )
                assignee_name = store.users[assignee_id].display_name
            changes["assignee_user_id"] = assignee_id
            changes["assignee_name"] = assignee_name
            events.append(
                _event(
                    report,
                    actor,
                    kind="assignment",
                    visibility="internal",
                    from_value=(report.assignee_name or "")[:64] or None,
                    to_value=(assignee_name or "")[:64] or None,
                    now=now,
                )
            )
    if not events:
        return _detail(store, report, for_reporter=False)
    updated = store.support_ticket_repository.update_report(
        report.id, changes=changes, events=events, now=now
    )
    store.record_audit(
        actor,
        "support.issue_updated",
        report.id,
        {
            "title": _ticket_title(report),
            "changed": sorted(changes) or ["note"],
            **({"status": changes["status"]} if "status" in changes else {}),
        },
        runtime_state_changed=False,
    )
    public = [event for event in events if event.visibility == "public"]
    if public and updated is not None:
        _notify_reporter(background, store, updated, public)
    return _detail(store, updated or report, for_reporter=False)


@router.post("/api/admin/issue-reports/{report_id}/comments")
def comment_on_issue_report(
    report_id: str,
    payload: IssueReportCommentRequest,
    background: BackgroundTasks,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportDetail:
    report = _admin_report(actor, store, report_id)
    now = clock.now()
    event = _event(
        report,
        actor,
        kind="comment",
        visibility=payload.visibility,
        body=_comment_text(store, report, payload.body),
        now=now,
    )
    changes: dict[str, object] = {}
    # A first public reply moves a fresh ticket into review.
    if payload.visibility == "public" and report.status == "new":
        changes["status"] = "in_review"
    updated = store.support_ticket_repository.update_report(
        report.id,
        changes=changes,
        events=[
            event,
            *(
                [
                    _event(
                        report,
                        actor,
                        kind="status",
                        from_value="new",
                        to_value="in_review",
                        now=now,
                    )
                ]
                if changes
                else []
            ),
        ],
        now=now,
    )
    store.record_audit(
        actor,
        "support.issue_commented",
        report.id,
        {"title": _ticket_title(report), "visibility": payload.visibility},
        runtime_state_changed=False,
    )
    if payload.visibility == "public" and updated is not None:
        _notify_reporter(background, store, updated, [event])
    return _detail(store, updated or report, for_reporter=False)


@router.get("/api/admin/issue-reports/{report_id}/screenshot")
def issue_report_screenshot(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> FileResponse:
    try:
        report = _admin_report(actor, store, report_id)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            raise HTTPException(status_code=404, detail="Screenshot not found.") from exc
        raise
    return _screenshot_response(report)


# --- Community hub sharing (owner) ------------------------------------------------


@router.post("/api/admin/issue-reports/{report_id}/upstream/draft")
def draft_issue_report_upstream(
    report_id: str,
    payload: IssueReportUpstreamDraftRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportUpstreamDraft:
    require_platform_owner(actor)
    report = _admin_report(actor, store, report_id)
    return support_upstream.build_share_draft(
        store,
        get_settings(),
        report,
        include_diagnostics=payload.include_diagnostics,
        use_ai=payload.use_ai,
    )


@router.post("/api/admin/issue-reports/{report_id}/upstream")
def share_issue_report_upstream(
    report_id: str,
    payload: IssueReportUpstreamShareRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportDetail:
    require_platform_owner(actor)
    report = _admin_report(actor, store, report_id)
    settings = get_settings()
    existing = store.support_ticket_repository.get_upstream(report.id)
    if existing is not None and existing.state not in ("failed",):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This ticket was already shared with the maintainers.",
        )
    draft = support_upstream.build_share_draft(store, settings, report, include_diagnostics=False)
    if not draft.hub_available:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=draft.blocked_reason)
    link = support_upstream.queue_share(
        store,
        settings,
        report,
        title=payload.title,
        body=payload.body,
        include_diagnostics=payload.include_diagnostics,
        shared_by_user_id=actor.id,
        shared_by_name=actor.display_name,
    )
    store.record_audit(
        actor,
        "support.issue_shared_upstream",
        report.id,
        {
            "title": _ticket_title(report),
            "hub": link.hub_url,
            "include_diagnostics": payload.include_diagnostics,
        },
        runtime_state_changed=False,
    )
    support_upstream.send_now(store, settings, link)
    refreshed = store.support_ticket_repository.get_report(report.id) or report
    return _detail(store, refreshed, for_reporter=False)


@router.post("/api/admin/issue-reports/{report_id}/upstream/refresh")
def refresh_issue_report_upstream(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> IssueReportDetail:
    require_platform_owner(actor)
    report = _admin_report(actor, store, report_id)
    link = store.support_ticket_repository.get_upstream(report.id)
    if link is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This ticket was not shared.")
    support_upstream.send_now(store, get_settings(), link)
    refreshed = store.support_ticket_repository.get_report(report.id) or report
    return _detail(store, refreshed, for_reporter=False)


# --- Helpers ------------------------------------------------------------------------


def _consume(key: str, per_minute: int) -> None:
    allowed, retry_after = _REPORT_BUCKETS.consume(key, per_minute)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="You're sending these very quickly. Wait a moment and try again.",
            headers={"Retry-After": str(retry_after)},
        )


def _ticket_title(report: IssueReportRecord) -> str:
    return f"Report #{report.number}" if report.number else "Report"


def _diagnostics(raw: str | None, actor: User, store: SeedStore, tenant_id: str) -> dict | None:
    parsed: object = None
    if raw and len(raw) <= MAX_DIAGNOSTICS_CHARS:
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
    cleaned = support_upstream.clean_client_diagnostics(parsed)
    if cleaned is None and raw is None:
        return None
    cleaned = dict(cleaned or {})
    # Server-known facts are recorded by the server, never taken from the browser.
    cleaned["app_version"] = APP_VERSION
    cleaned["reporter_role"] = actor.role.value
    for field in ("route", "user_agent"):
        if field in cleaned:
            cleaned[field] = conceal_for_tenant(store, tenant_id, cleaned[field])
    return cleaned


def _auto_share(store: SeedStore, report: IssueReportRecord) -> None:
    try:
        support_settings = store.support_ticket_repository.get_settings()
        if support_settings.upstream_mode != "automatic":
            return
        support_upstream.queue_automatic_share(store, get_settings(), report)
    except Exception:  # noqa: BLE001 - sharing must never fail a submission
        logger.exception("Automatic sharing could not queue %s", report.id)


def _own_report(actor: User, store: SeedStore, report_id: str) -> IssueReportRecord:
    report = store.support_ticket_repository.get_report(report_id)
    if report is None or report.user_id != actor.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found.")
    return report


def _admin_reports(actor: User, store: SeedStore, *, limit: int) -> list[IssueReportRecord]:
    require_admin_or_owner(actor)
    repository = store.support_ticket_repository
    if actor.role == Role.PLATFORM_OWNER:
        return repository.list_reports(limit=limit)
    if actor.tenant_id is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin privileges are required.")
    visible = _admin_visible_user_ids(actor, store)
    return [
        report
        for report in repository.list_reports(tenant_id=actor.tenant_id, limit=limit)
        if report.user_id in visible
    ]


def _admin_report(actor: User, store: SeedStore, report_id: str) -> IssueReportRecord:
    require_admin_or_owner(actor)
    report = store.support_ticket_repository.get_report(report_id)
    if report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found.")
    if actor.role == Role.PLATFORM_OWNER:
        return report
    if (
        actor.tenant_id is None
        or report.tenant_id != actor.tenant_id
        or report.user_id not in _admin_visible_user_ids(actor, store)
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found.")
    return report


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


def _assignee_options(
    actor: User, store: SeedStore, report: IssueReportRecord | None = None
) -> list[IssueReportAssignee]:
    """Who a ticket can be assigned to: owners, and admins of its organization."""

    multi_tenant = len(store.tenants) > 1
    owner_view = actor.role == Role.PLATFORM_OWNER
    scope_tenant = report.tenant_id if report is not None else (None if owner_view else actor.tenant_id)
    options: list[IssueReportAssignee] = []
    for user in store.users.values():
        if not user.active:
            continue
        if user.role == Role.PLATFORM_OWNER:
            # Tenant admins never see or assign platform owners.
            if owner_view:
                options.append(IssueReportAssignee(id=user.id, name=user.display_name))
        elif user.role == Role.TENANT_ADMIN:
            if scope_tenant is not None and user.tenant_id != scope_tenant:
                continue
            label = user.display_name
            if multi_tenant and owner_view and user.tenant_id in store.tenants:
                label = f"{user.display_name} · {store.tenants[user.tenant_id].name}"
            options.append(IssueReportAssignee(id=user.id, name=label))
    return sorted(options, key=lambda option: option.name.casefold())


def _comment_text(store: SeedStore, report: IssueReportRecord, text: str) -> str:
    cleaned = text.strip()
    if not cleaned:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Write a message first.")
    if len(cleaned) > 5000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Messages must be 5,000 characters or fewer."
        )
    # Replies follow the same personal-data policy as the report itself.
    return conceal_for_tenant(store, report.tenant_id, cleaned)


def _event(
    report: IssueReportRecord,
    actor: User,
    *,
    kind: str,
    body: str = "",
    visibility: str = "public",
    actor_kind: str = "support",
    from_value: str | None = None,
    to_value: str | None = None,
    now=None,
) -> IssueReportEvent:
    return IssueReportEvent(
        id=new_event_id(),
        report_id=report.id,
        tenant_id=report.tenant_id,
        kind=kind,
        visibility=visibility,
        actor_user_id=actor.id,
        actor_name=actor.display_name,
        actor_kind=actor_kind,
        body=body,
        from_value=from_value,
        to_value=to_value,
        created_at=now or clock.now(),
    )


def _list_items(
    store: SeedStore, reports: list[IssueReportRecord], *, for_reporter: bool
) -> list[IssueReportListItem]:
    links = store.support_ticket_repository.upstreams_for(report.id for report in reports)
    items: list[IssueReportListItem] = []
    for report in reports:
        tenant = store.tenants.get(report.tenant_id)
        link = links.get(report.id)
        record = _reporter_view(report) if for_reporter else report
        items.append(
            IssueReportListItem(
                **record.model_dump(),
                tenant_name=tenant.name if tenant is not None else "",
                unread=_unread(report),
                upstream=_upstream_view(link, for_reporter=for_reporter) if link else None,
            )
        )
    return items


def _detail(store: SeedStore, report: IssueReportRecord, *, for_reporter: bool) -> IssueReportDetail:
    item = _list_items(store, [report], for_reporter=for_reporter)[0]
    events = store.support_ticket_repository.list_events(report.id, include_internal=not for_reporter)
    if for_reporter:
        # Reporters see that support replied, not which administrator.
        events = [
            event.model_copy(update={"actor_user_id": None, "actor_name": "Support team"})
            if event.actor_kind == "support"
            else event
            for event in events
        ]
    return IssueReportDetail(report=item, events=events)


def _reporter_view(report: IssueReportRecord) -> IssueReportRecord:
    return report.model_copy(update={"assignee_user_id": None, "assignee_name": None})


def _upstream_view(link, *, for_reporter: bool) -> IssueReportUpstreamView:
    view = IssueReportUpstreamView.from_link(link)
    if for_reporter:
        # The reporter sees where it went and what happened, not who sent it
        # or the redacted payload.
        return view.model_copy(
            update={
                "shared_by_name": "",
                "sent_title": "",
                "sent_body": "",
                "sent_diagnostics": None,
                "last_error": None,
                "attempts": 0,
            }
        )
    return view


def _unread(report: IssueReportRecord) -> bool:
    # The reporter's own submissions, replies, and reopens move
    # ``reporter_seen_at`` too, so only someone else's activity reads as new.
    if report.last_public_activity_at is None:
        return False
    return report.reporter_seen_at is None or report.last_public_activity_at > report.reporter_seen_at


def _screenshot_response(report: IssueReportRecord) -> FileResponse:
    if report.screenshot_filename is None:
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


def _notify_reporter(
    background: BackgroundTasks,
    store: SeedStore,
    report: IssueReportRecord,
    events: list[IssueReportEvent],
) -> None:
    """Email the reporter about a public reply or status change, if configured."""

    try:
        support_settings = store.support_ticket_repository.get_settings()
    except Exception:  # noqa: BLE001
        return
    reporter = store.users.get(report.user_id)
    if (
        not support_settings.notify_reporters
        or reporter is None
        or not reporter.active
        or not reporter.email
        or not mailer.email_configured(store.email_settings)
    ):
        return
    brand = store.brand_name(report.tenant_id) or "Aperture Chat"
    lines = [f"Hi {reporter.display_name},", "", f"There's an update on your report #{report.number}: {report.subject}", ""]
    for event in events:
        if event.kind == "status" and event.to_value:
            lines.append(f"Status: {STATUS_LABELS.get(event.to_value, event.to_value)}")
        if event.body:
            lines.extend(["", event.body])
    lines.extend(
        [
            "",
            f"To reply or see the full history, open {brand}, choose Help, then My reports.",
        ]
    )
    background.add_task(
        _send_reporter_email,
        store,
        reporter.email,
        f"[{brand}] Update on report #{report.number}: {report.subject}"[:200],
        "\n".join(lines),
    )


def _send_reporter_email(store: SeedStore, recipient: str, subject: str, body_text: str) -> None:
    settings = store.email_settings
    try:
        mailer.send_email(
            host=settings.host,
            port=settings.port,
            security=settings.security,
            username=settings.username,
            password=store.configuration_secret("smtp", "primary"),
            from_address=settings.from_address,
            recipients=[recipient],
            subject=subject,
            body_text=body_text,
        )
    except mailer.MailerError as exc:
        logger.info("Support reply email was not delivered: %s", exc)
    except Exception:  # noqa: BLE001 - notification is best-effort
        logger.exception("Support reply email failed")


def _safe_filename(filename: str | None) -> str:
    name = Path((filename or "screenshot").replace("\\", "/")).name
    return name.replace("\x00", "").strip()[:180] or "screenshot"
