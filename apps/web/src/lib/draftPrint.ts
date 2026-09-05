/**
 * Print / Save as PDF support for the Drafts workspace.
 *
 * The approved PDF path is browser printing: Aperture never fabricates a
 * server-generated PDF or claims a PDF file was created. This module builds a
 * detached, print-only render of the exact saved draft version, invokes
 * `window.print()`, and cleans up afterwards. The editor DOM is never touched:
 * the print surface is a sibling of the app root, hidden on screen, and the
 * print stylesheet (see the draft print block at the end of styles.css) hides
 * every app surface except this root while printing.
 *
 * Cleanup runs on `afterprint` (which also fires on dialog cancel), or after a
 * bounded fallback timeout, whichever comes first. Repeated print actions
 * always remove any prior print root before building a new one, so no
 * duplicate print surfaces accumulate.
 */

import { sanitizeDocumentHtml } from "./draftRedline";

export const DRAFT_PRINT_ROOT_ID = "aperture-draft-print-root";
export const DRAFT_PRINT_BODY_CLASS = "is-draft-printing";
/** Bounded fallback in case a browser never fires afterprint. */
export const DRAFT_PRINT_CLEANUP_TIMEOUT_MS = 60_000;
/** Bounded wait for embedded images before the dialog opens. Images that
 * report a real load error fail the print honestly; images that are merely
 * still loading when the wait ends do not block the dialog. */
export const DRAFT_PRINT_IMAGE_WAIT_MS = 4_000;

export type DraftPrintOutcome = { ok: true } | { ok: false; error: string };

/** Removes any existing print surface and print body state. Idempotent. */
export function removeDraftPrintSurface(doc: Document = document) {
  doc.getElementById(DRAFT_PRINT_ROOT_ID)?.remove();
  doc.body.classList.remove(DRAFT_PRINT_BODY_CLASS);
}

function firstHeadingText(container: Element): string {
  const heading = container.querySelector("h1, h2");
  return heading?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/** Waits (bounded) for pending images inside the print root. Resolves with
 * the sources of images that reported an explicit load error. */
function waitForPrintImages(root: HTMLElement, waitMs: number): Promise<string[]> {
  const failed: string[] = [];
  const images = Array.from(root.querySelectorAll("img"));
  images.forEach((image) => {
    // Already-settled broken images (complete but empty) fail immediately.
    if (image.complete && image.naturalWidth === 0 && image.getAttribute("src")) {
      failed.push(image.getAttribute("src") ?? "");
    }
  });
  const pending = images.filter((image) => !image.complete);
  if (!pending.length) return Promise.resolve(failed);
  return new Promise((resolve) => {
    let remaining = pending.length;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(failed);
    };
    const timer = window.setTimeout(finish, waitMs);
    const settleOne = () => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearTimeout(timer);
        finish();
      }
    };
    pending.forEach((image) => {
      image.addEventListener("load", settleOne, { once: true });
      image.addEventListener(
        "error",
        () => {
          failed.push(image.getAttribute("src") ?? "");
          settleOne();
        },
        { once: true },
      );
    });
  });
}

/**
 * Builds the print-only surface for the exact saved draft version and opens
 * the browser print dialog. The user chooses "Save as PDF" in that dialog;
 * this function never claims a PDF file was produced.
 *
 * On any preparation or embedded-asset failure the surface is removed, the
 * editor is left untouched, and an explicit error is returned.
 */
export async function printSavedDraftVersion(options: {
  title: string;
  contentHtml: string;
  cleanupTimeoutMs?: number;
  imageWaitMs?: number;
}): Promise<DraftPrintOutcome> {
  const {
    title,
    contentHtml,
    cleanupTimeoutMs = DRAFT_PRINT_CLEANUP_TIMEOUT_MS,
    imageWaitMs = DRAFT_PRINT_IMAGE_WAIT_MS,
  } = options;

  if (typeof document === "undefined" || typeof window === "undefined") {
    return { ok: false, error: "Printing is only available in the browser." };
  }
  const doc = document;
  const win = window;
  if (typeof win.print !== "function") {
    return { ok: false, error: "This browser does not expose a print dialog." };
  }

  try {
    // Repeated print actions must not stack print roots.
    removeDraftPrintSurface(doc);

    const sanitized = sanitizeDocumentHtml(contentHtml);
    const pages = doc.createElement("div");
    pages.className = "draft-print-pages";
    pages.innerHTML = sanitized;
    // The on-screen "Page N" pills are app chrome, not document content.
    pages.querySelectorAll(".document-page-label").forEach((node) => node.remove());

    const hasText = Boolean(pages.textContent?.trim());
    const hasVisual = Boolean(pages.querySelector("img"));
    if (!hasText && !hasVisual) {
      return { ok: false, error: "This saved version has no printable content yet." };
    }

    const root = doc.createElement("div");
    root.id = DRAFT_PRINT_ROOT_ID;
    root.className = "draft-print-root";
    // Hidden from assistive tech and from screen rendering; it exists only
    // for the print stylesheet.
    root.setAttribute("aria-hidden", "true");

    const normalizedTitle = title.replace(/\s+/g, " ").trim();
    // Avoid printing the title twice when the document already opens with it.
    if (
      !pages.querySelector(".document-mla-text") &&
      normalizedTitle &&
      firstHeadingText(pages).toLowerCase() !== normalizedTitle.toLowerCase()
    ) {
      const titleElement = doc.createElement("h1");
      titleElement.className = "draft-print-doc-title";
      titleElement.textContent = normalizedTitle;
      root.appendChild(titleElement);
    }
    root.appendChild(pages);

    const previousFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;

    doc.body.appendChild(root);
    doc.body.classList.add(DRAFT_PRINT_BODY_CLASS);

    const failedImages = await waitForPrintImages(root, imageWaitMs);
    if (failedImages.length) {
      removeDraftPrintSurface(doc);
      return {
        ok: false,
        error:
          "Could not prepare the print view: an embedded image failed to load. The draft is unchanged.",
      };
    }

    let cleaned = false;
    let fallbackTimer: number | undefined;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      win.removeEventListener("afterprint", cleanup);
      if (fallbackTimer !== undefined) win.clearTimeout(fallbackTimer);
      removeDraftPrintSurface(doc);
      if (previousFocus && doc.contains(previousFocus)) {
        try {
          previousFocus.focus();
        } catch {
          // Focus restoration is best-effort; never fail cleanup over it.
        }
      }
    };

    win.addEventListener("afterprint", cleanup);
    try {
      win.print();
    } catch {
      cleanup();
      return {
        ok: false,
        error: "Could not open the browser print dialog. The draft is unchanged.",
      };
    }
    // Most browsers fire afterprint when the dialog closes (including cancel);
    // the timer is a bounded fallback so temporary print state never lingers.
    fallbackTimer = win.setTimeout(cleanup, cleanupTimeoutMs);
    return { ok: true };
  } catch {
    removeDraftPrintSurface(doc);
    return { ok: false, error: "Could not prepare the print view. The draft is unchanged." };
  }
}
