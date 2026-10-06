/** Timeline-specific Mermaid helpers.
 *
 * Timelines are drawn by Aperture's own renderer (renderTimelineFallbackSvg)
 * rather than Mermaid's: it stays legible at chat widths, never depends on
 * the lazy Mermaid chunk, and parses the almost-valid `timeline` fences
 * models emit (missing space before `:`, extra `: ` inside an event).
 */

import { diagramPalette } from "./diagramTheme";
import { diagramSvg, measureDiagramText, svgText, wrapDiagramText } from "./diagramText";

const TIMELINE_HEADER = /^\s*timeline(?:\s+(?:LR|TD))?\b/i;
const TITLE_LINE = /^(title|accTitle|accDescr)\b/i;
const SECTION_LINE = /^section\b/i;

export type TimelinePeriod = { period: string; events: string[] };
export type TimelineSection = { name: string | null; periods: TimelinePeriod[] };
export type TimelineModel = { title: string; sections: TimelineSection[] };

/** True when the source is a Mermaid timeline after fence artifacts are gone. */
export function isMermaidTimelineSource(source: string): boolean {
  return TIMELINE_HEADER.test(source.trim());
}

/** Makes common model timeline slips parseable without changing stored source
 * at the call site — the renderer uses the repaired text; the editor keeps
 * what the model wrote until the reader saves an edit. */
export function repairMermaidTimelineSource(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const headerIndex = lines.findIndex((line) => TIMELINE_HEADER.test(line));
  if (headerIndex < 0) return source;
  return lines
    .map((line, index) => {
      if (index < headerIndex) return line;
      const indent = /^\s*/.exec(line)?.[0] ?? "";
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (index === headerIndex) return trimmed;
      if (trimmed.startsWith("%%") || trimmed.startsWith("#")) return line;
      if (TITLE_LINE.test(trimmed) || SECTION_LINE.test(trimmed)) return line;
      const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
      if (bullet) return `${indent}: ${sanitizeTimelineEvent(bullet[1])}`;
      if (trimmed.startsWith(":")) {
        return `${indent}: ${sanitizeTimelineEvent(trimmed.replace(/^:\s*/, ""))}`;
      }
      const periodEvent = /^([^:]+?)\s*:\s*(.*)$/.exec(trimmed);
      if (!periodEvent) return line;
      const period = periodEvent[1].trim();
      const event = periodEvent[2].trim();
      if (!period) return line;
      return event
        ? `${indent}${period} : ${sanitizeTimelineEvent(event)}`
        : `${indent}${period}`;
    })
    .join("\n");
}

export function parseMermaidTimeline(source: string): TimelineModel | null {
  const lines = repairMermaidTimelineSource(source).split("\n");
  let index = 0;
  while (index < lines.length && !(lines[index] ?? "").trim()) index += 1;
  if (!TIMELINE_HEADER.test(lines[index] ?? "")) return null;
  index += 1;

  let title = "";
  const sections: TimelineSection[] = [];
  let current: TimelineSection = { name: null, periods: [] };

  const flush = () => {
    if (current.periods.length || current.name) sections.push(current);
  };

  for (; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed || trimmed.startsWith("%%") || trimmed.startsWith("#")) continue;
    if (/^title\s+/i.test(trimmed)) {
      title = trimmed.replace(/^title\s+/i, "").trim().replace(/^["']|["']$/g, "");
      continue;
    }
    if (/^accTitle\s*:/i.test(trimmed) || /^accDescr\s*:/i.test(trimmed)) continue;
    if (SECTION_LINE.test(trimmed)) {
      flush();
      current = { name: trimmed.replace(/^section\s+/i, "").trim() || null, periods: [] };
      continue;
    }
    if (trimmed.startsWith(":")) {
      const event = trimmed.replace(/^:\s*/, "").trim();
      const last = current.periods[current.periods.length - 1];
      if (last && event) last.events.push(event);
      continue;
    }
    const periodEvent = /^(.+?)\s+:\s+(.*)$/.exec(trimmed);
    if (periodEvent) {
      current.periods.push({
        period: periodEvent[1].trim(),
        events: periodEvent[2].trim() ? [periodEvent[2].trim()] : [],
      });
      continue;
    }
    current.periods.push({ period: trimmed, events: [] });
  }
  flush();
  if (!sections.some((section) => section.periods.length)) return null;
  return { title, sections };
}

/** Aperture's timeline: a vertical rail with period labels on the left and
 * event cards on the right, colored per section from the shared palette.
 * Reads well at chat widths (Mermaid's horizontal timeline shrinks to
 * unreadable type past five periods) and uses SVG text only, so PNG
 * rasterization (chat download, Drafts) stays untainted. */
export function renderTimelineFallbackSvg(source: string, dark: boolean, fontFamily: string): string | null {
  const model = parseMermaidTimeline(source);
  if (!model) return null;
  const palette = diagramPalette(dark);

  const width = 760;
  const pad = 30;
  const periodSize = 14;
  const eventSize = 13.5;
  const eventLine = 19;
  const periods = model.sections.flatMap((section) => section.periods);
  const periodColumn = Math.min(
    170,
    Math.max(52, ...periods.map((period) => measureDiagramText(period.period, periodSize, 700))),
  );
  const railX = pad + periodColumn + 20;
  const cardX = railX + 24;
  const cardWidth = width - cardX - pad;
  const textWidth = cardWidth - 30;
  const parts: string[] = [];
  let y = pad;

  if (model.title) {
    const titleLines = wrapDiagramText(model.title, width - pad * 2, 18, 700);
    parts.push(svgText(titleLines, { x: pad, y: y + 16, size: 18, lineHeight: 24, weight: 700, fill: palette.text }));
    y += 16 + titleLines.length * 24 + 10;
  }

  const dots: number[] = [];
  model.sections.forEach((section, sectionIndex) => {
    const color = palette.series[sectionIndex % palette.series.length]!;
    if (section.name) {
      y += 6;
      parts.push(
        svgText([section.name.toUpperCase()], {
          x: cardX,
          y: y + 12,
          size: 11.5,
          weight: 700,
          fill: color,
          extra: 'letter-spacing="0.06em"',
        }),
      );
      y += 26;
    }
    for (const period of section.periods) {
      const top = y;
      const periodLines = wrapDiagramText(period.period, periodColumn, periodSize, 700);
      const events = period.events.length ? period.events : [];
      let cardY = top;
      const cards: string[] = [];
      for (const event of events) {
        const lines = wrapDiagramText(event, textWidth, eventSize, 400);
        const height = 18 + lines.length * eventLine;
        cards.push(
          `<rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${height}" rx="9" fill="${palette.node.fill}" stroke="${palette.node.border}" />` +
            `<rect x="${cardX}" y="${cardY + 8}" width="3.5" height="${height - 16}" rx="1.75" fill="${color}" />` +
            svgText(lines, { x: cardX + 16, y: cardY + 9 + eventSize, size: eventSize, lineHeight: eventLine, fill: palette.node.text }),
        );
        cardY += height + 8;
      }
      const blockBottom = Math.max(cardY - 8, top + periodLines.length * 18 + 4);
      const anchorY = top + 18;
      dots.push(anchorY);
      parts.push(
        svgText(periodLines, {
          x: railX - 18,
          y: anchorY + 5,
          size: periodSize,
          lineHeight: 18,
          weight: 700,
          fill: palette.text,
          anchor: "end",
        }),
      );
      parts.push(...cards);
      parts.push(
        `<circle cx="${railX}" cy="${anchorY}" r="6.5" fill="${color}" stroke="${palette.canvas}" stroke-width="3" />`,
      );
      y = blockBottom + 16;
    }
  });

  if (dots.length > 1) {
    parts.unshift(
      `<line x1="${railX}" y1="${dots[0]}" x2="${railX}" y2="${dots[dots.length - 1]}" stroke="${palette.axis}" stroke-width="2" stroke-linecap="round" />`,
    );
  }

  const height = Math.max(y - 16 + pad, 90);
  return diagramSvg(width, height, palette.canvas, fontFamily, model.title || "Timeline diagram", parts.join(""));
}

function sanitizeTimelineEvent(event: string): string {
  // Mermaid's event token stops at the next `: ` (colon + space).
  return event.replace(/:\s+/g, " — ");
}
