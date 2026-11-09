import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { sampleData } from "../data/sampleData";
import * as api from "./api";
import {
  messageWithActiveResponseVersion,
  preservePendingTraceState,
  resumablePendingAssistant,
  targetModelForRequest,
  useChatStore,
  withPendingActivity,
  withStreamedPendingContent,
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

test("a streamed reply grows its own work trace", () => {
  const pending: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "",
    createdAt: "2:25 PM",
    status: "pending",
    startedAtMs: 10_000,
    activityTrace: [{ id: "route:model", label: "Routed to M" }],
  };
  const gathered = withPendingActivity(pending, { kind: "web", results: 2, engine: "searxng" });
  const streamed = withStreamedPendingContent(gathered, "## Plan\n\nOak", 13_000);
  expect(streamed.content).toBe("## Plan\n\nOak");
  expect(streamed.activityTrace?.map((step) => step.label)).toEqual([
    "Routed to M",
    "Searched the web · 2 results",
    "Thought for 3s",
    "Drafting “Plan”",
  ]);
});

test("a regenerated reply grows the trace of its newest version only", () => {
  const versions: ChatResponseVersion[] = [
    { id: "v1", label: "Version 1", content: "Finished", status: "ok", activityTrace: [{ id: "done:reply", label: "Delivered" }] },
    { id: "v2", label: "Version 2", content: "", status: "pending", startedAtMs: 0, activityTrace: [] },
  ];
  const message: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "",
    createdAt: "2:25 PM",
    status: "pending",
    metadata: { responseVersions: versions, activeResponseVersionIndex: 1 },
  };
  const next = withStreamedPendingContent(withPendingActivity(message, { kind: "continue", round: 1 }), "Hi", 2_000);
  const nextVersions = next.metadata?.responseVersions as ChatResponseVersion[];
  expect(nextVersions[0]).toEqual(versions[0]);
  expect(nextVersions[1].content).toBe("Hi");
  expect(nextVersions[1].activityTrace?.map((step) => step.id)).toEqual(["continue:r1", "think:first-token", "write:intro"]);
  expect(next.activityTrace).toEqual(nextVersions[1].activityTrace);
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

test("sending in one chat moves it to the top once and keeps every other chat", async () => {
  const data = firstUseData();
  vi.spyOn(api, "listChatThreads").mockResolvedValue([
    readThread({ id: "thread-a", title: "First" }),
    readThread({ id: "thread-b", title: "Second" }),
  ]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  vi.spyOn(api, "sendChatStream").mockResolvedValue({ content: "Done.", citations: [], memoryUsed: 0, memorySaved: [] });
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});
  act(() => view.result.current.selectThread("thread-b"));

  await act(async () => {
    view.result.current.sendMessage("One more thing", []);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  expect(view.result.current.threads.map((item) => item.title)).toEqual(["Second", "First", "New chat"]);
  expect(view.result.current.activeThread?.messages.map((message) => message.content)).toEqual([
    "Summarize",
    "Summary",
    "One more thing",
    "Done.",
  ]);
});

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

test("each response version keeps the sources of its own reply", () => {
  const citation = (id: string): NonNullable<ChatMessage["citations"]>[number] => ({
    id,
    source_name: id,
    source_type: "upload",
    source_uri: `upload://${id}`,
    snippet: "Passage.",
    k_index: 1,
  });
  const version = (id: string, citations: ChatMessage["citations"]) => ({
    id,
    label: id,
    content: "Grounded [K1].",
    status: "ok",
    citations,
    createdAt: "10:00 AM",
  });
  const message = (activeResponseVersionIndex: number): ChatMessage => ({
    id: "reply",
    role: "assistant",
    content: "Grounded [K1].",
    createdAt: "10:00 AM",
    status: "ok",
    citations: [],
    metadata: {
      activeResponseVersionIndex,
      responseVersions: [
        version("first", [citation("first-document")]),
        version("second", [citation("second-document")]),
      ],
    },
  });

  expect(messageWithActiveResponseVersion(message(0)).citations?.map((item) => item.id)).toEqual(["first-document"]);
  expect(messageWithActiveResponseVersion(message(1)).citations?.map((item) => item.id)).toEqual(["second-document"]);
});

async function seedArchivedThread(view: { result: { current: ReturnType<typeof useChatStore> } }) {
  let threadId = "";
  await act(async () => {
    threadId = view.result.current.sendMessageInNewThread("Keep me until the server agrees")?.id ?? "";
  });
  await act(async () => {
    view.result.current.archiveThread(threadId);
  });
  return threadId;
}

test("a refused permanent delete keeps the chat and reports the server's reason", async () => {
  const data = structuredClone(sampleData);
  const view = renderHook(() => useChatStore(data.me.id, data));
  const refusal = new api.ChatRequestError("This chat is protected by a legal hold.", 409);
  vi.spyOn(api, "deleteChatThread").mockRejectedValue(refusal);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_userId, thread) => thread);
  const created = await seedArchivedThread(view);

  let outcome: unknown;
  await act(async () => {
    outcome = await view.result.current.deleteThread(created).catch((error: unknown) => error);
  });

  expect(outcome).toBe(refusal);
  expect(view.result.current.threads.some((thread) => thread.id === created)).toBe(true);
});

test("a confirmed permanent delete leaves the list only once the server agrees", async () => {
  const data = structuredClone(sampleData);
  const view = renderHook(() => useChatStore(data.me.id, data));
  let confirm!: (value: { status: string; id: string }) => void;
  vi.spyOn(api, "deleteChatThread").mockImplementation(() => new Promise((resolve) => { confirm = resolve; }));
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_userId, thread) => thread);
  const created = await seedArchivedThread(view);

  let finished!: Promise<void>;
  act(() => {
    finished = view.result.current.deleteThread(created);
  });
  expect(view.result.current.threads.some((thread) => thread.id === created)).toBe(true);

  await act(async () => {
    confirm({ status: "deleted", id: created });
    await finished;
  });
  expect(view.result.current.threads.some((thread) => thread.id === created)).toBe(false);
});

test("a chat the server no longer has still leaves the list", async () => {
  const data = structuredClone(sampleData);
  const view = renderHook(() => useChatStore(data.me.id, data));
  vi.spyOn(api, "deleteChatThread").mockRejectedValue(new api.ChatRequestError("Chat thread not found.", 404));
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_userId, thread) => thread);
  const created = await seedArchivedThread(view);

  await act(async () => {
    await view.result.current.deleteThread(created);
  });

  expect(view.result.current.threads.some((thread) => thread.id === created)).toBe(false);
});

test("deleting the open chat lands on a blank one, and a blank chat needs no server", async () => {
  const data = structuredClone(sampleData);
  const view = renderHook(() => useChatStore(data.me.id, data));
  const remove = vi.spyOn(api, "deleteChatThread").mockResolvedValue({ status: "deleted", id: "x" });
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_userId, thread) => thread);
  let created = "";
  await act(async () => {
    created = view.result.current.sendMessageInNewThread("The open chat")?.id ?? "";
  });
  expect(view.result.current.activeThread?.id).toBe(created);

  await act(async () => {
    await view.result.current.deleteThread(created);
  });

  expect(view.result.current.activeThread?.id).not.toBe(created);
  expect(view.result.current.threads.map((thread) => thread.id)).toContain(view.result.current.activeThread?.id);
  expect(remove).toHaveBeenCalledTimes(1);

  const blank = view.result.current.activeThread?.id ?? "";
  await act(async () => {
    await view.result.current.deleteThread(blank);
  });
  expect(remove).toHaveBeenCalledTimes(1);
});

test("filing a stored chat under a matter shows at once and links it without resaving the chat", async () => {
  const data = firstUseData();
  vi.spyOn(api, "listChatThreads").mockResolvedValue([readThread()]);
  const save = vi.spyOn(api, "saveChatThread");
  let finishLink!: () => void;
  const change = vi.spyOn(api, "changeResourceMatter").mockImplementation(
    () => new Promise<void>((resolve) => { finishLink = resolve; }),
  );
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});

  let linked!: Promise<void>;
  act(() => { linked = view.result.current.setThreadMatter("thread-read-sync", "matter-a"); });
  const chosen = view.result.current.threads.find((thread) => thread.id === "thread-read-sync");
  expect(chosen?.pendingMatterId).toBe("matter-a");
  expect(chosen?.matter_id ?? null).toBeNull();

  await act(async () => {
    await vi.waitFor(() => expect(change).toHaveBeenCalled());
    finishLink();
    await linked;
  });
  const settled = view.result.current.threads.find((thread) => thread.id === "thread-read-sync");
  expect(settled?.matter_id).toBe("matter-a");
  expect(settled?.pendingMatterId).toBeUndefined();
  expect(change).toHaveBeenCalledWith(data.me.id, "chat-threads", "thread-read-sync", null, "matter-a", { tenantSlug: undefined });
  expect(save).not.toHaveBeenCalled();
});

test("a new chat keeps its matter until it is first saved, then links it", async () => {
  const data = firstUseData();
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  const change = vi.spyOn(api, "changeResourceMatter").mockResolvedValue(undefined);
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});
  const blankId = view.result.current.activeId;

  await act(async () => { await view.result.current.setThreadMatter(blankId, "matter-a"); });
  expect(change).not.toHaveBeenCalled();
  expect(view.result.current.activeThread?.pendingMatterId).toBe("matter-a");
});

test("a chat whose first save is still on its way is linked right after that save", async () => {
  const data = firstUseData();
  const unsaved = readThread({ id: "thread-first-save" });
  window.localStorage.setItem(`aperture-chats-v2-${data.me.id}`, JSON.stringify([unsaved]));
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  const change = vi
    .spyOn(api, "changeResourceMatter")
    .mockRejectedValueOnce(new api.ChatRequestError("Unknown private matter resource.", 404))
    .mockResolvedValue(undefined);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, thread) => ({ ...thread, matter_id: null }));
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});

  await act(async () => { await view.result.current.setThreadMatter("thread-first-save", "matter-a"); });
  expect(view.result.current.threads.find((thread) => thread.id === "thread-first-save")?.pendingMatterId).toBe("matter-a");

  await act(async () => { view.result.current.togglePin("thread-first-save"); });
  await act(async () => {});
  const settled = view.result.current.threads.find((thread) => thread.id === "thread-first-save");
  expect(change).toHaveBeenCalledTimes(2);
  expect(settled?.matter_id).toBe("matter-a");
  expect(settled?.pendingMatterId).toBeUndefined();
  expect(settled?.pinned).toBe(true);
});

test("a refused matter change says why and keeps the matter the server has", async () => {
  const data = firstUseData();
  vi.spyOn(api, "listChatThreads").mockResolvedValue([readThread({ matter_id: "matter-a" })]);
  vi.spyOn(api, "changeResourceMatter").mockRejectedValue(
    new api.ChatRequestError("This matter is being deleted and cannot accept assignments.", 409),
  );
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});

  await act(async () => { await view.result.current.setThreadMatter("thread-read-sync", "matter-b"); });
  const thread = view.result.current.threads.find((item) => item.id === "thread-read-sync");
  expect(thread?.matter_id).toBe("matter-a");
  expect(thread?.pendingMatterId).toBeUndefined();
  expect(thread?.matterError).toBe("This matter is being deleted and cannot accept assignments.");
});

test("a chat's own matter bookkeeping is never sent with a save", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await api.saveChatThread("fresh-user", { ...readThread(), pendingMatterId: "matter-a", matterError: "Refused.", syncPending: true });
  const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  expect(body).not.toHaveProperty("pendingMatterId");
  expect(body).not.toHaveProperty("matterError");
  expect(body).not.toHaveProperty("syncPending");
  vi.unstubAllGlobals();
});

test("a save sent before a matter change cannot undo it when its reply arrives late", async () => {
  const data = firstUseData();
  vi.spyOn(api, "listChatThreads").mockResolvedValue([readThread()]);
  let finishSave!: () => void;
  vi.spyOn(api, "saveChatThread").mockImplementation(
    (_user, thread) => new Promise((resolve) => { finishSave = () => resolve({ ...thread, matter_id: null }); }),
  );
  vi.spyOn(api, "changeResourceMatter").mockResolvedValue(undefined);
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});

  act(() => view.result.current.togglePin("thread-read-sync"));
  await act(async () => { await view.result.current.setThreadMatter("thread-read-sync", "matter-a"); });
  await act(async () => { finishSave(); });

  const thread = view.result.current.threads.find((item) => item.id === "thread-read-sync");
  expect(thread?.matter_id).toBe("matter-a");
  expect(thread?.pinned).toBe(true);
});

test("filing a chat that no longer exists changes nothing and asks the server nothing", async () => {
  const data = firstUseData();
  vi.spyOn(api, "listChatThreads").mockResolvedValue([readThread()]);
  const change = vi.spyOn(api, "changeResourceMatter").mockResolvedValue(undefined);
  const view = renderHook(() => useChatStore(data.me.id, data));
  await act(async () => {});
  const before = view.result.current.threads;

  await act(async () => { await view.result.current.setThreadMatter("thread-gone", "matter-a"); });
  expect(change).not.toHaveBeenCalled();
  expect(view.result.current.threads.map((thread) => thread.id)).toEqual(before.map((thread) => thread.id));
  expect(view.result.current.threads.find((thread) => thread.id === "thread-read-sync")?.pendingMatterId).toBeUndefined();
});

/* ------------------------------------------------------------------ */
/* Replies generated by server runs                                    */
/* ------------------------------------------------------------------ */

function runReply(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-run-reply",
    role: "assistant",
    content: "Half an ans",
    createdAt: "2:25 PM",
    status: "pending",
    startedAtMs: 1_000,
    activityTrace: [{ id: "route:model", label: "Routed to GPT-4o mini" }],
    metadata: { runId: "run-1" },
    ...overrides,
  };
}

function runThread(messages: ChatMessage[]): ChatThread {
  return { ...thread([userMessage, ...messages]), id: "thread-run", model_id: "text-model", owner_user_id: "fresh-user" };
}

function storeRunThread(messages: ChatMessage[]) {
  window.localStorage.setItem("aperture-chats-v2-fresh-user", JSON.stringify([runThread(messages)]));
}

const finishedReply = { content: "Half an answer, finished.", citations: [], memoryUsed: 0, memorySaved: [] };

test("a reload waits for the real workspace, then follows the reply's run with the chat's own model", async () => {
  const workspace = firstUseData();
  storeRunThread([runReply()]);
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  const stream = vi.spyOn(api, "sendChatStream").mockResolvedValue(finishedReply);
  const view = renderHook(
    ({ data, ready }: { data: BootstrapData; ready: boolean }) => useChatStore("fresh-user", data, { ready }),
    { initialProps: { data: sampleData, ready: false } },
  );
  await act(async () => {});
  expect(stream).not.toHaveBeenCalled();

  view.rerender({ data: workspace, ready: true });
  await act(async () => {});

  expect(stream).toHaveBeenCalledTimes(1);
  const [, options] = stream.mock.calls[0];
  expect(options).toMatchObject({ model: "text-model", runId: "run-1", attach: true, initialText: "Half an ans" });
  const reply = view.result.current.threads.find((item) => item.id === "thread-run")?.messages[1];
  expect(reply?.status).toBe("ok");
  expect(reply?.content).toBe("Half an answer, finished.");
});

test.each([
  ["no metadata at all", undefined],
  ["an empty run id", { runId: "" }],
  ["a run id that is not text", { runId: 7 }],
])("a pending reply saved before replies had runs (%s) is continued under a new run", async (_label, metadata) => {
  storeRunThread([runReply({ metadata })]);
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  const stream = vi.spyOn(api, "sendChatStream").mockReturnValue(new Promise(() => {}));
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});

  const [, options] = stream.mock.calls[0];
  expect(options.attach).toBe(false);
  expect(options.runId).toMatch(/^run-/);
  const reply = view.result.current.threads.find((item) => item.id === "thread-run")?.messages[1];
  expect(reply?.metadata?.runId).toBe(options.runId);
});

test("a new reply runs on the server under the run id its bubble records", async () => {
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  const stream = vi.spyOn(api, "sendChatStream").mockReturnValue(new Promise(() => {}));
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});

  await act(async () => {
    view.result.current.sendMessage("Hello");
  });
  await act(async () => {});

  const [, options] = stream.mock.calls[0];
  expect(options.runId).toMatch(/^run-/);
  expect(options.attach).toBeFalsy();
  const pending = view.result.current.activeThread?.messages.at(-1);
  expect(pending?.status).toBe("pending");
  expect(pending?.metadata?.runId).toBe(options.runId);
});

test("a reply that continues under a new run records it for the next reload", async () => {
  storeRunThread([runReply()]);
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  vi.spyOn(api, "sendChatStream").mockImplementation(async (_user, options) => {
    options.onRun?.("run-2");
    return new Promise(() => {});
  });
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});

  const reply = view.result.current.threads.find((item) => item.id === "thread-run")?.messages[1];
  expect(reply?.metadata?.runId).toBe("run-2");
});

test("following a run again rebuilds the trace from its snapshot instead of repeating steps", async () => {
  storeRunThread([
    runReply({
      activityTrace: [
        { id: "route:model", label: "Routed to GPT-4o mini" },
        { id: "continue:r1", label: "Reached the output limit and kept writing", detail: "Continuation 1" },
      ],
    }),
  ]);
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  vi.spyOn(api, "sendChatStream").mockImplementation(async (_user, options) => {
    options.onSnapshot?.();
    options.onActivity?.({ kind: "continue", round: 1 });
    return new Promise(() => {});
  });
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});

  const reply = view.result.current.threads.find((item) => item.id === "thread-run")?.messages[1];
  expect(reply?.activityTrace?.map((step) => step.id)).toEqual(["route:model", "continue:r1"]);
});

test("stopping a reply asks the server to stop its run", async () => {
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  const cancel = vi.spyOn(api, "cancelChatRun").mockResolvedValue({ id: "run", status: "stopping" });
  const stream = vi.spyOn(api, "sendChatStream").mockReturnValue(new Promise(() => {}));
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});
  await act(async () => {
    view.result.current.sendMessage("Hello");
  });
  await act(async () => {});

  act(() => {
    view.result.current.stopResponse();
  });

  const [, options] = stream.mock.calls[0];
  expect(cancel).toHaveBeenCalledWith("fresh-user", options.runId);
});

test("a server copy that finished the same run wins over the local pending bubble, even as a failure", () => {
  const failed = runReply({ status: "error", content: "Half an answer", metadata: { runId: "run-1", failureNotice: "timeout" } });

  const merged = preservePendingTraceState(runThread([runReply()]), runThread([failed]));

  expect(merged.messages[1].status).toBe("error");
});

test("a server copy finished by an older run never replaces a newer attempt in flight", () => {
  const olderRun = runReply({ status: "ok", content: "Old answer", metadata: { runId: "run-1" } });
  const newerAttempt = runReply({ metadata: { runId: "run-2" } });

  const merged = preservePendingTraceState(runThread([newerAttempt]), runThread([olderRun]));

  expect(merged.messages[1].status).toBe("pending");
  expect(merged.messages[1].metadata?.runId).toBe("run-2");
});

test("a reply the server finished while the page was closed arrives with a finished trace", async () => {
  const settled = runReply({
    status: "ok",
    content: "Hello world, finished on the server.",
    durationMs: 3_000,
    metadata: { runId: "run-1", serverSettled: { activities: [{ kind: "web", results: 2, engine: "searxng" }] } },
  });
  vi.spyOn(api, "listChatThreads").mockResolvedValue([runThread([settled])]);
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});

  const reply = view.result.current.threads.find((item) => item.id === "thread-run")?.messages[1];
  const steps = reply?.activityTrace?.map((step) => step.id) ?? [];
  expect(steps[0]).toBe("route:model");
  expect(steps).toContain("web:search");
  expect(steps.at(-1)).toBe("done:reply");
  expect(reply?.metadata?.serverSettled).toBeUndefined();
});

test("a regenerated version the server finished arrives with a finished trace of its own", async () => {
  const versions: ChatResponseVersion[] = [
    { id: "v1", label: "Version 1", content: "First answer", status: "ok", activityTrace: [{ id: "done:reply", label: "Delivered the reply" }] },
    {
      id: "v2",
      label: "Version 2",
      content: "Second answer, finished on the server.",
      status: "ok",
      startedAtMs: 1_000,
      durationMs: 2_000,
      activityTrace: [{ id: "route:model", label: "Routed to GPT-4o mini" }],
      metadata: { runId: "run-2", serverSettled: { activities: [] } },
    },
  ];
  const message = runReply({
    status: "ok",
    content: "Second answer, finished on the server.",
    metadata: { runId: "run-1", responseVersions: versions, activeResponseVersionIndex: 1, activeResponseVersionId: "v2" },
  });
  vi.spyOn(api, "listChatThreads").mockResolvedValue([runThread([message])]);
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});

  const reply = view.result.current.threads.find((item) => item.id === "thread-run")?.messages[1];
  const stored = reply?.metadata?.responseVersions as ChatResponseVersion[];
  expect(stored[0]).toEqual(versions[0]);
  expect(stored[1].activityTrace?.at(-1)?.id).toBe("done:reply");
  expect(stored[1].metadata?.serverSettled).toBeUndefined();
  expect(reply?.activityTrace?.at(-1)?.id).toBe("done:reply");
});


test("a server copy whose older versions carry no metadata still decides by the run", () => {
  const versions: ChatResponseVersion[] = [
    { id: "v1", label: "Version 1", content: "First answer", status: "ok" },
    { id: "v2", label: "Version 2", content: "Second answer", status: "ok", metadata: { runId: "run-2" } },
  ];
  const server = runReply({
    status: "ok",
    content: "Second answer",
    metadata: { responseVersions: versions, activeResponseVersionIndex: 1, activeResponseVersionId: "v2" },
  });
  const localVersions: ChatResponseVersion[] = [versions[0], { ...versions[1], status: "pending", content: "Sec" }];
  const local = runReply({
    content: "Sec",
    metadata: { responseVersions: localVersions, activeResponseVersionIndex: 1, activeResponseVersionId: "v2" },
  });

  const merged = preservePendingTraceState(runThread([local]), runThread([server]));

  expect(merged.messages[1].content).toBe("Second answer");
});

async function loadedReply(message: ChatMessage): Promise<ChatMessage | undefined> {
  vi.spyOn(api, "listChatThreads").mockResolvedValue([runThread([message])]);
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data, { ready: false }));
  await act(async () => {});
  return view.result.current.threads.find((item) => item.id === "thread-run")?.messages[1];
}

test("a reply the browser finished loads exactly as stored", async () => {
  const finishedHere = runReply({
    status: "ok",
    content: "Done here.",
    activityTrace: [
      { id: "route:model", label: "Routed to GPT-4o mini" },
      { id: "think:first-token", label: "Thought for 2s" },
      { id: "done:reply", label: "Delivered the reply" },
    ],
  });
  const versions: ChatResponseVersion[] = [
    { id: "v1", label: "Version 1", content: "First", status: "ok", metadata: { runId: "run-1" } },
    { id: "v2", label: "Version 2", content: "Second", status: "ok", metadata: { runId: "run-2" } },
  ];
  const regenerated = runReply({
    status: "ok",
    content: "Second",
    metadata: { runId: "run-1", responseVersions: versions, activeResponseVersionIndex: 1, activeResponseVersionId: "v2" },
  });

  expect(await loadedReply(finishedHere)).toStrictEqual(finishedHere);
  vi.restoreAllMocks();
  expect(await loadedReply(regenerated)).toStrictEqual(regenerated);
});

test.each([
  ["a malformed server record", { status: "ok" as const, metadata: { runId: "run-1", serverSettled: "yes" } }],
  ["a reply still pending", { status: "pending" as const, metadata: { runId: "run-1", serverSettled: { activities: [] } } }],
])("%s is not treated as finished on the server", async (_label, overrides) => {
  const message = runReply(overrides);

  const loaded = await loadedReply(message);

  expect(loaded?.activityTrace).toEqual(message.activityTrace);
  expect(loaded?.metadata?.serverSettled).toEqual(message.metadata?.serverSettled);
});

test("a server-finished reply's trace says how long the run took when the page never saw the first words", async () => {
  const loaded = await loadedReply(
    runReply({ status: "ok", content: "Hello.", durationMs: 2_500, metadata: { runId: "run-1", serverSettled: { activities: [] } } }),
  );

  expect(loaded?.activityTrace?.find((step) => step.id === "think:first-token")?.label).toBe("Thought for 3s");
});

test("a server-finished failure keeps its partial text's steps only when it has a notice", async () => {
  const withNotice = await loadedReply(
    runReply({
      status: "error",
      content: "Half an answer.",
      durationMs: 2_000,
      metadata: { runId: "run-1", failureNotice: "timeout", serverSettled: { activities: [] } },
    }),
  );
  vi.restoreAllMocks();
  const withoutNotice = await loadedReply(
    runReply({ status: "error", content: "Usage budget exhausted.", metadata: { runId: "run-1", serverSettled: { activities: [] } } }),
  );

  expect(withNotice?.activityTrace?.map((step) => step.id)).toContain("think:first-token");
  expect(withNotice?.metadata?.failureNotice).toBe("timeout");
  expect(withoutNotice?.activityTrace?.map((step) => step.id)).toEqual(["route:model"]);
});

test("a message with a single stored version settles that version", async () => {
  const only: ChatResponseVersion = {
    id: "v1",
    label: "Version 1",
    content: "Only answer.",
    status: "ok",
    durationMs: 1_000,
    activityTrace: [{ id: "route:model", label: "Routed to GPT-4o mini" }],
    metadata: { runId: "run-1", serverSettled: { activities: [] } },
  };
  const loaded = await loadedReply(
    runReply({ status: "ok", content: "Only answer.", metadata: { responseVersions: [only], activeResponseVersionIndex: 0, activeResponseVersionId: "v1" } }),
  );

  const stored = loaded?.metadata?.responseVersions as ChatResponseVersion[];
  expect(stored[0].activityTrace?.at(-1)?.id).toBe("done:reply");
});

test("a reply with an empty version list streams as a plain reply", () => {
  const message = runReply({ metadata: { runId: "run-1", responseVersions: [] } });

  const next = withStreamedPendingContent(message, "Hello", 2_000);

  expect(next.content).toBe("Hello");
  expect(next.metadata?.responseVersions).toEqual([]);
});

test("a server copy that wins over the local bubble arrives with its trace settled and the server's record gone", () => {
  const settledOnServer = runReply({
    status: "ok",
    content: "Finished on the server.",
    durationMs: 2_000,
    metadata: { runId: "run-1", serverSettled: { activities: [{ kind: "web", results: 2, engine: "searxng" }] } },
  });
  const earlierSettled = { ...settledOnServer, id: "msg-earlier" };

  const merged = preservePendingTraceState(runThread([runReply()]), runThread([settledOnServer]));
  const untouched = preservePendingTraceState(runThread([]), runThread([earlierSettled]));

  for (const reply of [merged.messages[1], untouched.messages[1]]) {
    expect(reply.metadata?.serverSettled).toBeUndefined();
    expect(reply.activityTrace?.map((step) => step.id)).toContain("web:search");
    expect(reply.activityTrace?.at(-1)?.id).toBe("done:reply");
  }
});

/* ------------------------------------------------------------------ */
/* Clarifying questions                                                */
/* ------------------------------------------------------------------ */

const askedQuestions = {
  intro: "One question first.",
  questions: [
    { id: "q1", question: "Which state?", options: [{ label: "California" }, { label: "New York" }], multiple: false, recommended: 0 },
  ],
};
const pausedReply = { content: "", questions: askedQuestions, citations: [], memoryUsed: 0, memorySaved: [] };
const askedTurn = { role: "assistant", content: "One question first.\n\nI paused to ask:\n1. Which state? (California / New York)" };

async function pausedChat({ askBeforeDraw = false } = {}) {
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  const saves = vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  const stream = vi.spyOn(api, "sendChatStream").mockImplementationOnce(async (_user, options) => {
    // A stream usually reports activity after the page has drawn the new
    // reply, but a fast one (or a busy page) can report it first.
    if (!askBeforeDraw) await new Promise((resolve) => setTimeout(resolve, 0));
    options.onActivity?.({ kind: "ask", questions: 1 });
    return pausedReply;
  });
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});
  await act(async () => {
    view.result.current.sendMessage("Draft the clause", [], { clarifyMode: "ask" });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const reply = () => view.result.current.activeThread!.messages.at(-1)!;
  return { view, stream, saves, reply };
}

test("a reply that pauses to ask waits on its questions instead of finishing", async () => {
  const { stream, reply } = await pausedChat();

  expect(stream.mock.calls[0][1].runtime?.clarifyMode).toBe("ask");
  expect(reply().status).toBe("ok");
  expect(reply().content).toBe("");
  expect(reply().metadata?.clarify).toMatchObject({ state: "waiting", ...askedQuestions, waitedMs: 0 });
  expect(reply().metadata?.chatRuntime).toMatchObject({ clarifyMode: "ask" });
  const steps = reply().activityTrace?.map((step) => step.id) ?? [];
  expect(steps).toContain("ask:questions");
  expect(steps).not.toContain("done:reply");
});

test("questions reported before the page draws the new reply still show in its trace", async () => {
  const { reply } = await pausedChat({ askBeforeDraw: true });

  expect(reply().metadata?.clarify).toMatchObject({ state: "waiting" });
  const steps = reply().activityTrace?.map((step) => step.id) ?? [];
  expect(steps).toContain("ask:questions");
  expect(steps).not.toContain("done:reply");
});

test("answering continues the same reply under a new run, with the answers in the conversation", async () => {
  const { view, stream, reply } = await pausedChat();
  stream.mockResolvedValueOnce({ ...finishedReply, content: "Here is the clause under California law." });
  const pausedId = reply().id;
  const firstRun = reply().metadata?.runId;

  let accepted = false;
  await act(async () => {
    accepted = view.result.current.answerQuestions(pausedId, {
      kind: "answers",
      answers: [{ questionId: "q1", choices: ["California"], other: "" }],
    });
  });
  await act(async () => {});

  expect(accepted).toBe(true);
  const [, options] = stream.mock.calls[1];
  expect(options.messages.slice(-3)).toEqual([
    { role: "user", content: "Draft the clause" },
    askedTurn,
    { role: "user", content: "My answers:\n1. Which state? California\n\nContinue with these answers." },
  ]);
  expect(options.runtime?.clarifyMode).toBe("answered");
  expect(options.attach).toBe(false);
  expect(options.runId).toMatch(/^run-/);
  expect(options.runId).not.toBe(firstRun);
  expect(reply().id).toBe(pausedId);
  expect(reply().status).toBe("ok");
  expect(reply().content).toBe("Here is the clause under California law.");
  expect(reply().metadata?.clarify).toMatchObject({ state: "answered" });
  const steps = reply().activityTrace?.map((step) => step.id) ?? [];
  expect(steps.indexOf("ask:questions")).toBeLessThan(steps.indexOf("answer:reply"));
  expect(steps.at(-1)).toBe("done:reply");
});

test("letting the assistant decide continues with that request, and a reply can be answered only once", async () => {
  const { view, stream, reply } = await pausedChat();
  stream.mockReturnValueOnce(new Promise(() => {}));

  let first = false;
  let second = true;
  await act(async () => {
    first = view.result.current.answerQuestions(reply().id, { kind: "decide" });
  });
  await act(async () => {
    second = view.result.current.answerQuestions(reply().id, { kind: "decide" });
  });

  expect(first).toBe(true);
  expect(second).toBe(false);
  expect(stream).toHaveBeenCalledTimes(2);
  expect(stream.mock.calls[1][1].messages.at(-1)?.content).toMatch(/^Make these choices yourself/);
  expect(reply().status).toBe("pending");
  expect(reply().metadata?.clarify).toMatchObject({ state: "delegated" });
});

test("later turns carry the questions and the answers that shaped the reply", async () => {
  const { view, stream, reply } = await pausedChat();
  stream.mockResolvedValueOnce({ ...finishedReply, content: "Clause drafted." });
  await act(async () => {
    view.result.current.answerQuestions(reply().id, { kind: "answers", answers: [{ questionId: "q1", choices: ["New York"], other: "" }] });
  });
  await act(async () => {});
  stream.mockReturnValueOnce(new Promise(() => {}));

  await act(async () => {
    view.result.current.sendMessage("Now shorten it");
  });

  expect(stream.mock.calls[2][1].messages.slice(-5)).toEqual([
    { role: "user", content: "Draft the clause" },
    askedTurn,
    { role: "user", content: "My answers:\n1. Which state? New York\n\nContinue with these answers." },
    { role: "assistant", content: "Clause drafted." },
    { role: "user", content: "Now shorten it" },
  ]);
});

test("replying in the composer instead leaves the questions in the conversation", async () => {
  const { view, stream } = await pausedChat();
  stream.mockReturnValueOnce(new Promise(() => {}));

  await act(async () => {
    view.result.current.sendMessage("Use Texas law");
  });

  expect(stream.mock.calls[1][1].messages.slice(-3)).toEqual([
    { role: "user", content: "Draft the clause" },
    askedTurn,
    { role: "user", content: "Use Texas law" },
  ]);
});

test("a reply the server paused while the page was closed loads waiting, with its trace unfinished", async () => {
  const paused = runReply({
    status: "ok",
    content: "",
    durationMs: 4_000,
    metadata: {
      runId: "run-1",
      clarify: { state: "waiting", ...askedQuestions, pausedAt: "2026-11-08T15:00:00Z" },
      serverSettled: { activities: [{ kind: "ask", questions: 1 }] },
    },
  });
  vi.spyOn(api, "listChatThreads").mockResolvedValue([runThread([paused])]);
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});

  const reply = view.result.current.threads.find((item) => item.id === "thread-run")?.messages[1];
  const steps = reply?.activityTrace?.map((step) => step.id) ?? [];
  expect(steps).toEqual(["route:model", "ask:questions"]);
  expect(reply?.metadata?.clarify).toMatchObject({ state: "waiting" });
});

test("a reload while the answered reply runs follows it with the answers still in the conversation", async () => {
  const answered = runReply({
    content: "",
    metadata: {
      runId: "run-2",
      clarify: { state: "answered", ...askedQuestions, answers: [{ questionId: "q1", choices: ["California"], other: "" }], waitedMs: 5 },
    },
  });
  storeRunThread([answered]);
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  const stream = vi.spyOn(api, "sendChatStream").mockReturnValue(new Promise(() => {}));
  const data = firstUseData();
  renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});

  const [, options] = stream.mock.calls[0];
  expect(options).toMatchObject({ runId: "run-2", attach: true });
  expect(options.runtime?.clarifyMode).toBe("answered");
  expect(options.messages.slice(-2)).toEqual([
    { role: "assistant", content: "One question first.\n\nI paused to ask:\n1. Which state? (California / New York)" },
    { role: "user", content: "My answers:\n1. Which state? California\n\nContinue with these answers." },
  ]);
});

test.each([
  ["ask", "ask"],
  ["decide", "decide"],
  ["answered", undefined],
] as const)("a reply remembers clarify mode %s as %s for regenerating it", async (mode, remembered) => {
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  vi.spyOn(api, "sendChatStream").mockReturnValue(new Promise(() => {}));
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});

  await act(async () => {
    view.result.current.sendMessage("Hello", [], { clarifyMode: mode, webEnabled: false });
  });

  const runtime = view.result.current.activeThread?.messages.at(-1)?.metadata?.chatRuntime as Record<string, unknown>;
  expect(runtime.clarifyMode).toBe(remembered);
});

test("only a waiting reply in the open chat can be answered, and not while another reply runs", async () => {
  const { view, stream, reply } = await pausedChat();
  const pausedId = reply().id;
  const userId = view.result.current.activeThread!.messages[0].id;
  stream.mockReturnValue(new Promise(() => {}));

  expect(view.result.current.answerQuestions("msg-missing", { kind: "decide" })).toBe(false);
  expect(view.result.current.answerQuestions(userId, { kind: "decide" })).toBe(false);
  await act(async () => {
    view.result.current.sendMessage("Use Texas law instead");
  });
  let accepted = true;
  await act(async () => {
    accepted = view.result.current.answerQuestions(pausedId, { kind: "decide" });
  });

  expect(accepted).toBe(false);
  expect(stream).toHaveBeenCalledTimes(2);
  expect(view.result.current.activeThread!.messages.find((message) => message.id === pausedId)?.status).toBe("ok");
});

test("time spent waiting on the user moves the reply's start forward instead of counting as work", async () => {
  const { view, stream, reply } = await pausedChat();
  stream.mockReturnValueOnce(new Promise(() => {}));
  const startedAtMs = reply().startedAtMs!;
  const pausedAtMs = Date.parse(String((reply().metadata?.clarify as { pausedAt: string }).pausedAt));
  const now = vi.spyOn(Date, "now").mockReturnValue(pausedAtMs + 60_000);

  await act(async () => {
    view.result.current.answerQuestions(reply().id, { kind: "decide" });
  });
  now.mockRestore();

  expect(reply().startedAtMs).toBe(startedAtMs + 60_000);
  expect(reply().metadata?.clarify).toMatchObject({ state: "delegated", waitedMs: 60_000 });
});

test("a reply that never paused has nothing to answer", async () => {
  vi.spyOn(api, "listChatThreads").mockResolvedValue([]);
  vi.spyOn(api, "saveChatThread").mockImplementation(async (_user, saved) => saved);
  const stream = vi.spyOn(api, "sendChatStream").mockResolvedValue(finishedReply);
  const data = firstUseData();
  const view = renderHook(() => useChatStore("fresh-user", data));
  await act(async () => {});
  await act(async () => {
    view.result.current.sendMessage("Hello");
  });
  await act(async () => {});
  const answered = view.result.current.activeThread!.messages.at(-1)!;

  expect(answered.status).toBe("ok");
  expect(view.result.current.answerQuestions(answered.id, { kind: "decide" })).toBe(false);
  expect(stream).toHaveBeenCalledTimes(1);
});
