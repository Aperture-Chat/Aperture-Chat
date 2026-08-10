from __future__ import annotations

import base64
import hashlib
import hmac
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Barrier, Event, Thread

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core import sessions
from app.core.config import get_settings
from app.core.security import SecretVault
from app.core.sessions import SessionClaims, issue_session_token, verify_session_token
from app.db.engine import create_application_engine, upgrade_database
from app.db.orm import RevokedSessionRow
from app.main import app
from app.repositories.application_state import (
    ApplicationStateRepository,
    SessionFamilyConflictError,
    SessionFamilyNotCurrentError,
    SessionRevocationConflictError,
)
from app.repositories.deps import get_store
from app.repositories.seed import SeedStore, SessionUserStateError
from app.routes.dependencies import current_user


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_settings.cache_clear()
    get_store.cache_clear()
    yield
    get_store.cache_clear()
    get_settings.cache_clear()


def _signed_token(payload: dict[str, object], secret: str) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    payload_b64 = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    signature = hmac.new(
        secret.encode(), payload_b64.encode("ascii"), hashlib.sha256
    ).digest()
    signature_b64 = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    return f"v1.{payload_b64}.{signature_b64}"


def _claims(token: str, secret: str) -> SessionClaims:
    claims = verify_session_token(token, secret)
    assert claims is not None
    return claims


def test_strict_session_claims_keep_legacy_tokens_and_precise_new_cutoffs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "session-claims-test-secret-value-1234567890"
    now = 1_800_000_000.125
    monkeypatch.setattr(sessions.time, "time", lambda: now)

    cutoff = int(now * 1000) + 700
    token, expires_at = issue_session_token(
        "user-one",
        secret,
        3600,
        issued_after_ms=cutoff,
    )
    claims = _claims(token, secret)
    assert claims.uid == "user-one"
    assert claims.iat_ms == cutoff + 1
    assert claims.iat_ms > cutoff
    assert claims.exp == expires_at
    assert len(bytes.fromhex(claims.sid)) >= 16

    legacy_sid = "0123456789abcdef"
    legacy = _signed_token(
        {
            "typ": "session",
            "uid": "user-one",
            "sid": legacy_sid,
            "iat": int(now),
            "exp": int(now) + 3600,
        },
        secret,
    )
    legacy_claims = _claims(legacy, secret)
    assert legacy_claims.sid == legacy_sid
    assert legacy_claims.iat_ms == int(now) * 1000

    rotated, _ = issue_session_token(
        "user-one",
        secret,
        3600,
        session_id=legacy_claims.sid,
    )
    assert _claims(rotated, secret).sid == legacy_sid
    assert rotated != legacy


def test_session_claim_parser_rejects_malformed_or_storage_unsafe_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "strict-parser-test-secret-value-1234567890"
    now = 1_800_000_000
    monkeypatch.setattr(sessions.time, "time", lambda: float(now))
    base: dict[str, object] = {
        "typ": "session",
        "uid": "user-one",
        "sid": "0123456789abcdef",
        "iat": now,
        "iat_ms": now * 1000 + 123,
        "exp": now + 3600,
    }
    malformed = [
        {**base, "uid": ""},
        {**base, "uid": " user-one"},
        {**base, "uid": "u" * 256},
        {**base, "sid": ""},
        {**base, "sid": "0123456789abcdef "},
        {**base, "sid": "s" * 129},
        {**base, "iat": True},
        {**base, "iat": -1},
        {**base, "iat_ms": True},
        {**base, "iat_ms": (now + 1) * 1000},
        {**base, "exp": True},
        {**base, "exp": now},
        {key: value for key, value in base.items() if key != "sid"},
        {key: value for key, value in base.items() if key != "iat"},
    ]
    for payload in malformed:
        assert verify_session_token(_signed_token(payload, secret), secret) is None

    expires_now = {**base, "iat": now - 1, "iat_ms": (now - 1) * 1000, "exp": now}
    assert verify_session_token(_signed_token(expires_now, secret), secret) is None


def test_repository_session_current_boundary_and_strict_same_ms_revocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    repository = store.application_state_repository
    user = store.users["user-owner"]
    secret = get_settings().secret_key
    fixed_ms = 1_800_000_000_500
    monkeypatch.setattr(sessions.time, "time", lambda: fixed_ms / 1000)

    first_cutoff = store.advance_user_session_watermark(
        user.id,
        user.tenant_id,
        reason="first-revoke-all",
        updated_by=user.id,
        issued_before_ms=fixed_ms,
        expected_user=user,
    )
    assert first_cutoff == fixed_ms
    token, _ = store.issue_session_token_for_user(
        user,
        secret,
        3600,
    )
    claims = _claims(token, secret)
    assert claims.iat_ms == first_cutoff + 1
    assert repository.session_is_current(
        sid=claims.sid,
        user_id=claims.uid,
        issued_at_ms=claims.iat_ms,
    )

    second_cutoff = store.advance_user_session_watermark(
        user.id,
        user.tenant_id,
        reason="second-revoke-all",
        updated_by=user.id,
        issued_before_ms=fixed_ms,
        expected_user=user,
    )
    assert second_cutoff == claims.iat_ms
    assert not repository.session_is_current(
        sid=claims.sid,
        user_id=claims.uid,
        issued_at_ms=claims.iat_ms,
    )
    with pytest.raises(SessionUserStateError):
        store.issue_session_token_for_user(
            user,
            secret,
            3600,
            session_id=claims.sid,
            presented_claims=claims,
        )
    assert repository.session_is_current(
        sid="different-current-sid",
        user_id=claims.uid,
        issued_at_ms=second_cutoff + 1,
    )


@pytest.mark.parametrize("_iteration", range(10))
def test_strict_watermark_advances_once_per_concurrent_revocation(
    _iteration: int,
) -> None:
    first = get_store().application_state_repository
    second = ApplicationStateRepository(first.engine)
    try:
        assert (
            first.advance_session_issued_before_ms_strict(
                "user-strict-race",
                "tenant-example",
                10_000,
                reason="initial-revocation",
            )
            == 10_000
        )
        repositories = [first, second] * 4
        with ThreadPoolExecutor(max_workers=8) as executor:
            advanced = list(
                executor.map(
                    lambda repository: repository.advance_session_issued_before_ms_strict(
                        "user-strict-race",
                        "tenant-example",
                        10_000,
                        reason="concurrent-revocation",
                    ),
                    repositories,
                )
            )
        assert sorted(advanced) == list(range(10_001, 10_009))
        assert first.get_session_issued_before_ms("user-strict-race") == 10_008
    finally:
        second.close()


def test_family_registration_rejects_existing_family_at_user_cutoff() -> None:
    repository = get_store().application_state_repository
    repository.register_session_family(
        sid="family-watermark-order",
        user_id="user-watermark-order",
        tenant_id="tenant-example",
        expires_at=3_600,
        issued_at_ms=2_000,
    )
    repository.advance_session_issued_before_ms_strict(
        "user-watermark-order",
        "tenant-example",
        2_000,
        reason="admin-revoke",
    )
    with pytest.raises(SessionFamilyNotCurrentError):
        repository.register_session_family(
            sid="family-watermark-order",
            user_id="user-watermark-order",
            tenant_id="tenant-example",
            expires_at=7_200,
            issued_at_ms=2_000,
        )


def test_family_registration_and_cutoff_are_safe_across_two_engines(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite+pysqlite:///{tmp_path / 'family-race.sqlite3'}"
    first_engine = create_application_engine(database_url)
    second_engine = create_application_engine(database_url)
    upgrade_database(first_engine)
    first = ApplicationStateRepository(first_engine)
    second = ApplicationStateRepository(second_engine)
    barrier = Barrier(2)
    try:
        first.advance_session_issued_before_ms(
            "user-family-race",
            "tenant-example",
            100,
            reason="initial-cutoff",
        )

        def register() -> bool:
            barrier.wait()
            try:
                first.register_session_family(
                    sid="family-two-engine-race",
                    user_id="user-family-race",
                    tenant_id="tenant-example",
                    expires_at=3_600,
                    issued_at_ms=200,
                )
            except SessionFamilyNotCurrentError:
                return False
            return True

        def revoke() -> int:
            barrier.wait()
            return second.advance_session_issued_before_ms_strict(
                "user-family-race",
                "tenant-example",
                200,
                reason="concurrent-admin-revoke",
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            registered_future = executor.submit(register)
            revoked_future = executor.submit(revoke)
            registered = registered_future.result()
            cutoff = revoked_future.result()

        assert cutoff >= 200
        assert not first.session_is_current(
            sid="family-two-engine-race",
            user_id="user-family-race",
            issued_at_ms=200,
            expires_at=3_600,
            tenant_id="tenant-example",
        )
        if registered:
            assert first.get_session_family("family-two-engine-race") is not None
    finally:
        first.close()
        second.close()


@pytest.mark.parametrize("_iteration", range(5))
def test_two_engine_rotation_and_logout_linearize_on_same_family_row(
    tmp_path: Path,
    _iteration: int,
) -> None:
    database_url = f"sqlite+pysqlite:///{tmp_path / 'family-logout-race.sqlite3'}"
    first_engine = create_application_engine(database_url)
    second_engine = create_application_engine(database_url)
    upgrade_database(first_engine)
    first = ApplicationStateRepository(first_engine)
    second = ApplicationStateRepository(second_engine)
    barrier = Barrier(2)
    revoked_at = datetime(2026, 7, 20, 14, 0, tzinfo=UTC)
    try:
        first.register_session_family(
            sid="family-register-revoke-race",
            user_id="user-family-race",
            tenant_id="tenant-example",
            expires_at=200,
            issued_at_ms=100_000,
        )

        def rotate() -> bool:
            barrier.wait()
            try:
                first.register_session_family(
                    sid="family-register-revoke-race",
                    user_id="user-family-race",
                    tenant_id="tenant-example",
                    expires_at=400,
                    issued_at_ms=101_000,
                    predecessor_expires_at=200,
                )
            except SessionFamilyNotCurrentError:
                return False
            return True

        def logout() -> None:
            barrier.wait()
            second.revoke_session_family(
                sid="family-register-revoke-race",
                user_id="user-family-race",
                tenant_id="tenant-example",
                issued_at=100,
                expires_at=200,
                revoked_at=revoked_at,
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            rotated_future = executor.submit(rotate)
            logout_future = executor.submit(logout)
            rotated = rotated_future.result()
            logout_future.result()

        family = first.get_session_family("family-register-revoke-race")
        assert family is not None and family.revoked_at == revoked_at
        assert family.max_expires_at == (400 if rotated else 200)
        with pytest.raises(SessionFamilyNotCurrentError):
            first.register_session_family(
                sid=family.sid,
                user_id=family.user_id,
                tenant_id=family.tenant_id,
                expires_at=500,
                issued_at_ms=102_000,
                predecessor_expires_at=400,
            )

        removed_early = first.purge_expired_sessions(200)
        if rotated:
            assert removed_early == 0
            assert first.get_session_family(family.sid) is not None
            assert first.is_session_revoked(family.sid)
            assert first.purge_expired_sessions(400) == 1
        else:
            assert removed_early == 1
    finally:
        first.close()
        second.close()


@pytest.mark.parametrize("_iteration", range(5))
def test_concurrent_same_claim_logout_is_idempotent_across_two_engines(
    tmp_path: Path,
    _iteration: int,
) -> None:
    database_url = f"sqlite+pysqlite:///{tmp_path / 'family-idempotent.sqlite3'}"
    first_engine = create_application_engine(database_url)
    second_engine = create_application_engine(database_url)
    upgrade_database(first_engine)
    first = ApplicationStateRepository(first_engine)
    second = ApplicationStateRepository(second_engine)
    barrier = Barrier(2)
    revoked_at = datetime(2026, 7, 20, 15, 0, tzinfo=UTC)

    def revoke(repository: ApplicationStateRepository) -> datetime:
        barrier.wait()
        row = repository.revoke_session_family(
            sid="family-concurrent-idempotent",
            user_id="user-family-race",
            tenant_id="tenant-example",
            issued_at=100,
            expires_at=200,
            revoked_at=revoked_at,
        )
        return row.revoked_at

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(revoke, (first, second)))
        assert results == [revoked_at, revoked_at]
        family = first.get_session_family("family-concurrent-idempotent")
        assert family is not None and family.legacy_unbounded is True
        assert family.revoked_by_issued_at == 100
        assert family.revoked_by_expires_at == 200
        with pytest.raises(SessionRevocationConflictError):
            first.revoke_session_family(
                sid=family.sid,
                user_id=family.user_id,
                tenant_id=family.tenant_id,
                issued_at=101,
                expires_at=200,
                revoked_at=revoked_at,
            )
    finally:
        first.close()
        second.close()


def test_public_revoke_quarantines_untracked_family_and_collisions_roll_back() -> None:
    repository = get_store().application_state_repository
    repository.revoke_session(
        sid="public-revoke-ledger",
        user_id="user-owner",
        tenant_id=None,
        issued_at=100,
        expires_at=200,
    )
    public_family = repository.get_session_family("public-revoke-ledger")
    assert public_family is not None
    assert public_family.legacy_unbounded is True
    assert public_family.revoked_at is not None

    repository.register_session_family(
        sid="family-collision-rollback",
        user_id="user-owner",
        tenant_id=None,
        expires_at=200,
        issued_at_ms=100_000,
    )
    with pytest.raises(SessionFamilyConflictError):
        repository.register_session_family(
            sid="family-collision-rollback",
            user_id="different-user",
            tenant_id=None,
            expires_at=300,
            issued_at_ms=101_000,
        )
    with pytest.raises(SessionFamilyConflictError):
        repository.revoke_session_family(
            sid="family-collision-rollback",
            user_id="user-owner",
            tenant_id=None,
            issued_at=100,
            expires_at=300,
        )
    unchanged = repository.get_session_family("family-collision-rollback")
    assert unchanged is not None
    assert unchanged.user_id == "user-owner"
    assert unchanged.max_expires_at == 200
    assert unchanged.revoked_at is None
    assert not repository.is_session_revoked(unchanged.sid)


def test_repository_revocation_is_idempotent_and_rejects_claim_collisions() -> None:
    repository = get_store().application_state_repository
    revoked_at = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)
    original = {
        "sid": "session-claim-binding",
        "user_id": "user-owner",
        "tenant_id": None,
        "issued_at": 1_800_000_000,
        "expires_at": 1_800_003_600,
    }
    first = repository.revoke_session(
        **original,
        revoked_at=revoked_at,
        reason="first-reason",
    )
    repeated = repository.revoke_session(
        **original,
        revoked_at=datetime(2026, 7, 20, 13, 0, tzinfo=UTC),
        reason="retry-reason",
    )
    assert repeated.revoked_at == first.revoked_at == revoked_at
    assert repeated.reason == first.reason == "first-reason"

    collisions = [
        {**original, "user_id": "different-user"},
        {**original, "tenant_id": "different-tenant"},
        {**original, "issued_at": original["issued_at"] + 1},
        {**original, "expires_at": original["expires_at"] + 1},
    ]
    for conflicting in collisions:
        with pytest.raises(SessionRevocationConflictError):
            repository.revoke_session(**conflicting)
        stored = repository.run_transaction(
            lambda session: session.get(RevokedSessionRow, original["sid"])
        )
        assert stored is not None
        assert stored.user_id == original["user_id"]
        assert stored.tenant_id == original["tenant_id"]
        assert stored.issued_at == original["issued_at"]
        assert stored.expires_at == original["expires_at"]
        assert stored.revoked_at == revoked_at
        assert stored.reason == "first-reason"


def test_repository_session_current_propagates_database_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repository = get_store().application_state_repository

    def fail_transaction(_operation: object) -> bool:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(repository, "run_transaction", fail_transaction)
    with pytest.raises(RuntimeError, match="database unavailable"):
        repository.session_is_current(
            sid="session-db-failure",
            user_id="user-owner",
            issued_at_ms=1_800_000_000_000,
        )


def test_rotation_preserves_sid_and_logout_revokes_the_whole_session_family() -> None:
    store = get_store()
    secret = get_settings().secret_key
    original, _ = issue_session_token("user-owner", secret, 3600)
    independent, _ = issue_session_token("user-owner", secret, 3600)

    resumed = client.get(
        "/api/auth/session",
        headers={"x-aperture-session": original},
    )
    assert resumed.status_code == 200
    rotated = resumed.json()["session"]["token"]
    assert rotated != original
    assert _claims(rotated, secret).sid == _claims(original, secret).sid
    assert _claims(independent, secret).sid != _claims(rotated, secret).sid

    logged_out = client.post(
        "/api/auth/logout",
        headers={"x-aperture-session": rotated},
    )
    assert logged_out.status_code == 200
    assert logged_out.json() == {"status": "logged_out"}
    assert store.audit_events[-1].action == "auth.logout"
    assert store.application_state_repository.is_session_revoked(_claims(rotated, secret).sid)

    for family_token in (original, rotated):
        rejected = client.get(
            "/api/bootstrap",
            headers={"x-aperture-session": family_token},
        )
        assert rejected.status_code == 401
    assert (
        client.get(
            "/api/bootstrap",
            headers={"x-aperture-session": independent},
        ).status_code
        == 200
    )
    retry = client.post(
        "/api/auth/logout",
        headers={"x-aperture-session": rotated},
    )
    assert retry.status_code == 401
    assert client.post(
        "/api/auth/logout", headers={"x-aperture-user": "user-owner"}
    ).status_code == 401


def test_family_horizon_prevents_later_sibling_resurrection_after_early_purge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    repository = store.application_state_repository
    user = store.users["user-owner"]
    secret = get_settings().secret_key
    now = [1_800_000_000.0]
    monkeypatch.setattr(sessions.time, "time", lambda: now[0])

    original, _ = store.issue_session_token_for_user(user, secret, 5)
    original_claims = _claims(original, secret)
    now[0] += 1
    rotated, _ = store.issue_session_token_for_user(
        user,
        secret,
        30,
        session_id=original_claims.sid,
        presented_claims=original_claims,
    )
    rotated_claims = _claims(rotated, secret)
    assert rotated_claims.exp > original_claims.exp

    store.revoke_session_claims(
        original_claims,
        tenant_id=user.tenant_id,
    )
    family = repository.get_session_family(original_claims.sid)
    assert family is not None
    assert family.max_expires_at == rotated_claims.exp
    assert family.revoked_by_expires_at == original_claims.exp
    assert family.legacy_unbounded is False

    assert repository.purge_expired_sessions(original_claims.exp) == 0
    assert repository.get_session_family(original_claims.sid) is not None
    assert repository.is_session_revoked(original_claims.sid)
    assert not repository.session_is_current(
        sid=rotated_claims.sid,
        user_id=rotated_claims.uid,
        issued_at_ms=rotated_claims.iat_ms,
        expires_at=rotated_claims.exp,
        tenant_id=user.tenant_id,
    )

    assert repository.purge_expired_sessions(rotated_claims.exp) == 1
    assert repository.get_session_family(original_claims.sid) is None
    assert not repository.is_session_revoked(original_claims.sid)


def test_family_horizon_survives_session_ttl_decrease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    repository = store.application_state_repository
    user = store.users["user-owner"]
    secret = get_settings().secret_key
    now = [1_800_000_100.0]
    monkeypatch.setattr(sessions.time, "time", lambda: now[0])

    long_lived, _ = store.issue_session_token_for_user(user, secret, 120)
    long_claims = _claims(long_lived, secret)
    now[0] += 1
    short_lived, _ = store.issue_session_token_for_user(
        user,
        secret,
        5,
        session_id=long_claims.sid,
        presented_claims=long_claims,
    )
    short_claims = _claims(short_lived, secret)
    assert short_claims.exp < long_claims.exp
    family_after_decrease = repository.get_session_family(long_claims.sid)
    assert (
        family_after_decrease is not None
        and family_after_decrease.max_expires_at == long_claims.exp
    )

    now[0] += 1
    longer_again, _ = store.issue_session_token_for_user(
        user,
        secret,
        240,
        session_id=short_claims.sid,
        presented_claims=short_claims,
    )
    longer_again_claims = _claims(longer_again, secret)
    assert longer_again_claims.exp > long_claims.exp

    store.revoke_session_claims(short_claims, tenant_id=user.tenant_id)
    family = repository.get_session_family(long_claims.sid)
    assert family is not None and family.max_expires_at == longer_again_claims.exp
    assert repository.purge_expired_sessions(short_claims.exp) == 0
    assert repository.is_session_revoked(long_claims.sid)


def test_family_revocation_survives_restart_and_early_cleanup(
    tmp_path: Path,
) -> None:
    secret = get_settings().secret_key
    runtime_path = tmp_path / "runtime_state.json"
    store = SeedStore(SecretVault(secret), runtime_state_path=str(runtime_path))
    user = store.users["user-owner"]
    original, _ = store.issue_session_token_for_user(user, secret, 60)
    original_claims = _claims(original, secret)
    rotated, _ = store.issue_session_token_for_user(
        user,
        secret,
        600,
        session_id=original_claims.sid,
        presented_claims=original_claims,
    )
    rotated_claims = _claims(rotated, secret)
    store.revoke_session_claims(original_claims, tenant_id=user.tenant_id)
    store.close()

    restarted = SeedStore(SecretVault(secret), runtime_state_path=str(runtime_path))
    try:
        family = restarted.application_state_repository.get_session_family(
            original_claims.sid
        )
        assert family is not None and family.max_expires_at == rotated_claims.exp
        assert (
            restarted.application_state_repository.purge_expired_sessions(
                original_claims.exp
            )
            == 0
        )
        assert restarted.user_for_session_claims(rotated_claims) is None
    finally:
        restarted.close()


def test_preledger_rotation_stays_legacy_unbounded_and_never_purges() -> None:
    store = get_store()
    repository = store.application_state_repository
    user = store.users["user-owner"]
    secret = get_settings().secret_key
    legacy_token, _ = issue_session_token(user.id, secret, 60)
    legacy_claims = _claims(legacy_token, secret)

    rotated, _ = store.issue_session_token_for_user(
        user,
        secret,
        600,
        session_id=legacy_claims.sid,
        presented_claims=legacy_claims,
    )
    rotated_claims = _claims(rotated, secret)
    family = repository.get_session_family(legacy_claims.sid)
    assert family is not None and family.legacy_unbounded is True
    assert family.max_expires_at == rotated_claims.exp

    store.revoke_session_claims(rotated_claims, tenant_id=user.tenant_id)
    assert repository.purge_expired_sessions(rotated_claims.exp + 10_000) == 0
    assert repository.get_session_family(legacy_claims.sid) is not None
    assert repository.is_session_revoked(legacy_claims.sid)


def test_supplied_session_id_requires_signed_predecessor_claims() -> None:
    store = get_store()
    user = store.users["user-owner"]
    with pytest.raises(ValueError, match="requires the signed predecessor"):
        store.issue_session_token_for_user(
            user,
            get_settings().secret_key,
            60,
            session_id="untrusted-stable-session-id",
        )


def test_admin_revoke_route_rejects_old_token_and_accepts_new_token_above_cutoff() -> None:
    store = get_store()
    user = store.users["user-jane"]
    secret = get_settings().secret_key
    old_token, _ = store.issue_session_token_for_user(user, secret, 3600)
    old_claims = _claims(old_token, secret)

    revoked = client.post(
        f"/api/admin/users/{user.id}/sessions/revoke",
        headers={"x-aperture-user": "user-admin"},
    )
    assert revoked.status_code == 200
    cutoff = revoked.json()["issued_before_ms"]
    assert cutoff >= old_claims.iat_ms
    rejected = client.get(
        "/api/bootstrap",
        headers={"x-aperture-session": old_token},
    )
    assert rejected.status_code == 401
    assert rejected.json() == {
        "detail": "Session is invalid or expired. Sign in again."
    }

    new_token, _ = store.issue_session_token_for_user(user, secret, 3600)
    assert _claims(new_token, secret).iat_ms > cutoff
    assert client.get(
        "/api/bootstrap",
        headers={"x-aperture-session": new_token},
    ).status_code == 200


def test_delete_recreate_restart_never_revives_old_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = get_settings().secret_key
    runtime_path = tmp_path / "runtime_state.json"
    monkeypatch.setattr("app.repositories.review_deps.purge_review_owner", lambda _user_id: None)
    store = SeedStore(
        SecretVault(secret),
        runtime_state_path=str(runtime_path),
    )
    user = store.users["user-jane"]
    old_token, _ = store.issue_session_token_for_user(user, secret, 3600)
    old_claims = _claims(old_token, secret)

    store.delete_user_account(user.id, updated_by="user-admin")
    recreated = user.model_copy(update={"active": True})
    store.users[recreated.id] = recreated
    new_token, _ = store.issue_session_token_for_user(recreated, secret, 3600)
    new_claims = _claims(new_token, secret)
    assert new_claims.iat_ms > old_claims.iat_ms
    with pytest.raises(HTTPException) as rejected_before_restart:
        current_user(old_token, None, store)
    assert rejected_before_restart.value.status_code == 401
    assert current_user(new_token, None, store).id == recreated.id
    store.save_runtime_state(urgent=True)
    store.close()

    restarted = SeedStore(
        SecretVault(secret),
        runtime_state_path=str(runtime_path),
    )
    try:
        with pytest.raises(HTTPException) as rejected_after_restart:
            current_user(old_token, None, restarted)
        assert rejected_after_restart.value.status_code == 401
        assert current_user(new_token, None, restarted).id == recreated.id
        assert (
            restarted.application_state_repository.get_session_issued_before_ms(
                recreated.id
            )
            < new_claims.iat_ms
        )
    finally:
        restarted.close()


def test_session_repository_failures_are_generic_503_and_never_fail_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    secret = get_settings().secret_key
    token, _ = issue_session_token("user-owner", secret, 3600)

    def fail_current(**_kwargs: object) -> bool:
        raise RuntimeError("sensitive database detail")

    monkeypatch.setattr(
        store.application_state_repository,
        "session_is_current",
        fail_current,
    )
    response = client.get(
        "/api/bootstrap",
        headers={"x-aperture-session": token},
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "Session validation is temporarily unavailable."}
    assert "sensitive" not in response.text


def test_logout_and_rotation_repository_failures_report_generic_503(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    secret = get_settings().secret_key
    token, _ = issue_session_token("user-owner", secret, 3600)

    def fail_revoke(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("private revocation detail")

    monkeypatch.setattr(store, "revoke_session_claims", fail_revoke)
    failed_logout = client.post(
        "/api/auth/logout",
        headers={"x-aperture-session": token},
    )
    assert failed_logout.status_code == 503
    assert failed_logout.json() == {
        "detail": "Session revocation is temporarily unavailable."
    }
    assert "private" not in failed_logout.text
    assert client.get(
        "/api/bootstrap", headers={"x-aperture-session": token}
    ).status_code == 200

    monkeypatch.undo()
    store = get_store()
    token, _ = issue_session_token("user-owner", secret, 3600)

    def fail_watermark(_user_id: str) -> int | None:
        raise RuntimeError("private issuance detail")

    monkeypatch.setattr(
        store.application_state_repository,
        "get_session_issued_before_ms",
        fail_watermark,
    )
    failed_rotation = client.get(
        "/api/auth/session",
        headers={"x-aperture-session": token},
    )
    assert failed_rotation.status_code == 503
    assert failed_rotation.json() == {
        "detail": "Session issuance is temporarily unavailable."
    }
    assert "private" not in failed_rotation.text


def test_rotation_losing_revocation_race_returns_generic_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    secret = get_settings().secret_key
    token, _ = issue_session_token("user-owner", secret, 3600)

    def lose_registration(**_kwargs: object) -> None:
        raise SessionFamilyNotCurrentError("internal race detail")

    monkeypatch.setattr(
        store.application_state_repository,
        "register_session_family",
        lose_registration,
    )
    response = client.get(
        "/api/auth/session",
        headers={"x-aperture-session": token},
    )
    assert response.status_code == 401
    assert response.json() == {
        "detail": "Session is invalid or expired. Sign in again."
    }
    assert "internal race" not in response.text


def test_atomic_issuance_serializes_with_deactivation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    repository = store.application_state_repository
    user = store.users["user-jane"]
    secret = get_settings().secret_key
    entered_issuance = Event()
    release_issuance = Event()
    original_get = repository.get_session_issued_before_ms

    def blocked_get(user_id: str) -> int | None:
        entered_issuance.set()
        assert release_issuance.wait(3)
        return original_get(user_id)

    monkeypatch.setattr(repository, "get_session_issued_before_ms", blocked_get)
    issued: list[str] = []
    failures: list[BaseException] = []

    def issue() -> None:
        try:
            issued.append(
                store.issue_session_token_for_user(user, secret, 3600)[0]
            )
        except BaseException as exc:  # noqa: BLE001 - surfaced in the test thread
            failures.append(exc)

    def deactivate() -> None:
        try:
            store.advance_user_session_watermark(
                user.id,
                user.tenant_id,
                reason="race-deactivation",
                updated_by="user-admin",
                expected_user=user,
                deactivate=True,
            )
        except BaseException as exc:  # noqa: BLE001 - surfaced in the test thread
            failures.append(exc)

    issue_thread = Thread(target=issue)
    deactivate_thread = Thread(target=deactivate)
    issue_thread.start()
    assert entered_issuance.wait(3)
    deactivate_thread.start()
    release_issuance.set()
    issue_thread.join(3)
    deactivate_thread.join(3)
    assert not issue_thread.is_alive() and not deactivate_thread.is_alive()
    assert failures == []
    assert user.active is False
    claims = _claims(issued[0], secret)
    assert not repository.session_is_current(
        sid=claims.sid,
        user_id=claims.uid,
        issued_at_ms=claims.iat_ms,
    )
    with pytest.raises(SessionUserStateError):
        store.issue_session_token_for_user(user, secret, 3600)


def test_atomic_issuance_serializes_with_hard_delete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = get_store()
    repository = store.application_state_repository
    user = store.users["user-jane"]
    secret = get_settings().secret_key
    entered_issuance = Event()
    release_issuance = Event()
    original_get = repository.get_session_issued_before_ms

    def blocked_get(user_id: str) -> int | None:
        entered_issuance.set()
        assert release_issuance.wait(3)
        return original_get(user_id)

    monkeypatch.setattr(repository, "get_session_issued_before_ms", blocked_get)
    monkeypatch.setattr("app.repositories.review_deps.purge_review_owner", lambda _user_id: None)
    issued: list[str] = []
    failures: list[BaseException] = []

    def issue() -> None:
        try:
            issued.append(
                store.issue_session_token_for_user(user, secret, 3600)[0]
            )
        except BaseException as exc:  # noqa: BLE001 - surfaced in the test thread
            failures.append(exc)

    def delete() -> None:
        try:
            store.delete_user_account(user.id, updated_by="user-admin")
        except BaseException as exc:  # noqa: BLE001 - surfaced in the test thread
            failures.append(exc)

    issue_thread = Thread(target=issue)
    delete_thread = Thread(target=delete)
    issue_thread.start()
    assert entered_issuance.wait(3)
    delete_thread.start()
    release_issuance.set()
    issue_thread.join(3)
    delete_thread.join(3)
    assert not issue_thread.is_alive() and not delete_thread.is_alive()
    assert failures == []
    assert user.id not in store.users
    claims = _claims(issued[0], secret)
    assert not repository.session_is_current(
        sid=claims.sid,
        user_id=claims.uid,
        issued_at_ms=claims.iat_ms,
    )
    with pytest.raises(SessionUserStateError):
        store.issue_session_token_for_user(user, secret, 3600)
