/** One AI run as the consoles show it, read from the completion audit event.
 * The server stamps these events itself, so they stand as the record of who
 * ran what and when, whatever the person's own device clock said. */

import type { AuditEvent } from "./types";

export type RuntimeRecord = {
  id: string;
  surface: "chat" | "draft";
  /** The conversation or draft by name, never a raw id. */
  title: string;
  /** Who, which model, which provider, how many messages. */
  detail: string;
  /** Plain statement of when the person's device sent it. */
  metadata: string;
  executedAt: string;
  clientStartedAt: string | null;
  actorId: string;
  actorName: string;
  actorRole: string;
  model: string;
  provider: string;
  messageCount: number | null;
  /** Set only for a chat run, whose saved conversation can be opened. */
  threadId: string | null;
};

const COMPLETION_ACTIONS = new Set(["chat.completion", "gateway.chat_completion", "gateway.responses"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function plural(amount: number, noun: string) {
  return `${amount.toLocaleString()} ${noun}${amount === 1 ? "" : "s"}`;
}

export type RuntimeRecordOptions = {
  /** Conversation names the viewer may see. */
  threadTitles: ReadonlyMap<string, string>;
  /** Display name for a model id. */
  modelName: (modelId: string) => string;
  formatTime: (value: string) => string;
};

/** Reads an audit event's run fields, or null when the event is not an AI run. */
function runFields(event: AuditEvent) {
  const metadata = asRecord(event.metadata);
  const context = asRecord(metadata.runtime_context);
  const field = (key: string) => metadata[key] ?? context[key];
  const surfaceValue = text(field("surface"));
  if (!COMPLETION_ACTIONS.has(event.action) && !surfaceValue) return null;
  const surface: RuntimeRecord["surface"] = surfaceValue === "draft" ? "draft" : "chat";
  return { metadata, field, surface, threadId: surface === "chat" ? text(field("thread_id")) : null };
}

/** The saved conversations behind these events, each once. */
export function runtimeThreadIds(events: AuditEvent[]): string[] {
  const ids = events.flatMap((event) => runFields(event)?.threadId ?? []);
  return [...new Set(ids)];
}

function runProvider(metadata: Record<string, unknown>) {
  return text(metadata.provider) ?? text(metadata.provider_name) ?? text(metadata.provider_kind) ?? "Provider not recorded";
}

function runTitle(surface: RuntimeRecord["surface"], draftTitle: unknown, threadId: string | null, titles: ReadonlyMap<string, string>) {
  if (surface === "draft") return text(draftTitle) ?? "Untitled draft";
  return (threadId && titles.get(threadId)) || "Chat conversation";
}

function runtimeRecord(event: AuditEvent, options: RuntimeRecordOptions): RuntimeRecord | null {
  const run = runFields(event);
  if (!run) return null;
  const { metadata, field, surface, threadId } = run;
  const clientStartedAt = text(field("client_started_at"));
  const provider = runProvider(metadata);
  const messageCount = count(field("message_count"));
  const model = options.modelName(event.target);
  const actorName = event.actor_name || event.actor_id;
  const kindLabel = surface === "draft" ? "Draft" : "Chat";
  const messages = messageCount ? plural(messageCount, "message") : null;
  return {
    id: event.id,
    surface,
    title: runTitle(surface, field("draft_title"), threadId, options.threadTitles),
    detail: [actorName, model, provider, messages].filter(Boolean).join(" · "),
    metadata: clientStartedAt ? `${kindLabel} · sent from their device ${options.formatTime(clientStartedAt)}` : kindLabel,
    executedAt: text(field("execution_started_at")) ?? event.created_at,
    clientStartedAt,
    actorId: event.actor_id,
    actorName,
    actorRole: event.actor_role,
    model,
    provider,
    messageCount,
    threadId,
  };
}

export function runtimeRecordsFromAudit(events: AuditEvent[], options: RuntimeRecordOptions): RuntimeRecord[] {
  return events.flatMap((event) => {
    const record = runtimeRecord(event, options);
    return record ? [record] : [];
  });
}
