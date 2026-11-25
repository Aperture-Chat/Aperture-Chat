import { expect, test } from "vitest";
import { sampleData } from "../data/sampleData";
import { agentAudienceLabel, agentIssues, agentSummary } from "./agentReadiness";
import type { BootstrapData } from "./types";

function data(overrides: Partial<BootstrapData> = {}): BootstrapData {
  return { ...sampleData, ...overrides };
}

const connectedProvider = sampleData.providers[0];

test("a turned-off knowledge base is a warning, everything else that chat refuses is a blocker", () => {
  const knowledge = sampleData.knowledgeBases[0];
  const tool = sampleData.tools[0];
  const issues = agentIssues(
    {
      provider_id: connectedProvider.id,
      knowledge_config_ids: [knowledge.id, "knowledge-deleted"],
      tool_config_ids: [tool.id],
      prompt_template_ids: [],
      skill_file_ids: ["skill-deleted"],
    },
    data({
      providers: sampleData.providers.map((provider) => ({ ...provider, connected: true })),
      knowledgeBases: sampleData.knowledgeBases.map((item) => (item.id === knowledge.id ? { ...item, enabled: false } : item)),
      tools: sampleData.tools.map((item) => (item.id === tool.id ? { ...item, enabled: false } : item)),
    }),
  );
  expect(issues.map((issue) => [issue.kind, issue.severity])).toEqual([
    ["knowledge", "warning"],
    ["knowledge", "blocker"],
    ["tool", "blocker"],
    ["skill", "blocker"],
  ]);
});

test("a disconnected provider blocks the agent", () => {
  const issues = agentIssues(
    { provider_id: connectedProvider.id, knowledge_config_ids: [], tool_config_ids: [], prompt_template_ids: [], skill_file_ids: [] },
    data({ providers: sampleData.providers.map((provider) => ({ ...provider, connected: false })) }),
  );
  expect(issues).toEqual([expect.objectContaining({ kind: "provider", severity: "blocker" })]);
});

test("organization and tenant visibility read the same, as the API enforces them", () => {
  expect(agentAudienceLabel("organization")).toBe(agentAudienceLabel("tenant"));
  expect(agentAudienceLabel("group")).toBe("Selected groups");
  expect(agentAudienceLabel("private")).toBe("Only the creator");
});

test("card summaries use the first sentence of the instructions", () => {
  expect(agentSummary("You summarize meetings. Always list owners.")).toBe("You summarize meetings.");
  expect(agentSummary("")).toBe("");
});

test("an Only me prompt or skill on an agent warns that nobody else can chat with it", () => {
  const template = { ...sampleData.promptTemplates[0], only_me: true, owner_user_id: sampleData.me.id, group_ids: [] };
  const skill = { ...sampleData.skillFiles[0], only_me: true, owner_user_id: sampleData.me.id, group_ids: [] };
  const issues = agentIssues(
    {
      provider_id: connectedProvider.id,
      knowledge_config_ids: [],
      tool_config_ids: [],
      prompt_template_ids: [template.id, sampleData.promptTemplates[1].id],
      skill_file_ids: [skill.id],
    },
    data({
      providers: sampleData.providers.map((provider) => ({ ...provider, connected: true })),
      promptTemplates: [template, sampleData.promptTemplates[1]],
      skillFiles: [skill],
    }),
  );
  expect(issues).toEqual([
    {
      kind: "template",
      severity: "warning",
      message: `Prompt template “${template.name}” is set to Only me, so this agent refuses chats from anyone else.`,
    },
    {
      kind: "skill",
      severity: "warning",
      message: `Skill file “${skill.name}” is set to Only me, so this agent refuses chats from anyone else.`,
    },
  ]);
});
