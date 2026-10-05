import { apiBase, apiRequest, authHeaders, ChatRequestError, pathId, readApiError } from "./http";
import type {
  PrivacyCategory,
  PrivacyDetectorCatalog,
  PrivacyPreviewResponse,
  TenantPrivacyPolicy,
  TenantPrivacyPolicyUpdateRequest,
  TrainingCapturePolicy,
  TrainingCapturePolicyUpdateRequest,
  TrainingDataset,
  TrainingDatasetWriteRequest,
  TrainingExample,
  TrainingExampleStatus,
  TrainingOverview,
  TrainingSignal,
  TrainingTaxonomy,
} from "../types";

// Personal-data protection ------------------------------------------------

export function getPrivacyPolicy(userId: string): Promise<TenantPrivacyPolicy> {
  return apiRequest(userId, "/api/admin/privacy/policy");
}

export function updatePrivacyPolicy(
  userId: string,
  payload: TenantPrivacyPolicyUpdateRequest,
): Promise<TenantPrivacyPolicy> {
  return apiRequest(userId, "/api/admin/privacy/policy", {
    method: "PATCH",
    body: payload,
  });
}

export function getPrivacyDetectors(userId: string): Promise<PrivacyDetectorCatalog> {
  return apiRequest(userId, "/api/admin/privacy/detectors");
}

export function previewPrivacy(
  userId: string,
  sample: string,
  categories?: PrivacyCategory[],
): Promise<PrivacyPreviewResponse> {
  return apiRequest(userId, "/api/admin/privacy/preview", {
    method: "POST",
    body: { sample, categories: categories ?? null },
  });
}

// Training datasets -------------------------------------------------------

export function getTrainingPolicy(userId: string): Promise<TrainingCapturePolicy> {
  return apiRequest(userId, "/api/admin/training/policy");
}

export function updateTrainingPolicy(
  userId: string,
  payload: TrainingCapturePolicyUpdateRequest,
): Promise<TrainingCapturePolicy> {
  return apiRequest(userId, "/api/admin/training/policy", {
    method: "PATCH",
    body: payload,
  });
}

export function getTrainingTaxonomy(userId: string): Promise<TrainingTaxonomy> {
  return apiRequest(userId, "/api/admin/training/taxonomy");
}

export function getTrainingOverview(userId: string): Promise<TrainingOverview> {
  return apiRequest(userId, "/api/admin/training/overview");
}

export function createTrainingDataset(userId: string, payload: TrainingDatasetWriteRequest): Promise<TrainingDataset> {
  return apiRequest(userId, "/api/admin/training/datasets", {
    method: "POST",
    body: payload,
  });
}

export function updateTrainingDataset(
  userId: string,
  datasetId: string,
  payload: TrainingDatasetWriteRequest,
): Promise<TrainingDataset> {
  return apiRequest(userId, `/api/admin/training/datasets/${pathId(datasetId)}`, { method: "PUT", body: payload });
}

export function deleteTrainingDataset(userId: string, datasetId: string): Promise<{ status: string; id: string }> {
  return apiRequest(userId, `/api/admin/training/datasets/${pathId(datasetId)}`, { method: "DELETE" });
}

export type TrainingExampleQuery = {
  status?: TrainingExampleStatus;
  signal?: TrainingSignal;
  datasetId?: string;
  practiceArea?: string;
  unrouted?: boolean;
  limit?: number;
  offset?: number;
};

export function listTrainingExamples(
  userId: string,
  query: TrainingExampleQuery = {},
): Promise<{ total: number; items: TrainingExample[] }> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.signal) params.set("signal", query.signal);
  if (query.datasetId) params.set("dataset_id", query.datasetId);
  if (query.practiceArea !== undefined) params.set("practice_area", query.practiceArea);
  if (query.unrouted) params.set("unrouted", "true");
  params.set("limit", String(query.limit ?? 100));
  params.set("offset", String(query.offset ?? 0));
  return apiRequest(userId, `/api/admin/training/examples?${params.toString()}`);
}

export function reviewTrainingExamples(
  userId: string,
  exampleIds: string[],
  status: TrainingExampleStatus,
): Promise<{ reviewed: number }> {
  return apiRequest(userId, "/api/admin/training/examples/review", {
    method: "POST",
    body: { example_ids: exampleIds, status },
  });
}

export function scanTrainingChats(
  userId: string,
  after = "",
): Promise<{ scanned: number; captured: number; next_after: string | null }> {
  return apiRequest(userId, `/api/admin/training/scan?after=${encodeURIComponent(after)}`, { method: "POST" });
}

/** Downloads a dataset bundle (ZIP). The server audits every export. */
export async function downloadTrainingDataset(
  userId: string,
  datasetId: string,
  includePending: boolean,
): Promise<{ blob: Blob; filename: string }> {
  let response: Response;
  try {
    response = await fetch(
      `${apiBase}/api/admin/training/datasets/${pathId(datasetId)}/export?include_pending=${includePending}`,
      { headers: authHeaders(userId) },
    );
  } catch {
    throw new ChatRequestError("Could not reach the API. Check your connection and try again.");
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return {
    blob: await response.blob(),
    filename: match?.[1] ?? "training-dataset.zip",
  };
}
