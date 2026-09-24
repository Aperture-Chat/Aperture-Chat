import { connectorEnabled, isMcpRuntimeTool } from "./connectors";
import type { BootstrapData, ModelConfig } from "./types";

/**
 * What is wrong with an agent right now, from the viewer's point of view.
 * Each check mirrors how the chat API treats an agent-mode turn
 * (services/api/app/routes/chat.py `_resolve_runtime_context`): a turned-off or
 * unshared tool, prompt template, or skill file, an unshared knowledge base,
 * or a disconnected provider fails the whole request ("blocker"); a turned-off
 * knowledge base is skipped, so the agent answers without it ("warning").
 * Surfacing these before the chat turns a confusing error into a fixable to-do.
 */
export type AgentIssue = {
  kind: "provider" | "knowledge" | "tool" | "template" | "skill" | "connector";
  severity: "blocker" | "warning";
  message: string;
};

export type AgentAttachments = {
  provider_id: string;
  knowledge_config_ids: string[];
  tool_config_ids: string[];
  prompt_template_ids: string[];
  skill_file_ids: string[];
};

export function agentAttachments(agent: ModelConfig): AgentAttachments {
  return {
    provider_id: agent.provider_id,
    knowledge_config_ids: agent.knowledge_config_ids ?? agent.knowledge_base_ids ?? [],
    tool_config_ids: agent.tool_config_ids ?? agent.tool_ids ?? [],
    prompt_template_ids: agent.prompt_template_ids ?? [],
    skill_file_ids: agent.skill_file_ids ?? [],
  };
}

export function agentIssues(attachments: AgentAttachments, data: BootstrapData): AgentIssue[] {
  const issues: AgentIssue[] = [];
  const provider = data.providers.find((item) => item.id === attachments.provider_id);
  // No provider yet means no model is chosen; the model field says so itself.
  if (attachments.provider_id && !provider?.connected) {
    issues.push({
      kind: "provider",
      severity: "blocker",
      message: `${provider?.name ?? "Its AI provider"} is not connected, so the agent cannot answer.`,
    });
  }
  for (const id of unique(attachments.knowledge_config_ids)) {
    const knowledge = data.knowledgeBases.find((item) => item.id === id);
    if (!knowledge) {
      issues.push({ kind: "knowledge", severity: "blocker", message: "A knowledge base it uses was deleted or is not shared with you." });
    } else if (!knowledge.enabled) {
      issues.push({
        kind: "knowledge",
        severity: "warning",
        message: `Knowledge base “${knowledge.name}” is turned off, so the agent answers without it.`,
      });
    }
  }
  let usesMcp = false;
  for (const id of unique(attachments.tool_config_ids)) {
    const tool = data.tools.find((item) => item.id === id);
    if (!tool) {
      issues.push({ kind: "tool", severity: "blocker", message: "A tool it uses was deleted or is not shared with you." });
      continue;
    }
    if (!tool.enabled) issues.push({ kind: "tool", severity: "blocker", message: `Tool “${tool.name}” is turned off.` });
    if (isMcpRuntimeTool(tool)) usesMcp = true;
  }
  if (usesMcp && !connectorEnabled(data.connectors, "mcp")) {
    issues.push({ kind: "connector", severity: "blocker", message: "MCP servers are turned off for this workspace." });
  }
  const templateIds = unique(attachments.prompt_template_ids);
  if (templateIds.length && !connectorEnabled(data.connectors, "prompt-library")) {
    issues.push({ kind: "connector", severity: "blocker", message: "The Prompt Library is turned off for this workspace." });
  } else {
    for (const id of templateIds) {
      const template = data.promptTemplates.find((item) => item.id === id);
      if (!template) {
        issues.push({ kind: "template", severity: "blocker", message: "A prompt template it uses was deleted or is not shared with you." });
      } else if (!template.enabled) {
        issues.push({ kind: "template", severity: "blocker", message: `Prompt template “${template.name}” is turned off.` });
      }
    }
  }
  for (const id of unique(attachments.skill_file_ids)) {
    const skill = data.skillFiles.find((item) => item.id === id);
    if (!skill) {
      issues.push({ kind: "skill", severity: "blocker", message: "A skill file it uses was deleted or is not shared with you." });
    } else if (!skill.enabled) {
      issues.push({ kind: "skill", severity: "blocker", message: `Skill file “${skill.name}” is turned off.` });
    }
  }
  return issues;
}

/** "Everyone" covers both stored values: the API enforces "organization" and
 * "tenant" identically (same-organization access), so the editor offers one
 * choice and keeps whichever value an existing agent already has. */
export function agentAudience(visibility: ModelConfig["visibility"] | undefined): "everyone" | "groups" | "private" {
  if (visibility === "private") return "private";
  if (visibility === "group") return "groups";
  return "everyone";
}

export function agentAudienceLabel(visibility: ModelConfig["visibility"] | undefined): string {
  const audience = agentAudience(visibility);
  if (audience === "private") return "Only the creator";
  if (audience === "groups") return "Selected groups";
  return "Everyone in the organization";
}

/** The first sentence or so of an agent's instructions, for card previews. */
export function agentSummary(systemPrompt: string | undefined | null): string {
  const text = (systemPrompt ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = /^(.{20,220}?[.!?])(\s|$)/.exec(text)?.[1];
  return sentence ?? (text.length > 200 ? `${text.slice(0, 197).trimEnd()}…` : text);
}

export function agentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "A";
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`;
  return letters.toUpperCase();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
