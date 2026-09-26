import { sanitizeDocumentHtml } from "./draftRedline";

/**
 * Cleans HTML pasted into the document canvas, like Word's "Merge
 * Formatting": structure (headings, lists, tables, links, images) and
 * emphasis (bold, italic, underline, strikethrough) are kept, while the
 * source page's fonts, sizes, colors, and backgrounds are dropped so pasted
 * text matches the document around it.
 */
export function cleanPastedHtml(html: string): string {
  if (typeof document === "undefined") return sanitizeDocumentHtml(html);
  const template = document.createElement("template");
  template.innerHTML = html
    // Word and Google Docs wrap the clipboard in document chrome.
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?o:p[^>]*>/gi, "");
  promoteStyledEmphasis(template.content);
  const sanitized = sanitizeDocumentHtml(template.innerHTML);
  const cleaned = document.createElement("template");
  cleaned.innerHTML = sanitized;
  cleaned.content.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    const align = element.style.textAlign;
    element.removeAttribute("style");
    if (align && /^(center|right|justify)$/.test(align) && /^(P|H[1-6]|LI|TD|TH)$/.test(element.tagName)) {
      element.style.textAlign = align;
    }
  });
  cleaned.content.querySelectorAll<HTMLElement>("[class]").forEach((element) => {
    const kept = Array.from(element.classList).filter((name) => name.startsWith("document-"));
    if (kept.length) element.className = kept.join(" ");
    else element.removeAttribute("class");
  });
  // Spans that only carried source styling are noise once it is gone.
  cleaned.content.querySelectorAll("span:not([class]):not([style])").forEach((span) => {
    span.replaceWith(...Array.from(span.childNodes));
  });
  cleaned.content.querySelectorAll("div").forEach((div) => {
    if (div.querySelector("p,h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre,figure,div")) {
      div.replaceWith(...Array.from(div.childNodes));
      return;
    }
    const paragraph = document.createElement("p");
    paragraph.append(...Array.from(div.childNodes));
    div.replaceWith(paragraph);
  });
  return cleaned.innerHTML.trim();
}

/** Google Docs marks bold and italic with inline styles, and wraps whole
 * pastes in `<b style="font-weight:normal">`. Emphasis is carried over as
 * real tags before the styles are stripped, and the false bold is dropped. */
function promoteStyledEmphasis(root: DocumentFragment) {
  root.querySelectorAll<HTMLElement>("b,strong").forEach((element) => {
    if (/^(normal|[1-4]00)$/.test(element.style.fontWeight)) {
      element.replaceWith(...Array.from(element.childNodes));
    }
  });
  root.querySelectorAll<HTMLElement>("span[style]").forEach((span) => {
    const wrappers: string[] = [];
    if (/^(bold|[6-9]00)$/.test(span.style.fontWeight)) wrappers.push("strong");
    if (span.style.fontStyle === "italic") wrappers.push("em");
    const decoration = `${span.style.textDecoration} ${span.style.textDecorationLine}`;
    if (decoration.includes("underline")) wrappers.push("u");
    if (decoration.includes("line-through")) wrappers.push("s");
    if (!wrappers.length) return;
    let inner: Node[] = Array.from(span.childNodes);
    wrappers.forEach((tag) => {
      const wrapper = document.createElement(tag);
      wrapper.append(...inner);
      inner = [wrapper];
    });
    span.replaceChildren(...inner);
  });
}

/** Plain text as paragraphs, for "Paste as plain text" (⌘⇧V). */
export function plainTextToParagraphHtml(text: string) {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  if (paragraphs.length === 1 && !paragraphs[0].includes("\n")) return escape(paragraphs[0]);
  return paragraphs
    .filter((paragraph) => paragraph.trim())
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
