import type {
  IssueReportDetail,
  IssueReportListItem,
  IssueReportQueue,
  IssueReportRecord,
  IssueReportSubmission,
  IssueReportUpdateRequest,
  IssueReportUpstreamDraft,
  SupportHubQueue,
  SupportHubReport,
  SupportHubStatus,
  SupportSettings,
  SupportSettingsUpdateRequest,
} from "../types";
import {
  apiBase,
  apiRequest,
  authHeaders,
  ChatRequestError,
  pathId,
  readApiError,
  type ApiMutationOptions,
} from "./http";

export function submitIssueReport(
  userId: string,
  payload: Partial<IssueReportSubmission> & { subject: string; body: string },
  options: ApiMutationOptions = {},
): Promise<IssueReportRecord> {
  const form = new FormData();
  form.append("subject", payload.subject);
  form.append("body", payload.body);
  if (payload.kind) form.append("kind", payload.kind);
  if (payload.priority) form.append("priority", payload.priority);
  if (payload.diagnostics) form.append("diagnostics", JSON.stringify(payload.diagnostics));
  if (payload.screenshot) form.append("screenshot", payload.screenshot);
  return issueReportFetch<IssueReportRecord>(userId, "/api/issue-reports", {
    method: "POST",
    body: form,
    signal: options.signal,
  });
}

// --- The reporter's own tickets ---------------------------------------------------

export function listMyIssueReports(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<IssueReportListItem[]> {
  return apiRequest<IssueReportListItem[]>(userId, "/api/issue-reports/mine", {
    signal: options.signal,
  });
}

export function getMyIssueReport(
  userId: string,
  reportId: string,
  options: ApiMutationOptions = {},
): Promise<IssueReportDetail> {
  return apiRequest<IssueReportDetail>(userId, `/api/issue-reports/mine/${pathId(reportId)}`, {
    signal: options.signal,
  });
}

export function markMyIssueReportSeen(userId: string, reportId: string): Promise<void> {
  return apiRequest<void>(userId, `/api/issue-reports/mine/${pathId(reportId)}/seen`, {
    method: "POST",
  });
}

export function replyToMyIssueReport(
  userId: string,
  reportId: string,
  body: string,
): Promise<IssueReportDetail> {
  return apiRequest<IssueReportDetail>(
    userId,
    `/api/issue-reports/mine/${pathId(reportId)}/comments`,
    { method: "POST", body: { body } },
  );
}

export function reopenMyIssueReport(
  userId: string,
  reportId: string,
  body: string,
): Promise<IssueReportDetail> {
  return apiRequest<IssueReportDetail>(
    userId,
    `/api/issue-reports/mine/${pathId(reportId)}/reopen`,
    { method: "POST", body: { body } },
  );
}

export function getMyIssueReportScreenshot(userId: string, reportId: string): Promise<Blob> {
  return blobRequest(userId, `/api/issue-reports/mine/${pathId(reportId)}/screenshot`);
}

// --- Admin and owner triage --------------------------------------------------------

export function listAdminIssueReports(
  userId: string,
  options: ApiMutationOptions & { limit?: number } = {},
): Promise<IssueReportListItem[]> {
  const query = options.limit ? `?limit=${encodeURIComponent(options.limit)}` : "";
  return apiRequest<IssueReportListItem[]>(userId, `/api/admin/issue-reports${query}`, {
    signal: options.signal,
  });
}

export function getAdminIssueReportQueue(
  userId: string,
  options: ApiMutationOptions = {},
): Promise<IssueReportQueue> {
  return apiRequest<IssueReportQueue>(userId, "/api/admin/issue-reports/queue", {
    signal: options.signal,
  });
}

export function getAdminIssueReport(
  userId: string,
  reportId: string,
  options: ApiMutationOptions = {},
): Promise<IssueReportDetail> {
  return apiRequest<IssueReportDetail>(userId, `/api/admin/issue-reports/${pathId(reportId)}`, {
    signal: options.signal,
  });
}

export function updateAdminIssueReport(
  userId: string,
  reportId: string,
  patch: IssueReportUpdateRequest,
): Promise<IssueReportDetail> {
  return apiRequest<IssueReportDetail>(userId, `/api/admin/issue-reports/${pathId(reportId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function commentOnAdminIssueReport(
  userId: string,
  reportId: string,
  payload: { body: string; visibility: "public" | "internal" },
): Promise<IssueReportDetail> {
  return apiRequest<IssueReportDetail>(
    userId,
    `/api/admin/issue-reports/${pathId(reportId)}/comments`,
    { method: "POST", body: payload },
  );
}

export function getAdminIssueReportScreenshot(
  userId: string,
  reportId: string,
  options: ApiMutationOptions = {},
): Promise<Blob> {
  return blobRequest(userId, `/api/admin/issue-reports/${pathId(reportId)}/screenshot`, options);
}

export function draftIssueReportUpstream(
  userId: string,
  reportId: string,
  payload: { use_ai?: boolean; include_diagnostics?: boolean },
): Promise<IssueReportUpstreamDraft> {
  return apiRequest<IssueReportUpstreamDraft>(
    userId,
    `/api/admin/issue-reports/${pathId(reportId)}/upstream/draft`,
    { method: "POST", body: payload },
  );
}

export function shareIssueReportUpstream(
  userId: string,
  reportId: string,
  payload: { title: string; body: string; include_diagnostics: boolean },
): Promise<IssueReportDetail> {
  return apiRequest<IssueReportDetail>(
    userId,
    `/api/admin/issue-reports/${pathId(reportId)}/upstream`,
    { method: "POST", body: payload },
  );
}

export function refreshIssueReportUpstream(
  userId: string,
  reportId: string,
): Promise<IssueReportDetail> {
  return apiRequest<IssueReportDetail>(
    userId,
    `/api/admin/issue-reports/${pathId(reportId)}/upstream/refresh`,
    { method: "POST" },
  );
}

// --- Owner support settings and the community hub ------------------------------------

export function getSupportSettings(userId: string): Promise<SupportSettings> {
  return apiRequest<SupportSettings>(userId, "/api/platform/support/settings");
}

export function updateSupportSettings(
  userId: string,
  patch: SupportSettingsUpdateRequest,
): Promise<SupportSettings> {
  return apiRequest<SupportSettings>(userId, "/api/platform/support/settings", {
    method: "PATCH",
    body: patch,
  });
}

export function getSupportHubStatus(userId: string): Promise<SupportHubStatus> {
  return apiRequest<SupportHubStatus>(userId, "/api/platform/support/hub-status");
}

export function listSupportHubReports(userId: string): Promise<SupportHubQueue> {
  return apiRequest<SupportHubQueue>(userId, "/api/platform/support-hub/reports");
}

export function previewSupportHubReport(
  userId: string,
  reportId: string,
): Promise<{ markdown: string }> {
  return apiRequest<{ markdown: string }>(
    userId,
    `/api/platform/support-hub/reports/${pathId(reportId)}/preview`,
  );
}

export function publishSupportHubReport(
  userId: string,
  reportId: string,
  payload: { title: string; body: string; labels: string[] },
): Promise<SupportHubReport> {
  return apiRequest<SupportHubReport>(
    userId,
    `/api/platform/support-hub/reports/${pathId(reportId)}/publish`,
    { method: "POST", body: payload },
  );
}

export function linkSupportHubReport(
  userId: string,
  reportId: string,
  payload: { issue_number: number; comment: string },
): Promise<SupportHubReport> {
  return apiRequest<SupportHubReport>(
    userId,
    `/api/platform/support-hub/reports/${pathId(reportId)}/link`,
    { method: "POST", body: payload },
  );
}

export function declineSupportHubReport(
  userId: string,
  reportId: string,
  payload: { reason: string; spam: boolean },
): Promise<SupportHubReport> {
  return apiRequest<SupportHubReport>(
    userId,
    `/api/platform/support-hub/reports/${pathId(reportId)}/decline`,
    { method: "POST", body: payload },
  );
}

export function requeueSupportHubReport(userId: string, reportId: string): Promise<SupportHubReport> {
  return apiRequest<SupportHubReport>(
    userId,
    `/api/platform/support-hub/reports/${pathId(reportId)}/requeue`,
    { method: "POST" },
  );
}

export function triageSupportHubReport(userId: string, reportId: string): Promise<SupportHubReport> {
  return apiRequest<SupportHubReport>(
    userId,
    `/api/platform/support-hub/reports/${pathId(reportId)}/triage`,
    { method: "POST" },
  );
}

export function syncSupportHubReports(userId: string): Promise<SupportHubQueue> {
  return apiRequest<SupportHubQueue>(userId, "/api/platform/support-hub/sync", { method: "POST" });
}

export function checkSupportHubGitHub(
  userId: string,
): Promise<{ ok: boolean; repository: string; private: boolean }> {
  return apiRequest<{ ok: boolean; repository: string; private: boolean }>(
    userId,
    "/api/platform/support-hub/check",
    { method: "POST" },
  );
}

async function blobRequest(
  userId: string,
  path: string,
  options: ApiMutationOptions = {},
): Promise<Blob> {
  const response = await fetch(`${apiBase}${path}`, {
    headers: authHeaders(userId),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  return response.blob();
}

async function issueReportFetch<T>(
  userId: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { ...authHeaders(userId), ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ChatRequestError("The issue report was cancelled before the API responded.");
    }
    throw new ChatRequestError("Could not reach the API. Check your connection and try again.");
  }
  if (!response.ok) {
    throw new ChatRequestError(await readApiError(response), response.status);
  }
  return (await response.json()) as T;
}
