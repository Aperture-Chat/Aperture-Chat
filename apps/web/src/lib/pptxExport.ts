/** Real .pptx (PresentationML OOXML) export for deck drafts.
 *
 * The package is hand-built the same way docxExport builds Word files: a
 * STORED zip (ooxmlZip.ts) of XML parts. Slides are drawn as explicit
 * positioned text boxes from the shared geometry table (deckGeometry.ts), so
 * the exported file mirrors the on-screen stage by construction — no
 * placeholder inheritance, which is where hand-built PPTX usually breaks.
 *
 * Scope: the text layouts (title, title-bullets, two-column, section, quote,
 * closing, image-caption, chart titles) plus real media parts (slide images,
 * brand logo, backgrounds). Slides with speaker notes export genuine
 * notesSlide parts — backed by a notesMaster and its own theme part — so the
 * PowerPoint notes pane shows them. Hyperlink relationships remain out of
 * scope.
 */

import { buildZip, type ZipEntry } from "./ooxmlZip";
import {
  embeddedJpegFromDataUrl,
  loadExportImage,
  rasterizeExportImage,
  type ExportImageProxy,
} from "./docxExport";
import {
  boxToEmu,
  slideDecorations,
  resolvedMediaBox,
  resolvedTextRegions,
  DECK_LOGO_BOX,
  DECK_SLIDE_HEIGHT_EMU,
  DECK_SLIDE_WIDTH_EMU,
  type DeckBox,
  type DeckColorRole,
  type DeckTextRegionSpec,
} from "./deck/deckGeometry";
import {
  deckRichTextParagraphs,
  deckRunsText,
  deckSlideBackgroundSource,
  isDeckBulletList,
  type DeckBullet,
  type DeckRichText,
  type DeckSlide,
  type DeckTextRun,
  type DeckTheme,
  type SlideDeck,
} from "./deck/deckModel";

export const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const XMLNS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XMLNS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const XMLNS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hex(color: string) {
  return color.replace(/^#/, "").toUpperCase();
}

function themeColor(theme: DeckTheme, role: DeckColorRole): string {
  switch (role) {
    case "heading":
      return theme.colors.heading;
    case "body":
      return theme.colors.body;
    case "accent1":
      return theme.colors.accent1;
    case "accent2":
      return theme.colors.accent2;
    case "surface":
      return theme.colors.surface;
    case "background":
      return theme.colors.background;
  }
}

/* ------------------------------ media loading ------------------------------ */

type PptxImageResource = {
  /** Media part name, e.g. "image1.jpeg" (under ppt/media/). */
  name: string;
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
};

/** Loads any image source into JPEG bytes for a media part. Cover-crops to
 * the target box aspect when one is given so the export matches the on-screen
 * object-fit: cover rendering. Returns null (never throws) on failure. */
async function loadPptxImageResource(
  src: string,
  index: number,
  imageProxy: ExportImageProxy | undefined,
  coverBox: DeckBox | null,
): Promise<PptxImageResource | null> {
  const name = `image${index}.jpeg`;
  const loaded = await loadExportImage(src, imageProxy);
  if (loaded) {
    let crop: { sx: number; sy: number; sw: number; sh: number } | null = null;
    if (coverBox) {
      const boxAspect = coverBox.w / coverBox.h;
      const naturalAspect = loaded.width / loaded.height;
      if (naturalAspect > boxAspect + 0.01) {
        const sourceWidth = loaded.height * boxAspect;
        crop = { sx: (loaded.width - sourceWidth) / 2, sy: 0, sw: sourceWidth, sh: loaded.height };
      } else if (naturalAspect < boxAspect - 0.01) {
        const sourceHeight = loaded.width / boxAspect;
        crop = { sx: 0, sy: (loaded.height - sourceHeight) / 2, sw: loaded.width, sh: sourceHeight };
      }
    }
    const bytes = rasterizeExportImage(loaded, crop);
    if (bytes) {
      return {
        name,
        bytes,
        widthPx: crop ? Math.round(crop.sw) : loaded.width,
        heightPx: crop ? Math.round(crop.sh) : loaded.height,
      };
    }
  }
  // Direct JPEG data-URL decode keeps working where canvas is unavailable
  // (test runtimes) — no cover-crop in that path.
  const embedded = embeddedJpegFromDataUrl(src);
  if (embedded) {
    return { name, bytes: embedded.bytes, widthPx: embedded.width, heightPx: embedded.height };
  }
  return null;
}

/** Contain-fit a natural size inside a box, anchored bottom-right (logo). */
function containInBox(box: DeckBox, widthPx: number, heightPx: number): DeckBox {
  const scale = Math.min(box.w / widthPx, box.h / heightPx, 1);
  const w = Math.max(1, widthPx * scale);
  const h = Math.max(1, heightPx * scale);
  return { x: box.x + box.w - w, y: box.y + box.h - h, w, h };
}

function picXml(shapeId: number, name: string, relId: string, box: DeckBox): string {
  const { xEmu, yEmu, wEmu, hEmu } = boxToEmu(box);
  return (
    `<p:pic>` +
    `<p:nvPicPr><p:cNvPr id="${shapeId}" name="${escapeXml(name)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${xEmu}" y="${yEmu}"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `</p:pic>`
  );
}

/* ------------------------------ text rendering ------------------------------ */

function runXml(
  run: DeckTextRun,
  spec: DeckTextRegionSpec,
  theme: DeckTheme,
  defaultColor?: string,
): string {
  const sizeHundredths = Math.round((run.sizePt ?? spec.sizePt) * 100);
  const bold = run.bold ?? spec.bold ? " b=\"1\"" : "";
  const italic = run.italic ?? spec.italic ? " i=\"1\"" : "";
  const underline = run.underline ? ' u="sng"' : "";
  const strike = run.strike ? ' strike="sngStrike"' : "";
  const color = hex(run.color ?? defaultColor ?? themeColor(theme, spec.colorRole));
  // A per-run font override wins; otherwise the region's theme font applies.
  const typeface = escapeXml(run.font ?? theme.fonts[spec.font]);
  return (
    `<a:r><a:rPr lang="en-US" sz="${sizeHundredths}"${bold}${italic}${underline}${strike} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    `<a:latin typeface="${typeface}"/>` +
    `</a:rPr><a:t>${escapeXml(run.text)}</a:t></a:r>`
  );
}

function paragraphProperties(spec: DeckTextRegionSpec, bulletLevel: number | null): string {
  const align = spec.align === "center" ? ' algn="ctr"' : ' algn="l"';
  if (bulletLevel === null) {
    return `<a:pPr${align}><a:buNone/></a:pPr>`;
  }
  const marL = 274_638 + bulletLevel * 274_638;
  const chars = ["•", "–", "·"];
  return (
    `<a:pPr${align} marL="${marL}" indent="-274638" lvl="${bulletLevel}">` +
    `<a:lnSpc><a:spcPct val="104000"/></a:lnSpc>` +
    `<a:spcBef><a:spcPts val="600"/></a:spcBef>` +
    `<a:buChar char="${chars[bulletLevel] ?? "•"}"/>` +
    `</a:pPr>`
  );
}

function textShapeXml(
  shapeId: number,
  name: string,
  spec: DeckTextRegionSpec,
  content: DeckRichText | DeckBullet[],
  theme: DeckTheme,
  defaultColor?: string,
): string | null {
  const paragraphs: string[] = [];
  if (!isDeckBulletList(content)) {
    // Rich region: per-run bold/italic/underline/colour/size all export.
    if (!deckRunsText(content).trim()) return null;
    deckRichTextParagraphs(content).forEach((runs) => {
      const rendered = runs.map((run) => runXml(run, spec, theme, defaultColor)).join("");
      paragraphs.push(`<a:p>${paragraphProperties(spec, null)}${rendered}</a:p>`);
    });
  } else {
    const bullets = content.filter((bullet) => deckRunsText(bullet.runs).trim().length > 0);
    if (!bullets.length) return null;
    bullets.forEach((bullet) => {
      const runs = bullet.runs.map((run) => runXml(run, spec, theme, defaultColor)).join("");
      paragraphs.push(`<a:p>${paragraphProperties(spec, bullet.level)}${runs}</a:p>`);
    });
  }
  const { xEmu, yEmu, wEmu, hEmu } = boxToEmu(spec.box);
  const anchor = spec.anchor === "middle" ? ' anchor="ctr"' : ' anchor="t"';
  return (
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="${shapeId}" name="${escapeXml(name)}"/>` +
    `<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${xEmu}" y="${yEmu}"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" rtlCol="0"${anchor}><a:normAutofit/></a:bodyPr><a:lstStyle/>` +
    paragraphs.join("") +
    `</p:txBody></p:sp>`
  );
}

function decorationShapeXml(shapeId: number, box: ReturnType<typeof boxToEmu>, color: string): string {
  return (
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="${shapeId}" name="Accent ${shapeId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.xEmu}" y="${box.yEmu}"/><a:ext cx="${box.wEmu}" cy="${box.hEmu}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`
  );
}

/** Region key → the slide field carrying its content. */
function regionContent(slide: DeckSlide, region: string): DeckRichText | DeckBullet[] | null {
  switch (slide.layout) {
    case "title":
    case "section":
      return region === "title" ? slide.title : region === "subtitle" ? slide.subtitle : null;
    case "title-bullets":
      return region === "title" ? slide.title : region === "bullets" ? slide.bullets : null;
    case "two-column":
      return region === "title"
        ? slide.title
        : region === "left"
          ? slide.left
          : region === "right"
            ? slide.right
            : null;
    case "image-caption":
      return region === "title" ? slide.title : region === "caption" ? slide.caption : null;
    case "quote":
      return region === "quote" ? slide.quote : region === "attribution" ? slide.attribution : null;
    case "chart":
      return region === "title" ? slide.title : null;
    case "closing":
      return region === "title" ? slide.title : region === "body" ? slide.body : null;
  }
}

type SlideMedia = {
  /** rel id → media part name, for this slide's .rels file. */
  rels: Array<{ relId: string; target: string }>;
  /** Slide-content picture (image-caption layout). */
  contentPic: { relId: string; box: DeckBox } | null;
  logoPic: { relId: string; box: DeckBox } | null;
  backgroundRelId: string | null;
};

function slideXml(slide: DeckSlide, theme: DeckTheme, media: SlideMedia): string {
  const shapes: string[] = [];
  let shapeId = 2;
  if (media.contentPic) {
    shapes.push(picXml(shapeId, "Slide image", media.contentPic.relId, media.contentPic.box));
    shapeId += 1;
  }
  slideDecorations(slide.layout).forEach((decoration) => {
    shapes.push(
      decorationShapeXml(shapeId, boxToEmu(decoration.box), hex(themeColor(theme, decoration.colorRole))),
    );
    shapeId += 1;
  });
  // User-resized boxes flow into the export through the shared resolver.
  const regions = resolvedTextRegions(slide);
  for (const [region, spec] of Object.entries(regions)) {
    const content = regionContent(slide, region);
    if (content === null) continue;
    const shape = textShapeXml(
      shapeId,
      `${slide.layout} ${region}`,
      spec,
      content,
      theme,
      slide.textColor,
    );
    if (shape) {
      shapes.push(shape);
      shapeId += 1;
    }
  }
  if (media.logoPic) {
    shapes.push(picXml(shapeId, "Brand logo", media.logoPic.relId, media.logoPic.box));
    shapeId += 1;
  }
  const background = media.backgroundRelId
    ? `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="${media.backgroundRelId}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`
    : `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(theme.colors.background)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="${XMLNS_A}" xmlns:r="${XMLNS_R}" xmlns:p="${XMLNS_P}">` +
    `<p:cSld>` +
    background +
    `<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    shapes.join("") +
    `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

/* ------------------------------ fixed parts ------------------------------ */

function contentTypesXml(
  slideCount: number,
  hasMedia: boolean,
  notedSlideNumbers: number[],
): string {
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`,
  ];
  for (let index = 1; index <= slideCount; index += 1) {
    overrides.push(
      `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    );
  }
  if (notedSlideNumbers.length) {
    overrides.push(
      `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`,
      `<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    );
    for (const slideNumber of notedSlideNumbers) {
      overrides.push(
        `<Override PartName="/ppt/notesSlides/notesSlide${slideNumber}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
      );
    }
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    (hasMedia ? `<Default Extension="jpeg" ContentType="image/jpeg"/>` : "") +
    overrides.join("") +
    `</Types>`
  );
}

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="${REL_NS}">` +
  `<Relationship Id="rId1" Type="${RT}/officeDocument" Target="ppt/presentation.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="${RT}/extended-properties" Target="docProps/app.xml"/>` +
  `</Relationships>`;

function corePropsXml(title: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dc:creator>Aperture Chat</dc:creator>` +
    `</cp:coreProperties>`
  );
}

function appPropsXml(slideCount: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>Aperture Chat</Application>` +
    `<Slides>${slideCount}</Slides>` +
    `</Properties>`
  );
}

function presentationXml(slideCount: number, hasNotes: boolean): string {
  const slideIds: string[] = [];
  for (let index = 1; index <= slideCount; index += 1) {
    slideIds.push(`<p:sldId id="${255 + index}" r:id="rIdSlide${index}"/>`);
  }
  // Schema order (CT_Presentation): sldMasterIdLst, notesMasterIdLst,
  // sldIdLst, sldSz, notesSz. Relationship ids are named strings, so the
  // notes-master id can never collide with rIdMaster1/rIdSlideN.
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:presentation xmlns:a="${XMLNS_A}" xmlns:r="${XMLNS_R}" xmlns:p="${XMLNS_P}">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst>` +
    (hasNotes
      ? `<p:notesMasterIdLst><p:notesMasterId r:id="rIdNotesMaster1"/></p:notesMasterIdLst>`
      : "") +
    (slideIds.length ? `<p:sldIdLst>${slideIds.join("")}</p:sldIdLst>` : "") +
    `<p:sldSz cx="${DECK_SLIDE_WIDTH_EMU}" cy="${DECK_SLIDE_HEIGHT_EMU}"/>` +
    `<p:notesSz cx="6858000" cy="9144000"/>` +
    `</p:presentation>`
  );
}

function presentationRelsXml(slideCount: number, hasNotes: boolean): string {
  const relationships = [
    `<Relationship Id="rIdMaster1" Type="${RT}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
  ];
  for (let index = 1; index <= slideCount; index += 1) {
    relationships.push(
      `<Relationship Id="rIdSlide${index}" Type="${RT}/slide" Target="slides/slide${index}.xml"/>`,
    );
  }
  if (hasNotes) {
    relationships.push(
      `<Relationship Id="rIdNotesMaster1" Type="${RT}/notesMaster" Target="notesMasters/notesMaster1.xml"/>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${REL_NS}">${relationships.join("")}</Relationships>`
  );
}

function slideMasterXml(theme: DeckTheme): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sldMaster xmlns:a="${XMLNS_A}" xmlns:r="${XMLNS_R}" xmlns:p="${XMLNS_P}">` +
    `<p:cSld>` +
    `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(theme.colors.background)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `</p:spTree></p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
    `<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>` +
    `</p:sldMaster>`
  );
}

const SLIDE_MASTER_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="${REL_NS}">` +
  `<Relationship Id="rId1" Type="${RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
  `<Relationship Id="rId2" Type="${RT}/theme" Target="../theme/theme1.xml"/>` +
  `</Relationships>`;

const SLIDE_LAYOUT_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:sldLayout xmlns:a="${XMLNS_A}" xmlns:r="${XMLNS_R}" xmlns:p="${XMLNS_P}" type="blank" preserve="1">` +
  `<p:cSld name="Blank">` +
  `<p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `</p:spTree></p:cSld>` +
  `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
  `</p:sldLayout>`;

const SLIDE_LAYOUT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="${REL_NS}">` +
  `<Relationship Id="rId1" Type="${RT}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
  `</Relationships>`;

function slideRelsXml(media: SlideMedia, notesSlideNumber: number | null): string {
  const relationships = [
    `<Relationship Id="rId1" Type="${RT}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    ...media.rels.map(
      (rel) =>
        `<Relationship Id="${rel.relId}" Type="${RT}/image" Target="../media/${rel.target}"/>`,
    ),
  ];
  if (notesSlideNumber !== null) {
    relationships.push(
      `<Relationship Id="rIdNotes1" Type="${RT}/notesSlide" Target="../notesSlides/notesSlide${notesSlideNumber}.xml"/>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${REL_NS}">${relationships.join("")}</Relationships>`
  );
}

/* ------------------------------ speaker notes ------------------------------ */

/* Notes parts mirror a PowerPoint-authored package: a notesMaster (with its
 * own theme part, theme2.xml) referenced from presentation.xml via
 * notesMasterIdLst, plus one notesSlide per noted slide. Each notesSlide
 * carries the standard sldImg placeholder and a body placeholder holding the
 * notes text; its .rels points at the notesMaster and back at its slide. All
 * of it is emitted only when at least one slide has notes, so no-notes decks
 * keep today's byte-identical structure. */

const NOTES_CLR_MAP =
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`;

/** notesMaster1.xml: the standard notes-page master — a framed slide-image
 * placeholder above a body placeholder — on the 6858000x9144000 notes page.
 * Notes pages render paper-white regardless of the deck's slide background. */
const NOTES_MASTER_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<p:notesMaster xmlns:a="${XMLNS_A}" xmlns:r="${XMLNS_R}" xmlns:p="${XMLNS_P}">` +
  `<p:cSld>` +
  `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
  `<p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  `<p:sp>` +
  `<p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/>` +
  `<p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>` +
  `<p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="1143000" y="685800"/><a:ext cx="4572000" cy="3429000"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>` +
  `<a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr>` +
  `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>` +
  `</p:sp>` +
  `<p:sp>` +
  `<p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/>` +
  `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
  `<p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
  `<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/>` +
  `<a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody>` +
  `</p:sp>` +
  `</p:spTree></p:cSld>` +
  NOTES_CLR_MAP +
  `<p:notesStyle>` +
  `<a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200" kern="1200">` +
  `<a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/>` +
  `</a:defRPr></a:lvl1pPr>` +
  `</p:notesStyle>` +
  `</p:notesMaster>`;

const NOTES_MASTER_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="${REL_NS}">` +
  `<Relationship Id="rId1" Type="${RT}/theme" Target="../theme/theme2.xml"/>` +
  `</Relationships>`;

/** notesSlideN.xml: sldImg placeholder plus a body placeholder whose
 * paragraphs are the notes text, one paragraph per authored line. */
function notesSlideXml(notes: string): string {
  const paragraphs = notes
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        ? `<a:p><a:r><a:t>${escapeXml(line)}</a:t></a:r></a:p>`
        : `<a:p><a:endParaRPr lang="en-US"/></a:p>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:notes xmlns:a="${XMLNS_A}" xmlns:r="${XMLNS_R}" xmlns:p="${XMLNS_P}">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/>` +
    `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/>` +
    `</p:sp>` +
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/>` +
    `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody>` +
    `</p:sp>` +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:notes>`
  );
}

function notesSlideRelsXml(slideNumber: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${REL_NS}">` +
    `<Relationship Id="rId1" Type="${RT}/notesMaster" Target="../notesMasters/notesMaster1.xml"/>` +
    `<Relationship Id="rId2" Type="${RT}/slide" Target="../slides/slide${slideNumber}.xml"/>` +
    `</Relationships>`
  );
}

/** theme1.xml: brand color/font schemes plus the fixed fmtScheme boilerplate
 * every valid theme needs (never visible — slide shapes carry explicit
 * fills). */
function themeXml(theme: DeckTheme): string {
  const c = theme.colors;
  const fmtScheme =
    `<a:fmtScheme name="Office">` +
    `<a:fillStyleLst>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"><a:tint val="65000"/></a:schemeClr></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill>` +
    `</a:fillStyleLst>` +
    `<a:lnStyleLst>` +
    `<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>` +
    `<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>` +
    `<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>` +
    `</a:lnStyleLst>` +
    `<a:effectStyleLst>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `</a:effectStyleLst>` +
    `<a:bgFillStyleLst>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill>` +
    `</a:bgFillStyleLst>` +
    `</a:fmtScheme>`;
  const major = escapeXml(theme.fonts.major);
  const minor = escapeXml(theme.fonts.minor);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<a:theme xmlns:a="${XMLNS_A}" name="Aperture Deck">` +
    `<a:themeElements>` +
    `<a:clrScheme name="Aperture">` +
    `<a:dk1><a:srgbClr val="${hex(c.body)}"/></a:dk1>` +
    `<a:lt1><a:srgbClr val="${hex(c.background)}"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="${hex(c.heading)}"/></a:dk2>` +
    `<a:lt2><a:srgbClr val="${hex(c.surface)}"/></a:lt2>` +
    `<a:accent1><a:srgbClr val="${hex(c.accent1)}"/></a:accent1>` +
    `<a:accent2><a:srgbClr val="${hex(c.accent2)}"/></a:accent2>` +
    `<a:accent3><a:srgbClr val="${hex(c.accent1)}"/></a:accent3>` +
    `<a:accent4><a:srgbClr val="${hex(c.accent2)}"/></a:accent4>` +
    `<a:accent5><a:srgbClr val="${hex(c.accent1)}"/></a:accent5>` +
    `<a:accent6><a:srgbClr val="${hex(c.accent2)}"/></a:accent6>` +
    `<a:hlink><a:srgbClr val="${hex(c.accent1)}"/></a:hlink>` +
    `<a:folHlink><a:srgbClr val="${hex(c.accent2)}"/></a:folHlink>` +
    `</a:clrScheme>` +
    `<a:fontScheme name="Aperture">` +
    `<a:majorFont><a:latin typeface="${major}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="${minor}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    `</a:fontScheme>` +
    fmtScheme +
    `</a:themeElements>` +
    `</a:theme>`
  );
}

/* ------------------------------ entry point ------------------------------ */

export type PptxExportResult = { bytes: Uint8Array; warnings: string[] };

/** Builds a genuine .pptx for the deck: real PresentationML, one explicit
 * text box per on-screen region, 16:9 geometry identical to the stage.
 * Slide images, the brand logo, and the brand background embed as real media
 * parts; any image that cannot be fetched is reported in `warnings`, never
 * silently faked. */
export async function buildPptxExportDocument(
  deck: SlideDeck,
  imageProxy?: ExportImageProxy,
): Promise<PptxExportResult> {
  const encoder = new TextEncoder();
  const warnings: string[] = [];
  const mediaParts: PptxImageResource[] = [];
  let mediaIndex = 0;

  const loadMedia = async (src: string, coverBox: DeckBox | null, label: string) => {
    mediaIndex += 1;
    const resource = await loadPptxImageResource(src, mediaIndex, imageProxy, coverBox);
    if (!resource) {
      mediaIndex -= 1;
      warnings.push(`${label} could not be embedded and was left out of the file.`);
      return null;
    }
    mediaParts.push(resource);
    return resource;
  };

  const logoResource = deck.theme.logo
    ? await loadMedia(deck.theme.logo.dataUrl, null, "The brand logo")
    : null;
  // Backgrounds are cached by source so a deck-wide brand background embeds as
  // one media part, and a failure is reported once rather than per slide.
  const backgroundCache = new Map<string, PptxImageResource | null>();
  const backgroundResourceFor = async (src: string, label: string) => {
    const cached = backgroundCache.get(src);
    if (cached !== undefined) return cached;
    const resource = await loadMedia(
      src,
      { x: 0, y: 0, w: DECK_PREVIEW_BOX.w, h: DECK_PREVIEW_BOX.h },
      label,
    );
    backgroundCache.set(src, resource);
    return resource;
  };

  const slideMediaList: SlideMedia[] = [];
  for (const [slideIndex, slide] of deck.slides.entries()) {
    const media: SlideMedia = { rels: [], contentPic: null, logoPic: null, backgroundRelId: null };
    let relCounter = 1;
    const nextRelId = () => {
      relCounter += 1;
      return `rIdMedia${relCounter}`;
    };
    if (slide.layout === "image-caption" && slide.image.src) {
      const box = resolvedMediaBox(slide);
      const resource = box
        ? await loadMedia(slide.image.src, box, `Slide ${slideIndex + 1}'s image`)
        : null;
      if (resource && box) {
        const relId = nextRelId();
        media.rels.push({ relId, target: resource.name });
        media.contentPic = { relId, box };
      }
    }
    // A slide with its own template design already contains that design's
    // logo; stamping the extracted one on top would double it.
    if (logoResource && !slide.backgroundId) {
      const relId = nextRelId();
      media.rels.push({ relId, target: logoResource.name });
      media.logoPic = {
        relId,
        box: containInBox(
          DECK_LOGO_BOX,
          deck.theme.logo?.widthPx ?? logoResource.widthPx,
          deck.theme.logo?.heightPx ?? logoResource.heightPx,
        ),
      };
    }
    const backgroundSrc = deckSlideBackgroundSource(slide, deck.theme);
    if (backgroundSrc) {
      const backgroundResource = await backgroundResourceFor(
        backgroundSrc,
        slide.background ? `Slide ${slideIndex + 1}'s background` : "The brand background",
      );
      if (backgroundResource) {
        const relId = nextRelId();
        media.rels.push({ relId, target: backgroundResource.name });
        media.backgroundRelId = relId;
      }
    }
    slideMediaList.push(media);
  }

  const slideCount = deck.slides.length;
  // Slides whose speaker notes carry real text (matching the outline
  // exporter's gate) get notesSlide parts named after their slide number.
  const notedSlideNumbers = deck.slides.flatMap((slide, index) =>
    slide.notes.trim() ? [index + 1] : [],
  );
  const hasNotes = notedSlideNumbers.length > 0;
  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      bytes: encoder.encode(contentTypesXml(slideCount, mediaParts.length > 0, notedSlideNumbers)),
    },
    { name: "_rels/.rels", bytes: encoder.encode(ROOT_RELS_XML) },
    { name: "docProps/core.xml", bytes: encoder.encode(corePropsXml(deck.title)) },
    { name: "docProps/app.xml", bytes: encoder.encode(appPropsXml(slideCount)) },
    { name: "ppt/presentation.xml", bytes: encoder.encode(presentationXml(slideCount, hasNotes)) },
    { name: "ppt/_rels/presentation.xml.rels", bytes: encoder.encode(presentationRelsXml(slideCount, hasNotes)) },
    { name: "ppt/slideMasters/slideMaster1.xml", bytes: encoder.encode(slideMasterXml(deck.theme)) },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", bytes: encoder.encode(SLIDE_MASTER_RELS_XML) },
    { name: "ppt/slideLayouts/slideLayout1.xml", bytes: encoder.encode(SLIDE_LAYOUT_XML) },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", bytes: encoder.encode(SLIDE_LAYOUT_RELS_XML) },
    { name: "ppt/theme/theme1.xml", bytes: encoder.encode(themeXml(deck.theme)) },
  ];
  if (hasNotes) {
    // The notes master carries its own theme part (theme2.xml), mirroring
    // PowerPoint's package layout; it reuses the deck theme's XML verbatim.
    entries.push(
      { name: "ppt/notesMasters/notesMaster1.xml", bytes: encoder.encode(NOTES_MASTER_XML) },
      { name: "ppt/notesMasters/_rels/notesMaster1.xml.rels", bytes: encoder.encode(NOTES_MASTER_RELS_XML) },
      { name: "ppt/theme/theme2.xml", bytes: encoder.encode(themeXml(deck.theme)) },
    );
  }
  deck.slides.forEach((slide, index) => {
    const slideNumber = index + 1;
    const hasSlideNotes = notedSlideNumbers.includes(slideNumber);
    entries.push({
      name: `ppt/slides/slide${slideNumber}.xml`,
      bytes: encoder.encode(slideXml(slide, deck.theme, slideMediaList[index])),
    });
    entries.push({
      name: `ppt/slides/_rels/slide${slideNumber}.xml.rels`,
      bytes: encoder.encode(slideRelsXml(slideMediaList[index], hasSlideNotes ? slideNumber : null)),
    });
    if (hasSlideNotes) {
      entries.push({
        name: `ppt/notesSlides/notesSlide${slideNumber}.xml`,
        bytes: encoder.encode(notesSlideXml(slide.notes)),
      });
      entries.push({
        name: `ppt/notesSlides/_rels/notesSlide${slideNumber}.xml.rels`,
        bytes: encoder.encode(notesSlideRelsXml(slideNumber)),
      });
    }
  });
  for (const part of mediaParts) {
    entries.push({ name: `ppt/media/${part.name}`, bytes: part.bytes });
  }
  return { bytes: buildZip(entries), warnings };
}

const DECK_PREVIEW_BOX: DeckBox = { x: 0, y: 0, w: 960, h: 540 };

export function pptxExportFilename(title: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").slice(0, 80) || "deck";
  return `${base}.pptx`;
}
