from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from app.core.config import Settings, get_settings
from app.core.net_guard import REDIRECT_GUARD_HOOKS, EgressBlocked, validate_public_url

DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_SYNC_ITEMS = 500
MAX_FILE_DOWNLOAD_BYTES = 15 * 1024 * 1024
GRAPH_DEFAULT_FIELDS = "id,name,file,folder,size,lastModifiedDateTime,webUrl,@microsoft.graph.downloadUrl"
GOOGLE_FIELDS = "nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink)"


class CloudSourceError(RuntimeError):
    """Raised when an enterprise content connector cannot return inventory."""


@dataclass(frozen=True)
class CloudSourceItem:
    id: str
    type: str
    name: str
    source_type: str
    source_uri: str
    modified_at: str | None = None
    size: int | None = None
    item_status: str | None = None
    mime_type: str | None = None
    download_url: str | None = None


class MicrosoftGraphClient:
    def __init__(
        self,
        *,
        access_token: str | None,
        base_url: str = "https://graph.microsoft.com/v1.0",
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._access_token = access_token
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    def list_drive_items(
        self,
        *,
        item_id: str,
        drive_id: str | None = None,
        site_id: str | None = None,
        limit: int = 100,
        max_items: int = MAX_SYNC_ITEMS,
    ) -> list[CloudSourceItem]:
        if not self._access_token:
            raise CloudSourceError("Microsoft Graph access token is not configured.")
        if not item_id:
            raise CloudSourceError("Microsoft Graph drive item id is required.")
        path = _graph_children_path(item_id=item_id, drive_id=drive_id, site_id=site_id)
        return self._list_collection(
            path,
            params={"$top": max(1, min(limit, 999)), "$select": GRAPH_DEFAULT_FIELDS},
            max_items=max_items,
        )

    def download_file(
        self,
        *,
        file_id: str,
        drive_id: str | None = None,
        site_id: str | None = None,
        max_bytes: int = MAX_FILE_DOWNLOAD_BYTES,
    ) -> bytes:
        if not self._access_token:
            raise CloudSourceError("Microsoft Graph access token is not configured.")
        if not file_id:
            raise CloudSourceError("Microsoft Graph file id is required.")
        safe_file_id = quote(file_id, safe="")
        if drive_id:
            path = f"/drives/{quote(drive_id, safe='')}/items/{safe_file_id}/content"
        elif site_id:
            path = f"/sites/{quote(site_id, safe='')}/drive/items/{safe_file_id}/content"
        else:
            # /me only resolves for delegated (user) tokens; app-only tokens must
            # target an explicit drive or site.
            path = f"/me/drive/items/{safe_file_id}/content"
        return self._download(path, max_bytes=max_bytes)

    def download_from_url(self, url: str, *, max_bytes: int = MAX_FILE_DOWNLOAD_BYTES) -> bytes:
        """Fetch a @microsoft.graph.downloadUrl. The URL is pre-authenticated, so
        no bearer header is sent; it works for both app-only and user tokens."""
        try:
            validate_public_url(url)
        except EgressBlocked as exc:
            raise CloudSourceError(f"connector endpoint is not permitted by egress policy: {exc}") from exc
        try:
            with httpx.Client(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=True,
                event_hooks=REDIRECT_GUARD_HOOKS,
            ) as client:
                response = client.get(url)
                response.raise_for_status()
                content = response.content
        except httpx.HTTPStatusError as exc:
            raise CloudSourceError(f"Microsoft Graph returned HTTP {exc.response.status_code}.") from exc
        except EgressBlocked as exc:
            raise CloudSourceError(f"connector endpoint is not permitted by egress policy: {exc}") from exc
        except httpx.HTTPError as exc:
            raise CloudSourceError(f"Microsoft Graph file download failed: {type(exc).__name__}.") from exc
        if len(content) > max(1, max_bytes):
            raise CloudSourceError("Microsoft Graph file exceeds the configured ingestion size limit.")
        return content

    def _list_collection(
        self,
        path: str,
        *,
        params: dict[str, object],
        max_items: int,
    ) -> list[CloudSourceItem]:
        items: list[CloudSourceItem] = []
        next_url: str | None = f"{self._base_url}{path}"
        try:
            with httpx.Client(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=True,
                event_hooks=REDIRECT_GUARD_HOOKS,
            ) as client:
                while next_url and len(items) < max(1, max_items):
                    response = client.get(next_url, headers=self._headers(), params=params if "?" not in next_url else None)
                    response.raise_for_status()
                    payload = response.json()
                    entries = payload.get("value")
                    if not isinstance(entries, list):
                        raise CloudSourceError("Microsoft Graph response did not include value entries.")
                    for entry in entries:
                        if isinstance(entry, dict):
                            item = _graph_item(entry)
                            if item is not None:
                                items.append(item)
                                if len(items) >= max(1, max_items):
                                    break
                    raw_next = payload.get("@odata.nextLink")
                    next_url = raw_next if isinstance(raw_next, str) and raw_next else None
                    params = {}
        except httpx.HTTPStatusError as exc:
            raise CloudSourceError(f"Microsoft Graph returned HTTP {exc.response.status_code}.") from exc
        except EgressBlocked as exc:
            raise CloudSourceError(f"connector endpoint is not permitted by egress policy: {exc}") from exc
        except httpx.HTTPError as exc:
            raise CloudSourceError(f"Microsoft Graph request failed: {type(exc).__name__}.") from exc
        return items

    def _download(self, path: str, *, max_bytes: int) -> bytes:
        try:
            with httpx.Client(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=True,
                event_hooks=REDIRECT_GUARD_HOOKS,
            ) as client:
                response = client.get(f"{self._base_url}{path}", headers=self._headers())
                response.raise_for_status()
                content = response.content
        except httpx.HTTPStatusError as exc:
            raise CloudSourceError(f"Microsoft Graph returned HTTP {exc.response.status_code}.") from exc
        except EgressBlocked as exc:
            raise CloudSourceError(f"connector endpoint is not permitted by egress policy: {exc}") from exc
        except httpx.HTTPError as exc:
            raise CloudSourceError(f"Microsoft Graph file download failed: {type(exc).__name__}.") from exc
        if len(content) > max(1, max_bytes):
            raise CloudSourceError("Microsoft Graph file exceeds the configured ingestion size limit.")
        return content

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token}"}


class GoogleDriveClient:
    def __init__(
        self,
        *,
        access_token: str | None,
        base_url: str = "https://www.googleapis.com/drive/v3",
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._access_token = access_token
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._transport = transport

    def list_files(self, *, folder_id: str, page_size: int = 100, max_items: int = MAX_SYNC_ITEMS) -> list[CloudSourceItem]:
        if not self._access_token:
            raise CloudSourceError("Google Drive access token is not configured.")
        if not folder_id:
            raise CloudSourceError("Google Drive folder id is required.")
        items: list[CloudSourceItem] = []
        page_token: str | None = None
        try:
            with httpx.Client(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=True,
                event_hooks=REDIRECT_GUARD_HOOKS,
            ) as client:
                while len(items) < max(1, max_items):
                    params: dict[str, object] = {
                        "q": f"'{folder_id}' in parents and trashed=false",
                        "fields": GOOGLE_FIELDS,
                        "pageSize": max(1, min(page_size, 1000)),
                        "supportsAllDrives": "true",
                        "includeItemsFromAllDrives": "true",
                    }
                    if page_token:
                        params["pageToken"] = page_token
                    response = client.get(f"{self._base_url}/files", headers=self._headers(), params=params)
                    response.raise_for_status()
                    payload = response.json()
                    files = payload.get("files")
                    if not isinstance(files, list):
                        raise CloudSourceError("Google Drive response did not include files.")
                    for entry in files:
                        if isinstance(entry, dict):
                            item = _google_item(entry)
                            if item is not None:
                                items.append(item)
                                if len(items) >= max(1, max_items):
                                    break
                    raw_next = payload.get("nextPageToken")
                    page_token = raw_next if isinstance(raw_next, str) and raw_next else None
                    if not page_token:
                        break
        except httpx.HTTPStatusError as exc:
            raise CloudSourceError(f"Google Drive returned HTTP {exc.response.status_code}.") from exc
        except EgressBlocked as exc:
            raise CloudSourceError(f"connector endpoint is not permitted by egress policy: {exc}") from exc
        except httpx.HTTPError as exc:
            raise CloudSourceError(f"Google Drive request failed: {type(exc).__name__}.") from exc
        return items

    def download_file(
        self,
        *,
        file_id: str,
        mime_type: str | None = None,
        max_bytes: int = MAX_FILE_DOWNLOAD_BYTES,
    ) -> bytes:
        if not self._access_token:
            raise CloudSourceError("Google Drive access token is not configured.")
        if not file_id:
            raise CloudSourceError("Google Drive file id is required.")
        safe_file_id = quote(file_id, safe="")
        if mime_type and mime_type.startswith("application/vnd.google-apps."):
            path = f"/files/{safe_file_id}/export"
            params = {"mimeType": "text/plain"}
        else:
            path = f"/files/{safe_file_id}"
            params = {"alt": "media", "supportsAllDrives": "true"}
        return self._download(path, params=params, max_bytes=max_bytes)

    def _download(self, path: str, *, params: dict[str, object], max_bytes: int) -> bytes:
        try:
            with httpx.Client(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=True,
                event_hooks=REDIRECT_GUARD_HOOKS,
            ) as client:
                response = client.get(f"{self._base_url}{path}", headers=self._headers(), params=params)
                response.raise_for_status()
                content = response.content
        except httpx.HTTPStatusError as exc:
            raise CloudSourceError(f"Google Drive returned HTTP {exc.response.status_code}.") from exc
        except EgressBlocked as exc:
            raise CloudSourceError(f"connector endpoint is not permitted by egress policy: {exc}") from exc
        except httpx.HTTPError as exc:
            raise CloudSourceError(f"Google Drive file download failed: {type(exc).__name__}.") from exc
        if len(content) > max(1, max_bytes):
            raise CloudSourceError("Google Drive file exceeds the configured ingestion size limit.")
        return content

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token}"}


class IManageClient:
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

    def list_documents(
        self,
        *,
        workspace_id: str,
        documents_endpoint: str | None = None,
        customer_id: str | None = None,
        library_id: str | None = None,
        max_items: int = MAX_SYNC_ITEMS,
    ) -> list[CloudSourceItem]:
        if not self._access_token:
            raise CloudSourceError("iManage access token is not configured.")
        endpoint = documents_endpoint or _imanage_documents_path(
            workspace_id=workspace_id,
            customer_id=customer_id,
            library_id=library_id,
        )
        if not endpoint:
            raise CloudSourceError("iManage documents endpoint is not configured.")
        try:
            with httpx.Client(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=True,
                event_hooks=REDIRECT_GUARD_HOOKS,
            ) as client:
                response = client.get(_absolute_or_joined_url(self._base_url, endpoint), headers=self._headers())
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as exc:
            raise CloudSourceError(f"iManage returned HTTP {exc.response.status_code}.") from exc
        except EgressBlocked as exc:
            raise CloudSourceError(f"connector endpoint is not permitted by egress policy: {exc}") from exc
        except httpx.HTTPError as exc:
            raise CloudSourceError(f"iManage request failed: {type(exc).__name__}.") from exc
        entries = _imanage_entries(payload)
        items: list[CloudSourceItem] = []
        for entry in entries:
            item = _imanage_item(entry, workspace_id=workspace_id)
            if item is not None:
                items.append(item)
                if len(items) >= max(1, max_items):
                    break
        return items

    def download_file(
        self,
        *,
        file_id: str,
        download_endpoint: str | None = None,
        max_bytes: int = MAX_FILE_DOWNLOAD_BYTES,
    ) -> bytes:
        if not self._access_token:
            raise CloudSourceError("iManage access token is not configured.")
        if not file_id:
            raise CloudSourceError("iManage file id is required.")
        endpoint = download_endpoint or f"/api/v2/documents/{quote(file_id, safe='')}/download"
        try:
            with httpx.Client(
                timeout=self._timeout,
                transport=self._transport,
                follow_redirects=True,
                event_hooks=REDIRECT_GUARD_HOOKS,
            ) as client:
                response = client.get(_absolute_or_joined_url(self._base_url, endpoint), headers=self._headers())
                response.raise_for_status()
                content = response.content
        except httpx.HTTPStatusError as exc:
            raise CloudSourceError(f"iManage returned HTTP {exc.response.status_code}.") from exc
        except EgressBlocked as exc:
            raise CloudSourceError(f"connector endpoint is not permitted by egress policy: {exc}") from exc
        except httpx.HTTPError as exc:
            raise CloudSourceError(f"iManage file download failed: {type(exc).__name__}.") from exc
        if len(content) > max(1, max_bytes):
            raise CloudSourceError("iManage file exceeds the configured ingestion size limit.")
        return content

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._access_token}"}


def _graph_children_path(*, item_id: str, drive_id: str | None, site_id: str | None) -> str:
    safe_item_id = quote(item_id, safe="")
    if drive_id:
        return f"/drives/{quote(drive_id, safe='')}/items/{safe_item_id}/children"
    if site_id:
        return f"/sites/{quote(site_id, safe='')}/drive/items/{safe_item_id}/children"
    return f"/me/drive/items/{safe_item_id}/children"


def _graph_item(entry: dict[str, Any]) -> CloudSourceItem | None:
    item_id = entry.get("id")
    name = entry.get("name")
    if not isinstance(item_id, str) or not isinstance(name, str):
        return None
    item_type = "file" if isinstance(entry.get("file"), dict) else "folder" if isinstance(entry.get("folder"), dict) else "item"
    size = entry.get("size")
    return CloudSourceItem(
        id=item_id,
        type=item_type,
        name=name,
        source_type="microsoft-graph",
        source_uri=str(entry.get("webUrl") or f"graph://items/{item_id}"),
        modified_at=entry.get("lastModifiedDateTime") if isinstance(entry.get("lastModifiedDateTime"), str) else None,
        size=size if isinstance(size, int) else None,
        item_status="active",
        mime_type=_graph_mime_type(entry),
        download_url=entry.get("@microsoft.graph.downloadUrl")
        if isinstance(entry.get("@microsoft.graph.downloadUrl"), str)
        else None,
    )


def _graph_mime_type(entry: dict[str, Any]) -> str | None:
    file_info = entry.get("file")
    if not isinstance(file_info, dict):
        return None
    mime_type = file_info.get("mimeType")
    return mime_type if isinstance(mime_type, str) else None


def _google_item(entry: dict[str, Any]) -> CloudSourceItem | None:
    item_id = entry.get("id")
    name = entry.get("name")
    mime_type = entry.get("mimeType")
    if not isinstance(item_id, str) or not isinstance(name, str):
        return None
    item_type = "folder" if mime_type == "application/vnd.google-apps.folder" else "file"
    size_value = entry.get("size")
    try:
        size = int(size_value) if size_value is not None else None
    except (TypeError, ValueError):
        size = None
    return CloudSourceItem(
        id=item_id,
        type=item_type,
        name=name,
        source_type="google-drive",
        source_uri=str(entry.get("webViewLink") or f"gdrive://files/{item_id}"),
        modified_at=entry.get("modifiedTime") if isinstance(entry.get("modifiedTime"), str) else None,
        size=size,
        item_status="active",
        mime_type=mime_type if isinstance(mime_type, str) else None,
    )


def _imanage_documents_path(
    *,
    workspace_id: str,
    customer_id: str | None,
    library_id: str | None,
) -> str | None:
    if not workspace_id:
        return None
    if customer_id and library_id:
        return (
            f"/api/v2/customers/{quote(customer_id, safe='')}/libraries/{quote(library_id, safe='')}"
            f"/workspaces/{quote(workspace_id, safe='')}/documents"
        )
    return f"/api/v2/workspaces/{quote(workspace_id, safe='')}/documents"


def _imanage_entries(payload: object) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [entry for entry in payload if isinstance(entry, dict)]
    if not isinstance(payload, dict):
        raise CloudSourceError("iManage response was not a JSON object.")
    for key in ("data", "documents", "results", "items"):
        entries = payload.get(key)
        if isinstance(entries, list):
            return [entry for entry in entries if isinstance(entry, dict)]
    raise CloudSourceError("iManage response did not include document entries.")


def _imanage_item(entry: dict[str, Any], *, workspace_id: str) -> CloudSourceItem | None:
    raw_id = entry.get("id") or entry.get("document_id") or entry.get("docnum")
    raw_name = entry.get("name") or entry.get("document_name") or entry.get("description") or entry.get("filename")
    if raw_id is None or not isinstance(raw_name, str):
        return None
    item_id = str(raw_id)
    modified = entry.get("modified_at") or entry.get("edit_date") or entry.get("last_modified")
    size = entry.get("size")
    return CloudSourceItem(
        id=item_id,
        type="file",
        name=raw_name,
        source_type="imanage",
        source_uri=str(entry.get("web_url") or entry.get("url") or f"imanage://{workspace_id}/documents/{item_id}"),
        modified_at=modified if isinstance(modified, str) else None,
        size=size if isinstance(size, int) else None,
        item_status=str(entry.get("status") or "indexed"),
        mime_type=entry.get("mime_type") if isinstance(entry.get("mime_type"), str) else None,
    )


def _absolute_or_joined_url(base_url: str, endpoint: str) -> str:
    if endpoint.startswith("http://") or endpoint.startswith("https://"):
        url = endpoint
    else:
        url = f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"
    try:
        validate_public_url(url)
    except EgressBlocked as exc:
        raise CloudSourceError(f"iManage endpoint is not permitted: {exc}") from exc
    return url


def build_microsoft_graph_client(settings: Settings, access_token: str | None) -> MicrosoftGraphClient:
    return MicrosoftGraphClient(access_token=access_token)


def build_google_drive_client(settings: Settings, access_token: str | None) -> GoogleDriveClient:
    return GoogleDriveClient(access_token=access_token)


def build_imanage_client(settings: Settings, access_token: str | None, base_url: str) -> IManageClient:
    return IManageClient(access_token=access_token, base_url=base_url)


def get_microsoft_graph_client(access_token: str | None) -> MicrosoftGraphClient:
    return build_microsoft_graph_client(get_settings(), access_token)


def get_google_drive_client(access_token: str | None) -> GoogleDriveClient:
    return build_google_drive_client(get_settings(), access_token)


def get_imanage_client(access_token: str | None, base_url: str) -> IManageClient:
    return build_imanage_client(get_settings(), access_token, base_url)
