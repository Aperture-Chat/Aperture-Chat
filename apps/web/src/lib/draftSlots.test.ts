import { describe, expect, it } from "vitest";
import { keptDraftSlots, returnsToHeldDraft, sameDraftSlots, slotOnScreen, type DraftSlot } from "./draftSlots";

const slot = (session: number, draftId: string | null, held = false): DraftSlot => ({
  key: `${session}:${draftId ?? ""}`,
  draftId,
  session,
  held,
});
const none = new Set<string>();
const working = (...slots: DraftSlot[]) => new Set(slots.map((item) => item.key));

/** Plays route changes and work changes in order, as the app does. */
function play(steps: Array<{ at: [number, string | null] | null; working?: string[] }>): DraftSlot[] {
  let kept: DraftSlot[] = [];
  for (const step of steps) {
    const onScreen = step.at ? slotOnScreen(kept, step.at[0], step.at[1]) : null;
    kept = keptDraftSlots(kept, onScreen, new Set(step.working ?? []));
  }
  return kept;
}

describe("slotOnScreen", () => {
  it("opens a new workspace for Drafts", () => {
    expect(slotOnScreen([], 0, null)).toEqual(slot(0, null));
  });

  it("opens a named draft in its own workspace", () => {
    expect(slotOnScreen([slot(0, null)], 0, "draft-7")).toEqual(slot(0, "draft-7"));
  });

  it("keeps showing the workspace already open on that draft", () => {
    const open = slot(2, "draft-7");
    expect(slotOnScreen([open], 2, "draft-7")).toBe(open);
  });

  it("returns to the workspace the assistant was writing in", () => {
    const writing = slot(1, "draft-7", true);
    expect(slotOnScreen([writing], 1, null)).toBe(writing);
  });

  it("returns to the one left most recently when several are held", () => {
    const first = slot(1, "draft-1", true);
    const second = slot(1, "draft-2", true);
    expect(slotOnScreen([first, second], 1, null)).toBe(second);
  });

  it("gives a new session its own workspace even while an older one is held", () => {
    expect(slotOnScreen([slot(1, null, true)], 2, null)).toEqual(slot(2, null));
  });

  it("opens a named draft even while another workspace is held", () => {
    expect(slotOnScreen([slot(1, null, true)], 1, "draft-9")).toEqual(slot(1, "draft-9"));
  });

  it("ignores a workspace that was never held", () => {
    expect(slotOnScreen([slot(1, "draft-7")], 1, null)).toEqual(slot(1, null));
  });
});

describe("returnsToHeldDraft", () => {
  it("is true when Drafts is opened while a workspace is held", () => {
    expect(returnsToHeldDraft([slot(1, "draft-7", true)], 1, null)).toBe(true);
  });

  it.each([
    ["nothing is held", [slot(1, null)], 1, null],
    ["a draft is named", [slot(1, null, true)], 1, "draft-9"],
    ["the held workspace is from an older session", [slot(1, null, true)], 2, null],
  ] as const)("is false when %s", (_label, kept, session, draftId) => {
    expect(returnsToHeldDraft(kept, session, draftId)).toBe(false);
  });
});

describe("keptDraftSlots", () => {
  it("mounts the workspace on screen", () => {
    expect(keptDraftSlots([], slot(0, null), none)).toEqual([slot(0, null)]);
  });

  it("unmounts an idle workspace the person leaves", () => {
    expect(keptDraftSlots([slot(0, null)], null, none)).toEqual([]);
  });

  it("holds a workspace left while the assistant is working", () => {
    const left = slot(0, null);
    expect(keptDraftSlots([left], null, working(left))).toEqual([slot(0, null, true)]);
  });

  it("keeps a held workspace after its work finishes, until the person is back in Drafts", () => {
    const held = slot(0, null, true);
    expect(keptDraftSlots([held], null, none)).toEqual([held]);
  });

  it("keeps a held workspace on screen as it is", () => {
    const held = slot(0, null, true);
    expect(keptDraftSlots([held], held, none)).toEqual([held]);
  });

  it("drops a finished held workspace once the person opens a different draft", () => {
    const held = slot(0, null, true);
    const other = slot(0, "draft-9");
    expect(keptDraftSlots([held], other, none)).toEqual([other]);
  });

  it("keeps a working workspace mounted beside the draft now on screen", () => {
    const writing = slot(0, null, true);
    const other = slot(0, "draft-9");
    expect(keptDraftSlots([writing], other, working(writing))).toEqual([writing, other]);
  });

  it("keeps the order workspaces were mounted in, so none is moved", () => {
    const first = slot(0, null, true);
    const second = slot(0, "draft-9");
    expect(keptDraftSlots([first, second], first, working(second)).map((item) => item.key)).toEqual(["0:", "0:draft-9"]);
  });

  it("does not hold a workspace that is working while on screen", () => {
    const shown = slot(0, null);
    expect(keptDraftSlots([shown], shown, working(shown))).toEqual([shown]);
  });
});

describe("a session in Drafts", () => {
  it("returns to a draft left mid-reply, and stays on it afterwards", () => {
    const kept = play([
      { at: [0, null] },
      { at: [0, null], working: ["0:"] },
      { at: null, working: ["0:"] },
      { at: null },
      { at: [0, null] },
      { at: [0, null] },
    ]);
    expect(kept).toEqual([slot(0, null, true)]);
  });

  it("returns to a named draft left mid-reply when Drafts is opened without a name", () => {
    const kept = play([
      { at: [0, "draft-7"], working: ["0:draft-7"] },
      { at: null, working: ["0:draft-7"] },
      { at: [0, null], working: ["0:draft-7"] },
      { at: [0, null] },
    ]);
    expect(kept).toEqual([slot(0, "draft-7", true)]);
  });

  it("lets a transfer from chat start a fresh draft while the old one finishes", () => {
    const kept = play([
      { at: [0, null], working: ["0:"] },
      { at: null, working: ["0:"] },
      { at: [1, null], working: ["0:"] },
      { at: [1, null] },
    ]);
    expect(kept).toEqual([slot(1, null)]);
  });

  it("behaves as before when nothing is in flight", () => {
    expect(play([{ at: [0, null] }, { at: null }, { at: [0, "draft-7"] }, { at: null }])).toEqual([]);
  });
});

describe("sameDraftSlots", () => {
  it("is true for the same workspaces in the same state", () => {
    expect(sameDraftSlots([slot(0, null, true)], [slot(0, null, true)])).toBe(true);
  });

  it.each([
    ["a different count", [slot(0, null)], []],
    ["a different workspace", [slot(0, null)], [slot(1, null)]],
    ["a different hold", [slot(0, null)], [slot(0, null, true)]],
  ])("is false for %s", (_label, a, b) => {
    expect(sameDraftSlots(a, b)).toBe(false);
  });
});
