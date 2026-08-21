export type PromptImproverKind = "chat" | "system" | "meta" | "template";

const BASE_PROMPT_IMPROVER_SYSTEM_PROMPT =
  "You are a prompt-improvement assistant inside an enterprise AI workspace. " +
  "Rewrite the user's draft prompt so it is clearer, more specific, and more effective while keeping the author's intent, language, and voice. " +
  "Add concrete details, constraints, or structure only when they are grounded in the draft itself or the workspace context provided — never invent facts, names, permissions, or requirements. " +
  "Do not answer the prompt. Return only the rewritten prompt as plain text, with no preamble, labels, quotes, or markdown fences.";

const KIND_GUARDRAILS: Record<PromptImproverKind, string> = {
  chat:
    "Improve this as an end-user request. Preserve the user's intended outcome and do not make the request broader than the original.",
  system:
    "Improve this as an agent system prompt. Preserve instruction hierarchy, policy boundaries, approval requirements, tool limits, and source-grounding rules. Do not grant the agent new permissions or weaken an existing guardrail.",
  meta:
    "Improve this as an agent meta prompt that guides internal working behavior. Keep it distinct from the user-facing system prompt, preserve approval and citation requirements, and do not request disclosure of private chain-of-thought.",
  template:
    "Improve this as a reusable prompt template. Preserve every existing {{variable}} token exactly, do not rename or remove variables, and do not add new variables.",
};

export function promptImproverSystemPrompt(kind: PromptImproverKind): string {
  return `${BASE_PROMPT_IMPROVER_SYSTEM_PROMPT} ${KIND_GUARDRAILS[kind]}`;
}

/** Converts a model rewrite into paste-ready editor text. */
export function cleanImprovedPrompt(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^(?:improved|rewritten|revised)\s+prompt\s*:\s*/i, "");
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("“") && text.endsWith("”"))) {
    text = text.slice(1, -1).trim();
  }
  return text.trim();
}
