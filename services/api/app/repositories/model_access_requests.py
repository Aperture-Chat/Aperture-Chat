"""Persistence for per-model access requests (advisory, tenant-scoped rows).

Bound to the application engine like ``MatterDraftRepository``. Requests never
influence :func:`app.core.policy.model_access_allowed`; they only record that a
person asked and how an administrator answered.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import TypeVar
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.db.engine import create_session_factory, engine_write_lock
from app.db.orm import ModelAccessRequestRow
from app.models.schemas import ModelAccessRequest, ModelAccessRequestStatus

T = TypeVar("T")


class ModelAccessRequestError(Exception):
    """Base class for request-store failures."""


class ModelAccessRequestNotFound(ModelAccessRequestError):
    """No request with that id inside the caller's scope."""


class ModelAccessRequestConflict(ModelAccessRequestError):
    """The request is not in a state that allows the operation."""


class ModelAccessRequestUnavailable(ModelAccessRequestError):
    """The relational store could not complete the operation."""


def new_request_id() -> str:
    return f"mar-{uuid4()}"


class ModelAccessRequestRepository:
    def __init__(
        self,
        engine: Engine,
        *,
        session_factory: sessionmaker[Session] | None = None,
    ) -> None:
        self.engine = engine
        self._sessions = session_factory or create_session_factory(engine)
        self._lock = engine_write_lock(engine)

    # Reads -------------------------------------------------------------

    def get(self, request_id: str, *, tenant_id: str) -> ModelAccessRequest | None:
        def operation(session: Session) -> ModelAccessRequest | None:
            row = session.get(ModelAccessRequestRow, request_id)
            if row is None or row.tenant_id != tenant_id:
                return None
            return row.to_model()

        return self._run_read(operation)

    def list_for_user(self, *, tenant_id: str, user_id: str) -> list[ModelAccessRequest]:
        def operation(session: Session) -> list[ModelAccessRequest]:
            rows = session.scalars(
                select(ModelAccessRequestRow)
                .where(
                    ModelAccessRequestRow.tenant_id == tenant_id,
                    ModelAccessRequestRow.user_id == user_id,
                )
                .order_by(ModelAccessRequestRow.created_at.desc(), ModelAccessRequestRow.id)
            )
            return [row.to_model() for row in rows]

        return self._run_read(operation)

    def pending_for_user(self, *, tenant_id: str, user_id: str) -> dict[str, ModelAccessRequest]:
        """Open requests keyed by model id, for decorating a catalog listing."""

        return {
            request.model_id: request
            for request in self.list_for_user(tenant_id=tenant_id, user_id=user_id)
            if request.status == "pending"
        }

    def list_for_tenant(
        self,
        *,
        tenant_id: str | None,
        status: ModelAccessRequestStatus | None = "pending",
        limit: int = 200,
    ) -> list[ModelAccessRequest]:
        limit = max(1, min(int(limit), 500))

        def operation(session: Session) -> list[ModelAccessRequest]:
            statement = select(ModelAccessRequestRow)
            if tenant_id is not None:
                statement = statement.where(ModelAccessRequestRow.tenant_id == tenant_id)
            if status is not None:
                statement = statement.where(ModelAccessRequestRow.status == status)
            statement = statement.order_by(
                ModelAccessRequestRow.created_at.desc(), ModelAccessRequestRow.id
            ).limit(limit)
            return [row.to_model() for row in session.scalars(statement)]

        return self._run_read(operation)

    def count_pending(self, *, tenant_id: str | None) -> int:
        def operation(session: Session) -> int:
            statement = select(ModelAccessRequestRow.id).where(
                ModelAccessRequestRow.status == "pending"
            )
            if tenant_id is not None:
                statement = statement.where(ModelAccessRequestRow.tenant_id == tenant_id)
            return len(list(session.scalars(statement)))

        return self._run_read(operation)

    # Writes ------------------------------------------------------------

    def create(
        self,
        *,
        tenant_id: str,
        user_id: str,
        model_id: str,
        note: str | None,
        now: datetime | None = None,
    ) -> ModelAccessRequest:
        timestamp = now or datetime.now(UTC)

        def operation(session: Session) -> ModelAccessRequest:
            existing = session.scalar(
                select(ModelAccessRequestRow).where(
                    ModelAccessRequestRow.tenant_id == tenant_id,
                    ModelAccessRequestRow.user_id == user_id,
                    ModelAccessRequestRow.model_id == model_id,
                    ModelAccessRequestRow.status == "pending",
                )
            )
            if existing is not None:
                raise ModelAccessRequestConflict("A request for this model is already pending.")
            request = ModelAccessRequest(
                id=new_request_id(),
                tenant_id=tenant_id,
                user_id=user_id,
                model_id=model_id,
                status="pending",
                note=note,
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(ModelAccessRequestRow.from_model(request))
            session.flush()
            return request

        return self._run_write(operation)

    def resolve(
        self,
        request_id: str,
        *,
        tenant_id: str,
        status: ModelAccessRequestStatus,
        resolved_by_user_id: str,
        resolution_note: str | None = None,
        granted_group_id: str | None = None,
        now: datetime | None = None,
    ) -> ModelAccessRequest:
        if status not in {"approved", "declined", "withdrawn"}:
            raise ValueError("Resolution status must be approved, declined, or withdrawn.")
        timestamp = now or datetime.now(UTC)

        def operation(session: Session) -> ModelAccessRequest:
            row = session.get(ModelAccessRequestRow, request_id)
            if row is None or row.tenant_id != tenant_id:
                raise ModelAccessRequestNotFound("Unknown access request.")
            if row.status != "pending":
                raise ModelAccessRequestConflict("This request has already been resolved.")
            row.status = status
            row.resolved_by_user_id = resolved_by_user_id
            row.resolution_note = resolution_note
            row.granted_group_id = granted_group_id
            row.updated_at = max(timestamp, row.created_at)
            session.flush()
            return row.to_model()

        return self._run_write(operation)

    def purge_user(self, *, tenant_id: str, user_id: str) -> int:
        def operation(session: Session) -> int:
            return int(
                session.execute(
                    delete(ModelAccessRequestRow).where(
                        ModelAccessRequestRow.tenant_id == tenant_id,
                        ModelAccessRequestRow.user_id == user_id,
                    )
                ).rowcount
                or 0
            )

        return self._run_write(operation)

    def purge_tenant(self, tenant_id: str) -> int:
        def operation(session: Session) -> int:
            return int(
                session.execute(
                    delete(ModelAccessRequestRow).where(
                        ModelAccessRequestRow.tenant_id == tenant_id
                    )
                ).rowcount
                or 0
            )

        return self._run_write(operation)

    # Plumbing ----------------------------------------------------------

    def _run_read(self, operation: Callable[[Session], T]) -> T:
        session = self._sessions()
        try:
            return operation(session)
        except ModelAccessRequestError:
            raise
        except SQLAlchemyError as exc:
            raise ModelAccessRequestUnavailable("Access requests are unavailable.") from exc
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
            except ModelAccessRequestError:
                raise
            except OperationalError as exc:
                code = getattr(exc.orig, "sqlite_errorcode", None)
                locked = (
                    self.engine.dialect.name == "sqlite"
                    and isinstance(code, int)
                    and (code & 0xFF) in {5, 6}
                )
                if not locked or attempt == 4:
                    raise ModelAccessRequestUnavailable(
                        "Access requests are unavailable."
                    ) from exc
            except SQLAlchemyError as exc:
                raise ModelAccessRequestUnavailable("Access requests are unavailable.") from exc
        raise ModelAccessRequestUnavailable("Access requests are unavailable.")
