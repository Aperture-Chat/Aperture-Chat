from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import Settings, get_settings

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_FIELDS = "id,type,name,modified_at,size,item_status,path_collection"
MAX_SYNC_ITEMS = 500
MAX_FILE_DOWNLOAD_BYTES = 15 * 1024 * 1024


class BoxError(RuntimeError):
    """Raised when Box cannot return a folder inventory."""


@dataclass(frozen=True)
class BoxItem:
    id: str
    type: str
    name: str
    modified_at: str | None = None
    size: int | None = None
    item_status: str | None = None
    path: str | None = None


class BoxClient:
    def __init__(
        self,
        *,
        access_token: str | None,
        base_url: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._access_token = access_token
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    @property
    def configured(self) -> bool:
        return bool(self._access_token)

    def list_folder_items(self, *, folder_id: str, limit: int = 100, max_items: int = MAX_SYNC_ITEMS) -> list[BoxItem]:
        if not self._access_token:
            raise BoxError("Box access token is not configured.")
        if not folder_id:
            raise BoxError("Box folder id is required.")

        safe_limit = max(1, min(limit, 1000))
        safe_max_items = max(1, max_items)
        offset = 0
        items: list[BoxItem] = []
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                while len(items) < safe_max_items:
                    response = client.get(
                        f"{self._base_url}/folders/{folder_id}/items",
                        headers={"Authorization": f"Bearer {self._access_token}"},
                        params={
                            "fields": DEFAULT_FIELDS,
                            "limit": safe_limit,
                            "offset": offset,
                        },
                    )
                    response.raise_for_status()
                    payload = response.json()
                    entries = payload.get("entries")
                    if not isinstance(entries, list):
                        raise BoxError("Box folder response did not include entries.")
                    for entry in entries:
                        if isinstance(entry, dict):
                            item = _box_item(entry)
                            if item is not None:
                                items.append(item)
                                if len(items) >= safe_max_items:
                                    break
                    total_count = int(payload.get("total_count") or 0)
                    next_offset = offset + len(entries)
                    if not entries or next_offset >= total_count or len(items) >= safe_max_items:
                        break
                    offset = next_offset
        except httpx.HTTPStatusError as exc:
            raise BoxError(f"Box returned HTTP {exc.response.status_code}.") from exc
        except httpx.HTTPError as exc:
            raise BoxError(f"Box request failed: {type(exc).__name__}.") from exc
        return items

    def download_file(self, *, file_id: str, max_bytes: int = MAX_FILE_DOWNLOAD_BYTES) -> bytes:
        if not self._access_token:
            raise BoxError("Box access token is not configured.")
        if not file_id:
            raise BoxError("Box file id is required.")

        safe_max_bytes = max(1, max_bytes)
        try:
            with httpx.Client(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=True,
            ) as client:
                response = client.get(
                    f"{self._base_url}/files/{file_id}/content",
                    headers={"Authorization": f"Bearer {self._access_token}"},
                )
                response.raise_for_status()
                content = response.content
        except httpx.HTTPStatusError as exc:
            raise BoxError(f"Box returned HTTP {exc.response.status_code}.") from exc
        except httpx.HTTPError as exc:
            raise BoxError(f"Box file download failed: {type(exc).__name__}.") from exc
        if len(content) > safe_max_bytes:
            raise BoxError("Box file exceeds the configured ingestion size limit.")
        return content


def _box_item(entry: dict[str, Any]) -> BoxItem | None:
    item_id = entry.get("id")
    item_type = entry.get("type")
    name = entry.get("name")
    if not isinstance(item_id, str) or not isinstance(item_type, str) or not isinstance(name, str):
        return None
    size = entry.get("size")
    path_collection = entry.get("path_collection")
    return BoxItem(
        id=item_id,
        type=item_type,
        name=name,
        modified_at=entry.get("modified_at") if isinstance(entry.get("modified_at"), str) else None,
        size=size if isinstance(size, int) else None,
        item_status=entry.get("item_status") if isinstance(entry.get("item_status"), str) else None,
        path=_box_path(path_collection),
    )


def _box_path(path_collection: object) -> str | None:
    if not isinstance(path_collection, dict):
        return None
    entries = path_collection.get("entries")
    if not isinstance(entries, list):
        return None
    parts = [entry.get("name") for entry in entries if isinstance(entry, dict) and isinstance(entry.get("name"), str)]
    return "/".join(parts) if parts else None


def build_box_client(settings: Settings, access_token: str | None) -> BoxClient:
    return BoxClient(access_token=access_token, base_url=settings.box_base_url)


def get_box_client(access_token: str | None) -> BoxClient:
    return build_box_client(get_settings(), access_token)
