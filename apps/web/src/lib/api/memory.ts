/**
 * Personalization memory client.
 *
 * The user-facing endpoints only ever touch the caller's own memories; the
 * admin endpoints return policy and counts and never memory content.
 */
import { apiRequest, pathId, type ApiMutationOptions } from "./http";
import type {
  MemoryCollection,
  MemoryUserStat,
  TenantMemoryPolicy,
  TenantMemoryPolicyUpdateRequest,
  UserMemory,
  UserMemoryCreateRequest,
  UserMemorySettings,
  UserMemorySettingsUpdateRequest,
  UserMemoryUpdateRequest,
} from "../types";

export function listMemories(userId: string, options: ApiMutationOptions = {}): Promise<MemoryCollection> {
  return apiRequest<MemoryCollection>(userId, "/api/memory", { signal: options.signal });
}

export function createMemory(
  userId: string,
  payload: UserMemoryCreateRequest,
  options: ApiMutationOptions = {},
): Promise<UserMemory> {
  return apiRequest<UserMemory>(userId, "/api/memory", {
    method: "POST",
    body: payload,
    signal: options.signal,
  });
}

export function updateMemory(
  userId: string,
  memoryId: string,
  payload: UserMemoryUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<UserMemory> {
  return apiRequest<UserMemory>(userId, `/api/memory/${pathId(memoryId)}`, {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function deleteMemory(
  userId: string,
  memoryId: string,
  options: ApiMutationOptions = {},
): Promise<void> {
  return apiRequest<void>(userId, `/api/memory/${pathId(memoryId)}`, {
    method: "DELETE",
    signal: options.signal,
  });
}

export function purgeMemories(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<{ removed: number }> {
  return apiRequest<{ removed: number }>(userId, "/api/memory/purge", {
    method: "POST",
    signal: options.signal,
  });
}

export function getMemorySettings(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<UserMemorySettings> {
  return apiRequest<UserMemorySettings>(userId, "/api/memory/settings", { signal: options.signal });
}

export function updateMemorySettings(
  userId: string,
  payload: UserMemorySettingsUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<UserMemorySettings> {
  return apiRequest<UserMemorySettings>(userId, "/api/memory/settings", {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

// --- admin: content-free policy, counts, and compliance purge --------------

export function getMemoryPolicy(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<TenantMemoryPolicy> {
  return apiRequest<TenantMemoryPolicy>(userId, "/api/admin/memory/policy", { signal: options.signal });
}

export function updateMemoryPolicy(
  userId: string,
  payload: TenantMemoryPolicyUpdateRequest,
  options: ApiMutationOptions = {},
): Promise<TenantMemoryPolicy> {
  return apiRequest<TenantMemoryPolicy>(userId, "/api/admin/memory/policy", {
    method: "PATCH",
    body: payload,
    signal: options.signal,
  });
}

export function getMemoryStats(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<MemoryUserStat[]> {
  return apiRequest<MemoryUserStat[]>(userId, "/api/admin/memory/stats", { signal: options.signal });
}

export function purgeUserMemories(
  userId: string,
  targetUserId: string,
  options: ApiMutationOptions = {},
): Promise<{ removed: number }> {
  return apiRequest<{ removed: number }>(
    userId,
    `/api/admin/memory/users/${pathId(targetUserId)}/purge`,
    { method: "POST", signal: options.signal },
  );
}
