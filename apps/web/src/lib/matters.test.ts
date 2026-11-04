import { describe, expect, it, vi } from "vitest";

import {
  MAX_MATTER_LABEL_CHARS,
  cleanMatterLabel,
  findMatterByLabel,
  matchingMatters,
  matterChangeSteps,
  matterLabelFor,
  matterLabelProblem,
  resolveMatterLabel,
  type Matter,
} from "./matters";

function matter(id: string, name: string): Matter {
  return {
    id,
    tenant_id: "tenant-example",
    name,
    retention_days: null,
    created_by_user_id: "user-jane",
    version: 1,
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
  };
}

const saved = [matter("matter-1", "100234-0001"), matter("matter-2", "100234-0002"), matter("matter-3", "Acme Lease Review")];

describe("cleanMatterLabel", () => {
  it("stores a label the way the server does", () => {
    expect(cleanMatterLabel("  100234   -  0001 \n")).toBe("100234 - 0001");
    expect(cleanMatterLabel("a\u0000b")).toBe("ab");
    expect(cleanMatterLabel("   ")).toBe("");
  });
});

describe("matterLabelProblem", () => {
  it("explains an empty or oversized label and accepts a normal one", () => {
    expect(matterLabelProblem("  ")).toBe("Type a client-matter number first.");
    expect(matterLabelProblem("x".repeat(MAX_MATTER_LABEL_CHARS + 1))).toBe("Use 200 characters or fewer.");
    expect(matterLabelProblem("x".repeat(MAX_MATTER_LABEL_CHARS))).toBeNull();
    expect(matterLabelProblem("100234-0001")).toBeNull();
  });
});

describe("findMatterByLabel", () => {
  it("finds a saved matter however its label was typed", () => {
    expect(findMatterByLabel(saved, " acme  lease REVIEW ")?.id).toBe("matter-3");
    expect(findMatterByLabel(saved, "100234-0002")?.id).toBe("matter-2");
  });

  it("finds nothing for a new label or an empty one", () => {
    expect(findMatterByLabel(saved, "100234-0003")).toBeUndefined();
    expect(findMatterByLabel(saved, "100234")).toBeUndefined();
    expect(findMatterByLabel(saved, "   ")).toBeUndefined();
  });
});

describe("matchingMatters", () => {
  it("lists every saved matter until something is typed", () => {
    expect(matchingMatters(saved, "").map((item) => item.id)).toEqual(["matter-1", "matter-2", "matter-3"]);
  });

  it("narrows to labels containing the typed text, in saved order", () => {
    expect(matchingMatters(saved, "100234").map((item) => item.id)).toEqual(["matter-1", "matter-2"]);
    expect(matchingMatters(saved, "LEASE").map((item) => item.id)).toEqual(["matter-3"]);
    expect(matchingMatters(saved, "9999")).toEqual([]);
  });
});

describe("matterLabelFor", () => {
  it("names a linked matter this person can open, and nothing otherwise", () => {
    expect(matterLabelFor(saved, "matter-2")).toBe("100234-0002");
    expect(matterLabelFor(saved, "matter-unknown")).toBeNull();
    expect(matterLabelFor(saved, null)).toBeNull();
    expect(matterLabelFor(saved, undefined)).toBeNull();
  });
});

describe("matterChangeSteps", () => {
  it("does nothing when the matter is unchanged", () => {
    expect(matterChangeSteps(null, null)).toEqual([]);
    expect(matterChangeSteps("matter-1", "matter-1")).toEqual([]);
  });

  it("links, unlinks, or moves between matters", () => {
    expect(matterChangeSteps(null, "matter-1")).toEqual([{ op: "assign", matterId: "matter-1" }]);
    expect(matterChangeSteps("matter-1", null)).toEqual([{ op: "clear", matterId: "matter-1" }]);
    expect(matterChangeSteps("matter-1", "matter-2")).toEqual([
      { op: "clear", matterId: "matter-1" },
      { op: "assign", matterId: "matter-2" },
    ]);
  });
});

describe("resolveMatterLabel", () => {
  it("reuses a saved matter instead of creating a duplicate", async () => {
    const create = vi.fn();
    const result = await resolveMatterLabel(saved, "100234-0001 ", create);
    expect(result.matter.id).toBe("matter-1");
    expect(result.matters.map((item) => item.id)).toEqual(["matter-1", "matter-2", "matter-3"]);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a new matter under the cleaned label and lists it first", async () => {
    const create = vi.fn(async (label: string) => matter("matter-new", label));
    const result = await resolveMatterLabel(saved, "  100234-0003  ", create);
    expect(create).toHaveBeenCalledWith("100234-0003");
    expect(result.matter.id).toBe("matter-new");
    expect(result.matters.map((item) => item.id)).toEqual(["matter-new", "matter-1", "matter-2", "matter-3"]);
  });

  it("refuses an empty label without calling the server", async () => {
    const create = vi.fn();
    await expect(resolveMatterLabel(saved, "  ", create)).rejects.toThrow("Type a client-matter number first.");
    expect(create).not.toHaveBeenCalled();
  });
});
