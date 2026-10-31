import { describe, expect, it, test } from "vitest";
import { appendChatCitationsForDraft } from "./draftCitations";
import type { ChatCitation } from "./types";

test("citation metadata transfers as written-out sources with names and full URLs", () => {
  const result = appendChatCitationsForDraft("Report body.", [
    {
      id: "c1",
      source_name: "FIFA standings",
      source_type: "web",
      source_uri: "https://www.fifa.com/standings",
      snippet: "Live bracket",
    },
    { id: "c2", source_name: "Offline memo", source_type: "knowledge", source_uri: "", snippet: "" },
  ]);
  expect(result).toContain("## Sources");
  expect(result).toContain(
    "1. **FIFA standings** — [https://www.fifa.com/standings](https://www.fifa.com/standings) — Live bracket",
  );
  expect(result).toContain("2. Offline memo");
});

test("replies that cite inline get their linked sources written out and deduplicated", () => {
  const content = [
    "France reached the semifinal. ([fifa.com](https://fifa.com/a))",
    "Odds favor France. ([sports.yahoo.com](https://yahoo.com/b))",
    "FIFA also noted records. ([fifa.com](https://fifa.com/a))",
    "![Kylian Mbappé](https://commons.wikimedia.org/photo.jpg)",
  ].join("\n\n");
  const result = appendChatCitationsForDraft(content);
  expect(result).toContain("## Sources");
  expect(result).toContain("1. **fifa.com** — [https://fifa.com/a](https://fifa.com/a)");
  expect(result).toContain("2. **sports.yahoo.com** — [https://yahoo.com/b](https://yahoo.com/b)");
  expect(result).not.toContain("3.");
  expect(result).not.toContain("commons.wikimedia.org/photo.jpg](");
});

test("replies without any citations transfer unchanged", () => {
  expect(appendChatCitationsForDraft("Plain reply, no links.")).toBe("Plain reply, no links.");
});

describe("sources a reply only consulted", () => {
  const web = (fields: Partial<ChatCitation>): ChatCitation => ({
    id: "w",
    source_name: "Article",
    source_type: "web",
    source_uri: "https://example.com/a",
    snippet: "",
    ...fields,
  });

  it("are not listed as sources of the draft", () => {
    const content = appendChatCitationsForDraft("Body.", [
      web({ id: "w1", source_name: "Cited one", cited: true }),
      web({ id: "w2", source_name: "Only consulted", source_uri: "https://example.com/b", cited: false }),
    ]);
    expect(content).toContain("Cited one");
    expect(content).not.toContain("Only consulted");
    expect(content).toContain("1. **Cited one**");
  });

  it("leave no empty section when nothing else was cited", () => {
    expect(appendChatCitationsForDraft("Body.", [web({ cited: false })])).toBe("Body.");
  });

  it("keep rows with no record either way", () => {
    expect(appendChatCitationsForDraft("Body.", [web({ cited: null })])).toContain("## Sources");
  });
});
