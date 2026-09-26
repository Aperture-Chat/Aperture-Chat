import { expect, test } from "vitest";
import { cleanPastedHtml, plainTextToParagraphHtml } from "./pasteCleanup";

test("pasted HTML keeps structure and emphasis but drops the source's fonts and colors", () => {
  const html = cleanPastedHtml(
    '<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-1">' +
      '<p style="line-height:1.38;margin-top:0pt"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:700">Revenue</span>' +
      '<span style="font-size:11pt;font-family:Arial;color:#000000"> grew </span>' +
      '<span style="font-style:italic;font-family:Arial">quickly</span></p>' +
      '<ul><li style="list-style-type:disc"><span style="font-family:Arial">First</span></li></ul></b>',
  );
  expect(html).toContain("<strong>Revenue</strong>");
  expect(html).toContain("<em>quickly</em>");
  expect(html).toContain("<ul><li>First</li></ul>");
  expect(html).not.toMatch(/font-family|font-size|color|<b\b|docs-internal/);
});

test("pasted alignment survives on blocks, classes from other sites do not", () => {
  const html = cleanPastedHtml('<p class="lead text-muted" style="text-align:center;font-size:20px">Centered</p><div>Loose line</div>');
  expect(html).toBe('<p style="text-align: center;">Centered</p><p>Loose line</p>');
});

test("plain text pastes as paragraphs, and a single line stays inline", () => {
  expect(plainTextToParagraphHtml("One line <b>")).toBe("One line &lt;b&gt;");
  expect(plainTextToParagraphHtml("First para\nsame para\n\nSecond")).toBe(
    "<p>First para<br>same para</p><p>Second</p>",
  );
});
