/** A piece of text that is either a fill-in blank or the words around one. */
export type FillInSegment = { text: string; blank: boolean };

/** A fill-in blank, as legal templates write one: three or more underscores.
 * One or two (`snake_case`, `__init__`) are words, not blanks. */
const FILL_IN_BLANK_RUN = /(_{3,})/;

/** Splits text into fill-in blanks and the text between them, keeping every
 * character, so a comparison view can draw each blank as the single line the
 * document shows instead of a row of underscores. */
export function splitFillInBlanks(text: string): FillInSegment[] {
  return text
    .split(FILL_IN_BLANK_RUN)
    .filter(Boolean)
    .map((segment) => ({ text: segment, blank: /^_{3,}$/.test(segment) }));
}
