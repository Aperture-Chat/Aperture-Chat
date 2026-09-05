"""Platform update status and one-click upgrade requests.

Every route requires the platform owner role. Tenant admins never see this
surface: upgrading the deployment is a service-level action, not a tenant one.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.config import get_settings
from app.core.platform_updates import (
    UpdateCheckRateLimited,
    UpdaterBridge,
    UpdaterBusy,
    UpdaterUnavailable,
    build_update_status,
    current_version,
    format_version,
    parse_version,
    reconcile_updater_outcome,
    update_checker,
)
from app.core.policy import require_platform_owner
from app.models.schemas import PlatformUpdateApplyRequest, PlatformUpdateStatus, User
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/platform/updates", tags=["platform-owner"])


@router.get("")
def platform_update_status(
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> PlatformUpdateStatus:
    require_platform_owner(actor)
    settings = get_settings()
    reconcile_updater_outcome(store, settings)
    return build_update_status(settings)


@router.post("/check")
def check_for_platform_updates(
    actor: User = Depends(current_user),
) -> PlatformUpdateStatus:
    require_platform_owner(actor)
    settings = get_settings()
    if not settings.platform_update_check_enabled:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Release checks are disabled for this deployment.",
        )
    try:
        update_checker.refresh(settings, force=True)
    except UpdateCheckRateLimited as exc:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)) from exc
    return build_update_status(settings, refresh=False)


@router.post("/apply", status_code=status.HTTP_202_ACCEPTED)
def apply_platform_update(
    payload: PlatformUpdateApplyRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> PlatformUpdateStatus:
    require_platform_owner(actor)
    settings = get_settings()
    target = parse_version(payload.target_version)
    if target is None:
        raise HTTPException(
            status_code=422,
            detail="target_version must be a release version such as v1.2.3.",
        )
    target_version = format_version(target)
    running = current_version(settings)
    update_status = build_update_status(settings)
    if not update_status.update_available:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This deployment is already on the newest release ({running}).",
        )
    if target_version not in {release.version for release in update_status.releases}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{target_version} is not a published release newer than {running}.",
        )
    bridge = UpdaterBridge(settings.platform_updater_state_dir)
    try:
        request_id = bridge.write_request(
            target_version=target_version,
            previous_version=running,
            requested_by=actor.id,
        )
    except UpdaterUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except UpdaterBusy as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The updater request could not be written. Check the shared state volume.",
        ) from exc
    store.record_audit(
        actor,
        "platform.update_requested",
        target_version,
        {
            "request_id": request_id,
            "from_version": running,
            "to_version": target_version,
        },
    )
    return build_update_status(settings, refresh=False)
