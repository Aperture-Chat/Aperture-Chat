/**
 * Picture size and alignment in documents, stored as classes on the figure so
 * they survive both sanitizers, print, and version history. The Word export
 * reads the same classes (docxExport), so a picture set to "Half width, right"
 * lands in Word at half the column width, right aligned.
 */

export type MediaSize = "sm" | "md" | "lg" | "full";
export type MediaAlign = "left" | "center" | "right";

export const MEDIA_SIZE_RATIOS: Record<Exclude<MediaSize, "full">, number> = {
  sm: 0.33,
  md: 0.5,
  lg: 0.75,
};

export const MEDIA_SIZE_LABELS: Record<MediaSize, string> = {
  sm: "Small",
  md: "Half",
  lg: "Large",
  full: "Full width",
};

const SIZE_CLASS = "document-media-size-";
const ALIGN_CLASS = "document-media-align-";

export function mediaSize(figure: Element): MediaSize {
  const found = (Object.keys(MEDIA_SIZE_RATIOS) as Array<keyof typeof MEDIA_SIZE_RATIOS>).find((size) =>
    figure.classList.contains(`${SIZE_CLASS}${size}`),
  );
  return found ?? "full";
}

/** Width ratio of the text column, or null for the default (full) size. */
export function mediaSizeRatio(figure: Element): number | null {
  const size = mediaSize(figure);
  return size === "full" ? null : MEDIA_SIZE_RATIOS[size];
}

export function mediaAlign(figure: Element): MediaAlign {
  if (figure.classList.contains(`${ALIGN_CLASS}left`)) return "left";
  if (figure.classList.contains(`${ALIGN_CLASS}right`)) return "right";
  return "center";
}

export function setMediaSize(figure: Element, size: MediaSize) {
  (Object.keys(MEDIA_SIZE_RATIOS) as string[]).forEach((name) => figure.classList.remove(`${SIZE_CLASS}${name}`));
  if (size !== "full") figure.classList.add(`${SIZE_CLASS}${size}`);
}

export function setMediaAlign(figure: Element, align: MediaAlign) {
  figure.classList.remove(`${ALIGN_CLASS}left`, `${ALIGN_CLASS}right`);
  if (align !== "center") figure.classList.add(`${ALIGN_CLASS}${align}`);
}
