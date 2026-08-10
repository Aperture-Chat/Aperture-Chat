import { expect, test } from "vitest";
import { buildPptxExportDocument } from "./pptxExport";
import { deckRichText, blankSlideDeck, type SlideDeck } from "./deck/deckModel";

function zipEntryNames(zip: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= zip.length) {
    const view = new DataView(zip.buffer, zip.byteOffset + offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    names.push(decoder.decode(zip.slice(offset + 30, offset + 30 + nameLength)));
    offset = offset + 30 + nameLength + extraLength + size;
  }
  return names;
}

function storedZipEntry(zip: Uint8Array, entryName: string) {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= zip.length) {
    const view = new DataView(zip.buffer, zip.byteOffset + offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const compression = view.getUint16(8, true);
    const size = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(zip.slice(nameStart, nameStart + nameLength));
    if (name === entryName) {
      expect(compression).toBe(0);
      return decoder.decode(zip.slice(dataStart, dataStart + size));
    }
    offset = dataStart + size;
  }
  throw new Error(`Missing PPTX ZIP entry: ${entryName}`);
}

function expectWellFormedXml(xml: string) {
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  expect(parsed.querySelector("parsererror")).toBeNull();
}

function resolveRelTarget(baseDir: string, target: string): string {
  const segments = (baseDir ? baseDir.split("/") : []).concat(target.split("/"));
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else if (segment !== "." && segment !== "") resolved.push(segment);
  }
  return resolved.join("/");
}

function sampleDeck(): SlideDeck {
  const deck = blankSlideDeck("Q3 Strategy");
  deck.slides = [
    { id: "s1", notes: "", layout: "title", title: deckRichText("Q3 Strategy"), subtitle: deckRichText("Planning review") },
    {
      id: "s2",
      notes: "walk slowly",
      layout: "title-bullets",
      title: deckRichText("Priorities"),
      bullets: [
        { runs: [{ text: "Grow pipeline ", bold: true }, { text: "30%", color: "#b91c1c" }], level: 0 },
        { runs: [{ text: "Nested detail", underline: true }], level: 1 },
        { runs: [{ text: "Retired goal", strike: true }], level: 2 },
      ],
    },
    {
      id: "s3",
      notes: "",
      layout: "two-column",
      title: deckRichText("Now vs Next"),
      left: [{ runs: [{ text: "Now: stabilize" }], level: 0 }],
      right: [{ runs: [{ text: "Next: expand" }], level: 0 }],
    },
    { id: "s4", notes: "", layout: "section", title: deckRichText("Execution"), subtitle: deckRichText("How we deliver") },
    { id: "s5", notes: "", layout: "quote", quote: deckRichText("Focus wins quarters."), attribution: deckRichText("CEO") },
    { id: "s6", notes: "", layout: "closing", title: deckRichText("Thank you"), body: deckRichText("Questions welcome") },
  ];
  return deck;
}

test("builds a structurally complete PresentationML package", async () => {
  const { bytes } = await buildPptxExportDocument(sampleDeck());
  expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);

  const names = zipEntryNames(bytes);
  const expectedFixed = [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/core.xml",
    "docProps/app.xml",
    "ppt/presentation.xml",
    "ppt/_rels/presentation.xml.rels",
    "ppt/slideMasters/slideMaster1.xml",
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    "ppt/slideLayouts/slideLayout1.xml",
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    "ppt/theme/theme1.xml",
  ];
  for (const name of expectedFixed) expect(names).toContain(name);
  for (let index = 1; index <= 6; index += 1) {
    expect(names).toContain(`ppt/slides/slide${index}.xml`);
    expect(names).toContain(`ppt/slides/_rels/slide${index}.xml.rels`);
  }
  // Slide 2 carries speaker notes, which brings in the notes master, its
  // theme part, and one notesSlide named after the slide number.
  const expectedNotesParts = [
    "ppt/notesMasters/notesMaster1.xml",
    "ppt/notesMasters/_rels/notesMaster1.xml.rels",
    "ppt/theme/theme2.xml",
    "ppt/notesSlides/notesSlide2.xml",
    "ppt/notesSlides/_rels/notesSlide2.xml.rels",
  ];
  for (const name of expectedNotesParts) expect(names).toContain(name);
  expect(names).toHaveLength(expectedFixed.length + expectedNotesParts.length + 12);

  // Every part parses as XML.
  for (const name of names) expectWellFormedXml(storedZipEntry(bytes, name));

  // Every relationship target resolves to a real zip entry.
  for (const relsName of names.filter((name) => name.endsWith(".rels"))) {
    const relsXml = storedZipEntry(bytes, relsName);
    const parsed = new DOMParser().parseFromString(relsXml, "application/xml");
    const baseDir = relsName.replace(/_rels\/[^/]+$/, "").replace(/\/$/, "");
    for (const relationship of Array.from(parsed.getElementsByTagName("Relationship"))) {
      const target = relationship.getAttribute("Target") ?? "";
      const resolved = resolveRelTarget(baseDir, target);
      expect(names, `unresolved rel ${target} in ${relsName}`).toContain(resolved);
    }
  }

  // Every part is covered by [Content_Types].xml.
  const contentTypes = storedZipEntry(bytes, "[Content_Types].xml");
  const typesDoc = new DOMParser().parseFromString(contentTypes, "application/xml");
  const defaults = new Set(
    Array.from(typesDoc.getElementsByTagName("Default")).map((node) =>
      (node.getAttribute("Extension") ?? "").toLowerCase(),
    ),
  );
  const overridden = new Set(
    Array.from(typesDoc.getElementsByTagName("Override")).map((node) => node.getAttribute("PartName")),
  );
  for (const name of names) {
    if (name === "[Content_Types].xml") continue;
    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    const covered = overridden.has(`/${name}`) || defaults.has(extension);
    expect(covered, `uncovered part ${name}`).toBe(true);
  }
});

test("slides carry 16:9 geometry, formatted runs, and leveled bullets", async () => {
  const { bytes } = await buildPptxExportDocument(sampleDeck());

  const presentation = storedZipEntry(bytes, "ppt/presentation.xml");
  expect(presentation).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
  expect(presentation).toContain('r:id="rIdSlide6"');

  const bulletsSlide = storedZipEntry(bytes, "ppt/slides/slide2.xml");
  expect(bulletsSlide).toContain('b="1"');
  expect(bulletsSlide).toContain('u="sng"');
  expect(bulletsSlide).toContain('strike="sngStrike"');
  expect(bulletsSlide).toContain('<a:srgbClr val="B91C1C"/>');
  expect(bulletsSlide).toContain('lvl="1"');
  expect(bulletsSlide).toContain('lvl="2"');
  expect(bulletsSlide).toContain("Grow pipeline ");
  // Region font size flows from the shared geometry table (16pt bullets).
  expect(bulletsSlide).toContain('sz="1600"');

  const titleSlide = storedZipEntry(bytes, "ppt/slides/slide1.xml");
  expect(titleSlide).toContain("Q3 Strategy");
  expect(titleSlide).toContain('sz="4000"');
  expect(titleSlide).toContain('algn="ctr"');

  const quoteSlide = storedZipEntry(bytes, "ppt/slides/slide5.xml");
  expect(quoteSlide).toContain("Focus wins quarters.");
  expect(quoteSlide).toContain('i="1"');

  const theme = storedZipEntry(bytes, "ppt/theme/theme1.xml");
  expect(theme).toContain('<a:accent1><a:srgbClr val="087D8B"/></a:accent1>');
  expect(theme).toContain('typeface="Plus Jakarta Sans"');
});

test("title and quote formatting exports, not just bullet formatting", async () => {
  const deck = blankSlideDeck("Formatted");
  deck.slides = [
    {
      id: "s1",
      notes: "",
      layout: "title",
      title: [
        { text: "Bold ", bold: true },
        { text: "red", color: "#c02626" },
      ],
      subtitle: [{ text: "Line one\nLine two", italic: true }],
    },
    {
      id: "s2",
      notes: "",
      layout: "closing",
      title: deckRichText("Thanks"),
      body: [{ text: "Big", sizePt: 40 }, { text: " and struck", strike: true }],
    },
  ];
  const { bytes } = await buildPptxExportDocument(deck);

  const titleSlide = storedZipEntry(bytes, "ppt/slides/slide1.xml");
  expect(titleSlide).toContain('b="1"');
  expect(titleSlide).toContain('<a:srgbClr val="C02626"/>');
  expect(titleSlide).toContain('i="1"');
  // The authored line break becomes a second paragraph, not a lost newline.
  expect(titleSlide).toContain("<a:t>Line one</a:t>");
  expect(titleSlide).toContain("<a:t>Line two</a:t>");
  expectWellFormedXml(titleSlide);

  const closingSlide = storedZipEntry(bytes, "ppt/slides/slide2.xml");
  expect(closingSlide).toContain('sz="4000"');
  expect(closingSlide).toContain('strike="sngStrike"');
});

test("turning a layout's bold or italic off is exported, not ignored", async () => {
  const deck = blankSlideDeck("Overrides");
  deck.slides = [
    // The title region is bold by layout and the quote region italic; both
    // must be overridable per run.
    { id: "s1", notes: "", layout: "title", title: [{ text: "Light title", bold: false }], subtitle: [] },
    {
      id: "s2",
      notes: "",
      layout: "quote",
      quote: [{ text: "Upright quote", italic: false }],
      attribution: [],
    },
  ];
  const { bytes } = await buildPptxExportDocument(deck);

  const titleSlide = storedZipEntry(bytes, "ppt/slides/slide1.xml");
  expect(titleSlide).toContain("Light title");
  expect(titleSlide).not.toContain('b="1"');
  const quoteSlide = storedZipEntry(bytes, "ppt/slides/slide2.xml");
  expect(quoteSlide).toContain("Upright quote");
  expect(quoteSlide).not.toContain('i="1"');
});

test("slides with speaker notes export real notesSlide parts", async () => {
  const deck = blankSlideDeck("Noted");
  deck.slides = [
    {
      id: "s1",
      notes: 'Pause here & ask about <Q3> "targets"\nThen hand off to Dana',
      layout: "title",
      title: deckRichText("Kickoff"),
      subtitle: [],
    },
    { id: "s2", notes: "", layout: "section", title: deckRichText("Middle"), subtitle: [] },
    { id: "s3", notes: "Close with the ask", layout: "closing", title: deckRichText("End"), body: [] },
  ];
  const { bytes } = await buildPptxExportDocument(deck);
  const names = zipEntryNames(bytes);

  // notesSlide part numbers match their slide numbers; the unnoted slide 2
  // gets none.
  expect(names).toContain("ppt/notesSlides/notesSlide1.xml");
  expect(names).toContain("ppt/notesSlides/_rels/notesSlide1.xml.rels");
  expect(names).toContain("ppt/notesSlides/notesSlide3.xml");
  expect(names).toContain("ppt/notesSlides/_rels/notesSlide3.xml.rels");
  expect(names).not.toContain("ppt/notesSlides/notesSlide2.xml");
  expect(names).toContain("ppt/notesMasters/notesMaster1.xml");
  expect(names).toContain("ppt/theme/theme2.xml");

  const contentTypes = storedZipEntry(bytes, "[Content_Types].xml");
  expect(contentTypes).toContain(
    '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>',
  );
  expect(contentTypes).toContain(
    '<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>',
  );
  expect(contentTypes).toContain('<Override PartName="/ppt/notesSlides/notesSlide3.xml"');
  expect(contentTypes).not.toContain("notesSlide2");
  expect(contentTypes).toContain('<Override PartName="/ppt/theme/theme2.xml"');

  const presentation = storedZipEntry(bytes, "ppt/presentation.xml");
  expect(presentation).toContain(
    '<p:notesMasterIdLst><p:notesMasterId r:id="rIdNotesMaster1"/></p:notesMasterIdLst>',
  );
  const presentationRels = storedZipEntry(bytes, "ppt/_rels/presentation.xml.rels");
  expect(presentationRels).toContain('Target="notesMasters/notesMaster1.xml"');

  const notedSlideRels = storedZipEntry(bytes, "ppt/slides/_rels/slide1.xml.rels");
  expect(notedSlideRels).toContain('Target="../notesSlides/notesSlide1.xml"');
  expect(notedSlideRels).toContain("relationships/notesSlide");
  const unnotedSlideRels = storedZipEntry(bytes, "ppt/slides/_rels/slide2.xml.rels");
  expect(unnotedSlideRels).not.toContain("notesSlide");

  // The notes text exports escaped, one paragraph per authored line, inside
  // the standard body placeholder next to the sldImg placeholder.
  const notesSlide = storedZipEntry(bytes, "ppt/notesSlides/notesSlide1.xml");
  expect(notesSlide).toContain(
    "<a:t>Pause here &amp; ask about &lt;Q3&gt; &quot;targets&quot;</a:t>",
  );
  expect(notesSlide).toContain("<a:t>Then hand off to Dana</a:t>");
  expect(notesSlide).toContain('<p:ph type="sldImg" idx="2"/>');
  expect(notesSlide).toContain('<p:ph type="body" sz="quarter" idx="3"/>');
  expectWellFormedXml(notesSlide);
  expect(storedZipEntry(bytes, "ppt/notesSlides/notesSlide3.xml")).toContain(
    "<a:t>Close with the ask</a:t>",
  );

  // Every notes-related relationship resolves to a real part.
  for (const relsName of [
    "ppt/notesSlides/_rels/notesSlide1.xml.rels",
    "ppt/notesSlides/_rels/notesSlide3.xml.rels",
    "ppt/notesMasters/_rels/notesMaster1.xml.rels",
  ]) {
    const parsed = new DOMParser().parseFromString(storedZipEntry(bytes, relsName), "application/xml");
    const baseDir = relsName.replace(/_rels\/[^/]+$/, "").replace(/\/$/, "");
    for (const relationship of Array.from(parsed.getElementsByTagName("Relationship"))) {
      const target = relationship.getAttribute("Target") ?? "";
      expect(names, `unresolved rel ${target} in ${relsName}`).toContain(
        resolveRelTarget(baseDir, target),
      );
    }
  }
});

test("decks without speaker notes emit no notes parts at all", async () => {
  const deck = blankSlideDeck("Silent");
  deck.slides = [
    { id: "s1", notes: "", layout: "title", title: deckRichText("Cover"), subtitle: [] },
    // Whitespace-only notes are not real notes and must not export.
    { id: "s2", notes: "  \n ", layout: "section", title: deckRichText("Part"), subtitle: [] },
  ];
  const { bytes } = await buildPptxExportDocument(deck);
  const names = zipEntryNames(bytes);
  expect(names.filter((name) => name.includes("notes"))).toEqual([]);
  expect(names).not.toContain("ppt/theme/theme2.xml");

  const contentTypes = storedZipEntry(bytes, "[Content_Types].xml");
  expect(contentTypes).not.toContain("notesSlide");
  expect(contentTypes).not.toContain("notesMaster");
  expect(contentTypes).not.toContain("theme2");

  const presentation = storedZipEntry(bytes, "ppt/presentation.xml");
  expect(presentation).not.toContain("notesMasterIdLst");
  expect(storedZipEntry(bytes, "ppt/_rels/presentation.xml.rels")).not.toContain("notesMaster");
  for (const slideNumber of [1, 2]) {
    expect(storedZipEntry(bytes, `ppt/slides/_rels/slide${slideNumber}.xml.rels`)).not.toContain(
      "notesSlide",
    );
  }
});

test("empty text regions are omitted instead of exporting placeholder boxes", async () => {
  const deck = blankSlideDeck("Empty");
  const { bytes } = await buildPptxExportDocument(deck);
  const slide = storedZipEntry(bytes, "ppt/slides/slide1.xml");
  // The blank title slide has no typed text yet: no text boxes, no fake copy.
  expect(slide).not.toContain('txBox="1"');
  expectWellFormedXml(slide);
});

const SMALL_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCvRRRX0x+Tn//Z";

/** A second, visibly different tiny JPEG (6x4) so background dedupe is real. */
const SMALL_JPEG_ALT =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAAEAAYDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDJoooruPPP/9k=";

test("embeds slide images, brand logo, and background as real media parts", async () => {
  const deck = blankSlideDeck("Media Deck");
  deck.theme.logo = { dataUrl: `data:image/jpeg;base64,${SMALL_JPEG}`, widthPx: 4, heightPx: 3 };
  deck.theme.backgroundImage = { dataUrl: `data:image/jpeg;base64,${SMALL_JPEG}` };
  deck.slides = [
    { id: "s1", notes: "", layout: "title", title: deckRichText("Media Deck"), subtitle: [] },
    {
      id: "s2",
      notes: "",
      layout: "image-caption",
      title: deckRichText("Office"),
      image: { src: `data:image/jpeg;base64,${SMALL_JPEG}`, alt: "office" },
      caption: deckRichText("Our Boston office"),
    },
  ];
  const { bytes, warnings } = await buildPptxExportDocument(deck);
  expect(warnings).toEqual([]);

  const names = zipEntryNames(bytes);
  // logo + background + slide image = three media parts
  expect(names.filter((name) => name.startsWith("ppt/media/"))).toHaveLength(3);

  const contentTypes = storedZipEntry(bytes, "[Content_Types].xml");
  expect(contentTypes).toContain('<Default Extension="jpeg" ContentType="image/jpeg"/>');

  const imageSlide = storedZipEntry(bytes, "ppt/slides/slide2.xml");
  expect(imageSlide).toContain("<p:pic>");
  expect(imageSlide).toContain("Our Boston office");
  // Background swaps the solid fill for a blip fill on every slide.
  expect(imageSlide).toContain("<a:blipFill>");
  const titleSlide = storedZipEntry(bytes, "ppt/slides/slide1.xml");
  expect(titleSlide).toContain("Brand logo");

  const slideRels = storedZipEntry(bytes, "ppt/slides/_rels/slide2.xml.rels");
  const parsed = new DOMParser().parseFromString(slideRels, "application/xml");
  for (const relationship of Array.from(parsed.getElementsByTagName("Relationship"))) {
    const target = relationship.getAttribute("Target") ?? "";
    const resolved = resolveRelTarget("ppt/slides", target);
    expect(names, `unresolved rel ${target}`).toContain(resolved);
  }
});

test("a slide's own uploaded background overrides the brand background", async () => {
  const deck = blankSlideDeck("Backdrops");
  deck.theme.backgroundImage = { dataUrl: `data:image/jpeg;base64,${SMALL_JPEG}` };
  deck.slides = [
    {
      id: "s1",
      notes: "",
      layout: "title",
      title: deckRichText("Cover"),
      subtitle: [],
      background: { dataUrl: `data:image/jpeg;base64,${SMALL_JPEG_ALT}` },
    },
    { id: "s2", notes: "", layout: "section", title: deckRichText("Shared"), subtitle: [] },
  ];
  const { bytes, warnings } = await buildPptxExportDocument(deck);
  expect(warnings).toEqual([]);

  // Two distinct pictures: the slide's own background plus the shared brand
  // background, each embedded once.
  const names = zipEntryNames(bytes);
  expect(names.filter((name) => name.startsWith("ppt/media/"))).toHaveLength(2);

  const ownBackgroundSlide = storedZipEntry(bytes, "ppt/slides/slide1.xml");
  const brandBackgroundSlide = storedZipEntry(bytes, "ppt/slides/slide2.xml");
  expect(ownBackgroundSlide).toContain("<p:bg>");
  expect(ownBackgroundSlide).toContain("<a:blipFill>");
  expect(brandBackgroundSlide).toContain("<a:blipFill>");
  expectWellFormedXml(ownBackgroundSlide);

  for (const slideNumber of [1, 2]) {
    const rels = storedZipEntry(bytes, `ppt/slides/_rels/slide${slideNumber}.xml.rels`);
    const parsed = new DOMParser().parseFromString(rels, "application/xml");
    for (const relationship of Array.from(parsed.getElementsByTagName("Relationship"))) {
      const target = relationship.getAttribute("Target") ?? "";
      const resolved = resolveRelTarget("ppt/slides", target);
      expect(names, `unresolved rel ${target}`).toContain(resolved);
    }
  }
});

test("a user-resized block box lands at its adjusted PPTX position", async () => {
  const deck = blankSlideDeck("Resized");
  deck.slides = [
    {
      id: "s1",
      notes: "",
      layout: "closing",
      title: deckRichText("Thanks"),
      body: deckRichText("Closing message"),
      // Default closing body is {160,306,640,96}; the user grew and moved it.
      boxes: { body: { x: 120, y: 280, w: 720, h: 200 } },
    },
  ];
  const { bytes } = await buildPptxExportDocument(deck);
  const slide = storedZipEntry(bytes, "ppt/slides/slide1.xml");
  // 12700 EMU per preview pixel.
  expect(slide).toContain('<a:off x="1524000" y="3556000"/>');
  expect(slide).toContain('<a:ext cx="9144000" cy="2540000"/>');
  expect(slide).not.toContain('<a:off x="2032000" y="3886200"/>');
  expectWellFormedXml(slide);
});
