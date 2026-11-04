/**
 * Matters API client (services/api/app/routes/matters.py).
 *
 * Every call is membership-gated on the server: a person lists, creates, and
 * links only their own matters, and linking never widens who can open a chat
 * or a knowledge base. Platform owners must name the tenant they are working
 * in with `X-Aperture-Tenant`; tenant users' own tenant always wins.
 */

import type { BootstrapData } from "../types";
import { matterChangeSteps, type Matter, type MatterResourceType } from "../matters";
import { apiRequest, pathId, tenantHeaders, type ApiMutationOptions } from "./http";

/** Server cap on one page of matters (MAX_DRAFT_LIST_LIMIT). */
const MATTER_PAGE_LIMIT = 200;

export type MatterRequestOptions = ApiMutationOptions & { tenantSlug?: string };

/** The tenant a platform owner is viewing; tenant users send none. */
export function matterTenantSlug(data: Pick<BootstrapData, "me" | "currentTenant">): string | undefined {
  return data.me.role === "PLATFORM_OWNER" ? data.currentTenant?.slug : undefined;
}

/** This person's matters, most recently changed first. */
export function listMatters(userId: string, options: MatterRequestOptions = {}): Promise<Matter[]> {
  return apiRequest<Matter[]>(userId, `/api/matters?limit=${MATTER_PAGE_LIMIT}`, {
    signal: options.signal,
    headers: tenantHeaders(options.tenantSlug),
  });
}

export function createMatter(userId: string, name: string, options: MatterRequestOptions = {}): Promise<Matter> {
  return apiRequest<Matter>(userId, "/api/matters", {
    method: "POST",
    body: { name },
    signal: options.signal,
    headers: tenantHeaders(options.tenantSlug),
  });
}

function resourcePath(matterId: string, type: MatterResourceType, resourceId: string) {
  return `/api/matters/${pathId(matterId)}/resources/${type}/${pathId(resourceId)}`;
}

/**
 * Moves one chat or knowledge base from its current matter (or none) to the
 * next one (or none), unlinking before linking as the server requires.
 */
export async function changeResourceMatter(
  userId: string,
  type: MatterResourceType,
  resourceId: string,
  current: string | null,
  next: string | null,
  options: MatterRequestOptions = {},
): Promise<void> {
  for (const step of matterChangeSteps(current, next)) {
    await apiRequest(userId, resourcePath(step.matterId, type, resourceId), {
      method: step.op === "assign" ? "PUT" : "DELETE",
      signal: options.signal,
      headers: tenantHeaders(options.tenantSlug),
    });
  }
}
