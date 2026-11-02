import { describe, expect, it } from "vitest";
import {
  applyCommandText,
  commandMenuKeyAction,
  detectComposerCommandToken,
  groupCommandSections,
  knowledgeCommandItems,
  matchingKnowledgeBases,
  rankCommandMatches,
} from "./composerCommands";
import type { KnowledgeBase, KnowledgeDocument } from "./types";

const base = (id: string, name: string) => ({ id, name, document_count: 2, source: "Upload" }) as KnowledgeBase;
const doc = (id: string, name: string) => ({ id, name }) as KnowledgeDocument;

const HARBOR = base("kb-harbor", "Harbor Crest matter");
const POLICY = base("kb-policy", "Policy Library");
const LEASE = doc("doc-lease", "Lease.pdf");
const NOTES = doc("doc-notes", "Harbor notes.pdf");

describe("detectComposerCommandToken", () => {
  it("finds a symbol at the start of the text", () => {
    expect(detectComposerCommandToken("#Har", 4)).toEqual({ symbol: "#", query: "Har", start: 0 });
  });

  it("finds a symbol after a space", () => {
    expect(detectComposerCommandToken("Compare #Har", 12)).toEqual({ symbol: "#", query: "Har", start: 8 });
  });

  it("reads only what is before the caret", () => {
    expect(detectComposerCommandToken("Compare #Har bor", 12)).toEqual({ symbol: "#", query: "Har", start: 8 });
  });

  it("ignores a symbol inside a word", () => {
    expect(detectComposerCommandToken("issue#12", 8)).toBeNull();
  });

  it("gives up without a caret", () => {
    expect(detectComposerCommandToken("#Har", null)).toBeNull();
  });
});

describe("rankCommandMatches", () => {
  it("ranks a name that starts with the query above one that contains it", () => {
    const names = rankCommandMatches(["Alpha harbor", "Harbor", "Zzz"], (name) => name, "har");
    expect(names).toEqual(["Harbor", "Alpha harbor"]);
  });

  it("ranks the same whichever way round the two names arrive", () => {
    const names = rankCommandMatches(["Harbor", "Alpha harbor"], (name) => name, "har");
    expect(names).toEqual(["Harbor", "Alpha harbor"]);
  });

  it("orders equal matches by name", () => {
    expect(rankCommandMatches(["Beta", "Alpha"], (name) => name, "")).toEqual(["Alpha", "Beta"]);
  });
});

describe("matchingKnowledgeBases", () => {
  it("adds a base that holds a matching file, after the bases named", () => {
    const files = [{ base: POLICY }];
    expect(matchingKnowledgeBases([POLICY, HARBOR], files, "harbor")).toEqual([HARBOR, POLICY]);
  });

  it("lists a base once when it is both named and holds a match", () => {
    expect(matchingKnowledgeBases([HARBOR], [{ base: HARBOR }], "harbor")).toEqual([HARBOR]);
  });
});

describe("knowledgeCommandItems", () => {
  const docs = { "kb-harbor": [LEASE, NOTES], "kb-policy": [] };

  it("lists bases before their files, each saying what it is", () => {
    const items = knowledgeCommandItems([HARBOR, POLICY], docs, "");
    expect(items.map((item) => item.name)).toEqual([HARBOR.name, POLICY.name, NOTES.name, LEASE.name]);
    expect(items[0]).toMatchObject({ kind: "knowledge-base", section: "Knowledge bases", detail: "2 files · Upload" });
    expect(items[2]).toMatchObject({
      kind: "knowledge-file",
      section: "Files in knowledge sources",
      detail: "In Harbor Crest matter",
    });
  });

  it("keeps a file's base in view while its name is typed", () => {
    const items = knowledgeCommandItems([HARBOR, POLICY], docs, "lease");
    expect(items.map((item) => item.name)).toEqual([HARBOR.name, LEASE.name]);
  });

  it("copes with a base whose files have not loaded", () => {
    expect(knowledgeCommandItems([POLICY], {}, "")).toHaveLength(1);
  });
});

describe("groupCommandSections", () => {
  it("keeps sections in the order they first appear", () => {
    const items = knowledgeCommandItems([HARBOR], { "kb-harbor": [LEASE] }, "");
    expect(groupCommandSections(items).map((section) => [section.title, section.items.length])).toEqual([
      ["Knowledge bases", 1],
      ["Files in knowledge sources", 1],
    ]);
  });
});

describe("applyCommandText", () => {
  it("swaps a typed token for the replacement and puts the caret after it", () => {
    expect(applyCommandText("Ask @Cli now", 4, 8, "@Client ")).toEqual({ text: "Ask @Client  now", caret: 12 });
  });

  it("takes a token out of the middle of a sentence without leaving two spaces", () => {
    expect(applyCommandText("Compare #Har with last year", 8, 12, "")).toEqual({
      text: "Compare with last year",
      caret: 8,
    });
  });

  it("leaves no stray space at the start of the text", () => {
    expect(applyCommandText("#Har needs a summary", 0, 4, "")).toEqual({ text: "needs a summary", caret: 0 });
  });

  it("changes nothing when a pick leaves no text and no token was typed", () => {
    expect(applyCommandText("Summarize  this", null, 10, "")).toEqual({ text: "Summarize  this", caret: 10 });
  });

  it("sets inserted text apart from a word it would touch", () => {
    expect(applyCommandText("Summarize", null, 9, "Text ")).toEqual({ text: "Summarize Text ", caret: 15 });
  });

  it("needs no space at the very start", () => {
    expect(applyCommandText("", null, 0, "Text ")).toEqual({ text: "Text ", caret: 5 });
  });

  it("sets inserted text apart from a single letter", () => {
    expect(applyCommandText("a", null, 1, "Text ")).toEqual({ text: "a Text ", caret: 7 });
  });

  it("adds no second space when one is already there", () => {
    expect(applyCommandText("a ", null, 2, "Text ")).toEqual({ text: "a Text ", caret: 7 });
  });
});

describe("commandMenuKeyAction", () => {
  const press = (key: string, shiftKey = false) => ({ key, shiftKey });

  it("moves down and stops at the last choice", () => {
    expect(commandMenuKeyAction(press("ArrowDown"), 3, 0)).toEqual({ type: "move", index: 1 });
    expect(commandMenuKeyAction(press("ArrowDown"), 3, 2)).toEqual({ type: "move", index: 2 });
  });

  it("moves up and stops at the first choice", () => {
    expect(commandMenuKeyAction(press("ArrowUp"), 3, 2)).toEqual({ type: "move", index: 1 });
    expect(commandMenuKeyAction(press("ArrowUp"), 3, 0)).toEqual({ type: "move", index: 0 });
  });

  it("picks the highlighted choice on Enter", () => {
    expect(commandMenuKeyAction(press("Enter"), 3, 1)).toEqual({ type: "pick", index: 1 });
  });

  it("still uses the arrows and Enter on a list of one", () => {
    expect(commandMenuKeyAction(press("ArrowDown"), 1, 0)).toEqual({ type: "move", index: 0 });
    expect(commandMenuKeyAction(press("ArrowUp"), 1, 0)).toEqual({ type: "move", index: 0 });
    expect(commandMenuKeyAction(press("Enter"), 1, 0)).toEqual({ type: "pick", index: 0 });
  });

  it("leaves Shift+Enter to the text box", () => {
    expect(commandMenuKeyAction(press("Enter", true), 3, 1)).toBeNull();
  });

  it("has nothing to do with the arrows or Enter on an empty list", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter"]) {
      expect(commandMenuKeyAction(press(key), 0, 0)).toBeNull();
    }
  });

  it("completes a single match on Tab", () => {
    expect(commandMenuKeyAction(press("Tab"), 1, 0)).toEqual({ type: "pick", index: 0 });
  });

  it("never traps Tab when there are several choices, or going backward", () => {
    expect(commandMenuKeyAction(press("Tab"), 2, 0)).toEqual({ type: "dismiss", keepKey: true });
    expect(commandMenuKeyAction(press("Tab", true), 1, 0)).toEqual({ type: "dismiss", keepKey: true });
  });

  it("closes on Escape and uses the key up", () => {
    expect(commandMenuKeyAction(press("Escape"), 2, 0)).toEqual({ type: "dismiss", keepKey: false });
  });

  it("ignores every other key", () => {
    expect(commandMenuKeyAction(press("a"), 2, 0)).toBeNull();
  });
});
