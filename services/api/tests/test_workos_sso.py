"""End-to-end tests for the optional WorkOS AuthKit sign-in.

WorkOS's REST API is replaced by fakes at the module's HTTP helpers, while the
access token is signed with a per-session RSA key and verified through the
real PyJWT path, so signature, expiry, and subject checks are exercised.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.core import workos
from app.core.config import get_settings
from app.main import app
from app.repositories.deps import get_store

client = TestClient(app, follow_redirects=False)

CLIENT_ID = "client_01JAPERTURETEST"
API_KEY = "sk_test_aperture_synthetic"
ORG_ID = "org_01JMERIDIAN"
CONFIG_ID = "sso-workos-test"
WORKOS_BASE = "https://api.workos.com"

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _FakeJwkClient:
    def get_signing_key_from_jwt(self, token: str) -> SimpleNamespace:
        return SimpleNamespace(key=_PRIVATE_KEY.public_key())


@pytest.fixture(autouse=True)
def reset_store(monkeypatch: pytest.MonkeyPatch):
    get_settings.cache_clear()
    get_store.cache_clear()
    monkeypatch.setitem(workos._jwk_clients, f"{WORKOS_BASE}/sso/jwks/{CLIENT_ID}", _FakeJwkClient())
    yield
    get_store.cache_clear()
    get_settings.cache_clear()


def _create_config(**settings) -> dict:
    response = client.post(
        "/api/admin/sso-configs",
        headers={"x-aperture-user": "user-owner"},
        json={
            "id": CONFIG_ID,
            "tenant_id": "tenant-example",
            "provider": "workos",
            "issuer_url": "",
            "client_id": CLIENT_ID,
            "client_secret": API_KEY,
            "settings": {
                "protocol": "WORKOS",
                "domains": ["example.com"],
                "jit_provisioning": True,
                "enforced": False,
                **settings,
            },
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _access_token(
    subject: str,
    *,
    org_id: str | None = ORG_ID,
    key=_PRIVATE_KEY,
    clock_offset: int = 0,
    **claims,
) -> str:
    now = int(time.time()) + clock_offset
    payload = {
        "iss": WORKOS_BASE,
        "sub": subject,
        "sid": "session_01JSYNTHETIC",
        "iat": now,
        "exp": now + 300,
        **({"org_id": org_id} if org_id else {}),
        **claims,
    }
    return jwt.encode(payload, key, algorithm="RS256")


def _authentication(
    email: str,
    *,
    user_id: str = "user_01JWORKOSNEW",
    first_name: str = "Riley",
    last_name: str = "Chen",
    email_verified: bool = True,
    access_token: str | None = None,
    organization_id: str | None = ORG_ID,
) -> dict:
    return {
        "user": {
            "object": "user",
            "id": user_id,
            "email": email,
            "first_name": first_name,
            "last_name": last_name,
            "email_verified": email_verified,
        },
        "organization_id": organization_id,
        "access_token": access_token or _access_token(user_id, org_id=organization_id),
        "refresh_token": "refresh_synthetic",
        "authentication_method": "SSO",
    }


class _WorkOSApi:
    """Records each request and answers from a queue of (status, payload) pairs."""

    def __init__(self, *responses: tuple[int, dict]) -> None:
        self.responses = list(responses)
        self.requests: list[dict] = []

    def post(self, url: str, body: dict) -> httpx.Response:
        return self._answer("POST", url, body=body)

    def get(self, url: str, api_key: str | None, params: dict | None = None) -> httpx.Response:
        return self._answer("GET", url, api_key=api_key, params=params)

    def _answer(self, method: str, url: str, **details) -> httpx.Response:
        self.requests.append({"method": method, "url": url, **details})
        status_code, payload = self.responses.pop(0)
        return httpx.Response(status_code, json=payload, request=httpx.Request(method, url))


def _authorize(query: str = "") -> dict[str, list[str]]:
    response = client.get(f"/api/auth/sso/{CONFIG_ID}/authorize{query}")
    assert response.status_code == 302, response.text
    location = response.headers["location"]
    assert location.startswith(f"{WORKOS_BASE}/user_management/authorize?")
    return parse_qs(urlparse(location).query)


def _callback(monkeypatch: pytest.MonkeyPatch, state: str, api: _WorkOSApi):
    monkeypatch.setattr(workos, "_post", api.post)
    return client.get("/api/auth/sso/callback", params={"code": "auth_code_synthetic", "state": state})


def _fragment(response) -> str:
    return unquote(urlparse(response.headers["location"]).fragment)


def test_authorize_sends_the_browser_to_hosted_authkit() -> None:
    _create_config()

    params = _authorize("?login_hint=Riley.Chen@Example.com")

    assert params["client_id"] == [CLIENT_ID]
    assert params["response_type"] == ["code"]
    assert params["provider"] == ["authkit"]
    assert params["redirect_uri"][0].endswith("/api/auth/sso/callback")
    assert params["code_challenge_method"] == ["S256"]
    assert len(params["code_challenge"][0]) >= 43
    assert params["login_hint"] == ["riley.chen@example.com"]
    assert "organization_id" not in params
    assert params["state"][0]


def test_authorize_pins_the_configured_organization() -> None:
    _create_config(workos_organization_id=ORG_ID)

    params = _authorize()

    assert params["organization_id"] == [ORG_ID]
    assert params["provider"] == ["authkit"]
    assert "login_hint" not in params


def test_sign_in_options_list_workos_only_when_ready() -> None:
    _create_config(display_name="Meridian sign-in")

    options = client.get("/api/auth/options").json()
    provider = next(item for item in options["providers"] if item["id"] == CONFIG_ID)
    assert provider["protocol"] == "WORKOS"
    assert provider["name"] == "Meridian sign-in"
    assert provider["start_url"] == f"/api/auth/sso/{CONFIG_ID}/authorize"
    assert "WORKOS" in options["supported_sso_protocols"]

    # Without allowed domains the configuration stays off the sign-in screen.
    get_store().sso_configs[CONFIG_ID].settings["domains"] = []
    options = client.get("/api/auth/options").json()
    assert CONFIG_ID not in {item["id"] for item in options["providers"]}


def test_sign_in_options_omit_workos_without_an_api_key() -> None:
    response = client.post(
        "/api/admin/sso-configs",
        headers={"x-aperture-user": "user-owner"},
        json={
            "id": CONFIG_ID,
            "tenant_id": "tenant-example",
            "provider": "workos",
            "issuer_url": "",
            "client_id": CLIENT_ID,
            "settings": {"protocol": "WORKOS", "domains": ["example.com"]},
        },
    )
    assert response.status_code == 201
    options = client.get("/api/auth/options").json()
    assert CONFIG_ID not in {item["id"] for item in options["providers"]}
    assert client.get(f"/api/auth/sso/{CONFIG_ID}/authorize").status_code == 404


def test_callback_redeems_the_code_and_provisions_a_new_user(monkeypatch: pytest.MonkeyPatch) -> None:
    _create_config()
    state = _authorize()["state"][0]
    api = _WorkOSApi((200, _authentication("riley.chen@example.com")))

    response = _callback(monkeypatch, state, api)

    assert response.status_code == 302
    fragment = _fragment(response)
    assert fragment.startswith("sso_session=")
    [request] = api.requests
    assert request["url"] == f"{WORKOS_BASE}/user_management/authenticate"
    body = request["body"]
    assert body["grant_type"] == "authorization_code"
    assert body["client_id"] == CLIENT_ID
    assert body["client_secret"] == API_KEY
    assert body["code"] == "auth_code_synthetic"
    assert len(body["code_verifier"]) >= 43

    store = get_store()
    created = next(user for user in store.users.values() if user.email == "riley.chen@example.com")
    assert created.display_name == "Riley Chen"
    assert created.auth_method == "sso"
    assert created.entra_object_id == "user_01JWORKOSNEW"
    login = store.audit_events[-1]
    assert login.action == "auth.login"
    assert login.metadata["issuer"] == WORKOS_BASE
    assert login.metadata["sso_config_id"] == CONFIG_ID

    session = client.get(
        "/api/auth/session",
        headers={"x-aperture-session": fragment.split("=", 1)[1]},
    )
    assert session.status_code == 200
    assert session.json()["user"]["email"] == "riley.chen@example.com"


def test_existing_account_bound_to_another_provider_is_not_taken_over(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """jane.smith is bound to her Entra subject; a WorkOS user ID is a new identity."""
    _create_config()
    state = _authorize()["state"][0]
    api = _WorkOSApi((200, _authentication("jane.smith@example.com", user_id="user_01JJANE")))

    fragment = _fragment(_callback(monkeypatch, state, api))

    assert fragment.startswith("sso_error=")
    assert "different identity" in fragment
    assert get_store().users["user-jane"].entra_object_id == "entra-user-001"


def test_callback_rejects_a_sign_in_from_another_organization(monkeypatch: pytest.MonkeyPatch) -> None:
    _create_config(workos_organization_id=ORG_ID)
    state = _authorize()["state"][0]
    api = _WorkOSApi((200, _authentication("riley.chen@example.com", organization_id="org_01JOTHER")))

    fragment = _fragment(_callback(monkeypatch, state, api))

    assert fragment.startswith("sso_error=")
    assert "organization configured for this workspace" in fragment
    assert not any(user.email == "riley.chen@example.com" for user in get_store().users.values())


def test_callback_rejects_an_unverified_email(monkeypatch: pytest.MonkeyPatch) -> None:
    _create_config()
    state = _authorize()["state"][0]
    api = _WorkOSApi((200, _authentication("riley.chen@example.com", email_verified=False)))

    fragment = _fragment(_callback(monkeypatch, state, api))

    assert fragment.startswith("sso_error=")
    assert "unverified" in fragment


def test_callback_rejects_an_email_outside_the_allowed_domains(monkeypatch: pytest.MonkeyPatch) -> None:
    _create_config()
    state = _authorize()["state"][0]
    api = _WorkOSApi((200, _authentication("riley.chen@elsewhere.test")))

    fragment = _fragment(_callback(monkeypatch, state, api))

    assert fragment.startswith("sso_error=")
    assert "outside the domains allowed" in fragment


@pytest.mark.parametrize(
    ("token_kwargs", "message"),
    [
        ({"key": _OTHER_KEY}, "failed verification"),
        ({"subject": "user_01JSOMEONEELSE"}, "does not belong to the signed-in user"),
    ],
)
def test_callback_rejects_an_access_token_that_does_not_verify(
    monkeypatch: pytest.MonkeyPatch,
    token_kwargs: dict,
    message: str,
) -> None:
    _create_config()
    state = _authorize()["state"][0]
    subject = token_kwargs.pop("subject", "user_01JWORKOSNEW")
    token = _access_token(subject, **token_kwargs)
    api = _WorkOSApi((200, _authentication("riley.chen@example.com", access_token=token)))

    fragment = _fragment(_callback(monkeypatch, state, api))

    assert fragment.startswith("sso_error=")
    assert message in fragment


def test_workos_roles_map_to_workspace_groups(monkeypatch: pytest.MonkeyPatch) -> None:
    _create_config(group_claim="roles")
    store = get_store()
    store.sso_configs[CONFIG_ID].mapped_groups = {"finance-reviewer": "group-finance"}
    state = _authorize()["state"][0]
    token = _access_token("user_01JWORKOSNEW", role="finance-reviewer", roles=["finance-reviewer"])
    api = _WorkOSApi((200, _authentication("riley.chen@example.com", access_token=token)))

    fragment = _fragment(_callback(monkeypatch, state, api))

    assert fragment.startswith("sso_session=")
    created = next(user for user in store.users.values() if user.email == "riley.chen@example.com")
    assert "group-finance" in created.group_ids


@pytest.mark.parametrize(
    ("status_code", "payload", "message"),
    [
        (
            403,
            {"code": "organization_selection_required", "pending_authentication_token": "pending_x"},
            "add the WorkOS organization ID",
        ),
        (400, {"error": "invalid_grant", "error_description": "expired"}, "expired or was already used"),
        (401, {"message": "Unauthorized"}, "rejected the client ID or API key"),
    ],
)
def test_authentication_errors_are_explained(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    payload: dict,
    message: str,
) -> None:
    _create_config()
    state = _authorize()["state"][0]

    fragment = _fragment(_callback(monkeypatch, state, _WorkOSApi((status_code, payload))))

    assert fragment.startswith("sso_error=")
    assert message in fragment
    assert "pending_x" not in fragment


def test_admin_test_checks_the_key_client_and_organization(monkeypatch: pytest.MonkeyPatch) -> None:
    _create_config(workos_organization_id=ORG_ID)
    api = _WorkOSApi(
        (200, {"object": "list", "data": []}),
        (200, {"keys": [{"kty": "RSA", "kid": "k1"}]}),
        (200, {"id": ORG_ID, "name": "Meridian Legal", "domains": [{"domain": "example.com"}]}),
    )
    monkeypatch.setattr(workos, "_get", api.get)

    result = client.post(
        f"/api/admin/sso-configs/{CONFIG_ID}/test",
        headers={"x-aperture-user": "user-owner"},
    ).json()

    assert result["status"] == "ok"
    assert [check["name"] for check in result["checks"]] == [
        "API key",
        "Client ID",
        "Organization",
        "Sign-in readiness",
    ]
    assert result["checks"][2]["detail"] == "Meridian Legal (example.com)"
    assert [request["url"] for request in api.requests] == [
        f"{WORKOS_BASE}/organizations",
        f"{WORKOS_BASE}/sso/jwks/{CLIENT_ID}",
        f"{WORKOS_BASE}/organizations/{ORG_ID}",
    ]
    assert api.requests[0]["api_key"] == API_KEY
    assert api.requests[1]["api_key"] is None


def test_admin_test_reports_a_rejected_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    _create_config()
    api = _WorkOSApi((401, {"message": "Unauthorized"}), (200, {"keys": [{"kid": "k1"}]}))
    monkeypatch.setattr(workos, "_get", api.get)

    result = client.post(
        f"/api/admin/sso-configs/{CONFIG_ID}/test",
        headers={"x-aperture-user": "user-owner"},
    ).json()

    assert result["status"] == "failed"
    assert result["message"] == "WorkOS could not verify: API key."
    assert "rejected the API key" in result["checks"][0]["detail"]


def test_a_token_minted_by_a_slightly_faster_clock_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    """WorkOS's clock may run a few seconds ahead of this server's."""
    _create_config()
    state = _authorize()["state"][0]
    token = _access_token("user_01JWORKOSNEW", clock_offset=5)
    api = _WorkOSApi((200, _authentication("riley.chen@example.com", access_token=token)))

    assert _fragment(_callback(monkeypatch, state, api)).startswith("sso_session=")


def _claims(**overrides) -> dict:
    authentication = _authentication("riley.chen@example.com", **overrides)
    return workos.identity_claims(authentication, client_id=CLIENT_ID)


def test_identity_claims_fall_back_to_the_single_role_claim() -> None:
    token = _access_token("user_01JWORKOSNEW", role="admin")

    claims = _claims(access_token=token)

    assert claims["role"] == "admin"
    assert claims["roles"] == ["admin"]
    assert claims["org_id"] == ORG_ID


def test_identity_claims_carry_no_roles_when_the_token_has_none() -> None:
    claims = _claims(first_name="Riley", last_name="")

    assert claims["roles"] == []
    assert claims["permissions"] == []
    assert claims["name"] == "Riley"
    assert claims["given_name"] == "Riley"
    assert claims["family_name"] is None


def test_identity_claims_take_the_organization_from_the_response_when_the_token_has_none() -> None:
    token = _access_token("user_01JWORKOSNEW", org_id=None)
    authentication = _authentication("riley.chen@example.com", access_token=token)

    claims = workos.identity_claims(authentication, client_id=CLIENT_ID, required_organization=ORG_ID)

    assert claims["org_id"] == ORG_ID


def test_identity_claims_omit_email_verified_when_workos_does_not_say() -> None:
    authentication = _authentication("riley.chen@example.com")
    del authentication["user"]["email_verified"]

    assert "email_verified" not in workos.identity_claims(authentication, client_id=CLIENT_ID)


def test_identity_claims_require_a_user_id() -> None:
    authentication = _authentication("riley.chen@example.com")
    authentication["user"]["id"] = " "

    with pytest.raises(workos.WorkOSError, match="did not return a user ID"):
        workos.identity_claims(authentication, client_id=CLIENT_ID)


def test_identity_claims_require_an_access_token() -> None:
    authentication = _authentication("riley.chen@example.com")
    authentication["access_token"] = None

    with pytest.raises(workos.WorkOSError, match="did not return an access token"):
        workos.identity_claims(authentication, client_id=CLIENT_ID)


@pytest.mark.parametrize(
    ("status_code", "body", "message"),
    [
        (500, {"error_description": "Upstream unavailable"}, "WorkOS returned 500: Upstream unavailable"),
        (422, {"message": "code is required"}, "WorkOS returned 422: code is required"),
        (503, {"code": "service_down"}, "WorkOS returned 503: service_down"),
        (502, "Bad gateway", "WorkOS returned 502: Bad gateway"),
    ],
)
def test_unexpected_authentication_errors_quote_workos(
    monkeypatch: pytest.MonkeyPatch,
    status_code: int,
    body,
    message: str,
) -> None:
    def respond(url: str, payload: dict) -> httpx.Response:
        request = httpx.Request("POST", url)
        if isinstance(body, dict):
            return httpx.Response(status_code, json=body, request=request)
        return httpx.Response(status_code, text=body, request=request)

    monkeypatch.setattr(workos, "_post", respond)

    with pytest.raises(workos.WorkOSError) as error:
        workos.authenticate_with_code(client_id=CLIENT_ID, api_key=API_KEY, code="c", code_verifier=None)

    assert str(error.value) == message


def test_authenticate_rejects_a_response_without_a_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(workos, "_post", _WorkOSApi((200, {"access_token": "t"})).post)

    with pytest.raises(workos.WorkOSError, match="did not return a user"):
        workos.authenticate_with_code(client_id=CLIENT_ID, api_key=API_KEY, code="c", code_verifier=None)


def test_connection_checks_report_each_failure_on_its_own(monkeypatch: pytest.MonkeyPatch) -> None:
    api = _WorkOSApi((500, {"message": "Internal error"}), (200, {"keys": []}), (404, {"message": "Not found"}))
    monkeypatch.setattr(workos, "_get", api.get)

    checks = workos.check_connection(client_id=CLIENT_ID, api_key=API_KEY, organization=ORG_ID)

    assert [(check["name"], check["status"]) for check in checks] == [
        ("API key", "failed"),
        ("Client ID", "failed"),
        ("Organization", "failed"),
    ]
    assert checks[0]["detail"] == "WorkOS returned 500: Internal error"
    assert "no signing keys" in checks[1]["detail"]
    assert checks[2]["detail"] == f"WorkOS could not find organization {ORG_ID} with this API key."


def test_connection_checks_need_saved_values() -> None:
    checks = workos.check_connection(client_id=" ", api_key=None, organization=ORG_ID)

    assert [check["detail"] for check in checks] == [
        "Save the WorkOS API key first.",
        "Enter the WorkOS client ID.",
        "Save the WorkOS API key to look up the organization.",
    ]


def test_connection_checks_survive_an_unreachable_workos(monkeypatch: pytest.MonkeyPatch) -> None:
    def unreachable(url: str, api_key: str | None, params: dict | None = None) -> httpx.Response:
        raise workos.WorkOSError("Could not reach WorkOS: connection refused")

    monkeypatch.setattr(workos, "_get", unreachable)

    checks = workos.check_connection(client_id=CLIENT_ID, api_key=API_KEY, organization=ORG_ID)

    assert {check["detail"] for check in checks} == {"Could not reach WorkOS: connection refused"}


def test_an_organization_without_domains_is_named_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    api = _WorkOSApi((200, {}), (200, {"keys": [{"kid": "k1"}, {"kid": "k2"}]}), (200, {"name": "Meridian Legal"}))
    monkeypatch.setattr(workos, "_get", api.get)

    checks = workos.check_connection(client_id=CLIENT_ID, api_key=API_KEY, organization=ORG_ID)

    assert checks[1]["detail"] == "WorkOS publishes 2 signing keys for this client."
    assert checks[2]["detail"] == "Meridian Legal"


def test_api_requests_carry_the_key_as_a_bearer_token(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict] = []

    def fake_get(url, headers=None, params=None, timeout=None):
        seen.append({"url": url, "headers": headers, "params": params})
        return httpx.Response(200, json={"keys": [{"kid": "k1"}], "data": []}, request=httpx.Request("GET", url))

    monkeypatch.setattr(workos.httpx, "get", fake_get)

    workos.check_connection(client_id=CLIENT_ID, api_key=API_KEY, organization=None)

    assert seen[0]["headers"]["Authorization"] == f"Bearer {API_KEY}"
    assert seen[0]["params"] == {"limit": "1"}
    # The signing keys are public: no key is sent for them.
    assert "Authorization" not in seen[1]["headers"]


def test_code_redemption_posts_json_and_reports_an_unreachable_workos(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[dict] = []

    def unreachable(url, json=None, headers=None, timeout=None):
        sent.append(json)
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(workos.httpx, "post", unreachable)

    with pytest.raises(workos.WorkOSError, match="Could not reach WorkOS: connection refused"):
        workos.authenticate_with_code(client_id=CLIENT_ID, api_key=API_KEY, code="c", code_verifier="v" * 43)

    assert sent == [
        {
            "grant_type": "authorization_code",
            "client_id": CLIENT_ID,
            "client_secret": API_KEY,
            "code": "c",
            "code_verifier": "v" * 43,
        }
    ]


def test_a_blocked_workos_address_is_never_called(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APERTURE_WORKOS_API_BASE_URL", "http://169.254.169.254")
    get_settings.cache_clear()
    monkeypatch.setattr(workos.httpx, "post", lambda *args, **kwargs: pytest.fail("WorkOS was called"))

    with pytest.raises(workos.WorkOSError, match="not permitted"):
        workos.authenticate_with_code(client_id=CLIENT_ID, api_key=API_KEY, code="c", code_verifier=None)


def test_an_organization_summary_skips_malformed_domain_entries(monkeypatch: pytest.MonkeyPatch) -> None:
    organization = {"name": "Meridian Legal", "domains": [{"domain": "meridian.test"}, "junk", {"state": "pending"}]}
    api = _WorkOSApi((200, {}), (200, {"keys": [{"kid": "k1"}]}), (200, organization))
    monkeypatch.setattr(workos, "_get", api.get)

    checks = workos.check_connection(client_id=CLIENT_ID, api_key=API_KEY, organization=ORG_ID)

    assert checks[2]["detail"] == "Meridian Legal (meridian.test)"
