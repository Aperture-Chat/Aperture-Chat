/** Web-font embedding for diagram rasters.
 *
 * Chat draws diagrams as live SVG in the page's own face (Plus Jakarta Sans,
 * from the page's font stylesheet), and card layout measures its text in that
 * face. A raster (the Drafts figure, its DOCX image, the PNG download) draws
 * the SVG through an <img>, which cannot see the page's web fonts, so its
 * letters fell back to a system face with different widths. Inlining the face
 * as data URLs makes the raster draw the letters chat drew.
 */

import { DIAGRAM_FONT_FAMILY } from "./diagramTheme";

/** The web face diagrams are designed in: the head of DIAGRAM_FONT_FAMILY. */
const DIAGRAM_WEB_FONT = DIAGRAM_FONT_FAMILY.split(",")[0]!.trim().replace(/^["']|["']$/g, "");

const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

type FetchFont = (url: string) => Promise<Response>;

/** The @font-face rules in a stylesheet that declare `family`. */
export function fontFaceRulesFor(css: string, family: string): string[] {
  const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = new RegExp(`font-family:\\s*(['"]?)${escaped}\\1\\s*;`, "i");
  return Array.from(css.matchAll(/@font-face\s*\{[^}]*\}/g), (match) => match[0]).filter((rule) => named.test(rule));
}

/** Joins the rules with every url() swapped for the data URL `inline`
 * returns. Weights of a variable face share one file, fetched once. */
export async function inlineFontUrls(rules: string[], inline: (url: string) => Promise<string>): Promise<string> {
  const css = rules.join("\n");
  const urls = [...new Set(Array.from(css.matchAll(URL_PATTERN), (match) => match[2]!))];
  const dataUrls = new Map(await Promise.all(urls.map(async (url) => [url, await inline(url)] as const)));
  return css.replace(URL_PATTERN, (_match, _quote, url: string) => `url(${dataUrls.get(url)})`);
}

/** Puts `css` in a <style> as the first child of the root <svg>. */
export function withSvgFontCss(svg: string, css: string): string {
  const root = /<svg\b[^>]*>/.exec(svg);
  if (!css || !root) return svg;
  const inside = root.index + root[0].length;
  return `${svg.slice(0, inside)}<style>${css}</style>${svg.slice(inside)}`;
}

async function fetchOk(fetchImpl: FetchFont, url: string): Promise<Response> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Diagram font request failed (${response.status})`);
  return response;
}

async function fontFileDataUrl(fetchImpl: FetchFont, url: string): Promise<string> {
  const bytes = new Uint8Array(await (await fetchOk(fetchImpl, url)).arrayBuffer());
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return `data:application/octet-stream;base64,${btoa(binary)}`;
}

/** Self-contained @font-face CSS for the diagram face, read from the page's
 * font stylesheet. "" when the page links none; rejects when a file fails. */
export async function loadDiagramFontCss(fetchImpl: FetchFont, doc: Document): Promise<string> {
  const familyParam = `family=${DIAGRAM_WEB_FONT.replace(/ /g, "+")}`;
  const link = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')).find((element) =>
    element.href.includes(familyParam),
  );
  if (!link) return "";
  const rules = fontFaceRulesFor(await (await fetchOk(fetchImpl, link.href)).text(), DIAGRAM_WEB_FONT);
  return inlineFontUrls(rules, (url) => fontFileDataUrl(fetchImpl, url));
}

let loading: Promise<string> | null = null;

/** The page's diagram font CSS, fetched once. A failed fetch yields "" (the
 * raster keeps the system face, as before) and is retried next time. */
export function diagramFontCss(): Promise<string> {
  loading ??= loadDiagramFontCss((url) => fetch(url), document).catch(() => {
    loading = null;
    return "";
  });
  return loading;
}
