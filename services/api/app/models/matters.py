"""Strict durable contracts for matter workspaces and private draft snapshots.

Matter membership is an additional access condition; it never grants access to
another user's chat, folder, or draft. Draft HTML is canonicalized through a
small allowlist before persistence so the server never stores executable markup.
Legacy browser history is intentionally outside this contract and must only be
uploaded by an explicit, authenticated user action in a later integration step.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from hashlib import sha256
from html import escape
from html.parser import HTMLParser
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)


SIGNED_BIGINT_MAX = 9_223_372_036_854_775_807
MAX_MATTER_NAME_CHARS = 200
MAX_MATTER_RETENTION_DAYS = 36_500
MAX_DRAFT_TITLE_CHARS = 240
MAX_DRAFT_CONTENT_BYTES = 2_000_000
MAX_DRAFT_REVISIONS = 200
MAX_DRAFT_LIST_LIMIT = 200
MAX_DRAFT_REVISION_LIST_LIMIT = 200
DRAFT_SANITIZER_VERSION = "sanitized-html-v1"

MatterDeletionStatus = Literal["pending", "running", "failed", "ready", "complete"]
MatterDeletionStage = Literal["application", "review", "knowledge", "legacy"]

ScopedId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]


def matter_now() -> datetime:
    return datetime.now(UTC)


def new_matter_id() -> str:
    return f"matter-{uuid4()}"


def new_draft_id() -> str:
    return f"draft-{uuid4()}"


def normalize_matter_name(value: str) -> str:
    return _normalize_label(value, label="Matter name", max_chars=MAX_MATTER_NAME_CHARS)


def normalize_draft_title(value: str) -> str:
    return _normalize_label(value, label="Draft title", max_chars=MAX_DRAFT_TITLE_CHARS)


def sanitize_draft_html(value: str) -> str:
    """Return bounded, non-executable HTML suitable for durable draft storage."""

    if not isinstance(value, str):
        raise TypeError("Draft content must be a string.")
    parser = _DraftHTMLSanitizer()
    try:
        parser.feed(value.replace("\x00", ""))
        parser.close()
    except ValueError as exc:
        raise ValueError("Draft content contains malformed HTML.") from exc
    sanitized = parser.render()
    if len(sanitized.encode("utf-8")) > MAX_DRAFT_CONTENT_BYTES:
        raise ValueError(f"Draft content is limited to {MAX_DRAFT_CONTENT_BYTES} UTF-8 bytes.")
    return sanitized


def draft_content_sha256(content: str) -> str:
    return sha256(
        f"aperture-draft-content:{DRAFT_SANITIZER_VERSION}:".encode("utf-8")
        + content.encode("utf-8")
    ).hexdigest()


class Matter(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    id: ScopedId
    tenant_id: ScopedId
    name: str = Field(min_length=1, max_length=MAX_MATTER_NAME_CHARS)
    # Metadata only until A7 retention enforcement. ``None`` honestly means
    # that no matter-specific policy has been configured.
    retention_days: int | None = Field(default=None, ge=1, le=MAX_MATTER_RETENTION_DAYS)
    created_by_user_id: ScopedId
    version: int = Field(ge=1, le=SIGNED_BIGINT_MAX)
    created_at: datetime
    updated_at: datetime

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return normalize_matter_name(value)

    @field_validator("created_at", "updated_at")
    @classmethod
    def require_aware_timestamp(cls, value: datetime) -> datetime:
        return _aware_utc(value)

    @model_validator(mode="after")
    def validate_clock_order(self) -> Matter:
        if self.updated_at < self.created_at:
            raise ValueError("Matter updated_at cannot precede created_at.")
        return self


class MatterMembership(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    matter_id: ScopedId
    tenant_id: ScopedId
    member_user_id: ScopedId
    added_by_user_id: ScopedId
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def require_aware_timestamp(cls, value: datetime) -> datetime:
        return _aware_utc(value)


class DraftDocument(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    id: ScopedId
    tenant_id: ScopedId
    owner_user_id: ScopedId
    matter_id: ScopedId | None = None
    title: str = Field(min_length=1, max_length=MAX_DRAFT_TITLE_CHARS)
    current_revision: int = Field(ge=1, le=MAX_DRAFT_REVISIONS)
    created_at: datetime
    updated_at: datetime

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        return normalize_draft_title(value)

    @field_validator("created_at", "updated_at")
    @classmethod
    def require_aware_timestamp(cls, value: datetime) -> datetime:
        return _aware_utc(value)

    @model_validator(mode="after")
    def validate_clock_order(self) -> DraftDocument:
        if self.updated_at < self.created_at:
            raise ValueError("Draft updated_at cannot precede created_at.")
        return self


class DraftRevision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    draft_id: ScopedId
    tenant_id: ScopedId
    owner_user_id: ScopedId
    revision: int = Field(ge=1, le=MAX_DRAFT_REVISIONS)
    title: str = Field(min_length=1, max_length=MAX_DRAFT_TITLE_CHARS)
    content: str
    content_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    sanitizer_version: str = Field(pattern=r"^sanitized-html-v[1-9][0-9]*$")
    created_at: datetime

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        return normalize_draft_title(value)

    @field_validator("content")
    @classmethod
    def validate_content_bound(cls, value: str) -> str:
        if len(value.encode("utf-8")) > MAX_DRAFT_CONTENT_BYTES:
            raise ValueError(f"Draft content is limited to {MAX_DRAFT_CONTENT_BYTES} UTF-8 bytes.")
        return value

    @field_validator("created_at")
    @classmethod
    def require_aware_timestamp(cls, value: datetime) -> datetime:
        return _aware_utc(value)

    @model_validator(mode="after")
    def validate_canonical_content(self) -> DraftRevision:
        if self.sanitizer_version != DRAFT_SANITIZER_VERSION:
            raise ValueError("Unsupported draft sanitizer version.")
        if sanitize_draft_html(self.content) != self.content:
            raise ValueError("Draft content is not canonical sanitized HTML.")
        if draft_content_sha256(self.content) != self.content_sha256:
            raise ValueError("Draft content digest does not match the stored snapshot.")
        return self


class DraftSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    document: DraftDocument
    revision: DraftRevision

    @model_validator(mode="after")
    def validate_binding(self) -> DraftSnapshot:
        document = self.document
        revision = self.revision
        if (
            revision.draft_id != document.id
            or revision.tenant_id != document.tenant_id
            or revision.owner_user_id != document.owner_user_id
            or revision.revision != document.current_revision
            or revision.title != document.title
        ):
            raise ValueError("Draft document and current revision are inconsistent.")
        return self


class MatterDeletionResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    matter_id: ScopedId
    tenant_id: ScopedId
    unlinked_chat_thread_ids: list[ScopedId]
    unlinked_chat_folder_ids: list[ScopedId]
    unlinked_draft_ids: list[ScopedId]


class MatterDeletionJob(BaseModel):
    """Privacy-minimal durable cleanup intent; contains no work-product data."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    matter_id: ScopedId
    tenant_id: ScopedId
    requested_by_user_id: ScopedId
    requested_matter_version: int = Field(ge=1, le=SIGNED_BIGINT_MAX)
    status: MatterDeletionStatus
    attempt_count: int = Field(ge=0, le=SIGNED_BIGINT_MAX)
    requested_at: datetime
    updated_at: datetime
    last_attempt_at: datetime | None = None
    lease_expires_at: datetime | None = None
    application_refs_cleared_at: datetime | None = None
    review_refs_cleared_at: datetime | None = None
    knowledge_refs_cleared_at: datetime | None = None
    legacy_refs_cleared_at: datetime | None = None
    completed_at: datetime | None = None
    last_error_stage: MatterDeletionStage | None = None

    @field_validator(
        "requested_at",
        "updated_at",
        "last_attempt_at",
        "lease_expires_at",
        "application_refs_cleared_at",
        "review_refs_cleared_at",
        "knowledge_refs_cleared_at",
        "legacy_refs_cleared_at",
        "completed_at",
    )
    @classmethod
    def require_aware_timestamp(cls, value: datetime | None) -> datetime | None:
        return None if value is None else _aware_utc(value)

    @model_validator(mode="after")
    def validate_lifecycle(self) -> MatterDeletionJob:
        if self.updated_at < self.requested_at:
            raise ValueError("Deletion job updated_at cannot precede requested_at.")
        if self.last_attempt_at is not None and self.last_attempt_at < self.requested_at:
            raise ValueError("Deletion attempts cannot precede the request.")
        if self.status == "running":
            if self.last_attempt_at is None or self.lease_expires_at is None:
                raise ValueError("Running deletion jobs require an active lease.")
            if self.lease_expires_at <= self.last_attempt_at:
                raise ValueError("Deletion job lease must expire after the attempt starts.")
        elif self.lease_expires_at is not None:
            raise ValueError("Only running deletion jobs may retain a lease.")
        if self.status == "complete":
            if self.completed_at is None or not self.all_references_cleared:
                raise ValueError("Complete deletion jobs require every cleanup stage.")
        elif self.completed_at is not None:
            raise ValueError("Only complete deletion jobs may have completed_at.")
        if self.status == "ready" and not self.all_references_cleared:
            raise ValueError("Ready deletion jobs require every cleanup stage.")
        if self.status == "failed" and self.last_error_stage is None:
            raise ValueError("Failed deletion jobs require a bounded error stage.")
        if self.status != "failed" and self.last_error_stage is not None:
            raise ValueError("Only failed deletion jobs may retain an error stage.")
        return self

    @property
    def all_references_cleared(self) -> bool:
        return all(
            timestamp is not None
            for timestamp in (
                self.application_refs_cleared_at,
                self.review_refs_cleared_at,
                self.knowledge_refs_cleared_at,
                self.legacy_refs_cleared_at,
            )
        )


class DraftRevisionCapacity(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    current_revision: int = Field(ge=1, le=MAX_DRAFT_REVISIONS)
    max_revisions: int = Field(default=MAX_DRAFT_REVISIONS, ge=1)
    remaining_revisions: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_remaining(self) -> DraftRevisionCapacity:
        if self.max_revisions != MAX_DRAFT_REVISIONS:
            raise ValueError("Unsupported draft revision capacity.")
        if self.remaining_revisions != self.max_revisions - self.current_revision:
            raise ValueError("Draft revision capacity is inconsistent.")
        return self


class MatterCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_MATTER_NAME_CHARS)
    member_user_ids: list[ScopedId] = Field(default_factory=list, max_length=500)
    retention_days: int | None = Field(default=None, ge=1, le=MAX_MATTER_RETENTION_DAYS)


class MatterUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=1, le=SIGNED_BIGINT_MAX)
    name: str | None = Field(default=None, min_length=1, max_length=MAX_MATTER_NAME_CHARS)
    # Omission preserves the current policy; an explicit null clears this
    # metadata without triggering deletion or retention enforcement.
    retention_days: int | None = Field(default=None, ge=1, le=MAX_MATTER_RETENTION_DAYS)


class MatterMemberMutationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=1, le=SIGNED_BIGINT_MAX)


class DraftCreateRequest(BaseModel):
    """Create one private draft whose identifier is assigned by the server."""

    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=MAX_DRAFT_TITLE_CHARS)
    content: str
    matter_id: ScopedId | None = None


class DraftPutRequest(BaseModel):
    """CAS-update an existing private draft; PUT never creates caller-chosen IDs."""

    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=1, le=MAX_DRAFT_REVISIONS)
    title: str | None = Field(default=None, min_length=1, max_length=MAX_DRAFT_TITLE_CHARS)
    content: str | None = None
    # Omission preserves the current binding while an explicit null unlinks it.
    matter_id: ScopedId | None = None


class MatterDeletionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    job: MatterDeletionJob


def _normalize_label(value: str, *, label: str, max_chars: int) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{label} must be a string.")
    normalized = " ".join(value.replace("\x00", "").split())
    if not normalized:
        raise ValueError(f"{label} cannot be blank.")
    if len(normalized) > max_chars:
        raise ValueError(f"{label} is limited to {max_chars} characters.")
    return normalized


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Matter and draft timestamps must be timezone-aware.")
    return value.astimezone(UTC)


_ALLOWED_TAGS = frozenset(
    {
        "a",
        "b",
        "blockquote",
        "br",
        "code",
        "del",
        "div",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "i",
        "img",
        "ins",
        "li",
        "mark",
        "ol",
        "p",
        "pre",
        "s",
        "span",
        "strong",
        "sub",
        "sup",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "u",
        "ul",
    }
)
_VOID_TAGS = frozenset({"br", "hr", "img"})
_DROP_CONTENT_TAGS = frozenset(
    {
        "applet",
        "base",
        "button",
        "embed",
        "form",
        "iframe",
        "input",
        "link",
        "math",
        "meta",
        "object",
        "option",
        "script",
        "select",
        "style",
        "svg",
        "textarea",
    }
)
_GLOBAL_ATTRIBUTES = frozenset({"class", "dir", "lang", "style"})
_TAG_ATTRIBUTES = {
    "a": frozenset({"href", "rel", "target", "title"}),
    "img": frozenset({"alt", "height", "src", "title", "width"}),
    "ol": frozenset({"start", "type"}),
    "td": frozenset({"colspan", "rowspan"}),
    "th": frozenset({"colspan", "rowspan", "scope"}),
}
_SAFE_STYLE_PROPERTIES = frozenset(
    {
        "background-color",
        "break-after",
        "break-before",
        "color",
        "font-family",
        "font-size",
        "font-style",
        "font-weight",
        "height",
        "line-height",
        "list-style-type",
        "margin-left",
        "margin-right",
        "max-width",
        "page-break-after",
        "page-break-before",
        "padding-left",
        "text-align",
        "text-decoration",
        "text-indent",
        "width",
    }
)
_SAFE_STYLE_VALUE = re.compile(r"^[a-zA-Z0-9\s#.,%()'\"/+\-]*$")
_SAFE_CLASS = re.compile(r"^[a-zA-Z0-9_\- ]*$")
_SAFE_DIMENSION = re.compile(r"^[0-9]{1,5}(?:\.[0-9]{1,3})?(?:px|pt|em|rem|%)?$")


class _DraftHTMLSanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self._parts: list[str] = []
        self._open_tags: list[str] = []
        self._blocked_tags: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self._blocked_tags:
            self._blocked_tags.append(tag)
            return
        if tag in _DROP_CONTENT_TAGS:
            self._blocked_tags.append(tag)
            return
        if tag not in _ALLOWED_TAGS:
            return
        rendered = self._safe_attributes(tag, attrs)
        self._parts.append(f"<{tag}{rendered}>")
        if tag not in _VOID_TAGS:
            self._open_tags.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self._blocked_tags or tag in _DROP_CONTENT_TAGS or tag not in _ALLOWED_TAGS:
            return
        rendered = self._safe_attributes(tag, attrs)
        self._parts.append(f"<{tag}{rendered}>")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._blocked_tags:
            if tag == self._blocked_tags[-1]:
                self._blocked_tags.pop()
            return
        if tag not in self._open_tags:
            return
        index = len(self._open_tags) - 1 - self._open_tags[::-1].index(tag)
        for open_tag in reversed(self._open_tags[index:]):
            self._parts.append(f"</{open_tag}>")
        del self._open_tags[index:]

    def handle_data(self, data: str) -> None:
        if not self._blocked_tags:
            self._parts.append(escape(data.replace("\x00", ""), quote=False))

    def handle_entityref(self, name: str) -> None:
        if not self._blocked_tags:
            self._parts.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if not self._blocked_tags:
            self._parts.append(f"&#{name};")

    def render(self) -> str:
        for tag in reversed(self._open_tags):
            self._parts.append(f"</{tag}>")
        self._open_tags.clear()
        return "".join(self._parts)

    @classmethod
    def _safe_attributes(
        cls,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> str:
        safe: dict[str, str] = {}
        allowed = _GLOBAL_ATTRIBUTES | _TAG_ATTRIBUTES.get(tag, frozenset())
        for raw_name, raw_value in attrs:
            name = raw_name.lower()
            value = raw_value or ""
            if name not in allowed or name.startswith("on"):
                continue
            candidate = cls._safe_attribute_value(tag, name, value)
            if candidate is not None:
                safe[name] = candidate
        if tag == "a" and safe.get("target") == "_blank":
            safe["rel"] = "noopener noreferrer"
        return "".join(
            f' {name}="{escape(value, quote=True)}"' for name, value in sorted(safe.items())
        )

    @staticmethod
    def _safe_attribute_value(tag: str, name: str, value: str) -> str | None:
        value = value.strip().replace("\x00", "")
        if any(ord(character) < 32 for character in value):
            return None
        if name == "style":
            return _sanitize_style(value)
        if name == "class":
            return value if len(value) <= 200 and _SAFE_CLASS.fullmatch(value) else None
        if name in {"href", "src"}:
            return _safe_url(tag, name, value)
        if name in {"height", "width"}:
            return value if _SAFE_DIMENSION.fullmatch(value) else None
        if name in {"colspan", "rowspan", "start"}:
            return value if value.isdigit() and 0 < int(value) <= 10_000 else None
        if name == "target":
            return value if value in {"_blank", "_self"} else None
        if name == "rel":
            tokens = {token.lower() for token in value.split()}
            allowed = tokens & {"nofollow", "noopener", "noreferrer"}
            return " ".join(sorted(allowed)) if allowed else None
        if name == "dir":
            return value.lower() if value.lower() in {"auto", "ltr", "rtl"} else None
        if name == "scope":
            return (
                value.lower() if value.lower() in {"col", "colgroup", "row", "rowgroup"} else None
            )
        if name == "type" and tag == "ol":
            return value if value in {"1", "A", "a", "I", "i"} else None
        return value[:500]


def _sanitize_style(value: str) -> str | None:
    if any(token in value.lower() for token in ("url", "expression", "@import", "\\")):
        return None
    declarations: list[str] = []
    for raw_declaration in value.split(";"):
        if ":" not in raw_declaration:
            continue
        raw_property, raw_value = raw_declaration.split(":", 1)
        property_name = raw_property.strip().lower()
        property_value = raw_value.strip()
        if (
            property_name in _SAFE_STYLE_PROPERTIES
            and len(property_value) <= 160
            and _SAFE_STYLE_VALUE.fullmatch(property_value)
        ):
            declarations.append(f"{property_name}: {property_value}")
    return "; ".join(declarations) if declarations else None


def _safe_url(tag: str, name: str, value: str) -> str | None:
    if not value or any(character.isspace() for character in value):
        return None
    lowered = value.lower()
    if lowered.startswith("/api/drafts/preserved-assets/") or lowered.startswith("#"):
        return value
    parsed = urlsplit(value)
    if name == "href" and parsed.scheme.lower() in {"http", "https", "mailto"}:
        return value
    if (
        tag == "img"
        and name == "src"
        and lowered.startswith(("data:image/png;base64,", "data:image/jpeg;base64,"))
    ):
        return value
    return None
