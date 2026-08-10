export type AssistantThinkingParts = {
  visibleContent: string;
  thinkingTraces: string[];
};

// Some open-weight reasoning models expose their internal trace as a leading
// <think> or <thinking> block. Only consume complete blocks at the very start
// of a response so ordinary prose, code samples, and incomplete output remain
// untouched.
const LEADING_THINKING_BLOCK = /^\s*<(think|thinking)>\s*([\s\S]*?)\s*<\/\1>\s*/i;

export function splitAssistantThinking(content: string): AssistantThinkingParts {
  const thinkingTraces: string[] = [];
  let visibleContent = content;
  let matchedBlock = false;

  for (let index = 0; index < 8; index += 1) {
    const match = visibleContent.match(LEADING_THINKING_BLOCK);
    if (!match) break;
    matchedBlock = true;
    const trace = match[2].trim();
    if (trace) thinkingTraces.push(trace);
    visibleContent = visibleContent.slice(match[0].length);
  }

  return matchedBlock
    ? { visibleContent: visibleContent.trimStart(), thinkingTraces }
    : { visibleContent: content, thinkingTraces };
}
