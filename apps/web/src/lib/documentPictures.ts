/** Picture spots in a drafted paper.
 *
 * When a request asks for pictures, the writer marks each place one belongs
 * with a paragraph of its own: `[[Picture: who or what, where, when]]` (the
 * server's draft directive asks for exactly this; services/api
 * app/core/directives.py PICTURE_SPOT_PATTERN). The editor then fills each
 * spot with a freely licensed photo or a labelled AI illustration, stored
 * inside the document so it survives saving and export.
 */

import { escapeHtml } from "./sheet/html";

export type PicturePlacement =
  | { kind: "photo"; src: string; alt: string; credit: string; sourceUrl: string }
  | { kind: "illustration"; src: string }
  | null;

export type PictureFillReport = { photos: number; illustrations: number; missing: number };

const SPOT_PARAGRAPH = /<p\b[^>]*>\s*\[\[Picture:\s*([^\]<]{3,}?)\s*\]\]\s*<\/p>/gi;
// A marker anywhere else (inside a list item or a sentence) cannot hold a figure.
const STRAY_MARKER = /\[\[Picture:[^\]<]*\]\]/gi;
const MARKER_LINE = /^[ \t]*(\[\[Picture:[^\]\n]+\]\])[ \t]*$/gim;
const PICTURE_SOURCE = /<figure\b[^>]*\bdocument-picture\b[^>]*>[\s\S]*?<a\b[^>]*\bhref="([^"]+)"/gi;

/** Puts every marker written on a line of its own into a paragraph of its
 * own, so a marker with no blank line around it still becomes a spot. */
export function isolatePictureSpots(markdown: string): string {
  return markdown.replace(MARKER_LINE, "\n\n$1\n\n");
}

/** True when the HTML still holds any marker, filled or not. */
export function hasPictureMarkers(html: string): boolean {
  return new RegExp(STRAY_MARKER.source, "i").test(html);
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The description of every spot, in document order. */
export function pictureSpots(html: string): string[] {
  return [...html.matchAll(SPOT_PARAGRAPH)].map((match) => unescapeHtml(match[1]).trim());
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The Commons pages of the photos a document already holds. */
export function pictureSourceUrls(html: string): string[] {
  return [...html.matchAll(PICTURE_SOURCE)].map((match) => unescapeHtml(match[1]));
}

/** The captioned figure for one placed picture: a photo is captioned with
 * what Commons says it shows, since a search can match only the subject. */
export function pictureFigureHtml(description: string, placement: Exclude<PicturePlacement, null>): string {
  if (placement.kind === "illustration") {
    const label = `AI-generated illustration: ${description}`;
    return (
      `<figure class="document-media-block document-picture" contenteditable="false">` +
      `<img src="${escapeHtml(placement.src)}" alt="${escapeHtml(label)}">` +
      `<figcaption>${escapeHtml(sentence(label))}</figcaption></figure>`
    );
  }
  return (
    `<figure class="document-media-block document-picture" contenteditable="false">` +
    `<img src="${escapeHtml(placement.src)}" alt="${escapeHtml(placement.alt)}">` +
    `<figcaption>${escapeHtml(sentence(placement.alt))} Image: ${escapeHtml(sentence(placement.credit))} ` +
    `<a href="${escapeHtml(placement.sourceUrl)}" target="_blank" rel="noopener noreferrer">Source</a></figcaption></figure>`
  );
}

/** Fills every spot, one at a time (image generation is rate limited), and
 * removes the spots that end up with nothing to show. */
export async function fillPictureSpots(
  html: string,
  place: (description: string) => Promise<PicturePlacement>,
): Promise<{ html: string; report: PictureFillReport }> {
  const report: PictureFillReport = { photos: 0, illustrations: 0, missing: 0 };
  let filled = "";
  let copied = 0;
  for (const match of html.matchAll(SPOT_PARAGRAPH)) {
    const description = unescapeHtml(match[1]).trim();
    let placement: PicturePlacement = null;
    try {
      placement = await place(description);
    } catch {
      placement = null;
    }
    if (placement === null) report.missing += 1;
    else if (placement.kind === "photo") report.photos += 1;
    else report.illustrations += 1;
    filled += html.slice(copied, match.index) + (placement ? pictureFigureHtml(description, placement) : "");
    copied = match.index + match[0].length;
  }
  const rest = (filled + html.slice(copied)).replace(STRAY_MARKER, () => {
    report.missing += 1;
    return "";
  });
  return { html: rest, report };
}

function count(amount: number, singular: string, plural = `${singular}s`): string {
  return `${amount} ${amount === 1 ? singular : plural}`;
}

export function pictureReportMessage(report: PictureFillReport): string {
  const placed = [
    report.photos ? count(report.photos, "freely licensed photo") : "",
    report.illustrations ? count(report.illustrations, "AI-generated illustration") : "",
  ].filter(Boolean);
  if (!placed.length) return `No pictures could be added: ${count(report.missing, "picture")} had no match.`;
  const missing = report.missing
    ? ` ${count(report.missing, "picture")} had no match and ${report.missing === 1 ? "was" : "were"} left out.`
    : "";
  return `Added ${placed.join(" and ")}.${missing}`;
}
