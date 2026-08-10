from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from ipaddress import ip_address, ip_network

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

from app.core.config import Settings
from app.core.rate_limit import (
    ProcessLocalTokenBucket,
    RateLimitMiddleware,
    classify_endpoint,
    validated_client_ip,
)
from app.core.sessions import SessionClaims, issue_session_token


class ManualClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class FakeUser:
    id: str
    active: bool = True


class FakeStore:
    def __init__(self) -> None:
        self.users = {
            "dev-user-a": FakeUser("dev-user-a"),
            "dev-user-b": FakeUser("dev-user-b"),
            "user-a": FakeUser("user-a"),
            "user-b": FakeUser("user-b"),
            "inactive-user": FakeUser("inactive-user", active=False),
            "revoked-user": FakeUser("revoked-user"),
        }
        self._api_key_users = {
            "key-a": FakeUser("api-user-a"),
            "key-b": FakeUser("api-user-b"),
        }
        self.api_key_touch_flags: list[bool] = []
        self.revoked_session_users = {"revoked-user"}
        self.session_claims_checks = 0
        self.session_claims_seen: list[SessionClaims] = []
        self.session_lookup_error: Exception | None = None

    def user_for_session_claims(self, claims: SessionClaims) -> FakeUser | None:
        self.session_claims_checks += 1
        self.session_claims_seen.append(claims)
        if self.session_lookup_error is not None:
            raise self.session_lookup_error
        user_id = getattr(claims, "uid", None)
        if not isinstance(user_id, str) or user_id in self.revoked_session_users:
            return None
        user = self.users.get(user_id)
        return user if user is not None and user.active else None

    def user_for_api_key(
        self,
        secret_value: str,
        *,
        touch_last_used: bool = True,
    ) -> FakeUser | None:
        self.api_key_touch_flags.append(touch_last_used)
        return self._api_key_users.get(secret_value)


def _settings(
    *,
    auth_limit: int = 2,
    chat_limit: int = 2,
    environment: str = "production",
    trusted_proxies: str = "",
    auth_ip_multiplier: int = 1,
) -> Settings:
    # These cases exercise the address bucket itself, so they pin the sign-in
    # multiplier to 1. Its production value is covered separately.
    return Settings(
        environment=environment,
        secret_key="rate-limit-test-signing-secret-value-1234567890",
        auth_rate_limit_per_minute=auth_limit,
        chat_rate_limit_per_minute=chat_limit,
        rate_limit_trusted_proxies=trusted_proxies,
        auth_ip_rate_limit_multiplier=auth_ip_multiplier,
    )


def _client(
    settings: Settings,
    clock: ManualClock,
    *,
    store: FakeStore | None = None,
    store_factory: Callable[[], FakeStore] | None = None,
    cors_origin: str | None = None,
    downstream_status: int = 200,
) -> TestClient:
    app = FastAPI()

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def ok(path: str) -> JSONResponse:
        return JSONResponse(status_code=downstream_status, content={"path": path})

    app.add_middleware(
        RateLimitMiddleware,
        settings=settings,
        store_factory=store_factory or ((lambda: store) if store is not None else None),
        clock=clock,
        max_entries=8,
        idle_ttl_seconds=60,
        bypass_during_pytest=False,
    )
    if cors_origin is not None:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=[cors_origin],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    return TestClient(app)


def test_token_bucket_threshold_retry_after_and_clock_reset() -> None:
    clock = ManualClock()
    client = _client(_settings(auth_limit=2), clock)

    assert client.get("/api/auth/options").status_code == 200
    assert client.get("/api/auth/options").status_code == 200
    limited = client.get("/api/auth/options")

    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "30"
    assert limited.json() == {
        "detail": (
            "Rate limit exceeded for auth requests. Try again after the Retry-After interval."
        )
    }

    clock.advance(30)
    assert client.get("/api/auth/options").status_code == 200


def test_limiter_generated_mfa_response_is_never_cacheable() -> None:
    client = _client(_settings(auth_limit=1), ManualClock())

    assert client.post("/api/auth/mfa/preauth/verify").status_code == 200
    limited = client.post("/api/auth/mfa/preauth/verify")

    assert limited.status_code == 429
    assert limited.headers["retry-after"] == "60"
    assert limited.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("method", "path", "name", "limit"),
    [
        ("POST", "/api/auth/login", "auth", 10),
        ("GET", "/api/bootstrap", "bootstrap", 10),
        ("POST", "/scim/v2/Users", "scim", 10),
        ("POST", "/api/chat/complete", "chat", 20),
        ("POST", "/v1/chat/completions", "openai", 20),
        ("POST", "/api/chat/transcriptions", "transcription", 20),
        ("POST", "/api/images/generations", "image", 20),
        ("POST", "/api/review/matrices/matrix-1/run", "review", 20),
    ],
)
def test_endpoint_classes_use_expected_default_policy(
    method: str,
    path: str,
    name: str,
    limit: int,
) -> None:
    policy = classify_endpoint(method, path, _settings(auth_limit=10, chat_limit=20))

    assert policy is not None
    assert policy.name == name
    assert policy.per_minute == limit


def test_auth_address_ceiling_scales_so_shared_egress_does_not_lock_users_out() -> None:
    """Everyone behind one proxy shares this bucket, so it must not be the
    per-account limit. Brute force is bounded per email inside the route."""
    settings = _settings(auth_limit=10, chat_limit=20, auth_ip_multiplier=20)

    policy = classify_endpoint("POST", "/api/auth/login", settings)

    assert policy is not None
    assert policy.per_minute == 200

    disabled = classify_endpoint(
        "POST", "/api/auth/login", _settings(auth_limit=0, auth_ip_multiplier=20)
    )
    assert disabled is not None
    assert disabled.per_minute == 0


def test_peek_reports_exhaustion_without_spending_a_token() -> None:
    clock = ManualClock()
    bucket = ProcessLocalTokenBucket(clock=clock)

    assert bucket.peek("k", 2) == (True, 0)
    assert bucket.peek("k", 2) == (True, 0)
    assert bucket.consume("k", 2) == (True, 0)
    assert bucket.consume("k", 2) == (True, 0)

    allowed, retry_after = bucket.peek("k", 2)
    assert allowed is False
    assert retry_after == 30
    # Peeking while exhausted must not extend the lockout.
    assert bucket.peek("k", 2) == (False, 30)

    clock.advance(30)
    assert bucket.peek("k", 2) == (True, 0)


def test_zero_disables_each_endpoint_class() -> None:
    clock = ManualClock()
    client = _client(_settings(auth_limit=0, chat_limit=0), clock)

    for _ in range(25):
        assert client.post("/api/auth/login").status_code == 200
        assert client.post("/api/chat/complete").status_code == 200
        assert client.post("/scim/v2/Users").status_code == 200


def test_signed_sessions_are_isolated_by_stable_user_identity() -> None:
    clock = ManualClock()
    settings = _settings(chat_limit=1)
    store = FakeStore()
    client = _client(settings, clock, store=store)
    token_a, _ = issue_session_token("user-a", settings.secret_key)
    token_b, _ = issue_session_token("user-b", settings.secret_key)

    assert (
        client.post("/api/chat/complete", headers={"x-aperture-session": token_a}).status_code
        == 200
    )
    assert (
        client.post("/api/chat/complete", headers={"x-aperture-session": token_a}).status_code
        == 429
    )
    assert (
        client.post("/api/chat/complete", headers={"x-aperture-session": token_b}).status_code
        == 200
    )
    assert store.session_claims_seen
    assert all(
        all(hasattr(claims, field) for field in ("uid", "sid", "iat", "iat_ms", "exp"))
        for claims in store.session_claims_seen
    )


def test_invalid_revoked_and_inactive_sessions_use_the_ip_bucket() -> None:
    settings = _settings(chat_limit=1)
    rejected_tokens = [
        ("not-a-signed-session", 0),
        (issue_session_token("revoked-user", settings.secret_key)[0], 1),
        (issue_session_token("inactive-user", settings.secret_key)[0], 1),
    ]

    for token, expected_claim_checks in rejected_tokens:
        store = FakeStore()
        client = _client(settings, ManualClock(), store=store)
        first = client.post("/api/chat/complete", headers={"x-aperture-session": token})
        second = client.post("/api/chat/complete")

        assert first.status_code == 200
        assert second.status_code == 429
        assert store.session_claims_checks == expected_claim_checks


def test_rejected_session_never_falls_through_to_unsigned_dev_identity() -> None:
    client = _client(
        _settings(chat_limit=1, environment="local"),
        ManualClock(),
        store=FakeStore(),
    )

    assert (
        client.post(
            "/api/chat/complete",
            headers={
                "x-aperture-session": "invalid-session",
                "x-aperture-user": "dev-user-a",
            },
        ).status_code
        == 200
    )
    assert client.post("/api/chat/complete").status_code == 429


@pytest.mark.parametrize("failure_source", ["factory", "repository"])
def test_session_classification_failure_uses_ip_and_preserves_downstream_503(
    failure_source: str,
) -> None:
    settings = _settings(chat_limit=1)
    token = issue_session_token("user-a", settings.secret_key)[0]
    store = FakeStore()
    factory: Callable[[], FakeStore]

    if failure_source == "factory":

        def factory() -> FakeStore:
            raise RuntimeError("database unavailable")

    else:
        store.session_lookup_error = RuntimeError("database unavailable")

        def repository_store() -> FakeStore:
            return store

        factory = repository_store

    client = _client(
        settings,
        ManualClock(),
        store_factory=factory,
        downstream_status=503,
    )

    response = client.post("/api/chat/complete", headers={"x-aperture-session": token})

    assert response.status_code == 503


def test_validated_api_keys_are_isolated_and_invalid_bearers_fall_back_to_ip() -> None:
    clock = ManualClock()
    store = FakeStore()
    client = _client(_settings(chat_limit=1), clock, store=store)

    assert (
        client.post("/v1/chat/completions", headers={"Authorization": "Bearer key-a"}).status_code
        == 200
    )
    assert (
        client.post("/v1/chat/completions", headers={"Authorization": "Bearer key-a"}).status_code
        == 429
    )
    assert (
        client.post("/v1/chat/completions", headers={"Authorization": "Bearer key-b"}).status_code
        == 200
    )
    assert (
        client.post("/v1/chat/completions", headers={"Authorization": "Bearer fake-1"}).status_code
        == 200
    )
    assert (
        client.post("/v1/chat/completions", headers={"Authorization": "Bearer fake-2"}).status_code
        == 429
    )
    assert store.api_key_touch_flags
    assert not any(store.api_key_touch_flags)


def test_openai_bearer_precedes_session_and_remains_non_touching() -> None:
    clock = ManualClock()
    settings = _settings(chat_limit=1)
    store = FakeStore()
    client = _client(settings, clock, store=store)
    session_token = issue_session_token("user-a", settings.secret_key)[0]

    assert (
        client.post(
            "/v1/chat/completions",
            headers={
                "Authorization": "Bearer key-a",
                "x-aperture-session": session_token,
            },
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/v1/chat/completions",
            headers={"Authorization": "Bearer key-a"},
        ).status_code
        == 429
    )
    assert (
        client.post(
            "/v1/chat/completions",
            headers={"x-aperture-session": session_token},
        ).status_code
        == 200
    )
    assert store.api_key_touch_flags == [False, False]
    assert store.session_claims_checks == 1


def test_deployed_mode_never_trusts_unsigned_user_headers() -> None:
    clock = ManualClock()
    client = _client(_settings(chat_limit=1), clock, store=FakeStore())

    assert (
        client.post("/api/chat/complete", headers={"x-aperture-user": "dev-user-a"}).status_code
        == 200
    )
    assert (
        client.post("/api/chat/complete", headers={"x-aperture-user": "dev-user-b"}).status_code
        == 429
    )


def test_limiter_state_is_bounded_and_idle_buckets_are_pruned() -> None:
    clock = ManualClock()
    limiter = ProcessLocalTokenBucket(clock=clock, max_entries=2, idle_ttl_seconds=5)

    assert limiter.consume("one", 1) == (True, 0)
    assert limiter.consume("two", 1) == (True, 0)
    assert limiter.consume("three", 1) == (True, 0)
    assert limiter.size == 2

    clock.advance(6)
    assert limiter.consume("fresh", 1) == (True, 0)
    assert limiter.size == 1


def test_unclassified_health_static_asset_and_generated_image_reads_are_unlimited() -> None:
    clock = ManualClock()
    client = _client(_settings(auth_limit=1, chat_limit=1), clock)

    for _ in range(5):
        assert client.get("/health").status_code == 200
        assert client.get("/assets/app.js").status_code == 200
        assert client.get("/api/chat/generated-images/image.png").status_code == 200


def test_cors_remains_outermost_for_rate_limit_responses() -> None:
    clock = ManualClock()
    origin = "https://chat.example.test"
    client = _client(_settings(auth_limit=1), clock, cors_origin=origin)

    assert client.get("/api/auth/options", headers={"Origin": origin}).status_code == 200
    limited = client.get("/api/auth/options", headers={"Origin": origin})

    assert limited.status_code == 429
    assert limited.headers["access-control-allow-origin"] == origin


def test_forwarded_client_ip_requires_an_explicitly_trusted_socket_peer() -> None:
    forwarded = Headers({"x-forwarded-for": "192.0.2.99, 198.51.100.20"})
    direct_scope = {"type": "http", "client": ("203.0.113.10", 1234)}
    proxy_scope = {"type": "http", "client": ("10.0.0.55", 1234)}

    # A directly connected client cannot make an arbitrary forwarded value the
    # limiter identity, even when that value looks like a valid public IP.
    assert validated_client_ip(direct_scope, forwarded, ()) == "203.0.113.10"
    assert (
        validated_client_ip(
            proxy_scope,
            forwarded,
            frozenset({ip_address("10.0.0.55")}),
        )
        == "198.51.100.20"
    )
    assert (
        validated_client_ip(
            proxy_scope,
            forwarded,
            (ip_network("10.0.0.0/24"),),
        )
        == "198.51.100.20"
    )


def test_rate_limit_environment_fields_bind_and_validate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("APERTURE_AUTH_RATE_LIMIT_PER_MINUTE", "7")
    monkeypatch.setenv("APERTURE_CHAT_RATE_LIMIT_PER_MINUTE", "13")
    monkeypatch.setenv(
        "APERTURE_RATE_LIMIT_TRUSTED_PROXIES",
        "127.0.0.1,10.20.0.0/16,::1",
    )

    settings = Settings(environment="test", secret_key="test-secret")

    assert settings.auth_rate_limit_per_minute == 7
    assert settings.chat_rate_limit_per_minute == 13
    assert settings.rate_limit_trusted_proxy_networks == (
        ip_network("127.0.0.1/32"),
        ip_network("10.20.0.0/16"),
        ip_network("::1/128"),
    )
