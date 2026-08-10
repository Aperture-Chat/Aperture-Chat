/** Deck → markdown outline. Powers the deck-mode Markdown export and the
 * escape hatch back to document mode. Speaker notes are included as quoted
 * lines when present so nothing the user wrote is lost in the outline. */

import { deckRunsText, type DeckBullet, type DeckRichText, type SlideDeck } from "./deckModel";

/** Rich regions carry runs; the outline only needs their words. */
function plain(text: DeckRichText): string {
  return deckRunsText(text).trim();
}

function bulletLines(bullets: DeckBullet[]): string[] {
  return bullets
    .map((bullet) => {
      const text = deckRunsText(bullet.runs).trim();
      return text ? `${"  ".repeat(bullet.level)}- ${text}` : "";
    })
    .filter(Boolean);
}

export function markdownOutlineFromDeck(deck: SlideDeck): string {
  const sections: string[] = [];
  if (deck.title.trim()) sections.push(`# ${deck.title.trim()}`);
  deck.slides.forEach((slide, index) => {
    const lines: string[] = [];
    switch (slide.layout) {
      case "title":
      case "section":
        lines.push(`## ${plain(slide.title) || `Slide ${index + 1}`}`);
        if (plain(slide.subtitle)) lines.push(plain(slide.subtitle));
        break;
      case "title-bullets":
        lines.push(`## ${plain(slide.title) || `Slide ${index + 1}`}`);
        lines.push(...bulletLines(slide.bullets));
        break;
      case "two-column":
        lines.push(`## ${plain(slide.title) || `Slide ${index + 1}`}`);
        lines.push(...bulletLines(slide.left));
        lines.push(...bulletLines(slide.right));
        break;
      case "image-caption":
        lines.push(`## ${plain(slide.title) || `Slide ${index + 1}`}`);
        if (slide.image.src) lines.push(`![${slide.image.alt}](${slide.image.src})`);
        if (plain(slide.caption)) lines.push(plain(slide.caption));
        break;
      case "quote":
        lines.push(`## Slide ${index + 1}`);
        if (plain(slide.quote)) lines.push(`> ${plain(slide.quote)}`);
        if (plain(slide.attribution)) lines.push(`> — ${plain(slide.attribution)}`);
        break;
      case "chart":
        lines.push(`## ${plain(slide.title) || `Slide ${index + 1}`}`);
        if (slide.mermaidSource.trim()) {
          lines.push("```mermaid");
          lines.push(slide.mermaidSource.trim());
          lines.push("```");
        }
        break;
      case "closing":
        lines.push(`## ${plain(slide.title) || `Slide ${index + 1}`}`);
        if (plain(slide.body)) lines.push(plain(slide.body));
        break;
    }
    if (slide.notes.trim()) {
      lines.push(`> Notes: ${slide.notes.trim().replace(/\n+/g, " ")}`);
    }
    sections.push(lines.join("\n\n"));
  });
  return sections.join("\n\n");
}
