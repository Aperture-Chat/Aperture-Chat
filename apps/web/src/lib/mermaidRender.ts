/** Shared Mermaid rendering for chat replies and Drafts documents.
 *
 * Mermaid stays a lazy Vite chunk (dynamic import) so the main bundle never
 * pays for it. Chat renders live SVG per theme; Drafts rasterizes to a PNG
 * data URL on the light palette because document pages are always white and
 * inline SVG does not survive the DOCX export or AI-revision round-trips.
 */

export const MERMAID_FONT_FAMILY =
  '"Plus Jakarta Sans", "SF Pro Display", "Segoe UI", ui-sans-serif, system-ui, sans-serif';

// Categorical series colors validated (CVD separation + contrast) against the app's
// light and dark chat surfaces. Mermaid pies and xycharts label values directly,
// which is the required relief for the sub-3:1 light-mode slots.
const MERMAID_SERIES_LIGHT = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948", "#e87ba4", "#eb6834"];
const MERMAID_SERIES_DARK = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767", "#d55181", "#d95926"];

function mermaidConfig(dark: boolean) {
  const series = dark ? MERMAID_SERIES_DARK : MERMAID_SERIES_LIGHT;
  const surface = dark ? "#0d1c27" : "#ffffff";
  const text = dark ? "#e9f3f7" : "#0c1a26";
  const muted = dark ? "#9fb1bd" : "#5c6b7a";
  const pieSlots = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`pie${index + 1}`, series[index % series.length]]),
  );
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: "base" as const,
    fontFamily: MERMAID_FONT_FAMILY,
    // A render-time failure must throw so the caller falls back to the code
    // block; without this, mermaid draws its "Syntax error in text" bomb SVG
    // and reports success, and the bomb reaches the reader.
    suppressErrorRendering: true,
    // HTML (foreignObject) labels taint the canvas during SVG→PNG
    // rasterization (chat PNG download, Drafts document raster). The
    // top-level htmlLabels flag is the one that actually removes them —
    // flowchart.htmlLabels alone leaves foreignObject edge labels behind.
    htmlLabels: false,
    // Markdown-string labels ("`**Title**`") are the only rich-label syntax
    // that renders under strict security with SVG text — raw <b>/<i> tags come
    // out as literal text. Auto-wrap keeps long detail lines inside the box.
    markdownAutoWrap: true,
    flowchart: {
      htmlLabels: false,
      curve: "linear" as const,
      nodeSpacing: 42,
      rankSpacing: 56,
      padding: 10,
      wrappingWidth: 260,
    },
    class: { htmlLabels: false },
    themeVariables: {
      darkMode: dark,
      fontFamily: MERMAID_FONT_FAMILY,
      background: surface,
      primaryColor: dark ? "#102330" : "#f5f9fa",
      primaryTextColor: text,
      primaryBorderColor: dark ? "#2c485a" : "#cfdae2",
      secondaryColor: dark ? "#0a1721" : "#eef4f6",
      tertiaryColor: dark ? "#102330" : "#f5f9fa",
      lineColor: muted,
      textColor: text,
      edgeLabelBackground: surface,
      clusterBkg: dark ? "#0a1721" : "#f7fafc",
      clusterBorder: dark ? "#2c485a" : "#cfdae2",
      ...pieSlots,
      xyChart: {
        backgroundColor: surface,
        titleColor: text,
        xAxisLabelColor: text,
        xAxisTitleColor: text,
        xAxisTickColor: muted,
        xAxisLineColor: muted,
        yAxisLabelColor: text,
        yAxisTitleColor: text,
        yAxisTickColor: muted,
        yAxisLineColor: muted,
        plotColorPalette: series.join(","),
      },
    },
  };
}

let mermaidModule: Promise<typeof import("mermaid").default> | null = null;
let mermaidActiveTheme: string | null = null;
let mermaidRenderId = 0;

function loadMermaid() {
  if (!mermaidModule) {
    mermaidModule = import("mermaid").then((module) => module.default);
  }
  return mermaidModule;
}

export function diagramTypeLabel(source: string) {
  const firstToken = source.trim().split(/\s+/)[0] ?? "";
  if (!firstToken || firstToken.startsWith("%%")) return "diagram";
  return firstToken
    .replace(/Diagram(-v\d+)?$/i, "")
    .replace(/-(beta|v\d+)$/i, "")
    .toLowerCase();
}

/** The single most common model slip that kills an otherwise-good flowchart:
 * a literal double quote inside a markdown-string label ("`…"uncrossing"…`")
 * terminates Mermaid's string early and the whole diagram falls back to a
 * code block. Swapping interior quotes for apostrophes inside backtick spans
 * keeps the reader's diagram rendering; the stored source stays untouched. */
export function repairMermaidLabelQuotes(source: string): string {
  return source.replace(/`[^`]*`/g, (span) => span.replace(/"/g, "'"));
}

/** Renders Mermaid source to an SVG string, or null when the source does not
 * parse (partial streaming input, model mistakes). Never throws. */
export async function renderMermaidSvg(rawSource: string, dark: boolean): Promise<string | null> {
  const source = repairMermaidLabelQuotes(rawSource);
  try {
    const mermaid = await loadMermaid();
    const themeKey = dark ? "dark" : "light";
    if (mermaidActiveTheme !== themeKey) {
      mermaid.initialize(mermaidConfig(dark));
      mermaidActiveTheme = themeKey;
    }
    const valid = await mermaid.parse(source, { suppressErrors: true });
    if (!valid) return null;
    const renderNodeId = `aperture-diagram-${++mermaidRenderId}`;
    try {
      const rendered = await mermaid.render(renderNodeId, source);
      // Sources can pass parse yet still fail at render; if mermaid returns
      // its error diagram instead of throwing, treat that as no render at all.
      if (
        !rendered.svg ||
        rendered.svg.includes('aria-roledescription="error"') ||
        rendered.svg.includes("Syntax error in text")
      ) {
        return null;
      }
      return rendered.svg;
    } finally {
      // Mermaid parks a measuring container (id "d<render id>") in
      // document.body and leaves it behind when render fails — without this
      // cleanup a failed render strands an error SVG at the end of the page.
      document.getElementById(`d${renderNodeId}`)?.remove();
    }
  } catch {
    return null;
  }
}

function svgDimensions(svgMarkup: string) {
  const viewBox = /viewBox="([^"]+)"/
    .exec(svgMarkup)?.[1]
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  return { width: 900, height: 540 };
}

async function rasterizeSvgToCanvas(svgMarkup: string, background: string): Promise<HTMLCanvasElement> {
  const { width, height } = svgDimensions(svgMarkup);
  // Mermaid emits width="100%" and sizes via CSS; rasterization needs explicit
  // pixel dimensions on the root element or the Image decodes at 300×150.
  const openTagEnd = svgMarkup.indexOf(">");
  const sized =
    openTagEnd > 0
      ? `${svgMarkup
          .slice(0, openTagEnd)
          .replace(/\s(?:width|height)="[^"]*"/g, "")} width="${width}" height="${height}"${svgMarkup.slice(openTagEnd)}`
      : svgMarkup;
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Diagram rasterization failed"));
      image.src = url;
    });
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function svgToPngBlob(svgMarkup: string, dark: boolean): Promise<Blob> {
  const canvas = await rasterizeSvgToCanvas(svgMarkup, dark ? "#101d2c" : "#ffffff");
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))), "image/png");
  });
}

/** Rasterizes any SVG markup to a PNG data URL (2× scale). Shared by the
 * Mermaid and structure-diagram document pipelines. Returns null when the
 * browser cannot rasterize. */
export async function rasterizeSvgToPngDataUrl(svgMarkup: string, background: string): Promise<string | null> {
  try {
    const canvas = await rasterizeSvgToCanvas(svgMarkup, background);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** Renders Mermaid source straight to a light-theme PNG data URL for document
 * surfaces (Drafts pages are always white). Returns null when the source does
 * not parse or the browser cannot rasterize. */
export async function renderMermaidPngDataUrl(source: string): Promise<string | null> {
  const svg = await renderMermaidSvg(source, false);
  if (!svg) return null;
  return rasterizeSvgToPngDataUrl(svg, "#ffffff");
}
