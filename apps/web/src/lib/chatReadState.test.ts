import { beforeEach, expect, test } from "vitest";
import { forgetLegacyReadState, isThreadUnread, laterReadMarker, readableMessageId } from "./chatReadState";
import type { ChatMessage, ChatThread } from "./types";

function message(id: string, role: ChatMessage["role"], status: ChatMessage["status"] = "ok"): ChatMessage {
  return { id, role, content: "text", createdAt: "9:00 AM", status } as ChatMessage;
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
    messages: [message("u1", "user"), message("a1", "assistant")],
    ...overrides,
  } as ChatThread;
}

beforeEach(() => {
  window.localStorage.clear();
});

test("a reply is unread until the stored read position reaches it", () => {
  expect(isThreadUnread(thread())).toBe(true);
  expect(isThreadUnread(thread({ last_read_message_id: "a1" }))).toBe(false);

  // A newer reply arrives after the last read.
  const continued = thread({
    last_read_message_id: "a1",
    messages: [message("u1", "user"), message("a1", "assistant"), message("u2", "user"), message("a2", "assistant")],
  });
  expect(isThreadUnread(continued)).toBe(true);
});

test("saves that change only metadata never make a read chat unread", () => {
  // Pinning or renaming bumps updated_at on the server; the messages are unchanged.
  const read = thread({ last_read_message_id: "a1", updated_at: "2026-09-01T00:00:00Z", pinned: true });
  expect(isThreadUnread(read)).toBe(false);
});

test("a chat whose last message is the user's own, or still streaming, is not unread", () => {
  expect(isThreadUnread(thread({ messages: [message("u1", "user")] }))).toBe(false);
  expect(isThreadUnread(thread({ messages: [] }))).toBe(false);
  const streaming = thread({ messages: [message("u1", "user"), message("a1", "assistant", "pending")] });
  expect(readableMessageId(streaming)).toBeNull();
  expect(isThreadUnread(streaming)).toBe(false);
});

test("read positions only move forward, mirroring the API merge", () => {
  const ids = ["u1", "a1", "u2", "a2"];
  expect(laterReadMarker(ids, null, "a1")).toBe("a1");
  expect(laterReadMarker(ids, "a1", "a2")).toBe("a2");
  expect(laterReadMarker(ids, "a2", "a1")).toBe("a2");
  expect(laterReadMarker(ids, "a2", undefined)).toBe("a2");
  expect(laterReadMarker(ids, "a1", "unknown")).toBe("a1");
  expect(laterReadMarker(ids, "removed", "a1")).toBe("a1");
});

test("browser-only read state from earlier releases is cleared", () => {
  window.localStorage.setItem("aperture-chat-read-v1-user-1", JSON.stringify({ "thread-1": 1 }));
  window.localStorage.setItem("aperture-chat-read-v1-user-1:seeded", "1");
  window.localStorage.setItem("aperture-chat-read-v1-user-2", JSON.stringify({ "thread-2": 2 }));

  forgetLegacyReadState("user-1");

  expect(window.localStorage.getItem("aperture-chat-read-v1-user-1")).toBeNull();
  expect(window.localStorage.getItem("aperture-chat-read-v1-user-1:seeded")).toBeNull();
  expect(window.localStorage.getItem("aperture-chat-read-v1-user-2")).not.toBeNull();
});
