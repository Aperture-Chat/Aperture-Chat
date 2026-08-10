import { expect, test } from "vitest";
import { settleInterruptedThread, targetModelForRequest, type ChatResponseVersion } from "./chatStore";
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

test("settles a stored pending assistant message into an honest interrupted error", () => {
  const pending: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "",
    createdAt: "2:25 PM",
    status: "pending",
    startedAtMs: 1000,
  };
  const settled = settleInterruptedThread(thread([userMessage, pending]));
  const assistant = settled.messages[1];
  expect(assistant.status).toBe("error");
  expect(assistant.content).toContain("interrupted");
  expect(assistant.content).toContain("Regenerate or resend");
});

test("settles pending response versions without touching completed ones", () => {
  const versions: ChatResponseVersion[] = [
    { id: "v1", label: "Version 1", content: "Finished draft", status: "ok" },
    { id: "v2", label: "Version 2", content: "", status: "pending" },
  ];
  const message: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "",
    createdAt: "2:25 PM",
    status: "pending",
    metadata: { responseVersions: versions, activeResponseVersionIndex: 1 },
  };
  const settled = settleInterruptedThread(thread([userMessage, message]));
  const assistant = settled.messages[1];
  expect(assistant.status).toBe("error");
  const settledVersions = assistant.metadata?.responseVersions as ChatResponseVersion[];
  expect(settledVersions[0]).toEqual(versions[0]);
  expect(settledVersions[1].status).toBe("error");
  expect(settledVersions[1].content).toContain("interrupted");
});

test("leaves threads without pending messages untouched (same reference)", () => {
  const done: ChatMessage = {
    id: "msg-assistant",
    role: "assistant",
    content: "Here is the paper.",
    createdAt: "2:26 PM",
    status: "ok",
  };
  const source = thread([userMessage, done]);
  expect(settleInterruptedThread(source)).toBe(source);
});
