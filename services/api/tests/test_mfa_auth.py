from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor

import pyotp
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.repositories.deps import get_store


client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_settings.cache_clear()
    get_store.cache_clear()
    yield
    get_store.cache_clear()
    get_settings.cache_clear()


def _session_headers(token: str) -> dict[str, str]:
    return {"X-Aperture-Session": token}


def _local_user() -> tuple[object, str]:
    store = get_store()
    user = store.users["user-jane"]
    user.email = "jane.mfa@local.invalid"
    user.auth_method = "local"
    password = "correct-mfa-password"
    store.set_password_credential(user.id, password)
    return user, password


def _login(password: str, *, headers: dict[str, str] | None = None):
    return client.post(
        "/api/auth/login",
        headers=headers,
        json={
            "email": "jane.mfa@local.invalid",
            "auth_method": "local",
            "password": password,
        },
    )


def _enroll_local_factor(
    password: str,
    *,
    tenant_headers: dict[str, str] | None = None,
) -> tuple[str, list[str], str, int]:
    primary = _login(password, headers=tenant_headers)
    assert primary.status_code == 200, primary.text
    enrollment = client.post(
        "/api/auth/mfa/enroll",
        headers=_session_headers(primary.json()["session"]["token"]),
        json={"current_password": password},
    )
    assert enrollment.status_code == 201, enrollment.text
    secret = enrollment.json()["secret"]
    confirmation = client.post(
        "/api/auth/mfa/enroll/confirm",
        json={
            "enrollment_token": enrollment.json()["enrollment_token"],
            "code": pyotp.TOTP(secret).now(),
        },
    )
    assert confirmation.status_code == 200, confirmation.text
    body = confirmation.json()
    return (
        secret,
        body["recovery_codes"],
        body["session"]["token"],
        body["session"]["mfa_factor_generation"],
    )


def test_local_totp_enrollment_login_recovery_and_disable_are_real_and_show_once() -> None:
    _user, password = _local_user()

    primary = _login(password)
    assert primary.status_code == 200
    assert primary.headers["cache-control"] == "no-store"
    first_session = primary.json()["session"]
    assert first_session["mfa_assured"] is False
    assert first_session["mfa_factor_generation"] is None

    enrollment = client.post(
        "/api/auth/mfa/enroll",
        headers=_session_headers(first_session["token"]),
        json={"current_password": password},
    )
    assert enrollment.status_code == 201
    assert enrollment.headers["cache-control"] == "no-store"
    enrollment_body = enrollment.json()
    assert enrollment_body["secret"]
    assert enrollment_body["provisioning_uri"].startswith("otpauth://totp/")

    confirmation = client.post(
        "/api/auth/mfa/enroll/confirm",
        json={
            "enrollment_token": enrollment_body["enrollment_token"],
            "code": pyotp.TOTP(enrollment_body["secret"]).now(),
        },
    )
    assert confirmation.status_code == 200
    confirmed = confirmation.json()
    assert confirmed["session"]["mfa_assured"] is True
    assert confirmed["session"]["mfa_factor_generation"] > 0
    recovery_codes = confirmed["recovery_codes"]
    assert len(recovery_codes) == len(set(recovery_codes)) == 10
    assert all(re.fullmatch(r"[A-Z2-9]{4}(?:-[A-Z2-9]{4}){5}", code) for code in recovery_codes)

    assert client.get(
        "/api/auth/session",
        headers=_session_headers(first_session["token"]),
    ).status_code == 401

    challenged = _login(password)
    assert challenged.status_code == 202
    challenge = challenged.json()
    assert challenge["purpose"] == "verify"
    assert "session" not in challenge
    assert "user" not in challenge
    assert challenge["methods"] == ["totp", "recovery_code"]

    recovered = client.post(
        "/api/auth/mfa/preauth/verify",
        json={
            "challenge_token": challenge["challenge_token"],
            "method": "recovery_code",
            "code": recovery_codes[0],
        },
    )
    assert recovered.status_code == 200
    assured_token = recovered.json()["session"]["token"]

    replay_challenge = _login(password).json()["challenge_token"]
    replay = client.post(
        "/api/auth/mfa/preauth/verify",
        json={
            "challenge_token": replay_challenge,
            "method": "recovery_code",
            "code": recovery_codes[0],
        },
    )
    assert replay.status_code == 401
    assert recovery_codes[0] not in replay.text

    regenerated = client.post(
        "/api/auth/mfa/recovery-codes/regenerate",
        headers=_session_headers(assured_token),
        json={"method": "recovery_code", "code": recovery_codes[1]},
    )
    assert regenerated.status_code == 200
    assert set(regenerated.json()) == {"recovery_codes"}
    replacement_codes = regenerated.json()["recovery_codes"]
    assert len(replacement_codes) == len(set(replacement_codes)) == 10
    assert set(replacement_codes).isdisjoint(recovery_codes)

    regeneration_replay = client.post(
        "/api/auth/mfa/recovery-codes/regenerate",
        headers=_session_headers(assured_token),
        json={"method": "recovery_code", "code": recovery_codes[1]},
    )
    assert regeneration_replay.status_code == 401
    assert recovery_codes[1] not in regeneration_replay.text
    assert "recovery_codes" not in regeneration_replay.json()

    old_code_challenge = _login(password).json()["challenge_token"]
    old_code = client.post(
        "/api/auth/mfa/preauth/verify",
        json={
            "challenge_token": old_code_challenge,
            "method": "recovery_code",
            "code": recovery_codes[2],
        },
    )
    assert old_code.status_code == 401
    assert recovery_codes[2] not in old_code.text

    replacement_challenge = _login(password).json()["challenge_token"]
    replacement_login = client.post(
        "/api/auth/mfa/preauth/verify",
        json={
            "challenge_token": replacement_challenge,
            "method": "recovery_code",
            "code": replacement_codes[0],
        },
    )
    assert replacement_login.status_code == 200
    replacement_session = replacement_login.json()["session"]["token"]

    replacement_replay_challenge = _login(password).json()["challenge_token"]
    replacement_replay = client.post(
        "/api/auth/mfa/preauth/verify",
        json={
            "challenge_token": replacement_replay_challenge,
            "method": "recovery_code",
            "code": replacement_codes[0],
        },
    )
    assert replacement_replay.status_code == 401
    assert replacement_codes[0] not in replacement_replay.text

    disable = client.post(
        "/api/auth/mfa/disable",
        headers=_session_headers(replacement_session),
        json={"method": "recovery_code", "code": replacement_codes[1]},
    )
    assert disable.status_code == 200
    assert client.get(
        "/api/auth/session",
        headers=_session_headers(replacement_session),
    ).status_code == 401
    assert _login(password).json()["session"]["mfa_assured"] is False


def test_required_tenant_without_factor_gets_enrollment_challenge_not_session() -> None:
    user, password = _local_user()
    policy = client.patch(
        f"/api/admin/tenants/{user.tenant_id}/mfa-policy",
        headers={"X-Aperture-User": "user-admin"},
        json={"required": True, "expected_generation": 0},
    )
    assert policy.status_code == 200
    assert policy.json()["required"] is True

    primary = _login(password)
    assert primary.status_code == 202
    body = primary.json()
    assert body["purpose"] == "enroll"
    assert body["methods"] == ["totp"]
    assert "session" not in body
    assert get_store().application_state_repository.get_session_family(
        body["challenge_token"]
    ) is None

    enrollment = client.post(
        "/api/auth/mfa/enroll",
        json={"challenge_token": body["challenge_token"]},
    )
    assert enrollment.status_code == 201
    secret = enrollment.json()["secret"]
    confirmation = client.post(
        "/api/auth/mfa/enroll/confirm",
        json={
            "enrollment_token": enrollment.json()["enrollment_token"],
            "code": pyotp.TOTP(secret).now(),
        },
    )
    assert confirmation.status_code == 200
    assert confirmation.json()["session"]["mfa_assured"] is True


def test_exhausted_recovery_codes_are_omitted_from_initial_and_status_methods() -> None:
    _user, password = _local_user()
    primary = _login(password)
    enrollment = client.post(
        "/api/auth/mfa/enroll",
        headers=_session_headers(primary.json()["session"]["token"]),
        json={"current_password": password},
    )
    secret = enrollment.json()["secret"]
    confirmation = client.post(
        "/api/auth/mfa/enroll/confirm",
        json={
            "enrollment_token": enrollment.json()["enrollment_token"],
            "code": pyotp.TOTP(secret).now(),
        },
    )
    recovery_codes = confirmation.json()["recovery_codes"]

    for recovery_code in recovery_codes:
        challenge = _login(password)
        assert challenge.status_code == 202
        assert challenge.json()["methods"] == ["totp", "recovery_code"]
        verified = client.post(
            "/api/auth/mfa/preauth/verify",
            json={
                "challenge_token": challenge.json()["challenge_token"],
                "method": "recovery_code",
                "code": recovery_code,
            },
        )
        assert verified.status_code == 200

    exhausted = _login(password)
    assert exhausted.status_code == 202
    assert exhausted.json()["methods"] == ["totp"]

    status_response = client.post(
        "/api/auth/mfa/preauth/status",
        json={"challenge_token": exhausted.json()["challenge_token"]},
    )
    assert status_response.status_code == 200
    assert status_response.json()["methods"] == ["totp"]


@pytest.mark.parametrize(
    ("method", "bad_code"),
    [
        ("totp", "abcdef"),
        ("recovery_code", "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"),
    ],
)
def test_failed_attempt_budget_survives_repeated_primary_authentication(
    method: str,
    bad_code: str,
) -> None:
    _user, password = _local_user()
    _enroll_local_factor(password)

    for attempt in range(1, 6):
        challenge = _login(password)
        assert challenge.status_code == 202
        assert challenge.json()["attempts_remaining"] == 6 - attempt
        failed = client.post(
            "/api/auth/mfa/preauth/verify",
            json={
                "challenge_token": challenge.json()["challenge_token"],
                "method": method,
                "code": bad_code,
            },
        )
        assert failed.status_code == (429 if attempt == 5 else 401)

    still_locked = _login(password)
    assert still_locked.status_code == 429
    assert int(still_locked.headers["retry-after"]) > 0
    assert still_locked.headers["cache-control"] == "no-store"
    assert "session" not in still_locked.json()


def test_enrollment_lockout_returns_429_when_setup_is_restarted() -> None:
    user, password = _local_user()
    enabled = client.patch(
        f"/api/admin/tenants/{user.tenant_id}/mfa-policy",
        headers={"X-Aperture-User": "user-admin"},
        json={"required": True, "expected_generation": 0},
    )
    assert enabled.status_code == 200
    challenge = _login(password).json()["challenge_token"]
    enrollment = client.post(
        "/api/auth/mfa/enroll",
        json={"challenge_token": challenge},
    )
    assert enrollment.status_code == 201

    for attempt in range(1, 6):
        failed = client.post(
            "/api/auth/mfa/enroll/confirm",
            json={
                "enrollment_token": enrollment.json()["enrollment_token"],
                "code": "abcdef",
            },
        )
        assert failed.status_code == (429 if attempt == 5 else 401)

    consumed_source = client.post(
        "/api/auth/mfa/enroll",
        json={"challenge_token": challenge},
    )
    assert consumed_source.status_code == 401

    restarted_primary = _login(password)
    assert restarted_primary.status_code == 202
    restarted = client.post(
        "/api/auth/mfa/enroll",
        json={"challenge_token": restarted_primary.json()["challenge_token"]},
    )
    assert restarted.status_code == 429
    assert int(restarted.headers["retry-after"]) > 0
    assert restarted.headers["cache-control"] == "no-store"
    assert "secret" not in restarted.text


def test_totp_step_replay_and_concurrent_challenge_completion_issue_one_session() -> None:
    _user, password = _local_user()
    secret, _codes, _session, _generation = _enroll_local_factor(password)
    challenge = _login(password)
    assert challenge.status_code == 202
    challenge_token = challenge.json()["challenge_token"]
    next_step_code = pyotp.TOTP(secret).at(time.time() + 30)

    def verify_once() -> tuple[int, dict[str, object]]:
        response = client.post(
            "/api/auth/mfa/preauth/verify",
            json={
                "challenge_token": challenge_token,
                "method": "totp",
                "code": next_step_code,
            },
        )
        return response.status_code, response.json()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _index: verify_once(), range(2)))

    assert sorted(status_code for status_code, _body in results) == [200, 401]
    assert sum("session" in body for _status, body in results) == 1

    replay_challenge = _login(password)
    replay = client.post(
        "/api/auth/mfa/preauth/verify",
        json={
            "challenge_token": replay_challenge.json()["challenge_token"],
            "method": "totp",
            "code": next_step_code,
        },
    )
    assert replay.status_code == 401
    assert "session" not in replay.json()


def test_policy_cas_revokes_sessions_and_distinguishes_factor_posture() -> None:
    user, password = _local_user()
    initial = _login(password)
    unassured_token = initial.json()["session"]["token"]

    enabled = client.patch(
        f"/api/admin/tenants/{user.tenant_id}/mfa-policy",
        headers={"X-Aperture-User": "user-admin"},
        json={"required": True, "expected_generation": 0},
    )
    assert enabled.status_code == 200
    assert enabled.json() == {
        "tenant_id": user.tenant_id,
        "required": True,
        "generation": 1,
    }
    assert client.get(
        "/api/auth/session",
        headers=_session_headers(unassured_token),
    ).status_code == 401

    stale = client.patch(
        f"/api/admin/tenants/{user.tenant_id}/mfa-policy",
        headers={"X-Aperture-User": "user-admin"},
        json={"required": False, "expected_generation": 0},
    )
    assert stale.status_code == 409

    forced = _login(password)
    assert forced.status_code == 202
    assert forced.json()["purpose"] == "enroll"
    enrollment = client.post(
        "/api/auth/mfa/enroll",
        json={"challenge_token": forced.json()["challenge_token"]},
    )
    confirmation = client.post(
        "/api/auth/mfa/enroll/confirm",
        json={
            "enrollment_token": enrollment.json()["enrollment_token"],
            "code": pyotp.TOTP(enrollment.json()["secret"]).now(),
        },
    )
    assert confirmation.status_code == 200
    assured_token = confirmation.json()["session"]["token"]

    disabled = client.patch(
        f"/api/admin/tenants/{user.tenant_id}/mfa-policy",
        headers={"X-Aperture-User": "user-admin"},
        json={"required": False, "expected_generation": 1},
    )
    assert disabled.status_code == 200
    assert disabled.json()["generation"] == 2
    assert client.get(
        "/api/auth/session",
        headers=_session_headers(assured_token),
    ).status_code == 401

    factor_still_requires_verification = _login(password)
    assert factor_still_requires_verification.status_code == 202
    assert factor_still_requires_verification.json()["purpose"] == "verify"


def test_admin_reset_role_boundaries_and_target_session_revocation() -> None:
    _user, password = _local_user()
    _secret, _codes, assured_token, _generation = _enroll_local_factor(password)

    self_reset = client.post(
        "/api/admin/users/user-admin/mfa/reset",
        headers={"X-Aperture-User": "user-admin"},
    )
    peer_admin_reset = client.post(
        "/api/admin/users/user-drew/mfa/reset",
        headers={"X-Aperture-User": "user-admin"},
    )
    assert self_reset.status_code == 403
    assert peer_admin_reset.status_code == 403

    tenant_reset = client.post(
        "/api/admin/users/user-jane/mfa/reset",
        headers={"X-Aperture-User": "user-admin"},
    )
    assert tenant_reset.status_code == 200
    assert tenant_reset.json()["factor_existed"] is True
    assert client.get(
        "/api/auth/session",
        headers=_session_headers(assured_token),
    ).status_code == 401

    replacement_session = _login(password).json()["session"]["token"]
    owner_reset = client.post(
        "/api/admin/users/user-jane/mfa/reset",
        headers={"X-Aperture-User": "user-owner"},
    )
    assert owner_reset.status_code == 200
    assert owner_reset.json()["factor_existed"] is False
    assert client.get(
        "/api/auth/session",
        headers=_session_headers(replacement_session),
    ).status_code == 401


def test_mfa_repository_failures_fail_closed_without_leaking_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _user, password = _local_user()
    secret, _codes, _session, _generation = _enroll_local_factor(password)
    repository = get_store().application_state_repository

    def unavailable(*_args, **_kwargs):
        raise RuntimeError("sensitive durable repository detail")

    with monkeypatch.context() as patcher:
        patcher.setattr(repository, "get_mfa_posture", unavailable)
        decision = _login(password)
    assert decision.status_code == 503
    assert decision.json()["detail"] == "Authentication is temporarily unavailable."
    assert "sensitive" not in decision.text

    challenge = _login(password)
    challenge_token = challenge.json()["challenge_token"]
    with monkeypatch.context() as patcher:
        patcher.setattr(repository, "get_mfa_challenge", unavailable)
        challenge_status = client.post(
            "/api/auth/mfa/preauth/status",
            json={"challenge_token": challenge_token},
        )
    assert challenge_status.status_code == 503
    assert challenge_status.json()["detail"] == "MFA verification is temporarily unavailable."
    assert "sensitive" not in challenge_status.text

    with monkeypatch.context() as patcher:
        patcher.setattr(repository, "complete_totp_challenge", unavailable)
        verification = client.post(
            "/api/auth/mfa/preauth/verify",
            json={
                "challenge_token": challenge_token,
                "method": "totp",
                "code": pyotp.TOTP(secret).at(time.time() + 30),
            },
        )
    assert verification.status_code == 503
    assert verification.json()["detail"] == "MFA verification is temporarily unavailable."
    assert "sensitive" not in verification.text
    assert all(
        response.headers["cache-control"] == "no-store"
        for response in (decision, challenge_status, verification)
    )


def test_unhandled_auth_failure_is_generic_and_never_cacheable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _user, password = _local_user()
    store = get_store()
    original_record_audit = store.record_audit

    def fail_login_audit(actor, action, *args, **kwargs):
        if action == "auth.login":
            raise RuntimeError("sensitive unhandled failure")
        return original_record_audit(actor, action, *args, **kwargs)

    monkeypatch.setattr(store, "record_audit", fail_login_audit)
    with TestClient(app, raise_server_exceptions=False) as error_client:
        response = error_client.post(
            "/api/auth/login",
            json={
                "email": "jane.mfa@local.invalid",
                "auth_method": "local",
                "password": password,
            },
        )

    assert response.status_code == 500
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"detail": "An unexpected server error occurred."}
    assert "sensitive" not in response.text


def test_identity_lifecycle_clears_flows_and_resets_or_purges_factor() -> None:
    user, password = _local_user()
    _secret, _codes, assured_token, _generation = _enroll_local_factor(password)
    challenge_before_group_change = _login(password).json()["challenge_token"]

    group_change = client.patch(
        f"/api/admin/users/{user.id}",
        headers={"X-Aperture-User": "user-owner"},
        json={"group_ids": ["group-default-users"]},
    )
    assert group_change.status_code == 200, group_change.text
    assert client.get(
        "/api/auth/session",
        headers=_session_headers(assured_token),
    ).status_code == 401
    assert client.post(
        "/api/auth/mfa/preauth/status",
        json={"challenge_token": challenge_before_group_change},
    ).status_code == 401
    _policy, factor_after_group, _unused = get_store().application_state_repository.get_mfa_posture(
        user_id=user.id,
        tenant_id=user.tenant_id,
    )
    assert factor_after_group is not None

    challenge_before_move = _login(password).json()["challenge_token"]
    tenant = client.post(
        "/api/platform/tenants",
        headers={"X-Aperture-User": "user-owner"},
        json={"name": "MFA Move Tenant", "slug": "mfa-move"},
    )
    assert tenant.status_code == 201, tenant.text
    moved = client.patch(
        f"/api/admin/users/{user.id}",
        headers={"X-Aperture-User": "user-owner"},
        json={"tenant_id": tenant.json()["id"]},
    )
    assert moved.status_code == 200, moved.text
    assert client.post(
        "/api/auth/mfa/preauth/status",
        json={"challenge_token": challenge_before_move},
    ).status_code == 401
    _policy, factor_after_move, unused_after_move = (
        get_store().application_state_repository.get_mfa_posture(
            user_id=user.id,
            tenant_id=tenant.json()["id"],
        )
    )
    assert factor_after_move is None
    assert unused_after_move == 0

    tenant_headers = {"X-Aperture-Tenant": tenant.json()["slug"]}
    _secret, _codes, moved_session, _generation = _enroll_local_factor(
        password,
        tenant_headers=tenant_headers,
    )
    challenge_before_delete = _login(
        password,
        headers=tenant_headers,
    ).json()["challenge_token"]
    deleted = client.delete(
        f"/api/admin/users/{user.id}",
        headers={"X-Aperture-User": "user-owner"},
    )
    assert deleted.status_code == 200, deleted.text
    assert user.id not in get_store().users
    assert client.get(
        "/api/auth/session",
        headers=_session_headers(moved_session),
    ).status_code == 401
    assert client.post(
        "/api/auth/mfa/preauth/status",
        json={"challenge_token": challenge_before_delete},
    ).status_code == 401
    _policy, factor_after_delete, unused_after_delete = (
        get_store().application_state_repository.get_mfa_posture(
            user_id=user.id,
            tenant_id=tenant.json()["id"],
        )
    )
    assert factor_after_delete is None
    assert unused_after_delete == 0


def test_mfa_validation_errors_redact_secret_input_and_never_cache() -> None:
    raw = "mfa_ch_" + ("sensitive-value" * 100)
    response = client.post(
        "/api/auth/mfa/preauth/status",
        json={"challenge_token": raw},
    )

    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    assert raw not in response.text
    assert response.json()["detail"][0]["input"] == "[redacted]"
    assert "ctx" not in response.json()["detail"][0]

    password = "credential-that-must-never-be-reflected"
    missing_email = client.post(
        "/api/auth/login",
        json={"auth_method": "local", "password": password},
    )
    assert missing_email.status_code == 422
    assert missing_email.headers["cache-control"] == "no-store"
    assert password not in missing_email.text
    assert missing_email.json()["detail"][0]["input"] == "[redacted]"


def test_password_change_preserves_mfa_assurance_in_fresh_session_only() -> None:
    _user, password = _local_user()
    _secret, _codes, old_token, generation = _enroll_local_factor(password)
    changed = client.post(
        "/api/auth/password",
        headers=_session_headers(old_token),
        json={"current_password": password, "new_password": "replacement-mfa-password"},
    )
    assert changed.status_code == 200
    replacement = changed.json()["session"]
    assert replacement["mfa_assured"] is True
    assert replacement["mfa_factor_generation"] == generation
    assert replacement["token"] != old_token
    assert client.get("/api/auth/session", headers=_session_headers(old_token)).status_code == 401
    assert client.get("/api/auth/session", headers=_session_headers(replacement["token"])).status_code == 200
    assert _login("replacement-mfa-password").status_code == 202
