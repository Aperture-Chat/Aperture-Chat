import { mergeSplitContinuationBlocks } from "./docxExport";

/** Page numbers belong to editor chrome, never editable or exported body text. */
export function removeDraftPageLabels(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll(".document-page-label").forEach(node => node.remove());
  template.content.querySelectorAll("p, span, h1, h2, h3, h4, h5, h6").forEach(node => {
    // Keep quotations, source references, and table cells exactly as authored.
    if (node.closest("blockquote, pre, code, table, a")) return;
    const paragraph = node.closest("p, li");
    const isPageLabel = (text: string) => /^\s*Page\s+\d+(?:\s+of\s+\d+)?\s*$/i.test(text);
    if (isPageLabel(node.textContent ?? "") && (!paragraph || isPageLabel(paragraph.textContent ?? ""))) {
      node.remove();
      return;
    }
    if (!/^H[1-6]$/.test(node.tagName)) return;
    const prefix = (node.textContent ?? "").match(/^\s*Page\s+\d+\s*[—–:\-]\s*/i)?.[0];
    if (!prefix) return;
    // Remove only the prefix, retaining links and formatting in the title.
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let remaining = prefix.length;
    let text: Node | null;
    while ((text = walker.nextNode())) {
      if (remaining > (text.textContent?.length ?? 0)) {
        remaining -= text.textContent?.length ?? 0;
        continue;
      }
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(text, remaining);
      range.deleteContents();
      break;
    }
  });
  return template.innerHTML;
}

/** Persist authored content and manual breaks; reconstruct automatic pages on open. */
export function draftHtmlForAccount(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = removeDraftPageLabels(html);
  mergeSplitContinuationBlocks(template.content);
  template.content.querySelectorAll("section.document-page").forEach(page => {
    if (page.getAttribute("data-page-break-before") === "manual") {
      const marker = document.createElement("hr");
      marker.className = "document-page-break";
      page.before(marker);
    }
    page.replaceWith(...Array.from(page.childNodes));
  });
  return template.innerHTML;
}
