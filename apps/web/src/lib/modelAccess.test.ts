import { expect, test } from "vitest";
import { sampleData } from "../data/sampleData";
import type { BootstrapData, ModelConfig } from "./types";
import {
  agentProfileVisibleToUser,
  approvedWorkspaceModels,
  isModelUsable,
  supportsReasoningEffort,
  usableModels,
  visibleAgentProfiles,
} from "./modelAccess";

const connectedOpenRouterModel = sampleData.models.find((model) => model.id === "openrouter-openai-gpt-4o-mini")!;
const owner = sampleData.users.find((user) => user.id === "user-owner")!;
const regularUser = sampleData.users.find((user) => user.id === "user-jane")!;

function withCatalogOnlyModel(me: BootstrapData["me"]) {
  const catalogOnlyModel: ModelConfig = {
    ...connectedOpenRouterModel,
    id: "openrouter-catalog-only-owner-test",
    name: "OpenRouter: Catalog Only Owner Test",
    upstream_model_id: "meta-llama/llama-3.3-70b-instruct",
    platform_enabled: false,
    group_ids: [],
  };
  return {
    data: {
      ...sampleData,
      me,
      models: [...sampleData.models, catalogOnlyModel],
    },
    catalogOnlyModel,
  };
}

test("platform owners do not see catalog-only provider models in runtime selectors", () => {
  const { data, catalogOnlyModel } = withCatalogOnlyModel(owner);

  expect(isModelUsable(data, catalogOnlyModel)).toBe(false);
  expect(usableModels(data).map((model) => model.id)).not.toContain(catalogOnlyModel.id);
  expect(approvedWorkspaceModels(data).map((model) => model.id)).not.toContain(catalogOnlyModel.id);
});

test("regular users cannot use connected provider catalog models until enabled and granted", () => {
  const { data, catalogOnlyModel } = withCatalogOnlyModel(regularUser);

  expect(isModelUsable(data, catalogOnlyModel)).toBe(false);
  expect(usableModels(data).map((model) => model.id)).not.toContain(catalogOnlyModel.id);
});

test("agent profile visibility keeps owners and admins above user scopes", () => {
  const privateAgent: ModelConfig = {
    ...connectedOpenRouterModel,
    id: "agent-private-casey",
    name: "Casey Private Agent",
    platform_enabled: false,
    is_custom: true,
    created_by: "Casey Doe",
    visibility: "private",
    group_ids: [],
    meta_prompt: "Keep this workspace private to the creator.",
  };
  const groupAgent: ModelConfig = {
    ...privateAgent,
    id: "agent-finance-only",
    name: "Finance Agent",
    created_by: "Alex Morgan",
    visibility: "group",
    group_ids: ["group-finance"],
  };
  const tenantAgent: ModelConfig = {
    ...privateAgent,
    id: "agent-tenant-wide",
    name: "Tenant Wide Agent",
    created_by: "Alex Morgan",
    visibility: "tenant",
  };
  const admin = sampleData.users.find((user) => user.id === "user-admin")!;
  const casey = sampleData.users.find((user) => user.id === "user-casey")!;
  const janeData: BootstrapData = {
    ...sampleData,
    me: regularUser,
    models: [...sampleData.models, privateAgent, groupAgent, tenantAgent],
  };
  const adminData: BootstrapData = { ...janeData, me: admin };
  const caseyData: BootstrapData = { ...janeData, me: casey };

  expect(visibleAgentProfiles(adminData).map((model) => model.id)).toEqual(
    expect.arrayContaining(["agent-private-casey", "agent-finance-only", "agent-tenant-wide"]),
  );
  expect(agentProfileVisibleToUser(janeData, privateAgent)).toBe(false);
  expect(agentProfileVisibleToUser(janeData, groupAgent)).toBe(false);
  expect(agentProfileVisibleToUser(janeData, tenantAgent)).toBe(true);
  expect(agentProfileVisibleToUser(caseyData, privateAgent)).toBe(true);
});

test("modelLabLabel derives the lab from route namespace with name fallback", async () => {
  const { modelLabLabel } = await import("./modelAccess");
  expect(modelLabLabel({ name: "OpenAI: GPT-5.5", upstream_model_id: "openai/gpt-5.5" })).toBe("OpenAI");
  expect(modelLabLabel({ name: "xAI: Grok 4.5", upstream_model_id: "x-ai/grok-4.5" })).toBe("xAI");
  expect(modelLabLabel({ name: "Meta Llama", upstream_model_id: "meta-llama/llama-4-70b" })).toBe("Meta");
  // Unknown namespaces title-case instead of vanishing into "Other".
  expect(modelLabLabel({ name: "New Vendor Model", upstream_model_id: "new-lab/model-1" })).toBe("New Lab");
  // No namespace: the display-name prefix decides.
  expect(modelLabLabel({ name: "Anthropic: Claude Opus 4.8", upstream_model_id: "claude-opus-4-8" })).toBe(
    "Anthropic",
  );
  expect(modelLabLabel({ name: "Hermes Demo Agent", upstream_model_id: undefined })).toBe("Other");
});

test("supportsReasoningEffort activates only for reasoning-capable model families", () => {
  const routeModel = (id: string, name: string, upstream: string | undefined) => ({
    id,
    name,
    upstream_model_id: upstream,
  });

  expect(supportsReasoningEffort(routeModel("openrouter-openai-gpt-5-5", "OpenAI: GPT-5.5", "openai/gpt-5.5"))).toBe(
    true,
  );
  expect(supportsReasoningEffort(routeModel("o3-mini", "o3-mini", "o3-mini"))).toBe(true);
  expect(supportsReasoningEffort(routeModel("openai-o4-mini", "o4 mini", "openai/o4-mini"))).toBe(true);
  expect(
    supportsReasoningEffort(routeModel("claude-sonnet", "Claude Sonnet 4.6", "anthropic/claude-sonnet-4.6")),
  ).toBe(true);
  expect(supportsReasoningEffort(routeModel("claude-opus", "Claude Opus 4.8", "claude-opus-4-8"))).toBe(true);
  expect(supportsReasoningEffort(routeModel("groq-gpt-oss-120b", "GPT OSS 120B", "openai/gpt-oss-120b"))).toBe(true);
  // Grok versions with OpenRouter effort control (per supported_parameters).
  expect(
    supportsReasoningEffort(routeModel("openrouter-x-ai-grok-4-5", "xAI: Grok 4.5", "x-ai/grok-4.5")),
  ).toBe(true);
  expect(
    supportsReasoningEffort(routeModel("openrouter-x-ai-grok-4-3", "xAI: Grok 4.3", "x-ai/grok-4.3")),
  ).toBe(true);
  expect(
    supportsReasoningEffort(
      routeModel("openrouter-x-ai-grok-4-20-multi-agent", "xAI: Grok 4.20 Multi-Agent", "x-ai/grok-4.20-multi-agent"),
    ),
  ).toBe(true);

  expect(supportsReasoningEffort(routeModel("gpt-4o", "GPT-4o", "gpt-4o"))).toBe(false);
  // Grok 4.20 base and Grok Build expose reasoning without effort control.
  expect(
    supportsReasoningEffort(routeModel("openrouter-x-ai-grok-4-20", "xAI: Grok 4.20", "x-ai/grok-4.20")),
  ).toBe(false);
  expect(
    supportsReasoningEffort(routeModel("openrouter-x-ai-grok-build", "xAI: Grok Build 0.1", "x-ai/grok-build-0.1")),
  ).toBe(false);

  // Provider-reported capability metadata is authoritative when present:
  // it enables vendors the heuristics never cover and disables models whose
  // catalog says effort is unsupported, regardless of the name.
  expect(
    supportsReasoningEffort({
      ...routeModel("gemini-flash", "Google: Gemini 3 Flash", "google/gemini-3-flash-preview"),
      capabilities: { supported_parameters: ["reasoning", "reasoning_effort", "tools"] },
    }),
  ).toBe(true);
  expect(
    supportsReasoningEffort({
      ...routeModel("gpt-5-image", "OpenAI: GPT-5 Image", "openai/gpt-5-image"),
      capabilities: { supported_parameters: ["temperature", "tools"] },
    }),
  ).toBe(false);
  expect(
    supportsReasoningEffort(routeModel("openrouter-openai-gpt-4o-mini", "OpenAI: GPT-4o mini", "openai/gpt-4o-mini")),
  ).toBe(false);
  expect(supportsReasoningEffort(routeModel("gpt-4.1", "GPT-4.1", "gpt-4.1"))).toBe(false);
  expect(
    supportsReasoningEffort(routeModel("claude-legacy", "Claude 3.5 Sonnet", "anthropic/claude-3.5-sonnet")),
  ).toBe(false);
  expect(supportsReasoningEffort(undefined)).toBe(false);
});
