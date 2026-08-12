import json
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, UploadFile, status
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
from app.core.knowledge_ingestion import (
    ExtractedSegment,
    chunk_segments,
    extract_segments,
    extract_segments_from_file,
)
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


@router.get("/{config_id}/oauth/callback")
def api_source_oauth_callback(
    config_id: str,
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    store: SeedStore = Depends(get_store),
) -> dict[str, Any]:
    config = store.knowledge_configs.get(config_id)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown knowledge configuration."
        )
    if error:
        return {
            "status": "error",
            "knowledge_config_id": config.id,
            "name": config.name,
            "error": error,
            "state": state,
        }
    if code and _api_source_oauth_token_url(config):
        if not state:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The OAuth callback is missing its state parameter.",
            )
        state_payload = verify_oidc_state(state, get_settings().secret_key)
        if state_payload is None or str(state_payload.get("config_id") or "") != config.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The OAuth state is invalid or expired; restart the API source connection.",
            )
        token_payload = _exchange_api_source_oauth_code(config, code, _callback_url(request), store)
        store.set_configuration_secret(
            "knowledge-oauth-token", config.id, json.dumps(token_payload)
        )
        settings = dict(config.settings)
        settings["oauth_token_status"] = "stored"
        settings["oauth_last_callback_state"] = state
        settings["oauth_token_type"] = token_payload.get("token_type")
        settings["oauth_scope"] = token_payload.get("scope")
        config.settings = settings
        store.record_audit(
            _oauth_callback_actor(config, store),
            "knowledge.oauth_token_stored",
            config.id,
            {
                "token_type": token_payload.get("token_type"),
                "scope": token_payload.get("scope"),
                "state": state,
                "access_token": "[redacted]",
            },
        )
        return {
            "status": "token_stored",
            "knowledge_config_id": config.id,
            "name": config.name,
            "code": "exchanged",
            "state": state,
            "token_type": token_payload.get("token_type"),
            "scope": token_payload.get("scope"),
        }
    return {
        "status": "received" if code else "ready",
        "knowledge_config_id": config.id,
        "name": config.name,
        "code": "received" if code else None,
        "state": state,
    }


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
    )
    return KnowledgeSearchResponse(query=query, knowledge_config_ids=readable_config_ids, hits=hits)


@router.get("/{config_id}/documents")
def documents(
    config_id: str,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> list[KnowledgeDocument]:
    assert_group_permission(actor, store.groups, "knowledge_access", "Knowledge access")
    config = _get_readable_config(config_id, actor, store)
    documents = store.knowledge_documents_for(config.id)
    store.record_audit(
        actor,
        "knowledge.documents_listed",
        config.id,
        {"document_count": len(documents), "source_type": config.source_type},
    )
    return documents


@router.post("/{config_id}/sync")
def sync(
    config_id: str,
    payload: KnowledgeSyncRequest | None = None,
    actor: User = Depends(current_user),
    store: SeedStore = Depends(get_store),
) -> KnowledgeSyncResponse:
    config = _get_operable_config(config_id, actor, store)
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
            else:
                segments = await run_in_threadpool(
                    extract_segments_from_file,
                    filename,
                    file.file,
                    file.content_type,
                    max_chars=settings.knowledge_max_extracted_chars,
                    ocr_enabled=settings.knowledge_ocr_enabled,
                    ocr_max_pages=settings.knowledge_ocr_max_pages,
                    ocr_page_timeout_seconds=settings.knowledge_ocr_page_timeout_seconds,
                )
            document, chunks = _document_from_segments(
                config,
                name=filename,
                source_type="upload",
                source_uri=f"upload://knowledge/{config.id}/{uuid4()}-{filename}",
                segments=segments,
                synced_at=synced_at,
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
    config, documents, synced_at = await run_in_threadpool(
        _append_indexed_sources,
        store,
        config,
        new_documents,
        new_chunks,
        synced_at=synced_at,
        provider_status="live",
        provider_message=f"Uploaded and indexed {len(new_documents)} document source{'' if len(new_documents) == 1 else 's'}.",
    )
    store.record_audit(
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
        provider_message=f"Uploaded and indexed {len(new_documents)} document source{'' if len(new_documents) == 1 else 's'}.",
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
            f"Indexed operator-provided text for {url}; the page itself was not fetched."
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
    config = _get_operable_config(config_id, actor, store)
    synced_at = _sync_time()
    base_url = payload.base_url.strip()
    if not base_url:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="API source base URL is required."
        )
    name = payload.name.strip() or base_url
    if payload.secret_value:
        # OAuth client secrets are stored under a deterministic key so the
        # OAuth callback can complete the token exchange later.
        secret_record_id = (
            f"{config.id}:oauth-client"
            if payload.auth_type == "oauth-client"
            else f"{config.id}:{uuid4()}"
        )
        store.set_configuration_secret(
            "knowledge-api-source", secret_record_id, payload.secret_value
        )
    if payload.auth_type == "oauth-client":
        settings = dict(config.settings)
        settings["api_source_oauth"] = {
            "name": name,
            "client_id": (payload.client_id or "").strip(),
            "authorization_url": (payload.authorization_url or "").strip(),
            "token_url": (payload.token_url or "").strip(),
            "callback_url": (payload.callback_url or "").strip(),
            "scopes": [scope.strip() for scope in payload.scopes if scope.strip()],
            "audience": (payload.audience or "").strip(),
        }
        config.settings = settings
    description_parts = (
        [payload.description.strip()] if payload.description and payload.description.strip() else []
    )
    connection_lines = [
        f"Source label: {payload.source_label.strip()}"
        if payload.source_label and payload.source_label.strip()
        else "",
        f"Resource or path: {payload.resource_id.strip()}"
        if payload.resource_id and payload.resource_id.strip()
        else "",
        f"Request method: {payload.request_method.strip().upper()}"
        if payload.request_method and payload.request_method.strip()
        else "",
        f"Header notes: {payload.header_notes.strip()}"
        if payload.header_notes and payload.header_notes.strip()
        else "",
    ]
    description_parts.extend(line for line in connection_lines if line)
    if payload.auth_type == "api-key":
        credential_name = (
            payload.credential_name.strip() if payload.credential_name else "X-API-Key"
        )
        credential_location = (
            payload.credential_location.strip() if payload.credential_location else "header"
        )
        api_key_lines = [
            f"API key metadata for {name}.",
            f"Credential name: {credential_name}.",
            f"Credential location: {credential_location}.",
            "API key value is stored in the backend vault and is not indexed.",
        ]
        description_parts.extend(api_key_lines)
    elif payload.auth_type == "bearer-token":
        bearer_lines = [
            f"Bearer token metadata for {name}.",
            "Authorization header: Bearer token.",
            "Bearer token value is stored in the backend vault and is not indexed.",
        ]
        description_parts.extend(bearer_lines)
    elif payload.auth_type == "oauth-client":
        oauth_lines = [
            f"OAuth client metadata for {name}.",
            f"Client ID: {payload.client_id.strip()}"
            if payload.client_id and payload.client_id.strip()
            else "",
            (
                f"Authorization URL: {payload.authorization_url.strip()}"
                if payload.authorization_url and payload.authorization_url.strip()
                else ""
            ),
            f"Token URL: {payload.token_url.strip()}"
            if payload.token_url and payload.token_url.strip()
            else "",
            f"Callback URL: {payload.callback_url.strip()}"
            if payload.callback_url and payload.callback_url.strip()
            else "",
            f"Scopes: {', '.join(scope.strip() for scope in payload.scopes if scope.strip())}"
            if payload.scopes
            else "",
            f"Audience/Tenant: {payload.audience.strip()}"
            if payload.audience and payload.audience.strip()
            else "",
            "Client secret is stored in the backend vault and is not indexed.",
        ]
        description_parts.extend(line for line in oauth_lines if line)
    description = (
        "\n".join(description_parts)
        or f"API source {name} uses {payload.auth_type} authentication at {base_url}."
    )
    document, chunks = _document_from_text(
        config,
        name=name,
        source_type="api",
        source_uri=base_url,
        text=description,
        synced_at=synced_at,
    )
    config, documents, synced_at = _append_indexed_sources(
        store,
        config,
        [document],
        chunks,
        synced_at=synced_at,
        provider_status="live",
        provider_message=f"Registered API source {name} and stored the credential in the backend vault.",
    )
    store.record_audit(
        actor,
        "knowledge.api_source_added",
        config.id,
        {
            "base_url": base_url,
            "auth_type": payload.auth_type,
            "source_label": payload.source_label,
            "resource_id": payload.resource_id,
            "request_method": payload.request_method,
            "header_notes": payload.header_notes,
            "credential_name": payload.credential_name,
            "credential_location": payload.credential_location,
            "client_id": payload.client_id,
            "authorization_url": payload.authorization_url,
            "token_url": payload.token_url,
            "callback_url": payload.callback_url,
            "scopes": payload.scopes,
            "audience": payload.audience,
            "secret_value": "[redacted]",
        },
    )
    return KnowledgeSyncResponse(
        config=config,
        documents=documents,
        status=knowledge_sync_status("live"),
        synced_at=synced_at,
        provider_status="live",
        provider_message=f"Registered API source {name} and stored the credential in the backend vault.",
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


def _get_readable_config(config_id: str, actor: User, store: SeedStore) -> KnowledgeConfig:
    config = store.knowledge_configs.get(config_id)
    if config is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Unknown knowledge configuration."
        )
    assert_knowledge_access(actor, config)
    return config


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

    segments = extract_segments(item.name, content, mime_type=_extraction_mime_type(item))
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

    segments = extract_segments(item.name, content)
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
) -> tuple[KnowledgeDocument, list[KnowledgeChunk]]:
    segments = [ExtractedSegment(text=text)] if text else []
    return _document_from_segments(
        config,
        name=name,
        source_type=source_type,
        source_uri=source_uri,
        segments=segments,
        synced_at=synced_at,
    )


def _document_from_segments(
    config: KnowledgeConfig,
    *,
    name: str,
    source_type: str,
    source_uri: str,
    segments: list[ExtractedSegment],
    synced_at: str,
) -> tuple[KnowledgeDocument, list[KnowledgeChunk]]:
    document = KnowledgeDocument(
        id=f"doc-{source_type}-{uuid4()}",
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
