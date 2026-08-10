"""Admin/owner password resets and temporary-password sign-in."""

from fastapi.testclient import TestClient
import pytest

from app.core.config import get_settings
from app.main import app
from app.models.schemas import Role, User
from app.repositories.deps import get_store

client = TestClient(app)

RESET = "/api/admin/users/{}/password"


@pytest.fixture(autouse=True)
def reset_store() -> None:
    get_settings.cache_clear()
    get_store.cache_clear()
    yield
    get_store.cache_clear()
    get_settings.cache_clear()


def _headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def test_owner_sets_passwords_for_admins_and_users() -> None:
    response = client.post(
        RESET.format("user-admin"),
        json={"password": "starter-password-123", "temporary": True},
        headers=_headers("user-owner"),
    )
    assert response.status_code == 200
    assert response.json() == {"status": "password_set", "user_id": "user-admin", "temporary": True}

    store = get_store()
    assert store.verify_password_credential("user-admin", "starter-password-123")
    assert store.password_is_temporary("user-admin")
    assert store.users["user-admin"].auth_method == "local"
    assert store.audit_events[-1].action == "admin.password_reset"
    assert store.audit_events[-1].metadata["temporary"] is True

    permanent = client.post(
        RESET.format("user-jane"),
        json={"password": "starter-password-456", "temporary": False},
        headers=_headers("user-owner"),
    )
    assert permanent.status_code == 200
    assert not store.password_is_temporary("user-jane")


def test_owner_sets_initial_password_for_invited_platform_owner_once() -> None:
    store = get_store()
    store.users["user-jordan"] = User(
        id="user-jordan",
        tenant_id=None,
        email="jordan@aperture.local",
        display_name="Jordan Lee",
        role=Role.PLATFORM_OWNER,
        auth_method="sso",
    )

    response = client.post(
        RESET.format("user-jordan"),
        json={"password": "starter-password-123", "temporary": True},
        headers=_headers("user-owner"),
    )
    assert response.status_code == 200
    assert response.json() == {"status": "password_set", "user_id": "user-jordan", "temporary": True}
    assert store.verify_password_credential("user-jordan", "starter-password-123")
    assert store.password_is_temporary("user-jordan")
    assert store.users["user-jordan"].auth_method == "local"

    repeat = client.post(
        RESET.format("user-jordan"),
        json={"password": "starter-password-456", "temporary": True},
        headers=_headers("user-owner"),
    )
    assert repeat.status_code == 403
    assert "must change its password from its own account panel" in repeat.json()["detail"]
    assert store.verify_password_credential("user-jordan", "starter-password-123")


def test_admin_resets_regular_users_but_never_admins_or_owners() -> None:
    allowed = client.post(
        RESET.format("user-jane"),
        json={"password": "starter-password-123"},
        headers=_headers("user-admin"),
    )
    assert allowed.status_code == 200
    assert allowed.json()["temporary"] is True  # temporary is the default

    peer_admin = client.post(
        RESET.format("user-drew"),
        json={"password": "starter-password-123"},
        headers=_headers("user-admin"),
    )
    assert peer_admin.status_code == 403

    owner = client.post(
        RESET.format("user-owner"),
        json={"password": "starter-password-123"},
        headers=_headers("user-admin"),
    )
    assert owner.status_code == 403

    regular_actor = client.post(
        RESET.format("user-casey"),
        json={"password": "starter-password-123"},
        headers=_headers("user-jane"),
    )
    assert regular_actor.status_code == 403


def test_password_rules_self_reset_and_inactive_accounts() -> None:
    short = client.post(
        RESET.format("user-jane"),
        json={"password": "short"},
        headers=_headers("user-owner"),
    )
    assert short.status_code == 400

    self_reset = client.post(
        RESET.format("user-owner"),
        json={"password": "starter-password-123"},
        headers=_headers("user-owner"),
    )
    assert self_reset.status_code == 400
    assert "account panel" in self_reset.json()["detail"]

    get_store().users["user-jane"].active = False
    inactive = client.post(
        RESET.format("user-jane"),
        json={"password": "starter-password-123"},
        headers=_headers("user-owner"),
    )
    assert inactive.status_code == 400


def test_temporary_password_login_requires_change_then_clears() -> None:
    store = get_store()
    # aperture.local is outside the seeded enforced-SSO domain, so local
    # sign-in is representative of a fresh manually provisioned account.
    store.users["user-temp"] = User(
        id="user-temp",
        tenant_id="tenant-example",
        email="temp.user@aperture.local",
        display_name="Temp User",
        role=Role.USER,
        auth_method="sso",
    )

    issued = client.post(
        RESET.format("user-temp"),
        json={"password": "starter-password-123", "temporary": True},
        headers=_headers("user-owner"),
    )
    assert issued.status_code == 200

    login = client.post(
        "/api/auth/login",
        json={"email": "temp.user@aperture.local", "auth_method": "local", "password": "starter-password-123"},
    )
    assert login.status_code == 200
    body = login.json()
    assert body["must_change_password"] is True
    token = body["session"]["token"]

    change = client.post(
        "/api/auth/password",
        json={"current_password": "starter-password-123", "new_password": "my-own-longer-password"},
        headers={"x-aperture-session": token},
    )
    assert change.status_code == 200

    second_login = client.post(
        "/api/auth/login",
        json={"email": "temp.user@aperture.local", "auth_method": "local", "password": "my-own-longer-password"},
    )
    assert second_login.status_code == 200
    assert second_login.json()["must_change_password"] is False
