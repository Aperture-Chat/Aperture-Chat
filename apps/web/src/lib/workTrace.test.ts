import { describe, expect, test } from "vitest";
import type { ChatActivityTraceStep, ChatCitation } from "./types";
import {
  advanceTrace,
  finishTrace,
  formatTraceDuration,
  liveTraceView,
  readTrace,
  recordActivity,
  selfChecks,
  startTrace,
  traceSummary,
} from "./workTrace";

const T0 = 1_000_000;

function ids(steps: ChatActivityTraceStep[]) {
  return steps.map((step) => step.id);
}

function labels(steps: ChatActivityTraceStep[]) {
  return steps.map((step) => step.label);
}

function step(steps: ChatActivityTraceStep[], id: string) {
  return steps.find((item) => item.id === id);
}

function citation(overrides: Partial<ChatCitation>): ChatCitation {
  return { id: "c", source_name: "Source", source_type: "knowledge", source_uri: "x", snippet: "", ...overrides };
}

const fence = (language: string, body: string, closed = true) =>
  ["```" + language, body, ...(closed ? ["```"] : [])].join("\n");

describe("startTrace", () => {
  test("names the model and only what the user switched on", () => {
    expect(startTrace({ modelLabel: "GPT-6 Astra", knowledge: 0, tools: 0, web: false, attachments: 0 })).toEqual([
      { id: "route:model", label: "Routed to GPT-6 Astra" },
    ]);
    expect(
      startTrace({ modelLabel: "Client Update Agent", knowledge: 2, tools: 1, web: true, attachments: 3 }),
    ).toEqual([
      {
        id: "route:model",
        label: "Routed to Client Update Agent",
        detail: "With 2 knowledge sources, web search, 1 tool, and 3 attachments",
      },
    ]);
    expect(startTrace({ modelLabel: "M", knowledge: 1, tools: 0, web: false, attachments: 0 })[0].detail).toBe(
      "With 1 knowledge source",
    );
    expect(startTrace({ modelLabel: "M", knowledge: 0, tools: 0, web: true, attachments: 1 })[0].detail).toBe(
      "With web search and 1 attachment",
    );
  });
});

describe("recordActivity", () => {
  const route = startTrace({ modelLabel: "M", knowledge: 0, tools: 0, web: false, attachments: 0 });

  test.each([
    [{ kind: "agent", name: "Research desk" }, "agent:profile", "Working as Research desk"],
    [{ kind: "privacy" }, "privacy:prompt", "Concealed personal data in your message"],
    [{ kind: "knowledge", passages: 6, sources: 2 }, "knowledge:hits", "Found 6 passages in workspace knowledge"],
    [{ kind: "knowledge", passages: 1, sources: 1 }, "knowledge:hits", "Found 1 passage in workspace knowledge"],
    [{ kind: "knowledge", passages: 0, sources: 0 }, "knowledge:hits", "Searched workspace knowledge"],
    [{ kind: "web", results: 5, engine: "searxng" }, "web:search", "Searched the web · 5 results"],
    [{ kind: "web", results: 0, engine: "" }, "web:search", "Searched the web"],
    [{ kind: "web-provider" }, "web:provider", "Handed web search to the model provider"],
    [{ kind: "fetch", pages: 2 }, "fetch:pages", "Read 2 linked pages"],
    [{ kind: "tools", servers: 2, calls: [] }, "tools:servers", "Connected 2 tool servers"],
    [{ kind: "attachments", files: 1, images: 0 }, "attachments:files", "Read 1 attachment"],
    [{ kind: "memory", recalled: 2, companion: 1 }, "memory:recall", "Recalled 3 memories"],
    [{ kind: "skills", skills: 1, templates: 0 }, "skills:loaded", "Loaded 1 skill"],
    [{ kind: "skills", skills: 0, templates: 2 }, "skills:loaded", "Loaded 2 prompt templates"],
    [{ kind: "skills", skills: 2, templates: 1 }, "skills:loaded", "Loaded 2 skills and 1 prompt template"],
    [{ kind: "requirements-noted", count: 2 }, "plan:requirements", "Picked out 2 things to verify"],
    [{ kind: "requirements-noted", count: 1 }, "plan:requirements", "Picked out 1 thing to verify"],
    [{ kind: "screen-hold" }, "screen:hold", "Holding the reply for content-rule screening"],
    [{ kind: "screen-done" }, "screen:done", "Screened the reply against content rules"],
    [{ kind: "continue", round: 1 }, "continue:r1", "Reached the output limit and kept writing"],
    [{ kind: "resume", attempt: 1 }, "resume:a1", "Connection dropped — resumed where it left off"],
    [
      { kind: "hermes", memories: 1, skills: ["Citation style"], automations: [] },
      "save:hermes",
      "Hermes saved what it learned",
    ],
  ] as const)("%j becomes %s", (activity, id, label) => {
    const next = recordActivity(route, activity);
    expect(next[0]).toEqual(route[0]);
    expect(next.at(-1)).toMatchObject({ id, label });
  });

  test("details stay factual and short", () => {
    expect(recordActivity([], { kind: "knowledge", passages: 6, sources: 2 })[0].detail).toBe("From 2 sources");
    expect(recordActivity([], { kind: "knowledge", passages: 0, sources: 0 })[0].detail).toBe(
      "No passages matched this request.",
    );
    expect(recordActivity([], { kind: "web", results: 5, engine: "searxng" })[0].detail).toBe("Via SearXNG");
    expect(recordActivity([], { kind: "web", results: 3, engine: "duckduckgo" })[0].detail).toBe("Via DuckDuckGo");
    expect(recordActivity([], { kind: "web", results: 3, engine: "brave" })[0].detail).toBe("Via brave");
    expect(recordActivity([], { kind: "web", results: 0, engine: "" })[0].detail).toBe("No results came back.");
    expect(recordActivity([], { kind: "attachments", files: 2, images: 1 })[0].detail).toBe("Including 1 image");
    expect(recordActivity([], { kind: "memory", recalled: 2, companion: 1 })[0].detail).toBe(
      "1 from the agent's companion",
    );
    expect(recordActivity([], { kind: "memory", recalled: 2, companion: 0 })[0].detail).toBeUndefined();
    expect(recordActivity([], { kind: "continue", round: 2 })[0].detail).toBe("Continuation 2");
    expect(
      recordActivity([], { kind: "hermes", memories: 2, skills: ["Style"], automations: ["Weekly digest"] })[0].detail,
    ).toBe("2 memories · skill “Style” · automation “Weekly digest” proposed");
  });

  test("each tool call is its own step and a failed call is a flag", () => {
    const next = recordActivity([], {
      kind: "tools",
      servers: 1,
      calls: [
        { name: "lookup", ok: true },
        { name: "fetch_case", ok: false },
      ],
    });
    expect(next).toEqual([
      { id: "tools:call-1", label: "Ran lookup", detail: "Its result was added to the context." },
      { id: "flag:tool-2", label: "fetch_case returned an error", detail: "The reply was written without that result." },
    ]);
  });

  test("requirement checks become verified or missed steps", () => {
    const next = recordActivity([], {
      kind: "requirements-checked",
      checks: [
        { label: "Include a markdown table", met: true },
        { label: "Include images or diagrams", met: false },
      ],
    });
    expect(next).toEqual([
      { id: "check:req-1", label: "Verified: Include a markdown table" },
      {
        id: "flag:req-2",
        label: "Not met: Include images or diagrams",
        detail: "Regenerate or ask a follow-up to cover it.",
      },
    ]);
  });

  test("a repeated fact replaces its step in place", () => {
    const first = recordActivity(route, { kind: "knowledge", passages: 2, sources: 1 });
    const again = recordActivity(recordActivity(first, { kind: "fetch", pages: 1 }), {
      kind: "knowledge",
      passages: 4,
      sources: 2,
    });
    expect(ids(again)).toEqual(["route:model", "knowledge:hits", "fetch:pages"]);
    expect(step(again, "knowledge:hits")?.label).toBe("Found 4 passages in workspace knowledge");
  });

  test("the first step can be replaced in place too", () => {
    const once = recordActivity([], { kind: "knowledge", passages: 1, sources: 1 });
    const twice = recordActivity(once, { kind: "knowledge", passages: 3, sources: 2 });
    expect(twice).toEqual([{ id: "knowledge:hits", label: "Found 3 passages in workspace knowledge", detail: "From 2 sources" }]);
  });

  test("continuation rounds and reconnects always add a new step", () => {
    let trace = recordActivity([], { kind: "continue", round: 1 });
    trace = recordActivity(trace, { kind: "resume", attempt: 1 });
    trace = recordActivity(trace, { kind: "continue", round: 1 });
    trace = recordActivity(trace, { kind: "continue", round: 1 });
    expect(ids(trace)).toEqual(["continue:r1", "resume:a1", "continue:r1-2", "continue:r1-3"]);
  });
});

describe("advanceTrace", () => {
  const route = startTrace({ modelLabel: "M", knowledge: 0, tools: 0, web: false, attachments: 0 });

  test("nothing changes before the first words arrive", () => {
    expect(advanceTrace(route, { content: "", startedAtMs: T0, nowMs: T0 + 9000, final: false })).toEqual(route);
  });

  test("the first words record how long the model thought", () => {
    const next = advanceTrace(route, { content: "Oak", startedAtMs: T0, nowMs: T0 + 6400, final: false });
    expect(step(next, "think:first-token")).toEqual({
      id: "think:first-token",
      label: "Thought for 6s",
      detail: "Time until the first words arrived",
    });
    expect(ids(next).slice(0, 3)).toEqual(["route:model", "think:first-token", "write:intro"]);
    // Later advances keep the recorded time instead of re-measuring.
    const later = advanceTrace(next, { content: "Oak trees", startedAtMs: T0, nowMs: T0 + 60_000, final: false });
    expect(step(later, "think:first-token")?.label).toBe("Thought for 6s");
  });

  test("an instant first token still reads as a whole second", () => {
    const next = advanceTrace([], { content: "Hi", startedAtMs: T0, nowMs: T0 + 120, final: false });
    expect(step(next, "think:first-token")?.label).toBe("Thought for 1s");
  });

  test("a screened reply records no thinking time", () => {
    const held = recordActivity(route, { kind: "screen-hold" });
    const next = advanceTrace(held, { content: "Done.", startedAtMs: T0, nowMs: T0 + 40_000, final: false });
    expect(step(next, "think:first-token")).toBeUndefined();
  });

  test("a plain reply is one writing step whose tense follows the stream", () => {
    const live = advanceTrace(route, { content: "Oak trees grow", startedAtMs: T0, nowMs: T0 + 1000, final: false });
    expect(step(live, "write:intro")?.label).toBe("Writing the reply");
    const done = advanceTrace(live, { content: "Oak trees grow slowly.", startedAtMs: T0, nowMs: T0 + 2000, final: true });
    expect(step(done, "write:intro")?.label).toBe("Wrote the reply");
  });

  test("steps are discovered from the reply in the order they appear", () => {
    const content = [
      "Here is the plan.",
      "",
      "## Game layout",
      "",
      "| Part | Role |",
      "| --- | --- |",
      "| Field | Play |",
      "| Panel | Score |",
      "",
      "![Board sketch](https://example.com/board.png)",
      "",
      fence("mermaid", "flowchart LR\n  A --> B"),
      "",
      "### The code",
      "",
      fence("html", "<!doctype html>\n<html>\n<body></body>", false),
    ].join("\n");
    const next = advanceTrace(route, { content, startedAtMs: T0, nowMs: T0 + 3000, final: false });
    expect(ids(next)).toEqual([
      "route:model",
      "think:first-token",
      "write:intro",
      "write:s1",
      "table:t1",
      "image:i1",
      "diagram:d1",
      "write:s2",
      "code:c1",
    ]);
    expect(labels(next).slice(2)).toEqual([
      "Wrote the opening",
      "Drafted “Game layout”",
      "Built a table",
      "Placed an image",
      "Drew a diagram",
      "Drafted “The code”",
      "Writing html",
    ]);
    expect(step(next, "table:t1")?.detail).toBe("2 rows");
    expect(step(next, "image:i1")?.detail).toBe("Board sketch");
    expect(step(next, "diagram:d1")?.detail).toBe("Mermaid");
    expect(step(next, "code:c1")?.detail).toBe("3 lines");
  });

  test("a code block's line count grows live, then settles in the past tense", () => {
    const opening = "## Build\n\n" + fence("python", "a = 1", false);
    const first = advanceTrace(route, { content: opening, startedAtMs: T0, nowMs: T0 + 1000, final: false });
    expect(step(first, "code:c1")).toMatchObject({ label: "Writing python", detail: "1 line" });
    const grown = advanceTrace(first, {
      content: opening + "\nb = 2\nc = 3",
      startedAtMs: T0,
      nowMs: T0 + 2000,
      final: false,
    });
    expect(step(grown, "code:c1")).toMatchObject({ label: "Writing python", detail: "3 lines" });
    const closed = advanceTrace(grown, {
      content: opening + "\nb = 2\nc = 3\n```\n\nThat's it.",
      startedAtMs: T0,
      nowMs: T0 + 3000,
      final: false,
    });
    expect(step(closed, "code:c1")).toMatchObject({ label: "Wrote python", detail: "3 lines" });
    expect(ids(closed).filter((id) => id === "code:c1")).toHaveLength(1);
  });

  test("structure charts are diagrams, Hermes blocks are not steps, and unnamed code says code", () => {
    const content = [
      fence("aperture-diagram", '{"rows": []}'),
      fence("hermes-memory", "Remember this"),
      fence("", "plain"),
    ].join("\n\n");
    const next = advanceTrace([], { content, startedAtMs: T0, nowMs: T0 + 1000, final: true });
    expect(step(next, "diagram:d1")).toMatchObject({ label: "Drew a diagram", detail: "Structure chart" });
    expect(step(next, "code:c1")).toMatchObject({ label: "Wrote code", detail: "1 line" });
    expect(next.some((item) => item.label.includes("hermes"))).toBe(false);
  });

  test("long headings and image descriptions are trimmed, and inline images count too", () => {
    const longTitle = "A".repeat(80);
    const content = `## ${longTitle}\n\nSee ![${"b".repeat(90)}](https://example.com/x.png) here.`;
    const next = advanceTrace([], { content, startedAtMs: T0, nowMs: T0 + 1000, final: true });
    expect(step(next, "write:s1")?.label).toBe(`Drafted “${"A".repeat(59)}…”`);
    expect(step(next, "image:i1")?.detail).toBe(`${"b".repeat(59)}…`);
  });

  test("a fence whose info line is still arriving is not a step yet", () => {
    // The stream split the opening fence mid-tag: "```aperture-" now, "diagram\n{" later.
    const partial = advanceTrace([], {
      content: "## Game layout\n\n```aperture-",
      startedAtMs: T0,
      nowMs: T0 + 1000,
      final: false,
    });
    expect(ids(partial)).toEqual(["think:first-token", "write:s1"]);
    const complete = advanceTrace(partial, {
      content: "## Game layout\n\n```aperture-diagram\n{",
      startedAtMs: T0,
      nowMs: T0 + 2000,
      final: false,
    });
    expect(ids(complete)).toEqual(["think:first-token", "write:s1", "diagram:d1"]);
    expect(step(complete, "diagram:d1")?.label).toBe("Drawing a diagram");
  });

  test("a finished code block stays finished while the next fence's tag is arriving", () => {
    const next = advanceTrace([], {
      content: fence("py", "a = 1") + "\n\n```aperture-",
      startedAtMs: T0,
      nowMs: T0 + 1000,
      final: false,
    });
    expect(step(next, "code:c1")).toMatchObject({ label: "Wrote py", detail: "1 line" });
  });

  test("a step the reply outgrew does not survive, while reported steps stay put", () => {
    const transient: ChatActivityTraceStep[] = [
      { id: "route:model", label: "Routed to M" },
      { id: "think:first-token", label: "Thought for 2s" },
      { id: "write:s1", label: "Drafting “Game layout”" },
      { id: "code:c1", label: "Writing aperture-", detail: "0 lines" },
      { id: "continue:r1", label: "Reached the output limit and kept writing" },
    ];
    const content = "## Game layout\n\n" + fence("aperture-diagram", '{"rows": [[{"id": "a", "title": "A"}]]}');
    const done = finishTrace(transient, { content, citations: [], startedAtMs: T0, nowMs: T0 + 5000 });
    expect(ids(done)).toEqual([
      "route:model",
      "think:first-token",
      "write:s1",
      "continue:r1",
      "diagram:d1",
      "check:fences",
      "check:diagram-1",
      "done:reply",
    ]);
  });

  test("a heading of exactly sixty characters is kept whole", () => {
    const title = "B".repeat(60);
    const next = advanceTrace([], { content: `## ${title}\n\nText`, startedAtMs: T0, nowMs: T0, final: true });
    expect(step(next, "write:s1")?.label).toBe(`Drafted “${title}”`);
  });

  test("a code block that has just opened has no lines yet", () => {
    const next = advanceTrace([], { content: "## A\n\n```py\n", startedAtMs: T0, nowMs: T0, final: false });
    expect(step(next, "code:c1")).toMatchObject({ label: "Writing py", detail: "0 lines" });
  });

  test("a reply that is only a table separator so far adds no steps and does not fail", () => {
    expect(ids(advanceTrace([], { content: "| --- | --- |", startedAtMs: T0, nowMs: T0, final: false }))).toEqual([
      "think:first-token",
    ]);
  });

  test("when the reply's last block makes no step, nothing reads as in progress", () => {
    const next = advanceTrace([], {
      content: "## A\n\nText\n\n## B\n\nMore\n\n---",
      startedAtMs: T0,
      nowMs: T0,
      final: false,
    });
    expect(labels(next).slice(1)).toEqual(["Drafted “A”", "Drafted “B”"]);
  });

  test("a half-arrived fence after several blocks drops only itself", () => {
    const next = advanceTrace([], {
      content: "## A\n\nText\n\n## B\n\nMore\n\n```aperture-",
      startedAtMs: T0,
      nowMs: T0,
      final: false,
    });
    expect(ids(next)).toEqual(["think:first-token", "write:s1", "write:s2"]);
  });

  test("one section past the cap reads as one more section", () => {
    const content = Array.from({ length: 7 }, (_, index) => `## Part ${index + 1}\n\nText.`).join("\n\n");
    const done = advanceTrace([], { content, startedAtMs: T0, nowMs: T0, final: true });
    expect(step(done, "write:more")).toEqual({ id: "write:more", label: "Drafted 1 more section", detail: "1 more · latest “Part 7”" });
  });

  test("a long reply groups its extra sections instead of flooding the trace", () => {
    const content = Array.from({ length: 9 }, (_, index) => `## Part ${index + 1}\n\nText.`).join("\n\n");
    const live = advanceTrace([], { content, startedAtMs: T0, nowMs: T0 + 1000, final: false });
    const sectionSteps = live.filter((item) => item.id.startsWith("write:"));
    expect(ids(sectionSteps)).toEqual(["write:s1", "write:s2", "write:s3", "write:s4", "write:s5", "write:s6", "write:more"]);
    expect(step(live, "write:more")).toEqual({
      id: "write:more",
      label: "Drafting more sections",
      detail: "3 more · latest “Part 9”",
    });
    const done = advanceTrace(live, { content, startedAtMs: T0, nowMs: T0 + 2000, final: true });
    expect(step(done, "write:more")?.label).toBe("Drafted 3 more sections");
  });

  test("steps reported by the server mid-stream stay where they happened", () => {
    let trace = advanceTrace(route, { content: "## One\n\nText", startedAtMs: T0, nowMs: T0 + 1000, final: false });
    trace = recordActivity(trace, { kind: "continue", round: 1 });
    trace = advanceTrace(trace, {
      content: "## One\n\nText\n\n## Two\n\nMore",
      startedAtMs: T0,
      nowMs: T0 + 2000,
      final: false,
    });
    expect(ids(trace)).toEqual(["route:model", "think:first-token", "write:s1", "continue:r1", "write:s2"]);
  });

  test("advancing is idempotent", () => {
    const content = "## A\n\n" + fence("ts", "const a = 1;");
    const once = advanceTrace(route, { content, startedAtMs: T0, nowMs: T0 + 1000, final: true });
    expect(advanceTrace(once, { content, startedAtMs: T0, nowMs: T0 + 5000, final: true })).toEqual(once);
  });
});

describe("selfChecks", () => {
  test("a reply with nothing to verify adds no checks", () => {
    expect(selfChecks("Just prose.", [])).toEqual([]);
  });

  test("prose after the last code block does not make it look open", () => {
    expect(selfChecks(fence("py", "a = 1") + "\n\nThat's all.", [])).toEqual([
      { id: "check:fences", label: "Code blocks are all closed", detail: "1 fenced block" },
    ]);
  });

  test("an unlabeled block left open is called a code block", () => {
    expect(selfChecks("```\nabc", [])[0]?.detail).toBe("The reply ends inside a code block, so it may be cut off.");
  });

  test("at most three diagrams are checked", () => {
    const diagrams = Array.from({ length: 4 }, () => fence("mermaid", "flowchart LR\n  A --> B")).join("\n\n");
    expect(selfChecks(diagrams, []).filter((item) => item.id.includes("diagram")).map((item) => item.id)).toEqual([
      "check:diagram-1",
      "check:diagram-2",
      "check:diagram-3",
    ]);
  });

  test("up to four missing markers are listed in full, and more are shortened", () => {
    expect(selfChecks("[K1] [K2] [K3] [K4]", [])[0]?.label).toBe("Cites [K1], [K2], [K3], [K4] with no source");
    expect(selfChecks("[K1] [K2] [K3] [K4] [K5]", [])[0]?.label).toBe("Cites [K1], [K2], [K3], [K4], … with no source");
    expect(selfChecks("Only [K7].", [citation({ k_index: 7 })])[0]?.detail).toBe("1 marker matched");
  });

  test("closed code blocks pass; a block left open is flagged", () => {
    expect(selfChecks(fence("py", "a = 1") + "\n\n" + fence("sh", "ls"), [])).toEqual([
      { id: "check:fences", label: "Code blocks are all closed", detail: "2 fenced blocks" },
    ]);
    expect(selfChecks("Intro\n\n" + fence("py", "a = 1", false), [])).toEqual([
      {
        id: "flag:fences",
        label: "A code block was left open",
        detail: "The reply ends inside a py block, so it may be cut off.",
      },
    ]);
  });

  test("a complete HTML page passes and a truncated one is flagged", () => {
    const complete = selfChecks(fence("html", "<!DOCTYPE html>\n<html>\n<body>Hi</body>\n</html>"), []);
    expect(complete).toContainEqual({
      id: "check:html-1",
      label: "HTML page is complete",
      detail: "4 lines, ending with </html>",
    });
    const cut = selfChecks(fence("html", "<!DOCTYPE html>\n<html>\n<body>Hi"), []);
    expect(cut).toContainEqual({
      id: "flag:html-1",
      label: "HTML page ends early",
      detail: "There's no closing </html> tag, so the page may be cut off.",
    });
    // A fragment is not a page, so it is not held to the page rule.
    expect(selfChecks(fence("html", "<p>Hi</p>"), []).some((item) => item.id.includes("html"))).toBe(false);
  });

  test("structure diagrams are parsed; Mermaid is recognized", () => {
    const valid = JSON.stringify({
      rows: [[{ id: "a", title: "A" }, { id: "b", title: "B" }]],
      edges: [{ from: "a", to: "b" }],
    });
    expect(selfChecks(fence("aperture-diagram", valid), [])).toContainEqual({
      id: "check:diagram-1",
      label: "Structure diagram is valid",
      detail: "2 boxes · 1 arrow",
    });
    expect(selfChecks(fence("aperture-diagram", '{"rows": [[{"id": "a"'), [])).toContainEqual({
      id: "flag:diagram-1",
      label: "Diagram needs repair",
      detail: "Its structure didn't parse; use Edit or regenerate the reply.",
    });
    expect(selfChecks(fence("mermaid", "flowchart LR\n  A --> B"), [])).toContainEqual({
      id: "check:diagram-1",
      label: "Diagram recognized",
      detail: "Drawn from Mermaid source",
    });
  });

  test("every citation marker must have a source behind it", () => {
    const citations = [citation({ id: "k", k_index: 1 }), citation({ id: "cite-fetch-1", source_type: "web" })];
    expect(selfChecks("Retention is seven years [K1], per the page [U1].", citations)).toEqual([
      { id: "check:citations", label: "Every citation links to a source", detail: "2 markers matched" },
    ]);
    expect(selfChecks("Seven years [K1] and ten [K3] and [U2].", citations)).toEqual([
      {
        id: "flag:citations",
        label: "Cites [K3], [U2] with no source",
        detail: "Those markers have nothing behind them in this reply.",
      },
    ]);
    expect(selfChecks("Grouped [K1, K2], ranged [K1-K2], full-width 【K1】.", [citation({ id: "a", k_index: 1 }), citation({ id: "b", k_index: 2 })])).toEqual([
      { id: "check:citations", label: "Every citation links to a source", detail: "4 markers matched" },
    ]);
    expect(selfChecks("Grouped [K3, K4].", citations)[0]?.label).toBe("Cites [K3], [K4] with no source");
    expect(selfChecks("A hallucinated range [K2-K999999].", citations)[0]?.id).toBe("flag:citations");
    expect(selfChecks("A range reaching one source [K1-K9].", citations)[0]?.id).toBe("check:citations");
    expect(selfChecks("Fetched [U4].", [citation({ id: "x", u_index: 4 })])[0]?.id).toBe("check:citations");
    expect(selfChecks("From the web [W2].", [citation({ id: "x", w_index: 2 })])[0]?.id).toBe("check:citations");
    expect(selfChecks("From the web [W3].", [citation({ id: "x", w_index: 2 })])[0]?.label).toBe("Cites [W3] with no source");
    // With no web source in the reply, [W2] is a tax form, not a claim of one.
    expect(selfChecks("See the [W2] form.", citations)).toEqual([]);
    expect(selfChecks("[K1 statement]", [])).toEqual([]);
    // Markers inside code are code, not citations.
    expect(selfChecks(fence("txt", "array[K9]"), [])).toEqual([
      { id: "check:fences", label: "Code blocks are all closed", detail: "1 fenced block" },
    ]);
  });
});

describe("finishTrace", () => {
  test("settles the steps, adds the checks, and closes with the delivery", () => {
    const route = startTrace({ modelLabel: "M", knowledge: 0, tools: 0, web: false, attachments: 0 });
    const content = "## Intro\n\nOak trees grow slowly and live long.\n\n" + fence("py", "print(1)");
    const live = advanceTrace(route, { content, startedAtMs: T0, nowMs: T0 + 2000, final: false });
    const done = finishTrace(live, { content, citations: [], startedAtMs: T0, nowMs: T0 + 4000 });
    expect(ids(done)).toEqual(["route:model", "think:first-token", "write:s1", "code:c1", "check:fences", "done:reply"]);
    expect(step(done, "code:c1")?.label).toBe("Wrote py");
    expect(step(done, "done:reply")).toEqual({ id: "done:reply", label: "Delivered the reply", detail: "≈ 8 words" });
    // Finishing twice is the same as finishing once.
    expect(finishTrace(done, { content, citations: [], startedAtMs: T0, nowMs: T0 + 9000 })).toEqual(done);
  });
});

describe("finishTrace tense", () => {
  test("a reply that ends in prose settles its section in the past tense", () => {
    const content = "## Plan\n\nOak trees grow slowly.";
    const live = advanceTrace([], { content, startedAtMs: T0, nowMs: T0, final: false });
    expect(step(live, "write:s1")?.label).toBe("Drafting “Plan”");
    const done = finishTrace(live, { content, citations: [], startedAtMs: T0, nowMs: T0 });
    expect(step(done, "write:s1")?.label).toBe("Drafted “Plan”");
  });
});

describe("readTrace", () => {
  test("new ids carry their kind", () => {
    expect(
      readTrace([
        { id: "route:model", label: "Routed to M" },
        { id: "check:fences", label: "Code blocks are all closed", detail: "2 fenced blocks" },
        { id: "mystery:x", label: "Something" },
      ]),
    ).toEqual([
      { id: "route:model", kind: "route", label: "Routed to M" },
      { id: "check:fences", kind: "check", label: "Code blocks are all closed", detail: "2 fenced blocks" },
      { id: "mystery:x", kind: "context", label: "Something" },
    ]);
  });

  test("older preset steps keep rendering, minus the validator claim that never ran on a stream", () => {
    const legacy = [
      "route",
      "context",
      "web",
      "knowledge",
      "tools",
      "attachments",
      "scope",
      "visuals",
      "generate",
      "validator",
      "finalize",
      "other",
    ].map((id) => ({ id, label: id }));
    expect(readTrace(legacy).map((item) => [item.id, item.kind])).toEqual([
      ["route", "route"],
      ["context", "context"],
      ["web", "web"],
      ["knowledge", "knowledge"],
      ["tools", "tools"],
      ["attachments", "attachments"],
      ["scope", "plan"],
      ["visuals", "image"],
      ["generate", "write"],
      ["finalize", "done"],
      ["other", "context"],
    ]);
    expect(readTrace(undefined)).toEqual([]);
  });
});

describe("liveTraceView", () => {
  const route = startTrace({ modelLabel: "M", knowledge: 0, tools: 0, web: false, attachments: 0 });

  test("before the first words the model is thinking, and writing is up next", () => {
    const view = liveTraceView(route, { content: "", startedAtMs: T0, nowMs: T0 + 4200 });
    expect(view.steps.map((item) => item.id)).toEqual(["route:model", "think:live"]);
    expect(view.current).toEqual({ id: "think:live", kind: "think", label: "Thinking", detail: "4s" });
    expect(view.activeIndex).toBe(1);
    expect(view.upNext).toBe("Start writing the reply");
  });

  test("a screened reply shows the hold instead of thinking", () => {
    const held = recordActivity(route, { kind: "screen-hold" });
    const view = liveTraceView(held, { content: "", startedAtMs: T0, nowMs: T0 + 2000 });
    expect(view.current).toMatchObject({ kind: "screen", label: "Writing behind the content screen" });
    expect(view.upNext).toBe("Show the reply once it clears screening");
  });

  test("while writing, the step in progress is current and the finish is up next", () => {
    const content = "## A\n\n" + fence("html", "<p>", false);
    const writing = advanceTrace(route, { content, startedAtMs: T0, nowMs: T0 + 2000, final: false });
    const view = liveTraceView(writing, { content, startedAtMs: T0, nowMs: T0 + 2500 });
    expect(view.current).toMatchObject({ id: "code:c1", label: "Writing html", detail: "1 line" });
    expect(view.activeIndex).toBe(view.steps.length - 1);
    expect(view.upNext).toBe("Check the work and finish");
  });

  test("prose after a finished code block puts its section back in progress", () => {
    const content = "## Build\n\n" + fence("py", "a = 1") + "\n\nNow the explanation";
    const writing = recordActivity(advanceTrace(route, { content, startedAtMs: T0, nowMs: T0 + 2000, final: false }), {
      kind: "continue",
      round: 1,
    });
    const view = liveTraceView(writing, { content, startedAtMs: T0, nowMs: T0 + 2500 });
    expect(view.current).toMatchObject({ id: "write:s1", kind: "write", label: "Drafting “Build”" });
    expect(step(writing, "code:c1")?.label).toBe("Wrote py");
  });

  test("the block the reply currently ends on stays current after a later server step", () => {
    const content = fence("py", "a = 1");
    const writing = recordActivity(advanceTrace(route, { content, startedAtMs: T0, nowMs: T0 + 2000, final: false }), {
      kind: "screen-done",
    });
    const view = liveTraceView(writing, { content, startedAtMs: T0, nowMs: T0 + 2500 });
    expect(view.current.id).toBe("code:c1");
  });

  test("the step in progress is current even when it is the first step", () => {
    const trace: ChatActivityTraceStep[] = [
      { id: "write:intro", label: "Writing the reply" },
      { id: "continue:r1", label: "Reached the output limit and kept writing" },
    ];
    const view = liveTraceView(trace, { content: "Hello", startedAtMs: T0, nowMs: T0 });
    expect(view.activeIndex).toBe(0);
    expect(view.current.id).toBe("write:intro");
  });

  test("an empty trace still has a current step", () => {
    const view = liveTraceView([], { content: "  ", startedAtMs: T0, nowMs: T0 });
    expect(view.current.kind).toBe("think");
    expect(view.current.detail).toBe("0s");
  });
});

describe("traceSummary", () => {
  test("counts steps, passed checks, and flags", () => {
    expect(
      traceSummary(
        readTrace([
          { id: "route:model", label: "r" },
          { id: "check:fences", label: "c" },
          { id: "check:req-1", label: "c" },
          { id: "flag:req-2", label: "f" },
        ]),
      ),
    ).toEqual({ steps: 4, checks: 2, flags: 1 });
  });
});

describe("formatTraceDuration", () => {
  test.each([
    [0, "0s"],
    [-5, "0s"],
    [999, "0s"],
    [48_400, "48s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [125_000, "2m 05s"],
    [3_599_000, "59m 59s"],
    [3_600_000, "1h 00m"],
    [3_720_000, "1h 02m"],
  ])("%d ms reads as %s", (ms, text) => {
    expect(formatTraceDuration(ms)).toBe(text);
  });
});
