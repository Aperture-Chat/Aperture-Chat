from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class DocumentImportResponse(BaseModel):
    """Stateless PDF-to-document import result for the Drafts editor."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    filename: str = Field(min_length=1, max_length=255)
    html: str
    page_count: int = Field(ge=0)
    warnings: list[str] = Field(default_factory=list)
