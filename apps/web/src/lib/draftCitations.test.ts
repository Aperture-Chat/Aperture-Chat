import { describe, expect, it, test } from "vitest";
import { appendChatCitationsForDraft, plainDraftCitations } from "./draftCitations";
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

test("a chat reply moved to Drafts keeps its sources and loses its chat markers", () => {
  const result = appendChatCitationsForDraft("The fee is four percent. [K1]", [
    {
      id: "c1",
      k_index: 1,
      source_name: "Harbor lease.pdf",
      source_type: "upload",
      source_uri: "",
      snippet: "",
      page_start: 3,
      page_end: 3,
    },
  ]);
  expect(result).toContain("The fee is four percent. (Harbor lease, p. 3)");
  expect(result).toContain("## Sources");
  expect(result).not.toMatch(/\[K\d/);
});

test("a chat marker with no citation still leaves a transferred reply", () => {
  expect(appendChatCitationsForDraft("A claim. [K1]")).toBe("A claim.");
});

const cite = (k_index: number, source_name: string, page_start: number | null = null, page_end = page_start) =>
  ({ id: `c${k_index}`, k_index, source_name, source_type: "upload", source_uri: "", snippet: "", page_start, page_end }) as ChatCitation;

const LEASE = cite(1, "Harbor lease.pdf", 3);
const NOTE = cite(2, "client_note-final.docx", 1);
const SURVEY = cite(3, "Site Survey.pdf");

describe("plainDraftCitations", () => {
  it("turns a marker into the file and page", () => {
    expect(plainDraftCitations("The fee is four percent. [K1]", [LEASE])).toBe(
      "The fee is four percent. (Harbor lease, p. 3)",
    );
  });

  it("names a passage with no page by its file alone", () => {
    expect(plainDraftCitations("Cracks were found. [K3]", [SURVEY])).toBe("Cracks were found. (Site Survey)");
  });

  it("gives a page range when a passage spans pages", () => {
    expect(plainDraftCitations("Terms [K1]", [cite(1, "Lease.pdf", 3, 5)])).toBe("Terms (Lease, pp. 3-5)");
  });

  it("reads underscores in a file name as spaces", () => {
    expect(plainDraftCitations("Noted. [K2]", [NOTE])).toBe("Noted. (client note-final, p. 1)");
  });

  it("keeps the words around a marker in mid-sentence", () => {
    expect(plainDraftCitations("The fee [K1] applies monthly.", [LEASE])).toBe(
      "The fee (Harbor lease, p. 3) applies monthly.",
    );
  });

  it.each([
    ["[K1, K2]"],
    ["[K1; K2]"],
    ["[K1][K2]"],
    ["[K1] [K2]"],
    ["[K1-K2]"],
    ["[K1–K2]"],
    ["[K1,2]"],
  ])("joins the written form %s into one citation", (marker) => {
    expect(plainDraftCitations(`Both agree. ${marker}`, [LEASE, NOTE])).toBe(
      "Both agree. (Harbor lease, p. 3; client note-final, p. 1)",
    );
  });

  it("names only the sources listed, skipping what lies between them", () => {
    expect(plainDraftCitations("Both. [K1, K3]", [LEASE, NOTE, SURVEY])).toBe("Both. (Harbor lease, p. 3; Site Survey)");
    expect(plainDraftCitations("Both. [K1; K3]", [LEASE, NOTE, SURVEY])).toBe("Both. (Harbor lease, p. 3; Site Survey)");
  });

  it("names everything inside a range", () => {
    expect(plainDraftCitations("All. [K1-K3]", [LEASE, NOTE, SURVEY])).toBe(
      "All. (Harbor lease, p. 3; client note-final, p. 1; Site Survey)",
    );
  });

  it("starts a range at its own first source", () => {
    expect(plainDraftCitations("Two. [K2-K3]", [LEASE, NOTE, SURVEY])).toBe("Two. (client note-final, p. 1; Site Survey)");
  });

  it("says a repeated source once", () => {
    expect(plainDraftCitations("Same. [K1][K1]", [LEASE])).toBe("Same. (Harbor lease, p. 3)");
  });

  it("drops a marker with no real source, and the space before it", () => {
    expect(plainDraftCitations("A hallucinated source. [K9] Next sentence.", [LEASE])).toBe(
      "A hallucinated source. Next sentence.",
    );
  });

  it("keeps the real sources of a group that also names a false one", () => {
    expect(plainDraftCitations("Claim. [K1, K9]", [LEASE])).toBe("Claim. (Harbor lease, p. 3)");
  });

  it("stops a huge range at what could be real", () => {
    const far = cite(51, "Far.pdf");
    const beyond = cite(52, "Beyond.pdf");
    expect(plainDraftCitations("Claim. [K1-K999999]", [LEASE, far, beyond])).toBe(
      "Claim. (Harbor lease, p. 3; Far)",
    );
  });

  it("leaves ordinary brackets alone", () => {
    const text = "See [1], [citation needed], [Kansas], and [K]. Exhibit [K-1] stands.";
    expect(plainDraftCitations(text, [LEASE])).toBe(text);
  });

  it("leaves the text alone when nothing is marked", () => {
    expect(plainDraftCitations("No markers here.", [])).toBe("No markers here.");
  });

  it("keeps a file name safe inside the JSON of a deck or workbook", () => {
    const reply = JSON.stringify({ title: "Terms [K1]" });
    const named = plainDraftCitations(reply, [cite(1, 'The "Harbor" \\ lease.pdf', 2)]);
    expect(JSON.parse(named)).toEqual({ title: "Terms (The Harbor lease, p. 2)" });
  });

  it("works on every line of a long reply", () => {
    expect(plainDraftCitations("One [K1]\n\nTwo [K2]", [LEASE, NOTE])).toBe(
      "One (Harbor lease, p. 3)\n\nTwo (client note-final, p. 1)",
    );
  });

  it("does not run past the end of a line to join markers", () => {
    expect(plainDraftCitations("One [K1]\n[K2] Two", [LEASE, NOTE])).toBe(
      "One (Harbor lease, p. 3)\n(client note-final, p. 1) Two",
    );
  });
});
