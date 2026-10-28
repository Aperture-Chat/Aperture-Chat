import { useCallback, useState } from "react";
import { copyCodeToClipboard } from "./clipboard";

export type CopyStatus = "idle" | "copied" | "failed";

/** Copy to the clipboard with a short-lived Copied / Failed label. */
export function useCopyFeedback() {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const copy = useCallback(async (text: string) => {
    let next: CopyStatus = "copied";
    try {
      await copyCodeToClipboard(text);
    } catch {
      next = "failed";
    }
    setStatus(next);
    window.setTimeout(() => setStatus((current) => (current === next ? "idle" : current)), next === "copied" ? 1600 : 2200);
  }, []);
  const reset = useCallback(() => setStatus("idle"), []);
  return { status, copy, reset };
}
