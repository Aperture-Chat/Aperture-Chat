import { afterEach, expect, test, vi } from "vitest";
import { fontFaceRulesFor, inlineFontUrls, loadDiagramFontCss, withSvgFontCss } from "./diagramFonts";

const JAKARTA = "https://fonts.gstatic.com/s/plusjakartasans/latin.woff2";
const JAKARTA_ITALIC = "https://fonts.gstatic.com/s/plusjakartasans/latin-italic.woff2";
const MONO = "https://fonts.gstatic.com/s/jetbrainsmono/latin.woff2";
const STYLESHEET = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600&family=JetBrains+Mono";

const GOOGLE_CSS = `/* latin */
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 500;
  src: url(${MONO}) format('woff2');
}
/* latin */
@font-face {
  font-family: 'Plus Jakarta Sans';
  font-style: italic;
  font-weight: 500;
  src: url(${JAKARTA_ITALIC}) format('woff2');
}
/* latin */
@font-face {
  font-family: 'Plus Jakarta Sans';
  font-style: normal;
  font-weight: 400;
  src: url(${JAKARTA}) format('woff2');
  unicode-range: U+0000-00FF;
}
/* latin */
@font-face {
  font-family: 'Plus Jakarta Sans';
  font-style: normal;
  font-weight: 600;
  src: url(${JAKARTA}) format('woff2');
  unicode-range: U+0000-00FF;
}`;

function documentWithFontLink(href = STYLESHEET) {
  const doc = document.implementation.createHTMLDocument("fonts");
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  doc.head.append(link);
  return doc;
}

function fakeFetch(files: Record<string, string>) {
  return vi.fn(async (url: string) =>
    url in files
      ? new Response(files[url], { status: 200 })
      : new Response("missing", { status: 404 }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("keeps only the diagram family's @font-face rules", () => {
  const rules = fontFaceRulesFor(GOOGLE_CSS, "Plus Jakarta Sans");
  expect(rules).toHaveLength(3);
  expect(rules.join("\n")).not.toContain("JetBrains");
});

test("inlines each font file once, as the data URL the loader returns", async () => {
  const inline = vi.fn(async (url: string) => `data:font/woff2;base64,${url.endsWith("italic.woff2") ? "SVQ=" : "Uk9N"}`);
  const css = await inlineFontUrls(fontFaceRulesFor(GOOGLE_CSS, "Plus Jakarta Sans"), inline);
  expect(inline).toHaveBeenCalledTimes(2);
  expect(css).not.toContain("https://");
  expect(css.match(/url\(data:font\/woff2;base64,Uk9N\)/g)).toHaveLength(2);
  expect(css).toContain("url(data:font/woff2;base64,SVQ=)");
  expect(css).toContain("font-weight: 600");
});

test("puts the font CSS first inside the root svg element", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;
  expect(withSvgFontCss(svg, "@font-face{}")).toBe(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@font-face{}</style><rect width="10" height="10"/></svg>`,
  );
  expect(withSvgFontCss(svg, "")).toBe(svg);
  expect(withSvgFontCss("not a diagram > yet", "@font-face{}")).toBe("not a diagram > yet");
  expect(withSvgFontCss(`<?xml version="1.0"?>\n${svg}`, "@font-face{}")).toContain('viewBox="0 0 10 10"><style>@font-face{}</style><rect');
});

test("loads the page's diagram web font as self-contained CSS", async () => {
  const fetchImpl = fakeFetch({ [STYLESHEET]: GOOGLE_CSS, [JAKARTA]: "ROMAN", [JAKARTA_ITALIC]: "ITALIC" });
  const css = await loadDiagramFontCss(fetchImpl, documentWithFontLink());
  expect(css).toContain("font-family: 'Plus Jakarta Sans'");
  expect(css).toContain(`url(data:application/octet-stream;base64,${btoa("ROMAN")})`);
  expect(css).toContain(`url(data:application/octet-stream;base64,${btoa("ITALIC")})`);
  expect(css).not.toMatch(/https:|JetBrains/);
  expect(fetchImpl).not.toHaveBeenCalledWith(MONO);
});

test("without the font stylesheet, or when a file fails, rasters keep the system face", async () => {
  expect(await loadDiagramFontCss(fakeFetch({}), document.implementation.createHTMLDocument("bare"))).toBe("");
  await expect(loadDiagramFontCss(fakeFetch({ [STYLESHEET]: GOOGLE_CSS }), documentWithFontLink())).rejects.toThrow();
});

test("rasterized diagrams carry the diagram face inside the SVG the browser draws", async () => {
  document.head.append(documentWithFontLink().querySelector("link")!);
  vi.stubGlobal("fetch", fakeFetch({ [STYLESHEET]: GOOGLE_CSS, [JAKARTA]: "ROMAN", [JAKARTA_ITALIC]: "ITALIC" }));
  const drawn: Blob[] = [];
  // jsdom has no object URLs; the rasterizer's Blob is what the browser would draw.
  Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      drawn.push(blob);
      return "blob:diagram";
    },
    revokeObjectURL: () => {},
  });
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: () => {},
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,UE5H");

  const { rasterizeSvgToPngDataUrl } = await import("./mermaidRender");
  const png = await rasterizeSvgToPngDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><text>Game layout</text></svg>`,
    "#ffffff",
  );

  expect(png).toBe("data:image/png;base64,UE5H");
  const svg = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(drawn[0]!);
  });
  expect(svg).toMatch(/^<svg[^>]*><style>@font-face/);
  expect(svg).toContain(`url(data:application/octet-stream;base64,${btoa("ROMAN")})`);
  expect(svg).toContain("<text>Game layout</text>");
});
