import clsx from "clsx";
import { Check, ChevronDown, ImagePlus, ListChecks, Monitor, Send, ShieldAlert, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";

import { collectDiagnostics } from "../lib/diagnostics";
import { RailSwitch } from "./RailSwitch";
import { TicketKindIcon } from "./TicketKindIcon";
import { IMPACT_OPTIONS, KIND_LABELS, KIND_ORDER } from "../lib/supportLabels";
import type { IssueReportKind, IssueReportRecord, IssueReportSubmission } from "../lib/types";

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
// Five stops share the drawer's width, so the rail uses one-word labels.
const SHORT_KIND_LABELS: Record<IssueReportKind, string> = {
  bug: "Problem",
  feature: "Idea",
  question: "Question",
  feedback: "Feedback",
  security: "Security",
};
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const DRAFT_KEY = "aperture.issue-report-draft";

const COPY: Record<IssueReportKind, { subject: string; body: string; intro: string }> = {
  bug: {
    intro: "Describe what happened, what you expected, and any steps that help reproduce it.",
    subject: "Short summary of the problem",
    body: "What happened? What were you trying to do? Steps that reproduce it help most.",
  },
  feature: {
    intro: "Tell us what you'd like to do and the problem it would solve.",
    subject: "What would you like to be able to do?",
    body: "Describe the idea and how it would help your work.",
  },
  question: {
    intro: "Ask anything about how the platform works.",
    subject: "Your question in a few words",
    body: "Add any detail that helps us answer.",
  },
  feedback: {
    intro: "Share what's working well or what could be better.",
    subject: "Your feedback in a few words",
    body: "Tell us more.",
  },
  security: {
    intro: "Describe the concern. Don't include passwords, keys, or personal data.",
    subject: "Short summary of the concern",
    body: "What did you notice, and where?",
  },
};

type Draft = { kind: IssueReportKind; impact: "high" | "normal" | "low"; subject: string; body: string };

function readDraft(): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (typeof parsed.subject !== "string" || typeof parsed.body !== "string") return null;
    return {
      kind: KIND_ORDER.includes(parsed.kind as IssueReportKind) ? (parsed.kind as IssueReportKind) : "bug",
      impact: parsed.impact === "high" || parsed.impact === "low" ? parsed.impact : "normal",
      subject: parsed.subject.slice(0, 200),
      body: parsed.body.slice(0, 5000),
    };
  } catch {
    return null;
  }
}

function writeDraft(draft: Draft | null) {
  try {
    if (!draft || (!draft.subject.trim() && !draft.body.trim())) {
      window.sessionStorage.removeItem(DRAFT_KEY);
    } else {
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    }
  } catch {
    // Storage can be unavailable (private mode); the form still works.
  }
}

function screenshotProblem(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return "Choose a PNG, JPEG, GIF, or WebP image.";
  if (file.size > MAX_SCREENSHOT_BYTES) return "Choose a screenshot that is 10 MB or smaller.";
  return null;
}

async function captureVisibleTab(): Promise<File> {
  const media = navigator.mediaDevices as MediaDevices & {
    getDisplayMedia?: (options?: unknown) => Promise<MediaStream>;
  };
  if (!media?.getDisplayMedia) throw new Error("This browser can't capture the screen.");
  const stream = await media.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
  });
  // Hide the report drawer for the captured frame so the screenshot shows
  // the page behind it.
  document.documentElement.classList.add("is-capturing-report");
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The screen capture could not be saved.");
    return new File([blob], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`, {
      type: "image/png",
    });
  } finally {
    document.documentElement.classList.remove("is-capturing-report");
    stream.getTracks().forEach((track) => track.stop());
  }
}

export function IssueReportForm({
  onSubmit,
  onViewReport,
}: {
  onSubmit?: (payload: IssueReportSubmission) => Promise<IssueReportRecord | void>;
  onViewReport?: (reportId: string) => void;
}) {
  const initial = useMemo(() => (typeof window === "undefined" ? null : readDraft()), []);
  const [kind, setKind] = useState<IssueReportKind>(initial?.kind ?? "bug");
  const [impact, setImpact] = useState<"high" | "normal" | "low">(initial?.impact ?? "normal");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [includeDetails, setIncludeDetails] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<IssueReportRecord | null | "sent">(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const detailsId = useId();
  const canCapture =
    typeof navigator !== "undefined" &&
    typeof (navigator.mediaDevices as { getDisplayMedia?: unknown } | undefined)?.getDisplayMedia === "function";
  const diagnostics = useMemo(() => (detailsOpen ? collectDiagnostics() : null), [detailsOpen]);
  const copy = COPY[kind];

  useEffect(() => {
    writeDraft({ kind, impact, subject, body });
  }, [kind, impact, subject, body]);

  useEffect(() => {
    if (!screenshot || typeof URL.createObjectURL !== "function") {
      setScreenshotUrl(null);
      return;
    }
    const url = URL.createObjectURL(screenshot);
    setScreenshotUrl(url);
    return () => URL.revokeObjectURL?.(url);
  }, [screenshot]);

  const acceptScreenshot = (file: File | null | undefined) => {
    if (!file) return;
    const problem = screenshotProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setScreenshot(file);
  };

  const handlePaste = (event: ClipboardEvent<HTMLFormElement>) => {
    const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    acceptScreenshot(new File([file], file.name || "pasted-screenshot.png", { type: file.type }));
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    acceptScreenshot(event.dataTransfer.files?.[0]);
  };

  const handleCapture = async () => {
    setCapturing(true);
    setError(null);
    try {
      acceptScreenshot(await captureVisibleTab());
    } catch (captureError) {
      if (captureError instanceof DOMException && captureError.name === "NotAllowedError") return;
      setError(captureError instanceof Error ? captureError.message : "The screen could not be captured.");
    } finally {
      setCapturing(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onSubmit) {
      setError("Issue reporting is not connected right now.");
      return;
    }
    const cleanSubject = subject.trim();
    const cleanBody = body.trim();
    if (!cleanSubject || !cleanBody) {
      setError("Add both a subject and a message.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const record = await onSubmit({
        subject: cleanSubject,
        body: cleanBody,
        kind,
        priority: kind === "bug" ? impact : "normal",
        screenshot,
        diagnostics: includeDetails ? collectDiagnostics() : null,
      });
      setSent(record ?? "sent");
      setSubject("");
      setBody("");
      setScreenshot(null);
      setKind("bug");
      setImpact("normal");
      writeDraft(null);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The issue report could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    const record = sent === "sent" ? null : sent;
    return (
      <div className="issue-report-success" role="status">
        <span className="feedback-icon is-positive"><Check size={18} /></span>
        <div>
          <strong>{record?.number ? `Report #${record.number} sent` : "Report sent"}</strong>
          <p>
            Thank you. Your administrators can see it now, and you can follow its status and
            replies in My reports.
          </p>
        </div>
        <div className="issue-report-success-actions">
          {record && onViewReport && (
            <button className="primary-button" type="button" onClick={() => onViewReport(record.id)}>
              <ListChecks size={15} /> View status
            </button>
          )}
          <button className="secondary-button" type="button" onClick={() => setSent(null)}>
            Report another issue
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="issue-report-form" onSubmit={handleSubmit} onPaste={handlePaste}>
      <fieldset className="issue-report-kind">
        <legend>What would you like to send?</legend>
        <RailSwitch
          ariaLabel="Report type"
          block
          stacked
          value={kind}
          onChange={setKind}
          options={KIND_ORDER.map((option) => ({
            value: option,
            label: SHORT_KIND_LABELS[option],
            icon: <TicketKindIcon kind={option} size={16} />,
            tooltip: KIND_LABELS[option],
          }))}
        />
      </fieldset>
      <p className="issue-report-intro">{copy.intro}</p>
      {kind === "security" && (
        <p className="issue-report-notice" role="note">
          <ShieldAlert size={15} /> Security concerns go only to your administrators and are never
          posted publicly.
        </p>
      )}
      {kind === "bug" && (
        <fieldset className="issue-report-kind">
          <legend>How much is this affecting you?</legend>
          <RailSwitch
            ariaLabel="Impact"
            block
            value={impact}
            onChange={setImpact}
            options={IMPACT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          />
        </fieldset>
      )}
      <label>
        <span>Subject</span>
        <input
          autoFocus
          maxLength={200}
          value={subject}
          onChange={(event) => setSubject(event.currentTarget.value)}
          placeholder={copy.subject}
          required
        />
      </label>
      <label>
        <span>Message</span>
        <textarea
          maxLength={5000}
          rows={7}
          value={body}
          onChange={(event) => setBody(event.currentTarget.value)}
          placeholder={copy.body}
          required
        />
      </label>
      <small className="issue-report-counter" aria-live="polite">
        {body.length.toLocaleString()} / 5,000
      </small>

      <div
        className={clsx("issue-report-dropzone", dragging && "is-dragging")}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <span className="issue-report-dropzone-title">Screenshot (optional)</span>
        {screenshot ? (
          <div className="issue-report-thumb">
            {screenshotUrl && <img src={screenshotUrl} alt="Screenshot to attach" />}
            <span>
              <strong>{screenshot.name}</strong>
              <small>{(screenshot.size / 1024 / 1024).toFixed(1)} MB</small>
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Remove screenshot"
              data-tooltip="Remove screenshot"
              onClick={() => setScreenshot(null)}
            >
              <X size={15} />
            </button>
          </div>
        ) : (
          <>
            <div className="issue-report-dropzone-actions">
              <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
                <ImagePlus size={15} /> Choose image
              </button>
              {canCapture && (
                <button type="button" className="secondary-button" disabled={capturing} onClick={() => void handleCapture()}>
                  <Monitor size={15} /> {capturing ? "Capturing…" : "Capture screen"}
                </button>
              )}
            </div>
            <small>Or paste or drop an image here. PNG, JPEG, GIF, or WebP up to 10 MB.</small>
          </>
        )}
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          aria-label="Screenshot (optional)"
          accept={ACCEPTED_TYPES.join(",")}
          onChange={(event) => {
            acceptScreenshot(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </div>

      <div className="issue-report-details">
        <label className="issue-report-check">
          <input
            type="checkbox"
            checked={includeDetails}
            onChange={(event) => setIncludeDetails(event.currentTarget.checked)}
          />
          <span>Include technical details</span>
        </label>
        <button
          type="button"
          className="issue-report-details-toggle"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          What's included <ChevronDown size={14} />
        </button>
        {detailsOpen && diagnostics && (
          <dl id={detailsId} className="issue-report-details-list">
            <dt>Page</dt>
            <dd>{diagnostics.route || "—"}</dd>
            <dt>Browser and screen</dt>
            <dd>{[diagnostics.viewport, diagnostics.color_scheme, diagnostics.language].filter(Boolean).join(" · ")}</dd>
            <dt>Recent errors</dt>
            <dd>
              {diagnostics.recent_errors?.length
                ? diagnostics.recent_errors.map((entry) => <span key={entry.at + entry.message}>{entry.message}</span>)
                : "None"}
            </dd>
            <dt>Failed requests</dt>
            <dd>
              {diagnostics.failed_requests?.length
                ? diagnostics.failed_requests.map((entry) => (
                    <span key={entry.at + entry.path}>{`${entry.method} ${entry.path} → ${entry.status}`}</span>
                  ))
                : "None"}
            </dd>
            <dd className="issue-report-details-note">
              Your browser version and app version are included too. No chat content is ever attached.
            </dd>
          </dl>
        )}
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button issue-report-submit" type="submit" disabled={busy}>
        <Send size={15} /> {busy ? "Sending…" : "Send report"}
      </button>
    </form>
  );
}
