"""Owner support settings and the community intake hub API.

``/api/platform/support/*`` and ``/api/platform/support-hub/*`` are platform
owner only. ``/api/support-hub/v1/*`` is the public, unauthenticated API other
deployments call; it answers only while this deployment has the hub enabled.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status

from app.core import clock, mailer, support_ai, support_hub, support_upstream
from app.core.config import get_settings
from app.core.policy import require_platform_owner
from app.core.rate_limit import ProcessLocalTokenBucket, validated_client_ip
from app.core.security import mask_secret
from app.models.schemas import (
    SupportHubDeclineRequest,
    SupportHubInfo,
    SupportHubLinkRequest,
    SupportHubPublicStatus,
    SupportHubPublishRequest,
    SupportHubQueue,
    SupportHubReceipt,
    SupportHubReportView,
    SupportHubStatus,
    SupportHubSubmission,
    SupportSettingsUpdateRequest,
    SupportSettingsView,
    User,
)
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user
from app.version import APP_VERSION

router = APIRouter(tags=["support"])

# Burst limit in front of the durable per-address and per-deployment counts.
_PUBLIC_BUCKETS = ProcessLocalTokenBucket(
    max_entries=get_settings().rate_limit_max_buckets,
    idle_ttl_seconds=get_settings().rate_limit_idle_ttl_seconds,
)
_PUBLIC_SUBMITS_PER_MINUTE = 3
_PUBLIC_READS_PER_MINUTE = 30


# --- Owner settings -----------------------------------------------------------------


@router.get("/api/platform/support/settings")
def get_support_settings(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportSettingsView:
    require_platform_owner(actor)
    return _settings_view(store)


@router.patch("/api/platform/support/settings")
def update_support_settings(
    payload: SupportSettingsUpdateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportSettingsView:
    require_platform_owner(actor)
    repository = store.support_ticket_repository
    current = repository.get_settings()
    updates = payload.model_dump(exclude_unset=True)
    token = updates.pop("hub_github_token", None)
    if "ai_model_id" in updates:
        model_id = (updates["ai_model_id"] or "").strip() or None
        if model_id is not None and support_ai.assistant_model(store, model_id) is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Choose an enabled platform model for support assistance.",
            )
        updates["ai_model_id"] = model_id
    if "hub_repository" in updates:
        repository_name = (updates["hub_repository"] or "").strip().strip("/")
        if repository_name and not _valid_repository(repository_name):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Enter the repository as owner/name, for example Aperture-Chat/Aperture-Chat.",
            )
        updates["hub_repository"] = repository_name
    for key in [key for key, value in updates.items() if value is None]:
        updates.pop(key)
    saved = repository.save_settings(
        current.model_copy(update={**updates, "updated_at": clock.now()})
    )
    changed = sorted(key for key in updates if getattr(current, key) != getattr(saved, key))
    if token is not None:
        if token.strip():
            store.set_configuration_secret(
                support_hub.SECRET_NAMESPACE, support_hub.SECRET_RECORD, token.strip()
            )
        else:
            store.delete_configuration_secret(support_hub.SECRET_NAMESPACE, support_hub.SECRET_RECORD)
        changed.append("hub_github_token")
    if changed:
        store.record_audit(
            actor,
            "support.settings_updated",
            "support-settings",
            {
                "changed": changed,
                "upstream_mode": saved.upstream_mode,
                "hub_enabled": saved.hub_enabled,
                "hub_auto_publish": saved.hub_auto_publish,
            },
            runtime_state_changed=False,
        )
    return _settings_view(store)


@router.get("/api/platform/support/hub-status")
def support_hub_status(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportHubStatus:
    require_platform_owner(actor)
    settings = get_settings()
    support_settings = store.support_ticket_repository.get_settings()
    if support_settings.hub_enabled:
        token_set = bool(support_hub.github_token(store))
        return SupportHubStatus(
            hub_url="This deployment",
            reachable=True,
            accepting=True,
            repository=support_hub.hub_repository(support_settings, settings),
            detail=None if token_set else "Add a GitHub token so reports can be published.",
        )
    result = support_upstream.hub_status(settings)
    return SupportHubStatus(hub_url=support_upstream.hub_base_url(settings) or "", **result)


def _settings_view(store: SeedStore) -> SupportSettingsView:
    settings = get_settings()
    support_settings = store.support_ticket_repository.get_settings()
    token = support_hub.github_token(store)
    model = support_ai.assistant_model(store, support_settings.ai_model_id)
    return SupportSettingsView(
        upstream_mode=support_settings.upstream_mode,
        instance_id=support_settings.instance_id,
        ai_model_id=support_settings.ai_model_id,
        ai_model_name=(model.name or model.id) if model is not None else None,
        notify_reporters=support_settings.notify_reporters,
        hub_url=support_upstream.hub_base_url(settings) or "",
        hub_is_self=support_settings.hub_enabled,
        email_configured=mailer.email_configured(store.email_settings),
        hub_enabled=support_settings.hub_enabled,
        hub_repository=support_hub.hub_repository(support_settings, settings),
        hub_auto_publish=support_settings.hub_auto_publish,
        hub_ai_triage=support_settings.hub_ai_triage,
        hub_token_set=bool(token),
        hub_masked_token=mask_secret(token) if token else "",
        model_options=support_ai.model_options(store),
    )


def _valid_repository(value: str) -> bool:
    import re

    return re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value) is not None


# --- Hub console (owner) --------------------------------------------------------------


@router.get("/api/platform/support-hub/reports")
def list_hub_reports(
    report_status: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=300, ge=1, le=2000),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportHubQueue:
    require_platform_owner(actor)
    repository = store.support_ticket_repository
    reports = repository.list_hub_reports(status=report_status, limit=limit)
    instance_counts = repository.hub_instance_counts(report.instance_id for report in reports)
    counts = repository.hub_status_counts()
    counts["all"] = sum(counts.values())
    return SupportHubQueue(
        items=[
            SupportHubReportView.from_report(
                report, instance_report_count=instance_counts.get(report.instance_id, 1)
            )
            for report in reports
        ],
        counts=counts,
    )


@router.get("/api/platform/support-hub/reports/{report_id}/preview")
def preview_hub_report(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, str]:
    require_platform_owner(actor)
    report = _hub_report(store, report_id)
    return {"markdown": support_hub.preview_issue(store, report)}


@router.post("/api/platform/support-hub/reports/{report_id}/publish")
def publish_hub_report(
    report_id: str,
    payload: SupportHubPublishRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportHubReportView:
    require_platform_owner(actor)
    report = _hub_report(store, report_id)
    try:
        published = support_hub.publish(
            store,
            get_settings(),
            report,
            actor_name=actor.display_name,
            title=payload.title,
            body=payload.body,
            labels=payload.labels,
        )
    except support_hub.GitHubError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    support_hub.audit_hub_action(store, actor, "support.hub_report_published", published)
    return _hub_view(store, published)


@router.post("/api/platform/support-hub/reports/{report_id}/link")
def link_hub_report(
    report_id: str,
    payload: SupportHubLinkRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportHubReportView:
    require_platform_owner(actor)
    report = _hub_report(store, report_id)
    try:
        linked = support_hub.link_existing(
            store,
            get_settings(),
            report,
            actor_name=actor.display_name,
            issue_number=payload.issue_number,
            comment=payload.comment,
        )
    except support_hub.GitHubError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    support_hub.audit_hub_action(store, actor, "support.hub_report_linked", linked)
    return _hub_view(store, linked)


@router.post("/api/platform/support-hub/reports/{report_id}/decline")
def decline_hub_report(
    report_id: str,
    payload: SupportHubDeclineRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportHubReportView:
    require_platform_owner(actor)
    report = _hub_report(store, report_id)
    if report.status in ("published", "linked"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This report is already on GitHub; close the issue there instead.",
        )
    declined = support_hub.decline(
        store, report, actor_name=actor.display_name, reason=payload.reason, spam=payload.spam
    )
    support_hub.audit_hub_action(store, actor, "support.hub_report_declined", declined)
    return _hub_view(store, declined)


@router.post("/api/platform/support-hub/reports/{report_id}/requeue")
def requeue_hub_report(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportHubReportView:
    require_platform_owner(actor)
    report = _hub_report(store, report_id)
    try:
        requeued = support_hub.return_to_queue(store, report)
    except support_hub.GitHubError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    support_hub.audit_hub_action(store, actor, "support.hub_report_requeued", requeued)
    return _hub_view(store, requeued)


@router.post("/api/platform/support-hub/reports/{report_id}/triage")
def triage_hub_report(
    report_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportHubReportView:
    require_platform_owner(actor)
    report = _hub_report(store, report_id)
    return _hub_view(store, support_hub.run_triage(store, get_settings(), report))


@router.post("/api/platform/support-hub/sync")
def sync_hub_reports(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> SupportHubQueue:
    require_platform_owner(actor)
    settings = get_settings()
    if not support_hub.github_token(store):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Add a GitHub token before syncing."
        )
    repository = store.support_ticket_repository
    for report in repository.hub_reports_for_sync(checked_before=clock.now(), limit=50):
        support_hub.sync_issue(store, settings, report)
    return list_hub_reports(report_status=None, limit=300, actor=actor, store=store)


@router.post("/api/platform/support-hub/check")
def check_hub_github(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, object]:
    require_platform_owner(actor)
    if not support_hub.github_token(store):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Add a GitHub token first.")
    try:
        with support_hub.github_client(store, get_settings()) as client:
            info = client.repository_info()
    except support_hub.GitHubError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    if not info["has_issues"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Issues are turned off on {info['full_name']}.",
        )
    return {"ok": True, "repository": info["full_name"], "private": info["private"]}


def _hub_report(store: SeedStore, report_id: str):
    report = store.support_ticket_repository.get_hub_report(report_id)
    if report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found.")
    return report


def _hub_view(store: SeedStore, report) -> SupportHubReportView:
    counts = store.support_ticket_repository.hub_instance_counts([report.instance_id])
    return SupportHubReportView.from_report(
        report, instance_report_count=counts.get(report.instance_id, 1)
    )


# --- Public hub API -----------------------------------------------------------------------


@router.get("/api/support-hub/v1/info")
def hub_info(request: Request, store: SeedStore = Depends(get_store)) -> SupportHubInfo:
    _public_limit(request, "info", _PUBLIC_READS_PER_MINUTE)
    support_settings = store.support_ticket_repository.get_settings()
    accepting = support_settings.hub_enabled
    return SupportHubInfo(
        accepting=accepting,
        repository=support_hub.hub_repository(support_settings, get_settings()) if accepting else None,
        version=APP_VERSION,
    )


@router.post("/api/support-hub/v1/reports", status_code=201)
def hub_submit(
    payload: SupportHubSubmission,
    request: Request,
    store: SeedStore = Depends(get_store),
) -> SupportHubReceipt:
    source = _public_limit(request, "submit", _PUBLIC_SUBMITS_PER_MINUTE)
    try:
        return support_hub.receive_submission(store, get_settings(), payload, source=source)
    except support_hub.SupportHubRejected as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise HTTPException(status_code=exc.status_code, detail=str(exc), headers=headers) from exc


@router.get("/api/support-hub/v1/reports/{report_id}")
def hub_report_status(
    report_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
    store: SeedStore = Depends(get_store),
) -> SupportHubPublicStatus:
    _public_limit(request, "status", _PUBLIC_READS_PER_MINUTE)
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    found = support_hub.public_status(store, report_id, token)
    if found is None:
        # Same answer for "unknown id" and "wrong token".
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Report not found.")
    return found


def _public_limit(request: Request, scope: str, per_minute: int) -> str:
    settings = get_settings()
    client_ip = validated_client_ip(
        request.scope, request.headers, settings.rate_limit_trusted_proxy_networks
    )
    allowed, retry_after = _PUBLIC_BUCKETS.consume(f"hub:{scope}:{client_ip}", per_minute)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests. Try again shortly.",
            headers={"Retry-After": str(retry_after)},
        )
    return client_ip
