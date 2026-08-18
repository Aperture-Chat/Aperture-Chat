from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from app.core.security import SecretVault
from app.core.vector_store import LocalVectorStore
from app.db.engine import (
    HEAD_REVISION,
    alembic_config,
    create_application_engine,
    create_session_factory,
    current_schema_revision,
    upgrade_database,
)
from app.db.knowledge_import_state import knowledge_semantic_digest
from app.db.orm import Base
from app.models.schemas import KnowledgeChunk, KnowledgeDocument
from app.repositories.identity_cleanup import (
    CleanupJobConflict,
    IdentityCleanupRepository,
    VectorSourceJournalConflict,
    VectorSourceJournalCorruption,
    claim_cleanup_job_in_session,
    create_cleanup_job_in_session,
    mark_cleanup_stage_in_session,
    prepare_vector_source_journal,
    put_vector_source_journal_in_session,
)
from app.repositories.identity_config_sql import IdentityConfigSqlRepository
from app.repositories.seed import SeedStore


NOW = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)


def _sqlite_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.as_posix()}"


def _downgrade(engine: object, revision: str) -> None:
    config = alembic_config()
    with engine.begin() as connection:  # type: ignore[union-attr]
        config.attributes["connection"] = connection
        command.downgrade(config, revision)


def _knowledge_payload(
    *,
    chunk_text: str = "Thirty day retention applies.",
) -> tuple[dict[str, list[KnowledgeDocument]], dict[str, list[KnowledgeChunk]]]:
    document = KnowledgeDocument(
        id="document-a",
        knowledge_config_id="knowledge-a",
        tenant_id="tenant-a",
        name="Retention policy",
        source_uri="sharepoint://retention",
        source_type="sharepoint",
        chunk_count=1,
        acl_group_ids=["group-a"],
        updated_at="2026-07-20T12:00:00Z",
    )
    chunk = KnowledgeChunk(
        id="chunk-a",
        knowledge_config_id="knowledge-a",
        document_id=document.id,
        tenant_id=document.tenant_id,
        source_name=document.name,
        source_uri=document.source_uri,
        source_type=document.source_type,
        text=chunk_text,
        ordinal=0,
        acl_group_ids=["group-a"],
        updated_at=document.updated_at,
    )
    return {"knowledge-a": [document]}, {"knowledge-a": [chunk]}


def test_0010_fresh_schema_matches_orm_and_contains_no_cleanup_payloads(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a10-fresh.sqlite3"))
    try:
        upgrade_database(engine)
        inspector = inspect(engine)
        assert current_schema_revision(engine) == HEAD_REVISION == "20260817_0017"
        assert {
            "identity_cleanup_jobs",
            "identity_cleanup_job_users",
            "cutover_vector_source_journal",
            "cutover_vector_source_consumed",
        } <= set(inspector.get_table_names())
        assert {column["name"] for column in inspector.get_columns("identity_cleanup_jobs")} == {
            "job_id",
            "resource_kind",
            "resource_id",
            "generation",
            "tenant_id",
            "status",
            "attempt_count",
            "requested_at",
            "updated_at",
            "last_attempt_at",
            "lease_expires_at",
            "identity_committed_at",
            "application_cleared_at",
            "review_cleared_at",
            "knowledge_vector_cleared_at",
            "m9_cleared_at",
            "completed_at",
            "last_error_stage",
        }
        assert {
            column["name"] for column in inspector.get_columns("identity_cleanup_job_users")
        } == {
            "job_id",
            "resource_kind",
            "user_id",
            "session_cutoff_ms",
        }
        assert {
            "payload",
            "ciphertext",
            "secret",
            "error_message",
        }.isdisjoint(column["name"] for column in inspector.get_columns("identity_cleanup_jobs"))
        assert {
            column["name"] for column in inspector.get_columns("cutover_vector_source_journal")
        } == {
            "source_digest",
            "knowledge_digest",
            "journal_digest",
            "documents",
            "chunks",
            "document_count",
            "chunk_count",
            "created_at",
        }
        assert {
            column["name"] for column in inspector.get_columns("cutover_vector_source_consumed")
        } == {
            "source_digest",
            "knowledge_digest",
            "journal_digest",
            "consumed_at",
        }
        assert inspector.get_pk_constraint("identity_cleanup_jobs")["constrained_columns"] == [
            "job_id"
        ]
        assert inspector.get_pk_constraint("identity_cleanup_job_users")["constrained_columns"] == [
            "job_id",
            "user_id",
        ]
        assert {index["name"] for index in inspector.get_indexes("identity_cleanup_jobs")} == {
            "ix_identity_cleanup_jobs_status_lease",
            "ix_identity_cleanup_jobs_tenant_status_updated",
            "uq_identity_cleanup_jobs_active_resource",
        }
        user_foreign_keys = inspector.get_foreign_keys("identity_cleanup_job_users")
        assert len(user_foreign_keys) == 1
        assert user_foreign_keys[0]["constrained_columns"] == ["job_id", "resource_kind"]
        assert user_foreign_keys[0]["referred_table"] == "identity_cleanup_jobs"
        assert user_foreign_keys[0]["referred_columns"] == ["job_id", "resource_kind"]
        assert user_foreign_keys[0]["options"] == {"ondelete": "CASCADE"}

        with engine.connect() as connection:
            assert (
                connection.execute(text("SELECT count(*) FROM identity_cleanup_jobs")).scalar_one()
                == 0
            )
            assert (
                connection.execute(
                    text("SELECT count(*) FROM cutover_vector_source_journal")
                ).scalar_one()
                == 0
            )
            assert (
                connection.execute(
                    text("SELECT count(*) FROM cutover_vector_source_consumed")
                ).scalar_one()
                == 0
            )
            context = MigrationContext.configure(connection)
            assert compare_metadata(context, Base.metadata) == []
    finally:
        engine.dispose()


def test_0010_down_up_preserves_0009_state_and_recreates_empty_coordination_tables(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a10-linear.sqlite3"))
    try:
        upgrade_database(engine, "20260720_0009")
        with engine.begin() as connection:
            connection.execute(
                text("INSERT INTO platform_settings (singleton_id, payload) VALUES (1, '{}')")
            )
        upgrade_database(engine)
        repository = IdentityCleanupRepository(engine)
        repository.create_cleanup_job(
            resource_kind="tenant",
            resource_id="tenant-a",
            tenant_id="tenant-a",
            user_session_cutoffs={"user-a": 100},
            job_id="job-before-down",
            now=NOW,
        )

        _downgrade(engine, "20260720_0009")
        assert current_schema_revision(engine) == "20260720_0009"
        assert {
            "identity_cleanup_jobs",
            "identity_cleanup_job_users",
            "cutover_vector_source_journal",
            "cutover_vector_source_consumed",
        }.isdisjoint(inspect(engine).get_table_names())
        with engine.connect() as connection:
            assert (
                connection.execute(text("SELECT count(*) FROM platform_settings")).scalar_one() == 1
            )

        upgrade_database(engine)
        assert current_schema_revision(engine) == "20260817_0017"
        with engine.connect() as connection:
            assert (
                connection.execute(text("SELECT count(*) FROM identity_cleanup_jobs")).scalar_one()
                == 0
            )
            assert (
                connection.execute(
                    text("SELECT count(*) FROM identity_cleanup_job_users")
                ).scalar_one()
                == 0
            )
    finally:
        engine.dispose()


def test_cleanup_job_orders_stages_fences_attempts_and_preserves_all_tenant_users(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a10-jobs.sqlite3"))
    try:
        upgrade_database(engine)
        repository = IdentityCleanupRepository(engine)
        cutoffs = {
            "user-with-a5-rows": 1_721_500_000_001,
            "user-with-no-a5-rows": 1_721_500_000_001,
        }
        created = repository.create_cleanup_job(
            resource_kind="tenant",
            resource_id="tenant-a",
            tenant_id="tenant-a",
            user_session_cutoffs=cutoffs,
            job_id="cleanup-a",
            now=NOW,
        )
        assert created.generation == 1
        assert created.status == "pending"
        assert dict(created.user_session_cutoffs) == cutoffs
        assert (
            repository.create_cleanup_job(
                resource_kind="tenant",
                resource_id="tenant-a",
                tenant_id="tenant-a",
                user_session_cutoffs=cutoffs,
                job_id="cleanup-a",
                now=NOW + timedelta(seconds=1),
            )
            == created
        )
        assert [job.job_id for job in repository.list_resumable_cleanup_jobs(now=NOW)] == [
            "cleanup-a"
        ]
        with pytest.raises(CleanupJobConflict, match="cannot be recreated"):
            repository.assert_resource_recreation_allowed(
                resource_kind="tenant",
                resource_id="tenant-a",
            )

        claimed = repository.claim_cleanup_job(
            "cleanup-a",
            tenant_id="tenant-a",
            now=NOW + timedelta(seconds=2),
        )
        assert claimed.attempt_count == 1
        assert repository.list_resumable_cleanup_jobs(now=NOW + timedelta(seconds=3)) == []
        with pytest.raises(CleanupJobConflict, match="strict order"):
            repository.mark_cleanup_stage(
                "cleanup-a",
                tenant_id="tenant-a",
                stage="review",
                expected_attempt=1,
                now=NOW + timedelta(seconds=3),
            )
        identity_done = repository.mark_cleanup_stage(
            "cleanup-a",
            tenant_id="tenant-a",
            stage="identity",
            expected_attempt=1,
            now=NOW + timedelta(seconds=3),
        )
        assert identity_done.next_stage == "application"
        assert (
            repository.mark_cleanup_stage(
                "cleanup-a",
                tenant_id="tenant-a",
                stage="identity",
                expected_attempt=1,
                now=NOW + timedelta(seconds=4),
            ).identity_committed_at
            == identity_done.identity_committed_at
        )

        failed = repository.fail_cleanup_job(
            "cleanup-a",
            tenant_id="tenant-a",
            stage="application",
            expected_attempt=1,
            now=NOW + timedelta(seconds=4),
        )
        assert failed.status == "failed"
        assert failed.last_error_stage == "application"
        assert [
            job.job_id
            for job in repository.list_resumable_cleanup_jobs(now=NOW + timedelta(seconds=5))
        ] == ["cleanup-a"]
        with pytest.raises(CleanupJobConflict, match="cannot be recreated"):
            repository.assert_resource_recreation_allowed(
                resource_kind="tenant",
                resource_id="tenant-a",
            )

        reclaimed = repository.claim_cleanup_job(
            "cleanup-a",
            tenant_id="tenant-a",
            now=NOW + timedelta(seconds=5),
        )
        assert reclaimed.attempt_count == 2
        with pytest.raises(CleanupJobConflict, match="superseded"):
            repository.mark_cleanup_stage(
                "cleanup-a",
                tenant_id="tenant-a",
                stage="application",
                expected_attempt=1,
                now=NOW + timedelta(seconds=6),
            )
        for offset, stage in enumerate(
            ("application", "review", "knowledge_vector", "m9"),
            start=6,
        ):
            reclaimed = repository.mark_cleanup_stage(
                "cleanup-a",
                tenant_id="tenant-a",
                stage=stage,  # type: ignore[arg-type]
                expected_attempt=2,
                now=NOW + timedelta(seconds=offset),
            )
        assert reclaimed.next_stage is None
        completed = repository.complete_cleanup_job(
            "cleanup-a",
            tenant_id="tenant-a",
            expected_attempt=2,
            now=NOW + timedelta(seconds=10),
        )
        assert completed.status == "complete"
        assert (
            repository.complete_cleanup_job(
                "cleanup-a",
                tenant_id="tenant-a",
                expected_attempt=2,
                now=NOW + timedelta(seconds=11),
            )
            == completed
        )

        with pytest.raises(CleanupJobConflict, match="cannot be recreated"):
            repository.assert_resource_recreation_allowed(
                resource_kind="tenant",
                resource_id="tenant-a",
            )
        with pytest.raises(CleanupJobConflict, match="permanently retired"):
            repository.create_cleanup_job(
                resource_kind="tenant",
                resource_id="tenant-a",
                tenant_id="tenant-a",
                user_session_cutoffs={"user-recreated": 1_721_500_000_999},
                job_id="cleanup-a-generation-2",
                now=NOW + timedelta(seconds=12),
            )
    finally:
        engine.dispose()


def test_two_sqlite_engines_allow_one_claim_and_reject_stale_worker(
    tmp_path: Path,
) -> None:
    database_url = _sqlite_url(tmp_path / "a10-two-engine.sqlite3")
    first_engine = create_application_engine(database_url)
    second_engine = create_application_engine(database_url)
    try:
        upgrade_database(first_engine)
        first = IdentityCleanupRepository(first_engine)
        second = IdentityCleanupRepository(second_engine)
        first.create_cleanup_job(
            resource_kind="knowledge_config",
            resource_id="knowledge-a",
            tenant_id="tenant-a",
            user_session_cutoffs={},
            job_id="cleanup-knowledge-a",
            now=NOW,
        )
        assert (
            first.claim_cleanup_job(
                "cleanup-knowledge-a",
                tenant_id="tenant-a",
                now=NOW,
                lease_seconds=5,
            ).attempt_count
            == 1
        )
        with pytest.raises(CleanupJobConflict, match="already leased"):
            second.claim_cleanup_job(
                "cleanup-knowledge-a",
                tenant_id="tenant-a",
                now=NOW + timedelta(seconds=1),
                lease_seconds=5,
            )
        assert [
            job.job_id for job in second.list_resumable_cleanup_jobs(now=NOW + timedelta(seconds=5))
        ] == ["cleanup-knowledge-a"]
        assert (
            second.claim_cleanup_job(
                "cleanup-knowledge-a",
                tenant_id="tenant-a",
                now=NOW + timedelta(seconds=6),
                lease_seconds=5,
            ).attempt_count
            == 2
        )
        with pytest.raises(CleanupJobConflict, match="superseded"):
            first.mark_cleanup_stage(
                "cleanup-knowledge-a",
                tenant_id="tenant-a",
                stage="identity",
                expected_attempt=1,
                now=NOW + timedelta(seconds=7),
            )
        assert second.mark_cleanup_stage(
            "cleanup-knowledge-a",
            tenant_id="tenant-a",
            stage="identity",
            expected_attempt=2,
            now=NOW + timedelta(seconds=7),
        ).identity_committed_at == NOW + timedelta(seconds=7)
    finally:
        second_engine.dispose()
        first_engine.dispose()


def test_cleanup_user_rows_are_composite_scoped_and_cascade_with_job(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a10-user-cascade.sqlite3"))
    try:
        upgrade_database(engine)
        repository = IdentityCleanupRepository(engine)
        repository.create_cleanup_job(
            resource_kind="tenant",
            resource_id="tenant-a",
            tenant_id="tenant-a",
            user_session_cutoffs={"user-a": 101, "user-no-artifacts": 101},
            job_id="cleanup-cascade",
            now=NOW,
        )
        with pytest.raises(IntegrityError):
            with engine.begin() as connection:
                connection.execute(
                    text(
                        "INSERT INTO identity_cleanup_job_users "
                        "(job_id, resource_kind, user_id, session_cutoff_ms) "
                        "VALUES ('cleanup-cascade', 'knowledge_config', 'bad-user', 101)"
                    )
                )
        with engine.begin() as connection:
            connection.execute(
                text("DELETE FROM identity_cleanup_jobs WHERE job_id = 'cleanup-cascade'")
            )
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT count(*) FROM identity_cleanup_job_users")
                ).scalar_one()
                == 0
            )
    finally:
        engine.dispose()


def test_vector_source_journal_round_trip_conflict_corruption_and_guarded_delete(
    tmp_path: Path,
) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a10-journal.sqlite3"))
    try:
        upgrade_database(engine)
        repository = IdentityCleanupRepository(engine)
        documents, chunks = _knowledge_payload()
        knowledge_digest = knowledge_semantic_digest(documents, chunks)
        entry = repository.put_vector_source_journal(
            source_digest="a" * 64,
            knowledge_digest=knowledge_digest,
            documents=documents,
            chunks=chunks,
            created_at=NOW,
        )
        assert entry.document_count == 1
        assert entry.chunk_count == 1
        assert list(entry.documents["knowledge-a"]) == documents["knowledge-a"]
        assert list(entry.chunks["knowledge-a"]) == chunks["knowledge-a"]
        assert (
            repository.put_vector_source_journal(
                source_digest="a" * 64,
                knowledge_digest=knowledge_digest,
                documents=documents,
                chunks=chunks,
                created_at=NOW + timedelta(seconds=1),
            )
            == entry
        )

        changed_documents, changed_chunks = _knowledge_payload(chunk_text="Changed material.")
        changed_digest = knowledge_semantic_digest(changed_documents, changed_chunks)
        with pytest.raises(VectorSourceJournalConflict, match="different vector material"):
            repository.put_vector_source_journal(
                source_digest="a" * 64,
                knowledge_digest=changed_digest,
                documents=changed_documents,
                chunks=changed_chunks,
                created_at=NOW,
            )
        with pytest.raises(VectorSourceJournalConflict, match="changed"):
            repository.delete_vector_source_journal(
                "a" * 64,
                expected_knowledge_digest=knowledge_digest,
                expected_journal_digest="f" * 64,
            )

        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE cutover_vector_source_journal "
                    "SET chunk_count = 2 WHERE source_digest = :source_digest"
                ),
                {"source_digest": "a" * 64},
            )
        with pytest.raises(VectorSourceJournalCorruption, match="counts"):
            repository.get_vector_source_journal("a" * 64)
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE cutover_vector_source_journal "
                    "SET chunk_count = 1 WHERE source_digest = :source_digest"
                ),
                {"source_digest": "a" * 64},
            )
        assert repository.delete_vector_source_journal(
            "a" * 64,
            expected_knowledge_digest=knowledge_digest,
            expected_journal_digest=entry.journal_digest,
        )
        assert repository.get_vector_source_journal("a" * 64) is None
        assert not repository.delete_vector_source_journal(
            "a" * 64,
            expected_knowledge_digest=knowledge_digest,
            expected_journal_digest=entry.journal_digest,
        )
        with pytest.raises(VectorSourceJournalConflict, match="already consumed"):
            repository.put_vector_source_journal(
                source_digest="a" * 64,
                knowledge_digest=knowledge_digest,
                documents=documents,
                chunks=chunks,
                created_at=NOW + timedelta(seconds=2),
            )
    finally:
        engine.dispose()


def test_seed_store_recovers_staged_cutover_from_vector_journal_without_runtime_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = _sqlite_url(tmp_path / "a10-restart-application.sqlite3")
    runtime_state_path = tmp_path / "a10-restart-runtime-state.json"
    vector_db_path = tmp_path / "a10-restart-vectors.sqlite3"
    vault_secret = "a10-restart-recovery-secret"
    real_import = LocalVectorStore.import_legacy_knowledge_state

    def fail_after_sql_stage(
        _store: LocalVectorStore,
        **_kwargs: object,
    ) -> object:
        raise RuntimeError("simulated crash after SQL identity stage")

    monkeypatch.setattr(
        LocalVectorStore,
        "import_legacy_knowledge_state",
        fail_after_sql_stage,
    )
    with pytest.raises(RuntimeError, match="after SQL identity stage"):
        SeedStore(
            SecretVault(vault_secret),
            runtime_state_path=str(runtime_state_path),
            application_database_url=database_url,
            vector_db_path=str(vector_db_path),
        )
    monkeypatch.setattr(
        LocalVectorStore,
        "import_legacy_knowledge_state",
        real_import,
    )

    probe_engine = create_application_engine(database_url)
    restarted: SeedStore | None = None
    try:
        identity_repository = IdentityConfigSqlRepository(probe_engine)
        cleanup_repository = IdentityCleanupRepository(probe_engine)
        staged_authority = identity_repository.load_authority_state()
        assert staged_authority.status == "staged"
        assert staged_authority.snapshot is not None
        staged_receipt = staged_authority.snapshot.receipt
        journal = cleanup_repository.get_vector_source_journal(staged_receipt.source_digest)
        assert journal is not None
        assert journal.knowledge_digest == staged_receipt.knowledge_digest
        assert journal.document_count > 0
        assert journal.chunk_count > 0

        restarted = SeedStore(
            SecretVault(vault_secret),
            application_database_url=database_url,
            vector_db_path=str(vector_db_path),
        )

        active_authority = restarted.identity_config_repository.load_authority_state()
        assert active_authority.status == "active"
        assert active_authority.snapshot is not None
        assert active_authority.snapshot.receipt.source_digest == staged_receipt.source_digest
        vector_receipt = restarted.vector_store.active_import_receipt()
        assert vector_receipt is not None
        assert vector_receipt.source_digest == staged_receipt.source_digest
        assert vector_receipt.semantic_digest == staged_receipt.knowledge_digest
        assert vector_receipt.document_count == journal.document_count
        assert vector_receipt.chunk_count == journal.chunk_count
        assert cleanup_repository.get_vector_source_journal(staged_receipt.source_digest) is None
    finally:
        if restarted is not None:
            restarted.close()
        probe_engine.dispose()


def test_session_journal_helper_is_atomic_with_caller_and_two_engine_idempotent(
    tmp_path: Path,
) -> None:
    database_url = _sqlite_url(tmp_path / "a10-journal-atomic.sqlite3")
    first_engine = create_application_engine(database_url)
    second_engine = create_application_engine(database_url)
    try:
        upgrade_database(first_engine)
        documents, chunks = _knowledge_payload()
        knowledge_digest = knowledge_semantic_digest(documents, chunks)
        prepared = prepare_vector_source_journal(
            source_digest="b" * 64,
            knowledge_digest=knowledge_digest,
            documents=documents,
            chunks=chunks,
            created_at=NOW,
        )
        sessions = create_session_factory(first_engine)
        session = sessions()
        try:
            with pytest.raises(RuntimeError, match="forced staging rollback"):
                with session.begin():
                    put_vector_source_journal_in_session(session, prepared=prepared)
                    raise RuntimeError("forced staging rollback")
        finally:
            session.close()
        assert IdentityCleanupRepository(second_engine).get_vector_source_journal("b" * 64) is None

        session = sessions()
        try:
            with session.begin():
                committed = put_vector_source_journal_in_session(session, prepared=prepared)
        finally:
            session.close()
        second_repository = IdentityCleanupRepository(second_engine)
        identical = second_repository.put_vector_source_journal(
            source_digest="b" * 64,
            knowledge_digest=knowledge_digest,
            documents=documents,
            chunks=chunks,
            created_at=NOW + timedelta(seconds=1),
        )
        assert identical.journal_digest == committed.journal_digest

        changed_documents, changed_chunks = _knowledge_payload(chunk_text="Conflicting payload.")
        with pytest.raises(VectorSourceJournalConflict, match="different vector material"):
            second_repository.put_vector_source_journal(
                source_digest="b" * 64,
                knowledge_digest=knowledge_semantic_digest(
                    changed_documents,
                    changed_chunks,
                ),
                documents=changed_documents,
                chunks=changed_chunks,
                created_at=NOW,
            )
    finally:
        second_engine.dispose()
        first_engine.dispose()


def test_session_cleanup_helpers_share_caller_commit_and_rollback(tmp_path: Path) -> None:
    engine = create_application_engine(_sqlite_url(tmp_path / "a10-session-job.sqlite3"))
    try:
        upgrade_database(engine)
        sessions = create_session_factory(engine)
        session = sessions()
        try:
            with pytest.raises(RuntimeError, match="forced identity rollback"):
                with session.begin():
                    created = create_cleanup_job_in_session(
                        session,
                        resource_kind="tenant",
                        resource_id="tenant-atomic",
                        tenant_id="tenant-atomic",
                        user_session_cutoffs={"user-no-a5-artifacts": 5_000},
                        job_id="cleanup-atomic",
                        requested_at=NOW,
                    )
                    assert created.status == "pending"
                    claimed = claim_cleanup_job_in_session(
                        session,
                        job_id="cleanup-atomic",
                        tenant_id="tenant-atomic",
                        claimed_at=NOW + timedelta(seconds=1),
                        lease_expires_at=NOW + timedelta(seconds=31),
                    )
                    mark_cleanup_stage_in_session(
                        session,
                        job_id="cleanup-atomic",
                        tenant_id="tenant-atomic",
                        stage="identity",
                        expected_attempt=claimed.attempt_count,
                        completed_at=NOW + timedelta(seconds=2),
                    )
                    raise RuntimeError("forced identity rollback")
        finally:
            session.close()
        repository = IdentityCleanupRepository(engine)
        assert (
            repository.get_cleanup_job(
                "cleanup-atomic",
                tenant_id="tenant-atomic",
            )
            is None
        )

        session = sessions()
        try:
            with session.begin():
                create_cleanup_job_in_session(
                    session,
                    resource_kind="tenant",
                    resource_id="tenant-atomic",
                    tenant_id="tenant-atomic",
                    user_session_cutoffs={"user-no-a5-artifacts": 5_000},
                    job_id="cleanup-atomic",
                    requested_at=NOW,
                )
                claimed = claim_cleanup_job_in_session(
                    session,
                    job_id="cleanup-atomic",
                    tenant_id="tenant-atomic",
                    claimed_at=NOW + timedelta(seconds=1),
                    lease_expires_at=NOW + timedelta(seconds=31),
                )
                committed = mark_cleanup_stage_in_session(
                    session,
                    job_id="cleanup-atomic",
                    tenant_id="tenant-atomic",
                    stage="identity",
                    expected_attempt=claimed.attempt_count,
                    completed_at=NOW + timedelta(seconds=2),
                )
        finally:
            session.close()
        assert committed.identity_committed_at == NOW + timedelta(seconds=2)
        persisted = repository.get_cleanup_job(
            "cleanup-atomic",
            tenant_id="tenant-atomic",
        )
        assert persisted is not None
        assert persisted.attempt_count == 1
        assert dict(persisted.user_session_cutoffs) == {"user-no-a5-artifacts": 5_000}
    finally:
        engine.dispose()
