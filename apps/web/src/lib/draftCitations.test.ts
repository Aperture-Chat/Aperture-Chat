import { expect, test } from "vitest";
import { appendChatCitationsForDraft } from "./draftCitations";

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
