import type { IssueReportRecord } from "../types";
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
  payload: { subject: string; body: string; screenshot?: File | null },
  options: ApiMutationOptions = {},
): Promise<IssueReportRecord> {
  const form = new FormData();
  form.append("subject", payload.subject);
  form.append("body", payload.body);
  if (payload.screenshot) form.append("screenshot", payload.screenshot);
  return issueReportFetch<IssueReportRecord>(userId, "/api/issue-reports", {
    method: "POST",
    body: form,
    signal: options.signal,
  });
}

export function listAdminIssueReports(
  userId: string,
  options: ApiMutationOptions & { limit?: number } = {},
): Promise<IssueReportRecord[]> {
  const query = options.limit ? `?limit=${encodeURIComponent(options.limit)}` : "";
  return apiRequest<IssueReportRecord[]>(userId, `/api/admin/issue-reports${query}`, {
    signal: options.signal,
  });
}

export async function getAdminIssueReportScreenshot(
  userId: string,
  reportId: string,
  options: ApiMutationOptions = {},
): Promise<Blob> {
  const response = await fetch(
    `${apiBase}/api/admin/issue-reports/${pathId(reportId)}/screenshot`,
    { headers: authHeaders(userId), signal: options.signal },
  );
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
