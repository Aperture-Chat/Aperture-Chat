import { Maximize2, Minimize2, Pencil, Sparkles, Undo2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { ChatRequestError, sendChat } from "../lib/api";
import {
  cleanImprovedPrompt,
  promptImproverSystemPrompt,
  type PromptImproverKind,
} from "../lib/promptImprover";

type ImproveRail = "off" | "run" | "done";

export function PromptImproveRail({
  state,
  progress,
  className = "",
}: {
  state: ImproveRail;
  progress: number;
  className?: string;
}) {
  return (
    <div
      className={`composer-improve-rail${state !== "off" ? " is-visible" : ""}${state === "run" ? " is-running" : ""}${state === "done" ? " is-done" : ""}${className ? ` ${className}` : ""}`}
      role={state === "run" ? "progressbar" : undefined}
      aria-label={state === "run" ? "Improving prompt" : undefined}
      aria-valuemin={state === "run" ? 0 : undefined}
      aria-valuemax={state === "run" ? 100 : undefined}
      aria-valuenow={state === "run" ? Math.round(progress) : undefined}
      aria-hidden={state === "off"}
    >
      <span className="composer-improve-rail-track" />
      <span className="composer-improve-rail-fill" style={{ width: `${progress}%` }} />
    </div>
  );
}

export function PromptImproveIcon() {
  return (
    <span className="prompt-improve-icon" aria-hidden="true">
      <Pencil size={15} />
      <Sparkles size={12} />
    </span>
  );
}

export function PromptEditorField({
  label,
  value,
  onChange,
  userId,
  modelId,
  kind,
  className = "",
  minHeight,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  userId: string;
  modelId?: string | null;
  kind: Exclude<PromptImproverKind, "chat">;
  className?: string;
  minHeight?: number;
  disabled?: boolean;
}) {
  const textareaId = useId();
  const modalTitleId = useId();
  const [expanded, setExpanded] = useState(false);
  const [isImproving, setIsImproving] = useState(false);
  const [improveRail, setImproveRail] = useState<ImproveRail>("off");
  const [improveProgress, setImproveProgress] = useState(0);
  const [originalPrompt, setOriginalPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isImproving) return;
    setImproveRail("run");
    setImproveProgress(7);
    const started = Date.now();
    const tick = window.setInterval(() => {
      const elapsed = Date.now() - started;
      setImproveProgress(7 + 83 * (1 - Math.exp(-elapsed / 4500)));
    }, 80);
    return () => window.clearInterval(tick);
  }, [isImproving]);

  useEffect(() => {
    if (isImproving || improveRail !== "run") return;
    setImproveProgress(100);
    setImproveRail("done");
    const hide = window.setTimeout(() => setImproveRail("off"), 4500);
    const reset = window.setTimeout(() => setImproveProgress(0), 5300);
    return () => {
      window.clearTimeout(hide);
      window.clearTimeout(reset);
    };
  }, [isImproving, improveRail]);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImproving) setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded, isImproving]);

  async function improvePrompt() {
    const prompt = value.trim();
    if (!prompt || !modelId || isImproving || disabled) return;
    setError(null);
    setIsImproving(true);
    try {
      const reply = await sendChat(userId, {
        model: modelId,
        messages: [
          { role: "system", content: promptImproverSystemPrompt(kind) },
          { role: "user", content: `Draft prompt to improve:\n\n${prompt}` },
        ],
        runtime: {
          surface: "chat",
          webEnabled: false,
          citationsEnabled: false,
          maxCompletionTokens: 2000,
        },
      });
      const improved = cleanImprovedPrompt(reply.content ?? "");
      if (!improved) throw new ChatRequestError("The model did not return a usable rewrite.");
      setOriginalPrompt((current) => current ?? value);
      onChange(improved);
    } catch (nextError) {
      setError(
        nextError instanceof ChatRequestError && nextError.message
          ? nextError.message
          : "Could not improve this prompt. Check your connection and try again.",
      );
    } finally {
      setIsImproving(false);
    }
  }

  function restoreOriginal() {
    if (originalPrompt === null || isImproving) return;
    onChange(originalPrompt);
    setOriginalPrompt(null);
    setError(null);
  }

  const hasText = value.trim().length > 0;
  const improveDisabled = disabled || isImproving || !hasText || !modelId;
  const improveTooltip = !modelId
    ? "Connect an available AI model before improving this prompt"
    : isImproving
      ? "Improving your prompt..."
      : `Improve this ${label.toLowerCase()} with AI while preserving its intent and safeguards`;

  const controls = (showExpand = true) => (
    <div className="prompt-editor-actions" role="group" aria-label={`${label} actions`}>
      {originalPrompt !== null && (
        <button
          type="button"
          className="prompt-editor-action prompt-restore-button"
          aria-label={`Restore original ${label.toLowerCase()}`}
          data-tooltip="Restore the version from before the last AI improvement"
          disabled={disabled || isImproving}
          onClick={restoreOriginal}
        >
          <Undo2 size={16} />
        </button>
      )}
      <button
        type="button"
        className={`prompt-editor-action prompt-editor-improve-button${isImproving ? " is-improving" : ""}`}
        aria-label={`Improve ${label.toLowerCase()}`}
        data-tooltip={improveTooltip}
        disabled={improveDisabled}
        onClick={() => void improvePrompt()}
      >
        <PromptImproveIcon />
      </button>
      {showExpand && (
        <button
          type="button"
          className="prompt-editor-action"
          aria-label={`Expand ${label.toLowerCase()}`}
          data-tooltip={`Open ${label.toLowerCase()} in a larger editor`}
          disabled={disabled || isImproving}
          onClick={() => setExpanded(true)}
        >
          <Maximize2 size={16} />
        </button>
      )}
    </div>
  );

  return (
    <div
      className={`prompt-editor-field${className ? ` ${className}` : ""}`}
      aria-hidden={expanded ? true : undefined}
    >
      <div className="prompt-editor-field-head">
        <label htmlFor={textareaId}>{label}</label>
        {controls()}
      </div>
      <div className={`prompt-editor-surface${isImproving ? " is-improving" : ""}`}>
        <PromptImproveRail state={improveRail} progress={improveProgress} />
        {isImproving && (
          <span className="sr-only" role="status">
            Improving prompt
          </span>
        )}
        <textarea
          id={textareaId}
          value={value}
          readOnly={isImproving}
          disabled={disabled}
          style={minHeight ? { minHeight } : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
      {error && (
        <p className="prompt-editor-error" role="alert">
          {error}
        </p>
      )}
      {expanded &&
        createPortal(
          <div className="prompt-editor-overlay" role="presentation">
            <section
              className={`prompt-editor-dialog${isImproving ? " is-improving" : ""}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby={modalTitleId}
            >
              <PromptImproveRail state={improveRail} progress={improveProgress} />
              <header className="prompt-editor-dialog-head">
                <div>
                  <span>Prompt editor</span>
                  <h2 id={modalTitleId}>{label}</h2>
                </div>
                <div className="prompt-editor-dialog-head-actions">
                  {controls(false)}
                  <button
                    type="button"
                    className="prompt-editor-collapse-button"
                    aria-label={`Collapse ${label.toLowerCase()}`}
                    data-tooltip="Return to the standard editor"
                    disabled={isImproving}
                    onClick={() => setExpanded(false)}
                  >
                    <Minimize2 size={17} />
                    <span>Collapse</span>
                  </button>
                </div>
              </header>
              <textarea
                aria-label={`Expanded ${label.toLowerCase()}`}
                autoFocus
                value={value}
                readOnly={isImproving}
                disabled={disabled}
                onChange={(event) => onChange(event.target.value)}
              />
              <footer className="prompt-editor-dialog-foot">
                <span>{value.length.toLocaleString()} characters</span>
                <span>{isImproving ? "Improving with AI…" : "Changes stay in this unsaved draft"}</span>
              </footer>
            </section>
          </div>,
          document.body,
        )}
    </div>
  );
}
