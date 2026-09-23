import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import * as api from "./api";
import {
  preservePendingTraceState,
  resumablePendingAssistant,
  targetModelForRequest,
  useChatStore,
  type ChatResponseVersion,
} from "./chatStore";
import type { BootstrapData, ChatMessage, ChatThread, ModelConfig } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function firstUseData(): BootstrapData {
  return {
    ...sampleData,
    me: { ...sampleData.me, id: "fresh-user", role: "USER", group_ids: ["group-1"] },
    providers: [{ ...sampleData.providers[0], id: "openrouter", connected: true }],
    models: [
      { ...model("image-model", "Gemini 2.5 Flash Image"), capabilities: { output_modalities: ["text", "image"] } },
      { ...model("text-model", "GPT-4o mini"), capabilities: { output_modalities: ["text"] } },
    ],
  };
}

test.each(["USER", "TENANT_ADMIN"] as const)("new %s chats use a member group when another group appears first", async (role) => {
  const data = firstUseData();
  data.me = { ...data.me, role, group_ids: ["member-group"] };
  data.groups = [
    { ...sampleData.groups[0], id: "other-group" },
    { ...sampleData.groups[0], id: "member-group" },
  ];
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});
  expect(view.result.current.activeThread?.group_id).toBe("member-group");
  act(() => view.result.current.newChat());
  expect(view.result.current.activeThread?.group_id).toBe("member-group");
});

test("new chats without an available member group remain unassigned", async () => {
  const data = firstUseData();
  data.me.group_ids = ["unavailable-group"];
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});
  expect(view.result.current.activeThread?.group_id).toBe("");
});

test("platform owners retain their permitted workspace group for new chats", async () => {
  const data = firstUseData();
  data.me = { ...data.me, role: "PLATFORM_OWNER", group_ids: [] };
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});
  expect(view.result.current.activeThread?.group_id).toBe(data.groups[0].id);
});

test("fresh chats prefer text while an explicit image choice survives history hydration and reload", async () => {
  const data = firstUseData();
  let finishHistory!: (threads: ChatThread[]) => void;
  const history = new Promise<ChatThread[]>((resolve) => { finishHistory = resolve; });
  vi.spyOn(api, "listChatThreads").mockReturnValueOnce(history).mockResolvedValue([]);
  const view = renderHook(() => useChatStore(data.me.id, data));

  expect(view.result.current.model).toBe("text-model");
  act(() => view.result.current.setModel("image-model"));
  await act(async () => { finishHistory([]); await history; });
  expect(view.result.current.model).toBe("image-model");
  expect(targetModelForRequest(view.result.current.enabledModels, view.result.current.model, "text-model")).toBe("image-model");
  view.unmount();

  const restored = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});
  expect(restored.result.current.model).toBe("image-model");
});

test("a valid pinned image default remains preferred for a fresh chat", async () => {
  const data = firstUseData();
  window.localStorage.setItem(`aperture-default-model-${data.me.id}`, "image-model");
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});

  expect(view.result.current.model).toBe("image-model");
  expect(view.result.current.defaultModelId).toBe("image-model");
  act(() => view.result.current.setModel("text-model"));
  act(() => view.result.current.newChat());
  expect(view.result.current.model).toBe("image-model");
});

test("an unavailable saved selection falls back to text without erasing its pinned preference", async () => {
  const data = firstUseData();
  data.models = data.models.map((item) => item.id === "image-model" ? { ...item, platform_enabled: false } : item);
  window.localStorage.setItem(`aperture-default-model-${data.me.id}`, "image-model");
  window.localStorage.setItem(`aperture-chats-v2-${data.me.id}`, JSON.stringify([
    { ...thread([]), title: "New chat", model_id: "image-model", owner_user_id: data.me.id },
  ]));
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});

  expect(view.result.current.model).toBe("text-model");
  expect(view.result.current.activeThread?.model_id).toBe("text-model");
  expect(window.localStorage.getItem(`aperture-default-model-${data.me.id}`)).toBe("image-model");
});

function thread(messages: ChatMessage[]): ChatThread {
  return {
    id: "thread-1",
    title: "Artemis paper",
    group_id: "group-1",
    model_id: "model-1",
    updated_at: "Just now",
    messages,
  } as ChatThread;
}

const userMessage: ChatMessage = {
  id: "msg-user",
  role: "user",
  content: "Draft me a ten page paper on the Artemis II mission",
  createdAt: "2:25 PM",
  status: "ok",
};

function model(id: string, name: string): ModelConfig {
  return {
    id,
    name,
    provider_id: "openrouter",
    provider_name: "OpenRouter",
    upstream_model_id: id,
    platform_enabled: true,
    tenant_restricted: false,
    group_ids: ["group-1"],
  };
}

test("keeps the selected model as the request target", () => {
  const enabledModels = [
    model("openai-gpt-5-5", "OpenAI: GPT-5.5"),
    model("anthropic-opus-4-8", "Anthropic: Claude Opus 4.8"),
  ];

  expect(targetModelForRequest(enabledModels, "anthropic-opus-4-8", "openai-gpt-5-5")).toBe(
    "anthropic-opus-4-8",
  );
});

test("honors an explicit agent profile model override", () => {
  const enabledModels = [
    model("openai-gpt-5-5", "OpenAI: GPT-5.5"),
    model("agent-client-update", "Client Update Agent"),
  ];

  expect(
    targetModelForRequest(enabledModels, "openai-gpt-5-5", "openai-gpt-5-5", {
      modelOverride: "agent-client-update",
      agentEnabled: true,
    }),
  ).toBe("agent-client-update");
});

test("keeps a stored pending assistant message resumable after reload", () => {
  const pending: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "Partial draft already streamed.",
    createdAt: "2:25 PM",
    status: "pending",
    startedAtMs: 1000,
  };
  const source = thread([userMessage, pending]);
  expect(resumablePendingAssistant(source)?.id).toBe("msg-assistant");
  expect(resumablePendingAssistant(source)?.content).toContain("Partial draft");
});

test("keeps pending response versions resumable without touching completed ones", () => {
  const versions: ChatResponseVersion[] = [
    { id: "v1", label: "Version 1", content: "Finished draft", status: "ok" },
    { id: "v2", label: "Version 2", content: "New partial", status: "pending" },
  ];
  const message: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "New partial",
    createdAt: "2:25 PM",
    status: "pending",
    metadata: { responseVersions: versions, activeResponseVersionIndex: 1 },
  };
  const pending = resumablePendingAssistant(thread([userMessage, message]));
  expect(pending?.status).toBe("pending");
  const pendingVersions = pending?.metadata?.responseVersions as ChatResponseVersion[];
  expect(pendingVersions[0]).toEqual(versions[0]);
  expect(pendingVersions[1].status).toBe("pending");
  expect(pendingVersions[1].content).toBe("New partial");
});

test("leaves threads without pending messages untouched", () => {
  const done: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "Here is the paper.",
    createdAt: "2:26 PM",
    status: "ok",
  };
  const source = thread([userMessage, done]);
  expect(resumablePendingAssistant(source)).toBeNull();
});

test("server merge keeps the local pending bubble over an older snapshot", () => {
  const pending: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "Later partial",
    createdAt: "2:25 PM",
    status: "pending",
    startedAtMs: 2000,
  };
  const local = thread([userMessage, pending]);
  const server = thread([
    userMessage,
    { ...pending, content: "", startedAtMs: 1000 },
  ]);
  const merged = preservePendingTraceState(local, server);
  expect(merged.messages[1].content).toBe("Later partial");
  expect(merged.messages[1].status).toBe("pending");
});

test("a completed server snapshot wins over a stale local pending bubble", () => {
  const pending: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "Stale partial",
    createdAt: "2:25 PM",
    status: "pending",
  };
  const completed: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "Finished on another tab",
    createdAt: "2:26 PM",
    status: "ok",
  };
  const merged = preservePendingTraceState(thread([userMessage, pending]), thread([userMessage, completed]));
  expect(merged.messages[1].status).toBe("ok");
  expect(merged.messages[1].content).toBe("Finished on another tab");
});

test("a failed thread save marks it unsynced, and a later success or hydration clears it", async () => {
  const data = firstUseData();
  const thread: ChatThread = {
    id: "thread-unsynced",
    owner_user_id: data.me.id,
    title: "Offline edits",
    model_id: "text-model",
    group_id: null,
    pinned: false,
    used_agent: false,
    updated_at: "2026-09-13T00:00:00Z",
    messages: [{ id: "m1", role: "user", content: "hello", createdAt: "12:00 PM", status: "ok" } as ChatMessage],
  };
  window.localStorage.setItem(`aperture-chats-v2-${data.me.id}`, JSON.stringify([thread]));
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  const save = vi.spyOn(api, "saveChatThread").mockRejectedValue(new Error("offline"));
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});
  expect(view.result.current.unsyncedThreadCount).toBe(0);

  await act(async () => {
    view.result.current.togglePin("thread-unsynced");
  });
  await act(async () => {});
  expect(view.result.current.unsyncedThreadCount).toBe(1);
  expect(view.result.current.threads.find((item) => item.id === "thread-unsynced")?.syncPending).toBe(true);
  expect(save).toHaveBeenCalled();

  save.mockImplementation(async (_userId, saved) => ({ ...saved, syncPending: undefined }));
  await act(async () => {
    await view.result.current.retryUnsyncedThreads();
  });
  expect(view.result.current.unsyncedThreadCount).toBe(0);
  expect(view.result.current.threads.find((item) => item.id === "thread-unsynced")?.syncPending).toBe(false);
});

function readThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id: "thread-read-sync",
    tenant_id: sampleData.currentTenant.id,
    owner_user_id: "fresh-user",
    title: "Automation digest",
    model_id: "text-model",
    group_id: "group-1",
    pinned: false,
    archived: false,
    folder_id: null,
    used_agent: false,
    updated_at: "Sep 22, 9:00 AM",
    messages: [
      { id: "u1", role: "user", content: "Summarize", createdAt: "9:00 AM", status: "ok" },
      { id: "a1", role: "assistant", content: "Summary", createdAt: "9:01 AM", status: "ok" },
    ],
    last_read_message_id: null,
    ...overrides,
  };
}

test("marking a chat read stores the position on the server without saving or reordering the chat", async () => {
  const data = firstUseData();
  vi.spyOn(api, "listChatThreads").mockResolvedValue([readThread()]);
  const save = vi.spyOn(api, "saveChatThread");
  const markRead = vi
    .spyOn(api, "markChatThreadRead")
    .mockResolvedValue({ thread_id: "thread-read-sync", last_read_message_id: "a1" });
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});

  act(() => view.result.current.markThreadRead("thread-read-sync"));

  const updated = view.result.current.threads.find((thread) => thread.id === "thread-read-sync");
  expect(updated?.last_read_message_id).toBe("a1");
  expect(updated?.updated_at).toBe("Sep 22, 9:00 AM");
  expect(markRead).toHaveBeenCalledWith(data.me.id, "thread-read-sync", "a1");
  expect(save).not.toHaveBeenCalled();

  // Already read: nothing more to send.
  act(() => view.result.current.markThreadRead("thread-read-sync"));
  expect(markRead).toHaveBeenCalledTimes(1);
});

test("a read the server could not take yet rides along with the chat's next save", async () => {
  const data = firstUseData();
  vi.spyOn(api, "listChatThreads").mockResolvedValue([readThread()]);
  vi.spyOn(api, "markChatThreadRead").mockRejectedValue(new Error("409"));
  const save = vi
    .spyOn(api, "saveChatThread")
    .mockImplementation(async (_user, thread) => ({ ...thread, last_read_message_id: thread.last_read_message_id ?? null }));
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});

  await act(async () => view.result.current.markThreadRead("thread-read-sync"));
  await act(async () => view.result.current.togglePin("thread-read-sync"));

  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][1].last_read_message_id).toBe("a1");
});

test("a newer read position from this browser survives the server copy and is sent on", async () => {
  const data = firstUseData();
  window.localStorage.setItem(
    `aperture-chats-v2-${data.me.id}`,
    JSON.stringify([readThread({ last_read_message_id: "a1" })]),
  );
  vi.spyOn(api, "listChatThreads").mockResolvedValue([readThread({ last_read_message_id: null })]);
  const markRead = vi
    .spyOn(api, "markChatThreadRead")
    .mockResolvedValue({ thread_id: "thread-read-sync", last_read_message_id: "a1" });
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});

  expect(view.result.current.threads.find((thread) => thread.id === "thread-read-sync")?.last_read_message_id).toBe("a1");
  expect(markRead).toHaveBeenCalledWith(data.me.id, "thread-read-sync", "a1");
});

test("server snapshots never move a read position backwards", () => {
  const local = readThread({
    messages: [...readThread().messages, { id: "u2", role: "user", content: "More", createdAt: "9:02 AM", status: "ok" }, { id: "a2", role: "assistant", content: "More detail", createdAt: "9:03 AM", status: "ok" }],
    last_read_message_id: "a2",
  });
  const stale = { ...local, last_read_message_id: "a1" };
  expect(preservePendingTraceState(local, stale).last_read_message_id).toBe("a2");
  const ahead = { ...local, last_read_message_id: "a2" };
  expect(preservePendingTraceState({ ...local, last_read_message_id: "a1" }, ahead).last_read_message_id).toBe("a2");
});
