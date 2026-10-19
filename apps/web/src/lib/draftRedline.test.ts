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

test("formatting carried by documents opened from Word or PDF survives storage", () => {
  const imported =
    '<div class="document-page-setup" style="width: 612pt; height: 792pt; padding-top: 72pt; margin-top: 36pt; font-family: \'Times New Roman\', serif; line-height: 1.241"></div>' +
    '<p dir="rtl" style="margin-top: 17.69px; margin-bottom: 0px; margin-left: -12px; text-indent: -53.06px; line-height: 22.11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 0.75px solid #000000; padding-bottom: 2px">' +
    '<span class="document-tab document-tab-right document-tab-at-9360" style="display: inline-block; width: 580px; border-bottom: 1.5px dotted currentcolor">\t</span>' +
    '<span style="font-variant: small-caps; font-family: Calibri, Carlito, Arial, sans-serif">Firm</span></p>' +
    '<table style="width: 515.89px; border-collapse: collapse; table-layout: fixed; margin: 0px auto"><colgroup><col style="width: 294.8px" span="1"></colgroup>' +
    '<tbody><tr style="height: 19.31px"><td colspan="2" style="padding: 0px 7.96px; vertical-align: middle; border-top: 1px solid rgb(0, 0, 0)">x</td></tr></tbody></table>' +
    '<ol start="3" type="a"><li value="5">item</li></ol>';
  const sanitized = sanitizeDocumentHtml(imported);

  for (const fragment of [
    "width: 612pt",
    "padding-top: 72pt",
    "margin-top: 36pt",
    "font-family: 'Times New Roman', serif",
    "line-height: 1.241",
    'dir="rtl"',
    "margin-left: -12px",
    "text-indent: -53.06px",
    "font-weight: 600",
    "text-transform: uppercase",
    "letter-spacing: 0.5px",
    "border-bottom: 0.75px solid #000000",
    "display: inline-block",
    "border-bottom: 1.5px dotted currentcolor",
    "font-variant: small-caps",
    "font-family: Calibri, Carlito, Arial, sans-serif",
    "table-layout: fixed",
    "margin: 0px auto",
    'span="1"',
    "height: 19.31px",
    "vertical-align: middle",
    "border-top: 1px solid rgb(0, 0, 0)",
    'start="3"',
    'type="a"',
    'value="5"',
  ]) {
    expect(sanitized).toContain(fragment);
  }
});

test("layout properties outside the allowlist or with unsafe values are dropped", () => {
  expect(sanitizeStyleAttribute("display: none; position: absolute; width: 10px")).toBe("width: 10px");
  expect(sanitizeStyleAttribute("border: 1px solid url(x); margin-left: expression(1)")).toBe("");
  expect(sanitizeStyleAttribute("line-height: 99; padding: 1px 2px 3px 4px 5px")).toBe("");
  const html = sanitizeDocumentHtml('<p dir="sideways">x</p><ol start="1e9" type="z"><li>y</li></ol>');
  expect(html).toBe("<p>x</p><ol><li>y</li></ol>");
});

test("borders re-serialized by the browser without a color stay intact", () => {
  // Chrome writes "1.5px dotted" for a currentcolor border after any CSSOM
  // edit to the element's style (tab spacers are resized that way).
  expect(sanitizeStyleAttribute("display: inline-block; width: 580px; border-bottom: 1.5px dotted")).toBe(
    "display: inline-block; width: 580px; border-bottom: 1.5px dotted",
  );
  expect(sanitizeStyleAttribute("border-top: solid")).toBe("border-top: solid");
  expect(sanitizeStyleAttribute("border-top: 1px wavy red")).toBe("");
});
