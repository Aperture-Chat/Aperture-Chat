"""Shared drafts over HTTP: sharing, collaborator access, live copy, events."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.core.draft_live_hub import DraftLiveHub, get_draft_live_hub
from app.db import create_application_engine, upgrade_database
from app.models.schemas import Group, Role, Tenant, User
from app.repositories.deps import get_store
from app.repositories.draft_collaboration import DraftCollaborationRepository
from app.routes import draft_collaboration as collab_routes
from app.routes.dependencies import current_user
from app.routes.matters import MatterActorScope, get_matter_draft_repository, router as matters_router


def _user(
    user_id: str,
    name: str,
    *groups: str,
    tenant: str | None = "tenant-a",
    active: bool = True,
    role: Role = Role.USER,
) -> User:
    return User(
        id=user_id,
        tenant_id=tenant,
        email=f"{user_id}@example.test",
        display_name=name,
        role=role,
        group_ids=list(groups),
        active=active,
    )


def _group(group_id: str, name: str, tenant: str = "tenant-a") -> Group:
    return Group(id=group_id, tenant_id=tenant, name=name, distinguished_name=name, entra_object_id=group_id)


class Directory:
    def __init__(self) -> None:
        self.tenants = {"tenant-a": Tenant(id="tenant-a", name="Tenant A", slug="tenant-a")}
        self.groups = {
            "group-lit": _group("group-lit", "Litigation"),
            "group-tax": _group("group-tax", "Tax"),
            "group-other": _group("group-other", "Elsewhere", tenant="tenant-b"),
        }
        self.users = {
            user.id: user
            for user in (
                _user("ana", "Ana Owner", "group-lit"),
                _user("ben", "Ben Partner", "group-lit"),
                _user("cy", "Cy Associate", "group-lit", "group-tax"),
                _user("dee", "Dee Tax", "group-tax"),
                _user("old", "Old Partner", "group-lit", active=False),
                _user("far", "Far Away", "group-lit", tenant="tenant-b"),
                _user("alex", "Alex Admin", role=Role.TENANT_ADMIN),
                _user("olive", "Olive Owner", tenant=None, role=Role.PLATFORM_OWNER),
                _user("otto", "Otto Owner", tenant=None, role=Role.PLATFORM_OWNER),
            )
        }
        self.audit_actions: list[tuple[str, str, str, dict]] = []

    def tenant_by_slug(self, slug: str) -> Tenant | None:
        return next((tenant for tenant in self.tenants.values() if tenant.slug == slug), None)

    def record_audit(self, actor: User, action: str, target: str, metadata=None, **_kwargs) -> None:
        self.audit_actions.append((actor.id, action, target, metadata or {}))


@pytest.fixture
def api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    engine = create_application_engine(f"sqlite:///{tmp_path / 'collab-routes.sqlite3'}")
    upgrade_database(engine)
    repository = DraftCollaborationRepository(engine)
    directory = Directory()
    hub = DraftLiveHub()
    actor = {"value": directory.users["ana"]}
    app = FastAPI()
    app.include_router(matters_router)
    app.include_router(collab_routes.router)
    app.dependency_overrides[current_user] = lambda: actor["value"]
    app.dependency_overrides[get_store] = lambda: directory
    app.dependency_overrides[get_matter_draft_repository] = lambda: repository
    app.dependency_overrides[get_draft_live_hub] = lambda: hub
    # Streams re-validate the signed session; tests sign in by override instead.
    monkeypatch.setattr(collab_routes, "_current_session_user", lambda *_args: actor["value"])
    client = TestClient(app)

    def as_user(user_id: str) -> TestClient:
        actor["value"] = directory.users[user_id]
        return client

    try:
        yield as_user, directory, repository
    finally:
        client.close()
        engine.dispose()


def _create_memo(client: TestClient) -> str:
    created = client.post("/api/drafts", json={"title": "Memo", "content": "<p>First.</p>"})
    assert created.status_code == 201
    return created.json()["document"]["id"]


def _share(client: TestClient, draft_id: str, *, groups=(), people=()) -> dict:
    response = client.put(
        f"/api/drafts/{draft_id}/sharing", json={"group_ids": list(groups), "user_ids": list(people)}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_the_directory_offers_my_groups_and_the_active_people_in_them(api) -> None:
    as_user, _directory, _repository = api

    directory = as_user("cy").get("/api/draft-sharing/directory").json()

    assert [(g["name"], g["member_count"]) for g in directory["groups"]] == [("Litigation", 3), ("Tax", 2)]
    assert [person["display_name"] for person in directory["people"]] == ["Ana Owner", "Ben Partner", "Dee Tax"]


def test_drafts_are_private_until_the_owner_shares_them(api) -> None:
    as_user, _directory, _repository = api
    draft_id = _create_memo(as_user("ana"))

    assert as_user("ben").get(f"/api/drafts/{draft_id}").status_code == 404
    assert as_user("ana").get(f"/api/drafts/{draft_id}/sharing").json()["groups"] == []


def test_the_owner_shares_with_a_group_or_a_person_and_it_is_audited(api) -> None:
    as_user, directory, _repository = api
    draft_id = _create_memo(as_user("ana"))

    sharing = _share(as_user("ana"), draft_id, groups=["group-lit"])
    assert [group["name"] for group in sharing["groups"]] == ["Litigation"]
    assert directory.audit_actions[-1][:3] == ("ana", "draft.sharing_updated", draft_id)
    assert as_user("ben").get(f"/api/drafts/{draft_id}").status_code == 200
    assert as_user("dee").get(f"/api/drafts/{draft_id}").status_code == 404

    sharing = _share(as_user("ana"), draft_id, people=["cy"])
    assert ([g["id"] for g in sharing["groups"]], [p["id"] for p in sharing["people"]]) == ([], ["cy"])
    assert as_user("ben").get(f"/api/drafts/{draft_id}").status_code == 404
    collaborator_view = as_user("cy").get(f"/api/drafts/{draft_id}/sharing").json()
    assert (collaborator_view["role"], collaborator_view["can_manage"]) == ("collaborator", False)
    assert collaborator_view["owner"]["display_name"] == "Ana Owner"


def test_only_the_owner_manages_sharing_and_only_within_their_groups(api) -> None:
    as_user, _directory, _repository = api
    draft_id = _create_memo(as_user("ana"))
    _share(as_user("ana"), draft_id, people=["ben"])

    refused = as_user("ben").put(f"/api/drafts/{draft_id}/sharing", json={"group_ids": [], "user_ids": ["cy"]})
    assert refused.status_code == 403
    for payload in ({"group_ids": ["group-tax"], "user_ids": []}, {"group_ids": [], "user_ids": ["dee"]},
                    {"group_ids": [], "user_ids": ["old"]}, {"group_ids": ["group-other"], "user_ids": []}):
        assert as_user("ana").put(f"/api/drafts/{draft_id}/sharing", json=payload).status_code == 422


def test_a_collaborator_edits_the_content_but_not_the_matter(api) -> None:
    as_user, _directory, repository = api
    draft_id = _create_memo(as_user("ana"))
    _share(as_user("ana"), draft_id, people=["ben"])

    saved = as_user("ben").put(f"/api/drafts/{draft_id}", json={"expected_revision": 1, "content": "<p>Ben.</p>"})
    assert saved.status_code == 200
    assert saved.json()["document"]["owner_user_id"] == "ana"
    moved = as_user("ben").put(f"/api/drafts/{draft_id}", json={"expected_revision": 2, "matter_id": None})
    assert moved.status_code == 403
    assert as_user("ben").delete(f"/api/drafts/{draft_id}?expected_revision=2").status_code == 404
    versions = as_user("ana").get(f"/api/drafts/{draft_id}/versions").json()
    assert [(v["revision"], v["author_name"]) for v in versions] == [(2, "Ben Partner"), (1, "Ana Owner")]
    assert repository.get_draft(draft_id, tenant_id="tenant-a", owner_user_id="ana").revision.content == "<p>Ben.</p>"


def test_the_live_copy_autosaves_with_compare_and_set(api) -> None:
    as_user, _directory, _repository = api
    draft_id = _create_memo(as_user("ana"))
    _share(as_user("ana"), draft_id, people=["ben"])

    start = as_user("ben").get(f"/api/drafts/{draft_id}/live").json()
    assert (start["live"]["seq"], start["live"]["content"], start["role"]) == (0, "<p>First.</p>", "collaborator")
    saved = as_user("ben").put(
        f"/api/drafts/{draft_id}/live",
        json={"expected_seq": 0, "client_id": "client-ben-1", "content": "<p>First. Ben.</p>"},
    )
    assert saved.status_code == 200
    assert (saved.json()["live"]["seq"], saved.json()["updated_by_name"]) == (1, "Ben Partner")

    stale = as_user("ana").put(
        f"/api/drafts/{draft_id}/live",
        json={"expected_seq": 0, "client_id": "client-ana-1", "content": "<p>First. Ana.</p>"},
    )
    assert stale.status_code == 409
    assert (stale.json()["live"]["seq"], stale.json()["live"]["content"]) == (1, "<p>First. Ben.</p>")

    version = as_user("ana").post(f"/api/drafts/{draft_id}/live/version", json={"client_id": "client-ana-1"})
    assert version.status_code == 200
    assert (version.json()["document"]["current_revision"], version.json()["revision"]["content"]) == (
        2,
        "<p>First. Ben.</p>",
    )
    old = as_user("ben").get(f"/api/drafts/{draft_id}/versions/1").json()
    assert (old["revision"]["content"], old["author_name"]) == ("<p>First.</p>", "Ana Owner")


def test_shared_with_me_names_the_owner_and_mine_counts_my_shares(api) -> None:
    as_user, _directory, _repository = api
    draft_id = _create_memo(as_user("ana"))
    _share(as_user("ana"), draft_id, groups=["group-lit"], people=["cy"])

    shared = as_user("cy").get("/api/draft-sharing/shared-with-me").json()
    assert [(item["document"]["id"], item["owner"]["display_name"], item["shared_via"]) for item in shared] == [
        (draft_id, "Ana Owner", "user")
    ]
    assert as_user("ana").get("/api/draft-sharing/mine").json() == [
        {"draft_id": draft_id, "group_count": 1, "people_count": 1}
    ]


def test_a_matter_draft_is_shared_only_with_people_on_the_matter(api) -> None:
    as_user, _directory, repository = api
    matter = repository.create_matter(tenant_id="tenant-a", name="Acme", creator_user_id="ana")
    created = as_user("ana").post(
        "/api/drafts", json={"title": "Memo", "content": "<p>x</p>", "matter_id": matter.id}
    )
    draft_id = created.json()["document"]["id"]

    refused = as_user("ana").put(f"/api/drafts/{draft_id}/sharing", json={"group_ids": [], "user_ids": ["ben"]})
    assert refused.status_code == 422
    assert "Ben Partner" in refused.json()["detail"]
    sharing = _share(as_user("ana"), draft_id, groups=["group-lit"])
    assert sharing["matter_bound"] is True
    # The group share stands, but the matter wall still applies to Ben.
    assert as_user("ben").get(f"/api/drafts/{draft_id}").status_code == 404


def test_presence_needs_an_open_stream(api) -> None:
    as_user, _directory, _repository = api
    draft_id = _create_memo(as_user("ana"))

    response = as_user("ana").put(
        f"/api/drafts/{draft_id}/live/presence", json={"client_id": "client-ana-1", "focus": None}
    )
    assert response.status_code == 404


def _parse_frames(chunks: list[str]) -> list[tuple[str, dict]]:
    events = []
    for frame in "".join(chunks).split("\n\n"):
        lines = dict(line.split(": ", 1) for line in frame.splitlines() if ": " in line and not line.startswith(":"))
        if "event" in lines:
            events.append((lines["event"], json.loads(lines["data"])))
    return events


class _OpenRequest:
    async def is_disconnected(self) -> bool:
        return False


def test_the_event_stream_announces_edits_and_ends_when_access_is_revoked(api, monkeypatch) -> None:
    """Drives the stream on its own loop: Starlette's TestClient buffers a
    whole response, so it cannot read an endless event stream."""

    as_user, directory, repository = api
    monkeypatch.setattr(collab_routes, "STREAM_POLL_SECONDS", 0.05)
    draft_id = _create_memo(as_user("ana"))
    _share(as_user("ana"), draft_id, people=["ben"])
    hub = as_user("ana").app.dependency_overrides[get_draft_live_hub]()
    ben = directory.users["ben"]
    scope = MatterActorScope(actor=ben, tenant_id="tenant-a", store=directory)

    def ana_edits_then_unshares() -> None:
        owner = as_user("ana")
        owner.put(
            f"/api/drafts/{draft_id}/live",
            json={"expected_seq": 0, "client_id": "client-ana-1", "content": "<p>Ana typed.</p>"},
        )
        owner.put(f"/api/drafts/{draft_id}/sharing", json={"group_ids": [], "user_ids": []})

    async def scenario() -> list[str]:
        response = await collab_routes.draft_live_events(
            draft_id,
            _OpenRequest(),  # type: ignore[arg-type]
            client_id="client-ben-1",
            scope=scope,
            repository=repository,
            hub=hub,
            x_aperture_session=None,
            x_aperture_user=None,
        )
        stream = response.body_iterator
        chunks = [await anext(stream)]
        # Ben's stream is still open while Ana edits from another thread.
        monkeypatch.setattr(collab_routes, "_current_session_user", lambda *_args: ben)
        await asyncio.to_thread(ana_edits_then_unshares)
        async for chunk in stream:
            chunks.append(chunk)
        return chunks

    events = _parse_frames(asyncio.run(asyncio.wait_for(scenario(), timeout=10)))

    assert events[0][0] == "hello"
    assert (events[0][1]["role"], events[0][1]["seq"]) == ("collaborator", 0)
    assert ("live", 1) in [(name, data.get("seq")) for name, data in events]
    assert events[-1] == ("access", {"state": "revoked"})
    assert hub.participants(("tenant-a", draft_id)) == []


async def _collect(stream, *, until, timeout: float = 5.0) -> list[tuple[str, dict]]:
    """Reads frames until `until(events)` holds or the stream ends."""

    chunks: list[str] = []

    async def read() -> None:
        async for chunk in stream:
            chunks.append(chunk)
            if until(_parse_frames(chunks), chunks):
                return

    await asyncio.wait_for(read(), timeout=timeout)
    return _parse_frames(chunks)


def _open_stream(api_fixture, draft_id: str, user_id: str):
    as_user, directory, repository = api_fixture
    hub = as_user("ana").app.dependency_overrides[get_draft_live_hub]()
    user = directory.users[user_id]
    scope = MatterActorScope(actor=user, tenant_id="tenant-a", store=directory)
    return collab_routes.draft_live_events(
        draft_id,
        _OpenRequest(),  # type: ignore[arg-type]
        client_id=f"client-{user_id}-1",
        scope=scope,
        repository=repository,
        hub=hub,
        x_aperture_session=None,
        x_aperture_user=None,
    )


def test_the_event_stream_notices_saves_another_server_process_made(api, monkeypatch) -> None:
    """A save that never passed through this process's hub still reaches the
    stream through its database poll, and so does the draft's deletion."""

    as_user, _directory, repository = api
    monkeypatch.setattr(collab_routes, "STREAM_POLL_SECONDS", 0.05)
    draft_id = _create_memo(as_user("ana"))
    _share(as_user("ana"), draft_id, people=["ben"])

    async def scenario() -> list[tuple[str, dict]]:
        stream = (await _open_stream(api, draft_id, "ben")).body_iterator
        await anext(stream)  # hello
        await asyncio.to_thread(
            repository.put_live,
            draft_id,
            tenant_id="tenant-a",
            owner_user_id="ana",
            actor_user_id="ana",
            client_id="client-elsewhere",
            expected_seq=0,
            content="<p>Saved by another process.</p>",
        )
        seen = await _collect(stream, until=lambda events, _chunks: any(name == "live" for name, _ in events))
        await asyncio.to_thread(
            repository.delete_draft, draft_id, tenant_id="tenant-a", owner_user_id="ana", expected_revision=1
        )
        return seen + await _collect(stream, until=lambda events, _chunks: any(name == "access" for name, _ in events))

    events = asyncio.run(scenario())
    assert ("live", {"seq": 1, "current_revision": 1}) in events
    assert events[-1] == ("access", {"state": "deleted"})


def test_a_quiet_event_stream_sends_keep_alive_pings(api, monkeypatch) -> None:
    as_user, _directory, _repository = api
    monkeypatch.setattr(collab_routes, "STREAM_POLL_SECONDS", 0.02)
    monkeypatch.setattr(collab_routes, "STREAM_PING_SECONDS", 0.05)
    draft_id = _create_memo(as_user("ana"))

    async def scenario() -> bool:
        stream = (await _open_stream(api, draft_id, "ana")).body_iterator
        await anext(stream)
        await _collect(stream, until=lambda _events, chunks: any(chunk.startswith(": ping") for chunk in chunks))
        return True

    assert asyncio.run(scenario())


def _names(directory: dict) -> list[str]:
    return [person["display_name"] for person in directory["people"]]


def test_everyone_in_the_default_users_group_is_offered_to_each_other(api) -> None:
    as_user, directory, _repository = api
    directory.groups["group-default"] = _group("group-default", "Default Users")
    for user_id, name in (("dana", "Dana Default"), ("eli", "Eli Default"), ("fay", "Fay Default")):
        directory.users[user_id] = _user(user_id, name, "group-default")

    offered = as_user("dana").get("/api/draft-sharing/directory").json()

    assert [(g["name"], g["member_count"]) for g in offered["groups"]] == [("Default Users", 3)]
    assert _names(offered) == ["Eli Default", "Fay Default"]
    assert offered["people_scope"] == "groups"


def test_an_administrator_is_offered_everyone_in_the_organization_but_platform_owners(api) -> None:
    as_user, _directory, _repository = api

    offered = as_user("alex").get("/api/draft-sharing/directory").json()

    assert _names(offered) == ["Ana Owner", "Ben Partner", "Cy Associate", "Dee Tax"]
    assert offered["people_scope"] == "organization"
    draft_id = _create_memo(as_user("alex"))
    sharing = _share(as_user("alex"), draft_id, people=["dee", "ben"])
    assert sorted(person["id"] for person in sharing["people"]) == ["ben", "dee"]
    refused = as_user("alex").put(f"/api/drafts/{draft_id}/sharing", json={"group_ids": [], "user_ids": ["olive"]})
    assert refused.status_code == 422


def test_a_platform_owner_is_offered_everyone(api) -> None:
    as_user, _directory, _repository = api
    owner = as_user("olive")
    owner.headers["X-Aperture-Tenant"] = "tenant-a"
    try:
        offered = owner.get("/api/draft-sharing/directory").json()
        assert _names(offered) == ["Alex Admin", "Ana Owner", "Ben Partner", "Cy Associate", "Dee Tax", "Otto Owner"]
        assert offered["people_scope"] == "everyone"
        draft_id = _create_memo(owner)
        sharing = _share(owner, draft_id, people=["otto", "dee"])
        assert sorted(person["display_name"] for person in sharing["people"]) == ["Dee Tax", "Otto Owner"]
    finally:
        del owner.headers["X-Aperture-Tenant"]


def test_a_regular_user_still_shares_only_inside_their_groups(api) -> None:
    as_user, _directory, _repository = api
    draft_id = _create_memo(as_user("ben"))

    refused = as_user("ben").put(f"/api/drafts/{draft_id}/sharing", json={"group_ids": [], "user_ids": ["dee"]})
    assert refused.status_code == 422
    assert "Alex Admin" not in _names(as_user("ben").get("/api/draft-sharing/directory").json())


def test_the_sharing_view_skips_removed_groups_and_people_who_left(api) -> None:
    as_user, directory, repository = api
    draft_id = _create_memo(as_user("ana"))
    _share(as_user("ana"), draft_id, groups=["group-lit"], people=["ben", "cy"])
    del directory.groups["group-lit"]
    directory.users["cy"] = directory.users["cy"].model_copy(update={"active": False})

    view = as_user("ana").get(f"/api/drafts/{draft_id}/sharing").json()

    assert (view["groups"], [person["id"] for person in view["people"]]) == ([], ["ben"])
    assert len(repository.list_shares(draft_id, tenant_id="tenant-a", owner_user_id="ana")) == 3


def test_sharing_changes_are_audited_with_who_has_access(api) -> None:
    as_user, directory, _repository = api
    draft_id = _create_memo(as_user("ana"))
    _share(as_user("ana"), draft_id, groups=["group-lit"], people=["cy"])
    _share(as_user("ana"), draft_id, groups=["group-lit"], people=["cy"])  # no change, no second event

    events = [event for event in directory.audit_actions if event[1] == "draft.sharing_updated"]
    assert events == [("ana", "draft.sharing_updated", draft_id, {"groups": ["group-lit"], "people": ["cy"], "added": 2, "removed": 0})]


def test_people_without_a_display_name_are_listed_by_email(api) -> None:
    as_user, directory, _repository = api
    directory.users["zed"] = _user("zed", "", "group-lit")

    offered = as_user("ana").get("/api/draft-sharing/directory").json()

    assert [person["display_name"] for person in offered["people"]] == ["Ben Partner", "Cy Associate", "zed@example.test"]


def test_a_version_save_that_changes_nothing_announces_nothing(api, monkeypatch) -> None:
    as_user, _directory, _repository = api
    draft_id = _create_memo(as_user("ana"))
    hub = as_user("ana").app.dependency_overrides[get_draft_live_hub]()
    published: list[dict] = []
    monkeypatch.setattr(hub, "publish", lambda key, event: published.append(event))

    unchanged = as_user("ana").post(f"/api/drafts/{draft_id}/live/version", json={"client_id": "client-ana-1"})
    assert unchanged.json()["document"]["current_revision"] == 1
    assert published == []
    as_user("ana").put(
        f"/api/drafts/{draft_id}/live", json={"expected_seq": 0, "client_id": "client-ana-1", "content": "<p>New.</p>"}
    )
    as_user("ana").post(f"/api/drafts/{draft_id}/live/version", json={"client_id": "client-ana-1"})
    assert [event["event"] for event in published] == ["live", "version"]
    assert published[1]["data"] == {
        "revision": 2, "current_revision": 2, "seq": 1, "author_user_id": "ana", "updated_by_client": "client-ana-1",
    }


def test_a_long_lived_stream_rechecks_the_session_and_the_sharing(api, monkeypatch) -> None:
    as_user, directory, repository = api
    draft_id = _create_memo(as_user("ana"))
    _share(as_user("ana"), draft_id, people=["ben"])
    scope = MatterActorScope(actor=directory.users["ben"], tenant_id="tenant-a", store=directory)

    def check(signed_in):
        monkeypatch.setattr(collab_routes, "_current_session_user", signed_in)
        return collab_routes._stream_still_allowed(scope, repository, draft_id, "token", None)

    def signed_out(*_args):
        raise HTTPException(status_code=401, detail="Authentication required")

    assert check(lambda *_args: directory.users["ben"]) is True
    assert check(signed_out) is False
    assert check(lambda *_args: directory.users["cy"]) is False
    _share(as_user("ana"), draft_id, people=[])
    assert check(lambda *_args: directory.users["ben"]) is False


def test_the_stream_says_hello_with_the_live_seq_and_names_the_person_by_email_when_unnamed(api, monkeypatch) -> None:
    as_user, directory, repository = api
    monkeypatch.setattr(collab_routes, "STREAM_POLL_SECONDS", 0.02)
    draft_id = _create_memo(as_user("ana"))
    as_user("ana").put(
        f"/api/drafts/{draft_id}/live", json={"expected_seq": 0, "client_id": "client-ana-1", "content": "<p>Live.</p>"}
    )
    as_user("ana").post(f"/api/drafts/{draft_id}/live/version", json={"client_id": "client-ana-1"})
    directory.users["ana"] = directory.users["ana"].model_copy(update={"display_name": ""})

    async def scenario():
        stream = (await _open_stream(api, draft_id, "ana")).body_iterator
        hello = _parse_frames([await anext(stream)])
        for expected_seq in (1, 2):
            await asyncio.to_thread(
                repository.put_live, draft_id, tenant_id="tenant-a", owner_user_id="ana", actor_user_id="ana",
                client_id="client-elsewhere", expected_seq=expected_seq, content=f"<p>Live {expected_seq}.</p>",
            )
        seen = await _collect(
            stream, until=lambda events, _chunks: any(name == "live" and data["seq"] == 3 for name, data in events)
        )
        return hello, seen

    hello, seen = asyncio.run(scenario())
    assert hello[0][1]["seq"] == 1 and hello[0][1]["current_revision"] == 2
    assert hello[0][1]["participants"][0]["display_name"] == "ana@example.test"
    assert ("live", {"seq": 3, "current_revision": 2}) in seen


def test_the_stream_pings_only_when_quiet_and_keeps_going_after_a_ping(api, monkeypatch) -> None:
    as_user, _directory, repository = api
    monkeypatch.setattr(collab_routes, "STREAM_POLL_SECONDS", 0.02)
    draft_id = _create_memo(as_user("ana"))

    async def scenario():
        stream = (await _open_stream(api, draft_id, "ana")).body_iterator
        await anext(stream)  # hello
        assert (await anext(stream)).startswith("event: presence")
        # Many poll rounds pass with nothing to say and no ping yet.
        pending = asyncio.ensure_future(anext(stream))
        done, _ = await asyncio.wait({pending}, timeout=0.3)
        pings_before = len(done)
        monkeypatch.setattr(collab_routes, "STREAM_PING_SECONDS", 0.05)
        first = await asyncio.wait_for(pending, timeout=2)
        assert first.startswith(": ping")
        await asyncio.to_thread(
            repository.put_live, draft_id, tenant_id="tenant-a", owner_user_id="ana", actor_user_id="ana",
            client_id="client-elsewhere", expected_seq=0, content="<p>After a ping.</p>",
        )
        after = await _collect(stream, until=lambda events, _chunks: any(name == "live" for name, _ in events))
        return pings_before, after

    pings_before, after = asyncio.run(scenario())
    assert pings_before == 0
    assert ("live", {"seq": 1, "current_revision": 1}) in after


def test_a_stream_ends_once_its_draft_is_deleted(api, monkeypatch) -> None:
    as_user, _directory, repository = api
    monkeypatch.setattr(collab_routes, "STREAM_POLL_SECONDS", 0.02)
    draft_id = _create_memo(as_user("ana"))

    async def scenario() -> list[str]:
        stream = (await _open_stream(api, draft_id, "ana")).body_iterator
        await anext(stream)
        await asyncio.to_thread(
            repository.delete_draft, draft_id, tenant_id="tenant-a", owner_user_id="ana", expected_revision=1
        )
        return [chunk async for chunk in stream]

    chunks = asyncio.run(asyncio.wait_for(scenario(), timeout=5))
    assert _parse_frames(chunks)[-1] == ("access", {"state": "deleted"})


def test_a_stream_that_fell_behind_sends_one_resync(api, monkeypatch) -> None:
    as_user, _directory, repository = api
    monkeypatch.setattr(collab_routes, "STREAM_POLL_SECONDS", 0.02)
    draft_id = _create_memo(as_user("ana"))
    hub = as_user("ana").app.dependency_overrides[get_draft_live_hub]()

    async def scenario():
        stream = (await _open_stream(api, draft_id, "ana")).body_iterator
        await anext(stream)
        hub._subscriptions[("tenant-a", draft_id)][0].overflowed = True
        await asyncio.sleep(0.1)
        await asyncio.to_thread(
            repository.put_live, draft_id, tenant_id="tenant-a", owner_user_id="ana", actor_user_id="ana",
            client_id="client-elsewhere", expected_seq=0, content="<p>Later.</p>",
        )
        return await _collect(stream, until=lambda events, _chunks: any(name == "live" for name, _ in events))

    events = asyncio.run(scenario())
    assert [name for name, _ in events].count("resync") == 1
