"""Egress guard: SSRF blocking with a local/allowlist escape hatch."""

from __future__ import annotations

import httpx
import pytest

from app.core.config import get_settings
from app.core.net_guard import (
    REDIRECT_GUARD_HOOKS,
    EgressBlocked,
    validate_public_url,
    validate_request_hook,
)


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def _use_production(monkeypatch: pytest.MonkeyPatch, allow_hosts: str = "") -> None:
    monkeypatch.setenv("APERTURE_ENVIRONMENT", "production")
    # Deployed environments require a strong secret or startup fails closed.
    monkeypatch.setenv("APERTURE_SECRET_KEY", "x" * 40)
    if allow_hosts:
        monkeypatch.setenv("APERTURE_EGRESS_ALLOW_HOSTS", allow_hosts)
    get_settings.cache_clear()


def test_cloud_metadata_ip_blocked_in_local() -> None:
    with pytest.raises(EgressBlocked):
        validate_public_url("http://169.254.169.254/latest/meta-data/")


def test_cloud_metadata_ip_blocked_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_production(monkeypatch)
    with pytest.raises(EgressBlocked):
        validate_public_url("http://169.254.169.254/")


def test_loopback_allowed_in_local_env() -> None:
    # The owner runs a local SearXNG/connector on loopback; local must permit it.
    url = "http://127.0.0.1:8080/search"
    assert validate_public_url(url) == url


def test_loopback_blocked_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_production(monkeypatch)
    with pytest.raises(EgressBlocked):
        validate_public_url("http://127.0.0.1:8080/search")


def test_private_ip_blocked_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_production(monkeypatch)
    with pytest.raises(EgressBlocked):
        validate_public_url("https://10.1.2.3/token")


def test_allowlisted_host_permitted_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_production(monkeypatch, allow_hosts="searxng.internal, imanage.on-prem")
    # Allowlisted (and unresolvable) -> tolerated rather than blocked.
    url = "http://searxng.internal/search"
    assert validate_public_url(url) == url


def test_unresolvable_host_blocked_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_production(monkeypatch)
    with pytest.raises(EgressBlocked):
        validate_public_url("http://does-not-exist.invalid/")


def test_non_http_scheme_rejected() -> None:
    with pytest.raises(EgressBlocked):
        validate_public_url("file:///etc/passwd")
    with pytest.raises(EgressBlocked):
        validate_public_url("gopher://example.com/")


def test_https_public_host_is_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_production(monkeypatch)
    monkeypatch.setattr(
        "app.core.net_guard.socket.getaddrinfo",
        lambda *_args, **_kwargs: [
            (2, 1, 6, "", ("93.184.216.34", 0)),
        ],
    )
    url = "https://example.com/resource"
    assert validate_public_url(url) == url


def test_dns_hostname_resolving_to_metadata_is_always_blocked(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.core.net_guard.socket.getaddrinfo",
        lambda *_args, **_kwargs: [
            (2, 1, 6, "", ("93.184.216.34", 0)),
            (2, 1, 6, "", ("169.254.169.254", 0)),
        ],
    )
    with pytest.raises(EgressBlocked, match="blocked address"):
        validate_public_url("https://metadata-alias.example/")


def test_missing_host_rejected() -> None:
    with pytest.raises(EgressBlocked):
        validate_public_url("http:///no-host")


def test_localhost_hostname_allowed_in_local_env() -> None:
    # 'localhost' resolves to 127.0.0.1 AND ::1; both must be permitted locally
    # so the owner's local SearXNG/connectors keep working (regression guard).
    for url in ("http://localhost:8888/search", "http://[::1]:8888/search"):
        assert validate_public_url(url) == url


def test_localhost_hostname_blocked_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_production(monkeypatch)
    for url in ("http://localhost:8888/search", "http://[::1]:8888/search"):
        with pytest.raises(EgressBlocked):
            validate_public_url(url)


def test_request_hook_blocks_metadata_hop() -> None:
    request = httpx.Request("GET", "http://169.254.169.254/latest/meta-data/")
    with pytest.raises(EgressBlocked):
        validate_request_hook(request)


def test_request_hook_allows_a_public_https_request(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_production(monkeypatch)
    monkeypatch.setattr(
        "app.core.net_guard.socket.getaddrinfo",
        lambda *_args, **_kwargs: [
            (2, 1, 6, "", ("93.184.216.34", 0)),
        ],
    )
    validate_request_hook(httpx.Request("GET", "https://example.com/health"))


def test_redirect_to_metadata_is_blocked_by_hook(monkeypatch: pytest.MonkeyPatch) -> None:
    # Even in a deployed env, a public host that 302s to cloud metadata is caught
    # on the redirect hop, not just on the initial URL.
    _use_production(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport, follow_redirects=True, event_hooks=REDIRECT_GUARD_HOOKS) as client:
        with pytest.raises(EgressBlocked):
            client.get("https://issuer.example/redirector")
