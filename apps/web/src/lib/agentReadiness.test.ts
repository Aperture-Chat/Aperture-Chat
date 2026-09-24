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
