"""Wire shapes for the Drafts PDF export."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

DraftPdfExportStatus = Literal["queued", "rendering", "finishing", "ready", "failed", "canceled"]


class DraftPdfSource(BaseModel):
    """A saved draft version as the browser's print surface sends it: the
    print root's markup and the stylesheet text the browser's Print applies.
    """

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=240)
    lang: str = Field(default="en", max_length=35, pattern=r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$")
    body_html: str = Field(min_length=1)
    css: str = ""

    @field_validator("title")
    @classmethod
    def _single_line_title(cls, value: str) -> str:
        title = " ".join(value.split())
        if not title:
            raise ValueError("The document needs a title.")
        return title


class DraftPdfExportJob(BaseModel):
    id: str
    status: DraftPdfExportStatus
    queue_position: int | None = None
    page_count: int | None = None
    size_bytes: int | None = None
    bookmark_count: int | None = None
    conformance: str | None = None
    error: str | None = None
