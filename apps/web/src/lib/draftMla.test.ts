import { expect, test } from 'vitest';
import { formatMlaDocument } from './draftMla';
import { sanitizeDocumentHtml } from './draftRedline';

test('MLA removes identified validator preamble and marks heading, body and references', () => {
  const html = formatMlaDocument('<p>The validator has repeated findings.</p><ul><li>No code block.</li></ul><p>Here is the complete paper.</p><p>[Student Name]</p><p>Teacher</p><p>History</p><p>[Date]</p><h2>Crossing the River</h2><p>The crossing changed the campaign (Fischer 42).</p><h2>Works Cited</h2><p>Fischer. Washington’s Crossing. Oxford, 2004.</p>', 'Write an MLA paper');
  const root = document.createElement('div'); root.innerHTML = sanitizeDocumentHtml(html);
  expect(root.firstElementChild?.textContent).toBe('[Student Name]');
  expect(root.textContent).not.toContain('validator');
  expect(root.querySelector('.document-mla-title')?.textContent).toBe('Crossing the River');
  expect(root.querySelector('.document-mla-body')?.getAttribute('style')).toContain('12pt');
  expect(root.querySelectorAll('.document-mla-reference')).toHaveLength(1);
});

test('does not strip an ordinary introduction or format non-MLA documents', () => {
  const original = '<p>An introduction about a validator.</p><h1>Technical Guide</h1>';
  expect(formatMlaDocument(original, 'Write a guide')).toBe(original);
  expect(formatMlaDocument(original, 'MLA')).toContain('An introduction about a validator.');
});

test('a provider title emitted as escaped HTML becomes a plain centered title', () => {
  const html = formatMlaDocument('<p>Alex Example</p><p>Taylor Example</p><p>History 101</p><p>5 September 2026</p><p>&lt;p align="center"&gt;Practice Paper&lt;/p&gt;</p><p>First paragraph.</p>', 'MLA');
  const root = document.createElement('div'); root.innerHTML = html;
  expect(root.querySelector('.document-mla-title')?.textContent).toBe('Practice Paper');
  expect(root.querySelector('.document-mla-body')?.textContent).toBe('First paragraph.');
});
