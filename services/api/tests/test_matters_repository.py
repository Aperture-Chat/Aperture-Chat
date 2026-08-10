from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, inspect, select, text

from app.db import (
    ChatFolderRow,
    ChatThreadRow,
    DraftDocumentRow,
    DraftRevisionRow,
    MatterDeletionJobRow,
    MatterMembershipRow,
    MatterRow,
    create_application_engine,
    create_session_factory,
    session_scope,
    upgrade_database,
)
from app.models.matters import (
    DRAFT_SANITIZER_VERSION,
    MAX_DRAFT_REVISIONS,
    draft_content_sha256,
)
from app.models.schemas import ChatFolder, ChatThread
from app.repositories.application_state import ApplicationStateRepository
from app.repositories.matters import (
    DraftConflict,
    DraftRevisionLimitExceeded,
    MatterAccessDenied,
    MatterConflict,
    MatterDraftRepository,
    MatterNotFound,
    MatterPersistenceUnavailable,
    PrivateResourceNotFound,
)


BASE_TIME = datetime(2026, 7, 20, 15, tzinfo=UTC)


def _url(path: Path) -> str:
    return f"sqlite:///{path}"


def _thread(thread_id: str, *, owner: str, tenant: str) -> ChatThread:
    return ChatThread(
        id=thread_id,
        tenant_id=tenant,
        owner_user_id=owner,
        title=f"Thread {thread_id}",
        model_id="model-one",
        group_id="",
        updated_at="Just now",
        messages=[],
    )


def _folder(folder_id: str, *, owner: str, tenant: str) -> ChatFolder:
    return ChatFolder(
        id=folder_id,
        tenant_id=tenant,
        owner_user_id=owner,
        name=f"Folder {folder_id}",
        created_at=BASE_TIME.isoformat(),
    )


@pytest.fixture
def repository(tmp_path: Path):
    engine = create_application_engine(_url(tmp_path / "matters.sqlite3"))
    upgrade_database(engine)
    try:
        yield engine, MatterDraftRepository(engine), ApplicationStateRepository(engine)
    finally:
        engine.dispose()


def _tenant_m9_counts(engine, tenant_id: str) -> dict[str, int]:
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        return {
            row_type.__tablename__: int(
                session.scalar(
                    select(func.count())
                    .select_from(row_type)
                    .where(row_type.tenant_id == tenant_id)
                )
                or 0
            )
            for row_type in (
                DraftDocumentRow,
                DraftRevisionRow,
                MatterDeletionJobRow,
                MatterMembershipRow,
                MatterRow,
            )
        }


def _user_private_counts(engine, *, tenant_id: str, user_id: str) -> dict[str, int]:
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        return {
            "draft_documents": int(
                session.scalar(
                    select(func.count())
                    .select_from(DraftDocumentRow)
                    .where(
                        DraftDocumentRow.tenant_id == tenant_id,
                        DraftDocumentRow.owner_user_id == user_id,
                    )
                )
                or 0
            ),
            "draft_revisions": int(
                session.scalar(
                    select(func.count())
                    .select_from(DraftRevisionRow)
                    .where(
                        DraftRevisionRow.tenant_id == tenant_id,
                        DraftRevisionRow.owner_user_id == user_id,
                    )
                )
                or 0
            ),
            "matter_memberships": int(
                session.scalar(
                    select(func.count())
                    .select_from(MatterMembershipRow)
                    .where(
                        MatterMembershipRow.tenant_id == tenant_id,
                        MatterMembershipRow.member_user_id == user_id,
                    )
                )
                or 0
            ),
        }


def test_membership_is_an_extra_gate_and_never_broadens_personal_ownership(
    repository,
) -> None:
    _engine, matters, application = repository
    created = matters.create_matter(
        tenant_id="tenant-a",
        name="Privileged IDs get no bypass",
        creator_user_id="user-one",
        member_user_ids=["user-two"],
        matter_id="matter-private",
        now=BASE_TIME,
    )
    assert created.version == 1

    for privileged_id in ("tenant-admin", "platform-owner"):
        with pytest.raises(MatterAccessDenied):
            matters.get_matter(
                "matter-private",
                tenant_id="tenant-a",
                actor_user_id=privileged_id,
            )
    with pytest.raises(MatterNotFound):
        matters.get_matter(
            "matter-private",
            tenant_id="tenant-b",
            actor_user_id="user-one",
        )

    application.upsert_chat_thread(_thread("thread-one", owner="user-one", tenant="tenant-a"))
    application.upsert_chat_folder(_folder("folder-one", owner="user-one", tenant="tenant-a"))
    with pytest.raises(PrivateResourceNotFound):
        matters.bind_chat_thread(
            "thread-one",
            tenant_id="tenant-a",
            owner_user_id="user-two",
            matter_id="matter-private",
        )
    matters.bind_chat_thread(
        "thread-one",
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-private",
    )
    matters.bind_chat_folder(
        "folder-one",
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-private",
    )
    assert (
        matters.chat_thread_ids_for_matter(
            "matter-private",
            tenant_id="tenant-a",
            actor_user_id="user-two",
        )
        == []
    )
    assert (
        matters.chat_folder_ids_for_matter(
            "matter-private",
            tenant_id="tenant-a",
            actor_user_id="user-two",
        )
        == []
    )

    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-private",
        draft_id="draft-one",
        title="Private draft",
        content="<p>Only its owner may read this.</p>",
        now=BASE_TIME,
    )
    with pytest.raises(PrivateResourceNotFound):
        matters.get_draft_in_matter(
            "draft-one",
            matter_id="matter-private",
            tenant_id="tenant-a",
            actor_user_id="user-two",
        )
    with pytest.raises(PrivateResourceNotFound):
        matters.get_draft(
            "draft-one",
            tenant_id="tenant-a",
            owner_user_id="platform-owner",
        )


def test_draft_snapshots_are_sanitized_owner_scoped_searchable_and_cas_guarded(
    repository,
) -> None:
    _engine, matters, _application = repository
    matters.create_matter(
        tenant_id="tenant-a",
        name="Matter A",
        creator_user_id="user-one",
        matter_id="matter-a",
        now=BASE_TIME,
    )
    first = matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-a",
        draft_id="draft-a",
        title="  Real   draft  ",
        content=(
            '<script>steal()</script><p onclick="steal()">needle '
            '<a href="javascript:steal()">safe label</a></p>'
        ),
        now=BASE_TIME,
    )
    assert first.document.title == "Real draft"
    assert first.revision.content == "<p>needle <a>safe label</a></p>"
    assert first.revision.sanitizer_version == DRAFT_SANITIZER_VERSION
    with pytest.raises(DraftConflict) as collision:
        matters.create_draft(
            tenant_id="tenant-b",
            owner_user_id="user-two",
            draft_id="draft-a",
            title="Cross-scope probe",
            content="<p>Probe</p>",
            now=BASE_TIME,
        )
    assert str(collision.value) == "Draft creation could not be completed."
    assert "exists" not in str(collision.value).lower()

    # This call exercises the matter+owner regression path directly.
    assert (
        matters.get_draft_in_matter(
            "draft-a",
            matter_id="matter-a",
            tenant_id="tenant-a",
            actor_user_id="user-one",
        )
        == first
    )
    assert [
        item.document.id
        for item in matters.search_drafts(
            "needle",
            tenant_id="tenant-a",
            owner_user_id="user-one",
        )
    ] == ["draft-a"]
    assert (
        matters.search_drafts(
            "needle",
            tenant_id="tenant-a",
            owner_user_id="user-two",
        )
        == []
    )
    assert (
        matters.search_drafts(
            "needle",
            tenant_id="tenant-b",
            owner_user_id="user-one",
        )
        == []
    )

    def write(content: str) -> str:
        try:
            matters.update_draft(
                "draft-a",
                tenant_id="tenant-a",
                owner_user_id="user-one",
                expected_revision=1,
                content=content,
                now=BASE_TIME + timedelta(seconds=1),
            )
        except DraftConflict:
            return "conflict"
        return "updated"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(write, ("<p>Writer one</p>", "<p>Writer two</p>")))
    assert sorted(results) == ["conflict", "updated"]
    latest = matters.get_draft(
        "draft-a",
        tenant_id="tenant-a",
        owner_user_id="user-one",
    )
    assert latest.document.current_revision == 2
    assert (
        len(
            matters.list_draft_revisions(
                "draft-a",
                tenant_id="tenant-a",
                owner_user_id="user-one",
            )
        )
        == 2
    )


def test_draft_history_ceiling_rejects_without_pruning(repository) -> None:
    engine, matters, _application = repository
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        draft_id="draft-full",
        title="Full history",
        content="<p>Revision 1</p>",
        now=BASE_TIME,
    )
    factory = create_session_factory(engine)
    with session_scope(factory) as session:
        document = session.get(DraftDocumentRow, "draft-full")
        assert document is not None
        document.current_revision = MAX_DRAFT_REVISIONS
        document.updated_at = BASE_TIME + timedelta(seconds=MAX_DRAFT_REVISIONS)
        for revision in range(2, MAX_DRAFT_REVISIONS + 1):
            content = f"<p>Revision {revision}</p>"
            session.add(
                DraftRevisionRow(
                    draft_id="draft-full",
                    revision=revision,
                    tenant_id="tenant-a",
                    owner_user_id="user-one",
                    title="Full history",
                    content=content,
                    content_sha256=draft_content_sha256(content),
                    sanitizer_version=DRAFT_SANITIZER_VERSION,
                    created_at=BASE_TIME + timedelta(seconds=revision),
                )
            )

    with pytest.raises(DraftRevisionLimitExceeded) as error:
        matters.update_draft(
            "draft-full",
            tenant_id="tenant-a",
            owner_user_id="user-one",
            expected_revision=MAX_DRAFT_REVISIONS,
            content="<p>Revision 201 must not fit.</p>",
            now=BASE_TIME + timedelta(seconds=MAX_DRAFT_REVISIONS + 1),
        )
    assert error.value.current_revision == MAX_DRAFT_REVISIONS
    assert error.value.max_revisions == MAX_DRAFT_REVISIONS
    with session_scope(factory) as session:
        assert (
            session.scalar(
                select(func.count())
                .select_from(DraftRevisionRow)
                .where(DraftRevisionRow.draft_id == "draft-full")
            )
            == MAX_DRAFT_REVISIONS
        )
        assert session.get(DraftDocumentRow, "draft-full").current_revision == (MAX_DRAFT_REVISIONS)


def test_chat_and_folder_matter_links_survive_ordinary_saves_and_restart(
    tmp_path: Path,
) -> None:
    database_url = _url(tmp_path / "matter-round-trip.sqlite3")
    engine = create_application_engine(database_url)
    upgrade_database(engine)
    matters = MatterDraftRepository(engine)
    application = ApplicationStateRepository(engine)
    matters.create_matter(
        tenant_id="tenant-a",
        name="Round trip",
        creator_user_id="user-one",
        matter_id="matter-round-trip",
        now=BASE_TIME,
    )
    application.upsert_chat_thread(
        _thread("thread-round-trip", owner="user-one", tenant="tenant-a")
    )
    application.upsert_chat_folder(
        _folder("folder-round-trip", owner="user-one", tenant="tenant-a")
    )
    matters.bind_chat_thread(
        "thread-round-trip",
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-round-trip",
    )
    matters.bind_chat_folder(
        "folder-round-trip",
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-round-trip",
    )

    # The general workspace writer receives stale/cache-shaped models with no
    # matter field. It preserves the authoritative SQL binding but cannot set
    # or resurrect one; only the membership-gated repository may do that.
    application.upsert_chat_thread(
        _thread("thread-round-trip", owner="user-one", tenant="tenant-a")
    )
    application.upsert_chat_folder(
        _folder("folder-round-trip", owner="user-one", tenant="tenant-a")
    )

    bound_thread = application.get_chat_thread("thread-round-trip")
    bound_folder = application.get_chat_folder("folder-round-trip")
    assert bound_thread is not None and bound_thread.matter_id == "matter-round-trip"
    assert bound_folder is not None and bound_folder.matter_id == "matter-round-trip"
    application.upsert_chat_folder(bound_folder.model_copy(update={"name": "Renamed"}))
    matters.bind_chat_thread(
        "thread-round-trip",
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id=None,
    )
    application.upsert_chat_thread(bound_thread.model_copy(update={"title": "Stale cached save"}))
    assert application.get_chat_thread("thread-round-trip").matter_id is None
    engine.dispose()

    restarted_engine = create_application_engine(database_url)
    try:
        upgrade_database(restarted_engine)
        restarted = ApplicationStateRepository(restarted_engine)
        assert restarted.get_chat_thread("thread-round-trip").matter_id is None
        assert restarted.get_chat_folder("folder-round-trip").matter_id == ("matter-round-trip")
    finally:
        restarted_engine.dispose()


def test_deletion_intent_is_restart_safe_fenced_and_never_deletes_work(
    tmp_path: Path,
) -> None:
    database_url = _url(tmp_path / "matter-deletion.sqlite3")
    engine = create_application_engine(database_url)
    upgrade_database(engine)
    matters = MatterDraftRepository(engine)
    application = ApplicationStateRepository(engine)
    matter = matters.create_matter(
        tenant_id="tenant-a",
        name="Deletion saga",
        creator_user_id="user-one",
        matter_id="matter-delete",
        now=BASE_TIME,
    )
    application.upsert_chat_thread(_thread("thread-delete", owner="user-one", tenant="tenant-a"))
    application.upsert_chat_folder(_folder("folder-delete", owner="user-one", tenant="tenant-a"))
    matters.bind_chat_thread(
        "thread-delete",
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-delete",
    )
    matters.bind_chat_folder(
        "folder-delete",
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-delete",
    )
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-delete",
        draft_id="draft-delete",
        title="Work survives",
        content="<p>Never delete this work.</p>",
        now=BASE_TIME,
    )

    requested = matters.request_matter_deletion(
        "matter-delete",
        tenant_id="tenant-a",
        actor_user_id="user-one",
        expected_version=matter.version,
        now=BASE_TIME + timedelta(seconds=1),
    )
    assert requested.status == "pending"
    with pytest.raises(MatterConflict):
        matters.update_matter(
            "matter-delete",
            tenant_id="tenant-a",
            actor_user_id="user-one",
            expected_version=matter.version,
            name="Frozen",
            now=BASE_TIME + timedelta(seconds=2),
        )
    with pytest.raises(MatterConflict):
        matters.update_draft(
            "draft-delete",
            tenant_id="tenant-a",
            owner_user_id="user-one",
            expected_revision=1,
            content="<p>Frozen while linked.</p>",
            now=BASE_TIME + timedelta(seconds=2),
        )
    with pytest.raises(MatterConflict):
        matters.bind_chat_thread(
            "thread-delete",
            tenant_id="tenant-a",
            owner_user_id="user-one",
            matter_id=None,
        )
    with pytest.raises(MatterConflict):
        matters.finalize_matter_deletion(
            "matter-delete",
            tenant_id="tenant-a",
            now=BASE_TIME + timedelta(seconds=2),
        )

    first_attempt = matters.claim_matter_deletion(
        "matter-delete",
        tenant_id="tenant-a",
        now=BASE_TIME + timedelta(seconds=3),
        lease_seconds=60,
    )
    assert first_attempt.attempt_count == 1
    unlinked = matters.clear_application_matter_references(
        "matter-delete",
        tenant_id="tenant-a",
        expected_attempt=1,
        now=BASE_TIME + timedelta(seconds=4),
    )
    assert unlinked.unlinked_chat_thread_ids == ["thread-delete"]
    assert unlinked.unlinked_chat_folder_ids == ["folder-delete"]
    assert unlinked.unlinked_draft_ids == ["draft-delete"]
    matters.mark_matter_deletion_stage_cleared(
        "matter-delete",
        tenant_id="tenant-a",
        stage="review",
        expected_attempt=1,
        now=BASE_TIME + timedelta(seconds=5),
    )
    failed = matters.mark_matter_deletion_failed(
        "matter-delete",
        tenant_id="tenant-a",
        stage="knowledge",
        expected_attempt=1,
        now=BASE_TIME + timedelta(seconds=6),
    )
    assert failed.status == "failed"
    assert failed.last_error_stage == "knowledge"
    engine.dispose()

    restarted_engine = create_application_engine(database_url)
    try:
        upgrade_database(restarted_engine)
        restarted = MatterDraftRepository(restarted_engine)
        second_attempt = restarted.claim_matter_deletion(
            "matter-delete",
            tenant_id="tenant-a",
            now=BASE_TIME + timedelta(seconds=7),
            lease_seconds=60,
        )
        assert second_attempt.attempt_count == 2
        with pytest.raises(MatterConflict, match="superseded"):
            restarted.mark_matter_deletion_stage_cleared(
                "matter-delete",
                tenant_id="tenant-a",
                stage="knowledge",
                expected_attempt=1,
                now=BASE_TIME + timedelta(seconds=8),
            )
        restarted.mark_matter_deletion_stage_cleared(
            "matter-delete",
            tenant_id="tenant-a",
            stage="knowledge",
            expected_attempt=2,
            now=BASE_TIME + timedelta(seconds=9),
        )
        ready = restarted.mark_matter_deletion_stage_cleared(
            "matter-delete",
            tenant_id="tenant-a",
            stage="legacy",
            expected_attempt=2,
            now=BASE_TIME + timedelta(seconds=10),
        )
        assert ready.status == "ready"
        complete = restarted.finalize_matter_deletion(
            "matter-delete",
            tenant_id="tenant-a",
            now=BASE_TIME + timedelta(seconds=11),
        )
        assert complete.status == "complete"
        assert restarted.finalize_matter_deletion(
            "matter-delete",
            tenant_id="tenant-a",
            now=BASE_TIME + timedelta(seconds=12),
        ) == complete.model_copy(
            update={
                "updated_at": complete.updated_at,
                "completed_at": complete.completed_at,
            }
        )
        assert (
            restarted.get_matter_deletion_job(
                "matter-delete",
                tenant_id="tenant-a",
                actor_user_id="user-one",
            ).status
            == "complete"
        )
        with pytest.raises(MatterAccessDenied):
            restarted.get_matter_deletion_job(
                "matter-delete",
                tenant_id="tenant-a",
                actor_user_id="another-user",
            )
        with pytest.raises(MatterNotFound):
            restarted.get_matter(
                "matter-delete",
                tenant_id="tenant-a",
                actor_user_id="user-one",
            )

        factory = create_session_factory(restarted_engine)
        with session_scope(factory) as session:
            assert session.get(MatterRow, "matter-delete") is None
            assert session.get(MatterDeletionJobRow, "matter-delete") is not None
            assert session.scalar(select(func.count()).select_from(ChatThreadRow)) == 1
            assert session.scalar(select(func.count()).select_from(ChatFolderRow)) == 1
            assert session.scalar(select(func.count()).select_from(DraftDocumentRow)) == 1
            assert session.scalar(select(func.count()).select_from(DraftRevisionRow)) == 1
            assert session.get(ChatThreadRow, 1).matter_id is None
            assert session.get(ChatFolderRow, 1).matter_id is None
            draft = session.get(DraftDocumentRow, "draft-delete")
            assert draft is not None and draft.matter_id is None
            revision = session.get(
                DraftRevisionRow,
                {"draft_id": "draft-delete", "revision": 1},
            )
            assert revision is not None
            assert revision.content == "<p>Never delete this work.</p>"

        assert set(inspect(restarted_engine).get_columns("matter_deletion_jobs")[0]) >= {
            "name",
            "type",
        }
        assert not {
            "content",
            "payload",
            "title",
            "body",
        } & {
            column["name"]
            for column in inspect(restarted_engine).get_columns("matter_deletion_jobs")
        }
    finally:
        restarted_engine.dispose()


def test_expired_lease_can_be_reclaimed_and_old_attempt_is_fenced(repository) -> None:
    _engine, matters, _application = repository
    matters.create_matter(
        tenant_id="tenant-a",
        name="Lease",
        creator_user_id="user-one",
        matter_id="matter-lease",
        now=BASE_TIME,
    )
    matters.request_matter_deletion(
        "matter-lease",
        tenant_id="tenant-a",
        actor_user_id="user-one",
        expected_version=1,
        now=BASE_TIME + timedelta(seconds=1),
    )
    matters.claim_matter_deletion(
        "matter-lease",
        tenant_id="tenant-a",
        now=BASE_TIME + timedelta(seconds=2),
        lease_seconds=1,
    )
    with pytest.raises(MatterConflict, match="already leased"):
        matters.claim_matter_deletion(
            "matter-lease",
            tenant_id="tenant-a",
            now=BASE_TIME + timedelta(seconds=2, milliseconds=500),
            lease_seconds=1,
        )
    reclaimed = matters.claim_matter_deletion(
        "matter-lease",
        tenant_id="tenant-a",
        now=BASE_TIME + timedelta(seconds=4),
        lease_seconds=10,
    )
    assert reclaimed.attempt_count == 2
    with pytest.raises(MatterConflict, match="superseded"):
        matters.clear_application_matter_references(
            "matter-lease",
            tenant_id="tenant-a",
            expected_attempt=1,
            now=BASE_TIME + timedelta(seconds=5),
        )


def test_tenant_purge_removes_every_m9_row_and_preserves_another_tenant(
    repository,
) -> None:
    engine, matters, _application = repository
    for suffix, tenant_id in (("a", "tenant-a"), ("b", "tenant-b")):
        matter_id = f"matter-purge-{suffix}"
        matters.create_matter(
            tenant_id=tenant_id,
            name=f"Tenant {suffix.upper()} lifecycle",
            creator_user_id="shared-user",
            member_user_ids=[f"survivor-{suffix}"],
            matter_id=matter_id,
            now=BASE_TIME,
        )
        linked = matters.create_draft(
            tenant_id=tenant_id,
            owner_user_id="shared-user",
            matter_id=matter_id,
            draft_id=f"draft-linked-{suffix}",
            title="Linked private draft",
            content="<p>Revision one</p>",
            now=BASE_TIME,
        )
        matters.update_draft(
            linked.document.id,
            tenant_id=tenant_id,
            owner_user_id="shared-user",
            expected_revision=1,
            content="<p>Revision two</p>",
            now=BASE_TIME + timedelta(seconds=1),
        )
        matters.create_draft(
            tenant_id=tenant_id,
            owner_user_id="shared-user",
            draft_id=f"draft-unbound-{suffix}",
            title="Unbound private draft",
            content="<p>Independent work</p>",
            now=BASE_TIME,
        )
        matters.request_matter_deletion(
            matter_id,
            tenant_id=tenant_id,
            actor_user_id="shared-user",
            expected_version=1,
            now=BASE_TIME + timedelta(seconds=2),
        )

    tenant_b_before = _tenant_m9_counts(engine, "tenant-b")
    removed = matters.purge_tenant("tenant-a")

    assert removed == {
        "removed_drafts": 2,
        "removed_deletion_jobs": 1,
        "removed_memberships": 2,
        "removed_matters": 1,
    }
    assert _tenant_m9_counts(engine, "tenant-a") == {
        "draft_documents": 0,
        "draft_revisions": 0,
        "matter_deletion_jobs": 0,
        "matter_memberships": 0,
        "matters": 0,
    }
    assert _tenant_m9_counts(engine, "tenant-b") == tenant_b_before
    assert (
        matters.get_matter(
            "matter-purge-b",
            tenant_id="tenant-b",
            actor_user_id="shared-user",
        ).name
        == "Tenant B lifecycle"
    )
    assert (
        matters.get_draft(
            "draft-linked-b",
            tenant_id="tenant-b",
            owner_user_id="shared-user",
        ).document.current_revision
        == 2
    )
    assert matters.purge_tenant("tenant-a") == {
        "removed_drafts": 0,
        "removed_deletion_jobs": 0,
        "removed_memberships": 0,
        "removed_matters": 0,
    }


def test_tenant_purge_failure_rolls_back_without_partial_mutation(repository) -> None:
    engine, matters, _application = repository
    matters.create_matter(
        tenant_id="tenant-a",
        name="Atomic tenant cleanup",
        creator_user_id="user-one",
        member_user_ids=["user-two"],
        matter_id="matter-atomic-purge",
        now=BASE_TIME,
    )
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="user-one",
        matter_id="matter-atomic-purge",
        draft_id="draft-atomic-purge",
        title="Atomic draft",
        content="<p>Must survive a failed purge.</p>",
        now=BASE_TIME,
    )
    matters.request_matter_deletion(
        "matter-atomic-purge",
        tenant_id="tenant-a",
        actor_user_id="user-one",
        expected_version=1,
        now=BASE_TIME + timedelta(seconds=1),
    )
    before = _tenant_m9_counts(engine, "tenant-a")
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TRIGGER reject_m9_membership_purge "
                "BEFORE DELETE ON matter_memberships "
                "WHEN OLD.tenant_id = 'tenant-a' "
                "BEGIN SELECT RAISE(ABORT, 'forced tenant cleanup failure'); END"
            )
        )

    with pytest.raises(MatterPersistenceUnavailable, match="could not be completed"):
        matters.purge_tenant("tenant-a")

    assert _tenant_m9_counts(engine, "tenant-a") == before
    assert (
        matters.get_draft(
            "draft-atomic-purge",
            tenant_id="tenant-a",
            owner_user_id="user-one",
        ).revision.content
        == "<p>Must survive a failed purge.</p>"
    )


def test_user_deactivation_requires_no_m9_mutation_and_survives_restart(
    tmp_path: Path,
) -> None:
    database_url = _url(tmp_path / "matter-deactivation.sqlite3")
    engine = create_application_engine(database_url)
    upgrade_database(engine)
    matters = MatterDraftRepository(engine)
    matters.create_matter(
        tenant_id="tenant-a",
        name="Quarantined while inactive",
        creator_user_id="deactivated-user",
        matter_id="matter-deactivated-user",
        now=BASE_TIME,
    )
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="deactivated-user",
        matter_id="matter-deactivated-user",
        draft_id="draft-deactivated-user",
        title="Private inactive work",
        content="<p>Revision one remains quarantined.</p>",
        now=BASE_TIME,
    )
    matters.update_draft(
        "draft-deactivated-user",
        tenant_id="tenant-a",
        owner_user_id="deactivated-user",
        expected_revision=1,
        content="<p>Revision two remains quarantined.</p>",
        now=BASE_TIME + timedelta(seconds=1),
    )

    # Reversible identity deactivation deliberately invokes no M9 purge.
    # Closing and reopening proves the membership and private history remain
    # durable for a later identity reactivation.
    engine.dispose()
    restarted_engine = create_application_engine(database_url)
    try:
        upgrade_database(restarted_engine)
        restarted = MatterDraftRepository(restarted_engine)
        matter = restarted.get_matter(
            "matter-deactivated-user",
            tenant_id="tenant-a",
            actor_user_id="deactivated-user",
        )
        assert matter.created_by_user_id == "deactivated-user"
        assert [
            membership.member_user_id
            for membership in restarted.list_memberships(
                matter.id,
                tenant_id="tenant-a",
                actor_user_id="deactivated-user",
            )
        ] == ["deactivated-user"]
        assert (
            restarted.get_draft(
                "draft-deactivated-user",
                tenant_id="tenant-a",
                owner_user_id="deactivated-user",
            ).document.current_revision
            == 2
        )
        assert (
            len(
                restarted.list_draft_revisions(
                    "draft-deactivated-user",
                    tenant_id="tenant-a",
                    owner_user_id="deactivated-user",
                )
            )
            == 2
        )
    finally:
        restarted_engine.dispose()


def test_permanent_user_purge_blocks_sole_member_without_partial_mutation(
    repository,
) -> None:
    engine, matters, _application = repository
    matters.create_matter(
        tenant_id="tenant-a",
        name="Sole membership blocks deletion",
        creator_user_id="departing-user",
        matter_id="matter-sole-member",
        now=BASE_TIME,
    )
    matters.create_matter(
        tenant_id="tenant-a",
        name="Shared work must also remain",
        creator_user_id="departing-user",
        member_user_ids=["surviving-user"],
        matter_id="matter-shared-before-block",
        now=BASE_TIME,
    )
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="departing-user",
        matter_id="matter-shared-before-block",
        draft_id="draft-before-sole-block",
        title="No partial cleanup",
        content="<p>This private draft must remain.</p>",
        now=BASE_TIME,
    )
    before = _user_private_counts(
        engine,
        tenant_id="tenant-a",
        user_id="departing-user",
    )

    with pytest.raises(MatterConflict, match="without an explicit member"):
        matters.preflight_permanent_user_purge(
            tenant_id="tenant-a",
            user_id="departing-user",
        )
    with pytest.raises(MatterConflict, match="without an explicit member"):
        matters.purge_permanent_user(
            tenant_id="tenant-a",
            user_id="departing-user",
        )

    assert (
        _user_private_counts(
            engine,
            tenant_id="tenant-a",
            user_id="departing-user",
        )
        == before
    )
    assert (
        matters.get_matter(
            "matter-sole-member",
            tenant_id="tenant-a",
            actor_user_id="departing-user",
        ).created_by_user_id
        == "departing-user"
    )
    assert (
        matters.get_draft(
            "draft-before-sole-block",
            tenant_id="tenant-a",
            owner_user_id="departing-user",
        ).revision.content
        == "<p>This private draft must remain.</p>"
    )


def test_permanent_user_purge_blocks_incomplete_deletion_requester(
    repository,
) -> None:
    engine, matters, _application = repository
    matters.create_matter(
        tenant_id="tenant-a",
        name="Deletion requester cannot depart",
        creator_user_id="departing-user",
        member_user_ids=["surviving-user"],
        matter_id="matter-requester-block",
        now=BASE_TIME,
    )
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="departing-user",
        matter_id="matter-requester-block",
        draft_id="draft-requester-block",
        title="Requester private work",
        content="<p>Pending cleanup cannot strand this work.</p>",
        now=BASE_TIME,
    )
    matters.request_matter_deletion(
        "matter-requester-block",
        tenant_id="tenant-a",
        actor_user_id="departing-user",
        expected_version=1,
        now=BASE_TIME + timedelta(seconds=1),
    )
    before = _user_private_counts(
        engine,
        tenant_id="tenant-a",
        user_id="departing-user",
    )

    with pytest.raises(MatterConflict, match="incomplete matter deletion request"):
        matters.preflight_permanent_user_purge(
            tenant_id="tenant-a",
            user_id="departing-user",
        )
    with pytest.raises(MatterConflict, match="incomplete matter deletion request"):
        matters.purge_permanent_user(
            tenant_id="tenant-a",
            user_id="departing-user",
        )

    assert (
        _user_private_counts(
            engine,
            tenant_id="tenant-a",
            user_id="departing-user",
        )
        == before
    )
    assert (
        matters.get_matter_deletion_job(
            "matter-requester-block",
            tenant_id="tenant-a",
            actor_user_id="departing-user",
        ).status
        == "pending"
    )
    assert (
        matters.get_draft(
            "draft-requester-block",
            tenant_id="tenant-a",
            owner_user_id="departing-user",
        ).revision.content
        == "<p>Pending cleanup cannot strand this work.</p>"
    )


def test_permanent_user_purge_failure_rolls_back_private_state(repository) -> None:
    engine, matters, _application = repository
    matters.create_matter(
        tenant_id="tenant-a",
        name="Atomic permanent user cleanup",
        creator_user_id="departing-user",
        member_user_ids=["surviving-user"],
        matter_id="matter-user-purge-failure",
        now=BASE_TIME,
    )
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="departing-user",
        matter_id="matter-user-purge-failure",
        draft_id="draft-user-purge-failure",
        title="Private work survives failure",
        content="<p>Rollback must restore this revision.</p>",
        now=BASE_TIME,
    )
    before = _user_private_counts(
        engine,
        tenant_id="tenant-a",
        user_id="departing-user",
    )
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TRIGGER reject_m9_user_membership_purge "
                "BEFORE DELETE ON matter_memberships "
                "WHEN OLD.tenant_id = 'tenant-a' "
                "AND OLD.member_user_id = 'departing-user' "
                "BEGIN SELECT RAISE(ABORT, 'forced user cleanup failure'); END"
            )
        )

    with pytest.raises(MatterPersistenceUnavailable, match="could not be completed"):
        matters.purge_permanent_user(
            tenant_id="tenant-a",
            user_id="departing-user",
        )

    assert (
        _user_private_counts(
            engine,
            tenant_id="tenant-a",
            user_id="departing-user",
        )
        == before
    )
    assert (
        matters.get_draft(
            "draft-user-purge-failure",
            tenant_id="tenant-a",
            owner_user_id="departing-user",
        ).revision.content
        == "<p>Rollback must restore this revision.</p>"
    )


def test_permanent_user_purge_is_tenant_scoped_and_retains_attribution(
    repository,
) -> None:
    engine, matters, _application = repository
    attributed = matters.create_matter(
        tenant_id="tenant-a",
        name="Creator attribution remains",
        creator_user_id="departing-user",
        member_user_ids=["surviving-user"],
        matter_id="matter-created-by-departing",
        now=BASE_TIME,
    )
    matters.create_matter(
        tenant_id="tenant-a",
        name="Departing user is only an added member",
        creator_user_id="surviving-user",
        member_user_ids=["departing-user"],
        matter_id="matter-member-departing",
        now=BASE_TIME,
    )
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="departing-user",
        matter_id=attributed.id,
        draft_id="draft-departing-linked",
        title="Departing linked draft",
        content="<p>First private revision.</p>",
        now=BASE_TIME,
    )
    matters.update_draft(
        "draft-departing-linked",
        tenant_id="tenant-a",
        owner_user_id="departing-user",
        expected_revision=1,
        content="<p>Second private revision.</p>",
        now=BASE_TIME + timedelta(seconds=1),
    )
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="departing-user",
        draft_id="draft-departing-unbound",
        title="Departing unbound draft",
        content="<p>Unbound private work.</p>",
        now=BASE_TIME,
    )
    matters.create_draft(
        tenant_id="tenant-a",
        owner_user_id="surviving-user",
        matter_id=attributed.id,
        draft_id="draft-survivor",
        title="Survivor private draft",
        content="<p>Must remain private to the survivor.</p>",
        now=BASE_TIME,
    )

    matters.create_matter(
        tenant_id="tenant-b",
        name="Same user id in another tenant",
        creator_user_id="departing-user",
        member_user_ids=["tenant-b-survivor"],
        matter_id="matter-cross-tenant-user",
        now=BASE_TIME,
    )
    matters.create_draft(
        tenant_id="tenant-b",
        owner_user_id="departing-user",
        matter_id="matter-cross-tenant-user",
        draft_id="draft-cross-tenant-user",
        title="Cross-tenant private draft",
        content="<p>Another tenant must remain untouched.</p>",
        now=BASE_TIME,
    )

    matters.create_matter(
        tenant_id="tenant-a",
        name="Completed requester tombstone",
        creator_user_id="departing-user",
        member_user_ids=["surviving-user"],
        matter_id="matter-complete-requester",
        now=BASE_TIME,
    )
    matters.request_matter_deletion(
        "matter-complete-requester",
        tenant_id="tenant-a",
        actor_user_id="departing-user",
        expected_version=1,
        now=BASE_TIME + timedelta(seconds=1),
    )
    matters.claim_matter_deletion(
        "matter-complete-requester",
        tenant_id="tenant-a",
        now=BASE_TIME + timedelta(seconds=2),
    )
    matters.clear_application_matter_references(
        "matter-complete-requester",
        tenant_id="tenant-a",
        expected_attempt=1,
        now=BASE_TIME + timedelta(seconds=3),
    )
    for index, stage in enumerate(("review", "knowledge", "legacy"), start=4):
        matters.mark_matter_deletion_stage_cleared(
            "matter-complete-requester",
            tenant_id="tenant-a",
            stage=stage,
            expected_attempt=1,
            now=BASE_TIME + timedelta(seconds=index),
        )
    matters.finalize_matter_deletion(
        "matter-complete-requester",
        tenant_id="tenant-a",
        now=BASE_TIME + timedelta(seconds=7),
    )

    matters.preflight_permanent_user_purge(
        tenant_id="tenant-a",
        user_id="departing-user",
    )
    removed = matters.purge_permanent_user(
        tenant_id="tenant-a",
        user_id="departing-user",
    )

    assert removed == {
        "removed_draft_revisions": 3,
        "removed_drafts": 2,
        "removed_memberships": 2,
    }
    assert _user_private_counts(
        engine,
        tenant_id="tenant-a",
        user_id="departing-user",
    ) == {
        "draft_documents": 0,
        "draft_revisions": 0,
        "matter_memberships": 0,
    }
    retained = matters.get_matter(
        attributed.id,
        tenant_id="tenant-a",
        actor_user_id="surviving-user",
    )
    assert retained.created_by_user_id == "departing-user"
    assert [
        membership.member_user_id
        for membership in matters.list_memberships(
            attributed.id,
            tenant_id="tenant-a",
            actor_user_id="surviving-user",
        )
    ] == ["surviving-user"]
    assert (
        matters.get_draft(
            "draft-survivor",
            tenant_id="tenant-a",
            owner_user_id="surviving-user",
        ).revision.content
        == "<p>Must remain private to the survivor.</p>"
    )
    with pytest.raises(PrivateResourceNotFound):
        matters.get_draft(
            "draft-departing-linked",
            tenant_id="tenant-a",
            owner_user_id="departing-user",
        )
    assert (
        matters.get_matter(
            "matter-cross-tenant-user",
            tenant_id="tenant-b",
            actor_user_id="departing-user",
        ).created_by_user_id
        == "departing-user"
    )
    assert (
        matters.get_draft(
            "draft-cross-tenant-user",
            tenant_id="tenant-b",
            owner_user_id="departing-user",
        ).revision.content
        == "<p>Another tenant must remain untouched.</p>"
    )
    assert (
        matters.get_matter_deletion_job(
            "matter-complete-requester",
            tenant_id="tenant-a",
            actor_user_id="departing-user",
        ).status
        == "complete"
    )
