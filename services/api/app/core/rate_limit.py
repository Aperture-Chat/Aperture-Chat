"""Bounded, process-local request rate limiting.

Each API process owns an independent set of token buckets. The configured
limits are therefore honest per-process controls, not cluster-wide quotas; a
multi-worker deployment needs a shared gateway or distributed limiter for a
global cap. Every bucket starts full, so the configured per-minute capacity is
also the maximum immediate burst, then tokens refill continuously.
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Collection
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network, ip_address
from typing import Protocol

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.config import Settings
from app.core.sessions import SessionClaims, verify_session_token


logger = logging.getLogger("aperture.rate_limit")


IpAddress = IPv4Address | IPv6Address
IpNetwork = IPv4Network | IPv6Network
TrustedProxy = IpAddress | IpNetwork


class _ApiKeyStore(Protocol):
    def user_for_session_claims(self, claims: SessionClaims): ...

    def user_for_api_key(
        self,
        secret_value: str,
        *,
        touch_last_used: bool = True,
    ): ...


@dataclass(frozen=True, slots=True)
class EndpointRateLimit:
    name: str
    per_minute: int
    route_key: str


@dataclass(slots=True)
class _Bucket:
    tokens: float
    updated_at: float
    last_seen_at: float


class ProcessLocalTokenBucket:
    """Thread-safe bounded token buckets sharing one injected monotonic clock."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_entries: int = 10_000,
        idle_ttl_seconds: float = 300.0,
    ) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be positive")
        if idle_ttl_seconds <= 0:
            raise ValueError("idle_ttl_seconds must be positive")
        self._clock = clock
        self._max_entries = max_entries
        self._idle_ttl_seconds = idle_ttl_seconds
        self._buckets: OrderedDict[str, _Bucket] = OrderedDict()
        self._lock = threading.Lock()
        self._next_prune_at = 0.0

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._buckets)

    def consume(self, key: str, per_minute: int) -> tuple[bool, int]:
        """Consume one token and return ``(allowed, retry_after_seconds)``."""
        if per_minute <= 0:
            return True, 0
        now = self._clock()
        with self._lock:
            if now >= self._next_prune_at or len(self._buckets) >= self._max_entries:
                self._prune_locked(now)

            bucket = self._buckets.get(key)
            if bucket is None:
                if len(self._buckets) >= self._max_entries:
                    self._buckets.popitem(last=False)
                self._buckets[key] = _Bucket(
                    tokens=float(per_minute - 1),
                    updated_at=now,
                    last_seen_at=now,
                )
                return True, 0

            elapsed = max(0.0, now - bucket.updated_at)
            bucket.tokens = min(
                float(per_minute),
                bucket.tokens + elapsed * (per_minute / 60.0),
            )
            bucket.updated_at = max(bucket.updated_at, now)
            bucket.last_seen_at = max(bucket.last_seen_at, now)
            self._buckets.move_to_end(key)
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True, 0

            seconds_per_token = 60.0 / per_minute
            retry_after = max(1, math.ceil((1.0 - bucket.tokens) * seconds_per_token))
            return False, retry_after

    def peek(self, key: str, per_minute: int) -> tuple[bool, int]:
        """Report ``(allowed, retry_after_seconds)`` without spending a token.

        Callers that only charge for some outcomes -- failed sign-ins, say --
        need to know whether a key is exhausted before doing the work that
        decides whether to charge it.
        """
        if per_minute <= 0:
            return True, 0
        now = self._clock()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                return True, 0
            elapsed = max(0.0, now - bucket.updated_at)
            tokens = min(
                float(per_minute),
                bucket.tokens + elapsed * (per_minute / 60.0),
            )
            if tokens >= 1.0:
                return True, 0
            seconds_per_token = 60.0 / per_minute
            return False, max(1, math.ceil((1.0 - tokens) * seconds_per_token))

    def _prune_locked(self, now: float) -> None:
        cutoff = now - self._idle_ttl_seconds
        expired = [key for key, bucket in self._buckets.items() if bucket.last_seen_at <= cutoff]
        for key in expired:
            self._buckets.pop(key, None)
        while len(self._buckets) > self._max_entries:
            self._buckets.popitem(last=False)
        self._next_prune_at = now + min(60.0, self._idle_ttl_seconds / 2.0)


class RateLimitMiddleware:
    """Apply endpoint-class token buckets before protected route handlers run."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        settings: Settings,
        store_factory: Callable[[], _ApiKeyStore] | None = None,
        clock: Callable[[], float] = time.monotonic,
        max_entries: int | None = None,
        idle_ttl_seconds: float | None = None,
        bypass_during_pytest: bool = False,
    ) -> None:
        self.app = app
        self.settings = settings
        self.store_factory = store_factory
        self.bypass_during_pytest = bypass_during_pytest
        self.limiter = ProcessLocalTokenBucket(
            clock=clock,
            max_entries=(
                max_entries if max_entries is not None else settings.rate_limit_max_buckets
            ),
            idle_ttl_seconds=(
                idle_ttl_seconds
                if idle_ttl_seconds is not None
                else settings.rate_limit_idle_ttl_seconds
            ),
        )
        self._trusted_proxies = settings.rate_limit_trusted_proxy_networks

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        if scope["type"] != "http" or (
            self.bypass_during_pytest and os.environ.get("PYTEST_CURRENT_TEST")
        ):
            await self.app(scope, receive, send)
            return

        method = str(scope.get("method") or "GET").upper()
        path = str(scope.get("path") or "/")
        endpoint_limit = classify_endpoint(method, path, self.settings)
        if endpoint_limit is None or endpoint_limit.per_minute == 0:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        identity = None
        if endpoint_limit.name != "scim":
            identity = self._authenticated_identity(
                headers,
                allow_api_key=endpoint_limit.name == "openai",
            )
        if identity is None:
            identity = f"ip:{validated_client_ip(scope, headers, self._trusted_proxies)}"

        key = f"{endpoint_limit.name}:{endpoint_limit.route_key}:{identity}"
        allowed, retry_after = self.limiter.consume(key, endpoint_limit.per_minute)
        if allowed:
            await self.app(scope, receive, send)
            return

        response_headers = {"Retry-After": str(retry_after)}
        if path.startswith("/api/auth"):
            # RateLimitMiddleware intentionally wraps the function-based auth
            # cache guard. A limiter-generated response never reaches that
            # inner middleware, so preserve the auth no-store contract here.
            response_headers["Cache-Control"] = "no-store"
        response = JSONResponse(
            status_code=429,
            content={
                "detail": (
                    f"Rate limit exceeded for {endpoint_limit.name} requests. "
                    "Try again after the Retry-After interval."
                )
            },
            headers=response_headers,
        )
        await response(scope, receive, send)

    def _authenticated_identity(
        self,
        headers: Headers,
        *,
        allow_api_key: bool,
    ) -> str | None:
        authorization = headers.get("authorization") or ""
        if allow_api_key and authorization:
            scheme, separator, credential = authorization.partition(" ")
            if (
                separator
                and scheme.casefold() == "bearer"
                and credential.strip()
                and self.store_factory is not None
            ):
                user = self.store_factory().user_for_api_key(
                    credential.strip(),
                    touch_last_used=False,
                )
                if user is not None:
                    return f"user:{user.id}"
            # OpenAI-compatible route authentication also gives any presented
            # Authorization value precedence over browser/dev credentials.
            return None

        session_token = (headers.get("x-aperture-session") or "").strip()
        if session_token and self.store_factory is not None:
            claims = verify_session_token(session_token, self.settings.secret_key)
            if claims is not None:
                try:
                    user = self.store_factory().user_for_session_claims(claims)
                except Exception:  # noqa: BLE001 - the route owns reporting repository failures
                    logger.warning(
                        "Signed-session rate-limit classification failed; using the client IP.",
                        exc_info=True,
                    )
                else:
                    if user is not None:
                        return f"user:{user.id}"

        # The unsigned header is intentionally usable only in the local/dev
        # posture where the authentication dependency accepts it too. Validate
        # the referenced user rather than trusting arbitrary header contents.
        if (
            not session_token
            and self.settings.is_local_environment
            and self.settings.dev_header_auth_enabled
        ):
            user_id = (headers.get("x-aperture-user") or "").strip()
            if user_id and self.store_factory is not None:
                store = self.store_factory()
                user = getattr(store, "users", {}).get(user_id)
                if user is not None and user.active:
                    return f"user:{user.id}"
        return None


def classify_endpoint(
    method: str,
    path: str,
    settings: Settings,
) -> EndpointRateLimit | None:
    """Return the bounded policy and normalized route key for one request."""
    if method.upper() == "OPTIONS":
        return None

    if path.startswith("/api/auth/"):
        route_key = path
        if path.startswith("/api/auth/sso/") and path.endswith("/authorize"):
            route_key = "/api/auth/sso/:config/authorize"
        # Unauthenticated sign-in traffic falls back to an address bucket, and
        # behind a reverse proxy that address is shared by every user. Brute
        # force is bounded per account inside the route instead, so this only
        # needs to stop a single-source flood.
        per_minute = settings.auth_rate_limit_per_minute
        if per_minute:
            per_minute *= settings.auth_ip_rate_limit_multiplier
        return EndpointRateLimit("auth", per_minute, route_key)

    if path in {"/api/bootstrap", "/api/me"}:
        return EndpointRateLimit("bootstrap", settings.auth_rate_limit_per_minute, path)

    if path == "/scim/v2" or path.startswith("/scim/v2/"):
        parts = [part for part in path.split("/") if part]
        resource = parts[2] if len(parts) >= 3 else "root"
        suffix = "/:id" if len(parts) >= 4 else ""
        route_key = f"/scim/v2/{resource}{suffix}"
        return EndpointRateLimit("scim", settings.auth_rate_limit_per_minute, route_key)

    if path == "/api/chat/complete":
        return EndpointRateLimit("chat", settings.chat_rate_limit_per_minute, path)
    if path == "/api/chat/transcriptions":
        return EndpointRateLimit("transcription", settings.chat_rate_limit_per_minute, path)
    if path == "/v1" or path.startswith("/v1/"):
        return EndpointRateLimit("openai", settings.chat_rate_limit_per_minute, "/v1")
    if path == "/api/review" or path.startswith("/api/review/"):
        return EndpointRateLimit("review", settings.chat_rate_limit_per_minute, "/api/review")
    if method.upper() == "POST" and (path == "/api/images" or path.startswith("/api/images/")):
        return EndpointRateLimit("image", settings.chat_rate_limit_per_minute, "/api/images")
    return None


def validated_client_ip(
    scope: Scope,
    headers: Headers,
    trusted_proxies: Collection[TrustedProxy],
) -> str:
    """Resolve a client IP without trusting forwarded headers from arbitrary peers."""
    client = scope.get("client")
    peer_raw = str(client[0]) if client else ""
    try:
        peer = ip_address(peer_raw)
    except ValueError:
        return "unknown"
    if not _address_is_trusted(peer, trusted_proxies):
        return str(peer)

    forwarded_raw = headers.get("x-forwarded-for") or ""
    if not forwarded_raw:
        return str(peer)
    forwarded: list[IpAddress] = []
    try:
        for value in forwarded_raw.split(",")[-20:]:
            forwarded.append(ip_address(value.strip()))
    except ValueError:
        return str(peer)

    # Walk from the socket peer toward the client and return the nearest
    # untrusted address. This rejects spoofed left-most entries when a trusted
    # proxy appends the actual peer address.
    for candidate in reversed([*forwarded, peer]):
        if not _address_is_trusted(candidate, trusted_proxies):
            return str(candidate)
    return str(peer)


def _address_is_trusted(address: IpAddress, entries: Collection[TrustedProxy]) -> bool:
    for entry in entries:
        if isinstance(entry, (IPv4Address, IPv6Address)):
            if address == entry:
                return True
        elif address.version == entry.version and address in entry:
            return True
    return False
