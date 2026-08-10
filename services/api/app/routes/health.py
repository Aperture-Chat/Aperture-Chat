from fastapi import APIRouter

from app.core import clock

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "aperture-api"}


@router.get("/api/time")
def server_time() -> dict[str, object]:
    """Authoritative platform time. Clients read this rather than trusting the
    local device clock, so scheduling and run-time metadata stay consistent."""
    return {
        "iso": clock.now_iso(),
        "unix": clock.now_unix(),
        "timezone": "UTC",
    }
