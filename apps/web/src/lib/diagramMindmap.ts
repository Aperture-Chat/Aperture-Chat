/** Aperture's mind map renderer.
 *
 * Mermaid's mindmap parser reads "(…)" anywhere in a line as a node shape, so
 * "Guilds (Esnaf)" loses "Guilds", and its SVG-text labels drift off their
 * shapes. Models write mind maps as plain indented outlines, so this module
 * reads them the way the writer meant and draws a tidy left-to-right tree in
 * the shared palette: the root as a brand-ink pill, each first-level branch
 * in its own tone, deeper ideas as outlined pills joined by soft curves.
 */

import { diagramPalette, type DiagramToneColors } from "./diagramTheme";
import { diagramSvg, measureDiagramText, svgText, wrapDiagramText } from "./diagramText";

const MINDMAP_HEADER = /^\s*mindmap\b/i;

export type MindmapNode = { text: string; children: MindmapNode[] };

export function isMindmapSource(source: string): boolean {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%%")) continue;
    return MINDMAP_HEADER.test(trimmed);
  }
  return false;
}

/** Node text from one outline line. Shape syntax only counts when it follows
 * a bare id (`root((Topic))`, `a[Idea]`); words before a parenthesis are
 * part of the text. */
export function mindmapNodeText(raw: string): string {
  let line = raw.trim().replace(/:::[\w-]+\s*$/, "").trim();
  const shaped = /^([\w-]*)(\(\(\(|\(\(|\)\)|\(\[|\[\[|\{\{|\[|\(|\)|\{)([\s\S]*?)(\)\)\)|\)\)|\(\(|\]\)|\]\]|\}\}|\]|\)|\(|\})$/.exec(line);
  if (shaped) line = shaped[3] ?? line;
  return line
    .replace(/^"`?|`?"$/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMindmap(source: string): MindmapNode | null {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => MINDMAP_HEADER.test(line));
  if (start < 0) return null;
  const stack: Array<{ indent: number; node: MindmapNode }> = [];
  let root: MindmapNode | null = null;
  for (const raw of lines.slice(start + 1)) {
    if (!raw.trim() || raw.trim().startsWith("%%") || /^\s*::icon\(/.test(raw)) continue;
    const indent = raw.replace(/\t/g, "    ").search(/\S/);
    const text = mindmapNodeText(raw);
    if (!text) continue;
    const node: MindmapNode = { text, children: [] };
    if (!root) {
      root = node;
      stack.push({ indent, node });
      continue;
    }
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    // Anything not indented past the root still belongs under it.
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ indent, node });
  }
  return root;
}

type Placed = {
  node: MindmapNode;
  depth: number;
  branch: number;
  lines: string[];
  width: number;
  height: number;
  x: number;
  y: number;
};

export function renderMindmapSvg(source: string, dark: boolean, fontFamily: string): string | null {
  const root = parseMindmap(source);
  if (!root) return null;
  const palette = diagramPalette(dark);
  const branchTones: DiagramToneColors[] = [
    palette.tones.accent,
    palette.tones.info,
    palette.tones.positive,
    palette.tones.warning,
    palette.tones.violet,
    palette.tones.danger,
  ];
  const style = (depth: number) =>
    depth === 0
      ? { size: 15, weight: 700, padX: 18, padY: 11, lineHeight: 19, maxWidth: 190 }
      : depth === 1
        ? { size: 13.5, weight: 600, padX: 14, padY: 8, lineHeight: 18, maxWidth: 190 }
        : { size: 13, weight: 400, padX: 12, padY: 7, lineHeight: 17, maxWidth: 210 };

  const placed: Placed[] = [];
  const columnWidths: number[] = [];
  const measure = (node: MindmapNode, depth: number, branch: number): Placed => {
    const s = style(depth);
    const lines = wrapDiagramText(node.text, s.maxWidth, s.size, s.weight).slice(0, 4);
    const width = Math.max(...lines.map((line) => measureDiagramText(line, s.size, s.weight))) + s.padX * 2;
    const height = lines.length * s.lineHeight + s.padY * 2;
    columnWidths[depth] = Math.max(columnWidths[depth] ?? 0, width);
    const item: Placed = { node, depth, branch, lines, width, height, x: 0, y: 0 };
    placed.push(item);
    return item;
  };

  const pad = 26;
  const gapX = 46;
  const gapY = 10;
  const items = new Map<MindmapNode, Placed>();
  const walk = (node: MindmapNode, depth: number, branch: number) => {
    items.set(node, measure(node, depth, branch));
    node.children.forEach((child, index) => walk(child, depth + 1, depth === 0 ? index : branch));
  };
  walk(root, 0, 0);
  const columnX: number[] = [];
  columnWidths.forEach((_, depth) => {
    columnX[depth] = depth === 0 ? pad : columnX[depth - 1]! + columnWidths[depth - 1]! + gapX;
  });

  // Tidy tree: leaves stack top to bottom; parents center on their children.
  let cursor = pad;
  const place = (node: MindmapNode): number => {
    const item = items.get(node)!;
    item.x = columnX[item.depth]!;
    if (!node.children.length) {
      item.y = cursor;
      cursor += item.height + (item.depth <= 1 ? gapY * 1.6 : gapY);
      return item.y + item.height / 2;
    }
    const centers = node.children.map(place);
    const center = (centers[0]! + centers[centers.length - 1]!) / 2;
    item.y = center - item.height / 2;
    if (item.y < pad) {
      // A tall parent with few children must not climb past the top edge.
      const shift = pad - item.y;
      item.y += shift;
    }
    if (item.depth === 1) cursor += gapY;
    return center;
  };
  place(root);

  const width = (columnX[columnWidths.length - 1] ?? pad) + (columnWidths[columnWidths.length - 1] ?? 0) + pad;
  const bottom = Math.max(...placed.map((item) => item.y + item.height));
  const height = bottom + pad;
  const edges: string[] = [];
  const nodes: string[] = [];
  for (const item of placed) {
    const tone = branchTones[item.branch % branchTones.length]!;
    for (const child of item.node.children) {
      const target = items.get(child)!;
      const x1 = item.x + item.width;
      const y1 = item.y + item.height / 2;
      const x2 = target.x;
      const y2 = target.y + target.height / 2;
      const mid = x1 + (x2 - x1) * 0.55;
      const childTone = branchTones[target.branch % branchTones.length]!;
      edges.push(
        `<path d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}" fill="none" stroke="${childTone.line}" stroke-width="${item.depth === 0 ? 2.2 : 1.6}" stroke-linecap="round" opacity="0.85" />`,
      );
    }
    const s = style(item.depth);
    const radius = Math.min(item.height / 2, 16);
    const fill = item.depth === 0 ? palette.ink : item.depth === 1 ? tone.fill : palette.canvas;
    const stroke = item.depth === 0 ? palette.inkBorder : item.depth === 1 ? tone.border : tone.border;
    const textColor = item.depth === 0 ? palette.inkText : item.depth === 1 ? tone.text : palette.node.text;
    nodes.push(
      `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" rx="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="1.2" />` +
        svgText(item.lines, {
          x: item.x + item.width / 2,
          y: item.y + s.padY + s.size * 0.92,
          size: s.size,
          lineHeight: s.lineHeight,
          weight: s.weight,
          fill: textColor,
          anchor: "middle",
        }),
    );
  }
  return diagramSvg(width, height, palette.canvas, fontFamily, root.text || "Mind map", edges.join("") + nodes.join(""));
}
