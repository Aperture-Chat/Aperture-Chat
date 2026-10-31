/**
 * The only file that touches pdf.js. It loads on first use, so the library and
 * its worker stay out of the main bundle, and it presents the few operations
 * the viewer needs so everything else can be tested without a PDF.
 *
 * The legacy build is deliberate: the modern one assumes features such as
 * Map.getOrInsertComputed and Math.sumPrecise that recent iPhones and managed
 * desktop browsers do not have yet.
 */
import type { PageBox } from "./documentViewerModel";

export type PdfTask<T> = { promise: Promise<T>; cancel: () => void };

export type PdfPageHandle = {
  /** Size at scale 1, rotation applied. */
  box: PageBox;
  paint: (canvas: HTMLCanvasElement, scale: number, pixelRatio: number) => PdfTask<void>;
  /** Fills `container` with the selectable text layer and resolves to its
   * spans in reading order. */
  writeText: (container: HTMLElement, scale: number) => PdfTask<HTMLElement[]>;
  release: () => void;
};

export type PdfDocumentHandle = {
  pageCount: number;
  /** The numbers printed on the pages, when the file records them. */
  labels: string[] | null;
  page: (number: number) => Promise<PdfPageHandle>;
};

export type PdfEngine = { open: (bytes: ArrayBuffer) => PdfTask<PdfDocumentHandle> & { destroy: () => void } };

/** Hands pdf.js the decoders, fonts, and CMaps it asks for from hashed build
 * assets, in place of a directory with fixed file names. Scanned PDFs depend on
 * this: without the JPX and JBIG2 decoders their pages come up blank. */
class PdfAssetFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const { pdfAssetUrl } = await import("./pdfAssets");
    const url = pdfAssetUrl(kind, filename);
    if (!url) throw new Error(`pdf.js asked for an asset that is not bundled: ${filename}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load ${filename}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfPageProxy = Awaited<ReturnType<import("pdfjs-dist").PDFDocumentProxy["getPage"]>>;

function pageHandle(pdfjs: PdfJs, page: PdfPageProxy): PdfPageHandle {
  const { width, height } = page.getViewport({ scale: 1 });
  return {
    box: { width, height },
    paint(canvas, scale, pixelRatio) {
      const viewport = page.getViewport({ scale: scale * pixelRatio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const task = page.render({ canvas, viewport });
      return { promise: task.promise, cancel: () => task.cancel() };
    },
    writeText(container, scale) {
      container.style.setProperty("--total-scale-factor", String(scale * page.userUnit));
      const layer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport: page.getViewport({ scale }),
      });
      return { promise: layer.render().then(() => layer.textDivs), cancel: () => layer.cancel() };
    },
    release: () => page.cleanup(),
  };
}

async function loadEngine(): Promise<PdfEngine> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    // `?worker` emits a .js asset. A bare `?url` would keep .mjs, which the
    // production nginx has no MIME type for, and a worker needs one.
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return {
    open(bytes) {
      const task = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        // Always the bundled faces, so a page looks the same on every device.
        useSystemFonts: false,
        BinaryDataFactory: PdfAssetFactory,
        verbosity: pdfjs.VerbosityLevel.ERRORS,
      });
      const promise = task.promise.then(async (document) => ({
        pageCount: document.numPages,
        labels: await document.getPageLabels().catch(() => null),
        page: async (number: number) => pageHandle(pdfjs, await document.getPage(number)),
      }));
      const destroy = () => void task.destroy();
      return { promise, cancel: destroy, destroy };
    },
  };
}

let engine: Promise<PdfEngine> | null = null;

export function loadPdfEngine(): Promise<PdfEngine> {
  engine ??= loadEngine().catch((error: unknown) => {
    // A failed chunk load must stay retryable.
    engine = null;
    throw error;
  });
  return engine;
}
