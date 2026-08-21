import { Bug, Image, Paperclip, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import type { IssueReportRecord } from "../lib/types";

export function IssueReportPreview({
  item,
  sentLabel,
  loadScreenshot,
  onClose,
}: {
  item: IssueReportRecord;
  sentLabel: string;
  loadScreenshot?: (reportId: string) => Promise<Blob>;
  onClose: () => void;
}) {
  const titleId = useId();
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotFailed, setScreenshotFailed] = useState(false);

  useEffect(() => {
    if (!item.screenshot_filename || !loadScreenshot) return;
    let active = true;
    let objectUrl: string | null = null;
    void loadScreenshot(item.id)
      .then((blob) => {
        if (!active) return;
        if (typeof URL.createObjectURL !== "function") {
          setScreenshotFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setScreenshotUrl(objectUrl);
      })
      .catch(() => {
        if (active) setScreenshotFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(objectUrl);
    };
  }, [item.id, item.screenshot_filename, loadScreenshot]);

  return createPortal(
    <div className="modal-backdrop prompt-output-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal issue-report-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon"><Bug size={20} /></span>
          <div>
            <h2 id={titleId}>Platform issue report</h2>
            <p>{item.subject}</p>
          </div>
          <button
            autoFocus
            className="icon-button"
            type="button"
            aria-label="Close issue report preview"
            data-tooltip="Close preview"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="prompt-output-meta" aria-label="Issue report metadata">
          <span><strong>User</strong>{item.user_name}</span>
          <span><strong>Sent</strong>{sentLabel}</span>
          <span>
            <strong>Screenshot</strong>
            {item.screenshot_filename ?? "None"}
          </span>
        </div>

        <article className="issue-report-message">
          <h3>{item.subject}</h3>
          <p>{item.body}</p>
        </article>

        {item.screenshot_filename && (
          <section className="issue-report-screenshot" aria-label="Attached screenshot">
            <header><Paperclip size={15} /> {item.screenshot_filename}</header>
            {screenshotUrl ? (
              <img src={screenshotUrl} alt={`Screenshot attached to ${item.subject}`} />
            ) : screenshotFailed ? (
              <p>The screenshot preview could not be loaded.</p>
            ) : (
              <p><Image size={16} /> Loading screenshot…</p>
            )}
          </section>
        )}
      </section>
    </div>,
    document.body,
  );
}
