import { expect, test } from "vitest";
import {
  REDLINE_LIMITS,
  computeDraftRedline,
  extractRedlineBlocks,
  sanitizeDocumentHtml,
  sanitizeStyleAttribute,
} from "./draftRedline";

test("sanitizes active content and unsafe attributes before comparison", () => {
  const sanitized = sanitizeDocumentHtml(
    '<p onclick="steal()" style="color:red">Safe <strong>text</strong></p>' +
      '<script>window.hacked = true;</script>' +
      '<a href="javascript:steal()">Unsafe link</a>',
  );

  expect(sanitized).toContain("Safe <strong>text</strong>");
  expect(sanitized).toContain("Unsafe link");
  expect(sanitized).not.toContain("<script");
  expect(sanitized).not.toContain("onclick");
  // Toolbar text color is legitimate formatting and must survive reload.
  expect(sanitized).toContain('style="color: red"');
  expect(sanitized).not.toContain("javascript:");
});

test("keeps toolbar formatting styles and drops everything else", () => {
  expect(
    sanitizeStyleAttribute(
      "color: #b91c1c; background-color: rgb(253, 230, 138); text-align: center; font-size: 19px",
    ),
  ).toBe("color: #b91c1c; background-color: rgb(253, 230, 138); text-align: center; font-size: 19px");
  expect(
    sanitizeStyleAttribute(
      "position: fixed; color: url(https://evil.example/x); background-image: url(x); font-size: 400vw; text-align: start",
    ),
  ).toBe("");
});

test("stored formatting survives a sanitize round-trip", () => {
  const stored =
    '<p style="text-align: right"><s>done</s> <sub>2</sub> ' +
    '<span style="background-color: #fde68a">key point</span> ' +
    '<span style="font-size: 24px">big</span> ' +
    '<a href="https://example.com">source</a></p>';
  const sanitized = sanitizeDocumentHtml(stored);

  expect(sanitized).toContain('style="text-align: right"');
  expect(sanitized).toContain("<s>done</s>");
  expect(sanitized).toContain("<sub>2</sub>");
  expect(sanitized).toContain("background-color: #fde68a");
  expect(sanitized).toContain("font-size: 24px");
  expect(sanitized).toContain('href="https://example.com"');
});

test("AI edit provenance survives storage while other data attributes do not", () => {
  const sanitized = sanitizeDocumentHtml(
    '<p class="document-ai-suggestion" data-ai-edit-at="2026-08-11T20:31:00.000Z" ' +
      'data-ai-edit-by="Client Update Agent" data-tracking-id="nope">Revised sentence.</p>',
  );

  // The AI edit trail reads these back after a reload, so they are allowlisted.
  expect(sanitized).toContain('data-ai-edit-at="2026-08-11T20:31:00.000Z"');
  expect(sanitized).toContain('data-ai-edit-by="Client Update Agent"');
  expect(sanitized).toContain('class="document-ai-suggestion"');
  expect(sanitized).not.toContain("data-tracking-id");
});

test("extracts document structure while excluding page-navigation chrome", () => {
  const blocks = extractRedlineBlocks(
    sanitizeDocumentHtml(
      '<section class="document-page">' +
        '<span class="document-page-label">Page 1</span>' +
        '<h2>Client update</h2>' +
        '<p>Discovery closes Friday.</p>' +
        '<ul><li>Confirm the approval owner.</li></ul>' +
        '<img src="https://example.com/chart.png" alt="Matter chart">' +
        '<hr class="document-page-break">' +
        "</section>",
    ),
  );

  expect(blocks.map(({ kind, label, text, detail }) => ({ kind, label, text, detail }))).toEqual([
    { kind: "text", label: "Heading", text: "Client update", detail: undefined },
    {
      kind: "text",
      label: "Paragraph",
      text: "Discovery closes Friday.",
      detail: undefined,
    },
    {
      kind: "text",
      label: "List item",
      text: "Confirm the approval owner.",
      detail: undefined,
    },
    { kind: "media", label: "Image", text: "", detail: "Matter chart" },
    { kind: "media", label: "Page break", text: "", detail: undefined },
  ]);
});

test("reports a complete word-level redline for a bounded paragraph change", () => {
  const result = computeDraftRedline(
    "<h1>Status</h1><p>The hearing is Friday morning.</p>",
    "<h1>Status</h1><p>The hearing is Monday morning.</p>",
  );

  expect(result.mode).toBe("word");
  expect(result.fallbackReason).toBeNull();
  expect(result.stats).toEqual({ unchanged: 1, inserted: 0, removed: 0, changed: 1 });
  expect(result.summary).toContain("1 changed block");
  expect(result.rows[1]).toMatchObject({
    type: "changed",
    tokens: [
      { type: "same", text: "The hearing is" },
      { type: "del", text: "Friday" },
      { type: "ins", text: "Monday" },
      { type: "same", text: "morning." },
    ],
  });
});

test("keeps media changes at whole-block granularity", () => {
  const result = computeDraftRedline(
    '<figure><img src="https://example.com/old.png" alt="Old chart"></figure>',
    '<figure><img src="https://example.com/new.png" alt="New chart"></figure>',
  );

  expect(result.mode).toBe("word");
  expect(result.stats).toEqual({ unchanged: 0, inserted: 1, removed: 1, changed: 0 });
  expect(result.rows.map((row) => row.type)).toEqual(["removed", "inserted"]);
});

test("falls back honestly to block-only output when a version exceeds the character cap", () => {
  const oversized = `Before ${"word ".repeat(REDLINE_LIMITS.maxCharsPerVersion / 5)}`;
  const result = computeDraftRedline(`<p>${oversized}</p>`, "<p>After</p>");

  expect(result.mode).toBe("block-only");
  expect(result.fallbackReason).toMatch(/character limit/i);
  expect(result.summary).toMatch(/block-level changes only/i);
  expect(result.rows.map((row) => row.type)).toEqual(["removed", "inserted"]);
  expect(result.stats.changed).toBe(0);
});

test("identical versions produce an accessible no-change summary", () => {
  const result = computeDraftRedline("<p>Same saved version.</p>", "<p>Same saved version.</p>");

  expect(result.stats).toEqual({ unchanged: 1, inserted: 0, removed: 0, changed: 0 });
  expect(result.summary).toBe(
    "Visual redline: the selected versions are identical at every compared block.",
  );
});
