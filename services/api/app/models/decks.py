"""Response models for deck (PowerPoint) brand-template parsing.

The parse endpoint is a stateless transform: it reads an uploaded .pptx/.potx,
returns theme colors, fonts, logo/background image candidates, and per-slide
text, and stores nothing server-side.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class DeckTemplateTheme(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    colors: dict[str, str] = Field(default_factory=dict)
    major_font: str | None = None
    minor_font: str | None = None


class DeckTemplateImageCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    data_url: str
    width_px: int
    height_px: int
    source: str
    #: True when the picture is dark enough that slide text needs light type.
    is_dark: bool = False


class DeckTemplateSlideText(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    index: int
    title: str | None = None
    blocks: list[str] = Field(default_factory=list)
    layout_name: str | None = None
    #: Index into DeckTemplateParseResponse.designs — the flattened artwork of
    #: this slide's layout. None when the layout had nothing to render.
    design_index: int | None = None


class DeckTemplateParseResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    filename: str
    slide_count: int
    theme: DeckTemplateTheme
    logo_candidates: list[DeckTemplateImageCandidate] = Field(default_factory=list)
    background_candidates: list[DeckTemplateImageCandidate] = Field(default_factory=list)
    #: One flattened design per distinct layout the deck actually uses; slides
    #: point at these by index so a repeated design is sent once.
    designs: list[DeckTemplateImageCandidate] = Field(default_factory=list)
    slides: list[DeckTemplateSlideText] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
