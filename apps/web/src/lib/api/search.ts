import { apiRequest, type ApiMutationOptions } from "./http";

/**
 * Mirrors the actor-scoped global search contract in
 * services/api/app/routes/search.py (GlobalSearchResponse). The backend owns
 * section membership, ordering, and each result's routing target.
 */
export type GlobalSearchKind =
  | "chat"
  | "knowledge"
  | "review"
  | "agent"
  | "automation"
  | "matter"
  | "draft";

/**
 * Backend-provided routing target. Keys vary by kind (`view` plus e.g.
 * `thread_id`, `draft_id`, `matrix_id`); the interface must route from this
 * object instead of inventing client-only paths.
 */
export type SearchNavigation = Record<string, string>;

export type GlobalSearchHit = {
  id: string;
  kind: GlobalSearchKind;
  title: string;
  snippet: string;
  score: number;
  navigation: SearchNavigation;
  metadata: Record<string, unknown>;
};

export type GlobalSearchSection = {
  kind: GlobalSearchKind;
  title: string;
  results: GlobalSearchHit[];
};

export type GlobalSearchResponse = {
  query: string;
  sections: GlobalSearchSection[];
};

export type GlobalSearchOptions = ApiMutationOptions & {
  /** Active tenant slug required when a platform owner searches tenant work. */
  tenantSlug?: string;
};

/** Searches the actor's workspace records. `limit` caps results per section (1-25). */
export function globalSearch(
  userId: string,
  query: string,
  limit = 8,
  options: GlobalSearchOptions = {},
): Promise<GlobalSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return apiRequest<GlobalSearchResponse>(userId, `/api/search?${params.toString()}`, {
    signal: options.signal,
    headers: options.tenantSlug ? { "X-Aperture-Tenant": options.tenantSlug } : undefined,
  });
}
