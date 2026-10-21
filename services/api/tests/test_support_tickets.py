"""Support tickets end to end: reporting, triage, the reporter's view, and the
community hub that turns shared tickets into GitHub issues.

GitHub and remote hubs are simulated with ``httpx.MockTransport``; nothing
here reaches the network.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core import attachment_previews, mailer, support_hub, support_upstream
from app.core.config import get_settings
from app.core.rate_limit import ProcessLocalTokenBucket
from app.main import app
from app.routes import issue_reports
from app.models.schemas import SupportHubSubmission
from app.repositories.deps import get_store

client = TestClient(app)

DIAGNOSTICS = {
    "route": "/chat/thread-4f2a9c1e-77aa-4c55-8d0e-123456789abc?x=1",
    "viewport": "1440x900",
    "user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "color_scheme": "dark",
    "recent_errors": [{"message": "TypeError: x is undefined at jane.smith@example.com", "source": "index.js"}],
    "failed_requests": [{"method": "post", "path": "/api/chat/thread-abc123def/messages", "status": 500}],
    "unexpected": "dropped",
}


@pytest.fixture(autouse=True)
def reset_store(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        attachment_previews,
        "get_settings",
        lambda: SimpleNamespace(runtime_state_path=str(tmp_path / "runtime_state.json")),
    )
    # Per-person submit limits are process-wide; give every test a fresh budget.
    monkeypatch.setattr(issue_reports, "_REPORT_BUCKETS", ProcessLocalTokenBucket(max_entries=100, idle_ttl_seconds=60))
    get_store.cache_clear()
    yield
    get_store.cache_clear()


def headers(user_id: str) -> dict[str, str]:
    return {"x-aperture-user": user_id}


def submit(user_id: str = "user-jane", **fields: str) -> dict:
    data = {
        "subject": "Export button freezes",
        "body": "The export button stays on Preparing after I select PDF.",
        **fields,
    }
    response = client.post("/api/issue-reports", data=data, headers=headers(user_id))
    assert response.status_code == 201, response.text
    return response.json()


class FakeGitHub:
    """Just enough of the GitHub REST API for issue filing and status sync."""

    def __init__(self) -> None:
        self.created: list[dict] = []
        self.comments: list[tuple[int, str]] = []
        self.issue_state = {"state": "open", "state_reason": None}
        self.search_items: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        assert request.headers["authorization"] == "Bearer ghp_testtoken1234567890"
        if request.method == "POST" and path.endswith("/issues"):
            payload = json.loads(request.content)
            self.created.append(payload)
            return httpx.Response(
                201,
                json={
                    "number": 42,
                    "title": payload["title"],
                    "state": "open",
                    "html_url": "https://github.com/Aperture-Chat/Aperture-Chat/issues/42",
                },
            )
        if request.method == "POST" and path.endswith("/comments"):
            number = int(path.split("/")[-2])
            self.comments.append((number, json.loads(request.content)["body"]))
            return httpx.Response(201, json={"id": 1})
        if request.method == "GET" and path.startswith("/repos/") and "/issues/" in path:
            number = int(path.rsplit("/", 1)[-1])
            return httpx.Response(
                200,
                json={
                    "number": number,
                    "title": "Existing",
                    "html_url": f"https://github.com/Aperture-Chat/Aperture-Chat/issues/{number}",
                    **self.issue_state,
                },
            )
        if request.method == "GET" and path == "/search/issues":
            return httpx.Response(200, json={"items": self.search_items})
        if request.method == "GET" and path.startswith("/repos/"):
            return httpx.Response(200, json={"full_name": "Aperture-Chat/Aperture-Chat", "has_issues": True})
        return httpx.Response(404, json={"message": "Not Found"})


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGitHub:
    fake = FakeGitHub()
    original = support_hub.github_client
    monkeypatch.setattr(
        support_hub,
        "github_client",
        lambda store, settings, transport=None: original(
            store, settings, transport=transport or httpx.MockTransport(fake.handler)
        ),
    )
    return fake


def enable_hub(token: str = "ghp_testtoken1234567890", **extra) -> dict:
    response = client.patch(
        "/api/platform/support/settings",
        json={"hub_enabled": True, "hub_github_token": token, **extra},
        headers=headers("user-owner"),
    )
    assert response.status_code == 200, response.text
    return response.json()


# --- Reporting and the reporter's view --------------------------------------------------


def test_reports_are_numbered_typed_and_keep_cleaned_diagnostics() -> None:
    first = submit(kind="feature", priority="high", diagnostics=json.dumps(DIAGNOSTICS))
    second = submit(user_id="user-casey")

    assert (first["number"], second["number"]) == (1, 2)
    assert first["kind"] == "feature" and first["priority"] == "high"
    assert first["status"] == "new"
    diagnostics = first["diagnostics"]
    assert "unexpected" not in diagnostics
    assert diagnostics["reporter_role"] == "USER"
    assert diagnostics["app_version"]
    assert diagnostics["failed_requests"][0] == {
        "method": "POST",
        "path": "/api/chat/:id/messages",
        "status": 500,
        "at": "",
    }

    urgent = client.post(
        "/api/issue-reports",
        data={"subject": "Hi", "body": "Please", "priority": "urgent"},
        headers=headers("user-jane"),
    )
    assert urgent.status_code == 400
    assert get_store().audit_events_newest_first(limit=1)[0].action == "support.issue_reported"


def test_reporter_sees_only_own_tickets_and_public_timeline() -> None:
    report = submit()
    submit(user_id="user-casey")

    mine = client.get("/api/issue-reports/mine", headers=headers("user-jane")).json()
    assert [item["id"] for item in mine] == [report["id"]]
    assert mine[0]["unread"] is False
    assert client.get(f"/api/issue-reports/mine/{report['id']}", headers=headers("user-casey")).status_code == 404

    note = client.post(
        f"/api/admin/issue-reports/{report['id']}/comments",
        json={"body": "Internal: likely the PDF worker.", "visibility": "internal"},
        headers=headers("user-admin"),
    )
    assert note.status_code == 200
    assert client.get("/api/issue-reports/mine", headers=headers("user-jane")).json()[0]["unread"] is False

    reply = client.post(
        f"/api/admin/issue-reports/{report['id']}/comments",
        json={"body": "Thanks, which browser are you using?", "visibility": "public"},
        headers=headers("user-admin"),
    )
    assert reply.json()["report"]["status"] == "in_review"

    listed = client.get("/api/issue-reports/mine", headers=headers("user-jane")).json()[0]
    assert listed["unread"] is True
    assert listed["assignee_name"] is None
    detail = client.get(f"/api/issue-reports/mine/{report['id']}", headers=headers("user-jane")).json()
    bodies = [event["body"] for event in detail["events"]]
    assert "Internal: likely the PDF worker." not in bodies
    assert "Thanks, which browser are you using?" in bodies
    assert {event["actor_name"] for event in detail["events"] if event["actor_kind"] == "support"} == {
        "Support team"
    }

    assert client.post(f"/api/issue-reports/mine/{report['id']}/seen", headers=headers("user-jane")).status_code == 204
    assert client.get("/api/issue-reports/mine", headers=headers("user-jane")).json()[0]["unread"] is False

    answer = client.post(
        f"/api/issue-reports/mine/{report['id']}/comments",
        json={"body": "Chrome 141 on macOS."},
        headers=headers("user-jane"),
    )
    assert answer.status_code == 200
    queue = client.get("/api/admin/issue-reports/queue", headers=headers("user-admin")).json()
    # Jane answered, and Casey's untouched report also waits on support.
    assert queue["counts"]["needs_reply"] == 2
    jane_row = next(item for item in queue["items"] if item["id"] == report["id"])
    assert jane_row["last_activity_by"] == "reporter" and jane_row["status"] == "in_review"


def test_status_changes_notify_and_closed_tickets_reopen(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    store.email_settings.host = "smtp.example.com"
    store.email_settings.from_address = "support@example.com"
    sent: list[dict] = []
    monkeypatch.setattr(mailer, "send_email", lambda **kwargs: sent.append(kwargs))
    report = submit()

    resolved = client.patch(
        f"/api/admin/issue-reports/{report['id']}",
        json={"status": "resolved", "note": "Fixed by restarting the export worker.", "priority": "high"},
        headers=headers("user-admin"),
    )
    assert resolved.status_code == 200
    body = resolved.json()
    assert body["report"]["status"] == "resolved"
    assert body["report"]["resolved_at"]
    kinds = {(event["kind"], event["visibility"]) for event in body["events"]}
    assert ("status", "public") in kinds and ("priority", "internal") in kinds
    assert len(sent) == 1
    assert sent[0]["recipients"] == ["jane.smith@example.com"]
    assert "Resolved" in sent[0]["body_text"]

    blocked = client.post(
        f"/api/issue-reports/mine/{report['id']}/comments",
        json={"body": "Still broken"},
        headers=headers("user-jane"),
    )
    assert blocked.status_code == 409
    reopened = client.post(
        f"/api/issue-reports/mine/{report['id']}/reopen",
        json={"body": "It happened again today."},
        headers=headers("user-jane"),
    )
    assert reopened.status_code == 200
    assert reopened.json()["report"]["status"] == "new"
    assert reopened.json()["report"]["resolved_at"] is None


def test_assignment_is_limited_to_the_tickets_administrators() -> None:
    report = submit()
    queue = client.get("/api/admin/issue-reports/queue", headers=headers("user-admin")).json()
    assert "user-owner" not in {option["id"] for option in queue["assignees"]}

    to_owner = client.patch(
        f"/api/admin/issue-reports/{report['id']}",
        json={"assignee_user_id": "user-owner"},
        headers=headers("user-admin"),
    )
    assert to_owner.status_code == 400
    assigned = client.patch(
        f"/api/admin/issue-reports/{report['id']}",
        json={"assignee_user_id": "user-admin"},
        headers=headers("user-admin"),
    )
    assert assigned.json()["report"]["assignee_name"] == "Alex Morgan"
    cleared = client.patch(
        f"/api/admin/issue-reports/{report['id']}",
        json={"assignee_user_id": ""},
        headers=headers("user-admin"),
    )
    assert cleared.json()["report"]["assignee_user_id"] is None


def test_admin_scope_and_owner_only_sharing() -> None:
    owner_report = submit(user_id="user-owner")
    user_report = submit()

    admin_ids = {item["id"] for item in client.get("/api/admin/issue-reports", headers=headers("user-admin")).json()}
    assert admin_ids == {user_report["id"]}
    assert client.get(f"/api/admin/issue-reports/{owner_report['id']}", headers=headers("user-admin")).status_code == 404
    assert client.get("/api/admin/issue-reports/queue", headers=headers("user-casey")).status_code == 403
    draft = client.post(
        f"/api/admin/issue-reports/{user_report['id']}/upstream/draft",
        json={},
        headers=headers("user-admin"),
    )
    assert draft.status_code == 403
    assert client.get("/api/platform/support/settings", headers=headers("user-admin")).status_code == 403


# --- Redaction and drafts -------------------------------------------------------------------


def test_redaction_removes_people_organizations_links_and_tokens() -> None:
    text = (
        "Jane Smith at Example Corporation emailed jane.smith@example.com from "
        "https://chat.example.com/chat/thread-1 and intranet.corp, see "
        "https://github.com/Aperture-Chat/Aperture-Chat/issues/3, log at /Users/jsmith/app.log, "
        "token abcd1234efgh5678ijkl9012mnop3456qrst"
    )
    redacted, count = support_upstream.redact_for_sharing(
        text,
        people=["Jane Smith"],
        organizations=["Example Corporation"],
        hosts=["chat.example.com"],
    )
    for secret in ("Jane Smith", "Example Corporation", "jane.smith@", "chat.example.com", "intranet.corp", "jsmith", "abcd1234"):
        assert secret not in redacted
    assert "https://github.com/Aperture-Chat/Aperture-Chat/issues/3" in redacted
    assert count >= 7


def test_share_draft_redacts_previews_and_blocks_security() -> None:
    report = submit(
        subject="Jane Smith can't export",
        body="@octocat Export fails for Example Corporation. See #12 <img src=x>",
        diagnostics=json.dumps(DIAGNOSTICS),
    )
    draft = client.post(
        f"/api/admin/issue-reports/{report['id']}/upstream/draft",
        json={"include_diagnostics": True},
        headers=headers("user-owner"),
    ).json()
    assert "Jane Smith" not in draft["title"]
    assert "Example Corporation" not in draft["body"]
    assert draft["diagnostics"]["area"] == "/chat/:id"
    assert draft["diagnostics"]["browser"] == "Chrome 141"
    assert "jane.smith@example.com" not in json.dumps(draft["diagnostics"])
    preview = draft["preview_markdown"]
    assert "@​octo" in preview and "#​12" in preview and "<img" not in preview
    assert "template=bug_report.yml" in draft["github_new_issue_url"]
    assert draft["hub_available"] is True

    security = submit(kind="security", subject="XSS in titles", body="A chat title runs script.")
    blocked = client.post(
        f"/api/admin/issue-reports/{security['id']}/upstream/draft",
        json={},
        headers=headers("user-owner"),
    ).json()
    assert blocked["hub_available"] is False
    assert blocked["github_new_issue_url"].endswith("/security/advisories/new")
    refused = client.post(
        f"/api/admin/issue-reports/{security['id']}/upstream",
        json={"title": "XSS in titles", "body": "A chat title runs script."},
        headers=headers("user-owner"),
    )
    assert refused.status_code == 409


# --- The community hub -----------------------------------------------------------------------


def test_hub_public_api_requires_enablement_and_receipt() -> None:
    submission = {
        "instance_id": "instance-1234abcd",
        "title": "Export freezes on PDF",
        "body": "Selecting PDF export leaves the dialog on Preparing; mail me at a@b.example",
    }
    assert client.post("/api/support-hub/v1/reports", json=submission).status_code == 404
    assert client.get("/api/support-hub/v1/info").json()["accepting"] is False

    enable_hub()
    info = client.get("/api/support-hub/v1/info").json()
    assert info == {"accepting": True, "repository": "Aperture-Chat/Aperture-Chat", "version": info["version"]}
    receipt = client.post("/api/support-hub/v1/reports", json=submission)
    assert receipt.status_code == 201
    receipt = receipt.json()
    stored = get_store().support_ticket_repository.get_hub_report(receipt["id"])
    assert "a@b.example" not in stored.body
    assert stored.receipt_hash != receipt["token"]

    assert client.get(f"/api/support-hub/v1/reports/{receipt['id']}").status_code == 404
    wrong = client.get(
        f"/api/support-hub/v1/reports/{receipt['id']}", headers={"Authorization": "Bearer nope"}
    )
    assert wrong.status_code == 404
    status = client.get(
        f"/api/support-hub/v1/reports/{receipt['id']}",
        headers={"Authorization": f"Bearer {receipt['token']}"},
    )
    assert status.status_code == 200
    assert status.json()["status"] == "pending"


def test_hub_limits_each_deployment_and_keeps_security_private() -> None:
    enable_hub()
    store = get_store()
    settings = get_settings()
    base = {"title": "Export freezes on PDF", "body": "Selecting PDF export never finishes."}
    for index in range(support_hub.INSTANCE_LIMITS[0][1]):
        support_hub.receive_submission(
            store,
            settings,
            SupportHubSubmission(instance_id="instance-flood01", **base),
            source=f"203.0.113.{index}",
        )
    with pytest.raises(support_hub.SupportHubRejected) as rejected:
        support_hub.receive_submission(
            store, settings, SupportHubSubmission(instance_id="instance-flood01", **base), source="198.51.100.1"
        )
    assert rejected.value.status_code == 429

    private = support_hub.receive_submission(
        store,
        settings,
        SupportHubSubmission(instance_id="instance-secure1", kind="security", **base),
        source="198.51.100.2",
    )
    assert private.status == "private"
    report = store.support_ticket_repository.get_hub_report(private.id)
    with pytest.raises(support_hub.GitHubError):
        support_hub.publish(
            store, settings, report, actor_name="Owner", title=report.title, body=report.body, labels=[]
        )


def test_shared_ticket_becomes_a_github_issue_and_status_flows_back(github: FakeGitHub) -> None:
    enable_hub()
    report = submit(diagnostics=json.dumps(DIAGNOSTICS))

    shared = client.post(
        f"/api/admin/issue-reports/{report['id']}/upstream",
        json={
            "title": "Export freezes for Jane Smith",
            "body": "Export never finishes. Contact jane.smith@example.com.",
            "include_diagnostics": True,
        },
        headers=headers("user-owner"),
    )
    assert shared.status_code == 200, shared.text
    upstream = shared.json()["report"]["upstream"]
    assert upstream["state"] == "sent"
    assert "Jane Smith" not in upstream["sent_title"]
    assert "jane.smith@example.com" not in upstream["sent_body"]

    queue = client.get("/api/platform/support-hub/reports", headers=headers("user-owner")).json()
    assert queue["counts"]["pending"] == 1
    hub_report = queue["items"][0]
    assert hub_report["diagnostics"]["area"] == "/chat/:id"

    github.search_items = [{"number": 7, "title": "PDF export hangs", "state": "open", "html_url": "https://github.com/Aperture-Chat/Aperture-Chat/issues/7"}]
    triaged = client.post(
        f"/api/platform/support-hub/reports/{hub_report['id']}/triage", headers=headers("user-owner")
    ).json()
    assert triaged["triage"]["candidates"][0]["number"] == 7

    published = client.post(
        f"/api/platform/support-hub/reports/{hub_report['id']}/publish",
        json={"title": "PDF export never finishes", "body": hub_report["body"], "labels": ["bug", "nope"]},
        headers=headers("user-owner"),
    )
    assert published.status_code == 200, published.text
    assert published.json()["issue_number"] == 42
    created = github.created[0]
    assert created["title"] == "[Bug]: PDF export never finishes"
    assert created["labels"] == ["bug", "in-app report"]
    assert "Hub reference" in created["body"]

    refreshed = client.post(
        f"/api/admin/issue-reports/{report['id']}/upstream/refresh", headers=headers("user-owner")
    ).json()
    assert refreshed["report"]["upstream"]["issue_number"] == 42
    mine = client.get(f"/api/issue-reports/mine/{report['id']}", headers=headers("user-jane")).json()
    assert mine["report"]["upstream"]["issue_url"].endswith("/issues/42")
    assert mine["report"]["upstream"]["sent_body"] == ""
    assert any("GitHub issue #42" in event["body"] for event in mine["events"])
    assert mine["report"]["unread"] is True
    # Hub updates are news for the reporter, not a support reply.
    queue = client.get("/api/admin/issue-reports/queue", headers=headers("user-admin")).json()
    assert queue["items"][0]["last_activity_by"] == "reporter"
    assert queue["counts"]["needs_reply"] == 1

    github.issue_state = {"state": "closed", "state_reason": "completed"}
    store = get_store()
    support_hub.sync_issue(store, get_settings(), store.support_ticket_repository.get_hub_report(hub_report["id"]))
    client.post(f"/api/admin/issue-reports/{report['id']}/upstream/refresh", headers=headers("user-owner"))
    events = client.get(f"/api/issue-reports/mine/{report['id']}", headers=headers("user-jane")).json()["events"]
    assert "closed as completed" in events[-1]["body"]


def test_linking_to_an_existing_issue_comments_there(github: FakeGitHub) -> None:
    enable_hub()
    receipt = support_hub.receive_submission(
        get_store(),
        get_settings(),
        SupportHubSubmission(instance_id="instance-linker1", title="PDF export hangs", body="Same as the known PDF hang."),
        source="198.51.100.9",
    )
    linked = client.post(
        f"/api/platform/support-hub/reports/{receipt.id}/link",
        json={"issue_number": 7, "comment": "Seen on another deployment."},
        headers=headers("user-owner"),
    )
    assert linked.status_code == 200
    assert linked.json()["status"] == "linked"
    assert github.comments[0][0] == 7
    declined = client.post(
        f"/api/platform/support-hub/reports/{receipt.id}/decline",
        json={"reason": "dup"},
        headers=headers("user-owner"),
    )
    assert declined.status_code == 409


def test_remote_hub_round_trip_over_http(monkeypatch: pytest.MonkeyPatch) -> None:
    store = get_store()
    settings = get_settings().model_copy(update={"support_hub_url": "https://hub.example.test"})
    received: list[dict] = []

    def hub(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/api/support-hub/v1/reports":
            received.append(json.loads(request.content))
            return httpx.Response(201, json={"id": "hubreport-1", "token": "receipt-token", "status": "pending"})
        if request.url.path == "/api/support-hub/v1/reports/hubreport-1":
            assert request.headers["authorization"] == "Bearer receipt-token"
            return httpx.Response(
                200,
                json={
                    "id": "hubreport-1",
                    "status": "published",
                    "issue_number": 9,
                    "issue_url": "https://github.com/Aperture-Chat/Aperture-Chat/issues/9",
                    "issue_state": "open",
                    "updated_at": "2026-10-21T00:00:00Z",
                },
            )
        return httpx.Response(404)

    transport = httpx.MockTransport(hub)
    store.support_ticket_repository.save_settings(
        store.support_ticket_repository.get_settings().model_copy(update={"upstream_mode": "automatic"})
    )
    report = store.support_ticket_repository.get_report(submit(diagnostics=json.dumps(DIAGNOSTICS))["id"])
    # Automatic mode queued it at submission; one scheduler pass sends it.
    queued = store.support_ticket_repository.get_upstream(report.id)
    assert queued is not None and queued.state == "queued"
    store.support_ticket_repository.save_upstream(queued.model_copy(update={"hub_url": "https://hub.example.test"}))
    assert support_upstream.support_upstream_pass(store, settings, transport=transport) == 1
    sent = store.support_ticket_repository.get_upstream(report.id)
    assert sent.state == "sent" and sent.receipt_token == "receipt-token"
    payload = received[0]
    assert payload["instance_id"] == store.support_ticket_repository.get_settings().instance_id
    assert "Jane" not in json.dumps(payload)
    assert "jane.smith@example.com" not in json.dumps(payload)

    polled = support_upstream.poll_link(store, settings, sent, transport=transport)
    assert polled.state == "published" and polled.issue_number == 9


def test_failed_sends_back_off_and_stop_retrying() -> None:
    store = get_store()
    settings = get_settings().model_copy(update={"support_hub_url": "https://hub.example.test"})
    report = store.support_ticket_repository.get_report(submit()["id"])
    link = support_upstream.queue_share(
        store,
        settings,
        report,
        title="Export freezes",
        body="Export never finishes on PDF.",
        include_diagnostics=False,
        shared_by_user_id="user-owner",
        shared_by_name="Owner",
    )
    down = httpx.MockTransport(lambda request: httpx.Response(503, json={"detail": "Hub is down."}))
    failed = support_upstream.send_link(store, settings, link, transport=down)
    assert failed.state == "failed" and failed.attempts == 1
    assert failed.last_error == "Hub is down."
    assert failed.next_attempt_at is not None
    final = failed.model_copy(update={"attempts": support_upstream.MAX_SEND_ATTEMPTS - 1})
    final = support_upstream.send_link(store, settings, final, transport=down)
    assert final.next_attempt_at is None


def test_support_settings_store_token_masked_and_validate() -> None:
    view = enable_hub(hub_repository="Aperture-Chat/Aperture-Chat")
    assert view["hub_token_set"] is True
    assert "ghp_testtoken1234567890" not in json.dumps(view)
    bad = client.patch(
        "/api/platform/support/settings",
        json={"hub_repository": "not a repo"},
        headers=headers("user-owner"),
    )
    assert bad.status_code == 400
    bad_model = client.patch(
        "/api/platform/support/settings",
        json={"ai_model_id": "missing-model"},
        headers=headers("user-owner"),
    )
    assert bad_model.status_code == 400
    cleared = client.patch(
        "/api/platform/support/settings",
        json={"hub_github_token": "", "upstream_mode": "off"},
        headers=headers("user-owner"),
    ).json()
    assert cleared["hub_token_set"] is False and cleared["upstream_mode"] == "off"
    assert get_store().audit_events_newest_first(limit=1)[0].action == "support.settings_updated"
