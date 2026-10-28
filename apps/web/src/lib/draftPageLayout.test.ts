import { expect, test } from "vitest";
import { draftHtmlForAccount, reflowSavedVersions, removeDraftPageLabels } from "./draftPageLayout";

test("removes layout labels and heading prefixes while preserving content, links, and quoted references", () => {
  const html = '<span class="document-page-label">Page 9</span><h2><strong>Page 4 — </strong><a href="https://example.com">Launch vehicle</a></h2><p>See <span>Page 6</span> in the report.</p><blockquote><p>Page 8</p></blockquote><p>Page 10</p>';
  const cleaned = removeDraftPageLabels(html);
  expect(cleaned).not.toContain('document-page-label');
  expect(cleaned).not.toContain('Page 4 —');
  expect(cleaned).toContain('<a href="https://example.com">Launch vehicle</a>');
  expect(cleaned).toContain('<p>See <span>Page 6</span> in the report.</p>');
  expect(cleaned).toContain('<blockquote><p>Page 8</p></blockquote>');
  expect(cleaned).not.toContain('Page 10');
});

test("account saves contain no automatic page chrome and retain explicit breaks", () => {
  const html = '<section class="document-page" data-page-number="1"><p>First.</p></section><section class="document-page" data-page-number="2"><p>Flow continuation.</p></section><section class="document-page" data-page-break-before="manual" data-page-number="3"><p>After a manual break.</p></section>';
  expect(draftHtmlForAccount(html)).toBe('<p>First.</p><p>Flow continuation.</p><hr class="document-page-break"><p>After a manual break.</p>');
});


test("account saves rejoin paragraphs split only by automatic layout", () => {
  const html = '<section class="document-page"><p>The original </p></section><section class="document-page"><p data-split-continuation="true"><strong>paragraph</strong> continues.</p></section>';
  expect(draftHtmlForAccount(html)).toBe('<p>The original <strong>paragraph</strong> continues.</p>');
});

test("text in a document opened from Word or PDF is authored, never a page label", () => {
  const html =
    '<div class="document-page-setup" style="width: 612pt"><div class="document-page-footer"><p>Page <span class="document-field-page">2</span> of 9</p></div></div>' +
    '<section class="document-page"><span class="document-page-label">Page 1</span><p>Page 10</p></section>';
  const cleaned = removeDraftPageLabels(html);
  expect(cleaned).not.toContain("document-page-label");
  expect(cleaned).toContain("<p>Page 10</p>");
  expect(cleaned).toContain('Page <span class="document-field-page">2</span> of 9');
  expect(draftHtmlForAccount(html).startsWith('<div class="document-page-setup"')).toBe(true);
});

test("re-joining a split paragraph drops empty formatting shells", () => {
  const html =
    '<section class="document-page"><p>The <span style="font-weight: 500">original</span><span style="font-weight: 500"></span></p></section>' +
    '<section class="document-page"><p data-split-continuation="true"><span style="font-weight: 500"></span> continues.</p></section>';
  expect(draftHtmlForAccount(html)).toBe('<p>The <span style="font-weight: 500">original</span> continues.</p>');
});

test("a version saved while its page reflow was measuring takes the reflowed layout too", () => {
  // Clicking Save version blurs the editor, which schedules a reflow of the
  // HTML that the new version is about to hold.
  const before = '<section class="document-page"><p>Plan.</p></section>';
  const reflowed = '<section class="document-page" data-page-number="1"><p>Plan.</p></section>';
  const versions = [
    { id: "version-1", content: "<p>Older draft.</p>" },
    { id: "version-2", content: before },
  ];
  expect(reflowSavedVersions(versions, before, reflowed)).toEqual([
    { id: "version-1", content: "<p>Older draft.</p>" },
    { id: "version-2", content: reflowed },
  ]);
});
