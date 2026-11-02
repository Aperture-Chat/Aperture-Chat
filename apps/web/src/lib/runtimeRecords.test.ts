import { expect, test } from "vitest";
import { runtimeRecordsFromAudit, runtimeThreadIds, type RuntimeRecordOptions } from "./runtimeRecords";
import type { AuditEvent } from "./types";

const OPTIONS: RuntimeRecordOptions = {
  threadTitles: new Map([["thread-1", "Lease amendment review"]]),
  modelName: (id) => (id === "gpt-x" ? "GPT X" : id),
  formatTime: (value) => `at ${value}`,
};

function event(overrides: Partial<AuditEvent> = {}, metadata: Record<string, unknown> = {}): AuditEvent {
  return {
    id: "audit-1",
    tenant_id: "tenant-1",
    actor_id: "user-1",
    actor_name: "Jordan Lee",
    actor_role: "USER",
    action: "chat.completion",
    action_type: "CHAT_COMPLETION",
    target: "gpt-x",
    target_type: "model",
    target_name: "gpt-x",
    detail: "",
    created_at: "2026-07-01T12:00:05Z",
    redacted: true,
    metadata,
    ...overrides,
  } as AuditEvent;
}

test("a chat run names the conversation, the person, and the model in words", () => {
  const [record] = runtimeRecordsFromAudit(
    [event({}, {
      surface: "chat",
      thread_id: "thread-1",
      provider: "OpenRouter",
      message_count: 3,
      execution_started_at: "2026-07-01T12:00:01Z",
      client_started_at: "2026-07-01T12:00:00Z",
    })],
    OPTIONS,
  );
  expect(record).toMatchObject({
    surface: "chat",
    title: "Lease amendment review",
    detail: "Jordan Lee · GPT X · OpenRouter · 3 messages",
    metadata: "Chat · sent from their device at 2026-07-01T12:00:00Z",
    executedAt: "2026-07-01T12:00:01Z",
    threadId: "thread-1",
  });
});

test("a conversation with no known name never shows its raw id", () => {
  const [record] = runtimeRecordsFromAudit([event({}, { thread_id: "local-5uhwuiaz" })], OPTIONS);
  expect(record.title).toBe("Chat conversation");
  expect(JSON.stringify([record.title, record.detail, record.metadata])).not.toContain("local-5uhwuiaz");
  expect(record.threadId).toBe("local-5uhwuiaz");
});

test("a draft run shows the draft and offers no conversation to open", () => {
  const [record] = runtimeRecordsFromAudit(
    [event({}, { surface: "draft", draft_title: "HOA PMA", thread_id: "ignored", message_count: 1 })],
    OPTIONS,
  );
  expect(record).toMatchObject({ surface: "draft", title: "HOA PMA", metadata: "Draft", threadId: null });
  expect(record.detail).toContain("1 message");
  expect(record.detail).not.toContain("1 messages");
});

test("details saved under the older runtime context are still read", () => {
  const [record] = runtimeRecordsFromAudit(
    [event({}, { runtime_context: { surface: "chat", thread_id: "thread-1", message_count: 2 }, provider_kind: "openai" })],
    OPTIONS,
  );
  expect(record.title).toBe("Lease amendment review");
  expect(record.detail).toContain("openai · 2 messages");
  expect(record.executedAt).toBe("2026-07-01T12:00:05Z");
});

test("events that are not AI runs are left out", () => {
  expect(runtimeRecordsFromAudit([event({ action: "auth.login" })], OPTIONS)).toEqual([]);
});

test("gateway runs count as chat runs", () => {
  const records = runtimeRecordsFromAudit(
    [event({ action: "gateway.chat_completion" }), event({ id: "audit-2", action: "gateway.responses" })],
    OPTIONS,
  );
  expect(records.map((record) => record.surface)).toEqual(["chat", "chat"]);
});

test("a run without a provider says so", () => {
  const [record] = runtimeRecordsFromAudit([event()], OPTIONS);
  expect(record.detail).toBe("Jordan Lee · GPT X · Provider not recorded");
});

test("the conversations behind a log are listed once each, drafts and other events left out", () => {
  expect(
    runtimeThreadIds([
      event({ id: "1" }, { thread_id: "thread-1" }),
      event({ id: "2" }, { thread_id: "thread-1" }),
      event({ id: "3" }, { runtime_context: { thread_id: "thread-2" } }),
      event({ id: "4" }, { surface: "draft", thread_id: "thread-3" }),
      event({ id: "5", action: "auth.login" }, { thread_id: "thread-4" }),
      event({ id: "6" }),
    ]),
  ).toEqual(["thread-1", "thread-2"]);
});

test("a broken run context is ignored, not fatal", () => {
  for (const runtime_context of [null, ["surface"], "chat"]) {
    const [record] = runtimeRecordsFromAudit([event({}, { runtime_context })], OPTIONS);
    expect(record.surface).toBe("chat");
  }
});

test("a message count that is not a real number is left out", () => {
  for (const message_count of [Number.NaN, Number.POSITIVE_INFINITY, "3"]) {
    const [record] = runtimeRecordsFromAudit([event({}, { message_count })], OPTIONS);
    expect(record.messageCount).toBeNull();
  }
});

test("a value on the event wins over the older runtime context, even zero", () => {
  const [record] = runtimeRecordsFromAudit(
    [event({}, { message_count: 0, runtime_context: { message_count: 5 } })],
    OPTIONS,
  );
  expect(record.messageCount).toBe(0);
});
