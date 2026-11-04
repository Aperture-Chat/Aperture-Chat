import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleData } from "../data/sampleData";
import * as mattersApi from "../lib/api/matters";
import type { ChatThread } from "../lib/types";
import { clearSavedMatters } from "../lib/useSavedMatters";
import { useChatMatter } from "./useChatMatter";

const MATTER = {
  id: "matter-1",
  tenant_id: "tenant-example",
  name: "100234-0001",
  created_by_user_id: "user-admin",
  version: 1,
  created_at: "2026-11-03T00:00:00Z",
  updated_at: "2026-11-03T00:00:00Z",
};

function thread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-1",
    tenant_id: "tenant-example",
    owner_user_id: "user-admin",
    title: "Lease questions",
    model_id: "model-1",
    group_id: "group-1",
    pinned: false,
    used_agent: false,
    updated_at: "Just now",
    messages: [{ id: "m1", role: "user", content: "Hello", createdAt: "9:00 AM", status: "ok" }],
    ...overrides,
  };
}

function chat(activeThread: ChatThread | null) {
  return { activeThread, setThreadMatter: vi.fn(async () => undefined) };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearSavedMatters();
});

describe("useChatMatter", () => {
  it("names the matter the open chat is filed under once the saved numbers load", async () => {
    vi.spyOn(mattersApi, "listMatters").mockResolvedValue([MATTER]);
    const view = renderHook(() => useChatMatter(chat(thread({ matter_id: "matter-1" })), sampleData, true));
    expect(view.result.current.detail).toBe("Filed under a matter.");
    await waitFor(() => expect(view.result.current.detail).toBe("Filed under 100234-0001."));
    expect(view.result.current.currentId).toBe("matter-1");
  });

  it("says a new chat is filed when it is sent, but a stored chat is filed now", async () => {
    vi.spyOn(mattersApi, "listMatters").mockResolvedValue([MATTER]);
    const blank = thread({ title: "New chat", messages: [], pendingMatterId: "matter-1" });
    const fresh = renderHook(() => useChatMatter(chat(blank), sampleData, true));
    await waitFor(() => expect(fresh.result.current.detail).toBe("Filed under 100234-0001 when you send."));
    const stored = renderHook(() => useChatMatter(chat(thread({ pendingMatterId: "matter-1" })), sampleData, true));
    expect(stored.result.current.detail).toBe("Filed under 100234-0001.");
    const unchosen = renderHook(() => useChatMatter(chat(thread({ title: "New chat", messages: [] })), sampleData, true));
    expect(unchosen.result.current.detail).toBe("Add a client-matter number.");
  });

  it("shows why the last change was refused", async () => {
    vi.spyOn(mattersApi, "listMatters").mockResolvedValue([MATTER]);
    const view = renderHook(() => useChatMatter(chat(thread({ matterError: "This matter is being deleted." })), sampleData, true));
    await waitFor(() => expect(view.result.current.detail).toBe("Not filed: This matter is being deleted."));
  });

  it("files the open chat, closing the chooser, and does nothing without a chat", async () => {
    vi.spyOn(mattersApi, "listMatters").mockResolvedValue([]);
    const store = chat(thread());
    const view = renderHook(() => useChatMatter(store, sampleData, true));
    act(() => view.result.current.toggle());
    expect(view.result.current.open).toBe(true);
    act(() => view.result.current.choose("matter-1"));
    expect(store.setThreadMatter).toHaveBeenCalledWith("thread-1", "matter-1");
    expect(view.result.current.open).toBe(false);

    const empty = chat(null);
    const none = renderHook(() => useChatMatter(empty, sampleData, true));
    act(() => none.result.current.toggle());
    act(() => none.result.current.choose("matter-1"));
    expect(empty.setThreadMatter).not.toHaveBeenCalled();
    expect(none.result.current.open).toBe(true);
    expect(none.result.current.currentId).toBeNull();
  });

  it("loads saved numbers only once Send options opens", () => {
    const list = vi.spyOn(mattersApi, "listMatters").mockResolvedValue([]);
    renderHook(() => useChatMatter(chat(thread()), sampleData, false));
    expect(list).not.toHaveBeenCalled();
  });
});
