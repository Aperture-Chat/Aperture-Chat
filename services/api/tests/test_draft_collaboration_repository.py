"""Shared drafts: who may open them, the shares themselves, and the live copy."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.db import (
    DraftLiveStateRow,
    DraftRevisionAuthorRow,
    DraftShareRow,
    create_application_engine,
    upgrade_database,
)
from app.models.draft_collaboration import DraftActor
from app.repositories.draft_collaboration import (
    DraftCollaborationRepository,
    DraftLiveConflict,
)
from app.repositories.matters import DraftConflict, PrivateResourceNotFound


TENANT = "tenant-a"
OWNER = "user-owner"
FRIEND = "user-friend"
TEAMMATE = "user-teammate"
STRANGER = "user-stranger"
BASE_TIME = datetime(2026, 11, 3, 12, tzinfo=UTC)


DECK = json.dumps({"schema": "aperture-deck-v1", "title": "Plan", "slides": [{"layout": "title", "title": "Plan"}]})


def _actor(user_id: str, *groups: str) -> DraftActor:
    return DraftActor(user_id=user_id, group_ids=frozenset(groups))


@pytest.fixture
def repo(tmp_path: Path):
    engine = create_application_engine(f"sqlite:///{tmp_path / 'collab.sqlite3'}")
    upgrade_database(engine)
    try:
        yield DraftCollaborationRepository(engine)
    finally:
        engine.dispose()


def _memo(repo: DraftCollaborationRepository, content: str = "<p>First memo.</p>", **kwargs) -> str:
    snapshot = repo.create_draft(
        tenant_id=TENANT, owner_user_id=OWNER, title="Memo", content=content, now=BASE_TIME, **kwargs
    )
    return snapshot.document.id


def _count(repo: DraftCollaborationRepository, row_type) -> int:
    with repo._sessions() as session:
        return session.scalar(select(func.count()).select_from(row_type)) or 0


# Access ------------------------------------------------------------------


def test_only_the_owner_opens_an_unshared_draft(repo) -> None:
    draft_id = _memo(repo)

    access = repo.draft_access(draft_id, tenant_id=TENANT, actor=_actor(OWNER))
    assert access.role == "owner"
    assert access.shared_via is None
    with pytest.raises(PrivateResourceNotFound):
        repo.draft_access(draft_id, tenant_id=TENANT, actor=_actor(STRANGER, "group-lit"))


def test_a_person_share_and_a_group_share_each_grant_collaborator_access(repo) -> None:
    draft_id = _memo(repo)
    repo.replace_shares(
        draft_id,
        tenant_id=TENANT,
        owner_user_id=OWNER,
        group_ids=["group-lit"],
        user_ids=[FRIEND],
        now=BASE_TIME,
    )

    friend = repo.draft_access(draft_id, tenant_id=TENANT, actor=_actor(FRIEND))
    teammate = repo.draft_access(draft_id, tenant_id=TENANT, actor=_actor(TEAMMATE, "group-lit"))
    assert (friend.role, friend.shared_via) == ("collaborator", "user")
    assert (teammate.role, teammate.shared_via) == ("collaborator", "group")
    assert teammate.owner_user_id == OWNER
    # Group access follows current membership: leaving the group ends it.
    with pytest.raises(PrivateResourceNotFound):
        repo.draft_access(draft_id, tenant_id=TENANT, actor=_actor(TEAMMATE, "group-tax"))


def test_shares_never_cross_tenants(repo) -> None:
    draft_id = _memo(repo)
    repo.replace_shares(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=[], user_ids=[FRIEND], now=BASE_TIME
    )

    with pytest.raises(PrivateResourceNotFound):
        repo.draft_access(draft_id, tenant_id="tenant-b", actor=_actor(FRIEND))


def test_a_matter_bound_draft_also_requires_matter_membership(repo) -> None:
    matter = repo.create_matter(
        tenant_id=TENANT, creator_user_id=OWNER, name="Acme v. Example", now=BASE_TIME
    )
    draft_id = _memo(repo, matter_id=matter.id)
    repo.replace_shares(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=["group-lit"], user_ids=[], now=BASE_TIME
    )

    with pytest.raises(PrivateResourceNotFound):
        repo.draft_access(draft_id, tenant_id=TENANT, actor=_actor(TEAMMATE, "group-lit"))
    repo.add_member(
        matter.id,
        tenant_id=TENANT,
        actor_user_id=OWNER,
        member_user_id=TEAMMATE,
        expected_version=matter.version,
        now=BASE_TIME + timedelta(seconds=1),
    )
    access = repo.draft_access(draft_id, tenant_id=TENANT, actor=_actor(TEAMMATE, "group-lit"))
    assert access.role == "collaborator"


# Shares ------------------------------------------------------------------


def test_replacing_shares_sets_exactly_the_requested_people_and_groups(repo) -> None:
    draft_id = _memo(repo)
    repo.replace_shares(
        draft_id,
        tenant_id=TENANT,
        owner_user_id=OWNER,
        group_ids=["group-lit", "group-lit"],
        user_ids=[FRIEND, TEAMMATE],
        now=BASE_TIME,
    )
    shares = repo.replace_shares(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=[], user_ids=[FRIEND], now=BASE_TIME
    )

    assert [(share.principal_kind, share.principal_id) for share in shares] == [("user", FRIEND)]
    assert shares == repo.list_shares(draft_id, tenant_id=TENANT, owner_user_id=OWNER)
    assert repo.replace_shares(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=[], user_ids=[], now=BASE_TIME
    ) == []


def test_a_draft_is_never_shared_with_its_owner(repo) -> None:
    draft_id = _memo(repo)

    shares = repo.replace_shares(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=[], user_ids=[OWNER], now=BASE_TIME
    )
    assert shares == []


def test_deleting_a_draft_removes_its_shares_live_copy_and_authors(repo) -> None:
    draft_id = _memo(repo)
    repo.replace_shares(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=[], user_ids=[FRIEND], now=BASE_TIME
    )
    live = repo.put_live(
        draft_id,
        tenant_id=TENANT,
        owner_user_id=OWNER,
        actor_user_id=FRIEND,
        client_id="client-friend",
        expected_seq=0,
        content="<p>Friend typed.</p>",
        now=BASE_TIME,
    )
    snapshot = repo.save_live_version(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=FRIEND, now=BASE_TIME
    )

    repo.delete_draft(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, expected_revision=snapshot.document.current_revision
    )
    assert live.seq == 1
    assert _count(repo, DraftShareRow) == 0
    assert _count(repo, DraftLiveStateRow) == 0
    assert _count(repo, DraftRevisionAuthorRow) == 0


def test_shared_with_me_lists_other_peoples_drafts_once_preferring_the_personal_share(repo) -> None:
    mine = repo.create_draft(tenant_id=TENANT, owner_user_id=FRIEND, title="Mine", content="<p>x</p>").document.id
    by_person = _memo(repo)
    by_group = repo.create_draft(
        tenant_id=TENANT, owner_user_id=OWNER, title="Plan", content=DECK, kind="deck"
    ).document.id
    archived = _memo(repo)
    for draft_id in (by_person, by_group, archived):
        repo.replace_shares(
            draft_id,
            tenant_id=TENANT,
            owner_user_id=OWNER,
            group_ids=["group-lit"],
            user_ids=[FRIEND] if draft_id == by_person else [],
            now=BASE_TIME,
        )
    repo.archive_draft(archived, tenant_id=TENANT, owner_user_id=OWNER, expected_revision=1, archived=True)
    repo.replace_shares(mine, tenant_id=TENANT, owner_user_id=FRIEND, group_ids=["group-lit"], user_ids=[], now=BASE_TIME)

    shared = repo.list_shared_with(tenant_id=TENANT, actor=_actor(FRIEND, "group-lit"))

    assert sorted((item.document.id, item.shared_via) for item in shared) == sorted(
        [(by_person, "user"), (by_group, "group")]
    )
    assert repo.list_shared_with(tenant_id=TENANT, actor=_actor(STRANGER, "group-tax")) == []


def test_share_summaries_count_the_owners_shared_drafts(repo) -> None:
    shared = _memo(repo)
    _memo(repo)
    repo.replace_shares(
        shared, tenant_id=TENANT, owner_user_id=OWNER, group_ids=["group-lit"], user_ids=[FRIEND, TEAMMATE],
        now=BASE_TIME,
    )

    summaries = repo.share_summaries(tenant_id=TENANT, owner_user_id=OWNER)
    assert [(item.draft_id, item.group_count, item.people_count) for item in summaries] == [(shared, 1, 2)]


# Live copy ---------------------------------------------------------------


def test_the_live_copy_starts_as_the_current_version(repo) -> None:
    draft_id = _memo(repo)

    live = repo.get_live(draft_id, tenant_id=TENANT, owner_user_id=OWNER)
    assert (live.seq, live.current_revision, live.content, live.title) == (0, 1, "<p>First memo.</p>", "Memo")


def test_a_live_save_must_start_from_the_newest_live_copy(repo) -> None:
    draft_id = _memo(repo)
    first = repo.put_live(
        draft_id,
        tenant_id=TENANT,
        owner_user_id=OWNER,
        actor_user_id=OWNER,
        client_id="client-owner",
        expected_seq=0,
        content="<p>Owner typed.</p><script>alert(1)</script>",
        now=BASE_TIME,
    )

    assert (first.seq, first.content, first.updated_by_user_id) == (1, "<p>Owner typed.</p>", OWNER)
    with pytest.raises(DraftLiveConflict) as conflict:
        repo.put_live(
            draft_id,
            tenant_id=TENANT,
            owner_user_id=OWNER,
            actor_user_id=FRIEND,
            client_id="client-friend",
            expected_seq=0,
            content="<p>Friend typed.</p>",
            now=BASE_TIME,
        )
    assert conflict.value.current == first
    second = repo.put_live(
        draft_id,
        tenant_id=TENANT,
        owner_user_id=OWNER,
        actor_user_id=FRIEND,
        client_id="client-friend",
        expected_seq=1,
        title="Memo (joint)",
        content="<p>Owner typed. Friend typed.</p>",
        now=BASE_TIME + timedelta(seconds=1),
    )
    assert (second.seq, second.title, second.updated_by_client) == (2, "Memo (joint)", "client-friend")
    assert repo.get_live(draft_id, tenant_id=TENANT, owner_user_id=OWNER) == second
    # Live saves never spend the bounded version history.
    assert second.current_revision == 1


def test_resending_the_live_copy_unchanged_does_not_advance_it(repo) -> None:
    draft_id = _memo(repo)
    first = repo.put_live(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=OWNER, client_id="client-owner",
        expected_seq=0, content="<p>Owner typed.</p>", now=BASE_TIME,
    )
    again = repo.put_live(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=OWNER, client_id="client-owner",
        expected_seq=1, content="<p>Owner typed.</p>", now=BASE_TIME,
    )
    assert again == first


def test_live_saves_are_validated_against_the_draft_kind(repo) -> None:
    deck_id = repo.create_draft(
        tenant_id=TENANT, owner_user_id=OWNER, title="Plan", content=DECK, kind="deck"
    ).document.id

    with pytest.raises(ValueError):
        repo.put_live(
            deck_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=OWNER, client_id="client-owner",
            expected_seq=0, content="<p>not a deck</p>", now=BASE_TIME,
        )
    edited = json.loads(DECK)
    edited["slides"].append({"layout": "title", "title": "Second"})
    live = repo.put_live(
        deck_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=OWNER, client_id="client-owner",
        expected_seq=0, content=json.dumps(edited), now=BASE_TIME,
    )
    assert live.kind == "deck"
    assert [slide["layout"] for slide in json.loads(live.content)["slides"]] == ["title", "title"]


# Versions ----------------------------------------------------------------


def test_saving_a_version_copies_the_live_copy_and_records_who_saved_it(repo) -> None:
    draft_id = _memo(repo)
    repo.put_live(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=FRIEND, client_id="client-friend",
        expected_seq=0, content="<p>Friend typed.</p>", now=BASE_TIME,
    )

    snapshot = repo.save_live_version(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=FRIEND, now=BASE_TIME
    )

    assert (snapshot.document.current_revision, snapshot.revision.content) == (2, "<p>Friend typed.</p>")
    versions = repo.list_versions(draft_id, tenant_id=TENANT, owner_user_id=OWNER)
    assert [(item.revision, item.author_user_id) for item in versions] == [(2, FRIEND), (1, OWNER)]
    live = repo.get_live(draft_id, tenant_id=TENANT, owner_user_id=OWNER)
    assert (live.seq, live.current_revision) == (1, 2)
    revision, author = repo.get_version(draft_id, 1, tenant_id=TENANT, owner_user_id=OWNER)
    assert (revision.content, author) == ("<p>First memo.</p>", OWNER)


def test_saving_a_version_with_no_live_changes_keeps_the_current_version(repo) -> None:
    draft_id = _memo(repo)

    snapshot = repo.save_live_version(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=OWNER, now=BASE_TIME
    )
    assert snapshot.document.current_revision == 1


def test_a_put_from_a_collaborator_is_attributed_and_moves_the_live_copy(repo) -> None:
    draft_id = _memo(repo)
    repo.put_live(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=OWNER, client_id="client-owner",
        expected_seq=0, content="<p>Owner typed.</p>", now=BASE_TIME,
    )

    snapshot = repo.update_draft_as(
        draft_id,
        actor_user_id=FRIEND,
        tenant_id=TENANT,
        owner_user_id=OWNER,
        expected_revision=1,
        content="<p>Friend rewrote it.</p>",
        now=BASE_TIME + timedelta(seconds=2),
    )

    assert snapshot.document.current_revision == 2
    live = repo.get_live(draft_id, tenant_id=TENANT, owner_user_id=OWNER)
    assert (live.seq, live.content, live.current_revision) == (2, "<p>Friend rewrote it.</p>", 2)
    assert repo.list_versions(draft_id, tenant_id=TENANT, owner_user_id=OWNER)[0].author_user_id == FRIEND
    with pytest.raises(DraftConflict):
        repo.update_draft_as(
            draft_id, actor_user_id=FRIEND, tenant_id=TENANT, owner_user_id=OWNER, expected_revision=1,
            content="<p>stale</p>",
        )


def test_purging_a_collaborator_removes_their_shares_and_authorship(repo) -> None:
    draft_id = _memo(repo)
    repo.replace_shares(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=["group-lit"], user_ids=[FRIEND],
        now=BASE_TIME,
    )
    repo.put_live(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=FRIEND, client_id="client-friend",
        expected_seq=0, content="<p>Friend typed.</p>", now=BASE_TIME,
    )
    repo.save_live_version(draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=FRIEND, now=BASE_TIME)

    repo.purge_user(tenant_id=TENANT, user_id=FRIEND)

    assert [(s.principal_kind, s.principal_id) for s in repo.list_shares(draft_id, tenant_id=TENANT, owner_user_id=OWNER)] == [
        ("group", "group-lit")
    ]
    assert repo.list_versions(draft_id, tenant_id=TENANT, owner_user_id=OWNER)[0].author_user_id is None
    assert repo.get_live(draft_id, tenant_id=TENANT, owner_user_id=OWNER).updated_by_user_id is None


def test_shared_with_me_puts_the_most_recently_edited_draft_first(repo) -> None:
    older = _memo(repo)
    newer = _memo(repo)
    for draft_id in (older, newer):
        repo.replace_shares(
            draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=["group-lit"], user_ids=[], now=BASE_TIME
        )
    edited_at = BASE_TIME + timedelta(hours=2)
    repo.put_live(
        older, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=OWNER, client_id="client-owner",
        expected_seq=0, content="<p>Edited live, later.</p>", now=edited_at,
    )

    shared = repo.list_shared_with(tenant_id=TENANT, actor=_actor(FRIEND, "group-lit"))

    assert [item.document.id for item in shared] == [older, newer]
    assert shared[0].last_edited_at == edited_at
    assert shared[1].last_edited_at == BASE_TIME


def test_shared_with_me_hides_matter_drafts_until_the_person_joins_the_matter(repo) -> None:
    matter = repo.create_matter(tenant_id=TENANT, creator_user_id=OWNER, name="Acme v. Example", now=BASE_TIME)
    draft_id = _memo(repo, matter_id=matter.id)
    repo.replace_shares(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=["group-lit"], user_ids=[], now=BASE_TIME
    )

    assert repo.list_shared_with(tenant_id=TENANT, actor=_actor(TEAMMATE, "group-lit")) == []
    repo.add_member(
        matter.id, tenant_id=TENANT, actor_user_id=OWNER, member_user_id=TEAMMATE,
        expected_version=matter.version, now=BASE_TIME + timedelta(seconds=1),
    )
    shared = repo.list_shared_with(tenant_id=TENANT, actor=_actor(TEAMMATE, "group-lit"))
    assert [item.document.id for item in shared] == [draft_id]


@pytest.mark.parametrize("expected_seq", [True, "1", -1, 1.0])
def test_a_live_save_needs_a_whole_nonnegative_seq(repo, expected_seq) -> None:
    draft_id = _memo(repo)

    with pytest.raises(ValueError):
        repo.put_live(
            draft_id, tenant_id=TENANT, owner_user_id=OWNER, actor_user_id=OWNER, client_id="client-owner",
            expected_seq=expected_seq, content="<p>x</p>", now=BASE_TIME,
        )


def test_one_draft_holds_at_most_fifty_groups_and_two_hundred_people(repo) -> None:
    draft_id = _memo(repo)
    groups = [f"group-{n}" for n in range(51)]
    people = [f"user-{n}" for n in range(201)]

    assert len(repo.replace_shares(
        draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=groups[:50], user_ids=people[:200], now=BASE_TIME
    )) == 250
    with pytest.raises(ValueError):
        repo.replace_shares(draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=groups, user_ids=[], now=BASE_TIME)
    with pytest.raises(ValueError):
        repo.replace_shares(draft_id, tenant_id=TENANT, owner_user_id=OWNER, group_ids=[], user_ids=people, now=BASE_TIME)


def test_an_unknown_version_is_not_found(repo) -> None:
    draft_id = _memo(repo)

    with pytest.raises(PrivateResourceNotFound):
        repo.get_version(draft_id, 7, tenant_id=TENANT, owner_user_id=OWNER)
