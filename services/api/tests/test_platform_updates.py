"""The imported owner updater preserves role checks and honest deployment state."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
import threading

import pytest
from fastapi.testclient import TestClient

from app.core import clock, platform_updates
from app.core.config import Settings
from app.core.platform_updates import (
    UpdateCheckError,
    UpdateCheckRateLimited,
    UpdateChecker,
    UpdaterBridge,
    UpdaterBusy,
    parse_release_payload,
    update_checker,
)
from app.main import app
from app.repositories.deps import get_store

client = TestClient(app)
NOW = datetime(2026, 9, 5, 12, tzinfo=UTC)


@pytest.fixture(autouse=True)
def isolated_update_state(monkeypatch):
    get_store.cache_clear()
    update_checker.reset(lambda _settings: [])
    monkeypatch.setattr(clock, "now", lambda: NOW)
    # The updater scenarios have a fixed synthetic release catalog. Pin their
    # running build too, so a package bump cannot make the candidate older.
    monkeypatch.setattr(platform_updates, "APP_VERSION", "0.4.7")
    yield
    update_checker.reset()
    get_store.cache_clear()


def published_releases():
    return parse_release_payload([
        {"tag_name": "v0.4.8", "html_url": "https://example.com/v0.4.8",
         "body": "## Highlights\n- Clearer setup.\n## Deploy\nDeployment instructions."},
        {"tag_name": "v0.4.7", "body": "Current release."},
        {"tag_name": "v0.5.0-rc.1", "prerelease": True},
        {"tag_name": "v0.6.0", "draft": True},
    ])


def ready_bridge(tmp_path):
    (tmp_path / "heartbeat").write_text(f"ts={NOW.timestamp()}\nready=1\nproject=example\n")
    return UpdaterBridge(tmp_path)


@pytest.mark.parametrize("actor", ["user-admin", "user-jane"])
@pytest.mark.parametrize("method,path,payload", [
    ("get", "/api/platform/updates", None),
    ("post", "/api/platform/updates/check", None),
    ("post", "/api/platform/updates/apply", {"target_version": "v0.4.8"}),
])
def test_tenant_roles_cannot_read_check_or_apply_updates(actor, method, path, payload):
    response = client.request(method, path, json=payload, headers={"x-aperture-user": actor})
    assert response.status_code == 403
    assert update_checker.snapshot().last_attempt_at is None


def test_owner_status_excludes_drafts_and_requires_updater_to_apply(monkeypatch):
    from app.routes import platform_updates as routes

    monkeypatch.setattr(routes, "get_settings", lambda: Settings(release_version="0.4.7"))
    update_checker.reset(lambda _settings: published_releases())
    response = client.get("/api/platform/updates", headers={"x-aperture-user": "user-owner"})
    assert response.status_code == 200
    status = response.json()
    assert status["current_version"] == "v0.4.7"
    assert status["update_available"] is True
    assert [release["version"] for release in status["releases"]] == ["v0.4.8"]
    assert status["releases"][0]["highlights"] == "- Clearer setup."
    assert status["updater"]["configured"] is False
    response = client.post("/api/platform/updates/apply", json={"target_version": "v0.4.8"},
                           headers={"x-aperture-user": "user-owner"})
    assert response.status_code == 409
    assert "not configured" in response.json()["detail"]


def test_owner_apply_writes_one_request_and_audits_after_acceptance(tmp_path, monkeypatch):
    from app.routes import platform_updates as routes

    ready_bridge(tmp_path)
    settings = Settings(release_version="0.4.7", platform_updater_state_dir=str(tmp_path))
    monkeypatch.setattr(routes, "get_settings", lambda: settings)
    update_checker.reset(lambda _settings: published_releases())
    headers = {"x-aperture-user": "user-owner"}
    response = client.post("/api/platform/updates/apply", json={"target_version": "0.4.8"},
                           headers=headers)
    assert response.status_code == 202
    run = response.json()["updater"]["run"]
    assert run["phase"] == "requested"
    assert run["target_version"] == "v0.4.8"
    assert "requested_by=user-owner\n" in (tmp_path / "request").read_text()
    duplicate = client.post("/api/platform/updates/apply", json={"target_version": "0.4.8"},
                            headers=headers)
    assert duplicate.status_code == 409
    events = [event for event in get_store().audit_events
              if event.action == "platform.update_requested"]
    assert len(events) == 1
    assert events[0].metadata["request_id"] == run["id"]


def test_failed_check_keeps_last_release_but_records_failure_and_throttles(monkeypatch):
    checker = UpdateChecker()
    calls = []

    def fetch(_settings):
        calls.append(1)
        if len(calls) > 1:
            raise UpdateCheckError("Release lookup failed with HTTP 503.")
        return published_releases()

    checker.reset(fetch)
    settings = Settings()
    first = checker.refresh(settings)
    assert first.error is None
    assert checker.refresh(settings).checked_at == NOW
    assert len(calls) == 1
    with pytest.raises(UpdateCheckRateLimited):
        checker.refresh(settings, force=True)
    monkeypatch.setattr(clock, "now", lambda: NOW + timedelta(minutes=2))
    failed = checker.refresh(settings, force=True)
    assert failed.releases == first.releases
    assert failed.checked_at == NOW
    assert failed.error == "Release lookup failed with HTTP 503."
    assert checker.refresh(settings).error == failed.error
    assert len(calls) == 2


@pytest.mark.parametrize("timestamp", ["nan", "inf", "-inf", "bad", "999999999999"])
def test_invalid_heartbeat_never_claims_updater_is_connected(tmp_path, timestamp):
    (tmp_path / "heartbeat").write_text(f"ts={timestamp}\nready=1\n")
    connected, _seen, _project, problem = UpdaterBridge(tmp_path).heartbeat()
    assert connected is False
    assert problem


@pytest.mark.parametrize("timestamp", ["2026-09-05T11:00:00", "bad", ""])
def test_malformed_pending_request_does_not_crash_or_block_retries(tmp_path, timestamp):
    bridge = ready_bridge(tmp_path)
    (tmp_path / "request").write_text(
        "id=upd-old\ntarget_version=v0.4.8\nprevious_version=v0.4.7\n"
        f"requested_at={timestamp}\n"
    )
    assert bridge.run_status().phase == "failed"
    assert not (tmp_path / "request").exists()
    assert bridge.write_request(target_version="v0.4.8", previous_version="v0.4.7",
                                requested_by="user-owner").startswith("upd-")


def test_simultaneous_owner_requests_do_not_overwrite_each_other(tmp_path, monkeypatch):
    ready_bridge(tmp_path)
    original_write = platform_updates._write_kv_file
    entered_write = threading.Event()
    competing_write = threading.Event()

    def interleaved_write(path, values):
        if entered_write.is_set():
            competing_write.set()
        else:
            entered_write.set()
            competing_write.wait(timeout=0.15)
        original_write(path, values)

    monkeypatch.setattr(platform_updates, "_write_kv_file", interleaved_write)

    def request_update():
        try:
            return UpdaterBridge(tmp_path).write_request(
                target_version="v0.4.8", previous_version="v0.4.7", requested_by="user-owner"
            )
        except UpdaterBusy:
            return "busy"

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(request_update)
        assert entered_write.wait(timeout=2)
        second = pool.submit(request_update)
        outcomes = [first.result(timeout=2), second.result(timeout=2)]
    assert outcomes.count("busy") == 1
    accepted = next(outcome for outcome in outcomes if outcome != "busy")
    assert UpdaterBridge(tmp_path).run_status().id == accepted


def test_fresh_heartbeat_keeps_a_slow_image_pull_busy(tmp_path):
    bridge = ready_bridge(tmp_path)
    (tmp_path / "status").write_text(
        "id=upd-running\nphase=pulling\ntarget_version=v0.4.8\n"
        f"updated_at={(NOW - timedelta(hours=1)).isoformat()}\n"
    )
    assert bridge.run_status().phase == "pulling"
    with pytest.raises(UpdaterBusy):
        bridge.write_request(target_version="v0.4.8", previous_version="v0.4.7",
                             requested_by="user-owner")


def test_expired_unclaimed_request_remains_visible_after_audit_and_reload(tmp_path, monkeypatch):
    from app.routes import platform_updates as routes

    ready_bridge(tmp_path)
    (tmp_path / "request").write_text(
        "id=upd-unclaimed\ntarget_version=v0.4.8\nprevious_version=v0.4.7\n"
        "requested_by=user-owner\n"
        f"requested_at={(NOW - timedelta(minutes=10)).isoformat()}\n"
    )
    settings = Settings(release_version="0.4.7", platform_updater_state_dir=str(tmp_path))
    monkeypatch.setattr(routes, "get_settings", lambda: settings)
    update_checker.reset(lambda _settings: published_releases())
    for _ in range(2):
        response = client.get("/api/platform/updates", headers={"x-aperture-user": "user-owner"})
        assert response.status_code == 200
        assert response.json()["updater"]["run"]["phase"] == "failed"
        assert response.json()["updater"]["run"]["id"] == "upd-unclaimed"
    assert not (tmp_path / "request").exists()
    events = [event for event in get_store().audit_events if event.action == "platform.update_failed"]
    assert len(events) == 1
    retry = client.post("/api/platform/updates/apply", json={"target_version": "v0.4.8"},
                        headers={"x-aperture-user": "user-owner"})
    assert retry.status_code == 202
    assert retry.json()["updater"]["run"]["phase"] == "requested"
    assert not (tmp_path / "request-failure").exists()


def test_stale_environment_version_cannot_advertise_current_release():
    settings = Settings(release_version="v0.4.6")
    assert platform_updates.current_version(settings) == "v" + platform_updates.APP_VERSION


def test_fork_repository_selects_matching_release_endpoint(monkeypatch):
    import httpx

    seen = []
    monkeypatch.setattr(platform_updates, "validate_public_url", lambda _url: None)
    def respond(request):
        seen.append(str(request.url))
        return httpx.Response(200, json=[])
    platform_updates.fetch_releases(
        Settings(platform_update_repository="example/fork", platform_update_releases_url=""),
        transport=httpx.MockTransport(respond),
    )
    assert seen == ["https://api.github.com/repos/example/fork/releases?per_page=20"]
