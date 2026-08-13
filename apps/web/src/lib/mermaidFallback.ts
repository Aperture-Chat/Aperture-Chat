/** Visual fallbacks for Mermaid (and similar) fences when mermaid.js cannot
 * draw. Chat must never sit on a code panel: these SVG-text diagrams keep the
 * data on screen, then mermaid.js may replace them if it succeeds. */

import {
  isMermaidTimelineSource,
  renderTimelineFallbackSvg,
} from "./mermaidTimeline";

export const FALLBACK_FONT_FAMILY =
  '"Plus Jakarta Sans", "SF Pro Display", "Segoe UI", ui-sans-serif, system-ui, sans-serif';

type Theme = {
  surface: string;
  text: string;
  muted: string;
  line: string;
  boxFill: string;
  boxStroke: string;
  accent: string;
};

function theme(dark: boolean): Theme {
  return dark
    ? {
        surface: "#0d1c27",
        text: "#e9f3f7",
        muted: "#9fb1bd",
        line: "#2c485a",
        boxFill: "#102330",
        boxStroke: "#2c485a",
        accent: "#3987e5",
      }
    : {
        surface: "#ffffff",
        text: "#0c1a26",
        muted: "#5c6b7a",
        line: "#cfdae2",
        boxFill: "#f5f9fa",
        boxStroke: "#cfdae2",
        accent: "#2a78d6",
      };
}

const FLOW_HEADER = /^(?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR)\b/i;
const SEQUENCE_HEADER = /^sequenceDiagram\b/i;
const PIE_HEADER = /^pie\b/i;
const EDGE_SPLIT = /(\s*(?:-->|---|-\.->|==>)\s*(?:\|[^|]*\|\s*)?)/;

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
  if (FLOW_HEADER.test(firstKeywordLine(trimmed))) {
    return renderFlowchartFallbackSvg(trimmed, dark, fontFamily) ?? renderCardFallbackSvg(trimmed, dark, fontFamily);
  }
  if (SEQUENCE_HEADER.test(firstKeywordLine(trimmed))) {
    return renderSequenceFallbackSvg(trimmed, dark, fontFamily) ?? renderCardFallbackSvg(trimmed, dark, fontFamily);
  }
  if (PIE_HEADER.test(firstKeywordLine(trimmed))) {
    return renderPieFallbackSvg(trimmed, dark, fontFamily) ?? renderCardFallbackSvg(trimmed, dark, fontFamily);
  }
  return renderCardFallbackSvg(trimmed, dark, fontFamily);
}

function firstKeywordLine(source: string): string {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("%%") && !trimmed.startsWith("#")) return trimmed;
  }
  return "";
}

function renderFlowchartFallbackSvg(source: string, dark: boolean, fontFamily: string): string | null {
  const nodes = new Map<string, string>();
  const edges: { from: string; to: string; label: string }[] = [];
  const order: string[] = [];

  const remember = (id: string, label: string) => {
    if (!nodes.has(id)) order.push(id);
    const next = label.trim() || id;
    const previous = nodes.get(id);
    if (!previous || previous === id) nodes.set(id, next);
  };

  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed.startsWith("#")) continue;
    if (FLOW_HEADER.test(trimmed) || /^(subgraph|end|style|classDef|click|linkStyle|direction)\b/i.test(trimmed)) {
      continue;
    }
    const parts = trimmed.split(EDGE_SPLIT).filter((part) => part.length > 0);
    if (parts.length >= 3) {
      for (let index = 0; index + 2 < parts.length; index += 2) {
        const from = parseNodeToken(parts[index] ?? "");
        const edgeText = parts[index + 1] ?? "";
        const to = parseNodeToken(parts[index + 2] ?? "");
        if (!from || !to) continue;
        remember(from.id, from.label);
        remember(to.id, to.label);
        const label = /\|([^|]*)\|/.exec(edgeText)?.[1]?.trim() ?? "";
        edges.push({ from: from.id, to: to.id, label });
      }
      continue;
    }
    const node = parseNodeToken(trimmed);
    if (node) remember(node.id, node.label);
  }

  if (!nodes.size) return null;

  const colors = theme(dark);
  const incoming = new Map<string, number>();
  for (const id of order) incoming.set(id, 0);
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const rank = new Map<string, number>();
  const queue = order.filter((id) => (incoming.get(id) ?? 0) === 0);
  if (!queue.length) queue.push(...order);
  let guard = 0;
  while (queue.length && guard++ < order.length * 4) {
    const id = queue.shift();
    if (!id || rank.has(id)) continue;
    const fromRanks = edges.filter((edge) => edge.to === id && rank.has(edge.from)).map((edge) => rank.get(edge.from) ?? 0);
    rank.set(id, fromRanks.length ? Math.max(...fromRanks) + 1 : 0);
    for (const edge of edges) {
      if (edge.from === id && !rank.has(edge.to)) queue.push(edge.to);
    }
  }
  for (const id of order) if (!rank.has(id)) rank.set(id, 0);

  const columns = new Map<number, string[]>();
  for (const id of order) {
    const column = rank.get(id) ?? 0;
    const list = columns.get(column) ?? [];
    list.push(id);
    columns.set(column, list);
  }
  const columnCount = Math.max(...columns.keys()) + 1;
  const boxWidth = 168;
  const boxHeight = 52;
  const gapX = 56;
  const gapY = 22;
  const pad = 28;
  const title = diagramTitle(source);
  const titleHeight = title ? 36 : 0;
  const maxRows = Math.max(...[...columns.values()].map((list) => list.length), 1);
  const width = pad * 2 + columnCount * boxWidth + Math.max(0, columnCount - 1) * gapX;
  const height = pad * 2 + titleHeight + maxRows * boxHeight + Math.max(0, maxRows - 1) * gapY;
  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, ids] of columns) {
    ids.forEach((id, row) => {
      positions.set(id, {
        x: pad + column * (boxWidth + gapX),
        y: pad + titleHeight + row * (boxHeight + gapY),
      });
    });
  }

  const parts: string[] = [];
  if (title) {
    parts.push(
      `<text x="${width / 2}" y="${pad + 8}" text-anchor="middle" font-size="16" font-weight="700" fill="${colors.text}">${escapeXml(title)}</text>`,
    );
  }
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + boxWidth;
    const y1 = from.y + boxHeight / 2;
    const x2 = to.x;
    const y2 = to.y + boxHeight / 2;
    parts.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colors.accent}" stroke-width="2" marker-end="url(#aperture-arrow)" />`,
    );
    if (edge.label) {
      parts.push(
        `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-size="11" fill="${colors.muted}">${escapeXml(edge.label)}</text>`,
      );
    }
  }
  for (const id of order) {
    const pos = positions.get(id);
    if (!pos) continue;
    const label = wrapLabel(nodes.get(id) ?? id, 22);
    parts.push(
      `<rect x="${pos.x}" y="${pos.y}" width="${boxWidth}" height="${boxHeight}" rx="8" fill="${colors.boxFill}" stroke="${colors.boxStroke}" />`,
    );
    label.forEach((line, lineIndex) => {
      parts.push(
        `<text x="${pos.x + boxWidth / 2}" y="${pos.y + 22 + lineIndex * 16}" text-anchor="middle" font-size="13" fill="${colors.text}">${escapeXml(line)}</text>`,
      );
    });
  }

  return wrapSvg(width, height, colors, fontFamily, title || "Flowchart diagram", [
    `<defs><marker id="aperture-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${colors.accent}" /></marker></defs>`,
    ...parts,
  ]);
}

function parseNodeToken(token: string): { id: string; label: string } | null {
  const trimmed = token.trim().replace(/;$/, "");
  if (!trimmed) return null;
  const shaped =
    /^([A-Za-z][\w-]*)\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\}|>\s*([^\]]*)\]|\[\[([^\]]*)\]\]|\(\(([^)]*)\)\))?$/.exec(
      trimmed,
    );
  if (shaped) {
    const id = shaped[1];
    const raw = shaped[2] ?? shaped[3] ?? shaped[4] ?? shaped[5] ?? shaped[6] ?? shaped[7] ?? id;
    return { id, label: cleanLabel(raw) || id };
  }
  const loose = /^([A-Za-z][\w-]*)/.exec(trimmed);
  return loose ? { id: loose[1], label: loose[1] } : null;
}

function renderSequenceFallbackSvg(source: string, dark: boolean, fontFamily: string): string | null {
  const participants: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const messages: { from: string; to: string; label: string }[] = [];

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
      remember(participant[1], participant[2]);
      continue;
    }
    const message = /^(\w+)\s*(?:-{1,2}>{1,2}|-->>|->>|--x)\s*(\w+)\s*:\s*(.*)$/.exec(trimmed);
    if (message) {
      remember(message[1]);
      remember(message[2]);
      messages.push({ from: message[1], to: message[2], label: message[3].trim() });
    }
  }
  if (!participants.length) return null;

  const colors = theme(dark);
  const title = diagramTitle(source);
  const colWidth = 160;
  const pad = 28;
  const titleHeight = title ? 32 : 0;
  const width = Math.max(pad * 2 + participants.length * colWidth, 360);
  const startY = pad + titleHeight + 28;
  const rowHeight = 44;
  const height = startY + 24 + Math.max(messages.length, 1) * rowHeight;
  const parts: string[] = [];
  if (title) {
    parts.push(
      `<text x="${width / 2}" y="${pad + 8}" text-anchor="middle" font-size="16" font-weight="700" fill="${colors.text}">${escapeXml(title)}</text>`,
    );
  }
  participants.forEach((participant, index) => {
    const x = pad + colWidth / 2 + index * colWidth;
    parts.push(`<rect x="${x - 54}" y="${startY - 22}" width="108" height="28" rx="6" fill="${colors.boxFill}" stroke="${colors.boxStroke}" />`);
    parts.push(
      `<text x="${x}" y="${startY - 3}" text-anchor="middle" font-size="12" font-weight="700" fill="${colors.text}">${escapeXml(participant.label)}</text>`,
    );
    parts.push(`<line x1="${x}" y1="${startY + 8}" x2="${x}" y2="${height - 16}" stroke="${colors.line}" stroke-width="2" />`);
  });
  const xFor = (id: string) => {
    const index = participants.findIndex((item) => item.id === id);
    return pad + colWidth / 2 + Math.max(index, 0) * colWidth;
  };
  messages.forEach((message, index) => {
    const y = startY + 36 + index * rowHeight;
    const x1 = xFor(message.from);
    const x2 = xFor(message.to);
    parts.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${colors.accent}" stroke-width="2" marker-end="url(#aperture-arrow)" />`);
    parts.push(
      `<text x="${(x1 + x2) / 2}" y="${y - 8}" text-anchor="middle" font-size="12" fill="${colors.text}">${escapeXml(message.label)}</text>`,
    );
  });
  return wrapSvg(width, height, colors, fontFamily, title || "Sequence diagram", [
    `<defs><marker id="aperture-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${colors.accent}" /></marker></defs>`,
    ...parts,
  ]);
}

function renderPieFallbackSvg(source: string, dark: boolean, fontFamily: string): string | null {
  const slices: { label: string; value: number }[] = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || PIE_HEADER.test(trimmed) || /^title\s+/i.test(trimmed) || trimmed.startsWith("%%")) continue;
    const match = /^"?([^":]+)"?\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(trimmed);
    if (match) slices.push({ label: match[1].trim(), value: Number(match[2]) });
  }
  if (!slices.length) return null;

  const colors = theme(dark);
  const title = diagramTitle(source);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const width = 720;
  const pad = 28;
  const titleHeight = title ? 32 : 0;
  const rowHeight = 36;
  const height = pad * 2 + titleHeight + slices.length * rowHeight;
  const barX = 220;
  const barWidth = width - barX - pad;
  const parts: string[] = [];
  if (title) {
    parts.push(
      `<text x="${width / 2}" y="${pad + 8}" text-anchor="middle" font-size="16" font-weight="700" fill="${colors.text}">${escapeXml(title)}</text>`,
    );
  }
  slices.forEach((slice, index) => {
    const y = pad + titleHeight + index * rowHeight;
    const widthForValue = Math.max(8, (slice.value / total) * barWidth);
    parts.push(
      `<text x="${pad}" y="${y + 16}" font-size="13" fill="${colors.text}">${escapeXml(slice.label)}</text>`,
    );
    parts.push(
      `<rect x="${barX}" y="${y + 2}" width="${barWidth}" height="18" rx="4" fill="${colors.boxFill}" stroke="${colors.boxStroke}" />`,
    );
    parts.push(`<rect x="${barX}" y="${y + 2}" width="${widthForValue}" height="18" rx="4" fill="${colors.accent}" />`);
    parts.push(
      `<text x="${barX + barWidth - 8}" y="${y + 16}" text-anchor="end" font-size="12" fill="${colors.text}">${escapeXml(String(slice.value))}</text>`,
    );
  });
  return wrapSvg(width, height, colors, fontFamily, title || "Pie diagram", parts);
}

function renderCardFallbackSvg(source: string, dark: boolean, fontFamily: string): string {
  const colors = theme(dark);
  const type = diagramTypeFromSource(source);
  const title = diagramTitle(source);
  const rows = fallbackRows(source);
  const width = 720;
  const pad = 28;
  const parts: string[] = [];
  let y = pad;
  parts.push(
    `<text x="${pad}" y="${y}" font-size="12" font-weight="700" fill="${colors.accent}">${escapeXml(type)} diagram</text>`,
  );
  y += 22;
  if (title) {
    parts.push(
      `<text x="${pad}" y="${y}" font-size="16" font-weight="700" fill="${colors.text}">${escapeXml(title)}</text>`,
    );
    y += 26;
  }
  for (const row of rows) {
    const lines = wrapLabel(row, 86);
    const boxHeight = 16 + lines.length * 18;
    parts.push(
      `<rect x="${pad}" y="${y}" width="${width - pad * 2}" height="${boxHeight}" rx="6" fill="${colors.boxFill}" stroke="${colors.boxStroke}" />`,
    );
    lines.forEach((line, lineIndex) => {
      parts.push(
        `<text x="${pad + 12}" y="${y + 20 + lineIndex * 18}" font-size="13" fill="${colors.text}">${escapeXml(line)}</text>`,
      );
    });
    y += boxHeight + 10;
  }
  if (!rows.length) {
    parts.push(
      `<text x="${pad}" y="${y + 8}" font-size="13" fill="${colors.muted}">This ${escapeXml(type)} diagram has no readable statements yet.</text>`,
    );
    y += 28;
  }
  return wrapSvg(width, Math.max(y + pad, 80), colors, fontFamily, title || `${type} diagram`, parts);
}

function fallbackRows(source: string): string[] {
  const rows: string[] = [];
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed.startsWith("#")) continue;
    if (/^(title|accTitle|accDescr)\b/i.test(trimmed)) continue;
    if (isDiagramHeaderLine(trimmed)) continue;
    const cleaned = trimmed.replace(/^(participant|actor|section)\s+/i, "").replace(/\s*-->\s*/g, " → ");
    if (cleaned) rows.push(cleaned);
  }
  return rows.slice(0, 40);
}

function isDiagramHeaderLine(line: string): boolean {
  return /^(graph\s+(?:TB|TD|BT|RL|LR)|flowchart\s+(?:TB|TD|BT|RL|LR)|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|zenuml|sankey(?:-beta)?|xychart-beta|block-beta|packet-beta|kanban|architecture-beta|radar(?:-beta)?|C4Context|C4Container|C4Component|C4Dynamic|@startuml|digraph|graph)\b/i.test(
    line,
  );
}

function diagramTitle(source: string): string {
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    const pieTitle = /^pie\s+showData\s+title\s+(.+)$/i.exec(trimmed) ?? /^pie\s+title\s+(.+)$/i.exec(trimmed);
    if (pieTitle) return pieTitle[1].trim().replace(/^["']|["']$/g, "");
    const titled = /^title\s+(?:title\s+)?(.+)$/i.exec(trimmed);
    if (titled) return titled[1].trim().replace(/^["']|["']$/g, "");
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

function wrapSvg(width: number, height: number, colors: Theme, fontFamily: string, label: string, parts: string[]): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeXml(label)}">` +
    `<rect width="${width}" height="${height}" fill="${colors.surface}" />` +
    `<g font-family="${escapeXml(fontFamily)}">${parts.join("")}</g>` +
    `</svg>`
  );
}

function cleanLabel(value: string): string {
  return value.replace(/^["'`]+|["'`]+$/g, "").replace(/`/g, "").trim();
}

function wrapLabel(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text];
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
