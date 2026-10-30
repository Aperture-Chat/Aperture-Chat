/**
 * PDF export for the Drafts workspace.
 *
 * The browser builds the same print surface Print uses (lib/draftPrint.ts),
 * embeds its pictures, and sends it with the page's styles to the API. The
 * server lays the pages out in a sandboxed, offline Chromium with its own
 * static copies of the app's typefaces and finishes the file as PDF/A-2b
 * (embedded fonts, archival metadata, bookmarks from the headings, tagged
 * structure). Building on the server keeps a
 * thousand-page document from straining the browser, and the export runs as
 * a job the page polls, so no single request has to outlast the build.
 */

import {
  discardDraftPdfExport,
  downloadDraftPdfExport,
  getDraftPdfExport,
  startDraftPdfExport,
  type DraftPdfJob,
  type DraftPdfSource,
} from "./api/draftPdfExport";
import { fetchImageAsDataUrl } from "./docxExport";
import { buildDraftPrintSurface } from "./draftPrint";

/** The stage a PDF export is in, as the export panel shows it. */
export type DraftPdfProgress =
  | { stage: "preparing" }
  | { stage: "uploading" }
  | { stage: "queued"; ahead: number }
  | { stage: "rendering" }
  | { stage: "finishing" }
  | { stage: "downloading"; received: number; total: number | null };

export type DraftPdfResult = {
  blob: Blob;
  pageCount: number;
  bookmarkCount: number;
  conformance: string;
};

export type DraftPdfExportApi = {
  start(source: Blob, signal?: AbortSignal): Promise<DraftPdfJob>;
  get(jobId: string, signal?: AbortSignal): Promise<DraftPdfJob>;
  download(
    jobId: string,
    options: { signal?: AbortSignal; onProgress?: (received: number, total: number | null) => void },
  ): Promise<Blob>;
  discard(jobId: string): Promise<void>;
};

export function draftPdfExportApi(userId: string): DraftPdfExportApi {
  return {
    start: (source, signal) => startDraftPdfExport(userId, source, signal),
    get: (jobId, signal) => getDraftPdfExport(userId, jobId, signal),
    download: (jobId, options) => downloadDraftPdfExport(userId, jobId, options),
    discard: (jobId) => discardDraftPdfExport(userId, jobId),
  };
}

/** Every rule the page can read: the same styles the browser's Print applies.
 * Cross-origin sheets (the web-font stylesheet) are skipped; the server
 * supplies static copies of those faces. */
export function collectDocumentStyleText(doc: Document): string {
  const parts: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) parts.push(rule.cssText);
  }
  return parts.join("\n");
}

/** Swaps each picture's address for its bytes; a picture that cannot be
 * fetched is removed. Returns how many were removed. */
async function embedPictures(root: HTMLElement, imageDataUrl: (src: string) => Promise<string | null>) {
  const images = Array.from(root.querySelectorAll("img")).filter(
    (image) => !(image.getAttribute("src") ?? "").startsWith("data:"),
  );
  const bySource = new Map<string, Promise<string | null>>();
  const embedded = await Promise.all(
    images.map((image) => {
      const src = image.getAttribute("src") ?? "";
      if (!bySource.has(src)) bySource.set(src, src ? imageDataUrl(src) : Promise.resolve(null));
      return bySource.get(src)!;
    }),
  );
  let dropped = 0;
  images.forEach((image, index) => {
    const dataUrl = embedded[index];
    if (dataUrl) {
      image.setAttribute("src", dataUrl);
      image.removeAttribute("srcset");
    } else {
      image.remove();
      dropped += 1;
    }
  });
  return dropped;
}

/** The saved version as the server's renderer receives it. Throws when the
 * version has nothing to put in a PDF. */
export async function buildDraftPdfSource({
  title,
  contentHtml,
  lang,
  styleText,
  imageDataUrl,
  doc = document,
}: {
  title: string;
  contentHtml: string;
  lang: string;
  styleText: string;
  imageDataUrl: (src: string) => Promise<string | null>;
  doc?: Document;
}): Promise<{ source: DraftPdfSource; warnings: string[] }> {
  const surface = buildDraftPrintSurface({ title, contentHtml }, doc);
  if (!surface) throw new Error("This saved version has no content to put in a PDF yet.");
  const dropped = await embedPictures(surface.root, imageDataUrl);
  const warnings = dropped
    ? [
        dropped === 1
          ? "1 picture could not be embedded in the PDF, so it was left out."
          : `${dropped} pictures could not be embedded in the PDF, so they were left out.`,
      ]
    : [];
  return {
    source: {
      title: title.replace(/\s+/g, " ").trim() || "Draft",
      lang,
      body_html: surface.root.outerHTML,
      css: [styleText, surface.pageCss].filter(Boolean).join("\n"),
    },
    warnings,
  };
}

/** JSON, gzip-compressed where the browser can: a thousand-page document's
 * markup shrinks several-fold before it is uploaded. */
export async function packDraftPdfSource(source: DraftPdfSource): Promise<Blob> {
  const json = JSON.stringify(source);
  const body = typeof CompressionStream === "undefined" ? null : new Response(json).body;
  if (!body) return new Blob([json], { type: "application/json" });
  const gzipped = body.pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(gzipped).arrayBuffer()], { type: "application/gzip" });
}

const FIRST_POLL_MS = 400;
const MAX_POLL_MS = 2_000;

function abortError() {
  return new DOMException("The PDF export was canceled.", "AbortError");
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function progressFor(job: DraftPdfJob): DraftPdfProgress {
  if (job.status === "queued") return { stage: "queued", ahead: job.queue_position ?? 0 };
  return job.status === "finishing" ? { stage: "finishing" } : { stage: "rendering" };
}

type Follow = {
  signal?: AbortSignal;
  onProgress: (progress: DraftPdfProgress) => void;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** Polls with a gentle backoff until the job is ready; a failed or canceled
 * job throws. */
async function followUntilReady(api: DraftPdfExportApi, first: DraftPdfJob, { signal, onProgress, wait }: Follow) {
  let job = first;
  let delay = FIRST_POLL_MS;
  while (job.status !== "ready") {
    if (job.status === "failed") throw new Error(job.error || "The PDF could not be built. Try again.");
    if (job.status === "canceled") throw abortError();
    onProgress(progressFor(job));
    await wait(delay, signal);
    delay = Math.min(MAX_POLL_MS, Math.round(delay * 1.5));
    job = await api.get(job.id, signal);
  }
  return job;
}

function pdfResult(job: DraftPdfJob, blob: Blob): DraftPdfResult {
  return {
    blob,
    pageCount: job.page_count ?? 0,
    bookmarkCount: job.bookmark_count ?? 0,
    conformance: job.conformance ?? "PDF",
  };
}

/** Queues the PDF on the server, follows it to the end, and downloads it. The
 * server copy is canceled or freed however this ends. */
export async function runDraftPdfExport({
  api,
  source,
  signal,
  onProgress = () => undefined,
  wait = waitFor,
}: {
  api: DraftPdfExportApi;
  source: Blob;
  signal?: AbortSignal;
  onProgress?: (progress: DraftPdfProgress) => void;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<DraftPdfResult> {
  onProgress({ stage: "uploading" });
  const queued = await api.start(source, signal);
  try {
    const ready = await followUntilReady(api, queued, { signal, onProgress, wait });
    const blob = await api.download(ready.id, {
      signal,
      onProgress: (received, total) => onProgress({ stage: "downloading", received, total }),
    });
    return pdfResult(ready, blob);
  } finally {
    void api.discard(queued.id);
  }
}

function megabytes(bytes: number) {
  return (bytes / 1_000_000).toFixed(1);
}

function queueDetail(ahead: number) {
  if (ahead <= 0) return "Starting next.";
  return ahead === 1 ? "1 export is ahead of this one." : `${ahead} exports are ahead of this one.`;
}

/** Headline and detail for the export panel's progress row. */
export function describePdfProgress(progress: DraftPdfProgress): { title: string; detail: string } {
  switch (progress.stage) {
    case "preparing":
      return { title: "Preparing pages", detail: "Embedding the saved version's pictures." };
    case "uploading":
      return { title: "Sending the saved version", detail: "The PDF is built on the server." };
    case "queued":
      return { title: "Waiting for the PDF renderer", detail: queueDetail(progress.ahead) };
    case "rendering":
      return { title: "Laying out pages", detail: "Long documents can take a minute or two." };
    case "finishing":
      return { title: "Adding archival details", detail: "PDF/A metadata, bookmarks, and fast web view." };
    case "downloading":
      return {
        title: "Downloading the PDF",
        detail:
          progress.total === null
            ? `${megabytes(progress.received)} MB`
            : `${megabytes(progress.received)} of ${megabytes(progress.total)} MB`,
      };
  }
}

/** One line for the export receipt: "2,889 pages · PDF/A-2b archival · 48 bookmarks". */
export function describePdfResult({
  pageCount,
  conformance,
  bookmarkCount,
}: Pick<DraftPdfResult, "pageCount" | "conformance" | "bookmarkCount">): string {
  const parts = [
    `${pageCount.toLocaleString("en-US")} ${pageCount === 1 ? "page" : "pages"}`,
    `${conformance} archival`,
  ];
  if (bookmarkCount > 0) parts.push(`${bookmarkCount} ${bookmarkCount === 1 ? "bookmark" : "bookmarks"}`);
  return parts.join(" · ");
}

/** Picture bytes for the PDF. Pictures on this site (and blob: URLs) are read
 * directly; anything else goes through the API's authenticated image proxy,
 * because many hosts refuse cross-origin reads. */
export async function draftPdfImageDataUrl(
  src: string,
  proxy: (src: string) => Promise<string | null>,
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(src, window.location.href);
  } catch {
    return null;
  }
  if (url.protocol !== "blob:" && url.origin !== window.location.origin) return proxy(src);
  return fetchImageAsDataUrl(url.href);
}
