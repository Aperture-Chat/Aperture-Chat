import { expect, test } from "vitest";
import { deckFromDocumentHtml } from "./deckFromDocument";
import { deckRunsText, parseSlideDeck, serializeSlideDeck } from "./deckModel";

test("converts headings, lists, and quotes into structured slides", () => {
  const { deck, warnings } = deckFromDocumentHtml(
    "Expansion Brief",
    "<h1>Expansion Brief</h1>" +
      "<h2>Goals</h2><p>Grow the northeast region.</p><ul><li>Hire two AEs<ul><li>Boston first</li></ul></li><li>Open a Boston office</li></ul>" +
      "<blockquote>We win on service, not price.</blockquote>" +
      "<h2>Risks</h2><p>Hiring timeline is tight.</p>",
  );

  expect(deck.slides[0].layout).toBe("title");
  expect(deckRunsText((deck.slides[0] as { title: never[] }).title)).toBe("Expansion Brief");
  const goals = deck.slides[1];
  expect(goals.layout).toBe("title-bullets");
  if (goals.layout === "title-bullets") expect(deckRunsText(goals.title)).toBe("Goals");
  if (goals.layout === "title-bullets") {
    expect(goals.bullets.map((bullet) => bullet.runs[0].text)).toEqual([
      "Grow the northeast region.",
      "Hire two AEs",
      "Boston first",
      "Open a Boston office",
    ]);
    expect(goals.bullets[2].level).toBe(1);
  }
  const quote = deck.slides[2];
  expect(quote.layout).toBe("quote");
  if (quote.layout === "quote") expect(deckRunsText(quote.quote)).toBe("We win on service, not price.");
  const risks = deck.slides[3];
  expect(risks.layout).toBe("title-bullets");
  if (risks.layout === "title-bullets") expect(deckRunsText(risks.title)).toBe("Risks");
  expect(warnings).toEqual([]);
  // Everything the converter emits must pass the single validation gate.
  expect(parseSlideDeck(serializeSlideDeck(deck)).ok).toBe(true);
});

test("splits long sections into continuation slides at the bullet cap", () => {
  const items = Array.from({ length: 11 }, (_, index) => `<li>Item ${index + 1}</li>`).join("");
  const { deck } = deckFromDocumentHtml("List Doc", `<h2>Backlog</h2><ul>${items}</ul>`);
  const bulletSlides = deck.slides.filter((slide) => slide.layout === "title-bullets");
  expect(bulletSlides).toHaveLength(2);
  expect(deckRunsText((bulletSlides[1] as { title: never[] }).title)).toBe("Backlog (cont.)");
  if (bulletSlides[0].layout === "title-bullets" && bulletSlides[1].layout === "title-bullets") {
    expect(bulletSlides[0].bullets).toHaveLength(8);
    expect(bulletSlides[1].bullets).toHaveLength(3);
  }
});

test("carries images onto image slides, reports diagrams and flattened tables", () => {
  const { deck, warnings } = deckFromDocumentHtml(
    "Media Doc",
    "<h2>Overview</h2><p>Intro text.</p>" +
      '<figure class="document-image-figure"><img src="https://example.com/a.png" alt="A"><figcaption>Office view</figcaption></figure>' +
      '<figure class="document-diagram-figure" data-diagram-source="flowchart"><img src="data:image/png;base64,x" alt="d"></figure>' +
      "<table><tr><th>Region</th><th>ARR</th></tr><tr><td>East</td><td>$2M</td></tr></table>",
  );
  const imageSlide = deck.slides.find((slide) => slide.layout === "image-caption");
  expect(imageSlide).toBeDefined();
  if (imageSlide && imageSlide.layout === "image-caption") {
    expect(imageSlide.image.src).toBe("https://example.com/a.png");
    expect(deckRunsText(imageSlide.caption)).toBe("Office view");
  }
  expect(warnings.some((warning) => warning.includes("diagram"))).toBe(true);
  expect(warnings.some((warning) => warning.includes("table"))).toBe(true);
  const overview = deck.slides.find((slide) => slide.layout === "title-bullets");
  expect(overview).toBeDefined();
  if (overview && overview.layout === "title-bullets") {
    expect(overview.bullets.map((bullet) => bullet.runs[0].text)).toContain("Intro text.");
  }
  const tableSlide = deck.slides.filter((slide) => slide.layout === "title-bullets").pop();
  if (tableSlide && tableSlide.layout === "title-bullets") {
    expect(tableSlide.bullets.map((bullet) => bullet.runs[0].text)).toContain("East | $2M");
  }
});

test("empty documents become an honest blank deck with a warning", () => {
  const { deck, warnings } = deckFromDocumentHtml("Empty Draft", "  ");
  expect(deck.slides).toHaveLength(1);
  expect(deck.slides[0].layout).toBe("title");
  expect(warnings.join(" ")).toContain("no convertible text");
});
