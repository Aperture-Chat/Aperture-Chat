import { parseDocument } from "yaml";

/** Parse the structured source used by Aperture card diagrams. Models may
 * emit the same schema as JSON or as real YAML, so detection and rendering
 * must share one safe parser instead of treating "YAML" as JSON-with-a-label. */
export function parseStructuredDiagramSource(source: string): unknown | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with YAML. The document API lets us reject malformed input,
    // duplicate keys, and alias expansion before it reaches the renderer.
  }

  try {
    const document = parseDocument(trimmed, { uniqueKeys: true });
    if (document.errors.length > 0) return null;
    return document.toJS({ maxAliasCount: 20 }) ?? null;
  } catch {
    return null;
  }
}

/** The same structural precondition used by the card-diagram renderer. This
 * keeps ordinary JSON/YAML code as code while recognizing either syntax when
 * it actually contains diagram rows and usable cards. */
export function looksLikeStructuredDiagramSource(source: string): boolean {
  const raw = parseStructuredDiagramSource(source);
  if (!raw || typeof raw !== "object") return false;
  const rows = (raw as Record<string, unknown>).rows;
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => {
    const cards = Array.isArray(row) ? row : (row as Record<string, unknown>)?.cards;
    return (
      Array.isArray(cards) &&
      cards.some(
        (card) =>
          Boolean(card) &&
          typeof card === "object" &&
          typeof (card as Record<string, unknown>).id === "string" &&
          typeof (card as Record<string, unknown>).title === "string",
      )
    );
  });
}

export type StructuredSummaryValue = string | number | boolean;

export type StructuredSummaryEntry = {
  key: string;
  values: StructuredSummaryValue[];
  collection: boolean;
};

export type StructuredSummarySource = {
  title: string;
  subtitle?: string;
  footnote?: string;
  entries: StructuredSummaryEntry[];
};

const SUMMARY_METADATA_KEYS = new Set(["title", "subtitle", "tag", "footnote"]);
const SUMMARY_STATUS_PATTERN =
  /\b(?:achieved|active|blocked|complete(?:d)?|failed|false|inactive|missing|not|pending|ready|success|true|unavailable|yes|no)\b/i;

function summaryTitle(keys: string[], explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const joined = keys.join(" ").toLowerCase();
  if (/research|clinical|trial|organ|patient/.test(joined)) return "Research status summary";
  if (/timeline|milestone|date|period/.test(joined)) return "Timeline summary";
  if (/risk|control|finding|audit/.test(joined)) return "Risk and findings summary";
  if (/phase|stage|workflow|process/.test(joined)) return "Process status summary";
  return "Structured summary";
}

/**
 * Recognize the second structured visual shape models commonly emit: a flat
 * status object plus two or more categorized lists. It is not a box-and-arrow
 * `rows` diagram, but it is clearly presentation data rather than executable
 * code and can be rendered as a card summary without inventing facts.
 *
 * Detection is intentionally narrower than "any JSON object": a single config
 * object, scalar payload, or one ordinary array remains a normal code block.
 */
export function parseStructuredSummarySource(source: string): StructuredSummarySource | null {
  const raw = parseStructuredDiagramSource(source);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  const entries: StructuredSummaryEntry[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (SUMMARY_METADATA_KEYS.has(key.toLowerCase())) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      entries.push({ key, values: [value], collection: false });
      continue;
    }
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (item): item is StructuredSummaryValue =>
          typeof item === "string" || typeof item === "number" || typeof item === "boolean",
      )
    ) {
      entries.push({ key, values: value, collection: true });
    }
  }

  const collections = entries.filter((entry) => entry.collection);
  const statusScalars = entries.filter(
    (entry) => !entry.collection && SUMMARY_STATUS_PATTERN.test(String(entry.values[0] ?? "")),
  );
  const detailCount = entries.reduce((count, entry) => count + entry.values.length, 0);
  if (
    detailCount < 4 ||
    !(collections.length >= 2 || (collections.length >= 1 && statusScalars.length >= 1))
  ) {
    return null;
  }

  return {
    title: summaryTitle(
      entries.map((entry) => entry.key),
      typeof record.title === "string" ? record.title : undefined,
    ),
    subtitle: typeof record.subtitle === "string" ? record.subtitle.trim() || undefined : undefined,
    footnote: typeof record.footnote === "string" ? record.footnote.trim() || undefined : undefined,
    entries,
  };
}

export function looksLikeStructuredSummarySource(source: string): boolean {
  return parseStructuredSummarySource(source) !== null;
}
