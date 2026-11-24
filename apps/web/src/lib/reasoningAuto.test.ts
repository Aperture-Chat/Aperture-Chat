import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { ReasoningLevel } from "../components/ReasoningSlider";
import {
  chooseReasoningLevel,
  loadReasoningAuto,
  reasoningLevelForSend,
  storeReasoningAuto,
  useReasoningPreference,
  type ReasoningSignals,
} from "./reasoningAuto";

const longPrompt = Array.from({ length: 260 }, (_, index) => `word${index}`).join(" ");
const longDocument = "The parties agree as follows. ".repeat(400);

const chatCases: [string, ReasoningSignals, ReasoningLevel][] = [
  // Clearly trivial: Fast.
  ["a greeting", { text: "hi" }, "fast"],
  ["thanks", { text: "thanks!" }, "fast"],
  ["a greeting with a time of day", { text: "Good morning!" }, "fast"],
  ["praise with thanks", { text: "great, thanks!" }, "fast"],
  ["thanks with emphasis", { text: "Thank you so much 🙏" }, "fast"],
  ["defining a word", { text: "define estoppel" }, "fast"],
  ["what a word means", { text: "What does voir dire mean?" }, "fast"],
  ["spelling", { text: "how do you spell accommodate" }, "fast"],
  ["a quick synonym", { text: "another word for important" }, "fast"],
  ["a short translation", { text: "translate 'good morning' to Spanish" }, "fast"],
  ["a unit conversion", { text: "convert 5 miles to km" }, "fast"],
  ["a longer stand-alone conversion", { text: "how many feet are in a mile" }, "fast"],
  ["the meaning of a term", { text: "what is the meaning of consequential damages" }, "fast"],

  // Short, but not trivial: Balanced.
  // A go-ahead continues an earlier request whose weight Auto cannot see.
  ["a go-ahead", { text: "ok sounds good" }, "balanced"],
  ["a yes", { text: "yes" }, "balanced"],
  ["a go-ahead to act", { text: "sure, go ahead" }, "balanced"],
  ["a no", { text: "no" }, "balanced"],
  // Touching up text is light work, but it is work on text Auto cannot weigh.
  ["rephrasing one sentence", { text: "rephrase: I am writing to follow up on my last email." }, "balanced"],
  ["fixing typos in a short text", { text: "fix the typos: teh meeting is moved to thrusday" }, "balanced"],
  // A lookup is trivial only when it is tiny and stands on its own.
  ["'spell out' means explain", { text: "Spell out what the tenant must do to cure a default under this lease and the deadlines" }, "balanced"],
  ["defining the elements of a claim", { text: "Define the elements of tortious interference in Kansas and Missouri" }, "balanced"],
  ["what a holding means for a matter", { text: "What does the court's holding in Smith v. Jones mean for our appeal?" }, "balanced"],
  ["what a section means for a deal", { text: "What does Section 4.2 of the MSA mean for our renewal?" }, "balanced"],
  ["what a short section means", { text: "What does Section 4.2 mean?" }, "balanced"],
  ["a meaning under a state's law", { text: "What is the meaning of consequential damages under New York law?" }, "balanced"],
  ["a definition under a state's law", { text: "Define consequential damages under Missouri law" }, "balanced"],
  ["rewording a provision changes it", { text: "Rephrase the arbitration provision so it covers all disputes" }, "balanced"],
  ["translating a whole section", { text: "Translate the termination section of our German supplier agreement into English and note anything unusual" }, "balanced"],
  ["a meaning that points at the conversation", { text: "what does this mean?" }, "balanced"],
  ["a definition that points at our matter", { text: "define our exposure" }, "balanced"],
  // Reading a file back is ordinary work; judging it is not.
  ["a summary of an attachment", { text: "summarize this", attachmentCount: 1 }, "balanced"],
  ["explaining an attachment", { text: "explain this to me", attachmentCount: 1 }, "balanced"],
  ["empty text", { text: "" }, "balanced"],
  ["whitespace only", { text: "   \n " }, "balanced"],
  ["recency in a short ask", { text: "What's the latest on the Chevron ruling?" }, "balanced"],
  ["a lookup in a short ask", { text: "look up the definition of laches" }, "balanced"],
  ["recency in a simple ask", { text: "how do you spell the name of the latest iPhone" }, "balanced"],
  ["a source request", { text: "define laches and cite a source" }, "balanced"],
  ["today in a greeting", { text: "hi, what is the news today" }, "balanced"],
  ["a greeting with an attachment", { text: "thanks", attachmentCount: 1 }, "balanced"],
  ["an everyday question", { text: "What is the capital of France?" }, "balanced"],
  ["a short email", { text: "write a quick reply to John thanking him for lunch" }, "balanced"],
  ["a drafting verb without a legal document", { text: "draft a short note to the team about Friday" }, "balanced"],
  ["code conversion is not a unit conversion", { text: "convert this function to TypeScript" }, "balanced"],
  ["a question about an attachment, no analysis", { text: "what is this?", attachmentCount: 2 }, "balanced"],
  ["fixing typos in a long paste", { text: `fix the typos in this: ${longPrompt}` }, "balanced"],
  ["spell-checking an attached file", { text: "check the spelling", attachmentCount: 1 }, "balanced"],

  // Word-boundary traps.
  ["'hi' inside 'this'", { text: "this" }, "balanced"],
  ["'thanks' is not enough when more is asked", { text: "thanks, now what should I bring to the deposition" }, "balanced"],
  ["'brief' as an adjective", { text: "give me a brief answer: what is the capital of France?" }, "balanced"],
  ["'write a brief summary' is not a legal brief", { text: "write a brief summary of the meeting" }, "balanced"],
  ["'compare' inside 'comparable'", { text: "are these comparable sizes" }, "balanced"],
  ["'risk' inside 'brisk'", { text: "a brisk walk" }, "balanced"],
  ["'debug' inside 'debugger' is a different word", { text: "open the debugger" }, "balanced"],

  // Depth: Smart.
  ["an analysis verb", { text: "Analyze the pros and cons of incorporating in Delaware" }, "smart"],
  ["a comparison", { text: "compare option A and option B" }, "smart"],
  ["trade-offs", { text: "what are the trade-offs here" }, "smart"],
  ["explain why", { text: "explain why the sky is blue" }, "smart"],
  ["step by step", { text: "walk through it step by step" }, "smart"],
  ["root cause", { text: "find the root cause of the outage" }, "smart"],
  ["a proof", { text: "prove that the square root of 2 is irrational" }, "smart"],
  ["a risk question", { text: "what are the risks of signing this" }, "smart"],
  ["a legal memo", { text: "draft a memo to the partner on the motion to dismiss" }, "smart"],
  ["a legal brief", { text: "write a brief for the appeal" }, "smart"],
  ["a brief at the end", { text: "please review my appellate brief" }, "smart"],
  ["a contract review", { text: "review this contract" }, "smart"],
  ["a legal term", { text: "is this indemnification clause enforceable?" }, "smart"],
  ["case law", { text: "find case law on adverse possession" }, "smart"],
  ["due diligence", { text: "what goes in a due diligence checklist" }, "smart"],
  ["a debugging ask", { text: "debug this for me" }, "smart"],
  ["a refactor", { text: "refactor the payment module" }, "smart"],
  ["system design", { text: "design a system for intake requests" }, "smart"],
  ["a fenced code block", { text: "why?\n```\nconst x = 1;\n```" }, "smart"],
  ["a JavaScript stack trace", { text: "TypeError: x is undefined\n    at render (app.js:10:5)" }, "smart"],
  ["a Python traceback", { text: "Traceback (most recent call last):\n  File \"main.py\", line 3" }, "smart"],
  ["three questions", { text: "Who signed? When? For how much?" }, "smart"],
  ["a numbered list of asks", { text: "Please:\n1. list parties\n2. list dates\n3. list amounts" }, "smart"],
  ["a bulleted list of asks", { text: "Need:\n- names\n- dates\n- totals" }, "smart"],
  ["a list with bullet characters", { text: "Need:\n• names\n• dates\n• totals" }, "smart"],
  ["a long prompt", { text: longPrompt }, "smart"],
  ["a review of an attachment", { text: "review the attached", attachmentCount: 1 }, "smart"],
  ["pulling terms out of an attachment", { text: "extract the key dates", attachmentCount: 1 }, "smart"],
  ["a greeting does not hide depth", { text: "hi! can you compare these two leases?" }, "smart"],
];

const draftsCases: [string, ReasoningSignals, ReasoningLevel][] = [
  // Drafts always has a working document, so it is never Fast.
  ["fix typos on a long document", { text: "fix typos", documentLength: longDocument.length }, "balanced"],
  ["shorten a paragraph", { text: "make this paragraph shorter", documentLength: 900 }, "balanced"],
  ["a long memo", { text: "write a 10-page memo on indemnification risk", documentLength: 0 }, "smart"],
  ["restructuring a large document", { text: "restructure this into three sections", documentLength: longDocument.length }, "smart"],
  ["rewriting a large document", { text: "rewrite it in plain English", documentLength: longDocument.length }, "smart"],
  ["rewriting a small document", { text: "rewrite it in plain English", documentLength: 600 }, "balanced"],
  ["a review with attachments", { text: "review the attached and summarize", attachmentCount: 2, documentLength: 0 }, "smart"],
  ["a review with no file sent", { text: "review the attached and summarize", attachmentCount: 0, documentLength: 0 }, "balanced"],
];

describe("chooseReasoningLevel", () => {
  test.each(chatCases)("chat: %s", (_name, signals, level) => {
    expect(chooseReasoningLevel(signals)).toBe(level);
  });

  test.each(draftsCases)("Drafts: %s", (_name, signals, level) => {
    expect(chooseReasoningLevel(signals)).toBe(level);
  });

  test("an acknowledgment past the word limit is not trivial", () => {
    expect(chooseReasoningLevel({ text: "thanks thanks thanks thanks thanks thanks thanks thanks" })).toBe("fast");
    expect(chooseReasoningLevel({ text: "thanks thanks thanks thanks thanks thanks thanks thanks thanks" })).toBe("balanced");
  });

  test("a simple ask past the word limit is not trivial", () => {
    const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");
    expect(chooseReasoningLevel({ text: `define ${words(7)}` })).toBe("fast");
    expect(chooseReasoningLevel({ text: `define ${words(8)}` })).toBe("balanced");
  });

  test("a prompt turns Smart at the long-prompt threshold", () => {
    const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");
    expect(chooseReasoningLevel({ text: words(249) })).toBe("balanced");
    expect(chooseReasoningLevel({ text: words(250) })).toBe("smart");
  });

  test("two questions or two list items are not multi-part", () => {
    expect(chooseReasoningLevel({ text: "Who signed? When?" })).toBe("balanced");
    expect(chooseReasoningLevel({ text: "Need:\n- names\n- dates" })).toBe("balanced");
  });

  test("a document turns large at the size threshold", () => {
    expect(chooseReasoningLevel({ text: "rewrite it", documentLength: 7999 })).toBe("balanced");
    expect(chooseReasoningLevel({ text: "rewrite it", documentLength: 8000 })).toBe("smart");
  });

  test("indented list items and stack frames still count", () => {
    expect(chooseReasoningLevel({ text: "Need:\n\t- names\n   - dates\n  - totals" })).toBe("smart");
    expect(chooseReasoningLevel({ text: "it failed\n\t  at render (app.js:10:5)  " })).toBe("smart");
  });

  test("a paste full of blank lines is judged at once", () => {
    // Runs of blank lines once made the list and stack-trace rules take
    // seconds; the chooser runs while the user types, so it must stay quick.
    const paste = `page one${"\n".repeat(100_000)}page two`;
    const started = performance.now();
    expect(chooseReasoningLevel({ text: paste })).toBe("balanced");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("any working document rules out Fast", () => {
    expect(chooseReasoningLevel({ text: "thanks", documentLength: 1 })).toBe("balanced");
  });
});

describe("reasoningLevelForSend", () => {
  const signals = { text: "hi" };

  test("sends the user's own level when Auto is off", () => {
    expect(reasoningLevelForSend({ level: "smart", auto: false }, signals)).toBe("smart");
  });

  test("sends the level picked for the request when Auto is on", () => {
    expect(reasoningLevelForSend({ level: "smart", auto: true }, signals)).toBe("fast");
    expect(reasoningLevelForSend({ level: "fast", auto: true }, { text: "compare these" })).toBe("smart");
  });
});

describe("Auto preference storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("is off until the user turns it on", () => {
    expect(loadReasoningAuto("user-a")).toBe(false);
  });

  test("on persists for that user only, and off persists too", () => {
    storeReasoningAuto("user-a", true);
    expect(loadReasoningAuto("user-a")).toBe(true);
    expect(loadReasoningAuto("user-b")).toBe(false);
    storeReasoningAuto("user-a", false);
    expect(loadReasoningAuto("user-a")).toBe(false);
  });

  test("storage that throws reads as off and loses only the preference", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
    expect(() => storeReasoningAuto("user-a", true)).not.toThrow();
    expect(loadReasoningAuto("user-a")).toBe(false);
  });
});

describe("useReasoningPreference", () => {
  afterEach(() => localStorage.clear());

  test("starts Balanced with Auto off", () => {
    const { result } = renderHook(() => useReasoningPreference("user-a"));
    expect(result.current.level).toBe("balanced");
    expect(result.current.auto).toBe(false);
  });

  test("level and Auto survive a remount for the same user", () => {
    const first = renderHook(() => useReasoningPreference("user-a"));
    act(() => {
      first.result.current.setLevel("smart");
      first.result.current.setAuto(true);
    });
    expect(first.result.current.level).toBe("smart");
    expect(first.result.current.auto).toBe(true);
    first.unmount();

    const again = renderHook(() => useReasoningPreference("user-a"));
    expect(again.result.current.level).toBe("smart");
    expect(again.result.current.auto).toBe(true);
  });

  test("a different user starts with Auto off", () => {
    const first = renderHook(() => useReasoningPreference("user-a"));
    act(() => first.result.current.setAuto(true));
    first.unmount();

    const other = renderHook(() => useReasoningPreference("user-b"));
    expect(other.result.current.auto).toBe(false);
    expect(other.result.current.level).toBe("balanced");
  });
});
