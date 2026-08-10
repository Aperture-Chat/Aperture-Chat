"""Shared egress guard for outbound HTTP to operator/tenant-supplied URLs.

Every sink that fetches or posts credentials to an admin-configured URL
(web search, OIDC discovery/token, cloud connectors, knowledge web sources)
runs the target through :func:`validate_public_url` first. The guard blocks SSRF
into cloud-metadata and link-local ranges unconditionally, and blocks
RFC1918/loopback in deployed environments.

Owner escape hatch: in a local environment (``settings.is_local_environment``)
or for hosts on the operator allowlist (``APERTURE_EGRESS_ALLOW_HOSTS``),
private and loopback targets are permitted so the owner's local SearXNG and
localhost connector tests keep working.

Mock-friendliness: in a permissive (local/allowlisted) context the guard is
best-effort — if DNS resolution fails it allows the request rather than
raising, so tests that point at unresolvable names (``example.test``,
``searxng.local``) and inject an httpx transport are never blocked before the
mock is reached. In a deployed context a resolution failure fails closed.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

import httpx

from app.core.config import get_settings


class EgressBlocked(Exception):
    """Raised when an outbound URL is not permitted by the egress policy.

    The message is safe to surface to an admin; it never contains a secret.
    """


# Ranges blocked in EVERY environment, including local — these are never a
# legitimate egress target. Loopback and RFC1918/ULA are NOT here: they are
# "private" (see _is_private) and only blocked when allow_private is False, so
# the owner's localhost SearXNG/connectors keep working in local env.
_ALWAYS_BLOCKED = (
    ipaddress.ip_network("169.254.0.0/16"),  # link-local incl. cloud metadata
    ipaddress.ip_network("fe80::/10"),  # IPv6 link-local
    ipaddress.ip_network("::ffff:169.254.0.0/112"),  # v4-mapped metadata
    ipaddress.ip_network("100.64.0.0/10"),  # CGNAT (cloud internal)
)


def _always_blocked_addr(ip: ipaddress._BaseAddress) -> bool:
    # NOTE: deliberately does NOT use ip.is_reserved — that flags IPv6 loopback
    # (::1, in the reserved ::/8) which must remain a permitted private target.
    if ip.is_link_local or ip.is_multicast or ip.is_unspecified:
        return True
    return any(ip in net for net in _ALWAYS_BLOCKED)


def _is_always_blocked(ip: ipaddress._BaseAddress) -> bool:
    if _always_blocked_addr(ip):
        return True
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped is not None and _always_blocked_addr(mapped)


def _is_private(ip: ipaddress._BaseAddress) -> bool:
    if ip.is_loopback or ip.is_private:
        return True
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None and (mapped.is_loopback or mapped.is_private):
        return True
    return False


def _resolve(host: str) -> list[ipaddress._BaseAddress]:
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    addrs: list[ipaddress._BaseAddress] = []
    for info in infos:
        raw = info[4][0].split("%", 1)[0]  # strip IPv6 zone id
        try:
            addrs.append(ipaddress.ip_address(raw))
        except ValueError:
            continue
    return addrs


def validate_public_url(url: str, *, allow_private: bool | None = None) -> str:
    """Return ``url`` unchanged if egress is permitted, else raise :class:`EgressBlocked`.

    ``allow_private`` defaults to ``settings.is_local_environment`` OR the host
    being on the operator allowlist. When permissive, private/loopback targets
    are allowed and DNS failures are tolerated (best-effort). Metadata and
    link-local are blocked in all modes when the address is known.
    """
    parsed = urlsplit((url or "").strip())
    if parsed.scheme not in ("http", "https"):
        raise EgressBlocked(f"URL scheme '{parsed.scheme or 'none'}' is not allowed; use http or https.")
    host = parsed.hostname
    if not host:
        raise EgressBlocked("URL has no host to connect to.")

    settings = get_settings()
    host_allowlisted = host.lower() in settings.egress_allow_host_set
    if allow_private is None:
        allow_private = settings.is_local_environment or host_allowlisted

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None

    if literal is not None:
        addrs = [literal]
    else:
        try:
            addrs = _resolve(host)
        except socket.gaierror as exc:
            if allow_private:
                return url
            raise EgressBlocked(f"Could not resolve host '{host}'.") from exc
        if not addrs:
            if allow_private:
                return url
            raise EgressBlocked(f"Host '{host}' did not resolve to any address.")

    for ip in addrs:
        if _is_always_blocked(ip):
            raise EgressBlocked(
                f"Host '{host}' resolves to a blocked address ({ip}); "
                "cloud-metadata and link-local ranges are never reachable."
            )
        if not allow_private and _is_private(ip):
            raise EgressBlocked(
                f"Host '{host}' resolves to a private/loopback address ({ip}); "
                "reaching internal hosts is disabled in this environment. Add it "
                "to APERTURE_EGRESS_ALLOW_HOSTS if this is intentional."
            )
    return url


def validate_request_hook(request: httpx.Request) -> None:
    """httpx request event hook that re-validates every hop, including redirects.

    Install via ``event_hooks={"request": [validate_request_hook]}`` on any client
    that uses ``follow_redirects=True`` so a 3xx to a metadata/internal address is
    blocked, not just the initial URL. Raising here aborts the request.
    """
    validate_public_url(str(request.url))


# Convenience for callers so they don't have to spell out the event hook.
REDIRECT_GUARD_HOOKS = {"request": [validate_request_hook]}
