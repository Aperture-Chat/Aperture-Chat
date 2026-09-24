import json
import re
from html import escape
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile, status
from fastapi.responses import HTMLResponse
from starlette.concurrency import run_in_threadpool

from app.core.box import BoxError, BoxItem, get_box_client
from app.core.cloud_sources import (
    CloudSourceError,
    CloudSourceItem,
    get_google_drive_client,
    get_imanage_client,
    get_microsoft_graph_client,
)
from app.core.config import get_settings
from app.core.connector_auth import acquire_connector_token
from app.core.api_source_fetch import (
    ApiSourceError,
    ApiSourceRequest,
    FetchedApiSource,
    build_api_url,
    fetch_api_source,
    parse_header_lines,
)
from app.core.knowledge_ingestion import (
    ExtractedSegment,
    chunk_segments,
    extract_segments,
    extract_segments_from_file,
)
from app.core.knowledge_ingestion import _limit_segments as limit_extracted_segments
from app.core.media_transcription import (
    MediaTranscriptionError,
    is_media_upload,
    transcribe_media_file,
)
from app.core.net_guard import EgressBlocked, validate_public_url
from app.core.sessions import sign_oidc_state, verify_oidc_state
from app.core.uploads import validate_upload_within_limit
from app.core.usage_budget import UsageBudgetError, new_accounting_id
from app.core.usage_budget_runtime import (
    TenantUsageBudgetOrchestrator,
    UsageBudgetRequestContext,
    UsageProviderExecutionRefused,
    UsageTenantScopeError,
    map_usage_budget_error,
)
from app.core.web_fetch import WebFetchError, fetch_web_source
from app.core.policy import (
    assert_group_permission,
    assert_knowledge_access,
    is_tenant_admin,
    knowledge_access_allowed,
    knowledge_authoring_allowed,
)
from app.models.schemas import (
    ConnectorConfig,
    KnowledgeChunk,
    KnowledgeConfig,
    KnowledgeApiSourceCreateRequest,
    KnowledgeDocument,
    KnowledgeIndexStatus,
    KnowledgeSearchRequest,
    KnowledgeSearchResponse,
    KnowledgeSyncRequest,
    KnowledgeSyncResponse,
    KnowledgeWebSourceCreateRequest,
    Role,
    User,
)
from app.repositories.deps import get_store, get_usage_budget_orchestrator
from app.repositories.seed import SeedStore, knowledge_sync_status
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


@router.get("/{config_id}/oauth/authorize-url")
def api_source_oauth_authorize_url(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    """Return an IdP authorize URL carrying signed state bound to this config.

    The callback rejects any code exchange whose state was not minted here, so
    an attacker cannot poison the stored API-source token for a known config id.
    """
    config = _get_operable_config(config_id, actor, store)
    oauth_settings = _api_source_oauth_settings(config)
    authorization_url = str(oauth_settings.get("authorization_url") or "").strip()
    client_id = str(oauth_settings.get("client_id") or "").strip()
    if not authorization_url or not client_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This API source is missing its OAuth authorization URL or client ID.",
        )
    state = sign_oidc_state(
        {"config_id": config.id, "actor_id": actor.id}, get_settings().secret_key
    )
    callback_url = str(oauth_settings.get("callback_url") or "").strip() or (
        f"{get_settings().api_base_url.rstrip('/')}/api/knowledge/{config.id}/oauth/callback"
    )
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": callback_url,
        "state": state,
    }
    scopes = oauth_settings.get("scopes")
    if isinstance(scopes, list) and scopes:
        params["scope"] = " ".join(str(scope) for scope in scopes)
    elif isinstance(scopes, str) and scopes.strip():
        params["scope"] = scopes.strip()
    separator = "&" if "?" in authorization_url else "?"
    return {"authorize_url": f"{authorization_url}{separator}{urlencode(params)}", "state": state}


@router.get("/{config_id}/oauth/callback", response_class=HTMLResponse)
def api_source_oauth_callback(
    config_id: str,
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    store: SeedStore = Depends(get_store),
) -> HTMLResponse:
    """Finish an API source's provider sign-in in the popup the UI opened.

    The provider redirects a person's browser here, so every outcome is a short
    readable page. On success the waiting API source is fetched and indexed
    immediately; any failure is reported on the page and again on Sync.
    """
    config = store.knowledge_configs.get(config_id)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown knowledge configuration."
        )
    brand = store.brand_name(config.tenant_id)
    if error:
        return _oauth_popup_page(
            f"The provider did not grant access ({error}). Nothing was changed.",
            success=False,
            brand=brand,
        )
    if not code:
        return _oauth_popup_page(
            "This address receives the provider's sign-in response. Start the connection "
            "from the knowledge base in Aperture.",
            success=False,
            brand=brand,
            status_code=200,
        )
    if not _api_source_oauth_token_url(config):
        return _oauth_popup_page(
            "This knowledge base has no provider sign-in configured.",
            success=False,
            brand=brand,
        )
    state_payload = verify_oidc_state(state or "", get_settings().secret_key) if state else None
    if state_payload is None or str(state_payload.get("config_id") or "") != config.id:
        return _oauth_popup_page(
            "The sign-in link expired or did not come from Aperture. Start the connection again.",
            success=False,
            brand=brand,
        )
    try:
        token_payload = _exchange_api_source_oauth_code(config, code, _callback_url(request), store)
    except HTTPException as exc:
        return _oauth_popup_page(str(exc.detail), success=False, brand=brand)
    store.set_configuration_secret("knowledge-oauth-token", config.id, json.dumps(token_payload))
    settings = dict(config.settings)
    settings["oauth_token_status"] = "stored"
    settings["oauth_token_type"] = token_payload.get("token_type")
    settings["oauth_scope"] = token_payload.get("scope")
    config.settings = settings
    actor = store.users.get(str(state_payload.get("actor_id") or "")) or _oauth_callback_actor(
        config, store
    )
    store.record_audit(
        actor,
        "knowledge.oauth_token_stored",
        config.id,
        {
            "token_type": token_payload.get("token_type"),
            "scope": token_payload.get("scope"),
            "access_token": "[redacted]",
        },
    )
    message = _index_authorized_api_sources(config, actor, store)
    return _oauth_popup_page(message, success=True, brand=brand)


def _index_authorized_api_sources(config: KnowledgeConfig, actor: User, store: SeedStore) -> str:
    """Fetch API sources that were waiting for this provider sign-in."""
    sources = _linked_sources(config)
    waiting = [source for source in sources if source.get("awaiting_authorization")]
    if not waiting:
        return "Access granted. Use Sync in Aperture to refresh the API data."
    indexed: list[str] = []
    failed: list[str] = []
    for source in waiting:
        source["awaiting_authorization"] = False
        name = str(source.get("name") or "API source")
        try:
            fetched = _fetch_linked_api_source(config, source, store)
        except HTTPException as exc:
            failed.append(f"{name}: {exc.detail}")
            continue
        document, chunks = _document_from_text(
            config,
            name=name,
            source_type="api",
            source_uri=fetched.display_url,
            text=fetched.text,
            synced_at=_sync_time(),
            document_id=str(source.get("document_id") or "") or None,
        )
        source["document_id"] = document.id
        _save_linked_sources(config, sources)
        _append_indexed_sources(
            store,
            config,
            [document],
            chunks,
            synced_at=document.updated_at,
            provider_status="live",
            provider_message=_api_fetch_message(name, fetched, len(chunks)),
        )
        indexed.append(name)
    _save_linked_sources(config, sources)
    store.record_audit(
        actor,
        "knowledge.api_source_authorized",
        config.id,
        {"indexed": len(indexed), "failed": len(failed)},
    )
    if failed:
        return (
            "Access granted, but fetching the API failed: "
            + "; ".join(failed)
            + " Fix the source settings and use Sync in Aperture to try again."
        )
    return f"Access granted and {', '.join(indexed)} indexed."


def _oauth_popup_page(
    message: str,
    *,
    success: bool,
    brand: str = "Aperture Chat",
    status_code: int | None = None,
) -> HTMLResponse:
    heading = "Connected" if success else "Connection not finished"
    return HTMLResponse(
        content=(
            "<!doctype html><html><head><meta charset=\"utf-8\">"
            f"<title>{escape(brand)} — {escape(heading)}</title>"
            "<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;"
            "padding:0 16px;color:#1c2430}h1{font-size:18px}p{font-size:14px;line-height:1.5;"
            "color:#3d4757}</style></head><body>"
            f"<h1>{escape(heading)}</h1><p>{escape(message)}</p>"
            "<p>You can close this window and return to Aperture.</p>"
            + ("<script>setTimeout(function(){window.close();},2500);</script>" if success else "")
            + "</body></html>"
        ),
        status_code=status_code if status_code is not None else (200 if success else 400),
    )


@router.post("/search")
def search(
    payload: KnowledgeSearchRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeSearchResponse:
    assert_group_permission(actor, store.groups, "knowledge_access", "Knowledge access")
    query = payload.query.strip()
    if not query:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Search query is required."
        )
    config_ids = list(payload.knowledge_config_ids)
    if payload.agent_profile_id:
        agent_profile = store.models.get(payload.agent_profile_id)
        if agent_profile is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Unknown agent profile."
            )
        config_ids.extend(agent_profile.knowledge_config_ids)
    if not config_ids:
        config_ids = [
            config.id
            for config in store.knowledge_configs.values()
            if knowledge_access_allowed(actor, config)
        ]
    readable_config_ids = []
    for config_id in dict.fromkeys(config_ids):
        readable_config_ids.append(_get_readable_config(config_id, actor, store).id)
    limit = max(1, min(payload.limit, 20))
    hits = store.retrieve_knowledge(actor, readable_config_ids, query, limit=limit)
    store.record_audit(
        actor,
        "knowledge.vector_search",
        payload.agent_profile_id or "knowledge-api",
        {
            "knowledge_config_ids": readable_config_ids,
            "limit": limit,
            "hit_count": len(hits),
            "query": query,
        },
        runtime_state_changed=False,
    )
    return KnowledgeSearchResponse(query=query, knowledge_config_ids=readable_config_ids, hits=hits)


@router.get("/{config_id}/documents")
def documents(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[KnowledgeDocument]:
    config = _get_viewable_config(config_id, actor, store)
    documents = store.knowledge_documents_for(config.id)
    store.record_audit(
        actor,
        "knowledge.documents_listed",
        config.id,
        {"document_count": len(documents), "source_type": config.source_type},
        runtime_state_changed=False,
    )
    return documents


@router.get("/limits")
def limits(actor: User = Depends(current_user), store: SeedStore = Depends(get_store)) -> dict[str, Any]:
    """Upload and indexing limits the Library shows next to its upload controls."""
    del actor
    settings = get_settings()
    return {
        "upload_max_mb": settings.knowledge_upload_max_mb,
        "max_extracted_chars": settings.knowledge_max_extracted_chars,
        "ocr_enabled": settings.knowledge_ocr_enabled,
        "ocr_max_pages": settings.knowledge_ocr_max_pages,
        "semantic_search": store.vector_store.dense_status("")["semantic_search"],
        # Provider sign-ins must be registered with the exact callback the
        # server sends, so the UI shows this rather than guessing an origin.
        "oauth_callback_base": f"{get_settings().api_base_url.rstrip('/')}/api/knowledge",
    }


@router.get("/{config_id}/index-status")
def index_status(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeIndexStatus:
    """Report how much of a knowledge base still awaits semantic (dense) vectors."""
    config = _get_viewable_config(config_id, actor, store)
    return KnowledgeIndexStatus(
        knowledge_config_id=config.id,
        **store.knowledge_index_status(config.id),
    )


@router.post("/{config_id}/sync")
def sync(
    config_id: str,
    payload: KnowledgeSyncRequest | None = None,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeSyncResponse:
    config = _get_operable_config(config_id, actor, store)
    if config.source_type not in _CONNECTOR_SOURCE_TYPES:
        return _refresh_linked_sources(config, actor, store, force=bool(payload and payload.force))
    sync_documents, sync_chunks, provider_status, provider_message = _provider_sync_documents(
        config, store
    )
    config, documents, synced_at = store.sync_knowledge_config(
        config.id,
        sync_documents,
        chunks=sync_chunks,
        provider_status=provider_status,
        provider_message=provider_message,
    )
    store.record_audit(
        actor,
        "knowledge.config_synced",
        config.id,
        {
            "document_count": len(documents),
            "force": bool(payload.force) if payload is not None else False,
            "provider_message": provider_message,
            "provider_status": provider_status,
            "source_type": config.source_type,
        },
    )
    return KnowledgeSyncResponse(
        config=config,
        documents=documents,
        status=knowledge_sync_status(provider_status),
        synced_at=synced_at,
        provider_status=provider_status,
        provider_message=provider_message,
    )


@router.post("/{config_id}/documents")
async def upload_documents(
    config_id: str,
    files: list[UploadFile] = File(...),
    tenant_slug: str | None = Header(default=None, alias="X-Aperture-Tenant"),
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
    usage_orchestrator: TenantUsageBudgetOrchestrator = Depends(get_usage_budget_orchestrator),
) -> KnowledgeSyncResponse:
    config = _get_operable_config(config_id, actor, store)
    synced_at = _sync_time()
    new_documents: list[KnowledgeDocument] = []
    new_chunks: list[KnowledgeChunk] = []
    notes: list[str] = []
    uploaded_bytes = 0
    settings = get_settings()
    usage_context: UsageBudgetRequestContext | None = None
    try:
        for file in files:
            filename = _safe_source_name(file.filename, fallback="uploaded-source")
            file_bytes = await validate_upload_within_limit(
                file,
                settings.knowledge_upload_max_bytes,
                detail=(
                    f"'{filename}' exceeds the {settings.knowledge_upload_max_mb} MB "
                    "knowledge upload limit."
                ),
            )
            uploaded_bytes += file_bytes
            if is_media_upload(filename, file.content_type):
                content = await file.read()
                if usage_context is None:
                    usage_context = _begin_knowledge_media_usage(
                        usage_orchestrator,
                        actor=actor,
                        store=store,
                        tenant_id=config.tenant_id,
                        tenant_slug=tenant_slug,
                    )
                result = await run_in_threadpool(
                    _transcribe_knowledge_media,
                    content,
                    filename,
                    file.content_type,
                    store,
                    config.tenant_id,
                    usage_context,
                )
                segments = [ExtractedSegment(text=result.text, locator="transcript")]
                truncated = False
            else:
                segments, truncated = await run_in_threadpool(
                    _extract_upload_segments,
                    filename,
                    file.file,
                    file.content_type,
                    settings.knowledge_max_extracted_chars,
                )
            # Chunking a multi-million-character file is CPU work; keep it off
            # the event loop so other requests are served meanwhile.
            document, chunks = await run_in_threadpool(
                _document_from_segments,
                config,
                name=filename,
                source_type="upload",
                source_uri=f"upload://knowledge/{config.id}/{uuid4()}-{filename}",
                segments=segments,
                synced_at=synced_at,
            )
            if document.status == "metadata-only":
                notes.append(
                    f"No readable text was found in {filename}, so only its name is searchable."
                )
            elif truncated:
                notes.append(
                    f"Only the first {settings.knowledge_max_extracted_chars:,} characters of "
                    f"{filename} were indexed."
                )
            new_documents.append(document)
            new_chunks.extend(chunks)
        if usage_context is not None:
            _close_knowledge_media_usage(usage_context)
    except MediaTranscriptionError as exc:
        if usage_context is not None:
            _fail_knowledge_media_usage(usage_context)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except UsageBudgetError as exc:
        if usage_context is not None:
            _fail_knowledge_media_usage(usage_context)
        failure = map_usage_budget_error(exc)
        raise HTTPException(
            status_code=failure.status_code,
            detail=failure.detail,
            headers=dict(failure.headers),
        ) from exc
    except Exception:
        if usage_context is not None:
            _fail_knowledge_media_usage(usage_context)
        raise
    readable = [document for document in new_documents if document.status != "metadata-only"]
    passages = sum(document.chunk_count for document in readable)
    provider_message = " ".join(
        [
            f"Indexed {len(readable)} of {len(new_documents)} uploaded "
            f"file{'' if len(new_documents) == 1 else 's'} "
            f"({passages:,} passage{'' if passages == 1 else 's'}).",
            *notes,
        ]
    )
    config, documents, synced_at = await run_in_threadpool(
        _append_indexed_sources,
        store,
        config,
        new_documents,
        new_chunks,
        synced_at=synced_at,
        provider_status="live",
        provider_message=provider_message,
    )
    await run_in_threadpool(
        store.record_audit,
        actor,
        "knowledge.documents_uploaded",
        config.id,
        {
            "document_count": len(new_documents),
            "chunk_count": len(new_chunks),
            "source_type": config.source_type,
            "uploaded_bytes": uploaded_bytes,
        },
    )
    return KnowledgeSyncResponse(
        config=config,
        documents=documents,
        status="synced",
        synced_at=synced_at,
        provider_status="live",
        provider_message=provider_message,
    )


@router.delete("/{config_id}/documents/{document_id}")
def delete_document(
    config_id: str,
    document_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeSyncResponse:
    config = _get_operable_config(config_id, actor, store)
    synced_at = _sync_time()
    # Forget any refresh recipe (and stored API credential) for this document
    # so Sync never re-creates content that was deliberately removed.
    sources = _linked_sources(config)
    removed_sources = [source for source in sources if source.get("document_id") == document_id]
    if removed_sources:
        _save_linked_sources(
            config, [source for source in sources if source.get("document_id") != document_id]
        )
        for source in removed_sources:
            if source.get("secret_ref"):
                store.delete_configuration_secret("knowledge-api-source", str(source["secret_ref"]))
    result = store.delete_knowledge_document(config, document_id, synced_at=synced_at)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown knowledge document."
        )
    config, documents, synced_at = result
    provider_message = config.settings.get(
        "provider_message", "Document deleted from the knowledge index."
    )
    store.record_audit(
        actor,
        "knowledge.document_deleted",
        config.id,
        {
            "document_id": document_id,
            "document_count": len(documents),
            "source_type": config.source_type,
        },
    )
    return KnowledgeSyncResponse(
        config=config,
        documents=documents,
        status="synced",
        synced_at=synced_at,
        provider_status="live",
        provider_message=provider_message,
    )


@router.post("/{config_id}/web-sources")
def add_web_source(
    config_id: str,
    payload: KnowledgeWebSourceCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeSyncResponse:
    config = _get_operable_config(config_id, actor, store)
    synced_at = _sync_time()
    url = payload.url.strip()
    if not url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Web source URL is required."
        )
    name = payload.name.strip() or url
    manual_text = (payload.text or "").strip()
    if manual_text:
        text = manual_text
        provider_message = (
            f"Indexed the text you provided for {url}; the page itself was not fetched."
        )
    else:
        # Fetch failures raise an HTTP error so no fake "indexed" document is created.
        text, provider_message = _fetch_web_source(url)
    document, chunks = _document_from_text(
        config,
        name=name,
        source_type="web",
        source_uri=url,
        text=text,
        synced_at=synced_at,
    )
    _save_linked_sources(
        config,
        [
            *_linked_sources(config),
            {
                "document_id": document.id,
                "kind": "web",
                "name": name,
                "url": url,
                # Pasted text has no live page behind it, so Sync leaves it alone.
                "refresh": not manual_text,
            },
        ],
    )
    config, documents, synced_at = _append_indexed_sources(
        store,
        config,
        [document],
        chunks,
        synced_at=synced_at,
        provider_status="live",
        provider_message=provider_message,
    )
    store.record_audit(
        actor,
        "knowledge.web_source_added",
        config.id,
        {"url": url, "chunk_count": len(chunks), "fetched": not manual_text},
    )
    return KnowledgeSyncResponse(
        config=config,
        documents=documents,
        status=knowledge_sync_status("live"),
        synced_at=synced_at,
        provider_status="live",
        provider_message=provider_message,
    )


@router.post("/{config_id}/api-sources")
def add_api_source(
    config_id: str,
    payload: KnowledgeApiSourceCreateRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeSyncResponse:
    """Register an API source and index its current response.

    Nothing is indexed unless the request succeeds, so a wrong URL or
    credential fails here instead of producing a document that only describes
    the connection. OAuth sources are saved and wait for the provider sign-in;
    the OAuth callback fetches them once a token is stored.
    """
    config = _get_operable_config(config_id, actor, store)
    base_url = payload.base_url.strip()
    if not base_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="API URL is required."
        )
    auth_type = (payload.auth_type or "none").strip().lower()
    if auth_type not in _API_AUTH_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Authentication must be none, api-key, bearer-token, or oauth-client.",
        )
    method = (payload.method or "GET").strip().upper()
    if method not in {"GET", "POST"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="API sources support GET and POST."
        )
    try:
        headers = parse_header_lines(payload.headers)
    except ApiSourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    secret_value = (payload.secret_value or "").strip() or None
    if auth_type in {"api-key", "bearer-token"} and not secret_value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Enter the API key or token this source should send.",
        )
    name = payload.name.strip() or build_api_url(base_url, payload.path or "")
    document_id = f"doc-api-{uuid4()}"
    source: dict[str, Any] = {
        "document_id": document_id,
        "kind": "api",
        "name": name,
        "base_url": base_url,
        "path": (payload.path or "").strip(),
        "method": method,
        "headers": headers,
        "body": (payload.body or "").strip() or None,
        "auth_type": auth_type,
        "credential_name": (payload.credential_name or "").strip()
        or ("X-API-Key" if auth_type == "api-key" else ""),
        "credential_location": (payload.credential_location or "header").strip().lower(),
        "refresh": True,
    }
    if source["credential_location"] not in {"header", "query"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The API key must be sent as a header or a query parameter.",
        )

    if auth_type == "oauth-client":
        if any(item.get("auth_type") == "oauth-client" for item in _linked_sources(config)):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This knowledge base already has a provider-connected API. Delete it "
                "before connecting a different one.",
            )
        client_id = (payload.client_id or "").strip()
        authorization_url = (payload.authorization_url or "").strip()
        token_url = (payload.token_url or "").strip()
        if not client_id or not authorization_url or not token_url:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="OAuth needs a client ID, authorization URL, and token URL.",
            )
        settings = dict(config.settings)
        settings["api_source_oauth"] = {
            "name": name,
            "client_id": client_id,
            "authorization_url": authorization_url,
            "token_url": token_url,
            "callback_url": _knowledge_oauth_callback_url(config.id),
            "scopes": [scope.strip() for scope in payload.scopes if scope.strip()],
            "audience": (payload.audience or "").strip(),
        }
        config.settings = settings
        if secret_value:
            store.set_configuration_secret(
                "knowledge-api-source", f"{config.id}:oauth-client", secret_value
            )
        source["awaiting_authorization"] = _stored_oauth_token(config, store) is None
        if source["awaiting_authorization"]:
            _save_linked_sources(config, [*_linked_sources(config), source])
            provider_message = (
                f"Saved {name}. Sign in with the provider to finish connecting; the data is "
                "indexed as soon as access is granted."
            )
            store.record_audit(
                actor,
                "knowledge.api_source_added",
                config.id,
                _api_source_audit(source, awaiting_authorization=True),
            )
            config, documents, synced_at = store.record_knowledge_sync(
                config,
                status=str(config.settings.get("status") or "draft"),
                synced_at=str(config.settings.get("last_sync") or "Not synced"),
                provider_status="pending",
                provider_message=provider_message,
            )
            return KnowledgeSyncResponse(
                config=config,
                documents=documents,
                status=str(config.settings.get("status") or "draft"),
                synced_at=synced_at,
                provider_status="pending",
                provider_message=provider_message,
            )

    secret_ref = f"{config.id}:{document_id}" if secret_value and auth_type != "oauth-client" else None
    fetched = _fetch_linked_api_source(config, source, store, secret_override=secret_value)
    synced_at = _sync_time()
    document, chunks = _document_from_text(
        config,
        name=name,
        source_type="api",
        source_uri=fetched.display_url,
        text=fetched.text,
        synced_at=synced_at,
        document_id=document_id,
    )
    if secret_ref:
        store.set_configuration_secret("knowledge-api-source", secret_ref, secret_value or "")
        source["secret_ref"] = secret_ref
    source["awaiting_authorization"] = False
    _save_linked_sources(config, [*_linked_sources(config), source])
    provider_message = _api_fetch_message(name, fetched, len(chunks))
    config, documents, synced_at = _append_indexed_sources(
        store,
        config,
        [document],
        chunks,
        synced_at=synced_at,
        provider_status="live",
        provider_message=provider_message,
    )
    store.record_audit(
        actor,
        "knowledge.api_source_added",
        config.id,
        {**_api_source_audit(source, awaiting_authorization=False), "chunk_count": len(chunks)},
    )
    return KnowledgeSyncResponse(
        config=config,
        documents=documents,
        status=knowledge_sync_status("live"),
        synced_at=synced_at,
        provider_status="live",
        provider_message=provider_message,
    )


def _begin_knowledge_media_usage(
    orchestrator: TenantUsageBudgetOrchestrator,
    *,
    actor: User,
    store: SeedStore,
    tenant_id: str,
    tenant_slug: str | None,
) -> UsageBudgetRequestContext:
    del tenant_slug  # Tenant comes from the knowledge base, not the Host slug.
    try:
        return orchestrator.begin_request(
            actor=actor,
            request_id=new_accounting_id(),
            explicit_tenant_id=tenant_id if actor.role == Role.PLATFORM_OWNER else None,
            resource_tenant_id=tenant_id,
            known_tenant_ids=store.tenants.keys(),
        )
    except UsageTenantScopeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except UsageProviderExecutionRefused as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Usage accounting already owns this request; no new provider "
                "execution is authorized."
            ),
        ) from exc
    except UsageBudgetError as exc:
        failure = map_usage_budget_error(exc)
        raise HTTPException(
            status_code=failure.status_code,
            detail=failure.detail,
            headers=dict(failure.headers),
        ) from exc


def _transcribe_knowledge_media(
    content: bytes,
    filename: str,
    mime_type: str | None,
    store: SeedStore,
    tenant_id: str,
    usage_context: UsageBudgetRequestContext,
):
    return transcribe_media_file(
        content,
        filename,
        mime_type,
        store=store,
        tenant_id=tenant_id,
        usage_context=usage_context,
    )


def _close_knowledge_media_usage(context: UsageBudgetRequestContext) -> None:
    if context.status != "active":
        return
    if context.settled_child_count:
        context.complete_success()
        return
    try:
        context.abandon()
    except UsageBudgetError as exc:
        failure = map_usage_budget_error(exc)
        raise HTTPException(
            status_code=failure.status_code,
            detail=failure.detail,
            headers=dict(failure.headers),
        ) from exc


def _fail_knowledge_media_usage(context: UsageBudgetRequestContext) -> None:
    if context.status != "active":
        return
    try:
        context.fail()
    except UsageBudgetError:
        return


_CONNECTOR_SOURCE_TYPES = frozenset({"box", "microsoft-graph", "google-drive", "imanage"})
_API_AUTH_TYPES = frozenset({"none", "api-key", "bearer-token", "oauth-client"})
_LINKED_SOURCES_KEY = "linked_sources"


def _linked_sources(config: KnowledgeConfig) -> list[dict[str, Any]]:
    """Refresh recipes for web pages and API sources, keyed by document id."""
    raw = config.settings.get(_LINKED_SOURCES_KEY)
    if not isinstance(raw, list):
        return []
    return [dict(item) for item in raw if isinstance(item, dict)]


def _save_linked_sources(config: KnowledgeConfig, sources: list[dict[str, Any]]) -> None:
    settings = dict(config.settings)
    settings[_LINKED_SOURCES_KEY] = sources
    config.settings = settings


def _extract_upload_segments(
    filename: str,
    file: Any,
    content_type: str | None,
    max_chars: int,
) -> tuple[list[ExtractedSegment], bool]:
    """Extract an upload and report whether it was cut at the character limit.

    Extraction asks for one character more than the limit, so a document that
    is exactly at the limit is never reported as truncated.
    """
    settings = get_settings()
    segments = extract_segments_from_file(
        filename,
        file,
        content_type,
        max_chars=max_chars + 1,
        ocr_enabled=settings.knowledge_ocr_enabled,
        ocr_max_pages=settings.knowledge_ocr_max_pages,
        ocr_page_timeout_seconds=settings.knowledge_ocr_page_timeout_seconds,
    )
    joined_length = sum(len(segment.text) for segment in segments) + 2 * max(0, len(segments) - 1)
    if joined_length <= max_chars:
        return segments, False
    return limit_extracted_segments(segments, max_chars=max_chars), True


def _refresh_linked_sources(
    config: KnowledgeConfig,
    actor: User,
    store: SeedStore,
    *,
    force: bool,
) -> KnowledgeSyncResponse:
    """Re-fetch web pages and API sources; uploaded files are never touched.

    Uploads are indexed when they are added, so a knowledge base made only of
    uploads has nothing to sync and keeps its status. Each linked source is
    refreshed in place; a failed refresh keeps that source's previous content.
    """
    sources = _linked_sources(config)
    refreshable = [
        source
        for source in sources
        if source.get("refresh")
        and (source.get("kind") == "web" or source.get("kind") == "api")
        and not source.get("awaiting_authorization")
    ]
    waiting = [source for source in sources if source.get("awaiting_authorization")]
    if not refreshable:
        message = (
            "Waiting for the provider sign-in before this API can be fetched."
            if waiting
            else "Nothing to sync. Uploaded files and pasted text are indexed when you add "
            "them; add a web page or API to keep content refreshed automatically."
        )
        store.record_audit(
            actor,
            "knowledge.config_synced",
            config.id,
            {"refreshed": 0, "failed": 0, "force": force, "source_type": config.source_type},
            runtime_state_changed=False,
        )
        return KnowledgeSyncResponse(
            config=config,
            documents=store.knowledge_documents_for(config.id),
            status=str(config.settings.get("status") or "draft"),
            synced_at=str(config.settings.get("last_sync") or "Not synced"),
            provider_status="unchanged",
            provider_message=message,
        )

    synced_at = _sync_time()
    documents_by_id = {document.id: document for document in store.knowledge_documents_for(config.id)}
    refreshed = 0
    failures: list[str] = []
    for source in refreshable:
        name = str(source.get("name") or source.get("url") or source.get("base_url") or "source")
        try:
            if source.get("kind") == "web":
                text, _message = _fetch_web_source(str(source.get("url") or ""))
                source_uri = str(source.get("url") or "")
            else:
                fetched = _fetch_linked_api_source(config, source, store)
                text, source_uri = fetched.text, fetched.display_url
        except HTTPException as exc:
            failures.append(f"{name}: {exc.detail}")
            continue
        existing = documents_by_id.get(str(source.get("document_id") or ""))
        document, chunks = _document_from_text(
            config,
            name=existing.name if existing else name,
            source_type=str(source.get("kind")),
            source_uri=source_uri,
            text=text,
            synced_at=synced_at,
            document_id=str(source.get("document_id") or "") or None,
        )
        if not source.get("document_id"):
            source["document_id"] = document.id
        store.replace_knowledge_document(config, document, chunks)
        refreshed += 1
    _save_linked_sources(config, sources)
    if failures:
        status_value = "error"
        provider_status = "error"
        message = (
            f"Refreshed {refreshed} of {len(refreshable)} linked sources. "
            "Could not refresh " + "; ".join(failures) + ". Their previous content is kept."
        )
    else:
        status_value = "synced"
        provider_status = "live"
        message = f"Refreshed {refreshed} linked source{'' if refreshed == 1 else 's'}."
    config, documents, synced_at = store.record_knowledge_sync(
        config,
        status=status_value,
        synced_at=synced_at,
        provider_status=provider_status,
        provider_message=message,
    )
    store.record_audit(
        actor,
        "knowledge.config_synced",
        config.id,
        {
            "refreshed": refreshed,
            "failed": len(failures),
            "force": force,
            "provider_status": provider_status,
            "source_type": config.source_type,
        },
    )
    return KnowledgeSyncResponse(
        config=config,
        documents=documents,
        status=status_value,
        synced_at=synced_at,
        provider_status=provider_status,
        provider_message=message,
    )


def _fetch_linked_api_source(
    config: KnowledgeConfig,
    source: dict[str, Any],
    store: SeedStore,
    *,
    secret_override: str | None = None,
) -> FetchedApiSource:
    """Run one API source request with its stored credential, or raise HTTP errors."""
    auth_type = str(source.get("auth_type") or "none")
    credential_header: tuple[str, str] | None = None
    credential_query: tuple[str, str] | None = None
    token_payload: dict[str, Any] | None = None
    if auth_type in {"api-key", "bearer-token"}:
        secret = secret_override
        if secret is None and source.get("secret_ref"):
            secret = store.configuration_secret("knowledge-api-source", str(source["secret_ref"]))
        if not secret:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The stored credential for this API source is missing; add the source again.",
            )
        if auth_type == "bearer-token":
            credential_header = ("Authorization", f"Bearer {secret}")
        else:
            credential_name = str(source.get("credential_name") or "X-API-Key")
            if source.get("credential_location") == "query":
                credential_query = (credential_name, secret)
            else:
                credential_header = (credential_name, secret)
    elif auth_type == "oauth-client":
        token_payload = _stored_oauth_token(config, store)
        if token_payload is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Sign in with the provider before this API source can be fetched.",
            )
        credential_header = ("Authorization", f"Bearer {token_payload['access_token']}")

    def run(header: tuple[str, str] | None) -> FetchedApiSource:
        return fetch_api_source(
            ApiSourceRequest(
                base_url=str(source.get("base_url") or ""),
                path=str(source.get("path") or ""),
                method=str(source.get("method") or "GET"),
                headers={str(key): str(value) for key, value in dict(source.get("headers") or {}).items()},
                body=source.get("body") or None,
                credential_header=header,
                credential_query=credential_query,
            )
        )

    try:
        return run(credential_header)
    except ApiSourceError as exc:
        # Expired OAuth access tokens are refreshed once when the provider
        # issued a refresh token; any other failure is reported as-is.
        if token_payload is not None and " 401" in exc.detail and token_payload.get("refresh_token"):
            refreshed = _refresh_api_source_oauth_token(config, store, token_payload)
            if refreshed is not None:
                try:
                    return run(("Authorization", f"Bearer {refreshed['access_token']}"))
                except ApiSourceError as retry_exc:
                    raise HTTPException(status_code=retry_exc.status_code, detail=retry_exc.detail) from retry_exc
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _api_fetch_message(name: str, fetched: FetchedApiSource, chunk_count: int) -> str:
    size_kb = max(1, fetched.byte_count // 1024)
    message = (
        f"Fetched {name} ({size_kb:,} KB) and indexed {chunk_count:,} "
        f"passage{'' if chunk_count == 1 else 's'}."
    )
    if fetched.truncated:
        message += " The response was longer than the indexing limit, so only the start was kept."
    return message


def _api_source_audit(source: dict[str, Any], *, awaiting_authorization: bool) -> dict[str, Any]:
    return {
        "base_url": source.get("base_url"),
        "path": source.get("path"),
        "method": source.get("method"),
        "auth_type": source.get("auth_type"),
        "credential_location": source.get("credential_location"),
        "header_names": sorted(dict(source.get("headers") or {})),
        "awaiting_authorization": awaiting_authorization,
        "secret_value": "[redacted]",
    }


def _stored_oauth_token(config: KnowledgeConfig, store: SeedStore) -> dict[str, Any] | None:
    raw = store.configuration_secret("knowledge-oauth-token", config.id)
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(payload, dict) or not str(payload.get("access_token") or "").strip():
        return None
    return payload


def _refresh_api_source_oauth_token(
    config: KnowledgeConfig,
    store: SeedStore,
    token_payload: dict[str, Any],
) -> dict[str, Any] | None:
    oauth_settings = _api_source_oauth_settings(config)
    token_url = _api_source_oauth_token_url(config)
    client_id = str(oauth_settings.get("client_id") or "").strip()
    if not token_url or not client_id:
        return None
    try:
        validate_public_url(token_url)
    except EgressBlocked:
        return None
    data = {
        "grant_type": "refresh_token",
        "refresh_token": str(token_payload.get("refresh_token")),
        "client_id": client_id,
    }
    client_secret = store.configuration_secret("knowledge-api-source", f"{config.id}:oauth-client")
    if client_secret:
        data["client_secret"] = client_secret
    try:
        with httpx.Client(timeout=15.0) as oauth_client:
            response = oauth_client.post(token_url, data=data, headers={"Accept": "application/json"})
        refreshed = response.json() if response.status_code < 400 else None
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(refreshed, dict) or not str(refreshed.get("access_token") or "").strip():
        return None
    refreshed.setdefault("refresh_token", token_payload.get("refresh_token"))
    store.set_configuration_secret("knowledge-oauth-token", config.id, json.dumps(refreshed))
    return refreshed


def _knowledge_oauth_callback_url(config_id: str) -> str:
    return f"{get_settings().api_base_url.rstrip('/')}/api/knowledge/{config_id}/oauth/callback"


def _get_readable_config(config_id: str, actor: User, store: SeedStore) -> KnowledgeConfig:
    config = store.knowledge_configs.get(config_id)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown knowledge configuration."
        )
    assert_knowledge_access(actor, config)
    return config


def _get_viewable_config(config_id: str, actor: User, store: SeedStore) -> KnowledgeConfig:
    """People who manage a knowledge base can inspect it even while it is off.

    Turning a base off stops assistants from searching it; its administrators
    and owner still need to see what it contains. Everyone else goes through
    the normal read check, which also requires the base to be on.
    """
    try:
        return _get_operable_config(config_id, actor, store)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            raise
    assert_group_permission(actor, store.groups, "knowledge_access", "Knowledge access")
    return _get_readable_config(config_id, actor, store)


def _get_operable_config(config_id: str, actor: User, store: SeedStore) -> KnowledgeConfig:
    """Admins operate any tenant knowledge base; a granted user operates their own.

    "Operate" covers ingestion and maintenance (sync, uploads, sources,
    document deletes). A non-admin needs the tenant's knowledge_authoring
    grant and must own the config, so revoking the grant also freezes
    previously created knowledge bases without deleting them.
    """
    config = store.knowledge_configs.get(config_id)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown knowledge configuration."
        )
    if actor.role == Role.PLATFORM_OWNER:
        return config
    if actor.tenant_id != config.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Knowledge access is restricted by tenant, group, or source ACL policy.",
        )
    if is_tenant_admin(actor):
        return config
    if config.owner_user_id == actor.id and knowledge_authoring_allowed(actor, store.groups):
        return config
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Only administrators or the knowledge base owner can manage its content.",
    )


def _provider_sync_documents(
    config: KnowledgeConfig,
    store: SeedStore,
) -> tuple[list[KnowledgeDocument] | None, list[KnowledgeChunk] | None, str, str | None]:
    if config.source_type == "box":
        return _sync_box_documents(config, store)
    if config.source_type == "microsoft-graph":
        return _sync_microsoft_graph_documents(config, store)
    if config.source_type == "google-drive":
        return _sync_google_drive_documents(config, store)
    if config.source_type == "imanage":
        return _sync_imanage_documents(config, store)
    return None, None, "cached", "No live adapter is configured for this source type yet."


def _sync_box_documents(
    config: KnowledgeConfig,
    store: SeedStore,
) -> tuple[list[KnowledgeDocument] | None, list[KnowledgeChunk] | None, str, str | None]:
    connector_config = _connector_config(config, store, expected_connector_id="box")
    if connector_config is None:
        return None, None, "cached", _connector_config_message(config, store, "box", "Box")
    folder_id = _box_folder_id(connector_config)
    if folder_id is None:
        return None, None, "cached", "Box folder_id is not configured for this knowledge base."
    access_token, token_message = _connector_access_token(connector_config, store)
    if access_token is None:
        return None, None, "cached", token_message

    try:
        client = get_box_client(access_token)
        items = client.list_folder_items(folder_id=folder_id)
    except BoxError as exc:
        return None, None, "error", f"Box sync failed ({exc}); using cached indexed inventory."

    documents: list[KnowledgeDocument] = []
    chunks: list[KnowledgeChunk] = []
    downloaded = 0
    metadata_only = 0
    for item in items:
        if item.type != "file":
            continue
        document, document_chunks, used_file_text = _box_document_and_chunks(config, item, client)
        documents.append(document)
        chunks.extend(document_chunks)
        if used_file_text:
            downloaded += 1
        else:
            metadata_only += 1
    chunk_count = len(chunks)
    return (
        documents,
        chunks,
        "live",
        (
            f"Box returned {len(documents)} file records from folder {folder_id}; "
            f"indexed {chunk_count} text chunks from {downloaded} files"
            f"{f' and kept {metadata_only} metadata-only records' if metadata_only else ''}."
        ),
    )


def _sync_microsoft_graph_documents(
    config: KnowledgeConfig,
    store: SeedStore,
) -> tuple[list[KnowledgeDocument] | None, list[KnowledgeChunk] | None, str, str | None]:
    connector_config = _connector_config(config, store, expected_connector_id="microsoft-graph")
    if connector_config is None:
        return (
            None,
            None,
            "cached",
            _connector_config_message(config, store, "microsoft-graph", "Microsoft Graph"),
        )
    root_id = _source_root_id(
        connector_config,
        "drive_item_id",
        "source_root_id",
        "root_folder_id",
        "folder_id",
    )
    if root_id is None:
        return (
            None,
            None,
            "cached",
            "Microsoft Graph drive_item_id is not configured for this knowledge base.",
        )
    access_token, token_message = _connector_access_token(connector_config, store)
    if access_token is None:
        return None, None, "cached", token_message

    drive_id = _source_root_id(connector_config, "drive_id")
    site_id = _source_root_id(connector_config, "site_id")
    try:
        client = get_microsoft_graph_client(access_token)
        items = client.list_drive_items(item_id=root_id, drive_id=drive_id, site_id=site_id)
    except CloudSourceError as exc:
        return (
            None,
            None,
            "error",
            f"Microsoft Graph sync failed ({exc}); using cached indexed inventory.",
        )

    download_kwargs: dict[str, object] = {"drive_id": drive_id}
    if site_id:
        # Site-rooted drives cannot fall back to /me with app-only tokens.
        download_kwargs["site_id"] = site_id
    documents, chunks, downloaded, metadata_only = _cloud_documents_and_chunks(
        config,
        items,
        client,
        download_kwargs=download_kwargs,
    )
    return _cloud_sync_result(
        provider_name="Microsoft Graph",
        source_label=root_id,
        documents=documents,
        chunks=chunks,
        downloaded=downloaded,
        metadata_only=metadata_only,
    )


def _sync_google_drive_documents(
    config: KnowledgeConfig,
    store: SeedStore,
) -> tuple[list[KnowledgeDocument] | None, list[KnowledgeChunk] | None, str, str | None]:
    connector_config = _connector_config(config, store, expected_connector_id="google-drive")
    if connector_config is None:
        return (
            None,
            None,
            "cached",
            _connector_config_message(config, store, "google-drive", "Google Drive"),
        )
    folder_id = _source_root_id(
        connector_config,
        "folder_id",
        "drive_folder_id",
        "source_root_id",
        "root_folder_id",
    )
    if folder_id is None:
        return (
            None,
            None,
            "cached",
            "Google Drive folder_id is not configured for this knowledge base.",
        )
    access_token, token_message = _connector_access_token(connector_config, store)
    if access_token is None:
        return None, None, "cached", token_message

    try:
        client = get_google_drive_client(access_token)
        items = client.list_files(folder_id=folder_id)
    except CloudSourceError as exc:
        return (
            None,
            None,
            "error",
            f"Google Drive sync failed ({exc}); using cached indexed inventory.",
        )

    documents, chunks, downloaded, metadata_only = _cloud_documents_and_chunks(
        config, items, client
    )
    return _cloud_sync_result(
        provider_name="Google Drive",
        source_label=folder_id,
        documents=documents,
        chunks=chunks,
        downloaded=downloaded,
        metadata_only=metadata_only,
    )


def _sync_imanage_documents(
    config: KnowledgeConfig,
    store: SeedStore,
) -> tuple[list[KnowledgeDocument] | None, list[KnowledgeChunk] | None, str, str | None]:
    connector_config = _connector_config(config, store, expected_connector_id="imanage")
    if connector_config is None:
        return None, None, "cached", _connector_config_message(config, store, "imanage", "iManage")
    workspace_id = _source_root_id(
        connector_config, "workspace_id", "source_root_id", "root_folder_id"
    )
    if workspace_id is None:
        return (
            None,
            None,
            "cached",
            "iManage workspace_id is not configured for this knowledge base.",
        )
    base_url = _source_root_id(connector_config, "base_url")
    if base_url is None:
        return None, None, "cached", "iManage base_url is not configured for this knowledge base."
    access_token, token_message = _connector_access_token(connector_config, store)
    if access_token is None:
        return None, None, "cached", token_message

    try:
        client = get_imanage_client(access_token, base_url)
        items = client.list_documents(
            workspace_id=workspace_id,
            documents_endpoint=_source_root_id(connector_config, "documents_endpoint"),
            customer_id=_source_root_id(connector_config, "customer_id"),
            library_id=_source_root_id(connector_config, "library_id"),
        )
    except CloudSourceError as exc:
        return None, None, "error", f"iManage sync failed ({exc}); using cached indexed inventory."

    documents, chunks, downloaded, metadata_only = _cloud_documents_and_chunks(
        config, items, client
    )
    return _cloud_sync_result(
        provider_name="iManage",
        source_label=workspace_id,
        documents=documents,
        chunks=chunks,
        downloaded=downloaded,
        metadata_only=metadata_only,
    )


def _connector_config(
    config: KnowledgeConfig,
    store: SeedStore,
    *,
    expected_connector_id: str,
) -> ConnectorConfig | None:
    if not config.connector_config_id:
        return None
    connector_config = store.connector_configs.get(config.connector_config_id)
    if (
        connector_config is None
        or not connector_config.enabled
        or connector_config.connector_id != expected_connector_id
    ):
        return None
    return connector_config


def _connector_config_message(
    config: KnowledgeConfig,
    store: SeedStore,
    expected_connector_id: str,
    provider_name: str,
) -> str:
    if not config.connector_config_id:
        return f"{provider_name} connector configuration is missing."
    connector_config = store.connector_configs.get(config.connector_config_id)
    if connector_config is None:
        return f"{provider_name} connector configuration is missing."
    if connector_config.connector_id != expected_connector_id:
        return (
            f"{provider_name} connector configuration is linked to '{connector_config.connector_id}' "
            f"instead of '{expected_connector_id}'."
        )
    if not connector_config.enabled:
        return f"{provider_name} connector configuration is disabled."
    return f"{provider_name} connector configuration is missing."


def _box_folder_id(connector_config: ConnectorConfig) -> str | None:
    raw = connector_config.settings.get("folder_id") or connector_config.settings.get(
        "root_folder_id"
    )
    if raw is None:
        return None
    folder_id = str(raw).strip()
    return folder_id or None


def _source_root_id(connector_config: ConnectorConfig, *keys: str) -> str | None:
    for key in keys:
        raw = connector_config.settings.get(key)
        if raw is None:
            continue
        value = str(raw).strip()
        if value:
            return value
    return None


def _connector_access_token(
    connector_config: ConnectorConfig,
    store: SeedStore,
) -> tuple[str | None, str | None]:
    """Acquire a real provider token; on failure return its honest message instead."""
    result = acquire_connector_token(store, connector_config)
    return result.access_token, result.message


def _cloud_documents_and_chunks(
    config: KnowledgeConfig,
    items: list[CloudSourceItem],
    client: object,
    *,
    download_kwargs: dict[str, object] | None = None,
) -> tuple[list[KnowledgeDocument], list[KnowledgeChunk], int, int]:
    documents: list[KnowledgeDocument] = []
    chunks: list[KnowledgeChunk] = []
    downloaded = 0
    metadata_only = 0
    for item in items:
        if item.type != "file":
            continue
        document, document_chunks, used_file_text = _cloud_document_and_chunks(
            config,
            item,
            client,
            download_kwargs=download_kwargs or {},
        )
        documents.append(document)
        chunks.extend(document_chunks)
        if used_file_text:
            downloaded += 1
        else:
            metadata_only += 1
    return documents, chunks, downloaded, metadata_only


def _cloud_sync_result(
    *,
    provider_name: str,
    source_label: str,
    documents: list[KnowledgeDocument],
    chunks: list[KnowledgeChunk],
    downloaded: int,
    metadata_only: int,
) -> tuple[list[KnowledgeDocument], list[KnowledgeChunk], str, str]:
    chunk_count = len(chunks)
    return (
        documents,
        chunks,
        "live",
        (
            f"{provider_name} returned {len(documents)} file records from {source_label}; "
            f"indexed {chunk_count} text chunks from {downloaded} files"
            f"{f' and kept {metadata_only} metadata-only records' if metadata_only else ''}."
        ),
    )


def _cloud_document(config: KnowledgeConfig, item: CloudSourceItem) -> KnowledgeDocument:
    status_value = (
        "indexed" if item.item_status in {None, "active", "indexed"} else str(item.item_status)
    )
    return KnowledgeDocument(
        id=f"doc-{item.source_type}-{_safe_id_fragment(item.id)}",
        knowledge_config_id=config.id,
        tenant_id=config.tenant_id,
        name=item.name,
        source_uri=item.source_uri,
        source_type=item.source_type,
        status=status_value,
        chunk_count=_estimated_chunks(item.size),
        acl_group_ids=list(config.acl_group_ids),
        updated_at=item.modified_at or "Synced now",
        citation_required=bool(config.settings.get("citation_required", True)),
    )


def _cloud_document_and_chunks(
    config: KnowledgeConfig,
    item: CloudSourceItem,
    client: object,
    *,
    download_kwargs: dict[str, object],
) -> tuple[KnowledgeDocument, list[KnowledgeChunk], bool]:
    document = _cloud_document(config, item)
    try:
        content = _download_cloud_file(client, item, download_kwargs=download_kwargs)
    except (AttributeError, CloudSourceError):
        chunks = [_inventory_chunk(config, document, 0)]
        document.chunk_count = len(chunks)
        document.status = "metadata-only"
        return document, chunks, False

    segments = extract_segments(
        item.name, content, mime_type=_extraction_mime_type(item), **_extraction_settings()
    )
    chunks = _knowledge_chunks_from_segments(document, segments)
    if not chunks:
        chunks = [_inventory_chunk(config, document, 0)]
        document.chunk_count = len(chunks)
        document.status = "metadata-only"
        return document, chunks, False

    document.chunk_count = len(chunks)
    document.status = "indexed"
    return document, chunks, True


def _download_cloud_file(
    client: object, item: CloudSourceItem, *, download_kwargs: dict[str, object]
) -> bytes:
    if item.download_url:
        download_from_url = getattr(client, "download_from_url", None)
        if callable(download_from_url):
            # Pre-authenticated Graph download URL; works for site-rooted drives
            # where the id-based /me fallback would not.
            return download_from_url(item.download_url)
    try:
        return client.download_file(file_id=item.id, mime_type=item.mime_type, **download_kwargs)
    except TypeError:
        return client.download_file(file_id=item.id, **download_kwargs)


def _extraction_mime_type(item: CloudSourceItem) -> str | None:
    if (
        item.source_type == "google-drive"
        and item.mime_type
        and item.mime_type.startswith("application/vnd.google-apps.")
    ):
        return "text/plain"
    return item.mime_type


def _safe_id_fragment(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-") or "source"


def _box_document(config: KnowledgeConfig, item: BoxItem) -> KnowledgeDocument:
    return KnowledgeDocument(
        id=f"doc-box-{item.id}",
        knowledge_config_id=config.id,
        tenant_id=config.tenant_id,
        name=item.name,
        source_uri=f"box://files/{item.id}",
        source_type="box",
        status="indexed" if item.item_status in {None, "active"} else str(item.item_status),
        chunk_count=_estimated_chunks(item.size),
        acl_group_ids=list(config.acl_group_ids),
        updated_at=item.modified_at or "Synced now",
        citation_required=bool(config.settings.get("citation_required", True)),
    )


def _extraction_settings() -> dict[str, Any]:
    settings = get_settings()
    return {
        "max_chars": settings.knowledge_max_extracted_chars,
        "ocr_enabled": settings.knowledge_ocr_enabled,
        "ocr_max_pages": settings.knowledge_ocr_max_pages,
        "ocr_page_timeout_seconds": settings.knowledge_ocr_page_timeout_seconds,
    }


def _estimated_chunks(size: int | None) -> int:
    if size is None or size <= 0:
        return 0
    return max(1, min(999, (size + 3999) // 4000))


def _box_document_and_chunks(
    config: KnowledgeConfig,
    item: BoxItem,
    client: object,
) -> tuple[KnowledgeDocument, list[KnowledgeChunk], bool]:
    document = _box_document(config, item)
    try:
        content = client.download_file(file_id=item.id)
    except (AttributeError, BoxError):
        chunks = [_inventory_chunk(config, document, 0)]
        document.chunk_count = len(chunks)
        document.status = "metadata-only"
        return document, chunks, False

    segments = extract_segments(item.name, content, **_extraction_settings())
    chunks = _knowledge_chunks_from_segments(document, segments)
    if not chunks:
        chunks = [_inventory_chunk(config, document, 0)]
        document.chunk_count = len(chunks)
        document.status = "metadata-only"
        return document, chunks, False

    document.chunk_count = len(chunks)
    document.status = "indexed"
    return document, chunks, True


def _inventory_chunk(
    config: KnowledgeConfig, document: KnowledgeDocument, ordinal: int
) -> KnowledgeChunk:
    return KnowledgeChunk(
        id=f"chunk-{document.id}-inventory",
        knowledge_config_id=config.id,
        document_id=document.id,
        tenant_id=document.tenant_id,
        source_name=document.name,
        source_uri=document.source_uri,
        source_type=document.source_type,
        text=(
            f"{config.name} indexed source inventory: {document.name} is available from "
            f"{document.source_type} at {document.source_uri}. Full file-text extraction is not available yet; "
            f"this source currently contributes document metadata and citation provenance."
        ),
        ordinal=ordinal,
        acl_group_ids=document.acl_group_ids,
        updated_at=document.updated_at,
    )


def _document_from_text(
    config: KnowledgeConfig,
    *,
    name: str,
    source_type: str,
    source_uri: str,
    text: str | None,
    synced_at: str,
    document_id: str | None = None,
) -> tuple[KnowledgeDocument, list[KnowledgeChunk]]:
    segments = [ExtractedSegment(text=text)] if text else []
    return _document_from_segments(
        config,
        name=name,
        source_type=source_type,
        source_uri=source_uri,
        segments=segments,
        synced_at=synced_at,
        document_id=document_id,
    )


def _document_from_segments(
    config: KnowledgeConfig,
    *,
    name: str,
    source_type: str,
    source_uri: str,
    segments: list[ExtractedSegment],
    synced_at: str,
    document_id: str | None = None,
) -> tuple[KnowledgeDocument, list[KnowledgeChunk]]:
    document = KnowledgeDocument(
        id=document_id or f"doc-{source_type}-{uuid4()}",
        knowledge_config_id=config.id,
        tenant_id=config.tenant_id,
        name=name,
        source_uri=source_uri,
        source_type=source_type,
        status="indexed",
        chunk_count=0,
        acl_group_ids=list(config.acl_group_ids),
        updated_at=synced_at,
        citation_required=bool(config.settings.get("citation_required", True)),
    )
    chunks = _knowledge_chunks_from_segments(document, segments)
    if not chunks:
        document.status = "metadata-only"
        chunks = _knowledge_chunks_from_segments(
            document,
            [
                ExtractedSegment(
                    text=(
                        f"{config.name} source inventory: {name} is available from "
                        f"{source_type} at {source_uri}. Full file-text extraction "
                        "was unavailable, so no location provenance was inferred."
                    )
                )
            ],
        )
    document.chunk_count = len(chunks)
    return document, chunks


def _knowledge_chunks_from_segments(
    document: KnowledgeDocument,
    segments: list[ExtractedSegment],
) -> list[KnowledgeChunk]:
    return [
        KnowledgeChunk(
            id=f"chunk-{document.id}-{index + 1}",
            knowledge_config_id=document.knowledge_config_id,
            document_id=document.id,
            tenant_id=document.tenant_id,
            source_name=document.name,
            source_uri=document.source_uri,
            source_type=document.source_type,
            text=segment.text,
            ordinal=index,
            page_start=segment.page_start,
            page_end=segment.page_end,
            locator=segment.locator,
            acl_group_ids=document.acl_group_ids,
            updated_at=document.updated_at,
        )
        for index, segment in enumerate(chunk_segments(segments))
    ]


def _append_indexed_sources(
    store: SeedStore,
    config: KnowledgeConfig,
    documents: list[KnowledgeDocument],
    chunks: list[KnowledgeChunk],
    *,
    synced_at: str,
    provider_status: str,
    provider_message: str,
) -> tuple[KnowledgeConfig, list[KnowledgeDocument], str]:
    return store.append_knowledge_sources(
        config,
        documents,
        chunks,
        synced_at=synced_at,
        provider_status=provider_status,
        provider_message=provider_message,
    )


def _safe_source_name(filename: str | None, *, fallback: str) -> str:
    if not filename:
        return fallback
    clean = filename.replace("\\", "/").split("/")[-1].replace("\x00", "").strip()
    return clean or fallback


def _fetch_web_source(url: str) -> tuple[str, str]:
    """Fetch a web source and extract indexable text, or raise an honest error."""
    try:
        fetched = fetch_web_source(
            url,
            user_agent="ApertureChat-KnowledgeIndexer/0.1",
        )
    except WebFetchError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    text = fetched.text
    return text, f"Fetched {url} and indexed {len(text)} extracted characters."


def _api_source_oauth_settings(config: KnowledgeConfig) -> dict[str, Any]:
    raw = config.settings.get("api_source_oauth")
    return raw if isinstance(raw, dict) else {}


def _api_source_oauth_token_url(config: KnowledgeConfig) -> str:
    return str(_api_source_oauth_settings(config).get("token_url") or "").strip()


def _callback_url(request: Request) -> str:
    return str(request.url).split("?", 1)[0]


def _oauth_callback_actor(config: KnowledgeConfig, store: SeedStore) -> User:
    if config.owner_user_id:
        owner = store.users.get(config.owner_user_id)
        if owner is not None:
            return owner
    # Provider redirects are unauthenticated; audit them as an explicit system actor.
    return User(
        id="system-oauth-callback",
        tenant_id=config.tenant_id,
        email="oauth-callback@aperture.local",
        display_name="OAuth provider callback",
        role=Role.USER,
        auth_method="local",
    )


def _exchange_api_source_oauth_code(
    config: KnowledgeConfig,
    code: str,
    callback_url: str,
    store: SeedStore,
) -> dict[str, Any]:
    oauth_settings = _api_source_oauth_settings(config)
    token_url = _api_source_oauth_token_url(config)
    client_id = str(oauth_settings.get("client_id") or "").strip()
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="OAuth client ID is required."
        )
    client_secret = store.configuration_secret("knowledge-api-source", f"{config.id}:oauth-client")
    try:
        validate_public_url(token_url)
    except EgressBlocked as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"OAuth token endpoint is not permitted: {exc}",
        ) from exc
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": str(oauth_settings.get("callback_url") or "").strip() or callback_url,
        "client_id": client_id,
    }
    if client_secret:
        payload["client_secret"] = client_secret
    try:
        with httpx.Client(timeout=15.0) as oauth_client:
            response = oauth_client.post(
                token_url, data=payload, headers={"Accept": "application/json"}
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"OAuth token exchange failed: {exc}",
        ) from exc
    if response.status_code >= 400:
        detail = response.text[:500] if response.text else response.reason_phrase
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"OAuth token endpoint returned {response.status_code}: {detail}",
        )
    try:
        token_payload = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OAuth token endpoint did not return JSON.",
        ) from exc
    access_token = token_payload.get("access_token")
    if not isinstance(access_token, str) or not access_token.strip():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OAuth token endpoint did not return an access token.",
        )
    return token_payload


def _sync_time() -> str:
    return datetime.now(UTC).strftime("%b %d, %Y, %I:%M %p UTC").replace(" 0", " ")
