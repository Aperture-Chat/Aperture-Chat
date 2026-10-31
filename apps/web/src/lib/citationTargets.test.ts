import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  citationDestination,
  citationLocationLabel,
  citationWebHost,
  markerEntryLabel,
  parseMarkerBracket,
  planMarkerBracket,
} from "./citationTargets";
import type { ChatCitation } from "./types";

const NO_HINTS = { passage: null, pageHint: null };

function citation(fields: Partial<ChatCitation> = {}): ChatCitation {
  return { id: "c1", source_name: "Handbook.pdf", source_type: "upload", source_uri: "upload://1", snippet: "text", ...fields };
}

describe("citationDestination", () => {
  it("opens a knowledge citation in the viewer by its ids", () => {
    expect(
      citationDestination(citation({ document_id: "doc-1", knowledge_config_id: "kb-1", chunk_id: "chunk-1" })),
    ).toEqual({ kind: "viewer", request: { kind: "document", configId: "kb-1", documentId: "doc-1", chunkId: "chunk-1", ...NO_HINTS } });
  });

  it("carries the sentence and the page as hints for the viewer", () => {
    const destination = citationDestination(
      citation({ document_id: "d", knowledge_config_id: "k", chunk_id: "c", passage: "The cited words.", page_start: 40 }),
    );
    expect(destination).toMatchObject({ request: { passage: "The cited words.", pageHint: 40 } });
  });

  it("drops hints of the wrong type from a stored citation", () => {
    const hostile = citation({ chunk_id: "c" }) as unknown as Record<string, unknown>;
    hostile.passage = { text: "x" };
    hostile.page_start = "5";
    expect(citationDestination(hostile as unknown as ChatCitation)).toMatchObject({ request: NO_HINTS });
    expect(citationDestination(citation({ chunk_id: "c", page_start: 0 }))).toMatchObject({ request: NO_HINTS });
    expect(citationDestination(citation({ chunk_id: "c", page_start: 1.5 }))).toMatchObject({ request: NO_HINTS });
  });

  it("opens a knowledge document with no chunk at the top", () => {
    expect(citationDestination(citation({ document_id: "doc-1", knowledge_config_id: "kb-1" }))).toEqual({
      kind: "viewer",
      request: { kind: "document", configId: "kb-1", documentId: "doc-1", chunkId: null, ...NO_HINTS },
    });
  });

  it("opens a crawled knowledge page in the viewer even though its type is web", () => {
    const destination = citationDestination(
      citation({
        source_type: "web",
        source_uri: "https://example.com/policy",
        document_id: "doc-1",
        knowledge_config_id: "kb-1",
        chunk_id: "chunk-1",
      }),
    );
    expect(destination.kind).toBe("viewer");
  });

  it("resolves an old citation through its chunk id", () => {
    expect(citationDestination(citation({ chunk_id: "chunk-1" }))).toEqual({
      kind: "viewer",
      request: { kind: "chunk", chunkId: "chunk-1", ...NO_HINTS },
    });
  });

  it("does not take half a pair of ids", () => {
    expect(citationDestination(citation({ document_id: "doc-1", chunk_id: "chunk-1" }))).toEqual({
      kind: "viewer",
      request: { kind: "chunk", chunkId: "chunk-1", ...NO_HINTS },
    });
    expect(citationDestination(citation({ knowledge_config_id: "kb-1" }))).toEqual({ kind: "none" });
  });

  it("keeps a web result as a link", () => {
    expect(citationDestination(citation({ source_type: "web", source_uri: "https://www.example.com/a" }))).toEqual({
      kind: "link",
      href: "https://www.example.com/a",
      host: "example.com",
    });
  });

  it("opens a live-page chunk by its URL, never the viewer", () => {
    expect(
      citationDestination(
        citation({
          source_type: "web",
          source_uri: "https://example.com/live",
          chunk_id: "live-abc",
          document_id: "doc-1",
          knowledge_config_id: "kb-1",
        }),
      ),
    ).toEqual({ kind: "link", href: "https://example.com/live", host: "example.com" });
  });

  it("does not send a live chunk to the location route when it has no URL", () => {
    expect(citationDestination(citation({ source_type: "web", source_uri: "", chunk_id: "live-abc" }))).toEqual({
      kind: "none",
    });
  });

  it("keeps an old crawled page as a link rather than the location route", () => {
    expect(
      citationDestination(citation({ source_type: "web", source_uri: "https://example.com/a", chunk_id: "chunk-1" })).kind,
    ).toBe("link");
  });

  it("gives a plain upload nowhere to go", () => {
    expect(citationDestination(citation())).toEqual({ kind: "none" });
  });

  it("never links an unsafe scheme from a stored citation", () => {
    expect(citationDestination(citation({ source_type: "web", source_uri: "javascript:alert(1)" }))).toEqual({
      kind: "none",
    });
  });

  it("ignores ids that are not strings", () => {
    const hostile = citation({ source_type: "web", source_uri: "" }) as unknown as Record<string, unknown>;
    hostile.document_id = { toString: () => "doc" };
    hostile.knowledge_config_id = 7;
    hostile.chunk_id = ["chunk"];
    expect(citationDestination(hostile as unknown as ChatCitation)).toEqual({ kind: "none" });
  });

  it("treats empty ids as missing", () => {
    expect(citationDestination(citation({ document_id: "", knowledge_config_id: "", chunk_id: "" }))).toEqual({
      kind: "none",
    });
  });
});

describe("citationWebHost", () => {
  it("names http and https hosts without www", () => {
    expect(citationWebHost("http://www.example.com/a")).toBe("example.com");
    expect(citationWebHost("https://docs.example.com")).toBe("docs.example.com");
  });

  it("rejects everything else", () => {
    expect(citationWebHost("upload://file")).toBeNull();
    expect(citationWebHost("not a url")).toBeNull();
  });
});

describe("citationLocationLabel", () => {
  it("uses the stored locator for slides and sheets", () => {
    expect(citationLocationLabel(citation({ locator: "Slide 3" }))).toBe("Slide 3");
    expect(citationLocationLabel(citation({ locator: "Sheet: Q3" }))).toBe("Sheet: Q3");
  });

  it("writes one page from the page numbers", () => {
    expect(citationLocationLabel(citation({ page_start: 40, page_end: 40 }))).toBe("Page 40");
    expect(citationLocationLabel(citation({ page_start: 40 }))).toBe("Page 40");
    expect(citationLocationLabel(citation({ page_end: 41 }))).toBe("Page 41");
  });

  it("prefers the locator for a single page", () => {
    expect(citationLocationLabel(citation({ page_start: 2, page_end: 2, locator: "Attachment: a.pdf, Page 2" }))).toBe(
      "Attachment: a.pdf, Page 2",
    );
  });

  it("writes a range when the passage crosses pages", () => {
    expect(citationLocationLabel(citation({ page_start: 40, page_end: 42, locator: "Page 40" }))).toBe("Pages 40–42");
  });

  it("never invents a page", () => {
    expect(citationLocationLabel(citation())).toBeNull();
    expect(citationLocationLabel(citation({ page_start: null, page_end: null, locator: null }))).toBeNull();
  });

  it("does not treat page zero as missing", () => {
    expect(citationLocationLabel(citation({ page_start: 0, page_end: 0 }))).toBe("Page 0");
  });
});

describe("parseMarkerBracket", () => {
  const { forms } = JSON.parse(
    readFileSync(
      createRequire(`${process.cwd()}/`).resolve("../../services/api/tests/fixtures/citation_marker_forms.json"),
      "utf8",
    ),
  ) as { forms: Array<{ bracket: string; markers: string[] }> };

  const labels = (bracket: string) =>
    parseMarkerBracket(bracket).flatMap(({ letter, first, last }) =>
      Array.from({ length: last - first + 1 }, (_, offset) => `${letter}${first + offset}`),
    );

  // The same list the server's test reads.
  it.each(forms)("reads $bracket as the server does", ({ bracket, markers }) => {
    expect(labels(bracket)).toEqual(markers);
  });

  it("keeps a reversed range in reading order", () => {
    expect(parseMarkerBracket("[K3-K1]")).toEqual([{ letter: "K", first: 1, last: 3 }]);
  });

  it("keeps both ends of a range across letters", () => {
    expect(parseMarkerBracket("[K1-W2]")).toEqual([
      { letter: "K", first: 1, last: 1 },
      { letter: "W", first: 2, last: 2 },
    ]);
  });

  it("does not build a list from a hostile range", () => {
    expect(parseMarkerBracket("[K1-K999999]")).toEqual([{ letter: "K", first: 1, last: 999999 }]);
  });

  it("reads a long list", () => {
    const list = Array.from({ length: 23 }, (_, index) => `K${index + 1}`).join(", ");
    expect(parseMarkerBracket(`[${list}]`)).toHaveLength(23);
  });
});

describe("markerEntryLabel", () => {
  it("writes one number or a range", () => {
    expect(markerEntryLabel({ letter: "K", first: 2, last: 2 })).toBe("K2");
    expect(markerEntryLabel({ letter: "W", first: 1, last: 3 })).toBe("W1–W3");
  });
});

describe("planMarkerBracket", () => {
  const citations = [
    citation({ id: "k1", k_index: 1 }),
    citation({ id: "k3", k_index: 3 }),
    citation({ id: "w2", source_type: "web", w_index: 2 }),
    citation({ id: "u1", source_type: "web", u_index: 1 }),
    citation({ id: "plain" }),
  ];
  const plan = (inner: string, list = citations) => planMarkerBracket(parseMarkerBracket(`[${inner}]`), list);
  const shown = (inner: string, list = citations) => plan(inner, list).matched.map(({ label }) => label);

  it("matches each letter by its own number", () => {
    expect(plan("K1").matched.map(({ citation: item }) => item.id)).toEqual(["k1"]);
    expect(plan("W2").matched.map(({ citation: item }) => item.id)).toEqual(["w2"]);
    expect(plan("U1").matched.map(({ citation: item }) => item.id)).toEqual(["u1"]);
  });

  it("drops a number that does not exist when that letter is in use", () => {
    expect(plan("K2")).toEqual({ matched: [], foreign: [] });
    expect(plan("W9")).toEqual({ matched: [], foreign: [] });
  });

  it("leaves a letter this reply never used as written", () => {
    const onlyKnowledge = [citation({ k_index: 1 })];
    expect(plan("W2", onlyKnowledge)).toEqual({ matched: [], foreign: [{ letter: "W", first: 2, last: 2 }] });
    expect(plan("K1", [])).toEqual({ matched: [], foreign: [{ letter: "K", first: 1, last: 1 }] });
  });

  it("counts page zero as in use, and no index as not", () => {
    expect(plan("K1", [citation({ k_index: 0 })]).foreign).toEqual([]);
    expect(plan("K1", [citation({ k_index: null })]).foreign).toHaveLength(1);
  });

  it("splits a bracket that mixes both", () => {
    const onlyKnowledge = [citation({ k_index: 1 })];
    const { matched, foreign } = plan("K1, W2", onlyKnowledge);
    expect(matched.map(({ label }) => label)).toEqual(["K1"]);
    expect(foreign).toEqual([{ letter: "W", first: 2, last: 2 }]);
  });

  it("fills a range from the citations that exist, in order", () => {
    expect(shown("K1-K3")).toEqual(["K1", "K3"]);
    expect(shown("K3-K1")).toEqual(["K1", "K3"]);
    expect(shown("K1-K999999")).toEqual(["K1", "K3"]);
  });

  it("lists a number written twice once", () => {
    expect(shown("K1, K1")).toEqual(["K1"]);
    expect(shown("K1, K1-K3")).toEqual(["K1", "K3"]);
  });

  it("does not match a K number against a W number", () => {
    expect(shown("K2")).toEqual([]);
    expect(shown("W1")).toEqual([]);
  });
});
