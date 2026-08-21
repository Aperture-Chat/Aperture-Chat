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
