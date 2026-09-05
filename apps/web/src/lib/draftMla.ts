/** MLA is a document format, not a theme. Keep semantic markers on every
 * block so pagination, storage, printing, and Word share the same contract. */
export function formatMlaDocument(html: string, request: string): string {
  if (!/\bMLA\b/i.test(request) && !html.includes('document-mla-')) return html;
  const root = document.createElement('template');
  root.innerHTML = html;
  const blocks = Array.from(root.content.querySelectorAll<HTMLElement>('p,h1,h2,h3,li,blockquote'));
  const student = blocks.findIndex((node) => /^\[Student(?: Name)?\]$/i.test(node.textContent?.trim() ?? ''));
  // Only discard a positively identified model preamble before a student
  // heading. Never infer that arbitrary opening prose is disposable.
  if (student > 0 && /validator|here is (?:the|your) (?:complete )?paper/i.test(blocks.slice(0, student).map(n => n.textContent).join(' '))) {
    for (const block of blocks.slice(0, student)) block.remove();
    root.content.querySelectorAll('ul,ol').forEach(n => { if (!n.textContent?.trim()) n.remove(); });
  }
  let headingLines = 0;
  let bodyStarted = false;
  let bibliography = false;
  for (const node of Array.from(root.content.querySelectorAll<HTMLElement>('p,h1,h2,h3,li,blockquote'))) {
    let text = node.textContent?.trim() ?? '';
    // Some providers emit a centered HTML title inside Markdown. It reaches
    // us as escaped text; extract only the literal title, never execute markup.
    const literalTitle = /^<(?:p|div)\s+(?:align=["']center["']|style=["']text-align:\s*center;?["'])>([^<>]+)<\/(?:p|div)>$/i.exec(text);
    if (literalTitle) { node.textContent = literalTitle[1]; text = literalTitle[1]; }

    if (/^(?:The (?:two )?validator findings|No verifiable direct image URL).*validator/i.test(text)) { node.remove(); continue; }
    const heading = /^H[1-3]$/.test(node.tagName);
    const worksCited = /^Works? Cited$/i.test(text);
    const title = !bodyStarted && (heading || headingLines >= 4 || Boolean(literalTitle));
    node.classList.add('document-mla-text');
    node.style.fontFamily = 'Times New Roman';
    node.style.fontSize = '12pt';
    if (title || worksCited) {
      node.classList.add('document-mla-title');
      node.style.textAlign = 'center';
    } else if (!bodyStarted) node.classList.add('document-mla-heading');
    else if (bibliography) node.classList.add('document-mla-reference');
    else if (!heading) node.classList.add('document-mla-body');
    if (!bodyStarted && !title) headingLines += Math.max(1, node.querySelectorAll('br').length + 1, text.split(/\n/).length);
    if (title || heading) bodyStarted = true;
    if (worksCited) {
      bibliography = true;
      if (!node.previousElementSibling?.matches('hr.document-page-break')) {
        const pageBreak = document.createElement('hr');
        pageBreak.className = 'document-page-break';
        node.before(pageBreak);
      }
    }
  }
  return root.innerHTML;
}
