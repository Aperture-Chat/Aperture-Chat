from __future__ import annotations

import re


class TenantIdentityError(ValueError):
    """A tenant slug or custom domain cannot be represented canonically."""


def normalize_tenant_slug(value: str) -> str:
    if not isinstance(value, str):
        raise TenantIdentityError("Tenant slug must be a string.")
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if not slug:
        raise TenantIdentityError("Tenant slug must contain at least one letter or number.")
    return slug[:80].rstrip("-")


def require_canonical_tenant_slug(value: str) -> str:
    canonical = normalize_tenant_slug(value)
    if canonical != value:
        raise TenantIdentityError("Tenant slug must already be in canonical lowercase form.")
    return canonical


def normalize_custom_domain(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TenantIdentityError("Custom domain must be a string.")
    domain = value.strip().lower().rstrip(".")
    if not domain:
        return None
    if "://" in domain or "/" in domain or "@" in domain or ":" in domain:
        raise TenantIdentityError(
            "Custom domain must be a hostname without a scheme, path, or port."
        )
    try:
        domain = domain.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise TenantIdentityError("Custom domain is not a valid hostname.") from exc
    if len(domain) > 253 or any(
        not label
        or len(label) > 63
        or re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label) is None
        for label in domain.split(".")
    ):
        raise TenantIdentityError("Custom domain is not a valid hostname.")
    return domain


def require_canonical_custom_domain(value: str | None) -> str | None:
    canonical = normalize_custom_domain(value)
    if canonical != value:
        raise TenantIdentityError(
            "Custom domain must already be a canonical lowercase IDNA hostname."
        )
    return canonical
