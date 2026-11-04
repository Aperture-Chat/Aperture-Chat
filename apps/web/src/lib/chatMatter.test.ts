import { describe, expect, it, vi } from "vitest";

import { ChatRequestError } from "./api/http";
import { applyThreadMatter, threadMatterId, withChosenMatter, withThreadMatterOutcome } from "./chatMatter";

const saved = { unsaved: false, afterSave: false };

describe("threadMatterId", () => {
  it("shows the choice just made before the server confirms it", () => {
    expect(threadMatterId({ matter_id: "matter-a", pendingMatterId: "matter-b" })).toBe("matter-b");
    expect(threadMatterId({ matter_id: "matter-a", pendingMatterId: null })).toBeNull();
  });

  it("otherwise shows what the server has", () => {
    expect(threadMatterId({ matter_id: "matter-a" })).toBe("matter-a");
    expect(threadMatterId({})).toBeNull();
  });
});

describe("withChosenMatter", () => {
  it("records the choice and clears an earlier refusal", () => {
    expect(withChosenMatter({ matter_id: null, matterError: "Refused." }, "matter-a")).toEqual({
      matter_id: null,
      pendingMatterId: "matter-a",
      matterError: undefined,
    });
  });
});

describe("applyThreadMatter", () => {
  it("does nothing when no choice is waiting", async () => {
    const change = vi.fn();
    expect(await applyThreadMatter(change, { matter_id: "matter-a" }, saved)).toEqual({ kind: "linked", matterId: "matter-a" });
    expect(change).not.toHaveBeenCalled();
  });

  it("waits for a new chat's first save before calling the server", async () => {
    const change = vi.fn();
    const outcome = await applyThreadMatter(change, { pendingMatterId: "matter-a" }, { unsaved: true, afterSave: false });
    expect(outcome).toEqual({ kind: "waiting" });
    expect(change).not.toHaveBeenCalled();
  });

  it("moves a stored chat from its old matter to the new one", async () => {
    const change = vi.fn(async () => undefined);
    const outcome = await applyThreadMatter(change, { matter_id: "matter-a", pendingMatterId: "matter-b" }, saved);
    expect(change).toHaveBeenCalledWith("matter-a", "matter-b");
    expect(outcome).toEqual({ kind: "linked", matterId: "matter-b" });
  });

  it("removes the tag when the choice is none", async () => {
    const change = vi.fn(async () => undefined);
    expect(await applyThreadMatter(change, { matter_id: "matter-a", pendingMatterId: null }, saved)).toEqual({
      kind: "linked",
      matterId: null,
    });
    expect(change).toHaveBeenCalledWith("matter-a", null);
  });

  it("keeps waiting when the chat's first save is still on its way", async () => {
    const change = vi.fn(async () => {
      throw new ChatRequestError("Unknown private matter resource.", 404);
    });
    expect(await applyThreadMatter(change, { pendingMatterId: "matter-a" }, saved)).toEqual({ kind: "waiting" });
  });

  it("reports a refusal right after a save, and any other refusal, in words", async () => {
    const notFound = vi.fn(async () => {
      throw new ChatRequestError("Matter not found.", 404);
    });
    expect(await applyThreadMatter(notFound, { pendingMatterId: "matter-a" }, { unsaved: false, afterSave: true })).toEqual({
      kind: "failed",
      message: "Matter not found.",
    });
    const conflict = vi.fn(async () => {
      throw new ChatRequestError("This matter is being deleted and cannot accept assignments.", 409);
    });
    expect(await applyThreadMatter(conflict, { pendingMatterId: "matter-a" }, saved)).toEqual({
      kind: "failed",
      message: "This matter is being deleted and cannot accept assignments.",
    });
    const silent = vi.fn(async () => {
      throw new Error("");
    });
    expect(await applyThreadMatter(silent, { pendingMatterId: "matter-a" }, saved)).toEqual({
      kind: "failed",
      message: "The matter was not saved.",
    });
  });
});

describe("withThreadMatterOutcome", () => {
  it("adopts a confirmed link and clears the pending choice", () => {
    const thread = { matter_id: null, pendingMatterId: "matter-a" };
    expect(withThreadMatterOutcome(thread, { kind: "linked", matterId: "matter-a" }, "matter-a")).toEqual({
      matter_id: "matter-a",
      pendingMatterId: undefined,
      matterError: undefined,
    });
  });

  it("keeps a newer choice pending after an older one lands", () => {
    const thread = { matter_id: null, pendingMatterId: "matter-b" };
    expect(withThreadMatterOutcome(thread, { kind: "linked", matterId: "matter-a" }, "matter-a")).toEqual({
      matter_id: "matter-a",
      pendingMatterId: "matter-b",
      matterError: undefined,
    });
  });

  it("drops a refused choice and says why, unless a newer choice replaced it", () => {
    const refused = { kind: "failed", message: "Refused." } as const;
    expect(withThreadMatterOutcome({ matter_id: "matter-a", pendingMatterId: "matter-b" }, refused, "matter-b")).toEqual({
      matter_id: "matter-a",
      pendingMatterId: undefined,
      matterError: "Refused.",
    });
    const newer = { matter_id: "matter-a", pendingMatterId: "matter-c" };
    expect(withThreadMatterOutcome(newer, refused, "matter-b")).toBe(newer);
  });

  it("leaves a waiting chat untouched", () => {
    const thread = { pendingMatterId: "matter-a" };
    expect(withThreadMatterOutcome(thread, { kind: "waiting" }, "matter-a")).toBe(thread);
  });
});
