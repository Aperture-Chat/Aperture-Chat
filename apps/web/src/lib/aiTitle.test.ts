import { describe, expect, it } from "vitest";
import { cleanAiTitle } from "./aiTitle";

describe("cleanAiTitle", () => {
  it.each([
    ["## Engagement summary\n\nHere is a synthetic reply.", "Engagement summary"],
    ["# Q3 Budget Review", "Q3 Budget Review"],
    ["**Vendor NDA Checklist**", "Vendor NDA Checklist"],
    ["__Vendor NDA Checklist__", "Vendor NDA Checklist"],
    ["*Matter intake plan*", "Matter intake plan"],
    ["Title: Vendor NDA Checklist", "Vendor NDA Checklist"],
    ["**Title:** Vendor NDA Checklist", "Vendor NDA Checklist"],
    ["- Matter intake plan", "Matter intake plan"],
    ["> ## Contract renewal notes", "Contract renewal notes"],
    ["`Q3` budget review", "Q3 budget review"],
    ["[Vendor NDA](https://example.test/nda) checklist", "Vendor NDA checklist"],
    [' "Vendor NDA Checklist Drafting." ', "Vendor NDA Checklist Drafting"],
  ])("drops the markdown a model sent anyway: %j", (raw, expected) => {
    expect(cleanAiTitle(raw)).toBe(expected);
  });

  it.each(["C# migration plan", "Issue #42 triage", "Rate * volume model", "snake_case naming rules"])(
    "keeps symbols that are not markdown: %s",
    (plain) => {
      expect(cleanAiTitle(plain)).toBe(plain);
    },
  );

  it("caps the name at 160 characters", () => {
    expect(cleanAiTitle("Budget ".repeat(40))).toHaveLength(160);
  });
});

describe("cleanAiTitle with nothing usable", () => {
  it("returns an empty name for an empty or blank reply", () => {
    expect(cleanAiTitle("")).toBe("");
    expect(cleanAiTitle("\n  \n")).toBe("");
  });
});

describe("cleanAiTitle with bare markers", () => {
  it("skips a line that is only a markdown marker and names from the next line", () => {
    expect(cleanAiTitle("## ")).toBe("");
    expect(cleanAiTitle("-")).toBe("");
    expect(cleanAiTitle("##\nEngagement summary")).toBe("Engagement summary");
  });
});
