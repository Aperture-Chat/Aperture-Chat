import { expect, test } from "vitest";
import { markdownToDocumentHtml } from "./markdown";
import {
  fillPictureSpots,
  isolatePictureSpots,
  pictureReportMessage,
  pictureSourceUrls,
  pictureSpots,
  type PicturePlacement,
} from "./documentPictures";

const paper = markdownToDocumentHtml(
  [
    "# Napoleon",
    "Early life.",
    "[[Picture: Napoleon at Brienne military school, 1780s & after]]",
    "The coronation.",
    "[[Picture: Coronation of Napoleon, 1804]]",
    "Exile.",
    "[[Picture: Napoleon's house on Saint Helena]]",
  ].join("\n\n"),
);

test("finds each picture spot the writer marked, in order, with its description unescaped", () => {
  expect(pictureSpots(paper)).toEqual([
    "Napoleon at Brienne military school, 1780s & after",
    "Coronation of Napoleon, 1804",
    "Napoleon's house on Saint Helena",
  ]);
  expect(pictureSpots('<p class="document-mla-text">[[Picture: Waterloo battlefield]]</p>')).toEqual(["Waterloo battlefield"]);
  expect(pictureSpots("<p>He wrote [[Picture: inline]] mid-sentence.</p>")).toEqual([]);
});

test("puts a credited photo or a labelled illustration in each spot and drops spots with nothing to show", async () => {
  const placements: Record<string, PicturePlacement> = {
    "Napoleon at Brienne military school, 1780s & after": {
      kind: "photo",
      src: "data:image/jpeg;base64,AAA",
      alt: "Brienne-le-Château school",
      credit: "Unknown author · Public domain · Wikimedia Commons",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Brienne.jpg",
    },
    "Coronation of Napoleon, 1804": { kind: "illustration", src: "data:image/jpeg;base64,BBB" },
    "Napoleon's house on Saint Helena": null,
  };
  const asked: string[] = [];

  const { html, report } = await fillPictureSpots(paper, async (description) => {
    asked.push(description);
    return placements[description];
  });

  expect(asked).toEqual(Object.keys(placements));
  expect(report).toEqual({ photos: 1, illustrations: 1, missing: 1 });
  expect(pictureSpots(html)).toEqual([]);
  expect(html).not.toContain("[[Picture:");
  const page = new DOMParser().parseFromString(html, "text/html");
  const figures = [...page.querySelectorAll("figure")];
  expect(figures).toHaveLength(2);
  expect(figures[0].querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAA");
  expect(figures[0].querySelector("img")?.getAttribute("alt")).toBe("Brienne-le-Château school");
  expect(figures[0].querySelector("figcaption")?.textContent).toBe(
    "Brienne-le-Château school. Image: Unknown author · Public domain · Wikimedia Commons. Source",
  );
  expect(figures[0].querySelector("figcaption a")?.getAttribute("href")).toBe("https://commons.wikimedia.org/wiki/File:Brienne.jpg");
  expect(figures[1].querySelector("figcaption")?.textContent).toBe("AI-generated illustration: Coronation of Napoleon, 1804.");
  expect(figures[1].querySelector("img")?.getAttribute("alt")).toBe("AI-generated illustration: Coronation of Napoleon, 1804");
  expect(page.body.textContent).toContain("Exile.");
});

test("a spot whose lookup fails counts as missing and the rest still fill", async () => {
  const { report } = await fillPictureSpots(paper, async (description) => {
    if (description.startsWith("Coronation")) throw new Error("Commons unreachable");
    return { kind: "illustration", src: "data:image/jpeg;base64,CCC" };
  });
  expect(report).toEqual({ photos: 0, illustrations: 2, missing: 1 });
});

test("says what was placed in plain words", () => {
  expect(pictureReportMessage({ photos: 4, illustrations: 1, missing: 1 })).toBe(
    "Added 4 freely licensed photos and 1 AI-generated illustration. 1 picture had no match and was left out.",
  );
  expect(pictureReportMessage({ photos: 1, illustrations: 0, missing: 0 })).toBe("Added 1 freely licensed photo.");
  expect(pictureReportMessage({ photos: 0, illustrations: 0, missing: 2 })).toBe(
    "No pictures could be added: 2 pictures had no match.",
  );
});

test("a filled spot leaves the text around it exactly as it was", async () => {
  const { html } = await fillPictureSpots(
    "<h1>Napoleon</h1><p>[[Picture: Brienne school]]</p><p>After.</p><p>[[Picture: Nothing here]]</p><p>End.</p>",
    async (description) => (description === "Brienne school" ? { kind: "illustration", src: "data:image/jpeg;base64,AAA" } : null),
  );
  expect(html).toBe(
    '<h1>Napoleon</h1><figure class="document-media-block document-picture" contenteditable="false">' +
      '<img src="data:image/jpeg;base64,AAA" alt="AI-generated illustration: Brienne school">' +
      "<figcaption>AI-generated illustration: Brienne school.</figcaption></figure><p>After.</p><p>End.</p>",
  );
});

test("a photo is captioned with what Commons says it shows, not with the scene the writer wished for", async () => {
  const { html } = await fillPictureSpots("<p>[[Picture: Napoleon crossing the Alps at dawn]]</p>", async () => ({
    kind: "photo",
    src: "data:image/jpeg;base64,AAA",
    alt: "Portrait of Napoleon Bonaparte, 1812",
    credit: "Jacques-Louis David · Public domain · Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Napoleon.jpg",
  }));
  expect(html).toContain("<figcaption>Portrait of Napoleon Bonaparte, 1812. Image:");
  expect(html).not.toContain("crossing the Alps");
});

test("a marker written on a line of its own without a blank line still becomes a spot", () => {
  const html = markdownToDocumentHtml(isolatePictureSpots("Intro.\n[[Picture: Brienne school]]\nMore text."));
  expect(pictureSpots(html)).toEqual(["Brienne school"]);
  expect(html).toContain("<p>Intro.</p>");
  expect(html).toContain("<p>More text.</p>");
});

test("a marker that is not a paragraph of its own is removed and counted as missing", async () => {
  const { html, report } = await fillPictureSpots(
    "<ul><li>Early life [[Picture: Corsica]]</li></ul><p>See [[Picture: Elba]] here.</p>",
    async () => ({ kind: "illustration", src: "data:image/jpeg;base64,AAA" }),
  );
  expect(html).toBe("<ul><li>Early life </li></ul><p>See  here.</p>");
  expect(report).toEqual({ photos: 0, illustrations: 0, missing: 2 });
});

test("lists the source pages of the photos a document already holds", async () => {
  const { html } = await fillPictureSpots("<p>[[Picture: Alps]]</p><p>[[Picture: Elba]]</p>", async (description) => ({
    kind: "photo",
    src: "data:image/jpeg;base64,AAA",
    alt: description,
    credit: "X · CC0 · Wikimedia Commons",
    sourceUrl: `https://commons.wikimedia.org/wiki/File:${description}.jpg`,
  }));
  expect(pictureSourceUrls(html)).toEqual([
    "https://commons.wikimedia.org/wiki/File:Alps.jpg",
    "https://commons.wikimedia.org/wiki/File:Elba.jpg",
  ]);
  expect(pictureSourceUrls("<p>No pictures.</p>")).toEqual([]);
});
