/** Text measurement and SVG text helpers shared by Aperture's own diagram
 * renderers (structure charts, timelines, fallbacks), so wrapping and type
 * sizes behave the same in every figure. */

import { DIAGRAM_FONT_FAMILY } from "./diagramTheme";

let measureContext: CanvasRenderingContext2D | null | undefined;

export function measureDiagramText(text: string, size: number, weight = 400): number {
  if (measureContext === undefined) {
    try {
      measureContext =
        typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  if (measureContext) {
    measureContext.font = `${weight} ${size}px ${DIAGRAM_FONT_FAMILY}`;
    const width = measureContext.measureText(text).width;
    if (width > 0 || !text) return width;
  }
  // Headless fallback (tests): average glyph width for the app font.
  return text.length * size * (weight >= 600 ? 0.6 : 0.55);
}

/** Greedy word wrap to a pixel width. A single word longer than the line is
 * broken by characters so nothing overflows its box. */
export function wrapDiagramText(text: string, maxWidth: number, size: number, weight = 400): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let current = "";
  const pushWord = (word: string) => {
    if (measureDiagramText(word, size, weight) <= maxWidth) return word;
    // Hard-break an overlong token (URLs, chemical names).
    let piece = "";
    for (const char of word) {
      if (piece && measureDiagramText(piece + char, size, weight) > maxWidth) {
        lines.push(piece);
        piece = char;
      } else {
        piece += char;
      }
    }
    return piece;
  };
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measureDiagramText(candidate, size, weight) > maxWidth) {
      lines.push(current);
      current = pushWord(word);
    } else if (!current) {
      current = pushWord(word);
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type TextOptions = {
  x: number;
  /** Baseline of the first line. */
  y: number;
  size: number;
  lineHeight?: number;
  weight?: number;
  fill: string;
  anchor?: "start" | "middle" | "end";
  extra?: string;
};

/** One `<text>` element: a single line is a plain text node (readable by
 * assistive tech and tests as one string); wrapped lines become tspans. */
export function svgText(lines: string[], options: TextOptions): string {
  if (!lines.length) return "";
  const { x, y, size, weight = 400, fill, anchor, extra = "" } = options;
  const lineHeight = options.lineHeight ?? Math.round(size * 1.4);
  const attrs =
    `x="${x}" y="${y}" font-size="${size}" fill="${fill}"` +
    (weight !== 400 ? ` font-weight="${weight}"` : "") +
    (anchor && anchor !== "start" ? ` text-anchor="${anchor}"` : "") +
    (extra ? ` ${extra}` : "");
  if (lines.length === 1) return `<text ${attrs}>${escapeXml(lines[0]!)}</text>`;
  const spans = lines
    .map((line, index) => `<tspan x="${x}"${index === 0 ? "" : ` dy="${lineHeight}"`}>${escapeXml(line)}</tspan>`)
    .join("");
  return `<text ${attrs}>${spans}</text>`;
}

/** Root `<svg>` wrapper used by every Aperture-drawn figure. */
export function diagramSvg(
  width: number,
  height: number,
  background: string,
  fontFamily: string,
  label: string,
  body: string,
): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" width="100%" role="img" aria-label="${escapeXml(label)}">` +
    `<rect width="${Math.ceil(width)}" height="${Math.ceil(height)}" fill="${background}" />` +
    `<g font-family="${escapeXml(fontFamily)}">${body}</g>` +
    `</svg>`
  );
}
