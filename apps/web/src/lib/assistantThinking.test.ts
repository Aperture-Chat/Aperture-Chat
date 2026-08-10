import { describe, expect, it } from "vitest";
import { splitAssistantThinking } from "./assistantThinking";

describe("splitAssistantThinking", () => {
  it("extracts a leading think block from the visible answer", () => {
    expect(
      splitAssistantThinking("<think>\nCompare the available routes.\n</think>\n\n## Final answer\nUse Groq."),
    ).toEqual({
      visibleContent: "## Final answer\nUse Groq.",
      thinkingTraces: ["Compare the available routes."],
    });
  });

  it("collects consecutive think and thinking blocks", () => {
    expect(
      splitAssistantThinking(
        "<think>First pass</think>\n<thinking>Second pass</thinking>\nAnswer",
      ),
    ).toEqual({
      visibleContent: "Answer",
      thinkingTraces: ["First pass", "Second pass"],
    });
  });

  it("leaves inline examples and incomplete tags in the answer", () => {
    expect(splitAssistantThinking("Example: <think>hidden</think>")).toEqual({
      visibleContent: "Example: <think>hidden</think>",
      thinkingTraces: [],
    });
    expect(splitAssistantThinking("<think>Still generating")).toEqual({
      visibleContent: "<think>Still generating",
      thinkingTraces: [],
    });
  });
});
