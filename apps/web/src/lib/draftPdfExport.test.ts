import { describe, expect, test, vi } from "vitest";
import type { DraftPdfJob } from "./api/draftPdfExport";
import { parseDraftPdfJob } from "./api/draftPdfExport";
import {
  buildDraftPdfSource,
  collectDocumentStyleText,
  describePdfProgress,
  describePdfResult,
  draftPdfImageDataUrl,
  packDraftPdfSource,
  runDraftPdfExport,
  type DraftPdfExportApi,
  type DraftPdfProgress,
} from "./draftPdfExport";

const SAVED_VERSION_HTML =
  '<section class="document-page"><span class="document-page-label">Page 1</span>' +
  "<h1>Harbor Lease</h1><p>The tenant pays rent monthly.</p>" +
  '<p><img src="https://images.example.test/seal.png" alt="Seal"></p>' +
  '<p><img src="data:image/png;base64,AAAA" alt="Inline"></p></section>';

function job(overrides: Partial<DraftPdfJob> = {}): DraftPdfJob {
  return {
    id: "pdf-1",
    status: "queued",
    queue_position: null,
    page_count: null,
    size_bytes: null,
    bookmark_count: null,
    conformance: null,
    error: null,
    ...overrides,
  };
}

function fakeApi(statuses: DraftPdfJob[], pdf = new Blob(["%PDF-1.7"], { type: "application/pdf" })) {
  const sequence = [...statuses];
  const api: DraftPdfExportApi = {
    start: vi.fn(async () => sequence.shift()!),
    get: vi.fn(async () => sequence.shift()!),
    download: vi.fn(async (_id, { onProgress }) => {
      onProgress?.(4, 8);
      onProgress?.(8, 8);
      return pdf;
    }),
    discard: vi.fn(async () => undefined),
  };
  return api;
}

const noWait = () => Promise.resolve();

describe("buildDraftPdfSource", () => {
  test("sends the print surface with every picture embedded", async () => {
    const imageDataUrl = vi.fn(async () => "data:image/png;base64,SEAL");

    const { source, warnings } = await buildDraftPdfSource({
      title: "Harbor Lease",
      contentHtml: SAVED_VERSION_HTML,
      lang: "en-US",
      styleText: ".draft-print-root { color: black; }",
      imageDataUrl,
    });

    expect(warnings).toEqual([]);
    expect(source.title).toBe("Harbor Lease");
    expect(source.lang).toBe("en-US");
    expect(source.css).toContain(".draft-print-root { color: black; }");
    expect(source.body_html).toContain('id="aperture-draft-print-root"');
    expect(source.body_html).toContain("The tenant pays rent monthly.");
    expect(source.body_html).toContain('src="data:image/png;base64,SEAL"');
    expect(source.body_html).not.toContain("images.example.test");
    expect(source.body_html).not.toContain("aria-hidden");
    expect(source.body_html).not.toContain("Page 1");
    expect(imageDataUrl).toHaveBeenCalledTimes(1);
  });

  test("a picture that cannot be embedded is left out and reported", async () => {
    const { source, warnings } = await buildDraftPdfSource({
      title: "Harbor Lease",
      contentHtml: SAVED_VERSION_HTML,
      lang: "en-US",
      styleText: "",
      imageDataUrl: async () => null,
    });

    expect(source.body_html).not.toContain("images.example.test");
    expect(source.body_html).toContain("data:image/png;base64,AAAA");
    expect(warnings).toEqual(["1 picture could not be embedded in the PDF, so it was left out."]);
  });

  test("a source-layout document sends its paper size with the styles", async () => {
    const marker =
      '<div class="document-page-setup" style="width: 612pt; height: 1008pt; padding-top: 72pt; padding-right: 90pt; padding-bottom: 72pt; padding-left: 90pt; margin-top: 36pt; margin-bottom: 30pt; font-family: Calibri; font-size: 16px; line-height: 1.2; color: #000000"></div>';

    const { source } = await buildDraftPdfSource({
      title: "Lease",
      contentHtml: `${marker}<section class="document-page"><p>Legal size.</p></section>`,
      lang: "en-US",
      styleText: "p { margin: 0; }",
      imageDataUrl: async () => null,
    });

    expect(source.css).toContain("p { margin: 0; }");
    expect(source.css).toContain("size: 612pt 1008pt");
  });

  test("an empty saved version is refused before anything is sent", async () => {
    await expect(
      buildDraftPdfSource({
        title: "Empty",
        contentHtml: "<p> </p>",
        lang: "en-US",
        styleText: "",
        imageDataUrl: async () => null,
      }),
    ).rejects.toThrow("This saved version has no content to put in a PDF yet.");
  });
});

describe("runDraftPdfExport", () => {
  test("waits for the server's PDF, reports each stage, and frees the server copy", async () => {
    const pdf = new Blob(["%PDF-1.7"], { type: "application/pdf" });
    const api = fakeApi([
      job({ status: "queued", queue_position: 2 }),
      job({ status: "rendering" }),
      job({ status: "finishing" }),
      job({ status: "ready", page_count: 2889, size_bytes: 8, bookmark_count: 48, conformance: "PDF/A-2b" }),
    ], pdf);
    const progress: DraftPdfProgress[] = [];

    const result = await runDraftPdfExport({
      api,
      source: new Blob(["{}"]),
      onProgress: (step) => progress.push(step),
      wait: noWait,
    });

    expect(result.pageCount).toBe(2889);
    expect(result.conformance).toBe("PDF/A-2b");
    expect(result.bookmarkCount).toBe(48);
    expect(result.blob).toBe(pdf);
    expect(progress.map((step) => step.stage)).toEqual([
      "uploading",
      "queued",
      "rendering",
      "finishing",
      "downloading",
      "downloading",
    ]);
    expect(progress[1]).toEqual({ stage: "queued", ahead: 2 });
    expect(progress[5]).toEqual({ stage: "downloading", received: 8, total: 8 });
    expect(api.discard).toHaveBeenCalledWith("pdf-1");
  });

  test("a failed render surfaces the server's reason", async () => {
    const api = fakeApi([job({ status: "rendering" }), job({ status: "failed", error: "The renderer ran out of memory." })]);

    await expect(runDraftPdfExport({ api, source: new Blob(["{}"]), wait: noWait })).rejects.toThrow(
      "The renderer ran out of memory.",
    );
    expect(api.download).not.toHaveBeenCalled();
    expect(api.discard).toHaveBeenCalledWith("pdf-1");
  });

  test("canceling stops polling and cancels the server job", async () => {
    const controller = new AbortController();
    const api = fakeApi([job({ status: "rendering" }), job({ status: "rendering" })]);
    const wait = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Canceled", "AbortError");
    });

    await expect(
      runDraftPdfExport({ api, source: new Blob(["{}"]), signal: controller.signal, wait }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(api.download).not.toHaveBeenCalled();
    expect(api.discard).toHaveBeenCalledWith("pdf-1");
  });
});

describe("progress and receipt text", () => {
  test("names the stage a large export is in", () => {
    expect(describePdfProgress({ stage: "queued", ahead: 0 }).detail).toBe("Starting next.");
    expect(describePdfProgress({ stage: "queued", ahead: 2 }).detail).toBe("2 exports are ahead of this one.");
    expect(describePdfProgress({ stage: "rendering" }).title).toBe("Laying out pages");
    expect(describePdfProgress({ stage: "downloading", received: 5_242_880, total: 26_214_400 }).detail).toBe(
      "5.2 of 26.2 MB",
    );
  });

  test("the receipt states pages, conformance, and bookmarks", () => {
    expect(describePdfResult({ pageCount: 2889, conformance: "PDF/A-2b", bookmarkCount: 48 })).toBe(
      "2,889 pages · PDF/A-2b archival · 48 bookmarks",
    );
    expect(describePdfResult({ pageCount: 1, conformance: "PDF/A-2b", bookmarkCount: 0 })).toBe(
      "1 page · PDF/A-2b archival",
    );
  });
});

describe("parseDraftPdfJob", () => {
  test("accepts the server's job shape and rejects anything else", () => {
    expect(parseDraftPdfJob({ ...job(), status: "ready", page_count: 3 }).page_count).toBe(3);
    expect(() => parseDraftPdfJob({ ...job(), status: "exploded" })).toThrow();
    expect(() => parseDraftPdfJob(null)).toThrow();
  });
});

test("collects same-origin rules and skips sheets the page cannot read", () => {
  const readable = { cssRules: [{ cssText: "h1 { color: red; }" }, { cssText: "p { margin: 0; }" }] };
  const crossOrigin = {
    get cssRules(): never {
      throw new DOMException("Blocked", "SecurityError");
    },
  };
  const doc = { styleSheets: [readable, crossOrigin] } as unknown as Document;

  expect(collectDocumentStyleText(doc)).toBe("h1 { color: red; }\np { margin: 0; }");
});

test("pictures from other sites go through the image proxy; this site's are read directly", async () => {
  const proxy = vi.fn(async () => "data:image/png;base64,PROXIED");
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 404 }));

  try {
    expect(await draftPdfImageDataUrl("https://images.example.test/seal.png", proxy)).toBe(
      "data:image/png;base64,PROXIED",
    );
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(await draftPdfImageDataUrl("/assets/seal.png", proxy)).toBeNull();
    expect(proxy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(`${window.location.origin}/assets/seal.png`, expect.anything());
  } finally {
    fetchSpy.mockRestore();
  }
});

describe("following a job in real time", () => {
  test("polls with a growing delay and needs no abort signal", async () => {
    vi.useFakeTimers();
    try {
      const api = fakeApi([
        job({ status: "queued" }),
        job({ status: "rendering" }),
        job({ status: "rendering" }),
        job({ status: "ready", page_count: null, bookmark_count: null, conformance: null }),
      ]);
      const progress: DraftPdfProgress[] = [];
      const running = runDraftPdfExport({ api, source: new Blob(["{}"]), onProgress: (step) => progress.push(step) });

      await vi.advanceTimersByTimeAsync(399);
      expect(api.get).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(599);
      expect(api.get).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.get).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(900);
      const result = await running;

      expect(progress[1]).toEqual({ stage: "queued", ahead: 0 });
      // A ready job without counts still yields a usable result.
      expect(result.pageCount).toBe(0);
      expect(result.bookmarkCount).toBe(0);
      expect(result.conformance).toBe("PDF");
    } finally {
      vi.useRealTimers();
    }
  });

  test("canceling during a wait stops right away", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const api = fakeApi([job({ status: "rendering" })]);
      const running = runDraftPdfExport({ api, source: new Blob(["{}"]), signal: controller.signal });
      const outcome = expect(running).rejects.toMatchObject({ name: "AbortError" });

      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      await outcome;
      expect(api.get).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an export canceled before its first wait never polls", async () => {
    const controller = new AbortController();
    controller.abort();
    const api = fakeApi([job({ status: "rendering" })]);

    await expect(
      runDraftPdfExport({ api, source: new Blob(["{}"]), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(api.get).not.toHaveBeenCalled();
  });
});

test("the source is gzip-compressed JSON when the browser can compress", async () => {
  const source = { title: "Lease", lang: "en", body_html: "<p>x</p>", css: "" };

  const packed = await packDraftPdfSource(source);

  expect(packed.type).toBe("application/gzip");
  const bytes = new Uint8Array(
    await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(packed);
    }),
  );
  expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
  const text = await new Response(new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"))).text();
  expect(JSON.parse(text)).toEqual(source);
});

test("singular counts read naturally", () => {
  expect(describePdfProgress({ stage: "queued", ahead: 1 }).detail).toBe("1 export is ahead of this one.");
  expect(describePdfResult({ pageCount: 3, conformance: "PDF/A-2b", bookmarkCount: 1 })).toBe(
    "3 pages · PDF/A-2b archival · 1 bookmark",
  );
});
