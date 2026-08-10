"""Request-to-tenant resolution for public, unauthenticated surfaces.

Authenticated routes derive tenant scope from the signed user. Public routes
must resolve it from an exact custom-domain Host or an explicit tenant slug;
insertion order is never a tenant-selection mechanism.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status

from app.models.schemas import Tenant
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore


def resolve_request_tenant(
    request: Request,
    store: SeedStore = Depends(get_store),
) -> Tenant | None:
    """Resolve Host first, then ``X-Aperture-Tenant`` slug, then sole tenant."""
    host_tenant = store.tenant_by_host(request.url.hostname or request.headers.get("host"))
    if host_tenant is not None:
        return host_tenant

    requested_slug = (request.headers.get("x-aperture-tenant") or "").strip()
    if requested_slug:
        tenant = store.tenant_by_slug(requested_slug)
        if tenant is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Unknown tenant slug.",
            )
        return tenant

    if len(store.tenants) == 1:
        return next(iter(store.tenants.values()))
    return None


def require_request_tenant(
    tenant: Tenant | None = Depends(resolve_request_tenant),
) -> Tenant:
    if tenant is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Tenant context is required on this shared host. Use a configured "
                "tenant domain or provide X-Aperture-Tenant with the tenant slug."
            ),
        )
    return tenant
