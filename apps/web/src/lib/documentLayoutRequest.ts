/* Layout asked for in plain English.
 *
 * "Use Times New Roman 12 pt, double spaced, with 1-inch margins and page
 * numbers at the bottom center" is a page setup, not prose: it is read here,
 * deterministically, into changes on the document's page setup
 * (documentPageSetup.ts), so the layout is exact rather than left to a model
 * that can only return Markdown. A request that asks for nothing but layout is
 * applied without a model call. */

import {
  DOCUMENT_FIELD_PAGE_CLASS,
  cssFontFamilyStack,
  fontLineFactor,
  primaryFontFamily,
  pxFromPt,
  roundTo,
  type DocumentPageSetup,
} from "./documentPageSetup";
import { cssLength, runningTextHtml, type FormatAlign, type RunningText } from "./documentFormats";

export type PageNumberRequest = {
  zone: "header" | "footer";
  align: "left" | "center" | "right";
  style: "number" | "page" | "page-of";
};

export type LayoutChanges = {
  /** A named format ("contract format", "as a memo"). */
  formatId?: string;
  fontName?: string;
  fontSizePt?: number;
  headingFontName?: string;
  headingSizePt?: number;
  lineSpacing?: number;
  margins?: Partial<Record<"top" | "right" | "bottom" | "left", number>>;
  paper?: { widthPt: number; heightPt: number; label: string };
  orientation?: "landscape" | "portrait";
  bodyAlign?: FormatAlign;
  indentFirstPt?: number;
  paragraphAfterPt?: number;
  pageNumbers?: PageNumberRequest | "none";
  skipFirstPageNumber?: boolean;
  headerText?: string;
  footerText?: string;
  headingAlign?: FormatAlign;
  titleAlign?: FormatAlign;
  headingCaps?: boolean;
  headingBold?: boolean;
  headingUnderline?: boolean;
};

export type LayoutRequest = {
  changes: LayoutChanges;
  /** What was understood, for the status line ("Times New Roman", "12 pt"). */
  applied: string[];
  /** Character ranges of the request that described layout. */
  spans: Array<[number, number]>;
};

const KNOWN_FONTS = [
  "Times New Roman",
  "Arial Narrow",
  "Arial",
  "Calibri Light",
  "Calibri",
  "Cambria",
  "EB Garamond",
  "Garamond",
  "Georgia",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Book Antiqua",
  "Palatino Linotype",
  "Palatino",
  "Century Schoolbook",
  "Century Gothic",
  "Courier New",
  "Courier",
  "Aptos",
  "Segoe UI",
  "Trebuchet MS",
  "Franklin Gothic Book",
  "Bookman Old Style",
  "Constantia",
  "Candara",
  "Corbel",
  "Consolas",
  "Baskerville",
  "Gill Sans",
  "Futura",
  "Roboto",
  "Open Sans",
  "Lato",
  "Source Sans Pro",
  "Liberation Serif",
  "Liberation Sans",
];

const FONT_PATTERN = new RegExp(
  `\\b(${KNOWN_FONTS.map((name) => name.replace(/ /g, "\\s+")).join("|")})\\b`,
  "gi",
);
/** A font name counts only as a font: "in Arial", "Arial font", "Times New
 * Roman 12". "Notices by courier" and "Georgia law" are not typefaces. */
const FONT_BEFORE = /(?:\bin|\buse|\busing|\bto|\bfont(?:\s+family)?(?:\s+(?:of|as|to|is))?|\btypeface|\bset\s+in|\bwith)\s+(?:the\s+)?$/i;
const FONT_AFTER = /^\s*(?:font|typeface|type\b|text\b|\d{1,2}(?:\.\d)?\s*(?:-\s*)?(?:pt|pts|point|points)?\b)/i;
/** Typeface names that are also places, people, or ordinary words
 * ("governed by Georgia law", "notices by courier"): they count only with an
 * explicit typeface cue. */
const AMBIGUOUS_FONTS = new Set(["georgia", "courier", "cambria", "futura", "baskerville", "lato", "corbel", "constantia", "candara", "gill sans", "roboto", "open sans", "consolas", "aptos"]);
const STRONG_FONT_BEFORE = /(?:\bfont(?:\s+family)?(?:\s+(?:of|as|to|is))?|\btypeface(?:\s+(?:of|as|to|is))?|\b(?:use|using|switch\s+to|change\s+(?:the\s+)?font\s+to|set\s+(?:it\s+)?in)(?:\s+the)?)\s+$/i;
const STRONG_FONT_AFTER = /^\s*(?:font|typeface|type\b|\d{1,2}(?:\.\d)?\s*(?:-\s*)?(?:pt|pts|point)\b)/i;
/** A word after the name that makes it a noun phrase, not a typeface
 * ("in Arial Corporation's name" is rare, "in Georgia County" is not). */
const NOT_A_TYPEFACE_AFTER = /^\s+(?:law|laws|county|state|corporation|corp|inc|llc|company|court|courts|statute|code|residents?|office)\b/i;

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  half: 0.5,
  "half an": 0.5,
  "half a": 0.5,
  an: 1,
  a: 1,
  "one and a half": 1.5,
  "one-and-a-half": 1.5,
};

const NUMBER = String.raw`(\d+(?:\.\d+)?|one and a half|one-and-a-half|half an?|one|two|three|an?)`;
const UNIT = String.raw`(inches|inch|in\b|"|”|''|centimet(?:er|re)s?|cm|millimet(?:er|re)s?|mm|points?|pts?)`;

function amount(raw: string) {
  const key = raw.trim().toLowerCase();
  return NUMBER_WORDS[key] ?? Number.parseFloat(key);
}

function toPoints(value: number, unit: string) {
  const name = unit.toLowerCase();
  if (/^(inch|inches|in|"|”|'')$/.test(name)) return value * 72;
  if (/^(cm|centimet)/.test(name)) return value * 28.3465;
  if (/^(mm|millimet)/.test(name)) return value * 2.83465;
  return value;
}

function lengthLabel(points: number) {
  const inches = points / 72;
  return Number.isInteger(roundTo(inches * 8, 3)) ? `${roundTo(inches, 3)}-inch` : `${roundTo(points, 1)} pt`;
}

function canonicalFont(raw: string) {
  const clean = raw.replace(/\s+/g, " ").trim().toLowerCase();
  return KNOWN_FONTS.find((name) => name.toLowerCase() === clean) ?? raw;
}

function nearby(text: string, start: number, end: number, before: number, after: number) {
  return text.slice(Math.max(0, start - before), Math.min(text.length, end + after)).toLowerCase();
}

const HEADING_WORD = /\b(headings?|titles?|section\s+headings?)\b/;

/** Reads the layout a request describes. Returns null when it describes none. */
/** A request aimed at one part of a document ("double space the signature
 * block", "put section 3 in bold") is not a page setting: the page setup
 * applies to the whole document, so such requests are left to the model. */
const SCOPED_TO_PART =
  /\b(?:the\s+)?(?:signature\s+(?:block|page|lines?)|section\s+\d|article\s+\d|clause\s+\d|exhibit\s+[a-z0-9]|schedule\s+[a-z0-9]|recitals?|preamble|this\s+(?:paragraph|section|clause|table|page)|(?:the\s+)?(?:first|second|third|last|next|previous)\s+(?:paragraph|page|section|clause))\b/i;
const WHOLE_DOCUMENT = /\b(?:whole|entire|all|everything|throughout|document|draft|agreement|contract|letter|memo|paper)\b/i;

export function parseLayoutRequest(request: string): LayoutRequest | null {
  const text = request.replace(/\s+/g, " ");
  if (SCOPED_TO_PART.test(text) && !WHOLE_DOCUMENT.test(text)) return null;
  const changes: LayoutChanges = {};
  const applied: string[] = [];
  const spans: Array<[number, number]> = [];
  const note = (match: RegExpExecArray | RegExpMatchArray, label?: string) => {
    const start = match.index ?? 0;
    spans.push([start, start + match[0].length]);
    if (label && !applied.includes(label)) applied.push(label);
  };

  // Named formats.
  const named: Array<[RegExp, string, string]> = [
    [/\b(?:formal\s+|standard\s+|proper\s+)?(?:contract|agreement|legal)\s+(?:format|formatting|style|layout)\b|\b(?:format|lay\s*out|set)(?:ted)?\s+(?:it\s+|this\s+|the\s+document\s+)?(?:as|like)\s+an?\s+(?:formal\s+|legal\s+)?(?:contract|agreement)\b|\blooks?\s+like\s+an?\s+(?:formal\s+|legal\s+)?(?:contract|agreement)\b/i, "legal-agreement", "contract format"],
    [/\b(?:business\s+|formal\s+)?letter\s+(?:format|formatting|style|layout)\b|\b(?:format|lay\s*out|set)(?:ted)?\s+(?:it\s+|this\s+|the\s+document\s+)?(?:as|like)\s+an?\s+(?:business\s+|formal\s+)?letter\b|\blooks?\s+like\s+an?\s+(?:business\s+|formal\s+)?letter\b/i, "legal-letter", "letter format"],
    [/\bmemo(?:randum)?\s+(?:format|formatting|style|layout)\b|\b(?:format|lay\s*out|set)(?:ted)?\s+(?:it\s+|this\s+|the\s+document\s+)?(?:as|like)\s+an?\s+memo(?:randum)?\b|\blooks?\s+like\s+an?\s+memo(?:randum)?\b/i, "legal-memo", "memo format"],
    [/\b(?:apa|academic|research\s+paper|essay)\s+(?:format|formatting|style|layout)\b/i, "academic-paper", "academic paper format"],
    [/\b(?:screenplay|script|film\s+script)\s+(?:format|formatting|style|layout)\b|\b(?:format|lay\s*out|set)(?:ted)?\s+(?:it\s+|this\s+)?(?:as|like)\s+a\s+screenplay\b/i, "screenplay", "screenplay format"],
    [/\b(?:business\s+)?report\s+(?:format|formatting|style|layout)\b/i, "business-report", "report format"],
  ];
  for (const [pattern, id, label] of named) {
    const match = pattern.exec(text);
    if (match) {
      changes.formatId = id;
      note(match, label);
      break;
    }
  }

  // Typefaces.
  for (const match of text.matchAll(FONT_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = text.slice(Math.max(0, start - 40), start);
    const after = text.slice(end, end + 24);
    const name = canonicalFont(match[0]);
    if (NOT_A_TYPEFACE_AFTER.test(after)) continue;
    if (AMBIGUOUS_FONTS.has(name.toLowerCase())) {
      if (!STRONG_FONT_BEFORE.test(before) && !STRONG_FONT_AFTER.test(after)) continue;
    } else if (!FONT_BEFORE.test(before) && !FONT_AFTER.test(after)) {
      continue;
    }
    const forHeadings = HEADING_WORD.test(before.slice(-30).toLowerCase()) || /^\s*(?:for\s+(?:the\s+)?)?headings?\b/i.test(after);
    if (forHeadings) changes.headingFontName = name;
    else changes.fontName = name;
    note(match, forHeadings ? `${name} headings` : name);
  }

  // Sizes in points (not paragraph spacing).
  const sizePattern = /\b(\d{1,2}(?:\.5)?)\s*(?:-\s*)?(pt|pts|point|points)\b(?!\s+(?:of\s+)?(?:space|spacing|gap|before|after))/gi;
  for (const match of text.matchAll(sizePattern)) {
    const value = Number.parseFloat(match[1]);
    if (!(value >= 6 && value <= 72)) continue;
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 36), start).toLowerCase();
    // "Worth 10 points" is a score; "12-point" and "11 point font" are type.
    if (/^point/i.test(match[2])) {
      const afterSize = text.slice(start + match[0].length, start + match[0].length + 16);
      const typeCue =
        /-\s*point/i.test(match[0]) ||
        /^\s*(?:font|type|text|size)\b/i.test(afterSize) ||
        /\b(?:font|size|in|at|to)\s*$/i.test(before) ||
        new RegExp(`(?:${KNOWN_FONTS.map((font) => font.replace(/ /g, "\\s+")).join("|")})\\s*,?\\s*$`, "i").test(before);
      if (!typeCue) continue;
    }
    if (/\bspac(?:e|ing)\s+(?:of\s+)?$|margins?\s+(?:of\s+)?$/.test(before)) continue;
    if (HEADING_WORD.test(before.slice(-28)) && !/\b(body|text|font)\b[^.]*$/.test(before.slice(-12))) {
      changes.headingSizePt = value;
      note(match, `${value} pt headings`);
    } else if (changes.fontSizePt === undefined) {
      changes.fontSizePt = value;
      note(match, `${value} pt`);
    }
  }
  if (changes.fontSizePt === undefined) {
    const sized =
      /\bfont\s+size\s+(?:of\s+|to\s+|at\s+)?(\d{1,2}(?:\.5)?)\b|\bsize\s+(\d{1,2}(?:\.5)?)\s+font\b|\b(\d{1,2}(?:\.5)?)\s+font\b/i.exec(text) ??
      (changes.fontName
        ? new RegExp(`${changes.fontName.replace(/ /g, "\\s+")}\\s*,?\\s*(?:size\\s+)?(\\d{1,2}(?:\\.5)?)(?!\\s*(?:-\\s*)?(?:inch|in\\b|"|cm|mm|%|pages?|lines?|x\\b))`, "i").exec(text)
        : null);
    const value = sized ? Number.parseFloat(sized[1] ?? sized[2] ?? sized[3]) : Number.NaN;
    if (sized && value >= 6 && value <= 72) {
      changes.fontSizePt = value;
      note(sized, `${value} pt`);
    }
  }

  // Line spacing.
  const spacing: Array<[RegExp, number | null, string]> = [
    [/\bdouble[\s-]*(?:line[\s-]*)?spac(?:e|ed|ing)\b/i, 2, "double spacing"],
    [/\b(?:1\.5|one and a half|one-and-a-half)[\s-]*(?:line[\s-]*)?spac(?:e|ed|ing)\b/i, 1.5, "1.5 line spacing"],
    [/\bsingle[\s-]*(?:line[\s-]*)?spac(?:e|ed|ing)\b/i, 1, "single spacing"],
    [/\b(?:line\s+spacing|leading)\s+(?:of\s+|at\s+|to\s+)?(\d(?:\.\d{1,2})?)\b/i, null, ""],
    [/\b(\d(?:\.\d{1,2})?)[\s-]*(?:line\s+spacing|spacing)\b/i, null, ""],
  ];
  for (const [pattern, value, label] of spacing) {
    const match = pattern.exec(text);
    if (!match) continue;
    const resolved = value ?? Number.parseFloat(match[1]);
    if (!(resolved >= 1 && resolved <= 3)) continue;
    changes.lineSpacing = resolved;
    note(match, label || `${resolved} line spacing`);
    break;
  }

  // Margins.
  const sides = ["top", "right", "bottom", "left"] as const;
  const sidePattern = new RegExp(
    String.raw`\b(top|bottom|left|right)(?:\s*(?:and|&|,)\s*(top|bottom|left|right))?\s+margins?\s+(?:of\s+|at\s+|to\s+|:\s*|should\s+be\s+|set\s+to\s+)?${NUMBER}\s*(?:-\s*)?${UNIT}|\b${NUMBER}\s*(?:-\s*)?${UNIT}\s+(top|bottom|left|right)(?:\s*(?:and|&|,)\s*(top|bottom|left|right))?\s+margins?\b`,
    "gi",
  );
  for (const match of text.matchAll(sidePattern)) {
    const named = [match[1], match[2], match[7], match[8]].filter(Boolean).map((side) => side.toLowerCase());
    const value = amount(match[3] ?? match[5]);
    const unit = match[4] ?? match[6];
    const points = toPoints(value, unit);
    if (!(points >= 18 && points <= 216)) continue;
    changes.margins = { ...(changes.margins ?? {}) };
    named.forEach((side) => {
      (changes.margins as Record<string, number>)[side] = points;
    });
    note(match, `${lengthLabel(points)} ${named.join(" and ")} margin${named.length > 1 ? "s" : ""}`);
  }
  const allPattern = new RegExp(
    String.raw`\b${NUMBER}\s*(?:-\s*)?${UNIT}\s+margins?\b|\bmargins?\s+(?:of\s+|at\s+|to\s+|:\s*|should\s+be\s+|set\s+to\s+|all\s+(?:the\s+)?way\s+around\s+(?:of\s+)?)?${NUMBER}\s*(?:-\s*)?${UNIT}`,
    "i",
  );
  const allMatch = allPattern.exec(text);
  if (allMatch && !spans.some(([start, end]) => (allMatch.index ?? 0) >= start && (allMatch.index ?? 0) < end)) {
    const value = amount(allMatch[1] ?? allMatch[3]);
    const points = toPoints(value, allMatch[2] ?? allMatch[4]);
    if (points >= 18 && points <= 216) {
      const explicit = changes.margins ?? {};
      changes.margins = Object.fromEntries(sides.map((side) => [side, explicit[side] ?? points]));
      note(allMatch, `${lengthLabel(points)} margins`);
    }
  }

  // Paper and orientation.
  const legal = /\blegal[\s-]size(?:d)?(?:\s+paper)?\b|\b(?:on|use|using|print(?:ed)?\s+on)\s+legal\s+paper\b|\b8\.5\s*(?:x|×|by)\s*14\b/i.exec(text);
  const a4 = /\bA4\b/.exec(text);
  const letter = /\b(?:us\s+)?letter[\s-]size(?:d)?(?:\s+paper)?\b|\b8\.5\s*(?:x|×|by)\s*11\b/i.exec(text);
  if (legal) {
    changes.paper = { widthPt: 612, heightPt: 1008, label: "legal-size paper" };
    note(legal, "legal-size paper");
  } else if (a4) {
    changes.paper = { widthPt: 595.3, heightPt: 841.9, label: "A4 paper" };
    note(a4, "A4 paper");
  } else if (letter) {
    changes.paper = { widthPt: 612, heightPt: 792, label: "letter-size paper" };
    note(letter, "letter-size paper");
  }
  const orientation = /\b(landscape|portrait)(?:\s+(?:orientation|mode|layout|pages?|paper|format|view))?\b(?!\s+[a-z])/i.exec(text) ??
    /\b(landscape|portrait)\s+(?:orientation|mode|layout|pages?|paper|format|view)\b/i.exec(text);
  if (orientation) {
    changes.orientation = orientation[1].toLowerCase() as "landscape" | "portrait";
    note(orientation, changes.orientation);
  }

  // Body alignment and first-line indent.
  const justify = /\b(?:fully\s+)?justif(?:y|ied)\b(?!\s+(?:the\s+|our\s+|its\s+|a\s+)?(?:fee|fees|cost|costs|price|decision|claim|position|request|use|delay|need|expense)s?\b)|\b(?:full|text|block)\s+justification\b/i.exec(text);
  if (justify) {
    const before = text.slice(Math.max(0, (justify.index ?? 0) - 16), justify.index ?? 0);
    const negated = /\b(?:not|don't|do not|no|un)\s*$/i.test(before);
    const forHeadings = /^\s*(?:the\s+)?headings?\b/i.test(text.slice((justify.index ?? 0) + justify[0].length));
    if (!forHeadings) {
      changes.bodyAlign = negated ? "left" : "justify";
      note(justify, negated ? "left-aligned text" : "justified text");
    }
  }
  const left = /\b(?:left[\s-]align(?:ed)?|align(?:ed)?\s+(?:to\s+the\s+)?left|ragged[\s-]right|flush[\s-]left)\b(?!\s+(?:the\s+)?headings?)/i.exec(text);
  if (left && !changes.bodyAlign && !HEADING_WORD.test(nearby(text, left.index ?? 0, (left.index ?? 0) + left[0].length, 20, 0))) {
    changes.bodyAlign = "left";
    note(left, "left-aligned text");
  }
  const noIndent = /\b(?:no|without)\s+(?:first[\s-]line\s+)?indent(?:s|ation|ing)?\b/i.exec(text);
  const indent = /\bindent(?:ed)?\s+(?:the\s+)?first\s+lines?(?:\s+of\s+(?:each|every|all|the)\s+paragraphs?)?\b|\bfirst[\s-]line\s+indent(?:s|ation|ed)?\b|\bindent(?:ed)?\s+(?:each\s+|every\s+|all\s+|the\s+)?paragraphs?\b|\bparagraphs?\s+indented\b/i.exec(text);
  if (noIndent) {
    changes.indentFirstPt = 0;
    note(noIndent, "no first-line indent");
  } else if (indent) {
    const tail = text.slice((indent.index ?? 0) + indent[0].length, (indent.index ?? 0) + indent[0].length + 30);
    const measured = new RegExp(String.raw`^\s*(?:of\s+|by\s+)?${NUMBER}\s*(?:-\s*)?${UNIT}`, "i").exec(tail);
    const points = measured ? toPoints(amount(measured[1]), measured[2]) : 36;
    changes.indentFirstPt = points >= 6 && points <= 144 ? points : 36;
    note(indent, `${lengthLabel(changes.indentFirstPt)} first-line indent`);
  }

  // Paragraph spacing.
  const noGap = /\b(?:no|without|remove(?:\s+the)?)\s+(?:extra\s+)?(?:space|spacing|gaps?|blank\s+lines?)\s+(?:between|after)\s+paragraphs\b/i.exec(text);
  const gap = /\b(\d{1,2})\s*(?:pt|pts|points?)\s+(?:of\s+)?(?:space|spacing)\s+(?:after|between|below)\s+(?:each\s+)?paragraphs?\b/i.exec(text);
  const blankLine = /\b(?:a\s+)?blank\s+line\s+between\s+paragraphs\b/i.exec(text);
  if (noGap) {
    changes.paragraphAfterPt = 0;
    note(noGap, "no space between paragraphs");
  } else if (gap) {
    changes.paragraphAfterPt = Number.parseInt(gap[1], 10);
    note(gap, `${gap[1]} pt after paragraphs`);
  } else if (blankLine) {
    changes.paragraphAfterPt = 12;
    note(blankLine, "a blank line between paragraphs");
  }

  // Page numbers.
  // "Remove the page number from the heading" edits text, not the footer.
  const textEdit = /\b(?:remove|delete|drop|strip|take\s+out|fix|change|update|correct)\s+(?:the\s+|a\s+|any\s+)?page\s+numbers?\s+(?:from|in|out\s+of|of|on)\s+(?:the\s+|this\s+|that\s+)?(?!header|footer|pages?\b|document\b|draft\b)/i.test(text);
  const noNumbers = textEdit ? null : /\b(?:no|without|remove(?:\s+the)?|drop(?:\s+the)?|hide(?:\s+the)?)\s+page\s+numbers?\b/i.exec(text);
  const numbers = textEdit ? null : /\bpage\s+numbers?\b|\bpage\s+numbering\b|\bnumber\s+(?:the|each|every|all)\s+pages?\b|\bpage\s+x\s+of\s+y\b/i.exec(text);
  if (noNumbers) {
    changes.pageNumbers = "none";
    note(noNumbers, "no page numbers");
  } else if (numbers) {
    const around = nearby(text, numbers.index ?? 0, (numbers.index ?? 0) + numbers[0].length, 40, 60);
    const zone: "header" | "footer" = /\b(top|header|upper)\b/.test(around) && !/\b(bottom|footer|lower|foot)\b/.test(around) ? "header" : "footer";
    const align: "left" | "center" | "right" = /\bright\b/.test(around)
      ? "right"
      : /\bleft\b/.test(around)
        ? "left"
        : /\b(center|centre|centered|centred|middle)\b/.test(around)
          ? "center"
          : zone === "header"
            ? "right"
            : "center";
    const style: PageNumberRequest["style"] = /\bpage\s+(?:x|#|n|\d+)\s+of\s+(?:y|n|\d+)|\bof\s+(?:the\s+)?total\b|\bx\s+of\s+y\b/.test(around)
      ? "page-of"
      : /["“]page\s+(?:x|\d+)["”]|\bwith\s+the\s+word\s+page\b/.test(around)
        ? "page"
        : "number";
    changes.pageNumbers = { zone, align, style };
    note(numbers, `page numbers ${zone === "header" ? "top" : "bottom"} ${align}`);
    // "…at the bottom right of each page" belongs to the request for numbers.
    const placement = /^(?:\s*,)?(?:\s+(?:at|on|in)\s+(?:the\s+)?|\s+)(?:bottom|top|footer|header|foot|upper|lower)(?:[\s-]+(?:center|centre|centered|right|left|middle|corner|hand))*(?:\s+(?:corner|side))?(?:\s+of\s+(?:each|every|the|all)\s+pages?)?(?:\s+(?:as|like|in\s+the\s+form)\s+["“]?page\s+(?:x|#|n|\d+)(?:\s+of\s+(?:y|n|\d+))?["”]?)?/i.exec(
      text.slice((numbers.index ?? 0) + numbers[0].length),
    );
    if (placement) {
      const start = (numbers.index ?? 0) + numbers[0].length;
      spans.push([start, start + placement[0].length]);
    }
  }
  const skipFirst = /\b(?:except|but\s+not|not|no\s+page\s+number)\s+(?:on\s+)?the\s+first\s+page\b|\bstart(?:ing)?\s+(?:on|at|from|with)\s+(?:page\s+(?:2|two)|the\s+second\s+page)\b|\bomit(?:ted)?\s+(?:on|from)\s+the\s+first\s+page\b/i.exec(text);
  if (skipFirst) {
    changes.skipFirstPageNumber = true;
    note(skipFirst, "no page number on the first page");
  }

  // Header and footer text.
  const quoted = /\b(header|footer)\s*(?:that\s+)?(?:says|saying|reads|reading|with(?:\s+the\s+(?:text|words?))?|:|=)\s*["“'‘]([^"”'’]{1,80})["”'’]/gi;
  for (const match of text.matchAll(quoted)) {
    const lead = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
    if (/\b(?:section|column|table|row|chapter|article|clause)\s+$/i.test(lead)) continue;
    if (match[1].toLowerCase() === "header") changes.headerText = match[2].trim();
    else changes.footerText = match[2].trim();
    note(match, `${match[1].toLowerCase()} "${match[2].trim()}"`);
  }
  const placed = /["“]([^"”]{1,80})["”]\s+(?:in|at)\s+the\s+(header|footer|top|bottom)\b/gi;
  for (const match of text.matchAll(placed)) {
    const zone = /header|top/i.test(match[2]) ? "header" : "footer";
    if (zone === "header") changes.headerText = match[1].trim();
    else changes.footerText = match[1].trim();
    note(match, `${zone} "${match[1].trim()}"`);
  }
  const legend = /\b(?:mark|label|stamp)(?:ed)?\s+(?:it\s+|the\s+document\s+|each\s+page\s+|every\s+page\s+)?(?:as\s+)?["“]?((?:privileged\s*(?:&|and)\s*)?confidential|draft|attorney[\s-]client\s+privileged(?:\s*(?:&|and)\s*confidential)?)["”]?(?:\s+(?:in|at|on)\s+the\s+(header|footer|top|bottom))?/i.exec(
    text,
  );
  const legendLead = legend ? text.slice(Math.max(0, (legend.index ?? 0) - 24), legend.index ?? 0) : "";
  const describesContent = /\b(?:information|materials?|documents?|data|records?|that|which|is|are|be|been|was|were|when|if|as|not)\s+$/i.test(legendLead);
  if (legend && !describesContent && !changes.headerText && !changes.footerText) {
    const legendText = legend[1].replace(/\s+/g, " ").toUpperCase();
    if (legend[2] && /footer|bottom/i.test(legend[2])) changes.footerText = legendText;
    else changes.headerText = legendText;
    note(legend, `"${legendText}" legend`);
  }

  // Headings: the attributes said about them in one clause ("make the
  // headings bold, centered, and in all caps"; "bold centered headings").
  for (const match of text.matchAll(/\b(?:section\s+|article\s+)?headings?\b/gi)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const beforeText = text.slice(Math.max(0, start - 32), start);
    const before = /(?:[\w-]+(?:,\s*|\s+and\s+|\s+)){0,4}$/.exec(beforeText)?.[0] ?? "";
    const afterText = text.slice(end, end + 70);
    const after = /^[^.;]*/.exec(afterText)?.[0].split(/\b(?:and\s+(?:the\s+)?(?:body|text|paragraphs?|title|margins?|page)|but)\b/i)[0] ?? "";
    const clause = `${before} ${after}`.toLowerCase();
    const found: string[] = [];
    if (/\b(?:center(?:ed)?|centre(?:d)?|in\s+the\s+center)\b/.test(clause)) {
      changes.headingAlign = "center";
      found.push("centered headings");
    } else if (/\bleft[\s-]align(?:ed)?\b|\bflush\s+left\b|\bon\s+the\s+left\b/.test(clause)) {
      changes.headingAlign = "left";
      found.push("left-aligned headings");
    }
    if (/\b(?:all[\s-]caps|all\s+capitals|uppercase|capital\s+letters|capitali[sz]ed|caps)\b/.test(clause)) {
      changes.headingCaps = true;
      found.push("capitalized headings");
    }
    if (/\bbold(?:ed)?\b/.test(clause)) {
      changes.headingBold = true;
      found.push("bold headings");
    }
    if (/\bunderlin(?:e|ed)\b/.test(clause)) {
      changes.headingUnderline = true;
      found.push("underlined headings");
    }
    if (found.length) {
      spans.push([start - before.length, end + after.length]);
      found.forEach((label) => {
        if (!applied.includes(label)) applied.push(label);
      });
    }
  }
  const title = /\b(?:center|centre)(?:ed)?\s+(?:the\s+)?title\b|\btitle\s+(?:should\s+be\s+)?(?:center(?:ed)?|centred)\b/i.exec(text);
  if (title) {
    changes.titleAlign = "center";
    note(title, "centered title");
  }

  if (!spans.length) return null;
  return { changes, applied, spans };
}

const LAYOUT_FILLER = new Set(
  `a add an and also all apply around as at be both by can change could create doc document draft each entire every everything everywhere for format formatted formatting from give have i in include insert instead into is it its just keep layout let lets like look looks make me my need now of on only our page pages paper please put rather reformat set should side sides so style styled switch text than that the them then these this those throughout to too turn update use using want whole with would you your font fonts typeface size sizes margin margins spacing spaced line lines paragraphs paragraph`.split(
    " ",
  ),
);

/** True when the request asks for layout and nothing else ("make it Times New
 * Roman 12 and double spaced"), so it can be applied without a model call. */
export function isLayoutOnlyRequest(request: string, layout: LayoutRequest) {
  const text = request.replace(/\s+/g, " ");
  let residual = "";
  let cursor = 0;
  [...layout.spans]
    .sort((a, b) => a[0] - b[0])
    .forEach(([start, end]) => {
      if (start > cursor) residual += ` ${text.slice(cursor, start)}`;
      cursor = Math.max(cursor, end);
    });
  residual += ` ${text.slice(cursor)}`;
  const words = residual
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter((word) => word && !/^\d+(\.\d+)?$/.test(word) && !LAYOUT_FILLER.has(word));
  return words.length === 0;
}

/** The request with its layout wording removed, for deriving a title or
 * subject: "an NDA in Garamond 12 on legal-size paper" reads "an NDA". */
export function stripLayoutPhrases(request: string) {
  const layout = parseLayoutRequest(request);
  if (!layout) return request;
  const text = request.replace(/\s+/g, " ");
  let result = "";
  let cursor = 0;
  [...layout.spans]
    .sort((a, b) => a[0] - b[0])
    .forEach(([start, end]) => {
      if (start > cursor) result += text.slice(cursor, start);
      result += " ";
      cursor = Math.max(cursor, end);
    });
  result += text.slice(cursor);
  // Connectors left dangling by a removed phrase ("… in", "with a and.").
  let previous = "";
  while (previous !== result) {
    previous = result;
    result = result.replace(/\b(?:in|with|on|using|and|as|at|a|an|the)\b(?=\s*(?:[,.;]|$))/gi, " ");
  }
  return result
    .replace(/\s+([,.;])/g, "$1")
    .replace(/,\s*(?:,|\.|$)/g, (match) => (match.includes(".") ? "." : ""))
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------ applying changes ------------------------------ */

function parseStyle(style: string | undefined) {
  const map = new Map<string, string>();
  (style ?? "").split(";").forEach((part) => {
    const index = part.indexOf(":");
    if (index < 1) return;
    map.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
  });
  return map;
}

function serialize(map: Map<string, string>) {
  return Array.from(map.entries())
    .map(([name, value]) => `${name}: ${value}`)
    .join("; ");
}

function editSample(setup: DocumentPageSetup, tag: "p" | "h1" | "h2" | "h3" | "h4", edits: Record<string, string | null>) {
  const styles = { ...(setup.blockStyles ?? {}) };
  const map = parseStyle(styles[tag]);
  Object.entries(edits).forEach(([name, value]) => {
    if (value === null) map.delete(name);
    else map.set(name, value);
  });
  styles[tag] = serialize(map);
  setup.blockStyles = styles;
}

const HEADING_TAGS = ["h2", "h3", "h4"] as const;

function zoneHasNumber(html: string) {
  return html.includes(DOCUMENT_FIELD_PAGE_CLASS);
}

/** A running zone's parts: its text lines without page numbers. */
function zoneTextOnly(html: string) {
  if (!html || typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  Array.from(template.content.children).forEach((child) => {
    if (child.querySelector(`.${DOCUMENT_FIELD_PAGE_CLASS}`)) child.remove();
  });
  return template.innerHTML;
}

function zoneText(html: string) {
  if (!html || typeof document === "undefined") return "";
  const template = document.createElement("template");
  template.innerHTML = zoneTextOnly(html);
  return (template.content.textContent ?? "").replace(/\s+/g, " ").trim();
}

function numberText(style: PageNumberRequest["style"]) {
  return style === "page-of" ? "Page {page} of {pages}" : style === "page" ? "Page {page}" : "{page}";
}

/** Applies plain-English changes to a page setup. The setup is copied. */
export function applyLayoutChanges(base: DocumentPageSetup, changes: LayoutChanges): DocumentPageSetup {
  const setup: DocumentPageSetup = {
    ...base,
    blockStyles: { ...(base.blockStyles ?? {}) },
    features: [...(base.features ?? [])],
  };
  const runningSizePt = Math.min(10, Math.max(8, roundTo(setup.fontSizePx / pxFromPt(1), 1) - 2));

  if (changes.paper) {
    setup.widthPt = changes.paper.widthPt;
    setup.heightPt = changes.paper.heightPt;
  }
  if (changes.orientation) {
    const long = Math.max(setup.widthPt, setup.heightPt);
    const short = Math.min(setup.widthPt, setup.heightPt);
    setup.widthPt = changes.orientation === "landscape" ? long : short;
    setup.heightPt = changes.orientation === "landscape" ? short : long;
  }
  if (changes.margins) {
    if (changes.margins.top !== undefined) setup.marginTopPt = changes.margins.top;
    if (changes.margins.right !== undefined) setup.marginRightPt = changes.margins.right;
    if (changes.margins.bottom !== undefined) setup.marginBottomPt = changes.margins.bottom;
    if (changes.margins.left !== undefined) setup.marginLeftPt = changes.margins.left;
    setup.headerDistancePt = Math.min(setup.headerDistancePt, Math.max(18, setup.marginTopPt / 2));
    setup.footerDistancePt = Math.min(setup.footerDistancePt, Math.max(18, setup.marginBottomPt / 2));
  }

  if (changes.fontName) {
    const multiple = setup.lineHeight / fontLineFactor(setup.fontFamily);
    setup.fontFamily = cssFontFamilyStack(changes.fontName);
    setup.lineHeight = roundTo(fontLineFactor(changes.fontName) * multiple, 3);
    // Headings follow the body face unless they were given their own.
    (["h1", ...HEADING_TAGS] as const).forEach((tag) => {
      if (!changes.headingFontName && parseStyle(setup.blockStyles?.[tag]).has("font-family")) {
        editSample(setup, tag, { "font-family": null });
      }
    });
  }
  if (changes.headingFontName) {
    (["h1", ...HEADING_TAGS] as const).forEach((tag) =>
      editSample(setup, tag, { "font-family": cssFontFamilyStack(changes.headingFontName as string) }),
    );
  }
  if (changes.fontSizePt) setup.fontSizePx = roundTo(pxFromPt(changes.fontSizePt), 2);
  if (changes.headingSizePt) {
    HEADING_TAGS.forEach((tag) => editSample(setup, tag, { "font-size": cssLength(changes.headingSizePt as number) }));
    const titleSize = Number.parseFloat(parseStyle(setup.blockStyles?.h1).get("font-size") ?? "");
    if (!(titleSize >= pxFromPt(changes.headingSizePt))) {
      editSample(setup, "h1", { "font-size": cssLength(changes.headingSizePt) });
    }
  }
  if (changes.lineSpacing) {
    setup.lineHeight = roundTo(fontLineFactor(setup.fontFamily) * changes.lineSpacing, 3);
    // A double-spaced document marks paragraphs by indent, not extra space,
    // unless the request set either explicitly.
    if (changes.lineSpacing >= 2 && changes.paragraphAfterPt === undefined && changes.indentFirstPt === undefined) {
      setup.paragraphAfterPx = 0;
      editSample(setup, "p", { "text-indent": cssLength(36) });
    }
  }
  if (changes.bodyAlign) editSample(setup, "p", { "text-align": changes.bodyAlign });
  if (changes.indentFirstPt !== undefined) editSample(setup, "p", { "text-indent": cssLength(changes.indentFirstPt) });
  if (changes.paragraphAfterPt !== undefined) setup.paragraphAfterPx = roundTo(pxFromPt(changes.paragraphAfterPt), 2);

  if (changes.headingAlign) HEADING_TAGS.forEach((tag) => editSample(setup, tag, { "text-align": changes.headingAlign as string }));
  if (changes.titleAlign || changes.headingAlign) editSample(setup, "h1", { "text-align": (changes.titleAlign ?? changes.headingAlign) as string });
  if (changes.headingCaps) (["h1", ...HEADING_TAGS] as const).forEach((tag) => editSample(setup, tag, { "text-transform": "uppercase" }));
  if (changes.headingBold) (["h1", ...HEADING_TAGS] as const).forEach((tag) => editSample(setup, tag, { "font-weight": "bold" }));
  if (changes.headingUnderline) HEADING_TAGS.forEach((tag) => editSample(setup, tag, { "text-decoration": "underline" }));

  // Running header and footer.
  if (changes.pageNumbers === "none") {
    setup.headerHtml = zoneTextOnly(setup.headerHtml);
    setup.footerHtml = zoneTextOnly(setup.footerHtml);
    if (setup.firstHeaderHtml !== null) setup.firstHeaderHtml = zoneTextOnly(setup.firstHeaderHtml);
    if (setup.firstFooterHtml !== null) setup.firstFooterHtml = zoneTextOnly(setup.firstFooterHtml);
  }
  const numbers = changes.pageNumbers && changes.pageNumbers !== "none" ? changes.pageNumbers : null;
  const rebuildZone = (zone: "header" | "footer") => {
    const requestedText = zone === "header" ? changes.headerText : changes.footerText;
    const wantsNumber = numbers?.zone === zone;
    if (requestedText === undefined && !wantsNumber) {
      // A page number moved to the other zone leaves this one.
      if (numbers && zoneHasNumber(zone === "header" ? setup.headerHtml : setup.footerHtml)) {
        return zoneTextOnly(zone === "header" ? setup.headerHtml : setup.footerHtml);
      }
      return null;
    }
    const current = zone === "header" ? setup.headerHtml : setup.footerHtml;
    const text = requestedText ?? zoneText(current);
    const keepNumber = !numbers && changes.pageNumbers !== "none" && zoneHasNumber(current);
    if (keepNumber && requestedText !== undefined) {
      // New legend text beside the existing number.
      return runningTextHtml({ left: requestedText, right: "Page {page} of {pages}" }, { sizePt: runningSizePt });
    }
    const parts: RunningText = {};
    if (wantsNumber && numbers) {
      const numberLabel = numberText(numbers.style);
      if (text) {
        parts.left = numbers.align === "left" ? numberLabel : text;
        if (numbers.align === "left") parts.right = text;
        else if (numbers.align === "center") parts.center = numberLabel;
        else parts.right = numberLabel;
      } else {
        parts[numbers.align] = numberLabel;
      }
    } else if (text) {
      parts.center = text;
    }
    return runningTextHtml(parts, { sizePt: runningSizePt });
  };
  const header = rebuildZone("header");
  const footer = rebuildZone("footer");
  if (header !== null) setup.headerHtml = header;
  if (footer !== null) setup.footerHtml = footer;
  if (changes.skipFirstPageNumber) {
    setup.firstHeaderHtml = zoneTextOnly(setup.headerHtml);
    setup.firstFooterHtml = zoneTextOnly(setup.footerHtml);
  } else if (header !== null || footer !== null) {
    // A rebuilt zone shows on the first page too unless asked otherwise.
    if (header !== null && setup.firstHeaderHtml !== null && !base.firstHeaderHtml) setup.firstHeaderHtml = null;
    if (footer !== null && setup.firstFooterHtml !== null && !base.firstFooterHtml) setup.firstFooterHtml = null;
  }
  return setup;
}

/** The typeface a setup's Normal text uses, for status lines. */
export function setupFontName(setup: DocumentPageSetup) {
  return primaryFontFamily(setup.fontFamily);
}
