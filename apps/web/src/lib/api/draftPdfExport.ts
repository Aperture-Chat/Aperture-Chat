import { ChatRequestError, apiBase, apiRequest, authHeaders, readApiError } from "./http";

/** Where a server-side PDF export is: waiting for a renderer, laying out
 * pages in the renderer, adding archival metadata, or finished one way or
 * another. */
export type DraftPdfJobStatus = "queued" | "rendering" | "finishing" | "ready" | "failed" | "canceled";

const JOB_STATUSES: ReadonlySet<string> = new Set<DraftPdfJobStatus>([
  "queued",
  "rendering",
  "finishing",
  "ready",
  "failed",
  "canceled",
]);

export type DraftPdfJob = {
  id: string;
  status: DraftPdfJobStatus;
  /** Exports ahead of this one while it is queued. */
  queue_position: number | null;
  page_count: number | null;
  size_bytes: number | null;
  bookmark_count: number | null;
  conformance: string | null;
  error: string | null;
};

/** The saved version as the server's renderer receives it: the print surface
 * and the styles the browser's own Print would apply to it. */
export type DraftPdfSource = {
  title: string;
  lang: string;
  body_html: string;
  css: string;
};

const PDF_EXPORTS_PATH = "/api/drafts/pdf-exports";

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parses a job from the API once, where it enters the app. */
export function parseDraftPdfJob(value: unknown): DraftPdfJob {
  if (!value || typeof value !== "object") throw new ChatRequestError("The PDF export status was unreadable.");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.status !== "string" || !JOB_STATUSES.has(record.status)) {
    throw new ChatRequestError("The PDF export status was unreadable.");
  }
  return {
    id: record.id,
    status: record.status as DraftPdfJobStatus,
    queue_position: optionalCount(record.queue_position),
    page_count: optionalCount(record.page_count),
    size_bytes: optionalCount(record.size_bytes),
    bookmark_count: optionalCount(record.bookmark_count),
    conformance: optionalText(record.conformance),
    error: optionalText(record.error),
  };
}

/** Uploads the packed source and queues the PDF build. */
export async function startDraftPdfExport(userId: string, source: Blob, signal?: AbortSignal): Promise<DraftPdfJob> {
  const form = new FormData();
  form.append("source", source, "draft-print.json");
  let response: Response;
  try {
    response = await fetch(`${apiBase}${PDF_EXPORTS_PATH}`, {
      method: "POST",
      headers: authHeaders(userId),
      body: form,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChatRequestError("Could not send the document for PDF export. Check your connection and try again.");
  }
  if (!response.ok) throw new ChatRequestError(await readApiError(response), response.status);
  return parseDraftPdfJob(await response.json());
}

export async function getDraftPdfExport(userId: string, jobId: string, signal?: AbortSignal): Promise<DraftPdfJob> {
  return parseDraftPdfJob(
    await apiRequest<unknown>(userId, `${PDF_EXPORTS_PATH}/${encodeURIComponent(jobId)}`, { signal }),
  );
}

async function fetchPdfFile(userId: string, jobId: string, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${PDF_EXPORTS_PATH}/${encodeURIComponent(jobId)}/file`, {
      headers: authHeaders(userId),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ChatRequestError("Could not download the PDF. Check your connection and try again.");
  }
  if (!response.ok) throw new ChatRequestError(await readApiError(response), response.status);
  return response;
}

async function readWithProgress(
  body: ReadableStream<Uint8Array>,
  total: number | null,
  onProgress?: (received: number, total: number | null) => void,
): Promise<Blob> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received, total);
  }
  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}

/** Downloads the finished PDF, reporting bytes as they arrive. */
export async function downloadDraftPdfExport(
  userId: string,
  jobId: string,
  { signal, onProgress }: { signal?: AbortSignal; onProgress?: (received: number, total: number | null) => void },
): Promise<Blob> {
  const response = await fetchPdfFile(userId, jobId, signal);
  const declared = Number(response.headers.get("content-length"));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (!response.body) return response.blob();
  return readWithProgress(response.body, total, onProgress);
}

/** Cancels a running export or frees a finished one. Best effort: the server
 * also expires exports on its own. */
export async function discardDraftPdfExport(userId: string, jobId: string): Promise<void> {
  try {
    await fetch(`${apiBase}${PDF_EXPORTS_PATH}/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      headers: authHeaders(userId),
    });
  } catch {
    // The server's retention window cleans up anything left behind.
  }
}
