/** Visual fallbacks for Mermaid (and similar) fences when mermaid.js cannot
 * draw. Chat must never sit on a code panel: these SVG-text diagrams keep the
 * data on screen in the shared diagram palette, then mermaid.js replaces
 * them when it succeeds. */

import { DIAGRAM_FONT_FAMILY, diagramPalette, type DiagramPalette } from "./diagramTheme";
import { diagramSvg, escapeXml, measureDiagramText, svgText, wrapDiagramText } from "./diagramText";
import { isMindmapSource, renderMindmapSvg } from "./diagramMindmap";
import { isMermaidTimelineSource, renderTimelineFallbackSvg } from "./mermaidTimeline";

export const FALLBACK_FONT_FAMILY = DIAGRAM_FONT_FAMILY;

const FLOW_HEADER = /^(?:graph|flowchart)\b(?:\s+(TB|TD|BT|RL|LR))?/i;
const SEQUENCE_HEADER = /^sequenceDiagram\b/i;
const PIE_HEADER = /^pie\b/i;
const EDGE_SPLIT = /(\s*(?:<-->|-->|---|-\.->|-\.-|==>|===|→|->)\s*(?:\|[^|]*\|\s*)?)/;

/** Always returns an SVG for non-empty diagram source. Timeline, flowchart,
 * sequence, and pie get structured drawings; everything else becomes labeled
 * cards. Never a `<pre>` listing. */
export function renderMermaidFallbackSvg(
  source: string,
  dark: boolean,
  fontFamily: string = FALLBACK_FONT_FAMILY,
): string | null {
  const trimmed = source.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return null;
  if (isMermaidTimelineSource(trimmed)) {
    return renderTimelineFallbackSvg(trimmed, dark, fontFamily) ?? renderCardFallbackSvg(trimmed, dark, fontFamily);
  }
  if (isMindmapSource(trimmed)) {
    return renderMindmapSvg(trimmed, dark, fontFamily) ?? renderCardFallbackSvg(trimmed, dark, fontFamily);
  }
  const header = firstKeywordLine(trimmed);
  if (FLOW_HEADER.test(header)) {
    return renderFlowchartFallbackSvg(trimmed, dark, fontFamily) ?? renderCardFallbackSvg(trimmed, dark, fontFamily);
  }
  if (SEQUENCE_HEADER.test(header)) {
    return renderSequenceFallbackSvg(trimmed, dark, fontFamily) ?? renderCardFallbackSvg(trimmed, dark, fontFamily);
  }
  if (PIE_HEADER.test(header)) {
    return renderPieFallbackSvg(trimmed, dark, fontFamily) ?? renderCardFallbackSvg(trimmed, dark, fontFamily);
  }
  return renderCardFallbackSvg(trimmed, dark, fontFamily);
}

function firstKeywordLine(source: string): string {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("%%") && !trimmed.startsWith("#") && trimmed !== "---") return trimmed;
  }
  return "";
}

function arrowMarker(id: string, color: string) {
  return `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1.2 L 9 5 L 1 8.8 z" fill="${color}" stroke="${color}" stroke-linejoin="round" /></marker>`;
}

function titleBlock(title: string, width: number, pad: number, palette: DiagramPalette) {
  if (!title) return { markup: "", height: 0 };
  const lines = wrapDiagramText(title, width - pad * 2, 17, 700);
  return {
    markup: svgText(lines, { x: width / 2, y: pad + 15, size: 17, lineHeight: 23, weight: 700, fill: palette.text, anchor: "middle" }),
    height: lines.length * 23 + 16,
  };
}

type FlowNode = { id: string; label: string; ink: boolean };

function renderFlowchartFallbackSvg(source: string, dark: boolean, fontFamily: string): string | null {
  const palette = diagramPalette(dark);
  const nodes = new Map<string, FlowNode>();
  const edges: { from: string; to: string; label: string }[] = [];
  const order: string[] = [];
  const direction = (FLOW_HEADER.exec(firstKeywordLine(source))?.[1] ?? "TD").toUpperCase();
  const horizontal = direction === "LR" || direction === "RL";
  const inkClasses = new Set<string>();

  for (const raw of source.split("\n")) {
    const classDef = /^\s*classDef\s+([\w-]+)\s+.*fill\s*:\s*(#[0-9a-f]{3,6})/i.exec(raw);
    if (classDef && isDarkHex(classDef[2] ?? "")) inkClasses.add(classDef[1] ?? "");
  }

  const remember = (id: string, label: string, className?: string) => {
    if (!nodes.has(id)) {
      order.push(id);
      nodes.set(id, { id, label: label.trim() || id, ink: false });
    }
    const node = nodes.get(id)!;
    if (label.trim() && label.trim() !== id && (node.label === id || !node.label)) node.label = label.trim();
    if (className && inkClasses.has(className)) node.ink = true;
  };

  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed.startsWith("#")) continue;
    if (FLOW_HEADER.test(trimmed) || /^(subgraph|end|style|classDef|click|linkStyle|direction)\b/i.test(trimmed)) {
      continue;
    }
    const classLine = /^class\s+([\w,\s-]+?)\s+([\w-]+)\s*;?$/.exec(trimmed);
    if (classLine) {
      if (inkClasses.has(classLine[2] ?? "")) {
        for (const id of (classLine[1] ?? "").split(",").map((part) => part.trim())) {
          const node = nodes.get(id);
          if (node) node.ink = true;
        }
      }
      continue;
    }
    const parts = trimmed.split(EDGE_SPLIT).filter((part) => part.length > 0);
    if (parts.length >= 3) {
      for (let index = 0; index + 2 < parts.length; index += 2) {
        const from = parseNodeToken(parts[index] ?? "");
        const edgeText = parts[index + 1] ?? "";
        const to = parseNodeToken(parts[index + 2] ?? "");
        if (!from || !to) continue;
        remember(from.id, from.label, from.className);
        remember(to.id, to.label, to.className);
        const label = cleanLabel(/\|([^|]*)\|/.exec(edgeText)?.[1]?.trim() ?? "");
        edges.push({ from: from.id, to: to.id, label });
      }
      continue;
    }
    const node = parseNodeToken(trimmed);
    if (node) remember(node.id, node.label, node.className);
  }

  if (!nodes.size) return null;

  // Rank = longest path from a root, so chains read in order.
  const rank = new Map<string, number>();
  for (const id of order) rank.set(id, 0);
  for (let pass = 0; pass < order.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const next = (rank.get(edge.from) ?? 0) + 1;
      if (next > (rank.get(edge.to) ?? 0) && next < order.length) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const levels = new Map<number, string[]>();
  for (const id of order) {
    const level = rank.get(id) ?? 0;
    levels.set(level, [...(levels.get(level) ?? []), id]);
  }
  const levelCount = Math.max(...levels.keys()) + 1;
  const maxBreadth = Math.max(...[...levels.values()].map((list) => list.length), 1);

  const boxWidth = 180;
  const textWidth = boxWidth - 24;
  const wrapped = new Map(order.map((id) => [id, wrapDiagramText(nodes.get(id)?.label ?? id, textWidth, 13.5, 500).slice(0, 4)]));
  const boxHeight = Math.max(48, ...[...wrapped.values()].map((lines) => 22 + lines.length * 18));
  const gapMain = 64;
  const gapCross = 24;
  const pad = 28;
  const contentWidth = horizontal
    ? levelCount * boxWidth + (levelCount - 1) * gapMain
    : maxBreadth * boxWidth + (maxBreadth - 1) * gapCross;
  const contentHeight = horizontal
    ? maxBreadth * boxHeight + (maxBreadth - 1) * gapCross
    : levelCount * boxHeight + (levelCount - 1) * gapMain;
  const width = Math.max(contentWidth + pad * 2, 320);
  const titleMarkup = titleBlock(diagramTitle(source), width, pad, palette);
  const top = pad + titleMarkup.height;
  const height = top + contentHeight + pad;

  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, ids] of levels) {
    const breadth = ids.length;
    ids.forEach((id, index) => {
      if (horizontal) {
        const span = breadth * boxHeight + (breadth - 1) * gapCross;
        const x = (width - contentWidth) / 2 + level * (boxWidth + gapMain);
        const y = top + (contentHeight - span) / 2 + index * (boxHeight + gapCross);
        positions.set(id, { x, y });
      } else {
        const span = breadth * boxWidth + (breadth - 1) * gapCross;
        const x = (width - span) / 2 + index * (boxWidth + gapCross);
        const y = top + level * (boxHeight + gapMain);
        positions.set(id, { x, y });
      }
    });
  }

  const parts: string[] = [titleMarkup.markup];
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    let d: string;
    let labelX: number;
    let labelY: number;
    if (horizontal) {
      const x1 = from.x + boxWidth;
      const y1 = from.y + boxHeight / 2;
      const x2 = to.x - 2;
      const y2 = to.y + boxHeight / 2;
      const mid = (x1 + x2) / 2;
      d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
      labelX = mid;
      labelY = (y1 + y2) / 2 - 7;
    } else {
      const x1 = from.x + boxWidth / 2;
      const y1 = from.y + boxHeight;
      const x2 = to.x + boxWidth / 2;
      const y2 = to.y - 2;
      const mid = (y1 + y2) / 2;
      d = `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
      labelX = (x1 + x2) / 2;
      labelY = mid + 4;
    }
    parts.push(
      `<path d="${d}" fill="none" stroke="${palette.edge}" stroke-width="1.7" stroke-linecap="round" marker-end="url(#aperture-fallback-arrow)" />`,
    );
    if (edge.label) {
      const labelWidth = measureDiagramText(edge.label, 12, 500) + 12;
      parts.push(
        `<rect x="${labelX - labelWidth / 2}" y="${labelY - 13}" width="${labelWidth}" height="19" rx="5" fill="${palette.canvas}" />` +
          svgText([edge.label], { x: labelX, y: labelY, size: 12, weight: 500, fill: palette.muted, anchor: "middle" }),
      );
    }
  }
  for (const id of order) {
    const pos = positions.get(id);
    const node = nodes.get(id);
    if (!pos || !node) continue;
    const lines = wrapped.get(id) ?? [id];
    const fill = node.ink ? palette.ink : palette.node.fill;
    const stroke = node.ink ? palette.inkBorder : palette.node.border;
    const text = node.ink ? palette.inkText : palette.node.text;
    const textTop = pos.y + (boxHeight - lines.length * 18) / 2 + 13;
    parts.push(
      `<rect x="${pos.x}" y="${pos.y}" width="${boxWidth}" height="${boxHeight}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.3" />` +
        svgText(lines, { x: pos.x + boxWidth / 2, y: textTop, size: 13.5, lineHeight: 18, weight: 500, fill: text, anchor: "middle" }),
    );
  }

  return diagramSvg(
    width,
    height,
    palette.canvas,
    fontFamily,
    diagramTitle(source) || "Flowchart diagram",
    `<defs>${arrowMarker("aperture-fallback-arrow", palette.edge)}</defs>${parts.join("")}`,
  );
}

function isDarkHex(hex: string) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.replace(/./g, (char) => char + char) : value;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
  return (0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)) / 255 < 0.42;
}

function parseNodeToken(token: string): { id: string; label: string; className?: string } | null {
  let trimmed = token.trim().replace(/;$/, "");
  const classSuffix = /:::([\w-]+)$/.exec(trimmed);
  if (classSuffix) trimmed = trimmed.slice(0, -classSuffix[0].length);
  if (!trimmed) return null;
  const shaped =
    /^([A-Za-z_][\w-]*)\s*(?:\[\[([\s\S]*)\]\]|\(\(([\s\S]*)\)\)|\[\(([\s\S]*)\)\]|\(\[([\s\S]*)\]\)|\{\{([\s\S]*)\}\}|\[([\s\S]*)\]|\(([\s\S]*)\)|\{([\s\S]*)\}|>([\s\S]*)\])?$/.exec(
      trimmed,
    );
  if (shaped) {
    const id = shaped[1]!;
    const raw = shaped.slice(2).find((value) => value !== undefined) ?? id;
    return { id, label: cleanLabel(raw) || id, className: classSuffix?.[1] };
  }
  const loose = /^([A-Za-z_][\w-]*)/.exec(trimmed);
  if (loose && /^[\w\s'.,&-]+$/.test(trimmed)) {
    // A spaced name with no shape ("User Login") is one node, labeled as written.
    return { id: trimmed.replace(/\s+/g, "_"), label: trimmed, className: classSuffix?.[1] };
  }
  return loose ? { id: loose[1]!, label: loose[1]!, className: classSuffix?.[1] } : null;
}

function renderSequenceFallbackSvg(source: string, dark: boolean, fontFamily: string): string | null {
  const palette = diagramPalette(dark);
  const participants: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const messages: { from: string; to: string; label: string; dashed: boolean }[] = [];

  const remember = (id: string, label?: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      participants.push({ id, label: label?.trim() || id });
    } else if (label?.trim()) {
      const row = participants.find((item) => item.id === id);
      if (row) row.label = label.trim();
    }
  };

  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || SEQUENCE_HEADER.test(trimmed) || trimmed.startsWith("%%")) continue;
    const participant = /^(?:participant|actor)\s+(\w+)(?:\s+as\s+(.+))?$/i.exec(trimmed);
    if (participant) {
      remember(participant[1]!, participant[2]?.replace(/^"|"$/g, ""));
      continue;
    }
    const message = /^(\w+)\s*(-{1,2}>{1,2}|-->>|->>|--x|-x|-\))\s*[+-]?(\w+)\s*:\s*(.*)$/.exec(trimmed);
    if (message) {
      remember(message[1]!);
      remember(message[3]!);
      messages.push({ from: message[1]!, to: message[3]!, label: message[4]!.trim(), dashed: message[2]!.startsWith("--") });
    }
  }
  if (!participants.length) return null;

  const colWidth = 170;
  const pad = 28;
  const width = Math.max(pad * 2 + participants.length * colWidth, 360);
  const titleMarkup = titleBlock(diagramTitle(source), width, pad, palette);
  const startY = pad + titleMarkup.height + 30;
  const rowHeight = 46;
  const height = startY + 30 + Math.max(messages.length, 1) * rowHeight;
  const parts: string[] = [titleMarkup.markup];
  const xFor = (id: string) => pad + colWidth / 2 + Math.max(participants.findIndex((item) => item.id === id), 0) * colWidth;
  participants.forEach((participant) => {
    const x = xFor(participant.id);
    parts.push(`<line x1="${x}" y1="${startY + 10}" x2="${x}" y2="${height - 18}" stroke="${palette.axis}" stroke-width="1.5" stroke-dasharray="4 4" />`);
    const label = wrapDiagramText(participant.label, colWidth - 34, 13, 600).slice(0, 2);
    const boxH = 16 + label.length * 17;
    parts.push(
      `<rect x="${x - (colWidth - 24) / 2}" y="${startY - boxH + 6}" width="${colWidth - 24}" height="${boxH}" rx="9" fill="${palette.ink}" stroke="${palette.inkBorder}" />` +
        svgText(label, { x, y: startY - boxH + 6 + 21, size: 13, lineHeight: 17, weight: 600, fill: palette.inkText, anchor: "middle" }),
    );
  });
  messages.forEach((message, index) => {
    const y = startY + 44 + index * rowHeight;
    const x1 = xFor(message.from);
    const x2 = xFor(message.to);
    const self = x1 === x2;
    const d = self ? `M${x1},${y - 8} C${x1 + 50},${y - 8} ${x1 + 50},${y + 10} ${x1 + 4},${y + 10}` : `M${x1},${y} L${x2 + (x2 > x1 ? -3 : 3)},${y}`;
    parts.push(
      `<path d="${d}" fill="none" stroke="${palette.edgeStrong}" stroke-width="1.6"${message.dashed ? ' stroke-dasharray="5 4"' : ""} marker-end="url(#aperture-fallback-arrow)" />`,
    );
    parts.push(
      svgText([message.label], { x: self ? x1 + 58 : (x1 + x2) / 2, y: y - 9, size: 13, fill: palette.text, anchor: self ? "start" : "middle" }),
    );
  });
  return diagramSvg(
    width,
    height,
    palette.canvas,
    fontFamily,
    diagramTitle(source) || "Sequence diagram",
    `<defs>${arrowMarker("aperture-fallback-arrow", palette.edgeStrong)}</defs>${parts.join("")}`,
  );
}

function renderPieFallbackSvg(source: string, dark: boolean, fontFamily: string): string | null {
  const palette = diagramPalette(dark);
  const slices: { label: string; value: number }[] = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || PIE_HEADER.test(trimmed) || /^title\s+/i.test(trimmed) || trimmed.startsWith("%%")) continue;
    const match = /^"?([^":]+)"?\s*:\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*%?\s*$/.exec(trimmed);
    if (match) slices.push({ label: match[1]!.trim(), value: Number(match[2]!.replace(/,/g, "")) });
  }
  if (!slices.length) return null;

  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const width = 720;
  const pad = 28;
  const titleMarkup = titleBlock(diagramTitle(source), width, pad, palette);
  const rowHeight = 38;
  const top = pad + titleMarkup.height;
  const height = top + slices.length * rowHeight + pad - 8;
  const labelWidth = Math.min(260, Math.max(...slices.map((slice) => measureDiagramText(slice.label, 13.5, 500))) + 12);
  const barX = pad + labelWidth;
  const barWidth = width - barX - pad - 70;
  const parts: string[] = [titleMarkup.markup];
  slices.forEach((slice, index) => {
    const y = top + index * rowHeight;
    const color = palette.series[index % palette.series.length]!;
    const share = slice.value / total;
    parts.push(
      svgText([slice.label], { x: pad, y: y + 18, size: 13.5, weight: 500, fill: palette.text }) +
        `<rect x="${barX}" y="${y + 6}" width="${barWidth}" height="16" rx="8" fill="${palette.node.fill}" />` +
        `<rect x="${barX}" y="${y + 6}" width="${Math.max(8, share * barWidth)}" height="16" rx="8" fill="${color}" />` +
        svgText([`${Math.round(share * 1000) / 10}%`], { x: width - pad, y: y + 18, size: 13, weight: 600, fill: palette.text, anchor: "end" }),
    );
  });
  return diagramSvg(width, height, palette.canvas, fontFamily, diagramTitle(source) || "Pie diagram", parts.join(""));
}

function renderCardFallbackSvg(source: string, dark: boolean, fontFamily: string): string {
  const palette = diagramPalette(dark);
  const type = diagramTypeFromSource(source);
  const title = diagramTitle(source);
  const rows = fallbackRows(source);
  const width = 720;
  const pad = 28;
  const parts: string[] = [];
  let y = pad;
  parts.push(
    svgText([`${type} diagram`.toUpperCase()], { x: pad, y: y + 10, size: 11.5, weight: 700, fill: palette.tones.accent.line, extra: 'letter-spacing="0.06em"' }),
  );
  y += 24;
  if (title) {
    const lines = wrapDiagramText(title, width - pad * 2, 17, 700);
    parts.push(svgText(lines, { x: pad, y: y + 14, size: 17, lineHeight: 23, weight: 700, fill: palette.text }));
    y += lines.length * 23 + 12;
  }
  for (const row of rows) {
    const lines = wrapDiagramText(row, width - pad * 2 - 28, 13.5);
    const boxHeight = 18 + lines.length * 19;
    parts.push(
      `<rect x="${pad}" y="${y}" width="${width - pad * 2}" height="${boxHeight}" rx="9" fill="${palette.node.fill}" stroke="${palette.node.border}" />` +
        svgText(lines, { x: pad + 14, y: y + 23, size: 13.5, lineHeight: 19, fill: palette.node.text }),
    );
    y += boxHeight + 8;
  }
  if (!rows.length) {
    parts.push(
      svgText([`This ${type} diagram has no readable statements yet.`], { x: pad, y: y + 14, size: 13, fill: palette.muted }),
    );
    y += 28;
  }
  return diagramSvg(width, Math.max(y + pad - 8, 80), palette.canvas, fontFamily, title || `${type} diagram`, parts.join(""));
}

function fallbackRows(source: string): string[] {
  const rows: string[] = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    if (/^(title|accTitle|accDescr)\b/i.test(trimmed)) continue;
    if (/^(?:@enduml|end|}\s*;?|{)$/i.test(trimmed)) continue;
    if (isDiagramHeaderLine(trimmed)) continue;
    const cleaned = trimmed
      .replace(/^(participant|actor|section)\s+/i, "")
      .replace(/\s*(?:-->|->|→)\s*/g, " → ")
      .replace(/\[(?:label\s*=\s*)?"?([^\]"]*)"?\]/g, " ($1)")
      .replace(/;$/, "");
    if (cleaned) rows.push(cleaned);
  }
  return rows.slice(0, 40);
}

function isDiagramHeaderLine(line: string): boolean {
  return /^(graph\s+(?:TB|TD|BT|RL|LR)|flowchart\s+(?:TB|TD|BT|RL|LR)|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|zenuml|sankey(?:-beta)?|xychart(?:-beta)?|block-beta|packet-beta|kanban|architecture-beta|radar(?:-beta)?|C4Context|C4Container|C4Component|C4Dynamic|@startuml|digraph|graph|strict)\b/i.test(
    line,
  );
}

function diagramTitle(source: string): string {
  const frontTitle = /^\s*---\n[\s\S]*?^title\s*:\s*(.+)$[\s\S]*?^---/m.exec(source);
  if (frontTitle) return frontTitle[1]!.trim().replace(/^["']|["']$/g, "");
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    const pieTitle = /^pie\s+showData\s+title\s+(.+)$/i.exec(trimmed) ?? /^pie\s+title\s+(.+)$/i.exec(trimmed);
    if (pieTitle) return pieTitle[1]!.trim().replace(/^["']|["']$/g, "");
    const titled = /^title\s+(?:title\s+)?(.+)$/i.exec(trimmed);
    if (titled) return titled[1]!.trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

export function diagramTypeFromSource(source: string): string {
  const first = firstKeywordLine(source).split(/\s+/)[0] ?? "";
  if (!first) return "diagram";
  return first
    .replace(/Diagram(-v\d+)?$/i, "")
    .replace(/-(beta|v\d+)$/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function cleanLabel(value: string): string {
  return value
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/`/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export { escapeXml };
