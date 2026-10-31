import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();
const render = vi.fn();
const layerRender = vi.fn();
const layerCancel = vi.fn();
const layerOptions = vi.fn();

class FakeTextLayer {
  textDivs = [document.createElement("span")];
  constructor(options: unknown) {
    layerOptions(options);
  }
  render = layerRender;
  cancel = layerCancel;
}

const pdfjsModule = {
  GlobalWorkerOptions: { workerSrc: "" },
  VerbosityLevel: { ERRORS: 0 },
  TextLayer: FakeTextLayer,
  getDocument,
};

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => pdfjsModule);
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url", () => ({ default: "/assets/pdf.worker.js" }));
vi.mock("./pdfAssets", () => ({
  pdfAssetUrl: (kind: string, filename: string) => (filename === "known.wasm" ? `/assets/${kind}/${filename}` : null),
}));

function fakePage() {
  return {
    userUnit: 1,
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, scale }),
    render: render.mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() }),
    streamTextContent: vi.fn(() => "stream"),
    cleanup: vi.fn(),
  };
}

async function openDocument(getPageLabels = vi.fn(async (): Promise<string[] | null> => null)) {
  const destroy = vi.fn();
  const page = fakePage();
  getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 60, getPage: vi.fn(async () => page), getPageLabels }),
    destroy,
  });
  const { loadPdfEngine } = await import("./pdfEngine");
  const engine = await loadPdfEngine();
  const task = engine.open(new ArrayBuffer(8));
  return { task, document: await task.promise, destroy, page };
}

describe("loadPdfEngine", () => {
  beforeEach(() => {
    getDocument.mockReset();
    render.mockReset();
    layerRender.mockReset();
  });

  it("opens with the bundled worker and the bundled fonts", async () => {
    await openDocument();
    expect(pdfjsModule.GlobalWorkerOptions.workerSrc).toBe("/assets/pdf.worker.js");
    expect(getDocument.mock.calls[0][0]).toMatchObject({ useSystemFonts: false });
  });

  // pdf.js 6 removed the isEvalSupported switch along with the code it guarded.
  // A crafted font once reached `new Function` that way (CVE-2024-4367), so an
  // upgrade that brings code generation back has to fail here.
  it.each(["pdf.mjs", "pdf.worker.mjs"])("ships no code generation in %s", (file) => {
    const source = readFileSync(createRequire(`${process.cwd()}/`).resolve(`pdfjs-dist/legacy/build/${file}`), "utf8");
    expect(source).not.toMatch(/\bnew Function\(/);
    expect(source).not.toMatch(/(^|[^\w.])eval\(/m);
  });

  it("reports the page count and a page's size at scale one", async () => {
    const { document } = await openDocument();
    expect(document.pageCount).toBe(60);
    expect((await document.page(40)).box).toEqual({ width: 600, height: 800 });
  });

  it("reads the file's printed page labels", async () => {
    const { document } = await openDocument(vi.fn(async () => ["i", "ii"]));
    expect(document.labels).toEqual(["i", "ii"]);
  });

  it("does without labels when a file has none or they cannot be read", async () => {
    expect((await openDocument()).document.labels).toBeNull();
    const broken = vi.fn(async (): Promise<string[] | null> => {
      throw new Error("bad labels");
    });
    expect((await openDocument(broken)).document.labels).toBeNull();
  });

  it("paints at device resolution on the canvas it is given", async () => {
    const { document } = await openDocument();
    const canvas = window.document.createElement("canvas");
    (await document.page(1)).paint(canvas, 1.5, 2);
    expect(canvas.width).toBe(1800);
    expect(canvas.height).toBe(2400);
    expect(render.mock.calls[0][0].canvas).toBe(canvas);
  });

  it("resolves the text layer to its spans at the page's scale", async () => {
    layerRender.mockResolvedValue(undefined);
    const { document } = await openDocument();
    const container = window.document.createElement("div");
    const spans = await (await document.page(1)).writeText(container, 1.5).promise;
    expect(spans).toHaveLength(1);
    expect(container.style.getPropertyValue("--total-scale-factor")).toBe("1.5");
    expect(layerOptions.mock.lastCall?.[0]).toMatchObject({ container, viewport: { scale: 1.5 } });
  });

  it("tears the document down through the loading task", async () => {
    const { task, destroy } = await openDocument();
    task.destroy();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("feeds pdf.js bundled assets and refuses anything else", async () => {
    await openDocument();
    const { BinaryDataFactory } = getDocument.mock.calls[0][0];
    const factory = new BinaryDataFactory();
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
    await expect(factory.fetch({ kind: "wasmUrl", filename: "known.wasm" })).resolves.toHaveLength(3);
    expect(globalThis.fetch).toHaveBeenCalledWith("/assets/wasmUrl/known.wasm");
    await expect(factory.fetch({ kind: "wasmUrl", filename: "other.wasm" })).rejects.toThrow("not bundled");
  });

  it("reports an asset that failed to load", async () => {
    await openDocument();
    const { BinaryDataFactory } = getDocument.mock.calls[0][0];
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 })) as typeof fetch;
    await expect(new BinaryDataFactory().fetch({ kind: "wasmUrl", filename: "known.wasm" })).rejects.toThrow("503");
  });
});
