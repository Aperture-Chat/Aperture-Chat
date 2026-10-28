import { CheckCircle2, CloudOff, LoaderCircle, PencilLine, TriangleAlert } from "lucide-react";
import type { DraftSaveStatus as DraftSaveStatusModel, DraftSaveTone } from "../lib/draftSaveStatus";

const TONE_ICONS: Record<DraftSaveTone, typeof CheckCircle2> = {
  editing: PencilLine,
  saving: LoaderCircle,
  saved: CheckCircle2,
  "local-only": CloudOff,
  "not-stored": CloudOff,
  conflict: TriangleAlert,
};

type DraftSaveStatusProps = {
  status: DraftSaveStatusModel;
  onRetry: () => void;
  onReload: (serverId: string) => void;
  /** Documents: the status word also shows and hides the AI edit highlights. */
  highlights?: { on: boolean; onToggle: () => void };
};

/** The one save status of the Drafts editor, at the end of the formatting
 * toolbar. Its reason lives in the tooltip, except when this tab holds the
 * only copy: that warning is spelled out in full. */
export function DraftSaveStatus({ status, onRetry, onReload, highlights }: DraftSaveStatusProps) {
  const Icon = TONE_ICONS[status.tone];
  const word = (
    <>
      <Icon size={17} aria-hidden="true" />
      <span className="document-save-label">{status.label}</span>
    </>
  );
  const action = status.action;
  return (
    <span className={`document-save-state is-${status.tone}`} role="status" aria-label="Save status">
      {highlights ? (
        <button
          className="document-edits-toggle"
          type="button"
          aria-pressed={highlights.on}
          data-tooltip={`${status.detail} Click to show or hide the AI edit highlights.`}
          onClick={highlights.onToggle}
        >
          {word}
        </button>
      ) : (
        <span className="document-save-word" data-tooltip={status.detail}>
          {word}
        </span>
      )}
      {status.tone === "not-stored" && <span className="document-save-message">{status.detail}</span>}
      {action && (
        <button
          className="document-save-action"
          type="button"
          onClick={() => (action.kind === "reload" ? onReload(action.serverId) : onRetry())}
        >
          {action.kind === "reload" ? "Reload server copy" : "Retry"}
        </button>
      )}
    </span>
  );
}
