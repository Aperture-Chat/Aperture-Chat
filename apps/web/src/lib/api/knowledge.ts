import {
  apiBase,
  authHeaders,
  apiRequest,
  readApiError,
  pathId,
  ChatRequestError,
  type ApiMutationOptions,
} from "./http";
import type { KnowledgeDocument, KnowledgeIndexStatus, KnowledgeSyncResult } from "../types";

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

export function addKnowledgeWebSource(
  userId: string,
  configId: string,
  payload: { name: string; url: string; text?: string | null },
  options: ApiMutationOptions = {},
): Promise<KnowledgeSyncResult> {
  return apiRequest<KnowledgeSyncResult>(userId, `/api/knowledge/${pathId(configId)}/web-sources`, {
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
  return apiRequest<KnowledgeSyncResult>(userId, `/api/knowledge/${pathId(configId)}/api-sources`, {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export type KnowledgeLimits = {
  upload_max_mb: number;
  max_extracted_chars: number;
  ocr_enabled: boolean;
  ocr_max_pages: number;
  semantic_search: "on" | "off" | string;
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
