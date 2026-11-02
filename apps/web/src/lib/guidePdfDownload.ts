import { triggerBlobDownload } from "./clipboard";

const PDF_HEADER = "%PDF-";
const PDF_TRAILER = "%%EOF";
const TRAILER_SEARCH_BYTES = 1024;

function asciiOf(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function isCompletePdf(bytes: Uint8Array) {
  return (
    asciiOf(bytes.subarray(0, PDF_HEADER.length)) === PDF_HEADER &&
    asciiOf(bytes.subarray(-TRAILER_SEARCH_BYTES)).includes(PDF_TRAILER)
  );
}

/* A plain `<a download>` lets Electron-based hosts write straight onto the
 * final filename with no progress shown, so a guide opened early looks damaged.
 * Saving only after the whole file has arrived and been checked closes that
 * window in every host, and stops the app page (the server's fallback for a
 * missing file) from being saved as a .pdf. */
export async function saveCompleteGuidePdf(href: string) {
  const response = await fetch(href);
  if (!response.ok) throw new Error(`Guide request failed with status ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!isCompletePdf(bytes)) throw new Error("Guide response was not a complete PDF");
  triggerBlobDownload(new Blob([bytes], { type: "application/pdf" }), href.slice(href.lastIndexOf("/") + 1));
}
