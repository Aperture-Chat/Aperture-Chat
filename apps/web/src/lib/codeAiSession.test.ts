import { describe, expect, test } from "vitest";
import {
  CODE_AI_NO_CODE,
  CODE_AI_STOPPED,
  codeAiAccepted,
  codeAiFailure,
  codeAiRequest,
  codeAiSessionReducer,
  type CodeAiSession,
} from "./codeAiSession";

const CODE = "def f():\n    return 1\n";
const SELECTION = { start: CODE.indexOf("    return"), end: CODE.length };

function open(): CodeAiSession {
  return codeAiSessionReducer(null, { type: "open", code: CODE, selection: SELECTION })!;
}

function reviewedWith(reply: string): CodeAiSession {
  const sent = codeAiSessionReducer(open(), { type: "send", runLabel: "Fix", messages: [{ role: "user", content: "x" }] });
  return codeAiSessionReducer(sent, { type: "reply", text: reply })!;
}

describe("codeAiSessionReducer", () => {
  test("opens on the selected code and names it", () => {
    expect(open()).toMatchObject({ phase: "compose", selectedText: "    return 1\n", label: "Line 2", error: null });
  });

  test("streams visible text only while working", () => {
    const sent = codeAiSessionReducer(open(), { type: "send", runLabel: "Fix", messages: [] })!;
    expect(sent.phase).toBe("working");
    const streaming = codeAiSessionReducer(sent, { type: "stream", text: "<think>plan</think>return 2" })!;
    expect(streaming.stream).toBe("return 2");
    expect(codeAiSessionReducer(open(), { type: "stream", text: "late" })!.stream).toBe("");
  });

  test("a reply becomes a cleaned proposal under review, remembering its conversation", () => {
    const session = reviewedWith("```python\nreturn 2\n```");
    expect(session).toMatchObject({ phase: "review", proposal: "    return 2\n", reply: "```python\nreturn 2\n```" });
    expect(session.messages).toEqual([{ role: "user", content: "x" }]);
  });

  test("a reply with no code is an error, not an empty replacement", () => {
    expect(reviewedWith("   ")).toMatchObject({ phase: "error", error: CODE_AI_NO_CODE });
  });

  test("failures show their message; close and actions without a session end it", () => {
    expect(codeAiSessionReducer(open(), { type: "fail", error: "Boom" })).toMatchObject({ phase: "error", error: "Boom" });
    expect(codeAiSessionReducer(open(), { type: "close" })).toBeNull();
    expect(codeAiSessionReducer(null, { type: "reply", text: "x" })).toBeNull();
  });
});

describe("codeAiRequest", () => {
  test("a first run asks for a fresh edit labelled by its instruction", () => {
    const request = codeAiRequest(open(), { code: CODE, language: "python", instruction: "Return 2", refine: false });
    expect(request.runLabel).toBe("Return 2");
    expect(request.messages[1]?.content).toContain("User instruction:\nReturn 2");
  });

  test("a refinement continues from the suggestion on screen", () => {
    const request = codeAiRequest(reviewedWith("return 2"), { code: CODE, language: "python", instruction: "Use 3", refine: true });
    expect(request.runLabel).toBe("Refine: Use 3");
    expect(request.messages.at(-2)).toEqual({ role: "assistant", content: "return 2" });
  });

  test("refining before any suggestion starts a fresh edit", () => {
    expect(codeAiRequest(open(), { code: CODE, language: "python", instruction: "Use 3", refine: true }).runLabel).toBe("Use 3");
  });
});

test("accepting applies the proposal unless the selected code changed", () => {
  const session = reviewedWith("return 2");
  expect(codeAiAccepted(session, CODE)).toBe("def f():\n    return 2\n");
  expect(codeAiAccepted(session, CODE.replace("1", "5"))).toBeNull();
});

test("a stopped request says so; other failures keep their message", () => {
  expect(codeAiFailure(new Error("aborted"), true)).toBe(CODE_AI_STOPPED);
  expect(codeAiFailure(new Error("Model is busy"), false)).toBe("Model is busy");
  expect(codeAiFailure("weird", false)).toBe(CODE_AI_NO_CODE);
  expect(codeAiFailure(new Error(""), false)).toBe(CODE_AI_NO_CODE);
});
