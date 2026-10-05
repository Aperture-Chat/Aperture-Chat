"""Persistence for personal-data protection and training-dataset capture.

Bound to the application engine like ``ModelAccessRequestRepository``. Holds
two small per-tenant policies (``privacy`` and ``training``), administrator
datasets, and de-identified training examples. Chat, user, and tenant
deletion remove examples inside the application-state transactions that
delete their source rows, so this repository never outlives its sources.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any, TypeVar
from uuid import uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.core import clock
from app.db.engine import create_session_factory, engine_write_lock
from app.db.orm import TenantDataPolicyRow, TrainingDatasetRow, TrainingExampleRow
from app.models.schemas import (
    TenantPrivacyPolicy,
    TrainingCapturePolicy,
    TrainingDataset,
    TrainingDatasetRules,
    TrainingExample,
)

T = TypeVar("T")

# Upper bound for one tenant's in-memory routing and export pass.
MAX_EXAMPLES_PER_TENANT_READ = 50_000

_EXAMPLE_PAYLOAD_FIELDS = (
    "practice_source",
    "group_ids",
    "prompt",
    "completion",
    "correction",
    "revision",
    "revision_accepted",
    "correction_kind",
    "comment",
    "redaction_count",
    "reviewed_by",
    "reviewed_at",
)


def new_dataset_id() -> str:
    return f"dataset-{uuid4()}"


def new_example_id() -> str:
    return f"example-{uuid4()}"


def _example_from_row(row: TrainingExampleRow) -> TrainingExample:
    payload = dict(row.payload or {})
    return TrainingExample(
        id=row.id,
        tenant_id=row.tenant_id,
        thread_id=row.thread_id,
        message_id=row.message_id,
        signal=row.signal,
        status=row.status,
        user_id=row.user_id,
        model_id=row.model_id,
        practice_area=row.practice_area,
        task_type=row.task_type,
        captured_at=row.captured_at,
        updated_at=row.updated_at,
        **{key: payload[key] for key in _EXAMPLE_PAYLOAD_FIELDS if key in payload},
    )


def _example_payload(example: TrainingExample) -> dict[str, Any]:
    dumped = example.model_dump(mode="json")
    return {key: dumped[key] for key in _EXAMPLE_PAYLOAD_FIELDS}


def _dataset_from_row(row: TrainingDatasetRow) -> TrainingDataset:
    payload = dict(row.payload or {})
    return TrainingDataset(
        id=row.id,
        tenant_id=row.tenant_id,
        name=row.name,
        description=str(payload.get("description") or ""),
        format=payload.get("format") or "sft",
        rules=TrainingDatasetRules.model_validate(payload.get("rules") or {}),
        system_prompt=str(payload.get("system_prompt") or ""),
        archived=row.archived,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class DataProtectionRepository:
    def __init__(
        self,
        engine: Engine,
        *,
        session_factory: sessionmaker[Session] | None = None,
    ) -> None:
        self.engine = engine
        self._sessions = session_factory or create_session_factory(engine)
        self._lock = engine_write_lock(engine)

    # Policies ----------------------------------------------------------

    def privacy_policy(self, tenant_id: str) -> TenantPrivacyPolicy:
        payload = self._policy_payload(tenant_id, "privacy")
        if payload is None:
            return TenantPrivacyPolicy(tenant_id=tenant_id)
        return TenantPrivacyPolicy.model_validate({**payload, "tenant_id": tenant_id})

    def save_privacy_policy(self, policy: TenantPrivacyPolicy) -> TenantPrivacyPolicy:
        self._save_policy(policy.tenant_id, "privacy", policy.model_dump(mode="json"))
        return policy

    def training_policy(self, tenant_id: str) -> TrainingCapturePolicy:
        payload = self._policy_payload(tenant_id, "training")
        if payload is None:
            return TrainingCapturePolicy(tenant_id=tenant_id)
        return TrainingCapturePolicy.model_validate({**payload, "tenant_id": tenant_id})

    def save_training_policy(self, policy: TrainingCapturePolicy) -> TrainingCapturePolicy:
        self._save_policy(policy.tenant_id, "training", policy.model_dump(mode="json"))
        return policy

    def _policy_payload(self, tenant_id: str, kind: str) -> dict[str, Any] | None:
        def operation(session: Session) -> dict[str, Any] | None:
            row = session.get(TenantDataPolicyRow, (tenant_id, kind))
            return dict(row.payload) if row is not None else None

        return self._run_read(operation)

    def _save_policy(self, tenant_id: str, kind: str, payload: dict[str, Any]) -> None:
        def operation(session: Session) -> None:
            row = session.get(TenantDataPolicyRow, (tenant_id, kind))
            if row is None:
                session.add(
                    TenantDataPolicyRow(
                        tenant_id=tenant_id, kind=kind, payload=payload, updated_at=clock.now()
                    )
                )
            else:
                row.payload = payload
                row.updated_at = clock.now()

        self._run_write(operation)

    # Datasets ----------------------------------------------------------

    def list_datasets(self, tenant_id: str) -> list[TrainingDataset]:
        def operation(session: Session) -> list[TrainingDataset]:
            rows = session.scalars(
                select(TrainingDatasetRow)
                .where(TrainingDatasetRow.tenant_id == tenant_id)
                .order_by(TrainingDatasetRow.created_at, TrainingDatasetRow.id)
            )
            return [_dataset_from_row(row) for row in rows]

        return self._run_read(operation)

    def get_dataset(self, dataset_id: str, *, tenant_id: str) -> TrainingDataset | None:
        def operation(session: Session) -> TrainingDataset | None:
            row = session.get(TrainingDatasetRow, dataset_id)
            if row is None or row.tenant_id != tenant_id:
                return None
            return _dataset_from_row(row)

        return self._run_read(operation)

    def save_dataset(self, dataset: TrainingDataset) -> TrainingDataset:
        payload = {
            "description": dataset.description,
            "format": dataset.format,
            "rules": dataset.rules.model_dump(mode="json"),
            "system_prompt": dataset.system_prompt,
        }

        def operation(session: Session) -> TrainingDataset:
            row = session.get(TrainingDatasetRow, dataset.id)
            if row is None:
                row = TrainingDatasetRow(
                    id=dataset.id,
                    tenant_id=dataset.tenant_id,
                    name=dataset.name,
                    archived=dataset.archived,
                    payload=payload,
                    created_by=dataset.created_by,
                    created_at=dataset.created_at,
                    updated_at=dataset.updated_at,
                )
                session.add(row)
            else:
                if row.tenant_id != dataset.tenant_id:
                    raise ValueError("Dataset belongs to another organization.")
                row.name = dataset.name
                row.archived = dataset.archived
                row.payload = payload
                row.updated_at = dataset.updated_at
            session.flush()
            return _dataset_from_row(row)

        return self._run_write(operation)

    def delete_dataset(self, dataset_id: str, *, tenant_id: str) -> bool:
        def operation(session: Session) -> bool:
            row = session.get(TrainingDatasetRow, dataset_id)
            if row is None or row.tenant_id != tenant_id:
                return False
            session.delete(row)
            return True

        return self._run_write(operation)

    # Examples ----------------------------------------------------------

    def replace_thread_examples(
        self,
        *,
        tenant_id: str,
        thread_id: str,
        examples: Iterable[TrainingExample],
        auto_approve: bool,
    ) -> int:
        """Make the thread's stored examples match ``examples`` exactly.

        Identity is (thread, message, signal). A reviewer's decision survives
        recaptures that leave the text unchanged; an approved example whose
        text changed returns to review, and signals that no longer exist (a
        thumb flipped, a correction edited away) are removed. Returns how many new
        examples were captured.
        """

        candidates = {(example.message_id, example.signal): example for example in examples}

        def operation(session: Session) -> int:
            existing = {
                (row.message_id, row.signal): row
                for row in session.scalars(
                    select(TrainingExampleRow).where(
                        TrainingExampleRow.tenant_id == tenant_id,
                        TrainingExampleRow.thread_id == thread_id,
                    )
                )
            }
            now = clock.now()
            created = 0
            for key, row in existing.items():
                if key not in candidates:
                    session.delete(row)
            for key, example in candidates.items():
                row = existing.get(key)
                if row is None:
                    session.add(
                        TrainingExampleRow(
                            id=example.id or new_example_id(),
                            tenant_id=tenant_id,
                            thread_id=thread_id,
                            message_id=example.message_id,
                            signal=example.signal,
                            status="approved" if auto_approve else "pending",
                            user_id=example.user_id,
                            model_id=example.model_id,
                            practice_area=example.practice_area,
                            task_type=example.task_type,
                            payload=_example_payload(example),
                            captured_at=now,
                            updated_at=now,
                        )
                    )
                    created += 1
                    continue
                kept = dict(row.payload or {})
                payload = _example_payload(example)
                payload["reviewed_by"] = kept.get("reviewed_by")
                payload["reviewed_at"] = kept.get("reviewed_at")
                content_changed = any(
                    payload.get(key) != kept.get(key)
                    for key in ("prompt", "completion", "correction", "revision", "revision_accepted", "comment")
                )
                if (
                    payload != kept
                    or row.model_id != example.model_id
                    or row.practice_area != example.practice_area
                    or row.task_type != example.task_type
                ):
                    if content_changed and row.status == "approved" and not auto_approve:
                        # An approval covers the text that was reviewed; an
                        # edited or regenerated answer needs a fresh review.
                        # Exclusions stand, since the reviewer rejected the signal.
                        row.status = "pending"
                        payload["reviewed_by"] = None
                        payload["reviewed_at"] = None
                    row.payload = payload
                    row.model_id = example.model_id
                    row.practice_area = example.practice_area
                    row.task_type = example.task_type
                    row.updated_at = now
            return created

        return self._run_write(operation)

    def list_examples(
        self,
        tenant_id: str,
        *,
        limit: int | None = MAX_EXAMPLES_PER_TENANT_READ,
    ) -> list[TrainingExample]:
        def operation(session: Session) -> list[TrainingExample]:
            statement = (
                select(TrainingExampleRow)
                .where(TrainingExampleRow.tenant_id == tenant_id)
                .order_by(TrainingExampleRow.captured_at.desc(), TrainingExampleRow.id)
            )
            if limit is not None:
                statement = statement.limit(limit)
            return [_example_from_row(row) for row in session.scalars(statement)]

        return self._run_read(operation)

    def count_examples(self, tenant_id: str) -> int:
        def operation(session: Session) -> int:
            return int(
                session.scalar(
                    select(func.count())
                    .select_from(TrainingExampleRow)
                    .where(TrainingExampleRow.tenant_id == tenant_id)
                )
                or 0
            )

        return self._run_read(operation)

    def review_examples(
        self,
        *,
        tenant_id: str,
        example_ids: Iterable[str],
        status: str,
        reviewer_id: str,
    ) -> int:
        ids = list(dict.fromkeys(example_ids))

        def operation(session: Session) -> int:
            rows = session.scalars(
                select(TrainingExampleRow).where(
                    TrainingExampleRow.tenant_id == tenant_id,
                    TrainingExampleRow.id.in_(ids),
                )
            )
            now = clock.now()
            changed = 0
            for row in rows:
                payload = dict(row.payload or {})
                payload["reviewed_by"] = reviewer_id
                payload["reviewed_at"] = now.isoformat()
                row.payload = payload
                row.status = status
                row.updated_at = now
                changed += 1
            return changed

        return self._run_write(operation)

    def delete_examples(self, *, tenant_id: str, example_ids: Iterable[str]) -> int:
        ids = list(dict.fromkeys(example_ids))

        def operation(session: Session) -> int:
            result = session.execute(
                delete(TrainingExampleRow).where(
                    TrainingExampleRow.tenant_id == tenant_id,
                    TrainingExampleRow.id.in_(ids),
                )
            )
            return int(result.rowcount or 0)

        return self._run_write(operation)

    # Transactions ------------------------------------------------------

    def _run_read(self, operation: Callable[[Session], T]) -> T:
        session = self._sessions()
        try:
            return operation(session)
        finally:
            session.close()

    def _run_write(self, operation: Callable[[Session], T]) -> T:
        for attempt in range(5):
            try:
                with self._lock:
                    session = self._sessions()
                    try:
                        with session.begin():
                            return operation(session)
                    finally:
                        session.close()
            except OperationalError as exc:
                code = getattr(exc.orig, "sqlite_errorcode", None)
                locked = (
                    self.engine.dialect.name == "sqlite"
                    and isinstance(code, int)
                    and (code & 0xFF) in {5, 6}
                )
                if not locked or attempt == 4:
                    raise
        raise RuntimeError("unreachable")
