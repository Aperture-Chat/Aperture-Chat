/** Steward structure diagrams: reference-grade entity charts from structured
 * JSON instead of Mermaid.
 *
 * Mermaid's auto-layout cannot reproduce the hand-built quality bar for this
 * genre (estate plans, org/trust structures, deal maps): cards with a navy
 * header band, detail bullets, color-coded status footers, elbow connectors,
 * a legend. So the model emits data — rows of cards plus edges — in a
 * ```steward-diagram fenced JSON block, and this module owns every pixel of
 * layout and styling. Structured data is also what makes the GUI editor
 * honest: every card field is a form input, no source parsing heuristics.
 */

import { MERMAID_FONT_FAMILY, rasterizeSvgToPngDataUrl } from "./mermaidRender";
import { parseStructuredDiagramSource } from "./structuredDiagramSource";

export type StewardDiagramTone = "neutral" | "positive" | "warning";
export type StewardDiagramEdgeKind = "primary" | "contingent" | "inactive";

export type StewardDiagramCard = {
  id: string;
  title: string;
  subtitle?: string;
  bullets?: string[];
  footer?: { text: string; tone?: StewardDiagramTone };
  /** Amber inset callout inside the card body (watch items, risks). */
  note?: string;
  /** "banner" renders a compact solid-navy card (people / principals). */
  variant?: "card" | "banner";
};

export type StewardDiagramEdge = {
  from: string;
  to: string;
  kind?: StewardDiagramEdgeKind;
  label?: string;
};

export type StewardDiagramModel = {
  title?: string;
  subtitle?: string;
  /** Small top-right tag, e.g. "Confidential — attorney work product". */
  tag?: string;
  rows: StewardDiagramCard[][];
  edges: StewardDiagramEdge[];
  legend?: Array<{ kind: StewardDiagramEdgeKind; label: string }>;
  footnote?: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asTone(value: unknown): StewardDiagramTone | undefined {
  return value === "neutral" || value === "positive" || value === "warning" ? value : undefined;
}

function asEdgeKind(value: unknown): StewardDiagramEdgeKind {
  return value === "contingent" || value === "inactive" ? value : "primary";
}

function parseCard(value: unknown): StewardDiagramCard | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id);
  const title = asString(raw.title);
  if (!id || !title) return null;
  const bullets = Array.isArray(raw.bullets)
    ? raw.bullets.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : undefined;
  const footerRaw = raw.footer as Record<string, unknown> | undefined;
  const footerText = footerRaw && typeof footerRaw === "object" ? asString(footerRaw.text) : undefined;
  return {
    id,
    title,
    subtitle: asString(raw.subtitle),
    bullets: bullets && bullets.length > 0 ? bullets : undefined,
    footer: footerText ? { text: footerText, tone: asTone(footerRaw?.tone) ?? "neutral" } : undefined,
    note: asString(raw.note),
    variant: raw.variant === "banner" ? "banner" : "card",
  };
}

/** Parses fenced steward-diagram JSON or YAML into a validated model, or null
 * when the text is not yet valid (mid-stream) or structurally unusable.
 * Unknown fields are dropped; edges pointing at unknown cards are dropped. */
export function parseStewardDiagram(text: string): StewardDiagramModel | null {
  const raw = parseStructuredDiagramSource(text);
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.rows)) return null;
  const rows: StewardDiagramCard[][] = [];
  const ids = new Set<string>();
  // Arrows can ride on their source card as "connects" so a truncated reply
  // keeps every arrow whose card survived; top-level "edges" also work.
  const edgeCandidates: Array<Record<string, unknown> & { from?: unknown }> = [];
  for (const rowRaw of data.rows) {
    const cardsRaw = Array.isArray(rowRaw) ? rowRaw : (rowRaw as Record<string, unknown>)?.cards;
    if (!Array.isArray(cardsRaw)) continue;
    const row: StewardDiagramCard[] = [];
    for (const cardRaw of cardsRaw) {
      const card = parseCard(cardRaw);
      if (!card || ids.has(card.id)) continue;
      ids.add(card.id);
      row.push(card);
      const connects = (cardRaw as Record<string, unknown>).connects;
      if (Array.isArray(connects)) {
        for (const connectRaw of connects) {
          if (connectRaw && typeof connectRaw === "object") {
            edgeCandidates.push({ ...(connectRaw as Record<string, unknown>), from: card.id });
          }
        }
      }
    }
    if (row.length > 0) rows.push(row);
  }
  if (rows.length === 0) return null;
  if (Array.isArray(data.edges)) {
    for (const edgeRaw of data.edges) {
      if (edgeRaw && typeof edgeRaw === "object") edgeCandidates.push(edgeRaw as Record<string, unknown>);
    }
  }
  const edges: StewardDiagramEdge[] = [];
  const seenEdges = new Set<string>();
  for (const edge of edgeCandidates) {
    const from = asString(edge.from);
    const to = asString(edge.to);
    if (!from || !to || !ids.has(from) || !ids.has(to) || from === to) continue;
    const candidate: StewardDiagramEdge = { from, to, kind: asEdgeKind(edge.kind), label: asString(edge.label) };
    const key = `${candidate.from}→${candidate.to}|${candidate.kind}|${candidate.label ?? ""}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(candidate);
  }
  const legend: StewardDiagramModel["legend"] = [];
  if (Array.isArray(data.legend)) {
    for (const entryRaw of data.legend) {
      if (!entryRaw || typeof entryRaw !== "object") continue;
      const entry = entryRaw as Record<string, unknown>;
      const label = asString(entry.label);
      if (label) legend.push({ kind: asEdgeKind(entry.kind), label });
    }
  }
  return {
    title: asString(data.title),
    subtitle: asString(data.subtitle),
    tag: asString(data.tag),
    rows,
    edges,
    legend: legend.length > 0 ? legend : undefined,
    footnote: asString(data.footnote),
  };
}

export function serializeStewardDiagram(model: StewardDiagramModel): string {
  return JSON.stringify(model, null, 2);
}

function closeOpenStructures(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return null;
    }
  }
  let repaired = text;
  if (inString) repaired += '"';
  repaired = repaired.replace(/[,:]\s*$/, "");
  return repaired + stack.reverse().join("");
}

/** Best-effort recovery of a reply that was cut off mid-diagram: balance the
 * truncated JSON (closing open strings/arrays/objects, chopping a dangling
 * partial element) until it parses, then validate as usual. Returns null when
 * nothing usable can be salvaged. Callers must present the result as a
 * recovery, not as the complete chart. */
export function parseStewardDiagramTruncated(text: string): StewardDiagramModel | null {
  let candidate = text.trim();
  if (!candidate.startsWith("{")) return null;
  for (let attempts = 0; attempts < 60 && candidate.length > 2; attempts++) {
    const closed = closeOpenStructures(candidate);
    if (closed !== null) {
      const model = parseStewardDiagram(closed);
      if (model) return model;
    }
    const cut = Math.max(candidate.lastIndexOf(","), candidate.lastIndexOf("["), candidate.lastIndexOf("{"));
    if (cut <= 0) return null;
    candidate = candidate.slice(0, cut);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Layout + SVG                                                        */
/* ------------------------------------------------------------------ */

const CANVAS_W = 1240;
const MARGIN = 30;
const GUTTER = 22;
const ROW_GAP = 62;

const NAVY = "#1b2a4a";
const CARD_BORDER = "#c6cfdb";
const BODY_TEXT = "#1f2a37";
const MUTED_TEXT = "#5c6b7a";
const TONE_STYLES: Record<StewardDiagramTone, { bg: string; text: string }> = {
  neutral: { bg: "#e9edf5", text: "#33415c" },
  positive: { bg: "#e6f1ea", text: "#1c4428" },
  warning: { bg: "#fbf1dd", text: "#7a5a18" },
};
const NOTE_STYLE = { bg: "#fbf1dd", border: "#e3c98b", text: "#6b4a12" };
const EDGE_STYLES: Record<StewardDiagramEdgeKind, { color: string; dash?: string }> = {
  primary: { color: "#33415c" },
  contingent: { color: "#c9a227", dash: "6 4" },
  inactive: { color: "#8b94a3", dash: "3 4" },
};

let measureContext: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, size: number, bold: boolean): number {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  if (measureContext) {
    measureContext.font = `${bold ? "600 " : ""}${size}px ${MERMAID_FONT_FAMILY}`;
    return measureContext.measureText(text).width;
  }
  // Headless fallback (tests): average glyph width for the app font.
  return text.length * size * (bold ? 0.62 : 0.58);
}

function wrapText(text: string, maxWidth: number, size: number, bold: boolean): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (current !== "" && textWidth(candidate, size, bold) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type TextBlock = { lines: string[]; size: number; lineHeight: number; bold: boolean };

function block(text: string, maxWidth: number, size: number, lineHeight: number, bold: boolean): TextBlock {
  return { lines: wrapText(text, maxWidth, size, bold), size, lineHeight, bold };
}

function blockHeight(item: TextBlock): number {
  return item.lines.length * item.lineHeight;
}

type CardLayout = {
  card: StewardDiagramCard;
  x: number;
  y: number;
  width: number;
  height: number;
  headerH: number;
  title: TextBlock;
  subtitle?: TextBlock;
  bullets: TextBlock[];
  note?: TextBlock;
  footer?: TextBlock;
  minHeight: number;
};

function layoutCard(card: StewardDiagramCard, width: number): Omit<CardLayout, "x" | "y" | "height"> {
  const banner = card.variant === "banner";
  const innerW = width - (banner ? 24 : 26);
  const title = block(card.title, innerW, banner ? 12.5 : 11.5, banner ? 16 : 15, true);
  const subtitle = card.subtitle ? block(card.subtitle, innerW, 9.3, 13, false) : undefined;
  const headerH = banner
    ? blockHeight(title) + (subtitle ? blockHeight(subtitle) : 0) + 20
    : blockHeight(title) + (subtitle ? blockHeight(subtitle) : 0) + 16;
  const bulletW = innerW - 12;
  const bullets = (card.bullets ?? []).map((bullet) => block(bullet, bulletW, 10, 13.5, false));
  const note = card.note ? block(card.note, innerW - 18, 9.3, 12.5, false) : undefined;
  const footer = card.footer ? block(card.footer.text, innerW - 6, 9.3, 12.5, true) : undefined;
  let minHeight = headerH;
  if (bullets.length > 0) minHeight += 10 + bullets.reduce((sum, b) => sum + blockHeight(b), 0) + (bullets.length - 1) * 6 + 10;
  if (note) minHeight += blockHeight(note) + 16 + 8;
  if (footer) minHeight += blockHeight(footer) + 14;
  if (banner) minHeight = Math.max(minHeight, 46);
  return { card, width, headerH, title, subtitle, bullets, note, footer, minHeight };
}


/* The layout is a semantic display list: rects, edge paths, and positioned
 * text runs, each tagged with the card/field it came from. Both renderers
 * consume it — renderStewardDiagramSvg serializes it to a static SVG string
 * (PNG/SVG export, previews), and StewardDiagramCanvas renders it as live JSX
 * where every tagged text is click-to-edit and every card box is movable. */

export type StewardTextField =
  | { scope: "card"; cardId: string; field: "title" | "subtitle" | "note" | "footer" }
  | { scope: "bullet"; cardId: string; index: number }
  | { scope: "chart"; field: "title" | "subtitle" | "footnote" };

export type StewardDiagramTextEl = {
  x: number;
  y: number;
  block: TextBlock;
  color: string;
  anchor?: "start" | "middle" | "end";
  italic?: boolean;
  /** Canvas-colored halo painted behind edge labels crossing lines. */
  halo?: string;
  cardId?: string;
  fieldRef?: StewardTextField;
};

export type StewardDiagramRectEl = {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke?: string;
  cardId?: string;
};

export type StewardDiagramPathEl = {
  d: string;
  color: string;
  dash?: string;
  markerKind: StewardDiagramEdgeKind;
};

export type StewardDiagramCardBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rowIndex: number;
  columnIndex: number;
};

export type StewardDiagramLayout = {
  width: number;
  height: number;
  rects: StewardDiagramRectEl[];
  paths: StewardDiagramPathEl[];
  texts: StewardDiagramTextEl[];
  cardBoxes: StewardDiagramCardBox[];
};

export type { TextBlock as StewardTextBlock };

export function stewardTextBlockHeight(item: TextBlock): number {
  return blockHeight(item);
}

export const STEWARD_EDGE_COLORS = EDGE_STYLES;

export function computeStewardDiagramLayout(model: StewardDiagramModel, dark: boolean): StewardDiagramLayout {
  const canvasText = dark ? "#e9f3f7" : "#12233a";
  const canvasMuted = dark ? "#9fb1bd" : MUTED_TEXT;
  const rects: StewardDiagramRectEl[] = [];
  const texts: StewardDiagramTextEl[] = [];
  const paths: StewardDiagramPathEl[] = [];
  const cardBoxes: StewardDiagramCardBox[] = [];
  let y = 26;

  if (model.tag) {
    const tag = block(model.tag, 320, 9.5, 12.5, true);
    texts.push({ x: CANVAS_W - MARGIN, y: 20, block: tag, color: "#a3273a", anchor: "end" });
  }
  if (model.title) {
    const title = block(model.title, CANVAS_W - 2 * MARGIN - 330, 19, 24, true);
    texts.push({ x: MARGIN, y, block: title, color: canvasText, fieldRef: { scope: "chart", field: "title" } });
    y += blockHeight(title) + 6;
  }
  if (model.subtitle) {
    const subtitle = block(model.subtitle, CANVAS_W - 2 * MARGIN, 10.5, 14, false);
    texts.push({ x: MARGIN, y, block: subtitle, color: canvasMuted, fieldRef: { scope: "chart", field: "subtitle" } });
    y += blockHeight(subtitle) + 4;
  }
  y += 14;

  // Rows: equal card widths per row; every card stretches to the row height
  // so footers align, exactly like the reference chart.
  const cards = new Map<string, CardLayout>();
  const rowBottoms: number[] = [];
  model.rows.forEach((row, rowIndex) => {
    const cardW = (CANVAS_W - 2 * MARGIN - (row.length - 1) * GUTTER) / row.length;
    const laidOut = row.map((card) => layoutCard(card, cardW));
    const rowH = Math.max(...laidOut.map((item) => item.minHeight));
    row.forEach((card, columnIndex) => {
      const x = MARGIN + columnIndex * (cardW + GUTTER);
      cards.set(card.id, { ...laidOut[columnIndex], x, y, height: rowH });
      cardBoxes.push({ id: card.id, x, y, width: cardW, height: rowH, rowIndex, columnIndex });
    });
    y += rowH;
    rowBottoms.push(y);
    y += ROW_GAP;
  });
  y -= ROW_GAP;

  for (const layout of cards.values()) {
    const { card, x, width, height, headerH } = layout;
    const cardId = card.id;
    if (card.variant === "banner") {
      rects.push({ x, y: layout.y, width, height, fill: NAVY, cardId });
      const contentH = blockHeight(layout.title) + (layout.subtitle ? blockHeight(layout.subtitle) : 0);
      const textY = layout.y + (height - contentH) / 2;
      texts.push({
        x: x + width / 2,
        y: textY,
        block: layout.title,
        color: "#ffffff",
        anchor: "middle",
        cardId,
        fieldRef: { scope: "card", cardId, field: "title" },
      });
      if (layout.subtitle) {
        texts.push({
          x: x + width / 2,
          y: textY + blockHeight(layout.title) + 1,
          block: layout.subtitle,
          color: "#c9d4e6",
          anchor: "middle",
          cardId,
          fieldRef: { scope: "card", cardId, field: "subtitle" },
        });
      }
      continue;
    }
    rects.push({ x, y: layout.y, width, height, fill: "#ffffff", stroke: CARD_BORDER, cardId });
    rects.push({ x, y: layout.y, width, height: headerH, fill: NAVY, cardId });
    texts.push({
      x: x + 13,
      y: layout.y + 8,
      block: layout.title,
      color: "#ffffff",
      cardId,
      fieldRef: { scope: "card", cardId, field: "title" },
    });
    if (layout.subtitle) {
      texts.push({
        x: x + 13,
        y: layout.y + 8 + blockHeight(layout.title) + 1,
        block: layout.subtitle,
        color: "#c9d4e6",
        cardId,
        fieldRef: { scope: "card", cardId, field: "subtitle" },
      });
    }
    let cursor = layout.y + headerH + 10;
    layout.bullets.forEach((bullet, index) => {
      rects.push({ x: x + 13, y: cursor + 4, width: 4, height: 4, fill: NAVY, cardId });
      texts.push({
        x: x + 23,
        y: cursor,
        block: bullet,
        color: BODY_TEXT,
        cardId,
        fieldRef: { scope: "bullet", cardId, index },
      });
      cursor += blockHeight(bullet) + 6;
    });
    const footerH = layout.footer ? blockHeight(layout.footer) + 14 : 0;
    if (layout.note) {
      const noteH = blockHeight(layout.note) + 16;
      const noteY = layout.y + height - footerH - noteH - 8;
      rects.push({ x: x + 8, y: noteY, width: width - 16, height: noteH, fill: NOTE_STYLE.bg, stroke: NOTE_STYLE.border, cardId });
      texts.push({
        x: x + 17,
        y: noteY + 8,
        block: layout.note,
        color: NOTE_STYLE.text,
        cardId,
        fieldRef: { scope: "card", cardId, field: "note" },
      });
    }
    if (layout.footer && card.footer) {
      const tone = TONE_STYLES[card.footer.tone ?? "neutral"];
      const footerY = layout.y + height - footerH;
      rects.push({ x, y: footerY, width, height: footerH, fill: tone.bg, cardId });
      texts.push({
        x: x + width / 2,
        y: footerY + 7,
        block: layout.footer,
        color: tone.text,
        anchor: "middle",
        cardId,
        fieldRef: { scope: "card", cardId, field: "footer" },
      });
    }
  }

  // Elbow connectors, staggered per row gap so parallel runs never overlap.
  const rowIndexOf = new Map<string, number>();
  model.rows.forEach((row, index) => row.forEach((card) => rowIndexOf.set(card.id, index)));
  const gapUse = new Map<number, number>();
  for (const edge of model.edges) {
    const from = cards.get(edge.from);
    const to = cards.get(edge.to);
    if (!from || !to) continue;
    const kind = edge.kind ?? "primary";
    const style = EDGE_STYLES[kind];
    const fromRow = rowIndexOf.get(edge.from) ?? 0;
    const toRow = rowIndexOf.get(edge.to) ?? 0;
    let labelX = 0;
    let labelY = 0;
    if (fromRow === toRow) {
      const [left, right] = from.x < to.x ? [from, to] : [to, from];
      const lineY = left.y + Math.min(left.headerH, right.headerH) / 2;
      const x1 = from.x < to.x ? left.x + left.width : right.x;
      const x2 = from.x < to.x ? right.x - 5 : left.x + left.width + 5;
      paths.push({ d: `M ${x1} ${lineY} L ${x2} ${lineY}`, color: style.color, dash: style.dash, markerKind: kind });
      labelX = (x1 + x2) / 2;
      labelY = lineY - 14;
    } else {
      const downward = toRow > fromRow;
      const startY = downward ? from.y + from.height : from.y;
      const endY = downward ? to.y - 5 : to.y + to.height + 5;
      const gapIndex = downward ? fromRow : toRow;
      const used = gapUse.get(gapIndex) ?? 0;
      gapUse.set(gapIndex, used + 1);
      const midY = rowBottoms[gapIndex] + 14 + ((used * 10) % (ROW_GAP - 26));
      const startX = from.x + from.width / 2;
      const endX = to.x + to.width / 2;
      paths.push({
        d: `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`,
        color: style.color,
        dash: style.dash,
        markerKind: kind,
      });
      labelX = (startX + endX) / 2;
      labelY = midY - 12;
    }
    if (edge.label) {
      const label = block(edge.label, 220, 9, 11.5, false);
      texts.push({
        x: labelX,
        y: labelY,
        block: label,
        color: style.color,
        anchor: "middle",
        italic: true,
        halo: dark ? "#0d1c27" : "#ffffff",
      });
    }
  }

  // Legend + footnote.
  let footerLineY = y + 30;
  if (model.legend && model.legend.length > 0) {
    let legendX = MARGIN;
    texts.push({ x: legendX, y: footerLineY - 4, block: block("KEY", 60, 9.5, 12, true), color: canvasText });
    legendX += 44;
    for (const entry of model.legend) {
      const style = EDGE_STYLES[entry.kind];
      paths.push({
        d: `M ${legendX} ${footerLineY + 3} L ${legendX + 34} ${footerLineY + 3}`,
        color: style.color,
        dash: style.dash,
        markerKind: entry.kind,
      });
      const label = block(entry.label, 400, 9.5, 12, false);
      texts.push({ x: legendX + 42, y: footerLineY - 4, block: label, color: canvasMuted });
      legendX += 42 + textWidth(entry.label, 9.5, false) + 34;
    }
    footerLineY += 22;
  }
  if (model.footnote) {
    const footnote = block(model.footnote, CANVAS_W - 2 * MARGIN, 9.3, 12.5, false);
    texts.push({
      x: MARGIN,
      y: footerLineY - 4,
      block: footnote,
      color: canvasMuted,
      fieldRef: { scope: "chart", field: "footnote" },
    });
    footerLineY += blockHeight(footnote) + 4;
  }

  return {
    width: CANVAS_W,
    height: Math.ceil(Math.max(footerLineY + 6, y + 16)),
    rects,
    paths,
    texts,
    cardBoxes,
  };
}

function svgTextMarkup(el: StewardDiagramTextEl): string {
  const spans = el.block.lines
    .map(
      (line, index) =>
        `<tspan x="${el.x}" ${index === 0 ? `y="${el.y + el.block.size}"` : `dy="${el.block.lineHeight}"`}>${escapeXml(line)}</tspan>`,
    )
    .join("");
  const weight = el.block.bold ? ' font-weight="600"' : "";
  const style = el.italic ? ' font-style="italic"' : "";
  const anchor = el.anchor ? ` text-anchor="${el.anchor}"` : "";
  const text = `<text fill="${el.color}" font-size="${el.block.size}"${weight}${style}${anchor}>${spans}</text>`;
  if (!el.halo) return text;
  return `<g style="paint-order: stroke" stroke="${el.halo}" stroke-width="3">${text}</g>`;
}

export function stewardDiagramMarkerDefs(): string {
  return (Object.keys(EDGE_STYLES) as StewardDiagramEdgeKind[])
    .map(
      (kind) =>
        `<marker id="arrow-${kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="${EDGE_STYLES[kind].color}"/></marker>`,
    )
    .join("");
}

/** Lays the model out and renders the full SVG. Deterministic: same model,
 * same markup (theme only changes canvas-level text colors). */
export function renderStewardDiagramSvg(model: StewardDiagramModel, dark: boolean): string {
  const layout = computeStewardDiagramLayout(model, dark);
  const paths = layout.paths
    .map(
      (el) =>
        `<path d="${el.d}" stroke="${el.color}" stroke-width="1.6" fill="none"${
          el.dash ? ` stroke-dasharray="${el.dash}"` : ""
        } marker-end="url(#arrow-${el.markerKind})"/>`,
    )
    .join("");
  const rects = layout.rects
    .map(
      (el) =>
        `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="${el.fill}"${
          el.stroke ? ` stroke="${el.stroke}"` : ""
        }/>`,
    )
    .join("");
  const texts = layout.texts.map(svgTextMarkup).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
    `font-family='${MERMAID_FONT_FAMILY.replace(/'/g, "")}' role="img" aria-label="${escapeXml(model.title ?? "Structure diagram")}">` +
    `<defs>${stewardDiagramMarkerDefs()}</defs>${paths}${rects}${texts}</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* Structured edit helpers shared by the inline canvas and the modal   */
/* ------------------------------------------------------------------ */

function cloneModel(model: StewardDiagramModel): StewardDiagramModel {
  return JSON.parse(JSON.stringify(model)) as StewardDiagramModel;
}

function findCard(model: StewardDiagramModel, cardId: string): StewardDiagramCard | undefined {
  for (const row of model.rows) {
    const card = row.find((item) => item.id === cardId);
    if (card) return card;
  }
  return undefined;
}

export function stewardFieldValue(model: StewardDiagramModel, ref: StewardTextField): string {
  if (ref.scope === "chart") return (model[ref.field] ?? "") as string;
  const card = findCard(model, ref.cardId);
  if (!card) return "";
  if (ref.scope === "bullet") return card.bullets?.[ref.index] ?? "";
  if (ref.field === "footer") return card.footer?.text ?? "";
  return (card[ref.field] ?? "") as string;
}

/** Sets one editable text field; an emptied value removes optional fields
 * (subtitle, note, footer, a bullet line) instead of leaving a blank run. */
export function withStewardFieldValue(
  model: StewardDiagramModel,
  ref: StewardTextField,
  value: string,
): StewardDiagramModel {
  const next = cloneModel(model);
  const text = value.trim();
  if (ref.scope === "chart") {
    next[ref.field] = text || undefined;
    return next;
  }
  const card = findCard(next, ref.cardId);
  if (!card) return next;
  if (ref.scope === "bullet") {
    const bullets = [...(card.bullets ?? [])];
    if (text) bullets[ref.index] = text;
    else bullets.splice(ref.index, 1);
    card.bullets = bullets.length > 0 ? bullets : undefined;
    return next;
  }
  if (ref.field === "title") {
    card.title = text || card.title;
  } else if (ref.field === "footer") {
    card.footer = text ? { text, tone: card.footer?.tone ?? "neutral" } : undefined;
  } else {
    card[ref.field] = text || undefined;
  }
  return next;
}

/** Moves a card one slot left/right within its row, or up/down to the
 * neighboring row (from an edge row with siblings, a new row is created so a
 * card can always be pulled out on its own). Returns null when the move is
 * impossible. */
export function moveStewardCard(
  model: StewardDiagramModel,
  cardId: string,
  direction: "left" | "right" | "up" | "down",
): StewardDiagramModel | null {
  const next = cloneModel(model);
  const rowIndex = next.rows.findIndex((row) => row.some((card) => card.id === cardId));
  if (rowIndex < 0) return null;
  const row = next.rows[rowIndex];
  const columnIndex = row.findIndex((card) => card.id === cardId);
  if (direction === "left" || direction === "right") {
    const target = direction === "left" ? columnIndex - 1 : columnIndex + 1;
    if (target < 0 || target >= row.length) return null;
    [row[columnIndex], row[target]] = [row[target], row[columnIndex]];
    return next;
  }
  const [card] = row.splice(columnIndex, 1);
  const targetRow = direction === "up" ? rowIndex - 1 : rowIndex + 1;
  if (targetRow >= 0 && targetRow < next.rows.length) {
    next.rows[targetRow].push(card);
  } else if (row.length > 0) {
    next.rows.splice(direction === "up" ? rowIndex : rowIndex + 1, 0, [card]);
  } else {
    return null;
  }
  if (row.length === 0) next.rows.splice(next.rows.findIndex((r) => r === row), 1);
  return next;
}

export function removeStewardCard(model: StewardDiagramModel, cardId: string): StewardDiagramModel {
  const next = cloneModel(model);
  next.rows = next.rows.map((row) => row.filter((card) => card.id !== cardId)).filter((row) => row.length > 0);
  next.edges = next.edges.filter((edge) => edge.from !== cardId && edge.to !== cardId);
  return next;
}

/** Renders steward-diagram JSON straight to a light-theme PNG data URL for
 * document surfaces (Drafts pages are always white). Truncated sources render
 * their salvageable portion — the transfer should carry whatever the reader
 * saw in chat. Returns null when nothing renders. */
export async function renderStewardDiagramPngDataUrl(source: string): Promise<string | null> {
  const model = parseStewardDiagram(source) ?? parseStewardDiagramTruncated(source);
  if (!model) return null;
  return rasterizeSvgToPngDataUrl(renderStewardDiagramSvg(model, false), "#ffffff");
}
