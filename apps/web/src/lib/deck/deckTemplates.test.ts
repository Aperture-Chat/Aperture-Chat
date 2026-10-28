import { expect, test } from "vitest";
import { BUILT_IN_DECK_TEMPLATES } from "./deckTemplates";

test("every deck starter builds a valid deck, and the starters mix the newer layouts in", () => {
  const layouts = new Set<string>();
  for (const template of BUILT_IN_DECK_TEMPLATES) {
    const deck = template.build(template.name);
    expect(deck.slides.length, template.id).toBeGreaterThan(5);
    expect(deck.slides[0].layout, template.id).toBe("title");
    deck.slides.forEach((slide) => layouts.add(slide.layout));
    // The outline the AI follows names every slide the starter scaffolds.
    expect(template.outline.split(";").length, template.id).toBe(deck.slides.length);
  }
  expect([...layouts]).toEqual(expect.arrayContaining(["statement", "big-number", "image-bullets"]));
});
