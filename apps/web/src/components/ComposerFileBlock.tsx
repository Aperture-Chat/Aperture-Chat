import { X } from "lucide-react";
import { fileIconClass } from "../lib/fileKinds";

/** A file or knowledge base in a composer: one key that opens it, one that takes
 * it back. Chat and Drafts share it so a block looks and behaves the same. */
export function ComposerFileBlock({
  name,
  kind,
  detail,
  status,
  canOpen = true,
  openHint,
  removeHint,
  onOpen,
  onRemove,
}: {
  name: string;
  kind: string;
  detail: string;
  status?: "ready" | "uploading" | "error";
  canOpen?: boolean;
  openHint: string;
  removeHint: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <span className={`attach-chip ${status ? `is-${status}` : ""}`}>
      <button
        type="button"
        className="attach-chip-open"
        aria-label={`Open ${name}`}
        data-tooltip={openHint}
        disabled={!canOpen}
        onClick={(event) => {
          // Safari leaves focus behind on click, and closing returns it here.
          event.currentTarget.focus();
          onOpen();
        }}
      >
        <span className={`file-icon ${fileIconClass(kind)}`}>{kind[0]?.toUpperCase() ?? "F"}</span>
        <span className="attach-chip-text">
          <strong>{name}</strong>
          <small>{detail}</small>
        </span>
      </button>
      <button
        type="button"
        className="attach-chip-remove"
        aria-label={`Remove ${name}`}
        data-tooltip={removeHint}
        onClick={onRemove}
      >
        <X size={14} />
      </button>
    </span>
  );
}
