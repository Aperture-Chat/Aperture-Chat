import { apiRequest, type ApiMutationOptions } from "./http";
import type {
  AdminModelAccessRequestView,
  ModelAccessDecision,
  ModelAccessRequest,
  ModelAccessRequestResolution,
  ModelCatalogEntry,
  ModelCatalogResponse,
  UserModelAccessTrace,
} from "../types";

/**
 * Explainable model access (services/api/app/routes/model_access.py). The
 * server owns every reason string; the interface renders them verbatim and
 * never derives entitlement from the catalog list.
 */

export function loadModelCatalog(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<ModelCatalogResponse> {
  return apiRequest<ModelCatalogResponse>(userId, "/api/me/model-catalog", { signal: options.signal });
}

export function explainModelAccess(userId: string, modelId: string): Promise<ModelAccessDecision> {
  return apiRequest<ModelAccessDecision>(userId, `/api/me/model-access/${encodeURIComponent(modelId)}`);
}

export function createModelAccessRequest(
  userId: string,
  payload: { model_id: string; note?: string | null },
): Promise<ModelCatalogEntry> {
  return apiRequest<ModelCatalogEntry>(userId, "/api/me/model-access-requests", {
    method: "POST",
    body: payload,
  });
}

export function withdrawModelAccessRequest(userId: string, requestId: string): Promise<ModelAccessRequest> {
  return apiRequest<ModelAccessRequest>(
    userId,
    `/api/me/model-access-requests/${encodeURIComponent(requestId)}`,
    { method: "DELETE" },
  );
}

export function listAdminModelAccessRequests(
  userId: string,
  options: { status?: "pending" | "approved" | "declined" | "withdrawn"; tenantSlug?: string } = {},
): Promise<AdminModelAccessRequestView[]> {
  const params = new URLSearchParams({ status: options.status ?? "pending" });
  return apiRequest<AdminModelAccessRequestView[]>(
    userId,
    `/api/admin/model-access-requests?${params.toString()}`,
    { headers: options.tenantSlug ? { "X-Aperture-Tenant": options.tenantSlug } : undefined },
  );
}

export function approveModelAccessRequest(
  userId: string,
  requestId: string,
  payload: { group_id: string; note?: string | null },
): Promise<ModelAccessRequestResolution> {
  return apiRequest<ModelAccessRequestResolution>(
    userId,
    `/api/admin/model-access-requests/${encodeURIComponent(requestId)}/approve`,
    { method: "POST", body: payload },
  );
}

export function declineModelAccessRequest(
  userId: string,
  requestId: string,
  payload: { note?: string | null } = {},
): Promise<ModelAccessRequestResolution> {
  return apiRequest<ModelAccessRequestResolution>(
    userId,
    `/api/admin/model-access-requests/${encodeURIComponent(requestId)}/decline`,
    { method: "POST", body: payload },
  );
}

export function traceUserModelAccess(userId: string, targetUserId: string): Promise<UserModelAccessTrace> {
  return apiRequest<UserModelAccessTrace>(
    userId,
    `/api/admin/users/${encodeURIComponent(targetUserId)}/model-access`,
  );
}
