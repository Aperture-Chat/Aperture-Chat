import {
  apiBase,
  authHeaders,
  apiRequest,
  readApiError,
  pathId,
  ChatRequestError,
  type ApiMutationOptions,
} from "./http";
import type { KnowledgeDocument, KnowledgeSyncResult } from "../types";

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

export function addKnowledgeApiSource(
  userId: string,
  configId: string,
  payload: {
    name: string;
    base_url: string;
    auth_type?: string;
    secret_value?: string | null;
    description?: string | null;
    source_label?: string | null;
    resource_id?: string | null;
    request_method?: string | null;
    header_notes?: string | null;
    credential_name?: string | null;
    credential_location?: string | null;
    client_id?: string | null;
    authorization_url?: string | null;
    token_url?: string | null;
    callback_url?: string | null;
    scopes?: string[];
    audience?: string | null;
  },
  options: ApiMutationOptions = {},
): Promise<KnowledgeSyncResult> {
  return apiRequest<KnowledgeSyncResult>(userId, `/api/knowledge/${pathId(configId)}/api-sources`, {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function knowledgeApiSourceOAuthCallbackUrl(configId: string): string {
  return `${apiBase}/api/knowledge/${pathId(configId)}/oauth/callback`;
}
