import json
import logging
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from html import escape
from datetime import UTC, datetime
from threading import Lock
from typing import Any, BinaryIO
from urllib.parse import quote, urlencode
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import FileResponse, HTMLResponse
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
from app.core.knowledge_originals import DocumentRef
from app.core.knowledge_walls import (
    DOCUMENT_WALLS_SETTING,
    document_wall_overrides,
    wall_group_ids,
)
from app.core.document_rendition import (
    PreparedDocument,
    RenditionOptions,
    page_index,
    prepare_document,
)
from app.core.document_view import locate_passage, recorded_span, target_for, text_segments
from app.core.document_metadata import (
    PROPERTIES_LOCATOR,
    bounded_metadata,
    descriptive_properties,
    metadata_summary,
)
from app.core.knowledge_ingestion import (
    ExtractedDocument,
    ExtractedSegment,
    PageReader,
    chunk_segments,
    extract_document,
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
from app.core.site_crawl import (
    CRAWLER_USER_AGENT,
    LINKED_SOURCES_KEY,
    CrawledPage,
    CrawlLimits,
    CrawlResult,
    crawl_recipe_fields,
    crawl_site,
    single_page_result,
    site_recipe,
)
from app.core.vision_ocr import VisionPageReader, resolve_vision_model
from app.core.web_fetch import FetchedWebSource, WebFetchError, fetch_web_source
from app.core.model_gateway import ModelGatewayRoute
from app.core.policy import (
    api_source_authoring_allowed,
    assert_api_source_authoring,
    assert_group_permission,
    assert_knowledge_access,
    is_tenant_admin,
    knowledge_access_allowed,
    knowledge_authoring_allowed,
    knowledge_wall_allows,
)
from app.models.schemas import (
    ConnectorConfig,
    KnowledgeChunk,
    KnowledgeChunkLocation,
    KnowledgeConfig,
    KnowledgeApiSourceCreateRequest,
    KnowledgeDocument,
    KnowledgeDocumentAccessRequest,
    KnowledgeDocumentView,
    KnowledgeDocumentViewSegment,
    KnowledgeDocumentViewTarget,
    KnowledgeIndexStatus,
    KnowledgeSearchRequest,
    KnowledgeSearchResponse,
    KnowledgeSyncRequest,
    KnowledgeSyncResponse,
    KnowledgeWebSourceCreateRequest,
    ModelConfig,
    Role,
    User,
)
from app.repositories.deps import get_store, get_usage_budget_orchestrator
from app.repositories.seed import SeedStore, knowledge_sync_status
from app.routes.dependencies import current_user

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])
logger = logging.getLogger("aperture.knowledge")


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
    assert_api_source_authoring(actor, store.groups)
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
    if not _operates(config, actor, store):
        # Readers outside an ethical wall must not learn the document exists;
        # the people who manage the base still see it with its wall.
        documents = [
            document
            for document in documents
            if knowledge_wall_allows(actor, wall_group_ids(document.wall))
        ]
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
    settings = get_settings()
    return {
        "upload_max_mb": settings.knowledge_upload_max_mb,
        "max_extracted_chars": settings.knowledge_max_extracted_chars,
        "ocr_enabled": settings.knowledge_ocr_enabled,
        "ocr_max_pages": settings.knowledge_ocr_max_pages,
        "vision_ocr": _vision_ocr_status(actor, store),
        "semantic_search": store.vector_store.dense_status("")["semantic_search"],
        # Provider sign-ins must be registered with the exact callback the
        # server sends, so the UI shows this rather than guessing an origin.
        "oauth_callback_base": f"{get_settings().api_base_url.rstrip('/')}/api/knowledge",
    }


def _vision_ocr_status(actor: User, store: SeedStore) -> dict[str, Any]:
    """Which model reads handwriting and images for this person's workspace."""
    settings = get_settings()
    selection = (
        resolve_vision_model(
            store, tenant_id=actor.tenant_id, preferred=settings.knowledge_vision_ocr_model
        )
        if settings.knowledge_vision_ocr_enabled and settings.knowledge_vision_ocr_max_pages > 0
        else None
    )
    return {
        "available": selection is not None,
        "model_name": selection[0].name if selection is not None else None,
        "max_pages": settings.knowledge_vision_ocr_max_pages,
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
    usage_orchestrator: TenantUsageBudgetOrchestrator = Depends(get_usage_budget_orchestrator),
) -> KnowledgeSyncResponse:
    config = _get_operable_config(config_id, actor, store)
    # Groups named by a wall may have been created or renamed since indexing.
    store.reapply_knowledge_walls(config)
    if config.source_type not in CONNECTOR_SOURCE_TYPES:
        return _refresh_linked_sources(config, actor, store, force=bool(payload and payload.force))
    usage = _LazyUsage(
        lambda: _begin_knowledge_media_usage(
            usage_orchestrator, actor=actor, store=store, tenant_id=config.tenant_id, tenant_slug=None
        )
    )
    readers = _ReaderLog(_vision_reader_factory(config, store, usage.get))
    try:
        sync_documents, sync_chunks, provider_status, provider_message = _provider_sync_documents(
            config, store, readers.new
        )
    finally:
        if usage.context is not None:
            _close_knowledge_media_usage(usage.context)
    provider_message = " ".join(
        part for part in (provider_message, readers.summary()) if part
    ) or None
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
    uploads: list[_IndexedUpload] = []
    usage = _LazyUsage(
        lambda: _begin_knowledge_media_usage(
            usage_orchestrator,
            actor=actor,
            store=store,
            tenant_id=config.tenant_id,
            tenant_slug=tenant_slug,
        )
    )
    new_vision_reader = _vision_reader_factory(config, store, usage.get)
    with _metered_upload(usage):
        for file in files:
            indexed = await _index_uploaded_file(
                file,
                config=config,
                actor=actor,
                store=store,
                usage=usage,
                new_vision_reader=new_vision_reader,
                synced_at=synced_at,
            )
            uploads.append(indexed)
            uploaded_bytes += indexed.byte_count
            notes.extend(indexed.notes)
            new_documents.append(indexed.document)
            new_chunks.extend(indexed.chunks)
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
    # Only once the documents exist, so a batch that fails partway keeps no bytes.
    await run_in_threadpool(_retain_uploads, store, config, uploads)
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
    overrides = document_wall_overrides(config.settings)
    if overrides.pop(document_id, None) is not None:
        config.settings = {**config.settings, DOCUMENT_WALLS_SETTING: overrides}
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


@router.put("/{config_id}/documents/{document_id}/access")
def set_document_access(
    config_id: str,
    document_id: str,
    payload: KnowledgeDocumentAccessRequest,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeSyncResponse:
    """Set one document's ethical wall.

    ``metadata`` follows the file's own wall field, ``restricted`` limits it to
    the chosen groups, and ``open`` lifts a metadata wall. Lifting a wall is for
    administrators only, so a knowledge base owner cannot undo a firm wall.
    """
    config = _get_operable_config(config_id, actor, store)
    document = _knowledge_document_or_404(config, document_id, store)
    if payload.mode == "open" and not (is_tenant_admin(actor) or actor.role == Role.PLATFORM_OWNER):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators can lift an ethical wall.",
        )
    group_ids = _wall_group_choice(payload, config, store)
    overrides = document_wall_overrides(config.settings)
    previous_group_ids = wall_group_ids(document.wall)
    if payload.mode == "metadata":
        overrides.pop(document_id, None)
    else:
        overrides[document_id] = {"mode": payload.mode, "group_ids": group_ids}
    config.settings = {**config.settings, DOCUMENT_WALLS_SETTING: overrides}
    store.reapply_knowledge_walls(config)
    store.record_audit(
        actor,
        "knowledge.document_wall_changed",
        config.id,
        {
            "document_id": document_id,
            "document_name": document.name,
            "mode": payload.mode,
            "group_ids": group_ids,
            "previous_group_ids": previous_group_ids,
        },
    )
    documents = store.knowledge_documents_for(config.id)
    updated = next(item for item in documents if item.id == document_id)
    return KnowledgeSyncResponse(
        config=config,
        documents=documents,
        status=str(config.settings.get("status") or "synced"),
        synced_at=str(config.settings.get("last_sync") or "Not synced"),
        provider_status="unchanged",
        provider_message=_wall_message(updated, store),
    )


@router.get("/chunks/{chunk_id}/location")
def chunk_location(
    chunk_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeChunkLocation:
    """Which document a saved citation points at, for citations that predate
    ``document_id``. Every refusal is a 404, so a chunk id proves nothing."""
    chunk = store.knowledge_chunk(chunk_id)
    if chunk is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_UNKNOWN_CHUNK)
    try:
        config, document = _viewable_document(
            chunk.knowledge_config_id, chunk.document_id, actor, store, access="location"
        )
    except HTTPException as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_UNKNOWN_CHUNK) from exc
    return KnowledgeChunkLocation(knowledge_config_id=config.id, document_id=document.id)


@router.get("/{config_id}/documents/{document_id}/view")
def document_view(
    config_id: str,
    document_id: str,
    response: Response,
    chunk_id: str | None = None,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeDocumentView:
    """How to present a document, and where its cited passage is."""
    config, document = _viewable_document(config_id, document_id, actor, store, access="view")
    # The excerpt and segments are the document's own text.
    response.headers["Cache-Control"] = "private, no-store"
    prepared = _prepared_document(config, document, store)
    chunks = store.knowledge_document_chunks(config.id, document.id)
    cited = next((chunk for chunk in chunks if chunk.id == chunk_id), None)
    return KnowledgeDocumentView(
        document_id=document.id,
        knowledge_config_id=config.id,
        name=document.name,
        content_type=prepared.content_type,
        mode=prepared.mode,
        file_url=_view_file_url(config.id, document.id) if prepared.file_path else None,
        original_available=prepared.original_available,
        page_count=prepared.page_count,
        target=_cited_target(cited, chunks, prepared, _document_ref(config, document), store),
        segments=_view_segments(document, chunks) if prepared.mode == "text" else None,
        notice=prepared.notice,
    )


@router.get("/{config_id}/documents/{document_id}/view/file")
def document_view_file(
    config_id: str,
    document_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> FileResponse:
    """The bytes the viewer renders: a PDF or an image, never anything active."""
    config, document = _viewable_document(config_id, document_id, actor, store, access="file")
    prepared = _prepared_document(config, document, store)
    if prepared.file_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NO_STORED_FILE)
    return FileResponse(
        prepared.file_path,
        media_type=_view_media_type(prepared),
        headers={**_PRIVATE_FILE_HEADERS, "Content-Disposition": "inline"},
    )


@router.get("/{config_id}/documents/{document_id}/original")
def document_original(
    config_id: str,
    document_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> FileResponse:
    """The file as it was stored, as a download the browser cannot render."""
    config, document = _viewable_document(config_id, document_id, actor, store, access="original")
    path = store.knowledge_originals.path(_document_ref(config, document))
    if path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NO_STORED_FILE)
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=_safe_source_name(document.name, fallback="document"),
        headers=_PRIVATE_FILE_HEADERS,
    )


_UNKNOWN_CONFIGURATION = "Unknown knowledge configuration."
_UNKNOWN_DOCUMENT = "Unknown knowledge document."
_UNKNOWN_CHUNK = "Unknown knowledge passage."
_NO_STORED_FILE = "No stored file for this document."
_PRIVATE_FILE_HEADERS = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
}


def _viewable_document(
    config_id: str,
    document_id: str,
    actor: User,
    store: SeedStore,
    *,
    access: str,
) -> tuple[KnowledgeConfig, KnowledgeDocument]:
    """The one gate for reading a document's content.

    Unlike ``_get_viewable_config`` this admits nobody to a disabled base, and
    unlike ``documents()`` it has no operator bypass: an ethical wall screens
    every role. A base the actor cannot read answers like a missing base, and a
    walled document like a missing document, so neither id proves anything. The
    wall refusal is still audited: in a wall product, the attempts are the signal.
    """
    assert_group_permission(actor, store.groups, "knowledge_access", "Knowledge access")
    try:
        config = _get_readable_config(config_id, actor, store)
    except HTTPException as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=_UNKNOWN_CONFIGURATION
        ) from exc
    document = _knowledge_document_or_404(config, document_id, store)
    details = {"document_id": document.id, "access": access}
    if not knowledge_wall_allows(actor, wall_group_ids(document.wall)):
        store.record_audit(
            actor, "knowledge.document.view_denied", config.id, details, runtime_state_changed=False
        )
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_UNKNOWN_DOCUMENT)
    store.record_audit(
        actor, "knowledge.document.viewed", config.id, details, runtime_state_changed=False
    )
    return config, document


def _document_ref(config: KnowledgeConfig, document: KnowledgeDocument) -> DocumentRef:
    return DocumentRef(config.tenant_id, config.id, document.id)


def _retain_original(
    store: SeedStore, config: KnowledgeConfig, document_id: str, source: BinaryIO | bytes
) -> None:
    """A document that cannot keep its file still opens, as text, so a full disk
    costs the viewer the layout rather than failing the ingest. A base purged
    while a sync was running keeps nothing: no later delete would find the bytes."""
    if config.id not in store.knowledge_configs:
        return
    try:
        store.knowledge_originals.save(DocumentRef(config.tenant_id, config.id, document_id), source)
    except OSError:
        logger.exception("Could not store the original of %s", document_id)


def _retain_uploads(store: SeedStore, config: KnowledgeConfig, uploads: list["_IndexedUpload"]) -> None:
    for upload in uploads:
        _retain_original(store, config, upload.document.id, upload.source)


RetainOriginal = Callable[[str, bytes | None], None]


def _retain_nothing(_document_id: str, _content: bytes | None) -> None:
    return None


def _original_retainer(config: KnowledgeConfig, store: SeedStore) -> RetainOriginal:
    """What a connector does with each download. ``None`` means the source would
    not give the file up, so what was kept from an earlier sync goes too."""

    def retain(document_id: str, content: bytes | None) -> None:
        if content is None:
            store.knowledge_originals.delete_document(
                DocumentRef(config.tenant_id, config.id, document_id)
            )
        else:
            _retain_original(store, config, document_id, content)

    return retain


def _prepared_document(
    config: KnowledgeConfig, document: KnowledgeDocument, store: SeedStore
) -> PreparedDocument:
    settings = get_settings()
    return prepare_document(
        store.knowledge_originals,
        _document_ref(config, document),
        name=document.name,
        options=RenditionOptions(
            soffice=settings.knowledge_rendition_soffice_path,
            timeout_seconds=settings.knowledge_rendition_timeout_seconds,
            memory_mb=settings.knowledge_rendition_memory_mb,
            require_isolation=settings.environment.strip().lower() != "local",
            private_directories=settings.private_data_directories,
        ),
    )


def _view_segments(
    document: KnowledgeDocument, chunks: list[KnowledgeChunk]
) -> list[KnowledgeDocumentViewSegment]:
    """A metadata-only document's one chunk describes the file; it is not its text."""
    return [] if document.status == "metadata-only" else text_segments(chunks)


def _cited_target(
    cited: KnowledgeChunk | None,
    chunks: list[KnowledgeChunk],
    prepared: PreparedDocument,
    ref: DocumentRef,
    store: SeedStore,
) -> KnowledgeDocumentViewTarget | None:
    if cited is None:
        return None
    pdf = prepared.file_path
    if prepared.mode != "pdf" or pdf is None:
        return target_for(cited, recorded_span(cited))
    span = locate_passage(cited, chunks, lambda: page_index(store.knowledge_originals, ref, pdf))
    return target_for(cited, span)


def _view_file_url(config_id: str, document_id: str) -> str:
    return f"/api/knowledge/{quote(config_id, safe='')}/documents/{quote(document_id, safe='')}/view/file"


def _view_media_type(prepared: PreparedDocument) -> str:
    return "application/pdf" if prepared.mode == "pdf" else prepared.content_type


def _knowledge_document_or_404(
    config: KnowledgeConfig, document_id: str, store: SeedStore
) -> KnowledgeDocument:
    for document in store.knowledge_documents_for(config.id):
        if document.id == document_id:
            return document
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_UNKNOWN_DOCUMENT)


def _wall_group_choice(
    payload: KnowledgeDocumentAccessRequest, config: KnowledgeConfig, store: SeedStore
) -> list[str]:
    if payload.mode != "restricted":
        return []
    group_ids = list(dict.fromkeys(item.strip() for item in payload.group_ids if item.strip()))
    if not group_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Choose at least one group that may see this document.",
        )
    unknown = [
        group_id
        for group_id in group_ids
        if (group := store.groups.get(group_id)) is None or group.tenant_id != config.tenant_id
    ]
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown group: {', '.join(unknown)}.",
        )
    return group_ids


def _wall_message(document: KnowledgeDocument, store: SeedStore) -> str:
    wall = document.wall
    if wall is None:
        return f"Everyone who can use this knowledge base can now find {document.name}."
    if not wall.group_ids:
        return f"{document.name} is hidden from everyone until its wall names a known group."
    names = [
        store.groups[group_id].name if group_id in store.groups else group_id
        for group_id in wall.group_ids
    ]
    return f"Only members of {', '.join(names)} can now find {document.name}."


def _operates(config: KnowledgeConfig, actor: User, store: SeedStore) -> bool:
    try:
        _get_operable_config(config.id, actor, store)
    except HTTPException:
        return False
    return True


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
    manual_text = (payload.text or "").strip()
    if manual_text:
        document, chunks = _document_from_text(
            config,
            name=payload.name.strip() or url,
            source_type="web",
            source_uri=url,
            text=manual_text,
            synced_at=synced_at,
        )
        read = _WebSourceRead(
            document,
            chunks,
            f"Indexed the text you provided for {url}; the page itself was not fetched.",
        )
    else:
        # Fetch failures raise an HTTP error so no fake "indexed" document is created.
        read = _read_web_source(
            config,
            url=url,
            name=payload.name.strip(),
            crawl_depth=payload.crawl_depth,
            max_pages=payload.max_pages,
            live_lookup=payload.live_lookup,
            synced_at=synced_at,
        )
    _save_linked_sources(
        config,
        [
            *_linked_sources(config),
            {
                "document_id": read.document.id,
                "kind": "web",
                "name": read.document.name,
                "url": url,
                # Pasted text has no live page behind it, so Sync leaves it alone.
                "refresh": not manual_text,
                **read.fields,
            },
        ],
    )
    config, documents, synced_at = _append_indexed_sources(
        store,
        config,
        [read.document],
        read.chunks,
        synced_at=synced_at,
        provider_status="live",
        provider_message=read.message,
    )
    store.record_audit(
        actor,
        "knowledge.web_source_added",
        config.id,
        {"url": url, "chunk_count": len(read.chunks), "fetched": not manual_text, **read.audit},
    )
    return KnowledgeSyncResponse(
        config=config,
        documents=documents,
        status=knowledge_sync_status("live"),
        synced_at=synced_at,
        provider_status="live",
        provider_message=read.message,
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
    assert_api_source_authoring(actor, store.groups)
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


CONNECTOR_SOURCE_TYPES = frozenset({"box", "microsoft-graph", "google-drive", "imanage"})
_API_AUTH_TYPES = frozenset({"none", "api-key", "bearer-token", "oauth-client"})
_LINKED_SOURCES_KEY = LINKED_SOURCES_KEY


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


@contextmanager
def _metered_upload(usage: "_LazyUsage") -> Iterator[None]:
    """Settle the upload's metered request, or fail it and report an HTTP error."""
    try:
        yield
        if usage.context is not None:
            _close_knowledge_media_usage(usage.context)
    except MediaTranscriptionError as exc:
        _fail_upload_usage(usage)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except UsageBudgetError as exc:
        _fail_upload_usage(usage)
        failure = map_usage_budget_error(exc)
        raise HTTPException(
            status_code=failure.status_code,
            detail=failure.detail,
            headers=dict(failure.headers),
        ) from exc
    except Exception:
        _fail_upload_usage(usage)
        raise


def _fail_upload_usage(usage: "_LazyUsage") -> None:
    if usage.context is not None:
        _fail_knowledge_media_usage(usage.context)


@dataclass(frozen=True, slots=True)
class _IndexedUpload:
    document: KnowledgeDocument
    chunks: list[KnowledgeChunk]
    notes: list[str]
    byte_count: int
    source: BinaryIO


async def _index_uploaded_file(
    file: UploadFile,
    *,
    config: KnowledgeConfig,
    actor: User,
    store: SeedStore,
    usage: "_LazyUsage",
    new_vision_reader: Callable[[], VisionPageReader | None],
    synced_at: str,
) -> _IndexedUpload:
    """Validate, extract (or transcribe), and chunk one uploaded file."""
    settings = get_settings()
    filename = _safe_source_name(file.filename, fallback="uploaded-source")
    file_bytes = await validate_upload_within_limit(
        file,
        settings.knowledge_upload_max_bytes,
        detail=(
            f"'{filename}' exceeds the {settings.knowledge_upload_max_mb} MB "
            "knowledge upload limit."
        ),
    )
    vision = None
    if is_media_upload(filename, file.content_type):
        content = await file.read()
        usage_context = await run_in_threadpool(usage.get)
        result = await run_in_threadpool(
            _transcribe_knowledge_media,
            content,
            filename,
            file.content_type,
            store,
            config.tenant_id,
            usage_context,
        )
        extracted = ExtractedDocument(
            segments=[ExtractedSegment(text=result.text, locator="transcript")], metadata={}
        )
        truncated = False
    else:
        vision = new_vision_reader()
        extracted, truncated = await run_in_threadpool(
            _extract_upload_document,
            filename,
            file.file,
            file.content_type,
            settings.knowledge_max_extracted_chars,
            vision,
        )
    # Chunking a multi-million-character file is CPU work; keep it off the
    # event loop so other requests are served meanwhile.
    document, chunks = await run_in_threadpool(
        _document_from_segments,
        config,
        name=filename,
        source_type="upload",
        source_uri=f"upload://knowledge/{config.id}/{uuid4()}-{filename}",
        segments=extracted.segments,
        synced_at=synced_at,
        metadata=_with_upload_properties(
            extracted.metadata, file_bytes=file_bytes, actor=actor, synced_at=synced_at
        ),
    )
    notes = _vision_notes(filename, vision) + _extraction_notes(
        filename, document, truncated=truncated, max_chars=settings.knowledge_max_extracted_chars
    )
    return _IndexedUpload(document, chunks, notes, file_bytes, file.file)


def _extraction_notes(
    filename: str, document: KnowledgeDocument, *, truncated: bool, max_chars: int
) -> list[str]:
    if document.status == "metadata-only":
        return [f"No readable text was found in {filename}, so only its name is searchable."]
    if truncated:
        return [f"Only the first {max_chars:,} characters of {filename} were indexed."]
    return []


def _extract_upload_document(
    filename: str,
    file: Any,
    content_type: str | None,
    max_chars: int,
    vision: PageReader | None = None,
) -> tuple[ExtractedDocument, bool]:
    """Extract an upload and report whether it was cut at the character limit.

    Extraction asks for one character more than the limit, so a document that
    is exactly at the limit is never reported as truncated.
    """
    settings = get_settings()
    extracted = extract_document(
        filename,
        file,
        content_type,
        max_chars=max_chars + 1,
        ocr_enabled=settings.knowledge_ocr_enabled,
        ocr_max_pages=settings.knowledge_ocr_max_pages,
        ocr_page_timeout_seconds=settings.knowledge_ocr_page_timeout_seconds,
        vision=vision,
    )
    segments = extracted.segments
    joined_length = sum(len(segment.text) for segment in segments) + 2 * max(0, len(segments) - 1)
    if joined_length <= max_chars:
        return extracted, False
    limited = limit_extracted_segments(segments, max_chars=max_chars)
    return ExtractedDocument(segments=limited, metadata=extracted.metadata), True


class _LazyUsage:
    """Open the request's usage-budget context only when a provider call needs it.

    Media transcription and AI page reading share one metered request per
    upload; plain documents never open one.
    """

    def __init__(self, begin: Callable[[], UsageBudgetRequestContext]) -> None:
        self._begin = begin
        self._lock = Lock()
        self.context: UsageBudgetRequestContext | None = None

    def get(self) -> UsageBudgetRequestContext:
        with self._lock:
            if self.context is None:
                self.context = self._begin()
            return self.context


VISION_OCR_SETTING = "vision_ocr"


def _vision_reader_factory(
    config: KnowledgeConfig,
    store: SeedStore,
    usage: Callable[[], UsageBudgetRequestContext],
) -> Callable[[], VisionPageReader | None]:
    """Make one page reader per file, or None when AI reading is off.

    The model is resolved once, on first use, so uploads that never need it
    never touch provider credentials.
    """
    settings = get_settings()
    enabled = settings.knowledge_vision_ocr_enabled and config.settings.get(
        VISION_OCR_SETTING, True
    ) is not False
    selection: list[tuple[ModelConfig, ModelGatewayRoute] | None] = []

    def make() -> VisionPageReader | None:
        if not enabled or settings.knowledge_vision_ocr_max_pages <= 0:
            return None
        if not selection:
            selection.append(
                resolve_vision_model(
                    store,
                    tenant_id=config.tenant_id,
                    preferred=settings.knowledge_vision_ocr_model,
                )
            )
        if selection[0] is None:
            return None
        model, route = selection[0]
        return VisionPageReader(
            model=model,
            route=route,
            usage=usage,
            max_pages=settings.knowledge_vision_ocr_max_pages,
            concurrency=settings.knowledge_vision_ocr_concurrency,
        )

    return make


def _vision_notes(filename: str, vision: VisionPageReader | None) -> list[str]:
    if vision is None:
        return []
    notes: list[str] = []
    if vision.pages_read:
        notes.append(
            f"{vision.model_name} read handwriting, stamps, and images on "
            f"{vision.pages_read:,} page{'' if vision.pages_read == 1 else 's'} of {filename}."
        )
    if vision.skipped_for_budget:
        notes.append(
            f"{vision.skipped_for_budget:,} more page"
            f"{'' if vision.skipped_for_budget == 1 else 's'} of {filename} used standard OCR "
            f"only (AI reading is limited to {vision.max_pages:,} pages per file)."
        )
    if vision.problem:
        notes.append(f"{vision.problem} Standard OCR was used for the rest of {filename}.")
    elif vision.failures:
        notes.append(
            f"{vision.model_name} could not read {vision.failures:,} page"
            f"{'' if vision.failures == 1 else 's'} of {filename}; standard OCR was used for "
            f"{'it' if vision.failures == 1 else 'them'}."
        )
    return notes


def _with_upload_properties(
    metadata: dict[str, str], *, file_bytes: int, actor: User, synced_at: str
) -> dict[str, str]:
    return bounded_metadata(
        [
            *metadata.items(),
            ("File size", _file_size_label(file_bytes)),
            ("Uploaded by", actor.display_name or actor.email),
            ("Uploaded", synced_at),
        ]
    )


def _file_size_label(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{max(1, size // 1024):,} KB"
    return f"{size:,} bytes"


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
    # Revoking the API-source grant stops the outbound calls without deleting
    # what was already indexed.
    api_paused = not api_source_authoring_allowed(actor, store.groups)
    paused, refreshable, waiting = _partition_linked_sources(sources, api_paused=api_paused)
    paused_note = _paused_api_note(paused)
    if not refreshable:
        message = paused_note or _nothing_to_refresh_message(waiting=bool(waiting))
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
    refreshed, failures, notes = _refresh_each_linked_source(config, store, refreshable, synced_at=synced_at)
    _save_linked_sources(config, sources)
    status_value, provider_status, message = _refresh_outcome(
        refreshed, len(refreshable), failures, [*notes, paused_note]
    )
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
            "provider_message": message,
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


def _partition_linked_sources(
    sources: list[dict[str, Any]], *, api_paused: bool
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Split recipes into paused API sources, sources Sync re-fetches, and ones awaiting sign-in."""
    paused = [source for source in sources if api_paused and _refreshes_api(source)]
    refreshable = [source for source in sources if _refetchable(source) and source not in paused]
    waiting = [
        source
        for source in sources
        if source.get("awaiting_authorization") and source not in paused
    ]
    return paused, refreshable, waiting


def _refreshes_api(source: dict[str, Any]) -> bool:
    return source.get("kind") == "api" and bool(source.get("refresh"))


def _refetchable(source: dict[str, Any]) -> bool:
    return (
        bool(source.get("refresh"))
        and source.get("kind") in ("web", "api")
        and not source.get("awaiting_authorization")
    )


def _paused_api_note(paused: list[dict[str, Any]]) -> str:
    if not paused:
        return ""
    return (
        f"{len(paused)} API source{'' if len(paused) == 1 else 's'} skipped: API sources are "
        "turned off for your groups, so their last content is kept."
    )


def _nothing_to_refresh_message(*, waiting: bool) -> str:
    if waiting:
        return "Waiting for the provider sign-in before this API can be fetched."
    return (
        "Nothing to sync. Uploaded files and pasted text are indexed when you add "
        "them; add a web page or API to keep content refreshed automatically."
    )


def _refresh_outcome(
    refreshed: int, total: int, failures: list[str], notes: list[str]
) -> tuple[str, str, str]:
    """Status, provider status, and message for a Sync; notes follow the headline."""
    if failures:
        headline = (
            f"Refreshed {refreshed} of {total} linked sources. "
            "Could not refresh " + "; ".join(failures) + ". Their previous content is kept."
        )
        status_value = provider_status = "error"
    else:
        headline = f"Refreshed {refreshed} linked source{'' if refreshed == 1 else 's'}."
        status_value, provider_status = "synced", "live"
    return status_value, provider_status, " ".join([headline, *(note for note in notes if note)])


def _linked_source_name(source: dict[str, Any]) -> str:
    return str(source.get("name") or source.get("url") or source.get("base_url") or "source")


def _refresh_each_linked_source(
    config: KnowledgeConfig,
    store: SeedStore,
    refreshable: list[dict[str, Any]],
    *,
    synced_at: str,
) -> tuple[int, list[str], list[str]]:
    """Refresh each source in place; return the refreshed count, failures, and crawl notes."""
    documents_by_id = {document.id: document for document in store.knowledge_documents_for(config.id)}
    refreshed = 0
    failures: list[str] = []
    notes: list[str] = []
    for source in refreshable:
        name = _linked_source_name(source)
        existing = documents_by_id.get(str(source.get("document_id") or ""))
        try:
            document, chunks, note = _refresh_linked_source(
                config, source, store, name=existing.name if existing else name, synced_at=synced_at
            )
        except HTTPException as exc:
            failures.append(f"{name}: {exc.detail}")
            continue
        if not source.get("document_id"):
            source["document_id"] = document.id
        store.replace_knowledge_document(config, document, chunks)
        refreshed += 1
        if note:
            notes.append(f"{document.name}: {note}")
    return refreshed, failures, notes


def _refresh_linked_source(
    config: KnowledgeConfig,
    source: dict[str, Any],
    store: SeedStore,
    *,
    name: str,
    synced_at: str,
) -> tuple[KnowledgeDocument, list[KnowledgeChunk], str]:
    """Re-read one web page, site, or API with its saved settings."""
    document_id = str(source.get("document_id") or "") or None
    recipe = site_recipe(source)
    if recipe is not None:
        read = _read_web_source(
            config,
            url=recipe.url,
            name=name,
            crawl_depth=recipe.crawl_depth,
            max_pages=recipe.max_pages,
            live_lookup=recipe.live_lookup,
            synced_at=synced_at,
            document_id=document_id,
        )
        source.update(read.fields)
        return read.document, read.chunks, read.note
    fetched = _fetch_linked_api_source(config, source, store)
    document, chunks = _document_from_text(
        config,
        name=name,
        source_type=str(source.get("kind")),
        source_uri=fetched.display_url,
        text=fetched.text,
        synced_at=synced_at,
        document_id=document_id,
    )
    return document, chunks, ""


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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_UNKNOWN_CONFIGURATION)
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


NewPageReader = Callable[[], PageReader | None]


def _no_page_reader() -> PageReader | None:
    return None


def _provider_sync_documents(
    config: KnowledgeConfig,
    store: SeedStore,
    new_reader: NewPageReader = _no_page_reader,
) -> tuple[list[KnowledgeDocument] | None, list[KnowledgeChunk] | None, str, str | None]:
    if config.source_type == "box":
        return _sync_box_documents(config, store, new_reader)
    if config.source_type == "microsoft-graph":
        return _sync_microsoft_graph_documents(config, store, new_reader)
    if config.source_type == "google-drive":
        return _sync_google_drive_documents(config, store, new_reader)
    if config.source_type == "imanage":
        return _sync_imanage_documents(config, store, new_reader)
    return None, None, "cached", "No live adapter is configured for this source type yet."


class _ReaderLog:
    """Hands out one page reader per synced file and sums what they did."""

    def __init__(self, factory: NewPageReader) -> None:
        self._factory = factory
        self.readers: list[VisionPageReader] = []

    def new(self) -> PageReader | None:
        reader = self._factory()
        if isinstance(reader, VisionPageReader):
            self.readers.append(reader)
        return reader

    def summary(self) -> str:
        pages = sum(reader.pages_read for reader in self.readers)
        problems = list(dict.fromkeys(reader.problem for reader in self.readers if reader.problem))
        parts: list[str] = []
        if pages:
            name = self.readers[0].model_name
            parts.append(
                f"{name} read handwriting, stamps, and images on {pages:,} "
                f"page{'' if pages == 1 else 's'}."
            )
        parts += problems
        return " ".join(parts)


def _sync_box_documents(
    config: KnowledgeConfig,
    store: SeedStore,
    new_reader: NewPageReader = _no_page_reader,
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
        document, document_chunks, used_file_text = _box_document_and_chunks(
            config, item, client, new_reader, retain=_original_retainer(config, store)
        )
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
    new_reader: NewPageReader = _no_page_reader,
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
        new_reader=new_reader,
        retain=_original_retainer(config, store),
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
    new_reader: NewPageReader = _no_page_reader,
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
        config, items, client, new_reader=new_reader, retain=_original_retainer(config, store)
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
    new_reader: NewPageReader = _no_page_reader,
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
        config, items, client, new_reader=new_reader, retain=_original_retainer(config, store)
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
    new_reader: NewPageReader = _no_page_reader,
    retain: RetainOriginal = _retain_nothing,
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
            new_reader=new_reader,
            retain=retain,
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
        metadata=bounded_metadata(item.properties),
    )


def _cloud_document_and_chunks(
    config: KnowledgeConfig,
    item: CloudSourceItem,
    client: object,
    *,
    download_kwargs: dict[str, object],
    new_reader: NewPageReader = _no_page_reader,
    retain: RetainOriginal = _retain_nothing,
) -> tuple[KnowledgeDocument, list[KnowledgeChunk], bool]:
    document = _cloud_document(config, item)
    try:
        content = _download_cloud_file(client, item, download_kwargs=download_kwargs)
    except (AttributeError, CloudSourceError):
        retain(document.id, None)
        chunks = [_inventory_chunk(config, document, 0)]
        document.chunk_count = len(chunks)
        document.status = "metadata-only"
        return document, chunks, False

    retain(document.id, content)
    extracted = extract_document(
        item.name,
        content,
        mime_type=_extraction_mime_type(item),
        vision=new_reader(),
        **_extraction_settings(),
    )
    segments = extracted.segments
    # What the source system records comes first; the file's own properties
    # fill in the rest.
    document.metadata = bounded_metadata([*document.metadata.items(), *extracted.metadata.items()])
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
        metadata=bounded_metadata(item.properties),
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
    new_reader: NewPageReader = _no_page_reader,
    *,
    retain: RetainOriginal = _retain_nothing,
) -> tuple[KnowledgeDocument, list[KnowledgeChunk], bool]:
    document = _box_document(config, item)
    # Template metadata (walls, matters, classifications) lives beside the
    # file in Box, so it is read even when the file itself cannot be.
    read_metadata = getattr(client, "file_metadata", None)
    box_metadata = read_metadata(file_id=item.id) if callable(read_metadata) else []
    document.metadata = bounded_metadata([*document.metadata.items(), *box_metadata])
    try:
        content = client.download_file(file_id=item.id)
    except (AttributeError, BoxError):
        retain(document.id, None)
        chunks = [_inventory_chunk(config, document, 0)]
        document.chunk_count = len(chunks)
        document.status = "metadata-only"
        return document, chunks, False

    retain(document.id, content)
    extracted = extract_document(
        item.name, content, vision=new_reader(), **_extraction_settings()
    )
    segments = extracted.segments
    document.metadata = bounded_metadata([*document.metadata.items(), *extracted.metadata.items()])
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
    metadata: dict[str, str] | None = None,
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
        metadata=dict(metadata or {}),
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
    """Passages for ``segments`` plus, when the file had properties, a searchable
    "Document properties" passage so questions about authors, dates, labels, or
    custom fields can find the file itself."""
    chunked = chunk_segments(segments)
    properties = descriptive_properties(document.metadata)
    if chunked and properties:
        chunked += chunk_segments([_properties_segment(properties)])
    details = metadata_summary(document.metadata)
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
            source_details=details,
        )
        for index, segment in enumerate(chunked)
    ]


def _properties_segment(properties: list[tuple[str, str]]) -> ExtractedSegment:
    lines = "\n\n".join(f"{key}: {value}" for key, value in properties)
    return ExtractedSegment(text=f"Document properties:\n\n{lines}", locator=PROPERTIES_LOCATOR)


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


@dataclass(frozen=True)
class _WebSourceRead:
    """A web page or site read into one document, plus what its recipe and audit record."""

    document: KnowledgeDocument
    chunks: list[KnowledgeChunk]
    message: str
    fields: dict[str, Any] = field(default_factory=dict)
    audit: dict[str, Any] = field(default_factory=dict)
    # Crawl summary repeated in Sync messages; empty for single pages.
    note: str = ""


def _read_web_source(
    config: KnowledgeConfig,
    *,
    url: str,
    name: str,
    crawl_depth: int,
    max_pages: int,
    live_lookup: bool,
    synced_at: str,
    document_id: str | None = None,
) -> _WebSourceRead:
    """Read one page (depth 0) or crawl its site; raise an honest HTTP error if the page fails."""
    if crawl_depth == 0:
        fetched = _fetch_web_page(url)
        result = single_page_result(url, fetched)
        document, chunks = _document_from_text(
            config,
            name=name or result.site_name or url,
            source_type="web",
            source_uri=url,
            text=fetched.text,
            synced_at=synced_at,
            document_id=document_id,
        )
        saved = result.inventory_note() if live_lookup else ""
        message = " ".join(
            part for part in (f"Fetched {url} and indexed {len(fetched.text)} extracted characters.", saved) if part
        )
        note = ""
    else:
        result = _crawl_web_site(url, crawl_depth=crawl_depth, max_pages=max_pages)
        document, chunks = _document_from_site_pages(
            config,
            name=name or result.site_name or url,
            source_uri=url,
            pages=result.pages,
            synced_at=synced_at,
            document_id=document_id,
        )
        passages = f"{len(chunks)} passage{'' if len(chunks) == 1 else 's'}"
        message = f"Fetched {url}: {result.summary(include_inventory=live_lookup)} Indexed {passages}."
        note = result.summary(include_inventory=False)
    return _WebSourceRead(
        document,
        chunks,
        message,
        fields=crawl_recipe_fields(result, crawl_depth=crawl_depth, max_pages=max_pages, live_lookup=live_lookup),
        audit=_crawl_audit(result, crawl_depth=crawl_depth, live_lookup=live_lookup),
        note=note,
    )


def _crawl_audit(result: CrawlResult, *, crawl_depth: int, live_lookup: bool) -> dict[str, Any]:
    return {
        "crawl_depth": crawl_depth,
        "live_lookup": live_lookup,
        "pages_read": len(result.pages),
        "robots_blocked": result.robots_blocked,
        "failed_pages": result.failed,
        "skipped_pages": result.skipped,
    }


def _fetch_web_page(url: str) -> FetchedWebSource:
    """Fetch one web page and extract indexable text, or raise an honest error."""
    try:
        return fetch_web_source(url, user_agent=CRAWLER_USER_AGENT)
    except WebFetchError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _crawl_web_site(url: str, *, crawl_depth: int, max_pages: int) -> CrawlResult:
    """Crawl the site around ``url``; only a failure of that page itself is an error."""
    try:
        return crawl_site(url, limits=CrawlLimits(max_pages=max_pages, max_depth=crawl_depth))
    except WebFetchError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _document_from_site_pages(
    config: KnowledgeConfig,
    *,
    name: str,
    source_uri: str,
    pages: tuple[CrawledPage, ...],
    synced_at: str,
    document_id: str | None = None,
) -> tuple[KnowledgeDocument, list[KnowledgeChunk]]:
    """One document for the whole site whose chunks each cite the exact page they came from."""
    document, fallback_chunks = _document_from_segments(
        config,
        name=name,
        source_type="web",
        source_uri=source_uri,
        segments=[],
        synced_at=synced_at,
        document_id=document_id,
    )
    chunks: list[KnowledgeChunk] = []
    for page in pages:
        for chunk in _knowledge_chunks_from_segments(document, [_site_page_segment(page)]):
            chunks.append(
                chunk.model_copy(
                    update={
                        "id": f"chunk-{document.id}-{len(chunks) + 1}",
                        "ordinal": len(chunks),
                        "source_uri": page.url,
                    }
                )
            )
    if not chunks:
        return document, fallback_chunks
    document.status = "indexed"
    document.chunk_count = len(chunks)
    return document, chunks


def _site_page_segment(page: CrawledPage) -> ExtractedSegment:
    """The page's text under a header naming it, so its first passage says where it is from."""
    paragraphs = page.text.split("\n\n")
    if page.title and paragraphs[:1] == [page.title]:
        paragraphs = paragraphs[1:]
    if page.description in paragraphs:
        paragraphs.remove(page.description)
    header = f"{page.title} ({page.url})" if page.title else page.url
    if page.description:
        header = f"{header} — {page.description}"
    return ExtractedSegment(
        text="\n\n".join([header, *paragraphs]),
        locator=page.title or page.url,
    )


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
