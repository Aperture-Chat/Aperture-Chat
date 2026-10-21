import clsx from "clsx";
import { BellRing, CheckCircle2, Github, KeyRound, Mail, Share2, Sparkles, UsersRound, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import type { SupportHubStatus, SupportSettings, SupportSettingsUpdateRequest, SupportUpstreamMode } from "../lib/types";
import { Panel, Toggle } from "./Primitives";
import { SelectControl } from "./SelectControl";

const MODES: { value: SupportUpstreamMode; title: string; detail: string }[] = [
  {
    value: "review",
    title: "Review each report",
    detail: "Recommended. Nothing leaves until an owner reviews the redacted text and sends it.",
  },
  {
    value: "automatic",
    title: "Share automatically",
    detail:
      "Every new report except security concerns is redacted and sent. With a support assistant model, AI rewrites it first as an extra privacy pass.",
  },
  {
    value: "off",
    title: "Off",
    detail: "Reports stay on this platform. Prefilled GitHub issue links still work.",
  },
];

/** Owner-only support settings: sharing, AI assistance, notices, and the hub. */
export function SupportSettingsPanel({
  load,
  save,
  hubStatus,
  checkGitHub,
}: {
  load: () => Promise<SupportSettings>;
  save: (patch: SupportSettingsUpdateRequest) => Promise<SupportSettings>;
  hubStatus?: () => Promise<SupportHubStatus>;
  checkGitHub?: () => Promise<{ ok: boolean; repository: string; private: boolean }>;
}) {
  const [settings, setSettings] = useState<SupportSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<SupportHubStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [githubCheck, setGithubCheck] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    load()
      .then((next) => {
        if (!active) return;
        setSettings(next);
        setRepository(next.hub_repository);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Settings could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [load]);

  const update = async (patch: SupportSettingsUpdateRequest, message = "Saved.") => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await save(patch);
      setSettings(next);
      setRepository(next.hub_repository);
      setNotice(message);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The setting could not be saved.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runHubCheck = async () => {
    if (!hubStatus) return;
    setChecking(true);
    try {
      setStatus(await hubStatus());
    } catch (checkError) {
      setStatus({
        hub_url: settings?.hub_url ?? "",
        reachable: false,
        accepting: false,
        detail: checkError instanceof Error ? checkError.message : "The hub could not be checked.",
      });
    } finally {
      setChecking(false);
    }
  };

  const runGitHubCheck = async () => {
    if (!checkGitHub) return;
    setChecking(true);
    try {
      const result = await checkGitHub();
      setGithubCheck({ ok: true, text: `Connected to ${result.repository}${result.private ? " (private repository)" : ""}.` });
    } catch (checkError) {
      setGithubCheck({ ok: false, text: checkError instanceof Error ? checkError.message : "GitHub could not be reached." });
    } finally {
      setChecking(false);
    }
  };

  if (!settings) {
    return error ? <p className="form-error" role="alert">{error}</p> : <p className="support-muted">Loading settings…</p>;
  }

  return (
    <div className="support-settings">
      {(error || notice) && (
        <p className={error ? "form-error" : "support-saved"} role={error ? "alert" : "status"}>
          {error ?? notice}
        </p>
      )}

      <Panel
        title={<span className="support-panel-title"><Share2 size={16} /> Sharing with the Aperture Chat maintainers</span>}
        subtitle="Send redacted reports to the project's community hub so they become GitHub issues, without a GitHub account here."
        collapsible={false}
      >
        <div className="support-mode-options" role="radiogroup" aria-label="Sharing mode">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={settings.upstream_mode === mode.value}
              className={clsx("support-mode-option", settings.upstream_mode === mode.value && "is-selected")}
              disabled={saving}
              onClick={() => void update({ upstream_mode: mode.value }, `Sharing set to ${mode.title.toLowerCase()}.`)}
            >
              <strong>{mode.title}</strong>
              <small>{mode.detail}</small>
            </button>
          ))}
        </div>
        <div className="support-hub-line">
          <span>
            Community hub: <strong>{settings.hub_is_self ? "This deployment" : settings.hub_url || "Not configured"}</strong>
          </span>
          {hubStatus && (
            <button className="secondary-button" type="button" disabled={checking} onClick={() => void runHubCheck()}>
              {checking ? "Checking…" : "Check connection"}
            </button>
          )}
        </div>
        {status && (
          <p className={clsx("support-check", status.reachable && status.accepting ? "is-ok" : "is-bad")} role="status">
            {status.reachable && status.accepting ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {status.reachable && status.accepting
              ? `The hub is accepting reports${status.repository ? ` for ${status.repository}` : ""}.`
              : status.detail ?? "The hub is not accepting reports."}
            {status.reachable && status.accepting && status.detail ? ` ${status.detail}` : ""}
          </p>
        )}
        <p className="support-muted">
          Security concerns are never shared, and screenshots never leave this platform. This deployment is
          identified to the hub only by an anonymous ID ({settings.instance_id.slice(0, 8)}…).
        </p>
      </Panel>

      <Panel
        title={<span className="support-panel-title"><Sparkles size={16} /> Support assistant</span>}
        subtitle="An optional model that rewrites reports for sharing and triages community hub reports."
        collapsible={false}
      >
        <label className="support-field support-field-inline">
          <span>Model</span>
          <SelectControl
            aria-label="Support assistant model"
            value={settings.ai_model_id ?? ""}
            disabled={saving}
            onChange={(event) =>
              void update({ ai_model_id: event.currentTarget.value }, event.currentTarget.value ? "Support assistant updated." : "Support assistant turned off.")
            }
          >
            <option value="">None (no AI assistance)</option>
            {settings.model_options.map((option) => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
          </SelectControl>
        </label>
        <p className="support-muted">
          The model only ever sees text that was already redacted, and its answer is redacted again before anything is sent.
        </p>
      </Panel>

      <Panel
        title={<span className="support-panel-title"><Mail size={16} /> Updates for the people who report</span>}
        collapsible={false}
      >
        <div className="support-toggle-row">
          <span>
            <strong>Email reporters when support replies or changes the status</strong>
            <small>
              {settings.email_configured
                ? "People can always follow their reports in Help › My reports."
                : "Email isn't set up yet, so updates show only in Help › My reports. Set up SMTP in Alerts to send emails."}
            </small>
          </span>
          <Toggle
            checked={settings.notify_reporters}
            disabled={saving}
            label="Email reporters about updates"
            onChange={(next) => void update({ notify_reporters: next })}
          />
        </div>
        <p className="support-muted support-alert-tip">
          <BellRing size={14} /> To get an email for every new report, add an Alerts rule for{" "}
          <code>support.issue_reported</code>. Use <code>support.*</code> to include replies and reopened reports.
        </p>
      </Panel>

      <Panel
        title={<span className="support-panel-title"><UsersRound size={16} /> Community hub</span>}
        subtitle="Run the intake hub on this deployment: accept reports from every Aperture Chat deployment and file them on GitHub."
        collapsible={false}
      >
        <div className="support-toggle-row">
          <span>
            <strong>Accept reports from other deployments</strong>
            <small>Only the project's own deployment usually turns this on.</small>
          </span>
          <Toggle
            checked={settings.hub_enabled}
            disabled={saving}
            label="Accept community reports"
            onChange={(next) => void update({ hub_enabled: next }, next ? "Community hub turned on." : "Community hub turned off.")}
          />
        </div>
        {settings.hub_enabled && (
          <div className="support-hub-settings">
            <label className="support-field">
              <span>GitHub repository</span>
              <span className="support-inline-input">
                <input
                  value={repository}
                  placeholder="owner/name"
                  onChange={(event) => setRepository(event.currentTarget.value)}
                />
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saving || repository.trim() === settings.hub_repository}
                  onClick={() => void update({ hub_repository: repository.trim() }, "Repository saved.")}
                >
                  Save
                </button>
              </span>
            </label>
            <label className="support-field">
              <span>
                <KeyRound size={13} /> GitHub token {settings.hub_token_set ? `(saved: ${settings.hub_masked_token})` : "(not set)"}
              </span>
              <span className="support-inline-input">
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  placeholder={settings.hub_token_set ? "Paste a new token to replace it" : "github_pat_…"}
                  onChange={(event) => setToken(event.currentTarget.value)}
                />
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saving || !token.trim()}
                  onClick={() =>
                    void update({ hub_github_token: token.trim() }, "Token saved.").then((ok) => {
                      if (ok) setToken("");
                    })
                  }
                >
                  Save token
                </button>
                {settings.hub_token_set && (
                  <button className="secondary-button" type="button" disabled={saving} onClick={() => void update({ hub_github_token: "" }, "Token removed.")}>
                    Remove
                  </button>
                )}
              </span>
              <small>
                Use a fine-grained personal access token limited to this one repository with Issues: Read and write.
                It's stored encrypted and never shown again.
              </small>
            </label>
            {checkGitHub && settings.hub_token_set && (
              <div className="support-hub-line">
                <button className="secondary-button" type="button" disabled={checking} onClick={() => void runGitHubCheck()}>
                  <Github size={14} /> {checking ? "Checking…" : "Check GitHub access"}
                </button>
                {githubCheck && (
                  <span className={clsx("support-check", githubCheck.ok ? "is-ok" : "is-bad")} role="status">
                    {githubCheck.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {githubCheck.text}
                  </span>
                )}
              </div>
            )}
            <div className="support-toggle-row">
              <span>
                <strong>Publish clean reports automatically</strong>
                <small>
                  Files reports without review when triage finds no spam, sensitive data, security content, or
                  likely duplicate. Off means every report waits for you in the Community hub view.
                </small>
              </span>
              <Toggle
                checked={settings.hub_auto_publish}
                disabled={saving}
                label="Publish clean reports automatically"
                onChange={(next) => void update({ hub_auto_publish: next })}
              />
            </div>
            <div className="support-toggle-row">
              <span>
                <strong>AI triage</strong>
                <small>
                  {settings.ai_model_id
                    ? `Summarize, label, and check incoming reports with ${settings.ai_model_name ?? "the support assistant"}.`
                    : "Choose a support assistant model above to enable AI triage. Duplicate search runs either way."}
                </small>
              </span>
              <Toggle
                checked={settings.hub_ai_triage}
                disabled={saving}
                label="AI triage"
                onChange={(next) => void update({ hub_ai_triage: next })}
              />
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
