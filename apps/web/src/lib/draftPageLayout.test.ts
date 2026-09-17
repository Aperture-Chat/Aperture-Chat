import { expect, test } from "vitest";
import { draftHtmlForAccount, removeDraftPageLabels } from "./draftPageLayout";

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
