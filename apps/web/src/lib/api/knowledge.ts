import {
  apiBase,
  apiBlobRequest,
  apiFileRequest,
  authHeaders,
  apiRequest,
  isRecord,
  readApiError,
  pathId,
  ChatRequestError,
  type ApiMutationOptions,
} from "./http";
import type {
  KnowledgeChunkLocation,
  KnowledgeDocument,
  KnowledgeDocumentNotice,
  KnowledgeDocumentSegment,
  KnowledgeDocumentTarget,
  KnowledgeDocumentView,
  KnowledgeDocumentViewMode,
  KnowledgeIndexStatus,
  KnowledgeSyncResult,
} from "../types";

export function listKnowledgeDocuments(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<KnowledgeDocument[]> {
  return apiRequest<KnowledgeDocument[]>(userId, `/api/knowledge/${pathId(configId)}/documents`, {
    signal: options.signal,
  });
}

export function syncKnowledgeBase(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<KnowledgeSyncResult> {
  return apiRequest<KnowledgeSyncResult>(userId, `/api/knowledge/${pathId(configId)}/sync`, {
    method: "POST",
    body: { force: true },
    signal: options.signal,
  });
}

export function deleteKnowledgeDocument(
  userId: string,
  configId: string,
  documentId: string,
  options: ApiMutationOptions = {},
): Promise<KnowledgeSyncResult> {
  return apiRequest<KnowledgeSyncResult>(userId, `/api/knowledge/${pathId(configId)}/documents/${pathId(documentId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export type KnowledgeDocumentAccessMode = "metadata" | "restricted" | "open";

/**
 * Set one document's ethical wall: follow its metadata, restrict it to
 * groups, or (administrators only) open a wall its metadata set.
 */
export function setKnowledgeDocumentAccess(
  userId: string,
  configId: string,
  documentId: string,
  payload: { mode: KnowledgeDocumentAccessMode; group_ids?: string[] },
  options: ApiMutationOptions = {},
): Promise<KnowledgeSyncResult> {
  return apiRequest<KnowledgeSyncResult>(
    userId,
    `/api/knowledge/${pathId(configId)}/documents/${pathId(documentId)}/access`,
    { method: "PUT", body: payload, signal: options.signal },
  );
}

export async function uploadKnowledgeDocuments(
  userId: string,
  configId: string,
  files: File[],
  options: ApiMutationOptions = {},
): Promise<KnowledgeSyncResult> {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/knowledge/${pathId(configId)}/documents`, {
      method: "POST",
      headers: authHeaders(userId),
      body: form,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The knowledge upload was cancelled before the API responded.");
    }
    throw new ChatRequestError("Could not upload knowledge documents. Check your connection and try again.");
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  return (await response.json()) as KnowledgeSyncResult;
}

export type KnowledgeWebSourcePayload = {
  /** Empty lets the server name the source after the page or site title. */
  name: string;
  url: string;
  /** Pasted text is indexed instead of fetching the page; crawl options are ignored. */
  text?: string | null;
  /** 0 reads only this page; 1-3 also read same-site pages it links to. */
  crawl_depth?: number;
  max_pages?: number;
  /** Look for fresh pages on this site when a question needs them. */
  live_lookup?: boolean;
};

export function addKnowledgeWebSource(
  userId: string,
  configId: string,
  payload: KnowledgeWebSourcePayload,
  options: ApiMutationOptions = {},
): Promise<KnowledgeSyncResult> {
  return addKnowledgeSource(userId, configId, "web-sources", payload, options);
}

/** Both linked-source kinds are fetched and indexed by one POST that returns the sync result. */
function addKnowledgeSource(
  userId: string,
  configId: string,
  kind: "web-sources" | "api-sources",
  payload: KnowledgeWebSourcePayload | KnowledgeApiSourcePayload,
  options: ApiMutationOptions,
): Promise<KnowledgeSyncResult> {
  return apiRequest<KnowledgeSyncResult>(userId, `/api/knowledge/${pathId(configId)}/${kind}`, {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export type KnowledgeApiSourcePayload = {
  name: string;
  base_url: string;
  /** Appended to base_url, e.g. "/v1/matters?status=open". */
  path?: string | null;
  method?: "GET" | "POST";
  /** "Name: value" lines sent with every request. Never put secrets here. */
  headers?: string | null;
  body?: string | null;
  auth_type: "none" | "api-key" | "bearer-token" | "oauth-client";
  secret_value?: string | null;
  credential_name?: string | null;
  credential_location?: "header" | "query";
  client_id?: string | null;
  authorization_url?: string | null;
  token_url?: string | null;
  scopes?: string[];
  audience?: string | null;
};

export function addKnowledgeApiSource(
  userId: string,
  configId: string,
  payload: KnowledgeApiSourcePayload,
  options: ApiMutationOptions = {},
): Promise<KnowledgeSyncResult> {
  return addKnowledgeSource(userId, configId, "api-sources", payload, options);
}

export type KnowledgeLimits = {
  upload_max_mb: number;
  max_extracted_chars: number;
  ocr_enabled: boolean;
  ocr_max_pages: number;
  semantic_search: "on" | "off" | string;
  /** The model that reads handwriting and images in this workspace, if any. */
  vision_ocr?: { available: boolean; model_name: string | null; max_pages: number };
  /** Server-side prefix of the OAuth callback; append /{id}/oauth/callback. */
  oauth_callback_base?: string;
};

export function getKnowledgeLimits(userId: string, options: ApiMutationOptions = {}): Promise<KnowledgeLimits> {
  return apiRequest<KnowledgeLimits>(userId, "/api/knowledge/limits", { signal: options.signal });
}

/** Semantic-index coverage; pending chunks are still being embedded. */
export function getKnowledgeIndexStatus(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<KnowledgeIndexStatus> {
  return apiRequest<KnowledgeIndexStatus>(userId, `/api/knowledge/${pathId(configId)}/index-status`, {
    signal: options.signal,
  });
}

/** Server-signed provider sign-in URL for a knowledge base's OAuth API source. */
export function getKnowledgeOAuthAuthorizeUrl(
  userId: string,
  configId: string,
  options: ApiMutationOptions = {},
): Promise<{ authorize_url: string; state: string }> {
  return apiRequest<{ authorize_url: string; state: string }>(
    userId,
    `/api/knowledge/${pathId(configId)}/oauth/authorize-url`,
    { signal: options.signal },
  );
}

/**
 * Upload one file with byte-level progress. fetch() cannot report upload
 * progress, so this uses XMLHttpRequest; the request and error handling
 * otherwise match the other knowledge calls.
 */
export function uploadKnowledgeFile(
  userId: string,
  configId: string,
  file: File,
  options: { signal?: AbortSignal; onUploadProgress?: (fraction: number) => void } = {},
): Promise<KnowledgeSyncResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${apiBase}/api/knowledge/${pathId(configId)}/documents`);
    Object.entries(authHeaders(userId)).forEach(([name, value]) => request.setRequestHeader(name, value));
    request.responseType = "text";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onUploadProgress?.(Math.min(1, event.loaded / event.total));
      }
    };
    request.upload.onload = () => options.onUploadProgress?.(1);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(JSON.parse(request.responseText) as KnowledgeSyncResult);
        } catch {
          reject(new ChatRequestError("The server finished the upload but sent an unreadable reply.", request.status));
        }
        return;
      }
      reject(new ChatRequestError(xhrErrorDetail(request), request.status));
    };
    request.onerror = () =>
      reject(new ChatRequestError("Could not upload the file. Check your connection and try again."));
    request.onabort = () => reject(new ChatRequestError("Upload cancelled."));
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new ChatRequestError("Upload cancelled."));
        return;
      }
      options.signal.addEventListener("abort", () => request.abort(), { once: true });
    }
    const form = new FormData();
    form.append("files", file);
    request.send(form);
  });
}

function xhrErrorDetail(request: XMLHttpRequest): string {
  const fallback = request.status === 413
    ? "The file is larger than the server accepts."
    : `Upload failed with ${request.status}`;
  try {
    const payload = JSON.parse(request.responseText) as { detail?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
    if (payload.detail !== undefined) return JSON.stringify(payload.detail);
  } catch {
    // Non-JSON error bodies (proxy pages) fall back to the status text.
  }
  return fallback;
}

export function knowledgeApiSourceOAuthCallbackUrl(configId: string): string {
  const path = `/api/knowledge/${pathId(configId)}/oauth/callback`;
  // Providers need an absolute redirect address; with a same-origin API the
  // page origin is the API origin.
  if (apiBase) return `${apiBase}${path}`;
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}

// ---------------------------------------------------------- document viewing

const VIEW_MODES: readonly string[] = ["pdf", "image", "text"] satisfies KnowledgeDocumentViewMode[];
const VIEW_NOTICES: readonly string[] = [
  "original_missing",
  "conversion_unavailable",
  "conversion_failed",
  "privacy_restricted",
] satisfies KnowledgeDocumentNotice[];

function documentPath(configId: string, documentId: string) {
  return `/api/knowledge/${pathId(configId)}/documents/${pathId(documentId)}`;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function pageOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function parseTarget(raw: unknown): KnowledgeDocumentTarget | null {
  if (!isRecord(raw)) return null;
  const page = pageOrNull(raw.page);
  return {
    page,
    page_end: pageOrNull(raw.page_end) ?? page,
    locator: textOrNull(raw.locator),
    excerpt: textOrNull(raw.excerpt) ?? "",
    chunk_id: textOrNull(raw.chunk_id),
    exact: raw.exact === true,
  };
}

function parseSegments(raw: unknown): KnowledgeDocumentSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((segment, index) => ({
    id: textOrNull(segment.id) ?? `segment-${index}`,
    page: pageOrNull(segment.page),
    locator: textOrNull(segment.locator),
    text: typeof segment.text === "string" ? segment.text : "",
  }));
}

/** Checks the view where it enters, so the viewer can trust its shape. */
export function parseKnowledgeDocumentView(raw: unknown): KnowledgeDocumentView {
  if (!isRecord(raw) || !VIEW_MODES.includes(String(raw.mode))) {
    throw new ChatRequestError("The document could not be read.");
  }
  return {
    document_id: String(raw.document_id ?? ""),
    knowledge_config_id: String(raw.knowledge_config_id ?? ""),
    name: textOrNull(raw.name) ?? "Document",
    content_type: textOrNull(raw.content_type) ?? "",
    mode: raw.mode as KnowledgeDocumentViewMode,
    file_url: textOrNull(raw.file_url),
    original_available: raw.original_available === true,
    page_count: pageOrNull(raw.page_count),
    target: parseTarget(raw.target),
    segments: parseSegments(raw.segments),
    notice: VIEW_NOTICES.includes(String(raw.notice)) ? (raw.notice as KnowledgeDocumentNotice) : null,
  };
}

/** What the viewer shows for a document, aimed at `chunkId` when given. */
export async function getKnowledgeDocumentView(
  userId: string,
  configId: string,
  documentId: string,
  options: ApiMutationOptions & { chunkId?: string | null } = {},
): Promise<KnowledgeDocumentView> {
  const query = options.chunkId ? `?chunk_id=${encodeURIComponent(options.chunkId)}` : "";
  const raw = await apiRequest<unknown>(userId, `${documentPath(configId, documentId)}/view${query}`, {
    signal: options.signal,
  });
  return parseKnowledgeDocumentView(raw);
}

/** The bytes the viewer renders. Built from the ids, never from a server or
 * citation URL, so nothing stored can steer this authenticated request. */
export function loadKnowledgeDocumentBytes(
  userId: string,
  configId: string,
  documentId: string,
  options: ApiMutationOptions = {},
): Promise<Blob> {
  return apiBlobRequest(userId, `${documentPath(configId, documentId)}/view/file`, options);
}

/** The file name a download response carries, or null. */
export function contentDispositionName(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // A malformed name falls through to the plain form.
    }
  }
  return /filename="?([^";]+)"?/.exec(header)?.[1]?.trim() ?? null;
}

export type OriginalFile = { blob: Blob; filename: string | null };

/** The stored upload, with the name the server gave it. */
export async function loadKnowledgeDocumentOriginal(
  userId: string,
  configId: string,
  documentId: string,
  options: ApiMutationOptions = {},
): Promise<OriginalFile> {
  const response = await apiFileRequest(userId, `${documentPath(configId, documentId)}/original`, options);
  return { blob: await response.blob(), filename: contentDispositionName(response.headers.get("Content-Disposition")) };
}

/** Finds the document behind a chunk, for citations saved before they carried
 * document ids. 404 when it is gone or out of this person's reach. */
export function locateKnowledgeChunk(
  userId: string,
  chunkId: string,
  options: ApiMutationOptions = {},
): Promise<KnowledgeChunkLocation> {
  return apiRequest<KnowledgeChunkLocation>(userId, `/api/knowledge/chunks/${pathId(chunkId)}/location`, {
    signal: options.signal,
  });
}
