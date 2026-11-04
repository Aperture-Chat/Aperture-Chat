"""Shared drafts: sharing, the live copy, version history, and presence.

Access is decided in one place (``resolve_draft_access`` in the matters
router). Owners manage sharing; collaborators read, edit live, and save
versions. Group shares follow the actor's current group membership, and a
matter-bound draft still requires matter membership.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.core.draft_live_hub import (
    DraftLiveHub,
    Participant,
    PresenceFocus,
    get_draft_live_hub,
    presence_color,
)
from app.models.draft_collaboration import (
    CLIENT_ID_PATTERN,
    DraftAccess,
    DraftLivePutRequest,
    DraftLiveState,
    DraftLiveVersionRequest,
    DraftShareUpdateRequest,
    SharePrincipalKind,
)
from app.models.matters import DraftDocument, DraftRevision, DraftSnapshot
from app.models.schemas import Role, User
from app.repositories.draft_collaboration import DraftCollaborationRepository, DraftLiveConflict
from app.routes.dependencies import _current_session_user
from app.routes.matters import (
    MatterActorScope,
    _repository_errors,
    _require_draft_content_bound,
    current_matter_scope,
    draft_actor,
    get_matter_draft_repository,
    publish_draft_written,
    resolve_draft_access,
)


router = APIRouter(tags=["drafts"])

MAX_DIRECTORY_PEOPLE = 1000
STREAM_POLL_SECONDS = 3.0
STREAM_ACCESS_SECONDS = 20.0
STREAM_PING_SECONDS = 15.0
_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


# Response shapes ---------------------------------------------------------


class Person(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    display_name: str
    email: str


class GroupChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    name: str
    member_count: int = Field(ge=0)


class ShareDirectory(BaseModel):
    """Who the signed-in person may share with: their groups, and the people
    they may pick by name (see ``people_scope``)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    groups: list[GroupChoice]
    people: list[Person]
    # "groups": people in their groups; "organization": everyone in the
    # organization (administrators); "everyone": platform owners.
    people_scope: Literal["groups", "organization", "everyone"]


class DraftSharing(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    draft_id: str
    owner: Person
    role: Literal["owner", "collaborator"]
    can_manage: bool
    matter_bound: bool
    groups: list[GroupChoice]
    people: list[Person]


class SharedDraftItem(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    document: DraftDocument
    owner: Person
    shared_via: SharePrincipalKind
    last_edited_at: datetime


class LiveStateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    live: DraftLiveState
    role: Literal["owner", "collaborator"]
    updated_by_name: str | None


class VersionItem(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    revision: int
    title: str
    created_at: datetime
    content_sha256: str
    author_user_id: str | None
    author_name: str


class VersionContent(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    revision: DraftRevision
    author_user_id: str | None
    author_name: str


class FocusPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["block", "slide", "cell"]
    ref: str = Field(min_length=1, max_length=120)


class PresenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(pattern=CLIENT_ID_PATTERN)
    focus: FocusPayload | None = None


# Directory ---------------------------------------------------------------


def _person(user: User) -> Person:
    return Person(id=user.id, display_name=user.display_name or user.email, email=user.email)


def _name_for(scope: MatterActorScope, user_id: str | None) -> str:
    if user_id is None:
        return "A former member"
    user = scope.store.users.get(user_id)
    return "A former member" if user is None else (user.display_name or user.email)


def _owner_person(scope: MatterActorScope, owner_user_id: str) -> Person:
    owner = scope.store.users.get(owner_user_id)
    if owner is None:
        return Person(id=owner_user_id, display_name="A former member", email="")
    return _person(owner)


def _tenant_groups(scope: MatterActorScope) -> dict[str, Any]:
    groups = getattr(scope.store, "groups", {}) or {}
    return {group_id: group for group_id, group in groups.items() if group.tenant_id == scope.tenant_id}


def _active_tenant_people(scope: MatterActorScope) -> list[User]:
    return [
        user
        for user in scope.store.users.values()
        if user.active and user.tenant_id == scope.tenant_id
    ]


def _group_choice(group: Any, people: list[User]) -> GroupChoice:
    count = sum(1 for user in people if group.id in user.group_ids)
    return GroupChoice(id=group.id, name=group.name, member_count=count)


_PEOPLE_SCOPES: dict[Role, Literal["organization", "everyone"]] = {
    Role.PLATFORM_OWNER: "everyone",
    Role.TENANT_ADMIN: "organization",
}


def _active_platform_owners(scope: MatterActorScope) -> list[User]:
    return [user for user in scope.store.users.values() if user.active and user.role == Role.PLATFORM_OWNER]


def _offered_people(scope: MatterActorScope, user: User, group_ids: set[str], people: list[User]) -> list[User]:
    """Who ``user`` may pick by name: a platform owner, anyone; an
    administrator, anyone in the organization (never a platform owner);
    everyone else, the people in their own groups."""

    if user.role == Role.PLATFORM_OWNER:
        candidates = [*people, *_active_platform_owners(scope)]
    elif user.role == Role.TENANT_ADMIN:
        candidates = [person for person in people if person.role != Role.PLATFORM_OWNER]
    else:
        candidates = [person for person in people if group_ids.intersection(person.group_ids)]
    return [person for person in candidates if person.id != user.id]


def share_directory_for(scope: MatterActorScope, user: User) -> ShareDirectory:
    """The groups ``user`` belongs to, and the people they may share with."""

    tenant_groups = _tenant_groups(scope)
    mine = [tenant_groups[group_id] for group_id in user.group_ids if group_id in tenant_groups]
    people = _active_tenant_people(scope)
    offered = sorted(
        {person.id: person for person in _offered_people(scope, user, {group.id for group in mine}, people)}.values(),
        key=lambda person: ((person.display_name or person.email).casefold(), person.id),
    )[:MAX_DIRECTORY_PEOPLE]
    return ShareDirectory(
        groups=sorted((_group_choice(group, people) for group in mine), key=lambda g: g.name.casefold()),
        people=[_person(person) for person in offered],
        people_scope=_PEOPLE_SCOPES.get(user.role, "groups"),
    )


@router.get("/api/draft-sharing/directory")
def get_share_directory(scope: MatterActorScope = Depends(current_matter_scope)) -> ShareDirectory:
    return share_directory_for(scope, scope.actor)


@router.get("/api/draft-sharing/shared-with-me")
def list_shared_with_me(
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
) -> list[SharedDraftItem]:
    with _repository_errors():
        shared = repository.list_shared_with(tenant_id=scope.tenant_id, actor=draft_actor(scope))
        return [
            SharedDraftItem(
                document=item.document,
                owner=_owner_person(scope, item.document.owner_user_id),
                shared_via=item.shared_via,
                last_edited_at=item.last_edited_at,
            )
            for item in shared
        ]
    raise AssertionError("unreachable")


@router.get("/api/draft-sharing/mine")
def list_my_shared_drafts(
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
) -> list[dict[str, object]]:
    with _repository_errors():
        return [
            summary.model_dump()
            for summary in repository.share_summaries(tenant_id=scope.tenant_id, owner_user_id=scope.actor.id)
        ]
    raise AssertionError("unreachable")


# Sharing -----------------------------------------------------------------


def _sharing_view(
    scope: MatterActorScope,
    repository: DraftCollaborationRepository,
    access: DraftAccess,
) -> DraftSharing:
    document = access.document
    shares = repository.list_shares(document.id, tenant_id=scope.tenant_id, owner_user_id=document.owner_user_id)
    tenant_groups = _tenant_groups(scope)
    people = _active_tenant_people(scope)
    # A platform owner can be shared with by name, though in no tenant.
    people_by_id = {person.id: person for person in [*people, *_active_platform_owners(scope)]}
    return DraftSharing(
        draft_id=document.id,
        owner=_owner_person(scope, document.owner_user_id),
        role=access.role,
        can_manage=access.is_owner,
        matter_bound=document.matter_id is not None,
        groups=[
            _group_choice(tenant_groups[share.principal_id], people)
            for share in shares
            if share.principal_kind == "group" and share.principal_id in tenant_groups
        ],
        people=[
            _person(people_by_id[share.principal_id])
            for share in shares
            if share.principal_kind == "user" and share.principal_id in people_by_id
        ],
    )


def _require_shareable_targets(
    scope: MatterActorScope,
    repository: DraftCollaborationRepository,
    access: DraftAccess,
    payload: DraftShareUpdateRequest,
) -> None:
    """Owners share only with their own groups and the people in them, and a
    matter-bound draft only with people on that matter."""

    directory = share_directory_for(scope, scope.actor)
    allowed_people = {person.id: person for person in directory.people}
    unknown_groups = set(payload.group_ids) - {group.id for group in directory.groups}
    if unknown_groups or set(payload.user_ids) - allowed_people.keys():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="You can share only with your own groups and the people in them.",
        )
    matter_id = access.document.matter_id
    if matter_id is None or not payload.user_ids:
        return
    members = {
        membership.member_user_id
        for membership in repository.list_memberships(
            matter_id, tenant_id=scope.tenant_id, actor_user_id=scope.actor.id
        )
    }
    outside = sorted(allowed_people[user_id].display_name for user_id in payload.user_ids if user_id not in members)
    if outside:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"This draft belongs to a matter. Add {', '.join(outside)} to the matter first, then share it.",
        )


def _share_keys(shares: list[Any]) -> set[tuple[str, str]]:
    return {(share.principal_kind, share.principal_id) for share in shares}


def _audit_share_change(
    scope: MatterActorScope,
    draft_id: str,
    before: set[tuple[str, str]],
    after: set[tuple[str, str]],
) -> None:
    scope.store.record_audit(
        scope.actor,
        "draft.sharing_updated",
        draft_id,
        {
            "groups": sorted(principal for kind, principal in after if kind == "group"),
            "people": sorted(principal for kind, principal in after if kind == "user"),
            "added": len(after - before),
            "removed": len(before - after),
        },
    )


@router.get("/api/drafts/{draft_id}/sharing")
def get_draft_sharing(
    draft_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
) -> DraftSharing:
    with _repository_errors():
        access = resolve_draft_access(scope, repository, draft_id)
        return _sharing_view(scope, repository, access)
    raise AssertionError("unreachable")


@router.put("/api/drafts/{draft_id}/sharing")
def put_draft_sharing(
    draft_id: str,
    payload: DraftShareUpdateRequest,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
    hub: DraftLiveHub = Depends(get_draft_live_hub),
) -> DraftSharing:
    with _repository_errors():
        access = resolve_draft_access(scope, repository, draft_id)
        if not access.is_owner:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the person who created this draft can change who it is shared with.",
            )
        _require_shareable_targets(scope, repository, access, payload)
        before = _share_keys(
            repository.list_shares(draft_id, tenant_id=scope.tenant_id, owner_user_id=scope.actor.id)
        )
        shares = repository.replace_shares(
            draft_id,
            tenant_id=scope.tenant_id,
            owner_user_id=scope.actor.id,
            group_ids=payload.group_ids,
            user_ids=payload.user_ids,
        )
        after = _share_keys(shares)
        if before != after:
            _audit_share_change(scope, draft_id, before, after)
            # Streams re-check access now, so someone removed is cut off at once.
            hub.publish((scope.tenant_id, draft_id), {"event": "sharing", "data": {}})
        return _sharing_view(scope, repository, access)
    raise AssertionError("unreachable")


# Live copy ---------------------------------------------------------------


def _live_response(scope: MatterActorScope, live: DraftLiveState, access: DraftAccess) -> LiveStateResponse:
    return LiveStateResponse(
        live=live,
        role=access.role,
        updated_by_name=None if live.updated_by_user_id is None else _name_for(scope, live.updated_by_user_id),
    )


@router.get("/api/drafts/{draft_id}/live")
def get_draft_live(
    draft_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
) -> LiveStateResponse:
    with _repository_errors():
        access = resolve_draft_access(scope, repository, draft_id)
        live = repository.get_live(draft_id, tenant_id=scope.tenant_id, owner_user_id=access.owner_user_id)
        return _live_response(scope, live, access)
    raise AssertionError("unreachable")


@router.put("/api/drafts/{draft_id}/live", response_model=None)
def put_draft_live(
    draft_id: str,
    payload: DraftLivePutRequest,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
    hub: DraftLiveHub = Depends(get_draft_live_hub),
) -> LiveStateResponse | JSONResponse:
    """Autosave into the live copy. A 409 carries the live copy the caller
    must merge its edits into before saving again."""

    with _repository_errors():
        access = resolve_draft_access(scope, repository, draft_id)
        _require_draft_content_bound(payload.content, access.document.kind)
        try:
            live = repository.put_live(
                draft_id,
                tenant_id=scope.tenant_id,
                owner_user_id=access.owner_user_id,
                actor_user_id=scope.actor.id,
                client_id=payload.client_id,
                expected_seq=payload.expected_seq,
                title=payload.title,
                content=payload.content,
            )
        except DraftLiveConflict as exc:
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={
                    "detail": str(exc),
                    **_live_response(scope, exc.current, access).model_dump(mode="json"),
                },
            )
        if live.seq != payload.expected_seq:
            hub.publish((scope.tenant_id, draft_id), _live_event(live))
        return _live_response(scope, live, access)
    raise AssertionError("unreachable")


def _live_event(live: DraftLiveState) -> dict[str, object]:
    return {
        "event": "live",
        "data": {
            "seq": live.seq,
            "current_revision": live.current_revision,
            "updated_by_user_id": live.updated_by_user_id,
            "updated_by_client": live.updated_by_client,
        },
    }


@router.post("/api/drafts/{draft_id}/live/version")
def save_draft_live_version(
    draft_id: str,
    payload: DraftLiveVersionRequest,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
    hub: DraftLiveHub = Depends(get_draft_live_hub),
) -> DraftSnapshot:
    """Save the live copy as the next numbered version."""

    with _repository_errors():
        access = resolve_draft_access(scope, repository, draft_id)
        before = access.document.current_revision
        snapshot = repository.save_live_version(
            draft_id,
            tenant_id=scope.tenant_id,
            owner_user_id=access.owner_user_id,
            actor_user_id=scope.actor.id,
        )
        if snapshot.document.current_revision != before:
            publish_draft_written(hub, scope, repository, snapshot, client_id=payload.client_id)
        return snapshot
    raise AssertionError("unreachable")


@router.put("/api/drafts/{draft_id}/live/presence", status_code=status.HTTP_204_NO_CONTENT)
def put_draft_presence(
    draft_id: str,
    payload: PresenceRequest,
    scope: MatterActorScope = Depends(current_matter_scope),
    hub: DraftLiveHub = Depends(get_draft_live_hub),
) -> Response:
    """Say where in the draft this person is working. Only an open event
    stream's own client may move its focus, so no draft read is needed."""

    focus = None if payload.focus is None else PresenceFocus(kind=payload.focus.kind, ref=payload.focus.ref)
    if not hub.set_focus(
        (scope.tenant_id, draft_id), client_id=payload.client_id, user_id=scope.actor.id, focus=focus
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No open live session for this draft.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# Versions ----------------------------------------------------------------


@router.get("/api/drafts/{draft_id}/versions")
def list_draft_versions(
    draft_id: str,
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
) -> list[VersionItem]:
    with _repository_errors():
        access = resolve_draft_access(scope, repository, draft_id)
        return [
            VersionItem(**item.model_dump(), author_name=_name_for(scope, item.author_user_id))
            for item in repository.list_versions(
                draft_id, tenant_id=scope.tenant_id, owner_user_id=access.owner_user_id
            )
        ]
    raise AssertionError("unreachable")


@router.get("/api/drafts/{draft_id}/versions/{revision}")
def get_draft_version(
    draft_id: str,
    revision: int = Path(ge=1),
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
) -> VersionContent:
    with _repository_errors():
        access = resolve_draft_access(scope, repository, draft_id)
        content, author = repository.get_version(
            draft_id, revision, tenant_id=scope.tenant_id, owner_user_id=access.owner_user_id
        )
        return VersionContent(revision=content, author_user_id=author, author_name=_name_for(scope, author))
    raise AssertionError("unreachable")


# Event stream ------------------------------------------------------------


def _sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'), default=str)}\n\n"


def _stream_still_allowed(
    scope: MatterActorScope,
    repository: DraftCollaborationRepository,
    draft_id: str,
    session_token: str | None,
    user_header: str | None,
) -> bool:
    """Re-check the session and the draft's sharing for a long-lived stream."""

    try:
        user = _current_session_user(session_token, user_header, scope.store)  # type: ignore[arg-type]
    except HTTPException:
        return False
    if user.id != scope.actor.id:
        return False
    refreshed = MatterActorScope(actor=user, tenant_id=scope.tenant_id, store=scope.store)
    try:
        with _repository_errors():
            resolve_draft_access(refreshed, repository, draft_id)
    except HTTPException:
        return False
    return True


class _DraftEventStream:
    """One open event stream: forwards hub events, polls the database for
    saves made by other API processes, re-checks access, and keeps the
    connection warm. Each method does one of those."""

    def __init__(
        self,
        *,
        scope: MatterActorScope,
        repository: DraftCollaborationRepository,
        hub: DraftLiveHub,
        draft_id: str,
        credentials: tuple[str | None, str | None],
        known: tuple[int, int] | None,
    ) -> None:
        self.scope = scope
        self.repository = repository
        self.hub = hub
        self.draft_id = draft_id
        self.credentials = credentials
        self.known = known
        self.key = (scope.tenant_id, draft_id)
        self.last_poll = self.last_access = self.last_ping = 0.0

    def hello(self, access: DraftAccess, client_id: str) -> str:
        seq, revision = self.known or (0, access.document.current_revision)
        return _sse(
            "hello",
            {
                "client_id": client_id,
                "role": access.role,
                "seq": seq,
                "current_revision": revision,
                "participants": [person.to_json() for person in self.hub.participants(self.key)],
            },
        )

    async def frames(self, subscription: Any, request: Request) -> AsyncIterator[str]:
        loop = asyncio.get_running_loop()
        self.last_poll = self.last_access = self.last_ping = loop.time()
        while not await request.is_disconnected():
            event = await self._next_event(subscription)
            frame, recheck, done = self._forward(event)
            if frame:
                yield frame
            if done:
                return
            if subscription.overflowed:
                subscription.overflowed = False
                yield _sse("resync", {})
            for frame, done in await self._housekeeping(loop.time(), recheck):
                yield frame
                if done:
                    return

    @staticmethod
    async def _next_event(subscription: Any) -> dict[str, Any] | None:
        try:
            return await asyncio.wait_for(subscription.queue.get(), timeout=STREAM_POLL_SECONDS)
        except TimeoutError:
            return None

    def _forward(self, event: dict[str, Any] | None) -> tuple[str | None, bool, bool]:
        """(frame to send, re-check access now, stream is over)."""

        if event is None:
            return None, False, False
        if event["event"] == "sharing":
            return None, True, False
        data = event["data"]
        if event["event"] in {"live", "version"}:
            self.known = (int(data["seq"]), int(data["current_revision"]))
            self.last_ping = asyncio.get_running_loop().time()
        return _sse(event["event"], data), False, event["event"] == "access"

    async def _housekeeping(self, now: float, recheck: bool) -> list[tuple[str, bool]]:
        frames: list[tuple[str, bool]] = []
        if now - self.last_poll >= STREAM_POLL_SECONDS:
            self.last_poll = now
            frames.extend(await self._poll(now))
        if not any(done for _, done in frames) and (recheck or now - self.last_access >= STREAM_ACCESS_SECONDS):
            self.last_access = now
            if not await run_in_threadpool(self._still_allowed):
                frames.append((_sse("access", {"state": "revoked"}), True))
        if not frames and now - self.last_ping >= STREAM_PING_SECONDS:
            self.last_ping = now
            frames.append((": ping\n\n", False))
        return frames

    async def _poll(self, now: float) -> list[tuple[str, bool]]:
        latest = await run_in_threadpool(self.repository.live_marker, self.draft_id, tenant_id=self.scope.tenant_id)
        if latest is None:
            return [(_sse("access", {"state": "deleted"}), True)]
        if latest == self.known:
            return []
        self.known = latest
        self.last_ping = now
        return [(_sse("live", {"seq": latest[0], "current_revision": latest[1]}), False)]

    def _still_allowed(self) -> bool:
        session_token, user_header = self.credentials
        return _stream_still_allowed(self.scope, self.repository, self.draft_id, session_token, user_header)


@router.get("/api/drafts/{draft_id}/live/events")
async def draft_live_events(
    draft_id: str,
    request: Request,
    client_id: str = Query(pattern=CLIENT_ID_PATTERN),
    scope: MatterActorScope = Depends(current_matter_scope),
    repository: DraftCollaborationRepository = Depends(get_matter_draft_repository),
    hub: DraftLiveHub = Depends(get_draft_live_hub),
    x_aperture_session: str | None = Header(default=None),
    x_aperture_user: str | None = Header(default=None),
) -> StreamingResponse:
    """Server-sent events for one open draft: ``hello``, ``live`` (someone
    saved the live copy), ``version``, ``presence``, ``resync``, and a final
    ``access`` when the draft is deleted or this person loses access."""

    def _open() -> tuple[DraftAccess, tuple[int, int] | None]:
        with _repository_errors():
            access = resolve_draft_access(scope, repository, draft_id)
            return access, repository.live_marker(draft_id, tenant_id=scope.tenant_id)
        raise AssertionError("unreachable")

    access, marker = await run_in_threadpool(_open)
    participant = Participant(
        client_id=client_id,
        user_id=scope.actor.id,
        display_name=scope.actor.display_name or scope.actor.email,
        color=presence_color(scope.actor.id),
    )
    stream = _DraftEventStream(
        scope=scope,
        repository=repository,
        hub=hub,
        draft_id=draft_id,
        credentials=(x_aperture_session, x_aperture_user),
        known=marker,
    )

    async def events() -> AsyncIterator[str]:
        subscription = hub.subscribe(stream.key, participant)
        try:
            yield stream.hello(access, client_id)
            async for frame in stream.frames(subscription, request):
                yield frame
        finally:
            hub.unsubscribe(subscription)

    return StreamingResponse(events(), media_type="text/event-stream", headers=_SSE_HEADERS)

