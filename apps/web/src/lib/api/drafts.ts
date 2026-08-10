/**
 * Private draft persistence API client.
 *
 * Mirrors the durable backend contract in services/api/app/routes/matters.py
 * (drafts section) and services/api/app/models/matters.py. Drafts are private
 * to their owner and scoped to one tenant:
 *
 * - the server assigns every draft id (POST never accepts caller-chosen ids);
 * - updates are compare-and-set via `expected_revision` and return 409 when
 *   the draft advanced elsewhere — callers must surface that honestly, never
 *   silently overwrite;
 * - omitting `matter_id` on update preserves the current matter binding, and
 *   an explicit `null` clears it (JSON.stringify drops undefined keys, which
 *   matches the backend's model_fields_set semantics);
 * - content is canonicalized server-side through the sanitized-html-v1
 *   allowlist and bounded at 2,000,000 UTF-8 bytes / 200 revisions.
 *
 * Platform owners must send `X-Aperture-Tenant` (the backend returns 400
 * without it); tenant-scoped users may omit it.
 */
import { apiRequest, pathId, ChatRequestError } from "./http";

/** Server-enforced limits (app/models/matters.py). */
export const MAX_DRAFT_TITLE_CHARS = 240;
export const MAX_DRAFT_CONTENT_BYTES = 2_000_000;
export const MAX_DRAFT_REVISIONS = 200;
export const MAX_DRAFT_LIST_LIMIT = 200;
export const DRAFT_SANITIZER_VERSION = "sanitized-html-v1";

export type DraftDocument = {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  /** Nullable matter binding; membership rules are enforced server-side. */
  matter_id: string | null;
  title: string;
  /** CAS token — send back as expected_revision on every update. */
  current_revision: number;
  created_at: string;
  updated_at: string;
};

export type DraftRevision = {
  draft_id: string;
  tenant_id: string;
  owner_user_id: string;
  revision: number;
  title: string;
  /** Canonical sanitized HTML — bounded, non-executable markup. */
  content: string;
  content_sha256: string;
  sanitizer_version: string;
  created_at: string;
};

export type DraftSnapshot = {
  document: DraftDocument;
  revision: DraftRevision;
};

export type DraftRevisionCapacity = {
  current_revision: number;
  max_revisions: number;
  remaining_revisions: number;
};

export type DraftCreatePayload = {
  title: string;
  content: string;
  matter_id?: string | null;
};

/**
 * CAS update. Omitting `matter_id` preserves the existing matter assignment;
 * sending an explicit `null` clears it. Never include the key unless the user
 * explicitly changed the assignment.
 */
export type DraftUpdatePayload = {
  expected_revision: number;
  title?: string;
  content?: string;
  matter_id?: string | null;
};

export type DraftRequestOptions = {
  signal?: AbortSignal;
  /**
   * Sets `X-Aperture-Tenant`. REQUIRED for platform owners (the backend
   * returns 400 without it); optional for tenant users, whose own tenant
   * scope always wins.
   */
  tenantSlug?: string;
};

export type DraftListOptions = DraftRequestOptions & {
  matterId?: string;
  limit?: number;
  offset?: number;
};

function draftHeaders(options: DraftRequestOptions): Record<string, string> | undefined {
  const slug = options.tenantSlug?.trim();
  return slug ? { "X-Aperture-Tenant": slug } : undefined;
}

/** True when a save was rejected because the draft advanced elsewhere (or the
 * revision cap was reached) — both surface as 409 and require user choice. */
export function isDraftConflictError(error: unknown): boolean {
  return error instanceof ChatRequestError && error.status === 409;
}

/** Summary list only — content requires getDraft per id. */
export function listDrafts(
  userId: string,
  options: DraftListOptions = {},
): Promise<DraftDocument[]> {
  const query = new URLSearchParams();
  if (options.matterId) query.set("matter_id", options.matterId);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.offset !== undefined) query.set("offset", String(options.offset));
  const encoded = query.toString();
  const suffix = encoded ? `?${encoded}` : "";
  return apiRequest<DraftDocument[]>(userId, `/api/drafts${suffix}`, {
    signal: options.signal,
    headers: draftHeaders(options),
  });
}

/** Bounded recoverable HTML for one draft (document + current revision). */
export function getDraft(
  userId: string,
  draftId: string,
  options: DraftRequestOptions = {},
): Promise<DraftSnapshot> {
  return apiRequest<DraftSnapshot>(userId, `/api/drafts/${pathId(draftId)}`, {
    signal: options.signal,
    headers: draftHeaders(options),
  });
}

/** The server assigns the draft id; callers must store the returned id. */
export function createDraft(
  userId: string,
  payload: DraftCreatePayload,
  options: DraftRequestOptions = {},
): Promise<DraftSnapshot> {
  return apiRequest<DraftSnapshot>(userId, "/api/drafts", {
    method: "POST",
    body: payload,
    signal: options.signal,
    headers: draftHeaders(options),
  });
}

export function updateDraft(
  userId: string,
  draftId: string,
  payload: DraftUpdatePayload,
  options: DraftRequestOptions = {},
): Promise<DraftSnapshot> {
  return apiRequest<DraftSnapshot>(userId, `/api/drafts/${pathId(draftId)}`, {
    method: "PUT",
    body: payload,
    signal: options.signal,
    headers: draftHeaders(options),
  });
}

export function getDraftCapacity(
  userId: string,
  draftId: string,
  options: DraftRequestOptions = {},
): Promise<DraftRevisionCapacity> {
  return apiRequest<DraftRevisionCapacity>(
    userId,
    `/api/drafts/${pathId(draftId)}/capacity`,
    { signal: options.signal, headers: draftHeaders(options) },
  );
}
