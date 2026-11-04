"""Shared-draft persistence: shares, access, the live copy, and versions.

Every method that reads or writes draft content takes the draft owner's id,
because revisions are stored under the owner's scope. Routes obtain it from
``draft_access`` first, which is where sharing is decided; nothing else in
this module grants access.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.orm import (
    DraftDocumentRow,
    DraftLiveStateRow,
    DraftRevisionAuthorRow,
    DraftRevisionRow,
    DraftShareRow,
    MatterMembershipRow,
)
from app.models.draft_collaboration import (
    MAX_SHARE_GROUPS,
    MAX_SHARE_PEOPLE,
    DraftAccess,
    DraftActor,
    DraftLiveState,
    DraftShare,
    DraftShareSummary,
    DraftVersionInfo,
    SharedDraft,
    SharePrincipalKind,
)
from app.models.matters import (
    MAX_DRAFT_LIST_LIMIT,
    MAX_DRAFT_REVISION_LIST_LIMIT,
    DraftKind,
    DraftRevision,
    DraftSnapshot,
    canonicalize_draft_content,
    content_sha256_for_kind,
    matter_now,
    normalize_draft_title,
    sanitizer_version_for_kind,
)
from app.repositories.matters import (
    DraftConflict,
    MatterAccessDenied,
    MatterDraftRepository,
    PrivateResourceNotFound,
    _aware_utc,
    _bounded_limit,
    _positive_bigint,
    _required_id,
    _scope,
)


class DraftLiveConflict(DraftConflict):
    """Someone saved the live copy first; carries what they saved."""

    def __init__(self, current: DraftLiveState) -> None:
        super().__init__("The live draft changed before this save completed.")
        self.current = current


class DraftCollaborationRepository(MatterDraftRepository):
    # Access ------------------------------------------------------------

    def draft_access(self, draft_id: str, *, tenant_id: str, actor: DraftActor) -> DraftAccess:
        """Decide whether ``actor`` may open ``draft_id``, and as whom.

        Unknown drafts and drafts the actor may not open look the same, so a
        guess at an id learns nothing.
        """
        draft_id, tenant_id, actor_user_id = _scope(draft_id, tenant_id, actor.user_id)
        return self._run_read(
            lambda session: self._access(
                session, draft_id=draft_id, tenant_id=tenant_id, actor_user_id=actor_user_id,
                group_ids=actor.group_ids,
            )
        )

    def _access(
        self,
        session: Session,
        *,
        draft_id: str,
        tenant_id: str,
        actor_user_id: str,
        group_ids: frozenset[str],
    ) -> DraftAccess:
        row = session.scalar(
            select(DraftDocumentRow).where(
                DraftDocumentRow.id == draft_id,
                DraftDocumentRow.tenant_id == tenant_id,
            )
        )
        if row is None:
            raise PrivateResourceNotFound("Unknown draft.")
        if row.owner_user_id == actor_user_id:
            return DraftAccess(document=row.to_model(), role="owner", shared_via=None)
        via = _shared_via(_share_rows(session, draft_id), actor_user_id, group_ids)
        if via is None:
            raise PrivateResourceNotFound("Unknown draft.")
        if row.matter_id is not None:
            # Sharing never widens a matter's wall.
            try:
                self._matter_for_member(
                    session, matter_id=row.matter_id, tenant_id=tenant_id, actor_user_id=actor_user_id
                )
            except MatterAccessDenied as exc:
                raise PrivateResourceNotFound("Unknown draft.") from exc
        return DraftAccess(document=row.to_model(), role="collaborator", shared_via=via)

    # Shares ------------------------------------------------------------

    def list_shares(self, draft_id: str, *, tenant_id: str, owner_user_id: str) -> list[DraftShare]:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)

        def operation(session: Session) -> list[DraftShare]:
            self._draft_document_for_owner(
                session, draft_id=draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id
            )
            return [_share_model(row) for row in _share_rows(session, draft_id)]

        return self._run_read(operation)

    def replace_shares(
        self,
        draft_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        group_ids: Iterable[str],
        user_ids: Iterable[str],
        now: datetime | None = None,
    ) -> list[DraftShare]:
        """Make the draft's shares exactly ``group_ids`` + ``user_ids``.

        Callers validate that each id is a group or person the owner may
        share with; this method only stores the set. Existing grants keep
        their original date.
        """
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        wanted = _wanted_shares(group_ids, user_ids, owner_user_id)
        timestamp = _aware_utc(now or matter_now())

        def operation(session: Session) -> list[DraftShare]:
            self._draft_document_for_owner(
                session, draft_id=draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id
            )
            existing = {(row.principal_kind, row.principal_id): row for row in _share_rows(session, draft_id)}
            for key, row in existing.items():
                if key not in wanted:
                    session.delete(row)
            for kind, principal_id in sorted(wanted - existing.keys()):
                session.add(
                    DraftShareRow(
                        draft_id=draft_id,
                        principal_kind=kind,
                        principal_id=principal_id,
                        tenant_id=tenant_id,
                        owner_user_id=owner_user_id,
                        created_at=timestamp,
                        created_by_user_id=owner_user_id,
                    )
                )
            session.flush()
            return [_share_model(row) for row in _share_rows(session, draft_id)]

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            raise DraftConflict("The draft's sharing changed before this update completed.") from exc

    def list_shared_with(
        self,
        *,
        tenant_id: str,
        actor: DraftActor,
        limit: int = MAX_DRAFT_LIST_LIMIT,
    ) -> list[SharedDraft]:
        """Other people's active drafts the actor may open, newest edit first."""

        tenant_id = _required_id(tenant_id, "tenant_id")
        actor_user_id = _required_id(actor.user_id, "actor_user_id")
        limit = _bounded_limit(limit, maximum=MAX_DRAFT_LIST_LIMIT)

        def operation(session: Session) -> list[SharedDraft]:
            principal = (
                (DraftShareRow.principal_kind == "user") & (DraftShareRow.principal_id == actor_user_id)
            )
            if actor.group_ids:
                principal = principal | (
                    (DraftShareRow.principal_kind == "group")
                    & DraftShareRow.principal_id.in_(sorted(actor.group_ids))
                )
            rows = session.execute(
                select(DraftDocumentRow, DraftShareRow.principal_kind, DraftLiveStateRow.updated_at)
                .join(DraftShareRow, DraftShareRow.draft_id == DraftDocumentRow.id)
                .outerjoin(DraftLiveStateRow, DraftLiveStateRow.draft_id == DraftDocumentRow.id)
                .where(
                    DraftDocumentRow.tenant_id == tenant_id,
                    DraftDocumentRow.owner_user_id != actor_user_id,
                    DraftDocumentRow.archived.is_(False),
                    principal,
                )
            ).all()
            member_of = set(
                session.scalars(
                    select(MatterMembershipRow.matter_id).where(
                        MatterMembershipRow.tenant_id == tenant_id,
                        MatterMembershipRow.member_user_id == actor_user_id,
                    )
                )
            )
            found: dict[str, SharedDraft] = {}
            for document, kind, live_updated_at in rows:
                if document.matter_id is not None and document.matter_id not in member_of:
                    continue
                previous = found.get(document.id)
                if previous is not None and previous.shared_via == "user":
                    continue
                edited = document.updated_at if live_updated_at is None else max(
                    _aware_utc(document.updated_at), _aware_utc(live_updated_at)
                )
                found[document.id] = SharedDraft(
                    document=document.to_model(), shared_via=kind, last_edited_at=edited
                )
            ordered = sorted(found.values(), key=lambda item: (item.last_edited_at, item.document.id), reverse=True)
            return ordered[:limit]

        return self._run_read(operation)

    def share_summaries(self, *, tenant_id: str, owner_user_id: str) -> list[DraftShareSummary]:
        """How widely each of the owner's drafts is shared (shared ones only)."""

        tenant_id = _required_id(tenant_id, "tenant_id")
        owner_user_id = _required_id(owner_user_id, "owner_user_id")

        def operation(session: Session) -> list[DraftShareSummary]:
            counts: dict[str, list[int]] = {}
            for draft_id, kind in session.execute(
                select(DraftShareRow.draft_id, DraftShareRow.principal_kind).where(
                    DraftShareRow.tenant_id == tenant_id,
                    DraftShareRow.owner_user_id == owner_user_id,
                )
            ):
                tally = counts.setdefault(draft_id, [0, 0])
                tally[0 if kind == "group" else 1] += 1
            return [
                DraftShareSummary(draft_id=draft_id, group_count=groups, people_count=people)
                for draft_id, (groups, people) in sorted(counts.items())
            ]

        return self._run_read(operation)

    # Live copy ---------------------------------------------------------

    def get_live(self, draft_id: str, *, tenant_id: str, owner_user_id: str) -> DraftLiveState:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        return self._run_read(
            lambda session: self._live_state(
                session, draft_id=draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id
            )
        )

    def live_marker(self, draft_id: str, *, tenant_id: str) -> tuple[int, int] | None:
        """(live seq, current revision) for change detection; None once deleted."""

        draft_id = _required_id(draft_id, "draft_id")
        tenant_id = _required_id(tenant_id, "tenant_id")

        def operation(session: Session) -> tuple[int, int] | None:
            row = session.execute(
                select(DraftDocumentRow.current_revision, DraftLiveStateRow.seq)
                .outerjoin(DraftLiveStateRow, DraftLiveStateRow.draft_id == DraftDocumentRow.id)
                .where(DraftDocumentRow.id == draft_id, DraftDocumentRow.tenant_id == tenant_id)
            ).first()
            if row is None:
                return None
            current_revision, seq = row
            return (int(seq or 0), int(current_revision))

        return self._run_read(operation)

    def put_live(
        self,
        draft_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        actor_user_id: str,
        client_id: str,
        expected_seq: int,
        content: str,
        title: str | None = None,
        now: datetime | None = None,
    ) -> DraftLiveState:
        """Compare-and-set the live copy. A stale ``expected_seq`` raises
        ``DraftLiveConflict`` with the live copy the caller must merge into."""

        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        write = _LiveWrite(
            actor_user_id=_required_id(actor_user_id, "actor_user_id"),
            client_id=_required_id(client_id, "client_id"),
            expected_seq=_nonnegative_seq(expected_seq),
            content=content,
            title=None if title is None else normalize_draft_title(title),
            timestamp=_aware_utc(now or matter_now()),
        )

        def operation(session: Session) -> DraftLiveState:
            document = self._draft_document_for_owner(
                session, draft_id=draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id
            )
            if document.matter_id is not None:
                self._assert_matter_not_deleting(session, document.matter_id)
            current = self._live_state(
                session, draft_id=draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id
            )
            if current.seq != write.expected_seq:
                raise DraftLiveConflict(current)
            values = write.values_over(current, document.kind)
            if values is None:
                return current
            _store_live_row(session, document, write.expected_seq, values)
            return self._live_state(
                session, draft_id=draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id
            )

        try:
            return self._run_write(operation)
        except IntegrityError as exc:
            # Two first saves raced to create the row; the loser merges.
            raise DraftLiveConflict(self.get_live(draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id)) from exc

    def _live_state(
        self, session: Session, *, draft_id: str, tenant_id: str, owner_user_id: str
    ) -> DraftLiveState:
        snapshot = self._draft_snapshot(
            session, draft_id=draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id
        )
        document = snapshot.document
        # The live row's foreign key ties it to this tenant's and owner's draft.
        row = session.get(DraftLiveStateRow, draft_id)
        if row is None:
            revision = snapshot.revision
            return DraftLiveState(
                draft_id=draft_id,
                kind=document.kind,
                seq=0,
                current_revision=document.current_revision,
                title=document.title,
                content=revision.content,
                content_sha256=revision.content_sha256,
                updated_at=document.updated_at,
                updated_by_user_id=self._author_of(session, draft_id, revision.revision, owner_user_id),
            )
        return DraftLiveState(
            draft_id=draft_id,
            kind=document.kind,
            seq=row.seq,
            current_revision=document.current_revision,
            title=row.title,
            content=row.content,
            content_sha256=row.content_sha256,
            updated_at=_aware_utc(row.updated_at),
            updated_by_user_id=row.updated_by_user_id,
            updated_by_client=row.updated_by_client,
        )

    # Versions ----------------------------------------------------------

    def update_draft_as(
        self,
        draft_id: str,
        *,
        actor_user_id: str,
        tenant_id: str,
        owner_user_id: str,
        expected_revision: int,
        title: str | None = None,
        content: str | None = None,
        now: datetime | None = None,
        **matter: object,
    ) -> DraftSnapshot:
        """``update_draft`` that records who saved the version and brings the
        live copy to it, in the same transaction."""

        actor_user_id = _required_id(actor_user_id, "actor_user_id")

        def on_written(session: Session, snapshot: DraftSnapshot) -> None:
            self._record_author(session, snapshot, actor_user_id)
            self._move_live_to(session, snapshot, actor_user_id)

        return self.update_draft(
            draft_id,
            tenant_id=tenant_id,
            owner_user_id=owner_user_id,
            expected_revision=expected_revision,
            title=title,
            content=content,
            now=now,
            on_written=on_written,
            **matter,  # type: ignore[arg-type]
        )

    def save_live_version(
        self,
        draft_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        actor_user_id: str,
        now: datetime | None = None,
    ) -> DraftSnapshot:
        """Copy the live copy into a new numbered version."""

        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        actor_user_id = _required_id(actor_user_id, "actor_user_id")
        live = self.get_live(draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id)

        def on_written(session: Session, snapshot: DraftSnapshot) -> None:
            row = session.get(DraftLiveStateRow, draft_id)
            if row is not None and row.seq != live.seq:
                # Someone saved the live copy while this version was being
                # written; the caller retries so the version includes it.
                raise DraftConflict("The live draft changed while saving this version.")
            if row is not None:
                row.base_revision = snapshot.document.current_revision
            self._record_author(session, snapshot, actor_user_id)

        return self.update_draft(
            draft_id,
            tenant_id=tenant_id,
            owner_user_id=owner_user_id,
            expected_revision=live.current_revision,
            title=live.title,
            content=live.content,
            now=now,
            on_written=on_written,
        )

    def list_versions(
        self,
        draft_id: str,
        *,
        tenant_id: str,
        owner_user_id: str,
        limit: int = MAX_DRAFT_REVISION_LIST_LIMIT,
    ) -> list[DraftVersionInfo]:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        limit = _bounded_limit(limit, maximum=MAX_DRAFT_REVISION_LIST_LIMIT)

        def operation(session: Session) -> list[DraftVersionInfo]:
            self._draft_document_for_owner(
                session, draft_id=draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id
            )
            rows = session.execute(
                select(
                    DraftRevisionRow.revision,
                    DraftRevisionRow.title,
                    DraftRevisionRow.created_at,
                    DraftRevisionRow.content_sha256,
                    DraftRevisionAuthorRow.draft_id,
                    DraftRevisionAuthorRow.author_user_id,
                )
                .outerjoin(
                    DraftRevisionAuthorRow,
                    (DraftRevisionAuthorRow.draft_id == DraftRevisionRow.draft_id)
                    & (DraftRevisionAuthorRow.revision == DraftRevisionRow.revision),
                )
                .where(
                    DraftRevisionRow.draft_id == draft_id,
                    DraftRevisionRow.tenant_id == tenant_id,
                    DraftRevisionRow.owner_user_id == owner_user_id,
                )
                .order_by(DraftRevisionRow.revision.desc())
                .limit(limit)
            )
            return [
                DraftVersionInfo(
                    revision=revision,
                    title=title,
                    created_at=_aware_utc(created_at),
                    content_sha256=sha,
                    author_user_id=owner_user_id if author_row is None else author,
                )
                for revision, title, created_at, sha, author_row, author in rows
            ]

        return self._run_read(operation)

    def get_version(
        self, draft_id: str, revision: int, *, tenant_id: str, owner_user_id: str
    ) -> tuple[DraftRevision, str | None]:
        draft_id, tenant_id, owner_user_id = _scope(draft_id, tenant_id, owner_user_id)
        revision = _positive_bigint(revision, "revision")

        def operation(session: Session) -> tuple[DraftRevision, str | None]:
            self._draft_document_for_owner(
                session, draft_id=draft_id, tenant_id=tenant_id, owner_user_id=owner_user_id
            )
            # Revisions share their draft's tenant and owner by foreign key.
            row = session.get(DraftRevisionRow, {"draft_id": draft_id, "revision": revision})
            if row is None:
                raise PrivateResourceNotFound("Unknown draft version.")
            return row.to_model(), self._author_of(session, draft_id, revision, owner_user_id)

        return self._run_read(operation)

    # Internals ---------------------------------------------------------

    @staticmethod
    def _record_author(session: Session, snapshot: DraftSnapshot, actor_user_id: str) -> None:
        document = snapshot.document
        if actor_user_id == document.owner_user_id:
            return
        session.add(
            DraftRevisionAuthorRow(
                draft_id=document.id,
                revision=document.current_revision,
                tenant_id=document.tenant_id,
                author_user_id=actor_user_id,
            )
        )

    @staticmethod
    def _move_live_to(session: Session, snapshot: DraftSnapshot, actor_user_id: str) -> None:
        row = session.get(DraftLiveStateRow, snapshot.document.id)
        if row is None:
            return
        revision = snapshot.revision
        row.seq = row.seq + 1
        row.base_revision = snapshot.document.current_revision
        row.title = revision.title
        row.content = revision.content
        row.content_sha256 = revision.content_sha256
        row.sanitizer_version = revision.sanitizer_version
        row.updated_at = max(_aware_utc(revision.created_at), _aware_utc(row.updated_at))
        row.updated_by_user_id = actor_user_id
        row.updated_by_client = None

    @staticmethod
    def _author_of(session: Session, draft_id: str, revision: int, owner_user_id: str) -> str | None:
        row = session.get(DraftRevisionAuthorRow, {"draft_id": draft_id, "revision": revision})
        return owner_user_id if row is None else row.author_user_id


@dataclass(frozen=True, slots=True)
class _LiveWrite:
    """One validated live save, before it meets the stored live copy."""

    actor_user_id: str
    client_id: str
    expected_seq: int
    content: str
    title: str | None
    timestamp: datetime

    def values_over(self, current: DraftLiveState, kind: DraftKind) -> dict[str, object] | None:
        """The row values for this save, or None when nothing would change."""

        content = canonicalize_draft_content(self.content, kind)
        title = current.title if self.title is None else self.title
        if content == current.content and title == current.title:
            return None
        return {
            "seq": self.expected_seq + 1,
            "title": title,
            "content": content,
            "content_sha256": content_sha256_for_kind(content, kind),
            "sanitizer_version": sanitizer_version_for_kind(kind),
            "updated_at": max(self.timestamp, _aware_utc(current.updated_at)),
            "updated_by_user_id": self.actor_user_id,
            "updated_by_client": self.client_id,
        }


def _nonnegative_seq(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError("expected_seq must be a nonnegative integer")
    return value


def _store_live_row(
    session: Session, document: DraftDocumentRow, expected_seq: int, values: dict[str, object]
) -> None:
    """Insert the first live row, or compare-and-set the existing one."""

    if expected_seq == 0:
        session.add(
            DraftLiveStateRow(
                draft_id=document.id,
                tenant_id=document.tenant_id,
                owner_user_id=document.owner_user_id,
                base_revision=document.current_revision,
                **values,
            )
        )
    else:
        changed = session.execute(
            update(DraftLiveStateRow)
            .where(DraftLiveStateRow.draft_id == document.id, DraftLiveStateRow.seq == expected_seq)
            .values(**values)
        ).rowcount
        if changed != 1:
            raise DraftConflict("The live draft changed before this save completed.")
    session.flush()


def _share_rows(session: Session, draft_id: str) -> list[DraftShareRow]:
    return list(
        session.scalars(
            select(DraftShareRow)
            .where(DraftShareRow.draft_id == draft_id)
            .order_by(DraftShareRow.principal_kind, DraftShareRow.principal_id)
        )
    )


def _shared_via(
    rows: Iterable[DraftShareRow], actor_user_id: str, group_ids: frozenset[str]
) -> SharePrincipalKind | None:
    via: SharePrincipalKind | None = None
    for row in rows:
        if row.principal_kind == "user" and row.principal_id == actor_user_id:
            return "user"
        if row.principal_kind == "group" and row.principal_id in group_ids:
            via = "group"
    return via


def _wanted_shares(
    group_ids: Iterable[str], user_ids: Iterable[str], owner_user_id: str
) -> set[tuple[str, str]]:
    groups = {_required_id(value, "group_id") for value in group_ids}
    people = {_required_id(value, "user_id") for value in user_ids} - {owner_user_id}
    if len(groups) > MAX_SHARE_GROUPS or len(people) > MAX_SHARE_PEOPLE:
        raise ValueError("Too many shares for one draft.")
    return {("group", value) for value in groups} | {("user", value) for value in people}


def _share_model(row: DraftShareRow) -> DraftShare:
    return DraftShare(
        principal_kind=row.principal_kind,  # type: ignore[arg-type]
        principal_id=row.principal_id,
        created_at=_aware_utc(row.created_at),
        created_by_user_id=row.created_by_user_id,
    )
