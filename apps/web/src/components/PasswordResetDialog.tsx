import { Check, Copy, KeyRound, RefreshCw, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Toggle } from "./Primitives";
import { useModalFocus } from "../lib/useModalFocus";

/* Owner/admin dialog for issuing an account password. The password is stored
 * hashed server-side, so it is shown exactly once here — hence the generate
 * and copy affordances. Role scoping (who may reset whom) is enforced by the
 * API; callers only render the trigger for permitted targets. */

function generatePassword(): string {
  // No look-alike characters (0/O, 1/l/I) — these get read aloud and retyped.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const values = new Uint32Array(16);
  crypto.getRandomValues(values);
  return [...values].map((value) => alphabet[value % alphabet.length]).join("");
}

export function PasswordResetDialog({
  userName,
  userEmail,
  onClose,
  onSubmit,
}: {
  userName: string;
  userEmail?: string;
  onClose: () => void;
  onSubmit: (password: string, temporary: boolean) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [temporary, setTemporary] = useState(true);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const inputId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus(dialogRef, true, () => { if (!pending) onClose(); });

  async function save() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit(password, temporary);
      setSaved(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The password was not set.");
    } finally {
      setPending(false);
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Could not copy — select the password text and copy it manually.");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => { if (!pending) onClose(); }}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="modal password-reset-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <KeyRound size={20} />
          </span>
          <div>
            <h2 id={titleId}>Set a password for {userName}</h2>
            <p>The password is stored securely and shown only here — share it with {userName} over a safe channel.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close password dialog"
            data-tooltip="Close without changing anything else"
            onClick={onClose}
            disabled={pending}
          >
            <X size={17} />
          </button>
        </div>
        {saved ? (
          <div className="password-reset-done">
            <p className="password-reset-success">
              <Check size={15} /> Password set for {userName}.
              {temporary ? " They must choose their own password at first sign-in." : ""}
            </p>
            {userEmail && <p className="password-reset-hint">Sign in at {window.location.origin} with {userEmail}. Choose Email &amp; password if organization SSO is also available. An enforced SSO policy still applies.</p>}
            <div className="password-reveal-row">
              <code>{password}</code>
              <button
                className="secondary-button compact"
                type="button"
                data-tooltip="Copy the password so you can share it securely"
                onClick={() => void copyPassword()}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="connector-config-actions">
              <button className="primary-button" type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="password-reset-form">
            <label className="password-reset-field" htmlFor={inputId}>
              New password
              <span className="password-generate-row">
                <input
                  id={inputId}
                  disabled={pending}
                  type="text"
                  value={password}
                  placeholder="At least 12 characters"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  className="secondary-button"
                  type="button"
                  data-tooltip="Fill in a strong random password"
                  onClick={() => setPassword(generatePassword())}
                  disabled={pending}
                >
                  <RefreshCw size={14} /> Generate
                </button>
              </span>
            </label>
            <Toggle
              checked={temporary}
              disabled={pending}
              onChange={setTemporary}
              label="Temporary password"
              tooltip={
                temporary
                  ? `${userName} must set their own password the first time they sign in`
                  : "The password stays as issued until the user changes it themselves"
              }
            />
            <small className="password-reset-hint">
              {temporary
                ? `${userName} signs in with this once, then is required to choose their own password.`
                : `${userName} keeps this password until they change it from their account panel.`}
            </small>
            {error && <p className="connector-config-error">{error}</p>}
            <div className="connector-config-actions">
              <button
                className="primary-button"
                type="button"
                disabled={password.trim().length < 12 || pending}
                data-tooltip="Save this password through the admin API"
                onClick={() => void save()}
              >
                {pending ? "Setting..." : "Set password"}
              </button>
              <button className="secondary-button" type="button" disabled={pending} onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
