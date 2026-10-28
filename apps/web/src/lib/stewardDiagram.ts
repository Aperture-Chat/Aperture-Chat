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

import { DIAGRAM_FONT_FAMILY, type DiagramPalette } from "./diagramTheme";
import { escapeXml, measureDiagramText, wrapDiagramText } from "./diagramText";
import {
  isStewardCardColor,
  isStewardDiagramThemeId,
  stewardDiagramPalette,
  stewardHeaderColors,
  type StewardCardColor,
  type StewardDiagramThemeId,
  type StewardHeaderColors,
} from "./diagramThemes";
import { rasterizeSvgToPngDataUrl } from "./mermaidRender";
import {
  parseStructuredDiagramSource,
  parseStructuredSummarySource,
  type StructuredSummaryEntry,
} from "./structuredDiagramSource";
import {
  drawEdgeRoute,
  freeEdgeSkeleton,
  runSkeleton,
  type EdgeSkeleton,
  type Point,
  type RouteBox,
  type StewardDiagramConnector,
  type StewardEdgeHandle,
} from "./stewardDiagramRoutes";

export type { StewardDiagramConnector } from "./stewardDiagramRoutes";
export type StewardDiagramCorners = "rounded" | "square";

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
  /** Top-left in design units, set by dragging; absent = its row slot. */
  position?: { x: number; y: number };
  /** Header color from the theme's swatches; absent = the theme's ink. */
  color?: StewardCardColor;
};

export type StewardDiagramEdge = {
  from: string;
  to: string;
  kind?: StewardDiagramEdgeKind;
  label?: string;
  /** Offset of the arrow's middle run from where the router puts it. */
  bend?: number;
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
  theme?: StewardDiagramThemeId;
  connector?: StewardDiagramConnector;
  corners?: StewardDiagramCorners;
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

/** Largest design-unit coordinate or bend a chart will store. */
const MAX_POSITION = 4000;
const MAX_BEND = 2000;

function clampedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(max, Math.max(min, value)));
}

function asPosition(value: unknown): StewardDiagramCard["position"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const x = clampedNumber(raw.x, 0, MAX_POSITION);
  const y = clampedNumber(raw.y, 0, MAX_POSITION);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function asBend(value: unknown): number | undefined {
  const bend = clampedNumber(value, -MAX_BEND, MAX_BEND);
  return bend === 0 ? undefined : bend;
}

function asOneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.find((option) => option === value);
}

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === "object" ? (value as RawRecord) : null;
}

function asBullets(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const bullets = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return bullets.length > 0 ? bullets : undefined;
}

function asFooter(value: unknown): StewardDiagramCard["footer"] {
  const raw = asRecord(value);
  const text = raw ? asString(raw.text) : undefined;
  return text ? { text, tone: asTone(raw?.tone) ?? "neutral" } : undefined;
}

function parseCard(value: unknown): StewardDiagramCard | null {
  const raw = asRecord(value);
  const id = asString(raw?.id);
  const title = asString(raw?.title);
  if (!raw || !id || !title) return null;
  return {
    id,
    title,
    subtitle: asString(raw.subtitle),
    bullets: asBullets(raw.bullets),
    footer: asFooter(raw.footer),
    note: asString(raw.note),
    variant: raw.variant === "banner" ? "banner" : "card",
    position: asPosition(raw.position),
    color: isStewardCardColor(raw.color) ? raw.color : undefined,
  };
}

type ParsedRows = { rows: StewardDiagramCard[][]; ids: Set<string>; edgeCandidates: RawRecord[] };

/** Arrows can ride on their source card as "connects" so a truncated reply
 * keeps every arrow whose card survived; top-level "edges" also work. */
function connectsOf(cardRaw: unknown, cardId: string): RawRecord[] {
  const connects = asRecord(cardRaw)?.connects;
  if (!Array.isArray(connects)) return [];
  return connects.flatMap((connect) => {
    const raw = asRecord(connect);
    return raw ? [{ ...raw, from: cardId }] : [];
  });
}

function parseRows(rowsRaw: unknown[]): ParsedRows {
  const parsed: ParsedRows = { rows: [], ids: new Set(), edgeCandidates: [] };
  for (const rowRaw of rowsRaw) {
    const cardsRaw = Array.isArray(rowRaw) ? rowRaw : asRecord(rowRaw)?.cards;
    if (!Array.isArray(cardsRaw)) continue;
    const row: StewardDiagramCard[] = [];
    for (const cardRaw of cardsRaw) {
      const card = parseCard(cardRaw);
      if (!card || parsed.ids.has(card.id)) continue;
      parsed.ids.add(card.id);
      row.push(card);
      parsed.edgeCandidates.push(...connectsOf(cardRaw, card.id));
    }
    if (row.length > 0) parsed.rows.push(row);
  }
  return parsed;
}

function parseEdge(raw: RawRecord, ids: Set<string>): StewardDiagramEdge | null {
  const from = asString(raw.from);
  const to = asString(raw.to);
  if (!from || !to || !ids.has(from) || !ids.has(to) || from === to) return null;
  return { from, to, kind: asEdgeKind(raw.kind), label: asString(raw.label), bend: asBend(raw.bend) };
}

/** Valid arrows between known cards, first copy of each duplicate kept. */
function parseEdges(candidates: RawRecord[], ids: Set<string>): StewardDiagramEdge[] {
  const edges: StewardDiagramEdge[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const edge = parseEdge(raw, ids);
    const key = edge ? `${edge.from}→${edge.to}|${edge.kind}|${edge.label ?? ""}` : "";
    if (!edge || seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
  }
  return edges;
}

function parseLegend(value: unknown): StewardDiagramModel["legend"] {
  if (!Array.isArray(value)) return undefined;
  const legend = value.flatMap((entryRaw) => {
    const entry = asRecord(entryRaw);
    const label = asString(entry?.label);
    return entry && label ? [{ kind: asEdgeKind(entry.kind), label }] : [];
  });
  return legend.length > 0 ? legend : undefined;
}

function records(value: unknown): RawRecord[] {
  return Array.isArray(value) ? value.flatMap((item) => (asRecord(item) ? [item as RawRecord] : [])) : [];
}

/** Parses fenced steward-diagram JSON or YAML into a validated model, or null
 * when the text is not yet valid (mid-stream) or structurally unusable.
 * Unknown fields are dropped; edges pointing at unknown cards are dropped. */
export function parseStewardDiagram(text: string): StewardDiagramModel | null {
  const data = asRecord(parseStructuredDiagramSource(text));
  if (!data || !Array.isArray(data.rows)) return null;
  const { rows, ids, edgeCandidates } = parseRows(data.rows);
  if (rows.length === 0) return null;
  return {
    title: asString(data.title),
    subtitle: asString(data.subtitle),
    tag: asString(data.tag),
    rows,
    edges: parseEdges([...edgeCandidates, ...records(data.edges)], ids),
    legend: parseLegend(data.legend),
    footnote: asString(data.footnote),
    theme: isStewardDiagramThemeId(data.theme) ? data.theme : undefined,
    connector: asOneOf(data.connector, ["elbow", "curved", "straight"] as const),
    corners: asOneOf(data.corners, ["rounded", "square"] as const),
  };
}

function humanizeSummaryKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Summary";
}

function summaryCardId(key: string, index: number): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  return `${slug || "summary"}-${index + 1}`;
}

function summaryTone(value: string): StewardDiagramTone {
  if (/\b(?:blocked|failed|false|inactive|missing|not\s+achieved|not\s+complete|unavailable|no)\b/i.test(value)) {
    return "warning";
  }
  if (/\b(?:achieved|active|complete(?:d)?|ready|success|true|yes)\b/i.test(value)) {
    return "positive";
  }
  return "neutral";
}

function summaryEntryCard(entry: StructuredSummaryEntry, index: number): StewardDiagramCard {
  const values = entry.values.map(String);
  if (entry.collection) {
    return {
      id: summaryCardId(entry.key, index),
      title: humanizeSummaryKey(entry.key),
      bullets: values,
    };
  }
  const value = values[0] ?? "Not specified";
  return {
    id: summaryCardId(entry.key, index),
    title: humanizeSummaryKey(entry.key),
    footer: { text: value, tone: summaryTone(value) },
  };
}

function rowsOf(cards: StewardDiagramCard[], size: number): StewardDiagramCard[][] {
  const rows: StewardDiagramCard[][] = [];
  for (let index = 0; index < cards.length; index += size) rows.push(cards.slice(index, index + size));
  return rows;
}

/** Convert summary-shaped JSON/YAML into the same visual model as a native
 * aperture-diagram. This makes already-saved model replies visual immediately
 * while preserving the original source behind the Code action. */
export function parseStructuredSummaryDiagram(text: string): StewardDiagramModel | null {
  const summary = parseStructuredSummarySource(text);
  if (!summary) return null;
  const scalarCards: StewardDiagramCard[] = [];
  const collectionCards: StewardDiagramCard[] = [];
  summary.entries.forEach((entry, index) => {
    const card = summaryEntryCard(entry, index);
    (entry.collection ? collectionCards : scalarCards).push(card);
  });
  return {
    title: summary.title,
    subtitle: summary.subtitle ?? "Visualized from structured response data",
    tag: "Visual summary",
    rows: [...rowsOf(scalarCards, 3), ...rowsOf(collectionCards, 3)],
    edges: [],
    footnote: summary.footnote,
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

const MAX_CANVAS_W = 1240;
const MIN_CANVAS_W = 640;
const MIN_CARD_W = 228;
const MARGIN = 30;
const GUTTER = 22;
const ROW_GAP = 64;
const CARD_RADIUS = 10;
/** Corner radius for "square" charts: crisp, not knife-sharp. */
const SQUARE_RADIUS = 3;
/** Dragged cards keep this clearance from the canvas edges. */
const POSITION_INSET = 4;

type EdgeStyle = { color: string; dash?: string };

function edgeStyles(palette: DiagramPalette): Record<StewardDiagramEdgeKind, EdgeStyle> {
  return {
    primary: { color: palette.edgeStrong },
    contingent: { color: palette.contingent, dash: "6 4" },
    inactive: { color: palette.inactive, dash: "3 4" },
  };
}

function toneColors(palette: DiagramPalette, tone: StewardDiagramTone) {
  if (tone === "positive") return palette.tones.positive;
  if (tone === "warning") return palette.tones.warning;
  return palette.tones.accent;
}

/** Canvas width sized to the busiest row so every card keeps a readable
 * measure (≈228px) instead of a fixed 1240px canvas shrunk into a chat
 * column or a document page. */
export function stewardCanvasWidth(model: StewardDiagramModel): number {
  const busiest = Math.max(1, ...model.rows.map((row) => row.length));
  const wanted = busiest * MIN_CARD_W + (busiest - 1) * GUTTER + 2 * MARGIN;
  return Math.min(MAX_CANVAS_W, Math.max(MIN_CANVAS_W, wanted));
}

function wrapText(text: string, maxWidth: number, size: number, bold: boolean): string[] {
  return wrapDiagramText(text, maxWidth, size, bold ? 600 : 400);
}

function textWidth(text: string, size: number, bold: boolean): number {
  return measureDiagramText(text, size, bold ? 600 : 400);
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
  const innerW = width - 28;
  const title = block(card.title, innerW, banner ? 14 : 13.5, banner ? 19 : 18, true);
  const subtitle = card.subtitle ? block(card.subtitle, innerW, 11.5, 15.5, false) : undefined;
  const headerH = blockHeight(title) + (subtitle ? blockHeight(subtitle) + 2 : 0) + (banner ? 24 : 20);
  const bulletW = innerW - 14;
  // Banner bullets are short centered lines under the name (roles, dates).
  const bullets = (card.bullets ?? []).map((bullet) =>
    banner ? block(bullet, innerW, 11.5, 15.5, false) : block(bullet, bulletW, 12.5, 17, false),
  );
  const note = card.note ? block(card.note, innerW - 20, 11.5, 15.5, false) : undefined;
  const footer = card.footer ? block(card.footer.text, innerW - 8, 11.5, 15, true) : undefined;
  let minHeight = headerH;
  if (banner) {
    if (bullets.length > 0) minHeight += 4 + bullets.reduce((sum, b) => sum + blockHeight(b), 0) + (bullets.length - 1) * 2;
    return { card, width, headerH, title, subtitle, bullets, note, footer, minHeight: Math.max(minHeight, 52) };
  }
  if (bullets.length > 0) minHeight += 12 + bullets.reduce((sum, b) => sum + blockHeight(b), 0) + (bullets.length - 1) * 6 + 12;
  if (note) minHeight += blockHeight(note) + 18 + 10;
  if (footer) minHeight += blockHeight(footer) + 16;
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
  | { scope: "chart"; field: "title" | "subtitle" | "footnote" }
  | { scope: "edge"; index: number; field: "label" };

export type StewardDiagramTextEl = {
  x: number;
  y: number;
  block: TextBlock;
  color: string;
  anchor?: "start" | "middle" | "end";
  italic?: boolean;
  /** Canvas-colored halo painted behind edge labels crossing lines. */
  halo?: string;
  letterSpacing?: number;
  cardId?: string;
  /** Index into model.edges for an arrow's label. */
  edgeIndex?: number;
  fieldRef?: StewardTextField;
};

export type StewardDiagramRectEl = {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke?: string;
  /** Corner radius; `corners` limits rounding to the top or bottom edge
   * (card header and footer bands inside a rounded card). */
  rx?: number;
  corners?: "all" | "top" | "bottom";
  shadow?: boolean;
  cardId?: string;
};

export type StewardDiagramPathEl = {
  d: string;
  color: string;
  dash?: string;
  markerKind: StewardDiagramEdgeKind;
  /** Index into model.edges; legend swatches have none. */
  edgeIndex?: number;
  /** Drag handle on the middle run, when the arrow has one. */
  handle?: StewardEdgeHandle;
  ends?: { from: Point; to: Point };
};

export type StewardDiagramCardBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rowIndex: number;
  columnIndex: number;
  headerHeight: number;
  /** Placed by dragging rather than by its row slot. */
  positioned: boolean;
};

export type StewardDiagramLayout = {
  width: number;
  height: number;
  dark: boolean;
  theme?: StewardDiagramThemeId;
  /** Top of the card area, below the chart heading. */
  contentTop: number;
  rects: StewardDiagramRectEl[];
  paths: StewardDiagramPathEl[];
  texts: StewardDiagramTextEl[];
  cardBoxes: StewardDiagramCardBox[];
};

export type { TextBlock as StewardTextBlock };

export function stewardTextBlockHeight(item: TextBlock): number {
  return blockHeight(item);
}

/** SVG path for a rectangle rounded on all corners, or only the top or
 * bottom pair. */
export function stewardRectPath(el: StewardDiagramRectEl): string {
  const { x, y, width: w, height: h } = el;
  const r = Math.min(el.rx ?? 0, w / 2, h / 2);
  const top = el.corners !== "bottom" ? r : 0;
  const bottom = el.corners !== "top" ? r : 0;
  return (
    `M${x + top},${y}H${x + w - top}` +
    (top ? `Q${x + w},${y} ${x + w},${y + top}` : "") +
    `V${y + h - bottom}` +
    (bottom ? `Q${x + w},${y + h} ${x + w - bottom},${y + h}` : "") +
    `H${x + bottom}` +
    (bottom ? `Q${x},${y + h} ${x},${y + h - bottom}` : "") +
    `V${y + top}` +
    (top ? `Q${x},${y} ${x + top},${y}` : "") +
    "Z"
  );
}

/** Everything one layout pass paints into, plus the chart-wide styling. */
type LayoutContext = {
  model: StewardDiagramModel;
  dark: boolean;
  palette: DiagramPalette;
  styles: Record<StewardDiagramEdgeKind, EdgeStyle>;
  width: number;
  radius: number;
  rects: StewardDiagramRectEl[];
  texts: StewardDiagramTextEl[];
  paths: StewardDiagramPathEl[];
};

/** Tag pill, title, and subtitle; returns the y where cards start. */
function layoutHeading(ctx: LayoutContext): number {
  const { model, palette, width } = ctx;
  let y = 26;
  let tagWidth = 0;
  if (model.tag) {
    const tag = block(model.tag, 300, 10.5, 13, true);
    tagWidth = Math.min(320, Math.max(...tag.lines.map((line) => textWidth(line, 10.5, true)))) + 20;
    const tagHeight = blockHeight(tag) + 10;
    const pillRadius = tagHeight / 2 > 12 ? 8 : tagHeight / 2;
    ctx.rects.push({
      x: width - MARGIN - tagWidth,
      y: 18,
      width: tagWidth,
      height: tagHeight,
      fill: palette.tones.accent.fill,
      stroke: palette.tones.accent.border,
      rx: model.corners === "square" ? SQUARE_RADIUS : pillRadius,
    });
    ctx.texts.push({
      x: width - MARGIN - tagWidth / 2,
      y: 18 + 3,
      block: tag,
      color: palette.tones.accent.text,
      anchor: "middle",
      letterSpacing: 0.2,
    });
  }
  if (model.title) {
    const title = block(model.title, Math.max(160, width - 2 * MARGIN - (tagWidth ? tagWidth + 24 : 0)), 20, 26, true);
    ctx.texts.push({ x: MARGIN, y, block: title, color: palette.text, fieldRef: { scope: "chart", field: "title" } });
    y += blockHeight(title) + 6;
  }
  if (model.subtitle) {
    const subtitle = block(model.subtitle, width - 2 * MARGIN, 12.5, 17, false);
    ctx.texts.push({ x: MARGIN, y, block: subtitle, color: palette.muted, fieldRef: { scope: "chart", field: "subtitle" } });
    y += blockHeight(subtitle) + 4;
  }
  return y + (model.title || model.subtitle ? 18 : 4);
}

type RowGeometry = {
  rowOf: Map<string, number>;
  columnOf: Map<string, number>;
  busyGaps: Set<number>;
  rowGutters: number[];
};

/** Which gaps between rows carry connectors (they need room for elbows and
 * labels); empty gaps stay tight. Same-row labeled arrows widen their row's
 * gutter so the label sits in clear space instead of on a card header. */
function rowGeometry(model: StewardDiagramModel): RowGeometry {
  const rowOf = new Map<string, number>();
  const columnOf = new Map<string, number>();
  model.rows.forEach((row, index) =>
    row.forEach((card, column) => {
      rowOf.set(card.id, index);
      columnOf.set(card.id, column);
    }),
  );
  const geometry: RowGeometry = { rowOf, columnOf, busyGaps: new Set(), rowGutters: model.rows.map(() => GUTTER) };
  for (const edge of model.edges) {
    const fromRow = rowOf.get(edge.from);
    const toRow = rowOf.get(edge.to);
    if (fromRow === undefined || toRow === undefined) continue;
    if (fromRow !== toRow) geometry.busyGaps.add(Math.min(fromRow, toRow));
    else if (skipsCards(geometry, edge)) geometry.busyGaps.add(fromRow);
    else if (edge.label) {
      const needed = Math.min(150, textWidth(edge.label, 11, false) + 26);
      geometry.rowGutters[fromRow] = Math.max(geometry.rowGutters[fromRow]!, needed);
    }
  }
  return geometry;
}

/** Same-row arrows that skip over a card run below the row instead. */
function skipsCards(geometry: RowGeometry, edge: StewardDiagramEdge): boolean {
  return Math.abs((geometry.columnOf.get(edge.from) ?? 0) - (geometry.columnOf.get(edge.to) ?? 0)) > 1;
}

type RowsLayout = {
  cards: Map<string, CardLayout>;
  cardBoxes: StewardDiagramCardBox[];
  rowBottoms: number[];
  /** Bottom of the lowest card, row-placed or dragged. */
  bottom: number;
};

function placedAt(card: StewardDiagramCard, slot: { x: number; y: number }, cardW: number, ctx: LayoutContext, top: number) {
  if (!card.position) return slot;
  return {
    x: Math.min(Math.max(card.position.x, POSITION_INSET), Math.max(POSITION_INSET, ctx.width - cardW - POSITION_INSET)),
    y: Math.max(card.position.y, top),
  };
}

/** Rows: equal card widths per row; every card stretches to the row height
 * so footers align. A dragged card keeps its row's size but sits where it
 * was dropped; its row slot stays open. */
function layoutRows(ctx: LayoutContext, geometry: RowGeometry, top: number): RowsLayout {
  const { model, width } = ctx;
  const cards = new Map<string, CardLayout>();
  const cardBoxes: StewardDiagramCardBox[] = [];
  const rowBottoms: number[] = [];
  const rowGap = (index: number) => (geometry.busyGaps.has(index) ? ROW_GAP : 26);
  let y = top;
  model.rows.forEach((row, rowIndex) => {
    const gutter = geometry.rowGutters[rowIndex]!;
    const cardW = (width - 2 * MARGIN - (row.length - 1) * gutter) / row.length;
    const laidOut = row.map((card) => layoutCard(card, cardW));
    const rowH = Math.max(...laidOut.map((item) => item.minHeight));
    row.forEach((card, columnIndex) => {
      const at = placedAt(card, { x: MARGIN + columnIndex * (cardW + gutter), y }, cardW, ctx, top);
      const item = laidOut[columnIndex]!;
      cards.set(card.id, { ...item, x: at.x, y: at.y, height: rowH });
      cardBoxes.push({
        id: card.id,
        x: at.x,
        y: at.y,
        width: cardW,
        height: rowH,
        rowIndex,
        columnIndex,
        headerHeight: item.headerH,
        positioned: Boolean(card.position),
      });
    });
    y += rowH;
    rowBottoms.push(y);
    y += rowGap(rowIndex);
  });
  y -= rowGap(model.rows.length - 1);
  const bottom = Math.max(y, ...cardBoxes.filter((box) => box.positioned).map((box) => box.y + box.height));
  return { cards, cardBoxes, rowBottoms, bottom };
}

function drawBannerCard(ctx: LayoutContext, layout: CardLayout, header: StewardHeaderColors) {
  const { card, x, width: cardWidth, height } = layout;
  const cardId = card.id;
  ctx.rects.push({ x, y: layout.y, width: cardWidth, height, fill: header.fill, stroke: header.border, rx: ctx.radius, shadow: true, cardId });
  const bulletsH = layout.bullets.length
    ? 4 + layout.bullets.reduce((sum, item) => sum + blockHeight(item), 0) + (layout.bullets.length - 1) * 2
    : 0;
  const subtitleH = layout.subtitle ? blockHeight(layout.subtitle) + 2 : 0;
  const contentH = blockHeight(layout.title) + subtitleH + bulletsH;
  const textY = layout.y + (height - contentH) / 2;
  const centerX = x + cardWidth / 2;
  const centered = { x: centerX, anchor: "middle" as const, cardId };
  ctx.texts.push({ ...centered, y: textY, block: layout.title, color: header.text, fieldRef: { scope: "card", cardId, field: "title" } });
  if (layout.subtitle) {
    ctx.texts.push({
      ...centered,
      y: textY + blockHeight(layout.title) + 2,
      block: layout.subtitle,
      color: header.subtext,
      fieldRef: { scope: "card", cardId, field: "subtitle" },
    });
  }
  let bulletY = textY + blockHeight(layout.title) + subtitleH + 4;
  layout.bullets.forEach((bullet, index) => {
    ctx.texts.push({ ...centered, y: bulletY, block: bullet, color: header.subtext, fieldRef: { scope: "bullet", cardId, index } });
    bulletY += blockHeight(bullet) + 2;
  });
}

function drawCardBody(ctx: LayoutContext, layout: CardLayout) {
  const { palette } = ctx;
  const { card, x, width: cardWidth, height, headerH } = layout;
  const cardId = card.id;
  let cursor = layout.y + headerH + 12;
  layout.bullets.forEach((bullet, index) => {
    ctx.rects.push({ x: x + 14, y: cursor + 6.5, width: 5, height: 5, fill: palette.series[0]!, rx: 2.5, cardId });
    ctx.texts.push({ x: x + 26, y: cursor, block: bullet, color: palette.node.text, cardId, fieldRef: { scope: "bullet", cardId, index } });
    cursor += blockHeight(bullet) + 6;
  });
  const footerH = layout.footer ? blockHeight(layout.footer) + 16 : 0;
  if (layout.note) {
    const noteH = blockHeight(layout.note) + 18;
    const noteY = layout.y + height - footerH - noteH - 10;
    ctx.rects.push({
      x: x + 10,
      y: noteY,
      width: cardWidth - 20,
      height: noteH,
      fill: palette.tones.warning.fill,
      stroke: palette.tones.warning.border,
      rx: ctx.radius === SQUARE_RADIUS ? SQUARE_RADIUS : 7,
      cardId,
    });
    ctx.texts.push({ x: x + 20, y: noteY + 9, block: layout.note, color: palette.tones.warning.text, cardId, fieldRef: { scope: "card", cardId, field: "note" } });
  }
  if (layout.footer && card.footer) {
    const tone = toneColors(palette, card.footer.tone ?? "neutral");
    const footerY = layout.y + height - footerH;
    ctx.rects.push({ x: x + 0.5, y: footerY, width: cardWidth - 1, height: footerH - 0.5, fill: tone.fill, rx: ctx.radius - 0.5, corners: "bottom", cardId });
    ctx.texts.push({
      x: x + cardWidth / 2,
      y: footerY + 8,
      block: layout.footer,
      color: tone.text,
      anchor: "middle",
      cardId,
      fieldRef: { scope: "card", cardId, field: "footer" },
    });
  }
}

function drawCard(ctx: LayoutContext, layout: CardLayout) {
  const { palette, dark, model } = ctx;
  const { card, x, width: cardWidth, height, headerH } = layout;
  const cardId = card.id;
  const header = stewardHeaderColors(model.theme, dark, card.color);
  if (card.variant === "banner") {
    drawBannerCard(ctx, layout, header);
    return;
  }
  const cardFill = dark ? palette.node.fill : palette.canvas;
  ctx.rects.push({ x, y: layout.y, width: cardWidth, height, fill: cardFill, stroke: palette.node.border, rx: ctx.radius, shadow: true, cardId });
  ctx.rects.push({ x, y: layout.y, width: cardWidth, height: headerH, fill: header.fill, rx: ctx.radius, corners: "top", cardId });
  ctx.texts.push({ x: x + 14, y: layout.y + 10, block: layout.title, color: header.text, cardId, fieldRef: { scope: "card", cardId, field: "title" } });
  if (layout.subtitle) {
    ctx.texts.push({
      x: x + 14,
      y: layout.y + 10 + blockHeight(layout.title) + 2,
      block: layout.subtitle,
      color: header.subtext,
      cardId,
      fieldRef: { scope: "card", cardId, field: "subtitle" },
    });
  }
  drawCardBody(ctx, layout);
}

function routeBox(layout: CardLayout): RouteBox {
  return { x: layout.x, y: layout.y, width: layout.width, height: layout.height, headerHeight: layout.headerH };
}

/** Next staggered run in a row gap, so parallel runs never overlap. */
function staggeredRun(gapUse: Map<number, number>, gapIndex: number, rowBottoms: number[]): number {
  const used = gapUse.get(gapIndex) ?? 0;
  gapUse.set(gapIndex, used + 1);
  return rowBottoms[gapIndex]! + 16 + ((used * 10) % (ROW_GAP - 30));
}

type RowRouteContext = { geometry: RowGeometry; rowBottoms: number[]; gapUse: Map<number, number> };

/** Same-row arrows: straight across to a neighbor, or under the row when
 * they skip over a card. */
function sameRowSkeleton(edge: StewardDiagramEdge, from: CardLayout, to: CardLayout, route: RowRouteContext, bend: number): EdgeSkeleton {
  if (skipsCards(route.geometry, edge)) {
    const row = route.geometry.rowOf.get(edge.from) ?? 0;
    const run = staggeredRun(route.gapUse, row, route.rowBottoms) + bend;
    return runSkeleton([from.x + from.width / 2, from.y + from.height], [to.x + to.width / 2, to.y + to.height + 4], "y", run);
  }
  const [left, right] = from.x < to.x ? [from, to] : [to, from];
  const lineY = left.y + Math.min(left.headerH, right.headerH) / 2;
  const x1 = from.x < to.x ? left.x + left.width : right.x;
  const x2 = from.x < to.x ? right.x - 4 : left.x + left.width + 4;
  return { points: [[x1, lineY], [x2, lineY]], label: [(x1 + x2) / 2, lineY - 16] };
}

/** Arrows between rows leave the bottom (or top) and run through the gap. */
function crossRowSkeleton(from: CardLayout, to: CardLayout, fromRow: number, toRow: number, route: RowRouteContext, bend: number): EdgeSkeleton {
  const downward = toRow > fromRow;
  const start: Point = [from.x + from.width / 2, downward ? from.y + from.height : from.y];
  const end: Point = [to.x + to.width / 2, downward ? to.y - 4 : to.y + to.height + 4];
  const run = staggeredRun(route.gapUse, downward ? fromRow : toRow, route.rowBottoms) + bend;
  if (Math.abs(start[0] - end[0]) < 1) return { points: [start, end], label: [(start[0] + end[0]) / 2, run - 13] };
  return runSkeleton(start, end, "y", run);
}

/** The row-aware route for arrows between cards still in their row slots. */
function rowEdgeSkeleton(edge: StewardDiagramEdge, from: CardLayout, to: CardLayout, route: RowRouteContext, bend: number): EdgeSkeleton {
  const fromRow = route.geometry.rowOf.get(edge.from) ?? 0;
  const toRow = route.geometry.rowOf.get(edge.to) ?? 0;
  return fromRow === toRow
    ? sameRowSkeleton(edge, from, to, route, bend)
    : crossRowSkeleton(from, to, fromRow, toRow, route, bend);
}

/** Arrows: row-aware routes while both cards sit in their rows; a dragged
 * card's arrows leave and enter through facing sides. */
function drawEdges(ctx: LayoutContext, rows: RowsLayout, geometry: RowGeometry) {
  const route: RowRouteContext = { geometry, rowBottoms: rows.rowBottoms, gapUse: new Map() };
  const connector = ctx.model.connector ?? "elbow";
  ctx.model.edges.forEach((edge, edgeIndex) => {
    const from = rows.cards.get(edge.from);
    const to = rows.cards.get(edge.to);
    if (!from || !to) return;
    const kind = edge.kind ?? "primary";
    const style = ctx.styles[kind];
    const bend = edge.bend ?? 0;
    const skeleton =
      from.card.position || to.card.position
        ? freeEdgeSkeleton(routeBox(from), routeBox(to), bend)
        : rowEdgeSkeleton(edge, from, to, route, bend);
    const drawn = drawEdgeRoute(skeleton, connector, routeBox(from), routeBox(to), bend);
    ctx.paths.push({ d: drawn.d, color: style.color, dash: style.dash, markerKind: kind, edgeIndex, handle: drawn.handle, ends: drawn.ends });
    if (edge.label) ctx.texts.push(edgeLabel(ctx, edge.label, kind, drawn.label, edgeIndex));
  });
}

/** An arrow's label rides at its middle, haloed so it reads over lines. */
function edgeLabel(ctx: LayoutContext, label: string, kind: StewardDiagramEdgeKind, at: Point, edgeIndex: number): StewardDiagramTextEl {
  return {
    x: at[0],
    y: at[1],
    block: block(label, 220, 11, 14, false),
    color: kind === "primary" ? ctx.palette.muted : ctx.styles[kind].color,
    anchor: "middle",
    italic: true,
    halo: ctx.palette.canvas,
    edgeIndex,
    fieldRef: { scope: "edge", index: edgeIndex, field: "label" },
  };
}

/** Legend and footnote under the cards; returns the bottom of the chart. */
function drawLegend(ctx: LayoutContext, bottom: number): number {
  const { model, palette, styles } = ctx;
  let footerLineY = bottom + 32;
  if (model.legend && model.legend.length > 0) {
    let legendX = MARGIN;
    ctx.texts.push({ x: legendX, y: footerLineY - 5, block: block("KEY", 60, 10.5, 13, true), color: palette.muted, letterSpacing: 0.6 });
    legendX += 44;
    for (const entry of model.legend) {
      const style = styles[entry.kind];
      ctx.paths.push({
        d: `M ${legendX} ${footerLineY + 3} L ${legendX + 34} ${footerLineY + 3}`,
        color: style.color,
        dash: style.dash,
        markerKind: entry.kind,
      });
      const label = block(entry.label, 400, 11.5, 14, false);
      ctx.texts.push({ x: legendX + 42, y: footerLineY - 5, block: label, color: palette.muted });
      legendX += 42 + textWidth(entry.label, 11.5, false) + 34;
    }
    footerLineY += 24;
  }
  if (model.footnote) {
    const footnote = block(model.footnote, ctx.width - 2 * MARGIN, 11.5, 15.5, false);
    ctx.texts.push({ x: MARGIN, y: footerLineY - 5, block: footnote, color: palette.muted, fieldRef: { scope: "chart", field: "footnote" } });
    footerLineY += blockHeight(footnote) + 4;
  }
  return footerLineY;
}

export function computeStewardDiagramLayout(
  model: StewardDiagramModel,
  dark: boolean,
  canvasWidth = stewardCanvasWidth(model),
): StewardDiagramLayout {
  const palette = stewardDiagramPalette(model.theme, dark);
  const ctx: LayoutContext = {
    model,
    dark,
    palette,
    styles: edgeStyles(palette),
    width: Math.max(320, canvasWidth),
    radius: model.corners === "square" ? SQUARE_RADIUS : CARD_RADIUS,
    rects: [],
    texts: [],
    paths: [],
  };
  const contentTop = layoutHeading(ctx);
  const geometry = rowGeometry(model);
  const rows = layoutRows(ctx, geometry, contentTop);
  for (const layout of rows.cards.values()) drawCard(ctx, layout);
  drawEdges(ctx, rows, geometry);
  const footerLineY = drawLegend(ctx, rows.bottom);
  return {
    width: ctx.width,
    height: Math.ceil(Math.max(footerLineY + 8, rows.bottom + 22)),
    dark,
    theme: model.theme,
    contentTop,
    rects: ctx.rects,
    paths: ctx.paths,
    texts: ctx.texts,
    cardBoxes: rows.cardBoxes,
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
  const spacing = el.letterSpacing ? ` letter-spacing="${el.letterSpacing}"` : "";
  const text = `<text fill="${el.color}" font-size="${el.block.size}"${weight}${style}${anchor}${spacing}>${spans}</text>`;
  if (!el.halo) return text;
  return `<g style="paint-order: stroke" stroke="${el.halo}" stroke-width="4" stroke-linejoin="round">${text}</g>`;
}

/** Arrowhead marker id. Themed charts get their own ids: marker ids are
 * document-global, and two charts in different themes share a page. */
export function stewardMarkerId(kind: StewardDiagramEdgeKind, dark: boolean, theme?: StewardDiagramThemeId) {
  const themed = theme && theme !== "aperture" ? `-${theme}` : "";
  return `aperture-sd-arrow-${kind}${themed}${dark ? "-dark" : ""}`;
}

export function stewardDiagramMarkerDefs(dark = false, theme?: StewardDiagramThemeId): string {
  const styles = edgeStyles(stewardDiagramPalette(theme, dark));
  const markers = (Object.keys(styles) as StewardDiagramEdgeKind[])
    .map(
      (kind) =>
        `<marker id="${stewardMarkerId(kind, dark, theme)}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1.2 L 9 5 L 1 8.8 z" fill="${styles[kind].color}" stroke="${styles[kind].color}" stroke-linejoin="round"/></marker>`,
    )
    .join("");
  const shadow = `<filter id="${stewardShadowId(dark)}" x="-5%" y="-5%" width="110%" height="120%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.6" flood-color="${dark ? "#000000" : "#0b2a38"}" flood-opacity="${dark ? "0.35" : "0.10"}"/></filter>`;
  return markers + shadow;
}

export function stewardShadowId(dark: boolean) {
  return `aperture-sd-shadow${dark ? "-dark" : ""}`;
}

function svgRectMarkup(el: StewardDiagramRectEl, dark: boolean): string {
  const stroke = el.stroke ? ` stroke="${el.stroke}"` : "";
  const shadow = el.shadow ? ` filter="url(#${stewardShadowId(dark)})"` : "";
  if (el.rx && el.corners && el.corners !== "all") {
    return `<path d="${stewardRectPath(el)}" fill="${el.fill}"${stroke}${shadow}/>`;
  }
  const rx = el.rx ? ` rx="${el.rx}"` : "";
  return `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}"${rx} fill="${el.fill}"${stroke}${shadow}/>`;
}

/** Lays the model out and renders the full SVG. Deterministic: same model,
 * same markup per theme. */
export function renderStewardDiagramSvg(model: StewardDiagramModel, dark: boolean, canvasWidth?: number): string {
  const layout = computeStewardDiagramLayout(model, dark, canvasWidth);
  const palette = stewardDiagramPalette(model.theme, dark);
  const paths = layout.paths
    .map(
      (el) =>
        `<path d="${el.d}" stroke="${el.color}" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"${
          el.dash ? ` stroke-dasharray="${el.dash}"` : ""
        } marker-end="url(#${stewardMarkerId(el.markerKind, dark, model.theme)})"/>`,
    )
    .join("");
  const rects = layout.rects.map((el) => svgRectMarkup(el, dark)).join("");
  const texts = layout.texts.map(svgTextMarkup).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
    `font-family='${DIAGRAM_FONT_FAMILY.replace(/'/g, "")}' role="img" aria-label="${escapeXml(model.title ?? "Structure diagram")}">` +
    `<rect width="${layout.width}" height="${layout.height}" fill="${palette.canvas}"/>` +
    `<defs>${stewardDiagramMarkerDefs(dark, model.theme)}</defs>${paths}${rects}${texts}</svg>`
  );
}

/* ------------------------------------------------------------------ */
/* Structured edit helpers shared by the inline canvas and the modal   */
/* ------------------------------------------------------------------ */

export function cloneStewardDiagram(model: StewardDiagramModel): StewardDiagramModel {
  return JSON.parse(JSON.stringify(model)) as StewardDiagramModel;
}

function findCard(model: StewardDiagramModel, cardId: string): StewardDiagramCard | undefined {
  for (const row of model.rows) {
    const card = row.find((item) => item.id === cardId);
    if (card) return card;
  }
  return undefined;
}

function cardFieldValue(card: StewardDiagramCard, field: "title" | "subtitle" | "note" | "footer"): string {
  return (field === "footer" ? card.footer?.text : card[field]) ?? "";
}

function cardTextValue(model: StewardDiagramModel, ref: Extract<StewardTextField, { cardId: string }>): string {
  const card = findCard(model, ref.cardId);
  if (!card) return "";
  return ref.scope === "bullet" ? card.bullets?.[ref.index] ?? "" : cardFieldValue(card, ref.field);
}

export function stewardFieldValue(model: StewardDiagramModel, ref: StewardTextField): string {
  if (ref.scope === "chart") return model[ref.field] ?? "";
  if (ref.scope === "edge") return model.edges[ref.index]?.label ?? "";
  return cardTextValue(model, ref);
}

function setBullet(card: StewardDiagramCard, index: number, text: string) {
  const bullets = [...(card.bullets ?? [])];
  if (text) bullets[index] = text;
  else bullets.splice(index, 1);
  card.bullets = bullets.length > 0 ? bullets : undefined;
}

/** A card's title can be rewritten but never emptied. */
function setCardField(card: StewardDiagramCard, field: "title" | "subtitle" | "note" | "footer", text: string) {
  if (field === "title") card.title = text || card.title;
  else if (field === "footer") card.footer = text ? { text, tone: card.footer?.tone ?? "neutral" } : undefined;
  else card[field] = text || undefined;
}

/** Sets one editable text field; an emptied value removes optional fields
 * (subtitle, note, footer, a bullet line, an arrow label) instead of
 * leaving a blank run. */
export function withStewardFieldValue(
  model: StewardDiagramModel,
  ref: StewardTextField,
  value: string,
): StewardDiagramModel {
  const next = cloneStewardDiagram(model);
  const text = value.trim();
  if (ref.scope === "chart") {
    next[ref.field] = text || undefined;
  } else if (ref.scope === "edge") {
    const edge = next.edges[ref.index];
    if (edge) edge.label = text || undefined;
  } else if (ref.scope === "bullet") {
    const card = findCard(next, ref.cardId);
    if (card) setBullet(card, ref.index, text);
  } else {
    const card = findCard(next, ref.cardId);
    if (card) setCardField(card, ref.field, text);
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
  const next = cloneStewardDiagram(model);
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
  const next = cloneStewardDiagram(model);
  next.rows = next.rows.map((row) => row.filter((card) => card.id !== cardId)).filter((row) => row.length > 0);
  next.edges = next.edges.filter((edge) => edge.from !== cardId && edge.to !== cardId);
  return next;
}

/** Renders steward-diagram JSON straight to a light-theme PNG data URL for
 * document surfaces (Drafts pages are always white). Truncated sources render
 * their salvageable portion — the transfer should carry whatever the reader
 * saw in chat. Returns null when nothing renders. */
export async function renderStewardDiagramPngDataUrl(source: string): Promise<string | null> {
  const model =
    parseStewardDiagram(source) ??
    parseStructuredSummaryDiagram(source) ??
    parseStewardDiagramTruncated(source);
  if (!model) return null;
  return rasterizeSvgToPngDataUrl(renderStewardDiagramSvg(model, false), stewardDiagramPalette(model.theme, false).canvas);
}
