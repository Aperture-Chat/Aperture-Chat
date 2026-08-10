import { beforeEach, expect, test } from "vitest";
import {
  CHAT_READ_STORAGE_PREFIX,
  isThreadUnread,
  loadReadState,
  markThreadRead,
  saveReadState,
  seedReadState,
} from "./chatReadState";
import type { ChatMessage, ChatThread } from "./types";

function message(role: ChatMessage["role"], createdAt: string): ChatMessage {
  return { id: `msg-${role}-${createdAt}`, role, content: "text", createdAt } as ChatMessage;
}

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    tenant_id: "tenant-example",
    title: "Automation: AI Search",
    model_id: "model-1",
    group_id: "",
    pinned: false,
    used_agent: false,
    updated_at: "2026-08-04T12:00:00Z",
    messages: [message("user", "2026-08-04T11:59:00Z"), message("assistant", "2026-08-04T12:00:00Z")],
    ...overrides,
  } as ChatThread;
}

beforeEach(() => {
  window.localStorage.clear();
});

test("a chat is unread only once it changes after the user last opened it", () => {
  const item = thread();
  const seeded = seedReadState("user-one", {}, [item]);

  expect(isThreadUnread(item, seeded)).toBe(false);

  const replied = thread({ updated_at: "2026-08-04T13:00:00Z" });
  expect(isThreadUnread(replied, seeded)).toBe(true);

  const afterOpening = markThreadRead(seeded, replied);
  expect(isThreadUnread(replied, afterOpening)).toBe(false);
});

test("a chat whose last message is the user's own is never unread", () => {
  const awaitingReply = thread({
    updated_at: "2026-08-04T13:00:00Z",
    messages: [message("assistant", "2026-08-04T12:00:00Z"), message("user", "2026-08-04T13:00:00Z")],
  });

  // There is nothing new to review, so the indicator must stay off.
  expect(isThreadUnread(awaitingReply, { "thread-1": 0 })).toBe(false);
});

test("existing history is not marked unread when the indicator first appears", () => {
  // Seeding is what stops a whole chat list lighting up on the first load
  // after this feature ships.
  const history = [thread({ id: "a" }), thread({ id: "b" }), thread({ id: "c" })];

  const seeded = seedReadState("user-one", {}, history);

  expect(history.every((item) => !isThreadUnread(item, seeded))).toBe(true);
});

test("a chat that arrives after the first load is unread — the whole point", () => {
  // An automation finishing while the user is elsewhere produces exactly this:
  // a thread with no read entry. Seeding must not run again and swallow it.
  const history = [thread({ id: "a" })];
  const seeded = seedReadState("user-one", {}, history);
  expect(isThreadUnread(history[0], seeded)).toBe(false);

  const fromAutomation = thread({ id: "automation-result" });
  const afterSecondPass = seedReadState("user-one", seeded, [...history, fromAutomation]);

  expect(afterSecondPass).toBe(seeded);
  expect(isThreadUnread(fromAutomation, afterSecondPass)).toBe(true);
});

test("read state round-trips per user and survives unreadable storage", () => {
  saveReadState("user-one", { "thread-1": 42 });
  expect(loadReadState("user-one")).toEqual({ "thread-1": 42 });
  // Another account starts clean rather than inheriting someone else's reads.
  expect(loadReadState("user-two")).toEqual({});

  window.localStorage.setItem(`${CHAT_READ_STORAGE_PREFIX}-user-three`, "not json");
  expect(loadReadState("user-three")).toEqual({});
});
