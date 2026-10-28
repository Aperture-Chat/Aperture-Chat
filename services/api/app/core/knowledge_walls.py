"""Ethical walls for knowledge documents, read from preserved file metadata.

A file can name the group(s) allowed to see it in a metadata field such as
"Ethical wall" (a Box metadata template field, an Office custom property, a
SharePoint column, ...). Each value names an Aperture group by name or id in the
document's tenant. Values that match no group fail closed: they admit nobody,
so a typo or a not-yet-created group never opens a walled file. Administrators
can override a document's wall; the override is kept in the knowledge base's
settings so every re-index applies it again.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

from app.models.schemas import Group, KnowledgeDocumentWall

# Metadata fields read as walls in every knowledge base. A base can add its own
# field names under ``WALL_FIELDS_SETTING``.
DEFAULT_WALL_FIELDS = (
    "Ethical wall",
    "Ethical walls",
    "Information barrier",
    "Information barriers",
    "Wall groups",
)
WALL_FIELDS_SETTING = "wall_fields"
DOCUMENT_WALLS_SETTING = "document_walls"
# Prefixed metadata keys ("Box metadata · Matter info · Ethical wall") are
# matched on their last segment.
KEY_SEPARATOR = " · "

_VALUE_SPLIT = re.compile(r"[;,|\n]+")
_NOT_ALPHANUMERIC = re.compile(r"[^a-z0-9]+")


def resolve_document_wall(
    metadata: Mapping[str, str],
    *,
    tenant_id: str,
    groups: Iterable[Group],
    extra_fields: Iterable[str] = (),
    override: Mapping[str, Any] | None = None,
) -> KnowledgeDocumentWall | None:
    """The wall one document should carry, or None when it has none."""

    tenant_groups = [group for group in groups if group.tenant_id == tenant_id]
    if override is not None:
        return _override_wall(override, tenant_groups)
    field, values = _wall_values(metadata, [*DEFAULT_WALL_FIELDS, *extra_fields])
    if not values:
        return None
    group_ids: list[str] = []
    unresolved: list[str] = []
    for value in values:
        group = _matching_group(value, tenant_groups)
        if group is None:
            unresolved.append(value)
        elif group.id not in group_ids:
            group_ids.append(group.id)
    return KnowledgeDocumentWall(
        source="metadata",
        group_ids=group_ids,
        field=field,
        values=values,
        unresolved=unresolved,
    )


def wall_field_names(settings: Mapping[str, Any]) -> list[str]:
    """The extra wall fields a knowledge base configured, cleaned."""

    raw = settings.get(WALL_FIELDS_SETTING)
    if not isinstance(raw, list):
        return []
    return [str(item).strip() for item in raw if str(item).strip()]


def document_wall_overrides(settings: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Administrator wall overrides keyed by document id."""

    raw = settings.get(DOCUMENT_WALLS_SETTING)
    if not isinstance(raw, dict):
        return {}
    return {str(key): dict(value) for key, value in raw.items() if isinstance(value, dict)}


def wall_group_ids(wall: KnowledgeDocumentWall | None) -> list[str] | None:
    """The group list passages carry: None when open, else the wall's groups."""

    return None if wall is None else list(wall.group_ids)


def _override_wall(
    override: Mapping[str, Any], tenant_groups: list[Group]
) -> KnowledgeDocumentWall | None:
    if override.get("mode") != "restricted":
        return None
    known = {group.id for group in tenant_groups}
    requested = override.get("group_ids")
    group_ids = [
        str(group_id)
        for group_id in (requested if isinstance(requested, list) else [])
        if str(group_id) in known
    ]
    return KnowledgeDocumentWall(source="manual", group_ids=list(dict.fromkeys(group_ids)))


def _wall_values(
    metadata: Mapping[str, str], field_names: list[str]
) -> tuple[str | None, list[str]]:
    wanted = {_field_key(name) for name in field_names}
    first_field: str | None = None
    values: list[str] = []
    for key, raw_value in metadata.items():
        if _field_key(key.rsplit(KEY_SEPARATOR, 1)[-1]) not in wanted:
            continue
        for value in _VALUE_SPLIT.split(str(raw_value)):
            cleaned = " ".join(value.split())
            if cleaned and cleaned not in values:
                values.append(cleaned)
                first_field = first_field or key
    return first_field, values


def _matching_group(value: str, tenant_groups: list[Group]) -> Group | None:
    wanted = value.casefold()
    for group in tenant_groups:
        if group.id == value or " ".join(group.name.split()).casefold() == wanted:
            return group
    return None


def _field_key(name: str) -> str:
    return _NOT_ALPHANUMERIC.sub("", name.casefold())
