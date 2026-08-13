/** Timeline-specific Mermaid helpers.
 *
 * Models often emit almost-valid `timeline` fences that Mermaid's lexer
 * rejects (missing space before `:`, extra `: ` inside an event). Chat used
 * to swallow that as a silent code panel. These repairs plus a SVG-text
 * fallback keep a visual on screen even when Mermaid's own renderer throws
 * (lazy chunk load, getBBox, foreignObject sanitization).
 */

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
      title = trimmed.replace(/^title\s+/i, "").trim();
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

/** SVG-text timeline used when Mermaid's renderer cannot draw one. Avoids
 * foreignObject so PNG rasterization (chat download, Drafts) stays untainted. */
export function renderTimelineFallbackSvg(source: string, dark: boolean, fontFamily: string): string | null {
  const model = parseMermaidTimeline(source);
  if (!model) return null;

  const surface = dark ? "#0d1c27" : "#ffffff";
  const text = dark ? "#e9f3f7" : "#0c1a26";
  const muted = dark ? "#9fb1bd" : "#5c6b7a";
  const line = dark ? "#2c485a" : "#cfdae2";
  const boxFill = dark ? "#102330" : "#f5f9fa";
  const boxStroke = dark ? "#2c485a" : "#cfdae2";
  const accent = dark ? "#3987e5" : "#2a78d6";

  const width = 720;
  const padX = 28;
  const axisX = 40;
  const contentX = 64;
  const contentWidth = width - contentX - padX;
  const wrapWidth = 52;
  let y = 28;
  const parts: string[] = [];

  if (model.title) {
    parts.push(
      `<text x="${width / 2}" y="${y}" text-anchor="middle" font-size="16" font-weight="700" fill="${text}">${escapeXml(model.title)}</text>`,
    );
    y += 28;
  }

  const axisStart = y;
  for (const section of model.sections) {
    if (section.name) {
      y += 8;
      parts.push(
        `<text x="${contentX}" y="${y}" font-size="13" font-weight="700" fill="${accent}">${escapeXml(section.name)}</text>`,
      );
      y += 22;
    }
    for (const period of section.periods) {
      parts.push(`<circle cx="${axisX}" cy="${y - 4}" r="5" fill="${accent}" />`);
      parts.push(
        `<text x="${contentX}" y="${y}" font-size="14" font-weight="700" fill="${text}">${escapeXml(period.period)}</text>`,
      );
      y += 10;
      for (const event of period.events) {
        const eventLines = wrapLabel(event, wrapWidth);
        const boxHeight = 16 + eventLines.length * 18;
        y += 8;
        parts.push(
          `<rect x="${contentX}" y="${y}" width="${contentWidth}" height="${boxHeight}" rx="6" fill="${boxFill}" stroke="${boxStroke}" />`,
        );
        eventLines.forEach((eventLine, lineIndex) => {
          parts.push(
            `<text x="${contentX + 12}" y="${y + 20 + lineIndex * 18}" font-size="13" fill="${text}">${escapeXml(eventLine)}</text>`,
          );
        });
        y += boxHeight;
      }
      y += 18;
    }
  }

  const axisEnd = Math.max(axisStart + 8, y - 12);
  parts.unshift(
    `<line x1="${axisX}" y1="${axisStart - 10}" x2="${axisX}" y2="${axisEnd}" stroke="${line}" stroke-width="3" />`,
  );

  const height = Math.max(y + 16, 80);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeXml(model.title || "Timeline diagram")}">` +
    `<rect width="${width}" height="${height}" fill="${surface}" />` +
    `<g font-family="${escapeXml(fontFamily)}">${parts.join("")}</g>` +
    `</svg>`
  );
}

function sanitizeTimelineEvent(event: string): string {
  // Mermaid's event token stops at the next `: ` (colon + space).
  return event.replace(/:\s+/g, " — ");
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
