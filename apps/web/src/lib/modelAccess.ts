import type { BootstrapData, ModelConfig } from "./types";

function providerForModel(data: BootstrapData, model: ModelConfig) {
  return data.providers.find((provider) => provider.id === model.provider_id);
}

function userCanAccessModel(data: BootstrapData, model: ModelConfig) {
  if (!model.platform_enabled) return false;
  if (data.me.role === "PLATFORM_OWNER") return true;
  return model.group_ids.some((groupId) => data.me.group_ids.includes(groupId));
}

export function isModelUsable(data: BootstrapData, model: ModelConfig) {
  return Boolean(providerForModel(data, model)?.connected) && userCanAccessModel(data, model);
}

export function usableModels(data: BootstrapData) {
  return data.models.filter((model) => isModelUsable(data, model));
}

export function approvedWorkspaceModels(data: BootstrapData) {
  return data.models.filter((model) => {
    if (!providerForModel(data, model)?.connected) return false;
    if (!model.platform_enabled) return false;
    if (data.me.role === "PLATFORM_OWNER") return true;
    return model.group_ids.some((groupId) => data.me.group_ids.includes(groupId));
  });
}

export function isAgentProfile(model: ModelConfig) {
  if (model.agentic_companion) return true;
  return Boolean(
    model.is_custom &&
      (model.created_by ||
        model.meta_prompt ||
        model.knowledge_config_ids?.length ||
        model.tool_config_ids?.length ||
        model.prompt_template_ids?.length ||
        model.skill_file_ids?.length),
  );
}

export function agentProfileVisibleToUser(data: BootstrapData, model: ModelConfig) {
  if (!isAgentProfile(model)) return false;
  if (data.me.role === "PLATFORM_OWNER" || data.me.role === "TENANT_ADMIN") return true;
  if (data.me.active && data.me.group_ids.length === 0) return false;
  const visibility = model.visibility ?? "tenant";
  if (visibility === "organization" || visibility === "tenant") return Boolean(data.me.tenant_id || data.currentTenant.id);
  if (visibility === "private") return agentProfileCreatorMatches(data, model);
  return model.group_ids.some((groupId) => data.me.group_ids.includes(groupId));
}

export function visibleAgentProfiles(data: BootstrapData) {
  return data.models.filter((model) => agentProfileVisibleToUser(data, model));
}

export function agentProfileCreatorMatches(data: BootstrapData, model: ModelConfig | null) {
  const createdBy = model?.created_by?.trim().toLowerCase();
  if (!createdBy) return false;
  return [data.me.id, data.me.email, data.me.display_name].some(
    (value) => value.trim().toLowerCase() === createdBy,
  );
}

/**
 * Models with controllable reasoning depth. Provider-reported capability
 * metadata (captured at model sync, e.g. OpenRouter supported_parameters) is
 * authoritative when present — it covers every vendor, including families the
 * heuristics below never will. Without capability data, fall back to known
 * families: OpenAI o-series (o1/o3/o4) and the GPT-5 family, Claude Opus
 * 4.5+ / Sonnet 4.6+ / the Claude 5 family, and xAI Grok 4.3+, 4.5, and
 * 4.20 Multi-Agent (Grok 4.20 base and Grok Build expose reasoning but no
 * effort control). The composer's Fast–Smart slider only activates for
 * supported models; the API gateway enforces the same gate before forwarding
 * the parameter upstream, so non-reasoning models never receive a parameter
 * they would reject.
 */
export function supportsReasoningEffort(
  model: Pick<ModelConfig, "id" | "name" | "upstream_model_id" | "capabilities"> | undefined,
): boolean {
  if (!model) return false;
  const supportedParameters = model.capabilities?.supported_parameters ?? [];
  if (supportedParameters.length > 0) return supportedParameters.includes("reasoning_effort");
  const route = `${model.id} ${model.name} ${model.upstream_model_id ?? ""}`.toLowerCase();
  if (/(?:^|[^a-z0-9])o[134](?:[^a-z0-9]|$)/.test(route)) return true;
  if (route.includes("gpt-5") || route.includes("gpt-oss")) return true;
  if (/grok-4[.-](?:[3-9](?:[^0-9]|$)|20-multi-agent)/.test(route)) return true;
  return /claude-(?:opus-4[.-][5-9]|sonnet-4[.-][6-9]|(?:opus|sonnet|fable|mythos)-5)/.test(route);
}

const MODEL_LAB_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "x-ai": "xAI",
  xai: "xAI",
  "meta-llama": "Meta",
  meta: "Meta",
  mistralai: "Mistral",
  mistral: "Mistral",
  qwen: "Qwen",
  deepseek: "DeepSeek",
  cohere: "Cohere",
  nvidia: "NVIDIA",
  microsoft: "Microsoft",
  amazon: "Amazon",
  perplexity: "Perplexity",
  moonshotai: "Moonshot",
  minimax: "MiniMax",
  "z-ai": "Z.ai",
  bytedance: "ByteDance",
  baidu: "Baidu",
  ai21: "AI21",
  inflection: "Inflection",
};

/**
 * Human label for the lab behind a model, derived from the upstream route
 * namespace ("openai/gpt-5.5" → OpenAI) with the display-name prefix
 * ("xAI: Grok 4.5") as fallback. Unknown namespaces title-case their slug so
 * new labs group correctly without a code change; models with neither signal
 * land in "Other".
 */
export function modelLabLabel(model: Pick<ModelConfig, "name" | "upstream_model_id">): string {
  const upstream = (model.upstream_model_id ?? "").trim();
  if (upstream.includes("/")) {
    const namespace = upstream.split("/", 1)[0]!.toLowerCase();
    if (MODEL_LAB_LABELS[namespace]) return MODEL_LAB_LABELS[namespace];
    if (namespace) {
      return namespace
        .split("-")
        .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
        .join(" ");
    }
  }
  const namePrefix = model.name.split(":", 1)[0]!.trim();
  if (namePrefix && namePrefix !== model.name.trim()) {
    const known = MODEL_LAB_LABELS[namePrefix.toLowerCase()];
    return known ?? namePrefix;
  }
  return "Other";
}

/**
 * Vendor-neutral ordering used only to pick a sensible first-run default
 * model when the user has not chosen one. Current flagship generations from
 * every major vendor share the top tier; "mini"/"lite"/"nano" variants sink.
 * The reported context window breaks ties so bigger workhorse models win
 * within a tier without favoring any one provider.
 */
export function modelCapabilityRank(model: ModelConfig) {
  const route = `${model.id} ${model.name} ${model.upstream_model_id ?? ""}`.toLowerCase();
  const small = /mini|lite|nano|tiny|micro/.test(route);
  const flagship =
    /gpt-5|claude-(?:opus|sonnet|fable|mythos)|opus-4|sonnet-4|grok-[4-9]|gemini-[3-9]|gemini-2[.-]5-pro|deepseek-(?:v[3-9]|r[1-9])|llama-[4-9]|qwen[3-9]/.test(
      route,
    );
  const base = small ? 25 : flagship ? 90 : 50;
  // Context window as a bounded tiebreaker (0–9) inside a tier.
  const contextBonus = Math.min(9, Math.floor((model.context_window ?? 0) / 250_000));
  return base + contextBonus;
}

/** Candidates for an automatic text-workflow default. Image-output models
 * remain selectable, but should not win a fresh chat or draft when another
 * usable model exists. Missing metadata stays eligible; input image support
 * does not imply image generation. */
export function modelsForTextDefault(models: ModelConfig[]) {
  const nonImageModels = models.filter((model) => !model.capabilities?.output_modalities?.includes("image"));
  return nonImageModels.length > 0 ? nonImageModels : models;
}

export function preferredModel(models: ModelConfig[]) {
  return [...modelsForTextDefault(models)].sort((first, second) => modelCapabilityRank(second) - modelCapabilityRank(first))[0] ?? null;
}

/**
 * Web search works with every provider: OpenRouter-backed models use
 * OpenRouter's built-in web search server tool (native provider search where
 * the model family supports it), and all other providers get results from
 * the platform-hosted search engine (SearXNG, DuckDuckGo, or provider-hosted
 * OpenAI/Anthropic search) injected as context by the API. Governance:
 * - The Web Search connector (Platform → Org Settings → Connectors) is the
 *   deployment-wide on/off switch; the API enforces it too.
 * - A `tool-web-search` tool config can additionally restrict web search to
 *   specific models; when absent, it is available everywhere.
 */
export function webSearchSupportedForModel(
  data: Pick<BootstrapData, "tools" | "connectors">,
  model: Pick<ModelConfig, "id" | "provider_id" | "provider_name" | "upstream_model_id"> | undefined,
): boolean {
  if (!model) return false;
  const webConnector = data.connectors.find((connector) => connector.id === "web");
  if (webConnector && (!webConnector.platform_enabled || !webConnector.tenant_enabled)) return false;
  const webSearchTool = data.tools.find((tool) => tool.id === "tool-web-search");
  if (!webSearchTool) return true;
  if (!webSearchTool.enabled || webSearchTool.status !== "ready") return false;
  const connectedModelIds = webSearchTool.connected_model_ids ?? [];
  return (
    connectedModelIds.length === 0 ||
    connectedModelIds.includes(model.id) ||
    (model.upstream_model_id ? connectedModelIds.includes(model.upstream_model_id) : false)
  );
}
