import { expect, test } from "vitest";
import {
  preservePendingTraceState,
  resumablePendingAssistant,
  targetModelForRequest,
  type ChatResponseVersion,
} from "./chatStore";
import type { ChatMessage, ChatThread, ModelConfig } from "./types";

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
