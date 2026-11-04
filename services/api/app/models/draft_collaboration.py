"""Shared drafts: who a draft is shared with, and the live copy they edit.

Glossary
--------
owner
    The person who created the draft. Only the owner shares, unshares,
    archives, deletes, or moves a draft between matters.
collaborator
    Someone the owner shared the draft with, directly or through one of the
    owner's groups. Collaborators read and edit the draft and save versions.
share
    One grant: a person (``user``) or a whole group (``group``). Group shares
    follow live membership, so leaving the group ends access.
live copy
    The one working copy everyone editing the draft autosaves into. ``seq``
    counts its saves; a save must name the ``seq`` it started from
    (compare-and-set). ``seq`` 0 means nobody has edited live yet, so the
    live copy is the current version.
version
    A numbered revision in ``draft_revisions``. Saving a version copies the
    live copy into the bounded history.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.matters import (
    MAX_DRAFT_REVISIONS,
    MAX_DRAFT_TITLE_CHARS,
    DraftDocument,
    DraftKind,
)


DraftRole = Literal["owner", "collaborator"]
SharePrincipalKind = Literal["group", "user"]
MAX_SHARE_GROUPS = 50
MAX_SHARE_PEOPLE = 200
CLIENT_ID_PATTERN = r"^[A-Za-z0-9_-]{8,64}$"


@dataclass(frozen=True, slots=True)
class DraftActor:
    """The signed-in person asking, with the groups they belong to now."""

    user_id: str
    group_ids: frozenset[str]


@dataclass(frozen=True, slots=True)
class DraftAccess:
    """Why the actor may open a draft. ``shared_via`` is None for the owner."""

    document: DraftDocument
    role: DraftRole
    shared_via: SharePrincipalKind | None

    @property
    def owner_user_id(self) -> str:
        return self.document.owner_user_id

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"


class DraftShare(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    principal_kind: SharePrincipalKind
    principal_id: str
    created_at: datetime
    created_by_user_id: str


class SharedDraft(BaseModel):
    """A draft someone else shared with the actor."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    document: DraftDocument
    shared_via: SharePrincipalKind
    last_edited_at: datetime


class DraftShareSummary(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    draft_id: str
    group_count: int = Field(ge=0)
    people_count: int = Field(ge=0)


class DraftLiveState(BaseModel):
    """The shared working copy, as every editor sees it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    draft_id: str
    kind: DraftKind
    seq: int = Field(ge=0)
    # The newest saved version, and whether the live copy has moved past it.
    current_revision: int = Field(ge=1, le=MAX_DRAFT_REVISIONS)
    title: str
    content: str
    content_sha256: str
    updated_at: datetime
    updated_by_user_id: str | None = None
    updated_by_client: str | None = None


class DraftVersionInfo(BaseModel):
    """One entry in a draft's version history, without its content."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    revision: int = Field(ge=1, le=MAX_DRAFT_REVISIONS)
    title: str
    created_at: datetime
    content_sha256: str
    # None means the author's account was permanently removed.
    author_user_id: str | None


class DraftLivePutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_seq: int = Field(ge=0)
    client_id: str = Field(pattern=CLIENT_ID_PATTERN)
    content: str
    title: str | None = Field(default=None, min_length=1, max_length=MAX_DRAFT_TITLE_CHARS)


class DraftLiveVersionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(pattern=CLIENT_ID_PATTERN)


class DraftShareUpdateRequest(BaseModel):
    """The complete set of shares the owner wants; empty lists stop sharing."""

    model_config = ConfigDict(extra="forbid")

    group_ids: list[str] = Field(default_factory=list, max_length=MAX_SHARE_GROUPS)
    user_ids: list[str] = Field(default_factory=list, max_length=MAX_SHARE_PEOPLE)
