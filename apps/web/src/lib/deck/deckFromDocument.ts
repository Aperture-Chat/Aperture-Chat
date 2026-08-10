/** Deterministic document → deck conversion.
 *
 * Walks the sanitized document HTML (same parsing idiom as the DOCX
 * exporter's parseDocBlocks) and produces a structured deck: headings start
 * slides, paragraphs and lists become bullets, blockquotes become quote
 * slides. Content the deck format cannot carry yet (images, diagrams,
 * tables' structure) is reported in `warnings` — never silently dropped.
 */

import {
  DECK_SCHEMA_VERSION,
  MAX_DECK_BULLETS_PER_SLIDE,
  MAX_DECK_SLIDES,
  blankSlideDeck,
  createDeckSlide,
  deckRichText,
  defaultDeckTheme,
  type DeckBullet,
  type DeckSlide,
  type DeckTextRun,
  type SlideDeck,
} from "./deckModel";

export type DeckFromDocumentResult = { deck: SlideDeck; warnings: string[] };

let conversionSlideCounter = 0;
function conversionSlideId() {
  conversionSlideCounter += 1;
  return `slide-c${conversionSlideCounter}`;
}

/** Normalizes the colour spellings browsers produce (#rgb, #rrggbb, rgb(...))
 * into the deck model's single #rrggbb form. */
export function normalizeRunColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
  if (rgb) {
    const channel = (raw: string) => {
      const number = Math.max(0, Math.min(255, Math.round(Number(raw))));
      return Number.isFinite(number) ? number.toString(16).padStart(2, "0") : null;
    };
    const parts = [channel(rgb[1]), channel(rgb[2]), channel(rgb[3])];
    if (parts.every((part): part is string => part !== null)) return `#${parts.join("")}`;
  }
  return null;
}

/** Shared DOM→runs parser: also used by the deck editor to read formatted
 * text back out of contentEditable slide blocks. */
export function textRunsFromElement(element: Element): DeckTextRun[] {
  const runs: DeckTextRun[] = [];
  const walk = (node: Node, format: Omit<DeckTextRun, "text">) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ");
      if (text.trim()) runs.push({ ...format, text });
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName;
    if (tag === "BR") {
      // Authored line break inside a rich region.
      runs.push({ ...format, text: "\n" });
      return;
    }
    const next = { ...format };
    if (tag === "B" || tag === "STRONG") next.bold = true;
    if (tag === "I" || tag === "EM") next.italic = true;
    if (tag === "U") next.underline = true;
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") next.strike = true;
    // execCommand("foreColor") emits <font color> without styleWithCSS and
    // <span style="color: rgb(...)"> with it; both have to read back or the
    // colour silently disappears on the next model sync.
    if (tag === "FONT") {
      const attribute = normalizeRunColor(node.getAttribute("color"));
      if (attribute) next.color = attribute;
    }
    const style = node.getAttribute("style") ?? "";
    const colorMatch = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
    const styleColor = colorMatch ? normalizeRunColor(colorMatch[1]) : null;
    if (styleColor) next.color = styleColor;
    if (/(?:^|;)\s*font-weight\s*:\s*(bold|[6-9]00)\b/i.test(style)) next.bold = true;
    // "normal" is a real instruction on regions the layout renders bold.
    if (/(?:^|;)\s*font-weight\s*:\s*(normal|[1-5]00)\b/i.test(style)) next.bold = false;
    if (/(?:^|;)\s*font-style\s*:\s*italic\b/i.test(style)) next.italic = true;
    if (/(?:^|;)\s*font-style\s*:\s*normal\b/i.test(style)) next.italic = false;
    if (/(?:^|;)\s*text-decoration[^:]*:\s*[^;]*underline/i.test(style)) next.underline = true;
    if (/(?:^|;)\s*text-decoration[^:]*:\s*[^;]*line-through/i.test(style)) next.strike = true;
    const sizeMatch = /(?:^|;)\s*font-size\s*:\s*([\d.]+)px/i.exec(style);
    if (sizeMatch) {
      const px = Number(sizeMatch[1]);
      // The stage renders 1pt as 1px, so a px size maps straight to points.
      if (Number.isFinite(px) && px >= 8 && px <= 96) next.sizePt = Math.round(px);
    }
    const familyMatch = /(?:^|;)\s*font-family\s*:\s*([^;]+)/i.exec(style);
    if (familyMatch) {
      // First family only, unquoted — the run model stores one plain name.
      const family = (familyMatch[1].split(",")[0] ?? "")
        .replace(/["']/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (family && /^[a-z0-9][a-z0-9 \-]{0,58}$/i.test(family)) next.font = family;
    }
    node.childNodes.forEach((child) => walk(child, next));
  };
  walk(element, {});
  // Merge identical-format neighbors so the deck stays compact.
  const merged: DeckTextRun[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.bold === run.bold &&
      previous.italic === run.italic &&
      previous.underline === run.underline &&
      previous.strike === run.strike &&
      previous.color === run.color &&
      previous.sizePt === run.sizePt &&
      previous.font === run.font
    ) {
      previous.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  if (merged.length) {
    merged[0].text = merged[0].text.replace(/^[^\S\n]+/, "");
    merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/[^\S\n]+$/, "");
  }
  return merged.filter((run) => run.text.length > 0);
}

function listBullets(list: Element, level: 0 | 1 | 2, bullets: DeckBullet[]) {
  Array.from(list.children).forEach((child) => {
    if (child.tagName !== "LI") return;
    const nested = child.querySelector(":scope > ul, :scope > ol");
    const itemClone = child.cloneNode(true) as Element;
    itemClone.querySelectorAll("ul, ol").forEach((inner) => inner.remove());
    const runs = textRunsFromElement(itemClone);
    if (runs.length) bullets.push({ runs, level });
    if (nested) listBullets(nested, Math.min(2, level + 1) as 0 | 1 | 2, bullets);
  });
}

type PendingSlide = { title: string; bullets: DeckBullet[] };

export function deckFromDocumentHtml(
  documentTitle: string,
  contentHtml: string,
): DeckFromDocumentResult {
  const warnings: string[] = [];
  if (typeof document === "undefined") {
    return { deck: blankSlideDeck(documentTitle), warnings: ["No DOM available; created a blank deck."] };
  }
  const template = document.createElement("template");
  template.innerHTML = contentHtml;
  template.content.querySelectorAll(".document-page-label").forEach((node) => node.remove());

  const slides: DeckSlide[] = [];
  let pending: PendingSlide | null = null;
  let titleSlideDone = false;
  let skippedImages = 0;
  let skippedCharts = 0;
  let flattenedTables = 0;

  const flushPending = () => {
    if (!pending) return;
    const { title, bullets } = pending;
    pending = null;
    if (!bullets.length) {
      if (title.trim()) {
        slides.push({
          ...createDeckSlide("section", conversionSlideId()),
          title: deckRichText(title),
        } as DeckSlide);
      }
      return;
    }
    for (let start = 0; start < bullets.length; start += MAX_DECK_BULLETS_PER_SLIDE) {
      const chunk = bullets.slice(start, start + MAX_DECK_BULLETS_PER_SLIDE);
      const slideTitle = start === 0 ? title : `${title} (cont.)`;
      slides.push({
        id: conversionSlideId(),
        notes: "",
        layout: "title-bullets",
        title: deckRichText(slideTitle),
        bullets: chunk,
      });
    }
  };

  const beginSlide = (title: string) => {
    flushPending();
    pending = { title, bullets: [] };
  };

  const addBullet = (bullet: DeckBullet) => {
    if (!pending) pending = { title: "", bullets: [] };
    pending.bullets.push(bullet);
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) addBullet({ runs: [{ text }], level: 0 });
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    if (node.classList.contains("document-page-label")) return;

    if (tag === "h1" && !titleSlideDone) {
      titleSlideDone = true;
      const runs = textRunsFromElement(node);
      slides.push({
        id: conversionSlideId(),
        notes: "",
        layout: "title",
        // Heading formatting carries into the title now that it is rich text.
        title: runs.length ? runs : deckRichText(documentTitle),
        subtitle: [],
      });
      return;
    }
    if (tag === "h1" || tag === "h2") {
      beginSlide(textRunsFromElement(node).map((run) => run.text).join(""));
      return;
    }
    if (tag === "h3") {
      const runs = textRunsFromElement(node);
      if (runs.length) addBullet({ runs: runs.map((run) => ({ ...run, bold: true as const })), level: 0 });
      return;
    }
    if (tag === "p") {
      const runs = textRunsFromElement(node);
      if (runs.length) addBullet({ runs, level: 0 });
      return;
    }
    if (tag === "ul" || tag === "ol") {
      const bullets: DeckBullet[] = [];
      listBullets(node, 0, bullets);
      bullets.forEach(addBullet);
      return;
    }
    if (tag === "blockquote") {
      flushPending();
      const quoteText = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (quoteText) {
        slides.push({
          id: conversionSlideId(),
          notes: "",
          layout: "quote",
          quote: deckRichText(quoteText),
          attribution: [],
        });
      }
      return;
    }
    if (tag === "table") {
      flattenedTables += 1;
      node.querySelectorAll("tr").forEach((row) => {
        const cells = Array.from(row.querySelectorAll("th,td"))
          .map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean);
        if (cells.length) addBullet({ runs: [{ text: cells.join(" | ") }], level: 0 });
      });
      return;
    }
    if (tag === "figure" || tag === "img") {
      if (node.classList.contains("document-diagram-figure")) {
        skippedCharts += 1;
        return;
      }
      const image = tag === "img" ? node : node.querySelector("img");
      const src = image?.getAttribute("src")?.trim() ?? "";
      const safeSrc = /^(https:\/\/|data:image\/(png|jpe?g|gif|webp);)/i.test(src) ? src : "";
      if (!safeSrc) {
        skippedImages += 1;
        return;
      }
      const caption =
        tag === "figure"
          ? (node.querySelector("figcaption")?.textContent ?? "").replace(/\s+/g, " ").trim()
          : "";
      const heading = pending?.title ?? "";
      flushPending();
      slides.push({
        id: conversionSlideId(),
        notes: "",
        layout: "image-caption",
        title: deckRichText(heading),
        image: { src: safeSrc, alt: image?.getAttribute("alt")?.trim() ?? "" },
        caption: deckRichText(caption),
      });
      return;
    }
    if (tag === "hr" || tag === "pre") {
      if (tag === "pre") {
        const text = (node.textContent ?? "").trim();
        if (text) addBullet({ runs: [{ text: text.slice(0, 300) }], level: 0 });
      }
      return;
    }
    node.childNodes.forEach(visit);
  };

  template.content.childNodes.forEach(visit);
  flushPending();

  const sawBodyContent = slides.length > 0 || titleSlideDone;
  if (!titleSlideDone && documentTitle.trim()) {
    slides.unshift({
      id: conversionSlideId(),
      notes: "",
      layout: "title",
      title: deckRichText(documentTitle),
      subtitle: [],
    });
  }
  if (!sawBodyContent) {
    warnings.push("The document had no convertible text; created a blank title slide.");
  }

  if (skippedImages) {
    warnings.push(
      `${skippedImages} image${skippedImages === 1 ? "" : "s"} had no safe image address and ${
        skippedImages === 1 ? "was" : "were"
      } left out.`,
    );
  }
  if (skippedCharts) {
    warnings.push(
      `${skippedCharts} diagram${skippedCharts === 1 ? "" : "s"} not carried over — chart slides arrive in a later phase.`,
    );
  }
  if (flattenedTables) {
    warnings.push(
      `${flattenedTables} table${flattenedTables === 1 ? "" : "s"} flattened to text rows — native slide tables are not supported yet.`,
    );
  }
  if (slides.length > MAX_DECK_SLIDES) {
    warnings.push(`Deck truncated to ${MAX_DECK_SLIDES} slides.`);
    slides.length = MAX_DECK_SLIDES;
  }
  if (!slides.length) {
    return {
      deck: blankSlideDeck(documentTitle),
      warnings: [...warnings, "The document had no convertible text; created a blank title slide."],
    };
  }

  return {
    deck: {
      schema: DECK_SCHEMA_VERSION,
      title: documentTitle,
      theme: defaultDeckTheme(),
      slides,
    },
    warnings,
  };
}
