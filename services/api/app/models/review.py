"""Durable API contracts for document review matrices.

The review feature is intentionally isolated from the legacy runtime-state
graph.  These models are stored in the dedicated review SQLite database and
are safe to evolve independently of ``models.schemas``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


MAX_REVIEW_DOCUMENTS = 40
MAX_REVIEW_COLUMNS = 20
MAX_REVIEW_CELLS = 200
MAX_REVIEW_QUESTION_CHARS = 2_000
MAX_REVIEW_ANSWER_CHARS = 32_000
MAX_REVIEW_NAME_CHARS = 160
MAX_REVIEW_COLUMN_LABEL_CHARS = 120

ReviewAnswerFormat = Literal["text", "yes_no", "date", "amount"]
ReviewMatrixStatus = Literal["draft", "running", "complete", "interrupted"]
ReviewCellStatus = Literal["pending", "running", "complete", "failed", "interrupted"]


def review_now() -> datetime:
    return datetime.now(UTC)


def _column_id() -> str:
    return f"review-column-{uuid4()}"


class ReviewColumn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(default_factory=_column_id, min_length=1, max_length=120)
    label: str = Field(min_length=1, max_length=MAX_REVIEW_COLUMN_LABEL_CHARS)
    question: str = Field(min_length=1, max_length=MAX_REVIEW_QUESTION_CHARS)
    answer_format: ReviewAnswerFormat = "text"

    @field_validator("id", "label", "question")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Review column fields cannot be blank.")
        return value


class ReviewCitation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    k_index: int = Field(ge=1)
    knowledge_config_id: str
    document_id: str
    chunk_id: str
    source_name: str
    source_uri: str
    page_start: int | None = Field(default=None, ge=1)
    page_end: int | None = Field(default=None, ge=1)
    locator: str | None = None


class ReviewMatrix(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    tenant_id: str
    owner_user_id: str
    name: str = Field(min_length=1, max_length=MAX_REVIEW_NAME_CHARS)
    knowledge_config_ids: list[str] = Field(min_length=1)
    document_ids: list[str] = Field(min_length=1, max_length=MAX_REVIEW_DOCUMENTS)
    columns: list[ReviewColumn] = Field(min_length=1, max_length=MAX_REVIEW_COLUMNS)
    model_id: str
    status: ReviewMatrixStatus = "draft"
    # Assignment happens only through the membership-gated matters router;
    # create/update requests still reject caller-supplied matter ids.
    matter_id: str | None = None
    created_at: datetime = Field(default_factory=review_now)
    updated_at: datetime = Field(default_factory=review_now)
    started_at: datetime | None = None
    completed_at: datetime | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Review matrix name cannot be blank.")
        return value

    @model_validator(mode="after")
    def validate_grid_shape(self) -> "ReviewMatrix":
        _validate_unique(self.knowledge_config_ids, "knowledge configuration")
        _validate_unique(self.document_ids, "document")
        _validate_unique([column.id for column in self.columns], "column")
        if len(self.document_ids) * len(self.columns) > MAX_REVIEW_CELLS:
            raise ValueError(f"A review matrix is limited to {MAX_REVIEW_CELLS} cells.")
        return self


class ReviewCell(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    matrix_id: str
    tenant_id: str
    owner_user_id: str
    document_id: str
    column_id: str
    status: ReviewCellStatus = "pending"
    answer: str | None = Field(default=None, max_length=MAX_REVIEW_ANSWER_CHARS)
    citations: list[ReviewCitation] = Field(default_factory=list)
    error: str | None = Field(default=None, max_length=2_000)
    attempt: int = Field(default=1, ge=1)
    run_token: str
    created_at: datetime = Field(default_factory=review_now)
    updated_at: datetime = Field(default_factory=review_now)
    started_at: datetime | None = None
    completed_at: datetime | None = None


class ReviewCellResponse(BaseModel):
    """Public cell shape; the internal attempt token is never serialized."""

    model_config = ConfigDict(extra="forbid")

    id: str
    matrix_id: str
    tenant_id: str
    owner_user_id: str
    document_id: str
    column_id: str
    status: ReviewCellStatus
    answer: str | None = None
    citations: list[ReviewCitation] = Field(default_factory=list)
    error: str | None = None
    attempt: int
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None

    @classmethod
    def from_stored(cls, cell: ReviewCell) -> "ReviewCellResponse":
        return cls.model_validate(cell.model_dump(exclude={"run_token"}))


class ReviewMatrixCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_REVIEW_NAME_CHARS)
    knowledge_config_ids: list[str] = Field(min_length=1)
    document_ids: list[str] = Field(min_length=1, max_length=MAX_REVIEW_DOCUMENTS)
    columns: list[ReviewColumn] = Field(min_length=1, max_length=MAX_REVIEW_COLUMNS)
    model_id: str = Field(min_length=1)
    matter_id: None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Review matrix name cannot be blank.")
        return value

    @field_validator("model_id")
    @classmethod
    def strip_model_id(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Review model id cannot be blank.")
        return value

    @field_validator("knowledge_config_ids", "document_ids")
    @classmethod
    def strip_reference_ids(cls, values: list[str]) -> list[str]:
        return [value.strip() for value in values]

    @model_validator(mode="after")
    def validate_grid_shape(self) -> "ReviewMatrixCreateRequest":
        _validate_unique(self.knowledge_config_ids, "knowledge configuration")
        _validate_unique(self.document_ids, "document")
        _validate_unique([column.id for column in self.columns], "column")
        if len(self.document_ids) * len(self.columns) > MAX_REVIEW_CELLS:
            raise ValueError(f"A review matrix is limited to {MAX_REVIEW_CELLS} cells.")
        return self


class ReviewMatrixUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=MAX_REVIEW_NAME_CHARS)
    knowledge_config_ids: list[str] | None = None
    document_ids: list[str] | None = Field(default=None, min_length=1, max_length=MAX_REVIEW_DOCUMENTS)
    columns: list[ReviewColumn] | None = Field(default=None, min_length=1, max_length=MAX_REVIEW_COLUMNS)
    model_id: str | None = Field(default=None, min_length=1)
    matter_id: None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("Review matrix name cannot be blank.")
        return value

    @field_validator("model_id")
    @classmethod
    def strip_model_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("Review model id cannot be blank.")
        return value

    @field_validator("knowledge_config_ids", "document_ids")
    @classmethod
    def strip_reference_ids(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        return [value.strip() for value in values]


class ReviewMatrixDetail(BaseModel):
    matrix: ReviewMatrix
    cells: list[ReviewCellResponse]


class ReviewRunAccepted(BaseModel):
    matrix_id: str
    status: ReviewMatrixStatus
    cell_count: int


def _validate_unique(values: list[str], label: str) -> None:
    if any(not value.strip() for value in values):
        raise ValueError(f"Every {label} id must be non-empty.")
    if len(values) != len(set(values)):
        raise ValueError(f"Duplicate {label} ids are not allowed.")
