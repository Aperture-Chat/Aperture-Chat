/** What the chat API reports doing for a streamed reply.
 *
 * `/api/chat/complete` streams `data: {"activity": {...}}` events next to the
 * text deltas: what was gathered before the model started (knowledge, web,
 * tools, attachments, memories), each continuation round, content-rule
 * screening, the requirement checks run on the finished reply, and what
 * Hermes saved. They are parsed once here, at the wire boundary, into a typed
 * union; anything malformed is dropped rather than guessed at.
 */

export type StreamToolCall = { name: string; ok: boolean };
export type StreamRequirementCheck = { label: string; met: boolean };

export type ChatStreamActivity =
  | { kind: "agent"; name: string }
  | { kind: "privacy" }
  | { kind: "knowledge"; passages: number; sources: number }
  | { kind: "web"; results: number; engine: string }
  | { kind: "web-provider" }
  | { kind: "fetch"; pages: number }
  | { kind: "tools"; servers: number; calls: StreamToolCall[] }
  | { kind: "attachments"; files: number; images: number }
  | { kind: "memory"; recalled: number; companion: number }
  | { kind: "skills"; skills: number; templates: number }
  | { kind: "requirements-noted"; count: number }
  | { kind: "requirements-checked"; checks: StreamRequirementCheck[] }
  | { kind: "screen-hold" }
  | { kind: "screen-done" }
  | { kind: "continue"; round: number }
  | { kind: "hermes"; memories: number; skills: string[]; automations: string[] }
  /** Client-side: the stream dropped and the browser resumed it. */
  | { kind: "resume"; attempt: number };

type Raw = Record<string, unknown>;
type Parser = (raw: Raw) => ChatStreamActivity | null;

/** A non-negative whole number, or null when present but malformed. A missing
 * value reads as zero. */
function count(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => text(item) !== null) : [];
}

/** Object entries of a list; their fields are checked by each caller. */
function records(value: unknown): Raw[] {
  return Array.isArray(value) ? value.filter((item): item is Raw => item !== null && typeof item === "object") : [];
}

/** Every listed count must be well formed; the result maps names to values. */
function counts<K extends string>(raw: Raw, keys: K[]): Record<K, number> | null {
  const values = {} as Record<K, number>;
  for (const key of keys) {
    const value = count(raw[key]);
    if (value === null) return null;
    values[key] = value;
  }
  return values;
}

function parseTools(raw: Raw): ChatStreamActivity | null {
  const servers = count(raw.servers);
  if (servers === null) return null;
  const calls = records(raw.calls)
    .filter((call) => text(call.name) !== null && typeof call.ok === "boolean")
    .map((call) => ({ name: String(call.name), ok: Boolean(call.ok) }));
  return { kind: "tools", servers, calls };
}

function parseRequirements(raw: Raw): ChatStreamActivity | null {
  if (raw.phase === "noted") {
    const noted = count(raw.count);
    return noted ? { kind: "requirements-noted", count: noted } : null;
  }
  if (raw.phase !== "checked") return null;
  const checks = records(raw.checks)
    .filter((check) => text(check.label) !== null && typeof check.met === "boolean")
    .map((check) => ({ label: String(check.label), met: Boolean(check.met) }));
  return { kind: "requirements-checked", checks };
}

function parseWeb(raw: Raw): ChatStreamActivity | null {
  if (raw.provider === true) return { kind: "web-provider" };
  const results = count(raw.results);
  if (results === null) return null;
  return { kind: "web", results, engine: text(raw.engine) ?? "" };
}

const PARSERS: Record<string, Parser> = {
  agent: (raw) => {
    const name = text(raw.name);
    return name ? { kind: "agent", name } : null;
  },
  privacy: () => ({ kind: "privacy" }),
  knowledge: (raw) => {
    const values = counts(raw, ["passages", "sources"]);
    return values && { kind: "knowledge", ...values };
  },
  web: parseWeb,
  fetch: (raw) => {
    const values = counts(raw, ["pages"]);
    return values && { kind: "fetch", ...values };
  },
  tools: parseTools,
  attachments: (raw) => {
    const values = counts(raw, ["files", "images"]);
    return values && { kind: "attachments", ...values };
  },
  memory: (raw) => {
    const values = counts(raw, ["recalled", "companion"]);
    return values && { kind: "memory", ...values };
  },
  skills: (raw) => {
    const values = counts(raw, ["skills", "templates"]);
    return values && { kind: "skills", ...values };
  },
  requirements: parseRequirements,
  screen: (raw) =>
    raw.phase === "hold" ? { kind: "screen-hold" } : raw.phase === "done" ? { kind: "screen-done" } : null,
  continue: (raw) => {
    const round = count(raw.round);
    return round ? { kind: "continue", round } : null;
  },
  hermes: (raw) => {
    const memories = count(raw.memories);
    if (memories === null) return null;
    return { kind: "hermes", memories, skills: strings(raw.skills), automations: strings(raw.automations) };
  },
};

export function parseStreamActivity(raw: unknown): ChatStreamActivity | null {
  // An array or primitive has no string kind, so it falls through to null.
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Raw;
  const parser = typeof record.kind === "string" ? PARSERS[record.kind] : undefined;
  return parser ? parser(record) : null;
}
