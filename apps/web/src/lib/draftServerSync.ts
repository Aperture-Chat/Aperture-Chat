/**
 * Scoped local draft cache + server merge helpers for the Drafts workspace.
 *
 * Persistence is server-first: the server copy (services/api drafts routes) is
 * the durable record, and localStorage is only a per-tenant, per-user working
 * cache under `aperture-drafts-cache-v2:<tenantId>:<userId>`.
 *
 * The legacy unscoped `aperture-document-history-v1` key predates per-account
 * scoping, so its entries may belong to a different person who used this
 * browser. That history is quarantined: it is read-only here and must NEVER be
 * uploaded under the signed-in identity without an explicit, per-entry user
 * confirmation that names the account it would be imported into.
 */
import type { DraftDocument } from "./api/drafts";

export const SCOPED_DRAFT_CACHE_KEY_PREFIX = "aperture-drafts-cache-v2";
export const LEGACY_DRAFT_HISTORY_STORAGE_KEY = "aperture-document-history-v1";
export const SCOPED_DRAFT_CACHE_LIMIT = 24;

export type DraftCacheScope = {
  tenantId: string;
  userId: string;
};

/** Server-sync bookkeeping carried on each cached entry. */
export type DraftSyncFields = {
  /** Server-assigned draft id; missing/null means the entry is local only. */
  serverId?: string | null;
  /** The server revision that the cached `content` corresponds to. Used as the
   * CAS `expected_revision` — never advanced without fetching the content. */
  serverRevision?: number | null;
  /** True when the server copy advanced past the cached content (edited from
   * another device/session); restoring must fetch the server copy first. */
  serverContentStale?: boolean;
};

type CacheEntryBase = DraftSyncFields & {
  id: string;
  updatedAt?: string;
};

export function scopedDraftCacheKey(scope: DraftCacheScope): string {
  // Component ids are URI-encoded so a ":" inside a tenant or user id can
  // never collide with another scope's key.
  return `${SCOPED_DRAFT_CACHE_KEY_PREFIX}:${encodeURIComponent(scope.tenantId)}:${encodeURIComponent(scope.userId)}`;
}

/** Reads only the scoped cache; never falls back to the legacy unscoped key. */
export function loadScopedDraftCache<T>(
  scope: DraftCacheScope,
  isEntry: (value: unknown) => value is T,
): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(scopedDraftCacheKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, SCOPED_DRAFT_CACHE_LIMIT);
  } catch {
    return [];
  }
}

/** Returns false when the browser refused the write (private browsing, or a
 * quota exceeded by image-heavy decks) so callers can say so instead of
 * showing a "saved" state that never happened. */
export function saveScopedDraftCache(scope: DraftCacheScope, entries: unknown[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(
      scopedDraftCacheKey(scope),
      JSON.stringify(entries.slice(0, SCOPED_DRAFT_CACHE_LIMIT)),
    );
    return true;
  } catch {
    // Private-browsing storage failures leave the in-memory state authoritative.
    return false;
  }
}

/**
 * Read-only view of the legacy unscoped history. Loading never migrates,
 * copies, or uploads anything — imports require an explicit user confirmation
 * handled by the caller.
 */
export function loadLegacyDraftHistory<T>(isEntry: (value: unknown) => value is T): T[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LEGACY_DRAFT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

/** Removes one entry from the legacy key after a confirmed, successful import
 * so the same draft is not offered for import twice. Other entries stay put. */
export function removeLegacyDraftHistoryEntry(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(LEGACY_DRAFT_HISTORY_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    const remaining = parsed.filter(
      (entry) => !entry || typeof entry !== "object" || (entry as { id?: unknown }).id !== id,
    );
    if (remaining.length === 0) {
      window.localStorage.removeItem(LEGACY_DRAFT_HISTORY_STORAGE_KEY);
    } else {
      window.localStorage.setItem(LEGACY_DRAFT_HISTORY_STORAGE_KEY, JSON.stringify(remaining));
    }
  } catch {
    // Leaving the legacy entry in place is safe; it stays quarantined.
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Merges the server draft summary list into the scoped cache:
 *
 * - a cached entry bound to a listed server draft keeps its full-fidelity
 *   local content; when the server revision is ahead, the entry is flagged
 *   `serverContentStale` (server wins — restore must fetch) without advancing
 *   `serverRevision`, so a stale save still CAS-fails instead of overwriting;
 * - listed server drafts with no cached entry become stubs via
 *   `makeServerEntry` (content fetched on restore);
 * - cached entries the server does not list (local-only, or outside the list
 *   window) are preserved as they are.
 */
export function mergeServerDraftsIntoCache<T extends CacheEntryBase>(
  cached: T[],
  server: DraftDocument[],
  makeServerEntry: (doc: DraftDocument) => T,
): T[] {
  const byServerId = new Map<string, T>();
  for (const entry of cached) {
    if (entry.serverId) byServerId.set(entry.serverId, entry);
  }
  const merged: T[] = [];
  for (const doc of server) {
    const existing = byServerId.get(doc.id);
    if (!existing) {
      merged.push(makeServerEntry(doc));
      continue;
    }
    const knownRevision = existing.serverRevision ?? 0;
    if (doc.current_revision > knownRevision) {
      // Cast: spreading a generic narrows literal fields; entries only ever
      // gain the DraftSyncFields updated here.
      merged.push({
        ...existing,
        title: doc.title,
        updatedAt: doc.updated_at,
        serverContentStale: true,
      } as T);
    } else {
      merged.push({ ...existing, serverContentStale: false } as T);
    }
  }
  const listedServerIds = new Set(server.map((doc) => doc.id));
  for (const entry of cached) {
    if (!entry.serverId || !listedServerIds.has(entry.serverId)) merged.push(entry);
  }
  return merged
    .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""))
    .slice(0, SCOPED_DRAFT_CACHE_LIMIT);
}
