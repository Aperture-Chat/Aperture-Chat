"""Thread-safe SQLite persistence for Review Grid matrices and cells.

This store is deliberately separate from ``runtime_state.json``.  Matrix and
cell transitions are committed transactionally in WAL mode, and a process
restart turns unfinished work into an honest ``interrupted`` state instead of
leaving rows that appear to run forever.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from threading import RLock
from uuid import NAMESPACE_URL, uuid4, uuid5

from app.models.review import ReviewCell, ReviewMatrix, review_now


class ReviewStoreError(RuntimeError):
    """Base error for review persistence operations."""


class ReviewNotFound(ReviewStoreError):
    """The requested matrix or cell does not exist."""


class ReviewConflict(ReviewStoreError):
    """A requested mutation conflicts with active review work."""


class ReviewLimitExceeded(ReviewStoreError):
    """The bounded review queue is full."""


class ReviewStore:
    def __init__(self, path: str, *, max_queued_runs: int = 4) -> None:
        if path != ":memory:":
            Path(path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.max_queued_runs = max(1, max_queued_runs)
        self._lock = RLock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._closed = False
        self._init_schema()
        self._interrupt_unfinished_runs()

    def create_matrix(self, matrix: ReviewMatrix) -> ReviewMatrix:
        with self._lock, self._connection:
            try:
                self._connection.execute(
                    """
                    insert into review_matrices (
                        id, tenant_id, owner_user_id, status, updated_at, payload
                    ) values (?, ?, ?, ?, ?, ?)
                    """,
                    self._matrix_values(matrix),
                )
            except sqlite3.IntegrityError as exc:
                raise ReviewConflict(f"Review matrix '{matrix.id}' already exists.") from exc
        return matrix.model_copy(deep=True)

    def get_matrix(self, matrix_id: str) -> ReviewMatrix | None:
        with self._lock:
            row = self._connection.execute(
                "select payload from review_matrices where id = ?",
                (matrix_id,),
            ).fetchone()
        return ReviewMatrix.model_validate_json(row["payload"]) if row is not None else None

    def list_matrices(self, *, owner_user_id: str) -> list[ReviewMatrix]:
        with self._lock:
            rows = self._connection.execute(
                """
                select payload from review_matrices
                where owner_user_id = ?
                order by updated_at desc, id
                """,
                (owner_user_id,),
            ).fetchall()
        return [ReviewMatrix.model_validate_json(row["payload"]) for row in rows]

    def purge_tenant(self, tenant_id: str) -> list[str]:
        """Delete all matrices/cells for one tenant; call through ReviewRunner."""
        return self._purge_scope("tenant_id", tenant_id)

    def purge_owner(self, owner_user_id: str) -> list[str]:
        """Delete all matrices/cells for one owner; call through ReviewRunner."""
        return self._purge_scope("owner_user_id", owner_user_id)

    def update_matrix(
        self,
        matrix: ReviewMatrix,
        *,
        clear_cells: bool,
        expected_updated_at: datetime | None = None,
    ) -> ReviewMatrix:
        with self._lock:
            self._begin_immediate()
            try:
                current = self._required_matrix_locked(matrix.id)
                self._assert_expected_version(current, expected_updated_at)
                if current.status == "running":
                    raise ReviewConflict("A running review matrix cannot be changed.")
                self._upsert_matrix_locked(matrix)
                if clear_cells:
                    self._connection.execute(
                        "delete from review_cells where matrix_id = ?",
                        (matrix.id,),
                    )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return matrix.model_copy(deep=True)

    def set_matrix_matter(
        self,
        matrix_id: str,
        *,
        tenant_id: str,
        matter_id: str | None,
    ) -> ReviewMatrix:
        with self._lock:
            self._begin_immediate()
            try:
                current = self._required_matrix_locked(matrix_id)
                if current.tenant_id != tenant_id:
                    raise ReviewNotFound("Unknown review matrix.")
                if current.status == "running":
                    raise ReviewConflict("A running review matrix cannot be changed.")
                updated = current.model_copy(
                    update={"matter_id": matter_id, "updated_at": review_now()}
                )
                self._upsert_matrix_locked(updated)
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return updated.model_copy(deep=True)

    def clear_matter_references(self, matter_id: str) -> int:
        """Null every matrix reference to one matter; deletes nothing."""

        cleared = 0
        with self._lock:
            self._begin_immediate()
            try:
                rows = self._connection.execute(
                    "select payload from review_matrices"
                ).fetchall()
                for row in rows:
                    matrix = ReviewMatrix.model_validate_json(row["payload"])
                    if matrix.matter_id != matter_id:
                        continue
                    self._upsert_matrix_locked(
                        matrix.model_copy(
                            update={"matter_id": None, "updated_at": review_now()}
                        )
                    )
                    cleared += 1
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return cleared

    def delete_matrix(self, matrix_id: str) -> None:
        with self._lock:
            self._begin_immediate()
            try:
                matrix = self._required_matrix_locked(matrix_id)
                if matrix.status == "running":
                    raise ReviewConflict("A running review matrix cannot be deleted.")
                self._connection.execute(
                    "delete from review_cells where matrix_id = ?", (matrix_id,)
                )
                self._connection.execute("delete from review_matrices where id = ?", (matrix_id,))
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

    def cells_for_matrix(self, matrix_id: str) -> list[ReviewCell]:
        with self._lock:
            rows = self._connection.execute(
                """
                select payload from review_cells
                where matrix_id = ?
                order by document_id, column_id, id
                """,
                (matrix_id,),
            ).fetchall()
        return [ReviewCell.model_validate_json(row["payload"]) for row in rows]

    def get_cell(self, matrix_id: str, cell_id: str) -> ReviewCell | None:
        with self._lock:
            row = self._connection.execute(
                "select payload from review_cells where matrix_id = ? and id = ?",
                (matrix_id, cell_id),
            ).fetchone()
        return ReviewCell.model_validate_json(row["payload"]) if row is not None else None

    def begin_run(
        self,
        matrix_id: str,
        *,
        expected_updated_at: datetime | None = None,
    ) -> tuple[ReviewMatrix, list[ReviewCell]]:
        """Atomically reserve a full matrix run and replace its prior cells."""
        with self._lock:
            self._begin_immediate()
            try:
                matrix = self._required_matrix_locked(matrix_id)
                self._assert_expected_version(matrix, expected_updated_at)
                self._assert_run_slot_locked(matrix)
                now = review_now()
                running = matrix.model_copy(
                    update={
                        "status": "running",
                        "started_at": now,
                        "completed_at": None,
                        "updated_at": now,
                    }
                )
                self._connection.execute(
                    "delete from review_cells where matrix_id = ?", (matrix_id,)
                )
                cells = [
                    ReviewCell(
                        id=_cell_id(matrix.id, document_id, column.id),
                        matrix_id=matrix.id,
                        tenant_id=matrix.tenant_id,
                        owner_user_id=matrix.owner_user_id,
                        document_id=document_id,
                        column_id=column.id,
                        run_token=str(uuid4()),
                    )
                    for document_id in matrix.document_ids
                    for column in matrix.columns
                ]
                self._upsert_matrix_locked(running)
                for cell in cells:
                    self._upsert_cell_locked(cell)
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return running.model_copy(deep=True), [cell.model_copy(deep=True) for cell in cells]

    def begin_cell_rerun(
        self,
        matrix_id: str,
        cell_id: str,
        *,
        expected_updated_at: datetime | None = None,
    ) -> tuple[ReviewMatrix, ReviewCell]:
        """Atomically reserve one terminal cell for a new attempt."""
        with self._lock:
            self._begin_immediate()
            try:
                matrix = self._required_matrix_locked(matrix_id)
                self._assert_expected_version(matrix, expected_updated_at)
                self._assert_run_slot_locked(matrix)
                current = self._required_cell_locked(matrix_id, cell_id)
                if current.status not in {"complete", "failed", "interrupted"}:
                    raise ReviewConflict("Only a terminal review cell can be rerun.")
                now = review_now()
                running = matrix.model_copy(
                    update={
                        "status": "running",
                        "started_at": now,
                        "completed_at": None,
                        "updated_at": now,
                    }
                )
                pending = current.model_copy(
                    update={
                        "status": "pending",
                        "answer": None,
                        "citations": [],
                        "error": None,
                        "attempt": current.attempt + 1,
                        "run_token": str(uuid4()),
                        "updated_at": now,
                        "started_at": None,
                        "completed_at": None,
                    }
                )
                self._upsert_matrix_locked(running)
                self._upsert_cell_locked(pending)
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return running.model_copy(deep=True), pending.model_copy(deep=True)

    def mark_cell_running(
        self,
        matrix_id: str,
        cell_id: str,
        *,
        expected_attempt: int,
        run_token: str,
    ) -> ReviewCell | None:
        with self._lock:
            self._begin_immediate()
            try:
                cell = self._required_cell_locked(matrix_id, cell_id)
                if (
                    cell.status != "pending"
                    or cell.attempt != expected_attempt
                    or cell.run_token != run_token
                ):
                    self._connection.rollback()
                    return None
                now = review_now()
                running = cell.model_copy(
                    update={"status": "running", "started_at": now, "updated_at": now}
                )
                self._upsert_cell_locked(running)
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return running.model_copy(deep=True)

    def complete_cell(
        self,
        matrix_id: str,
        cell_id: str,
        *,
        answer: str,
        citations: list,
        expected_attempt: int,
        run_token: str,
    ) -> ReviewCell:
        return self._finish_cell(
            matrix_id,
            cell_id,
            status="complete",
            answer=answer,
            citations=citations,
            error=None,
            expected_attempt=expected_attempt,
            run_token=run_token,
        )

    def fail_cell(
        self,
        matrix_id: str,
        cell_id: str,
        *,
        error: str,
        expected_attempt: int,
        run_token: str,
    ) -> ReviewCell:
        return self._finish_cell(
            matrix_id,
            cell_id,
            status="failed",
            answer=None,
            citations=[],
            error=error,
            expected_attempt=expected_attempt,
            run_token=run_token,
        )

    def fail_reserved_cell_attempt(
        self,
        matrix_id: str,
        cell_id: str,
        *,
        error: str,
        expected_attempt: int,
        run_token: str,
    ) -> ReviewCell:
        """Fail the exact reserved attempt even when claiming it raised ambiguously."""

        return self._finish_cell(
            matrix_id,
            cell_id,
            status="failed",
            answer=None,
            citations=[],
            error=error,
            expected_attempt=expected_attempt,
            run_token=run_token,
            allowed_current_statuses=("pending", "running"),
        )

    def finish_matrix_if_terminal(self, matrix_id: str) -> ReviewMatrix:
        with self._lock:
            self._begin_immediate()
            try:
                matrix = self._required_matrix_locked(matrix_id)
                rows = self._connection.execute(
                    "select status from review_cells where matrix_id = ?",
                    (matrix_id,),
                ).fetchall()
                statuses = [str(row["status"]) for row in rows]
                if not statuses or any(status in {"pending", "running"} for status in statuses):
                    self._connection.rollback()
                    return matrix
                now = review_now()
                matrix_status = "interrupted" if "interrupted" in statuses else "complete"
                finished = matrix.model_copy(
                    update={"status": matrix_status, "completed_at": now, "updated_at": now}
                )
                self._upsert_matrix_locked(finished)
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return finished.model_copy(deep=True)

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._connection.close()
                self._closed = True

    def interrupt_unfinished_runs(self) -> None:
        """Mark every unfinished local run interrupted during bounded shutdown."""
        self._interrupt_unfinished_runs()

    def _finish_cell(
        self,
        matrix_id: str,
        cell_id: str,
        *,
        status: str,
        answer: str | None,
        citations: list,
        error: str | None,
        expected_attempt: int,
        run_token: str,
        allowed_current_statuses: tuple[str, ...] = ("running",),
    ) -> ReviewCell:
        with self._lock:
            self._begin_immediate()
            try:
                current = self._required_cell_locked(matrix_id, cell_id)
                if (
                    current.status not in allowed_current_statuses
                    or current.attempt != expected_attempt
                    or current.run_token != run_token
                ):
                    raise ReviewConflict(
                        "This review cell attempt is stale and cannot change the current result."
                    )
                now = review_now()
                finished = current.model_copy(
                    update={
                        "status": status,
                        "answer": answer,
                        "citations": citations,
                        "error": error,
                        "updated_at": now,
                        "completed_at": now,
                    }
                )
                self._upsert_cell_locked(finished)
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return finished.model_copy(deep=True)

    def _assert_run_slot_locked(self, matrix: ReviewMatrix) -> None:
        if matrix.status == "running":
            raise ReviewConflict("This review matrix already has an active run.")
        active = int(
            self._connection.execute(
                "select count(*) from review_matrices where status = 'running'"
            ).fetchone()[0]
        )
        if active >= self.max_queued_runs:
            raise ReviewLimitExceeded(
                f"The review queue is limited to {self.max_queued_runs} active runs."
            )

    def _purge_scope(self, column: str, value: str) -> list[str]:
        if not value.strip():
            raise ValueError("Review purge scope cannot be blank.")
        if column not in {"tenant_id", "owner_user_id"}:
            raise ValueError("Unsupported review purge scope.")
        with self._lock:
            self._begin_immediate()
            try:
                rows = self._connection.execute(
                    f"select id from review_matrices where {column} = ?",  # noqa: S608 - column allowlisted above
                    (value,),
                ).fetchall()
                matrix_ids = [str(row["id"]) for row in rows]
                if matrix_ids:
                    placeholders = ", ".join("?" for _ in matrix_ids)
                    self._connection.execute(
                        f"delete from review_cells where matrix_id in ({placeholders})",  # noqa: S608
                        matrix_ids,
                    )
                    self._connection.execute(
                        f"delete from review_matrices where id in ({placeholders})",  # noqa: S608
                        matrix_ids,
                    )
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise
        return matrix_ids

    @staticmethod
    def _assert_expected_version(
        matrix: ReviewMatrix,
        expected_updated_at: datetime | None,
    ) -> None:
        if expected_updated_at is not None and matrix.updated_at != expected_updated_at:
            raise ReviewConflict("The review matrix changed while its run was being prepared.")

    def _required_matrix_locked(self, matrix_id: str) -> ReviewMatrix:
        row = self._connection.execute(
            "select payload from review_matrices where id = ?",
            (matrix_id,),
        ).fetchone()
        if row is None:
            raise ReviewNotFound(f"Unknown review matrix '{matrix_id}'.")
        return ReviewMatrix.model_validate_json(row["payload"])

    def _required_cell_locked(self, matrix_id: str, cell_id: str) -> ReviewCell:
        row = self._connection.execute(
            "select payload from review_cells where matrix_id = ? and id = ?",
            (matrix_id, cell_id),
        ).fetchone()
        if row is None:
            raise ReviewNotFound(f"Unknown review cell '{cell_id}'.")
        return ReviewCell.model_validate_json(row["payload"])

    def _upsert_matrix_locked(self, matrix: ReviewMatrix) -> None:
        self._connection.execute(
            """
            insert into review_matrices (
                id, tenant_id, owner_user_id, status, updated_at, payload
            ) values (?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
                tenant_id = excluded.tenant_id,
                owner_user_id = excluded.owner_user_id,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload = excluded.payload
            """,
            self._matrix_values(matrix),
        )

    def _upsert_cell_locked(self, cell: ReviewCell) -> None:
        self._connection.execute(
            """
            insert into review_cells (
                id, matrix_id, tenant_id, owner_user_id, document_id,
                column_id, status, updated_at, payload
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
                matrix_id = excluded.matrix_id,
                tenant_id = excluded.tenant_id,
                owner_user_id = excluded.owner_user_id,
                document_id = excluded.document_id,
                column_id = excluded.column_id,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload = excluded.payload
            """,
            (
                cell.id,
                cell.matrix_id,
                cell.tenant_id,
                cell.owner_user_id,
                cell.document_id,
                cell.column_id,
                cell.status,
                cell.updated_at.isoformat(),
                cell.model_dump_json(),
            ),
        )

    @staticmethod
    def _matrix_values(matrix: ReviewMatrix) -> tuple[str, str, str, str, str, str]:
        return (
            matrix.id,
            matrix.tenant_id,
            matrix.owner_user_id,
            matrix.status,
            matrix.updated_at.isoformat(),
            matrix.model_dump_json(),
        )

    def _init_schema(self) -> None:
        with self._lock, self._connection:
            self._connection.execute("pragma journal_mode = wal")
            self._connection.execute("pragma foreign_keys = on")
            self._connection.execute(
                """
                create table if not exists review_matrices (
                    id text primary key,
                    tenant_id text not null,
                    owner_user_id text not null,
                    status text not null,
                    updated_at text not null,
                    payload text not null
                )
                """
            )
            self._connection.execute(
                """
                create table if not exists review_cells (
                    id text primary key,
                    matrix_id text not null references review_matrices(id) on delete cascade,
                    tenant_id text not null,
                    owner_user_id text not null,
                    document_id text not null,
                    column_id text not null,
                    status text not null,
                    updated_at text not null,
                    payload text not null
                )
                """
            )
            self._connection.execute(
                """
                create index if not exists idx_review_matrices_owner
                on review_matrices (owner_user_id, updated_at)
                """
            )
            self._connection.execute(
                """
                create index if not exists idx_review_matrices_tenant_status
                on review_matrices (tenant_id, status)
                """
            )
            self._connection.execute(
                """
                create index if not exists idx_review_cells_matrix
                on review_cells (matrix_id, document_id, column_id)
                """
            )

    def _interrupt_unfinished_runs(self) -> None:
        with self._lock:
            self._begin_immediate()
            try:
                rows = self._connection.execute(
                    "select payload from review_matrices where status = 'running'"
                ).fetchall()
                if not rows:
                    self._connection.rollback()
                    return
                now = review_now()
                for row in rows:
                    matrix = ReviewMatrix.model_validate_json(row["payload"])
                    cell_rows = self._connection.execute(
                        """
                        select payload from review_cells
                        where matrix_id = ?
                        """,
                        (matrix.id,),
                    ).fetchall()
                    cells = [
                        ReviewCell.model_validate_json(cell_row["payload"])
                        for cell_row in cell_rows
                    ]
                    unfinished = [cell for cell in cells if cell.status in {"pending", "running"}]
                    terminal_status = "interrupted" if unfinished or not cells else "complete"
                    terminal_matrix = matrix.model_copy(
                        update={"status": terminal_status, "completed_at": now, "updated_at": now}
                    )
                    self._upsert_matrix_locked(terminal_matrix)
                    for cell in unfinished:
                        interrupted_cell = cell.model_copy(
                            update={
                                "status": "interrupted",
                                "answer": None,
                                "citations": [],
                                "error": "Review processing was interrupted before this cell completed.",
                                "completed_at": now,
                                "updated_at": now,
                            }
                        )
                        self._upsert_cell_locked(interrupted_cell)
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

    def _begin_immediate(self) -> None:
        self._connection.execute("begin immediate")


def _cell_id(matrix_id: str, document_id: str, column_id: str) -> str:
    stable = uuid5(NAMESPACE_URL, f"aperture-review:{matrix_id}:{document_id}:{column_id}")
    return f"review-cell-{stable}"
