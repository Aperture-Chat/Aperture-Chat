import { describe, expect, test } from "vitest";
import { parseStreamActivity } from "./streamActivity";

describe("parseStreamActivity", () => {
  test.each([
    [{ kind: "agent", name: "Research desk" }, { kind: "agent", name: "Research desk" }],
    [{ kind: "privacy", concealed: true }, { kind: "privacy" }],
    [{ kind: "knowledge", passages: 6, sources: 2 }, { kind: "knowledge", passages: 6, sources: 2 }],
    [{ kind: "web", results: 5, engine: "searxng" }, { kind: "web", results: 5, engine: "searxng" }],
    [{ kind: "web", provider: true }, { kind: "web-provider" }],
    [{ kind: "fetch", pages: 2 }, { kind: "fetch", pages: 2 }],
    [
      { kind: "tools", servers: 1, calls: [{ name: "lookup", ok: true }, { name: "case", ok: false }] },
      { kind: "tools", servers: 1, calls: [{ name: "lookup", ok: true }, { name: "case", ok: false }] },
    ],
    [{ kind: "attachments", files: 2, images: 1 }, { kind: "attachments", files: 2, images: 1 }],
    [{ kind: "memory", recalled: 3, companion: 0 }, { kind: "memory", recalled: 3, companion: 0 }],
    [{ kind: "skills", skills: 1, templates: 2 }, { kind: "skills", skills: 1, templates: 2 }],
    [{ kind: "requirements", phase: "noted", count: 2 }, { kind: "requirements-noted", count: 2 }],
    [
      { kind: "requirements", phase: "checked", checks: [{ label: "Include a table", met: true }] },
      { kind: "requirements-checked", checks: [{ label: "Include a table", met: true }] },
    ],
    [{ kind: "screen", phase: "hold" }, { kind: "screen-hold" }],
    [{ kind: "screen", phase: "done" }, { kind: "screen-done" }],
    [{ kind: "continue", round: 2 }, { kind: "continue", round: 2 }],
    [
      { kind: "hermes", memories: 1, skills: ["Style"], automations: [] },
      { kind: "hermes", memories: 1, skills: ["Style"], automations: [] },
    ],
  ])("reads %j", (raw, parsed) => {
    expect(parseStreamActivity(raw)).toEqual(parsed);
  });

  test.each([
    null,
    "knowledge",
    [],
    { kind: "unknown" },
    { kind: "agent", name: "" },
    { kind: "knowledge", passages: "6", sources: 2 },
    { kind: "knowledge", passages: -1, sources: 0 },
    { kind: "web", results: 1.5, engine: "x" },
    { kind: "requirements", phase: "later" },
    { kind: "screen", phase: "never" },
    { kind: "continue", round: 0 },
  ])("rejects malformed %j", (raw) => {
    expect(parseStreamActivity(raw)).toBeNull();
  });

  test("drops malformed entries inside lists instead of the whole event", () => {
    expect(
      parseStreamActivity({
        kind: "tools",
        servers: 1,
        calls: [{ name: "lookup", ok: true }, null, ["x"], { name: 4 }, "x", { name: "case", ok: "no" }],
      }),
    ).toEqual({ kind: "tools", servers: 1, calls: [{ name: "lookup", ok: true }] });
    expect(
      parseStreamActivity({
        kind: "requirements",
        phase: "checked",
        checks: [{ label: "Cite sources", met: false }, null, { label: "", met: true }],
      }),
    ).toEqual({ kind: "requirements-checked", checks: [{ label: "Cite sources", met: false }] });
    expect(
      parseStreamActivity({ kind: "hermes", memories: 0, skills: ["A", 3], automations: "B" }),
    ).toEqual({ kind: "hermes", memories: 0, skills: ["A"], automations: [] });
  });

  test("missing counts read as zero and a missing engine as blank", () => {
    expect(parseStreamActivity({ kind: "attachments", files: 1 })).toEqual({ kind: "attachments", files: 1, images: 0 });
    expect(parseStreamActivity({ kind: "web", results: 3 })).toEqual({ kind: "web", results: 3, engine: "" });
    expect(parseStreamActivity({ kind: "memory", recalled: 2 })).toEqual({ kind: "memory", recalled: 2, companion: 0 });
  });
});
