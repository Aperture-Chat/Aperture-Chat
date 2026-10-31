import { Braces, Check, ChevronDown, Copy, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState, type ComponentProps, type Ref } from "react";
import { ChatRequestError } from "../lib/api/http";
import type { AccountApiKeyCreateResponse, AccountApiKeyStatus } from "../lib/types";
import { AccountConfirm, AccountRowBody, useAnnounce, useReturnFocus } from "./AccountRow";

type CopyField = "url" | "key";
type PendingChange = "rotate" | "revoke";
type CopyFn = (value: string, field: CopyField) => void;
type ReturnFocus = ReturnType<typeof useReturnFocus>;
type ApiKeyHandlers = {
  onLoad?: () => Promise<AccountApiKeyStatus>;
  onCreate?: (options: { replace: boolean }) => Promise<AccountApiKeyCreateResponse>;
  onRevoke?: () => Promise<AccountApiKeyStatus>;
  /** Holds the drawer open until a change's result, or show-once secret, appears. */
  onMutationChange: (running: boolean) => void;
};

const CHANGE_COPY: Record<PendingChange, { message: string; confirm: string }> = {
  rotate: { message: "Replace this API key? The current key stops working immediately.", confirm: "Replace key" },
  revoke: { message: "Revoke this API key? Any connected coding tools will lose access immediately.", confirm: "Revoke key" },
};

function formatApiTimestamp(value?: string | null) {
  if (!value) return "recently";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function failureMessage(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback;
}

function isKeyConflict(failure: unknown) {
  return failure instanceof ChatRequestError && failure.status === 409;
}

function useApiKeyStatus(
  onLoad: ApiKeyHandlers["onLoad"],
  returnTo: ReturnFocus["returnTo"],
  setError: (message: string | null) => void,
) {
  const [status, setStatus] = useState<AccountApiKeyStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!onLoad) return;
    let cancelled = false;
    const whileMounted = <T,>(apply: (value: T) => void) => (value: T) => {
      if (!cancelled) apply(value);
    };
    // A retry must not drop focus: the key that was pressed unmounts while loading.
    const retrying = loadAttempt > 0;
    setLoading(true);
    setError(null);
    void onLoad()
      .then(whileMounted((next) => {
        if (retrying) returnTo("rotate");
        setStatus(next);
      }))
      .catch(whileMounted((failure: unknown) => {
        if (retrying) returnTo("retry");
        setError(failureMessage(failure, "Could not load API access."));
      }))
      .finally(whileMounted<void>(() => setLoading(false)));
    return () => {
      cancelled = true;
    };
  }, [onLoad, loadAttempt]);

  return { status, setStatus, loading, retryLoad: () => setLoadAttempt((attempt) => attempt + 1) };
}

function useApiKey({ onLoad, onCreate, onRevoke, onMutationChange }: ApiKeyHandlers, returnTo: ReturnFocus["returnTo"]) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const { status, setStatus, loading, retryLoad } = useApiKeyStatus(onLoad, returnTo, setError);
  const announce = useAnnounce();

  const run = async (action: () => Promise<void>, fallback: string) => {
    setChanging(true);
    onMutationChange(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failureMessage(failure, fallback));
    } finally {
      setChanging(false);
      onMutationChange(false);
    }
  };

  /** A 409 means a key went live after this panel loaded, so show that key. */
  const refreshAfterConflict = async (failure: unknown) => {
    if (isKeyConflict(failure)) await onLoad?.().then(setStatus);
    throw failure;
  };

  const create = (replace: boolean) =>
    run(async () => {
      setSecret(null);
      const created = await onCreate?.({ replace }).catch(refreshAfterConflict);
      if (!created) return;
      returnTo("copy-key");
      setStatus(created);
      setSecret(created.secret_value);
      announce("New API key created. Copy it now.");
    }, "Could not create the API key.");

  const revoke = () =>
    run(async () => {
      const next = await onRevoke?.();
      if (!next) return;
      returnTo("rotate");
      setStatus(next);
      setSecret(null);
      announce("API key revoked.");
    }, "Could not revoke the API key.");

  return { status, secret, error, setError, busy: loading || changing, create, revoke, retryLoad };
}

function useCopy(onFailure: (message: string) => void) {
  const [copied, setCopied] = useState<CopyField | null>(null);
  const copy: CopyFn = (value, field) => {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(field);
        window.setTimeout(() => setCopied((current) => (current === field ? null : current)), 1800);
      })
      .catch(() => onFailure("Clipboard access is unavailable. Select and copy the value manually."));
  };
  return { copied, copy };
}

function CopyValue({
  label,
  copyName,
  tooltip,
  value,
  copied,
  lit = false,
  copyRef,
  onCopy,
}: {
  label: string;
  copyName: string;
  tooltip: string;
  value: string;
  copied: boolean;
  /** Copy is the main action only while a show-once secret is on screen. */
  lit?: boolean;
  copyRef?: Ref<HTMLButtonElement>;
  onCopy: () => void;
}) {
  return (
    <span className="account-api-value-row">
      <input aria-label={label} readOnly value={value} />
      <button
        ref={copyRef}
        className={lit ? "primary-button" : "secondary-button"}
        type="button"
        aria-label={copyName}
        data-tooltip={tooltip}
        onClick={onCopy}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function KeyState({
  status,
  secret,
  copied,
  onCopy,
  target,
}: {
  status: AccountApiKeyStatus;
  secret: string | null;
  copied: CopyField | null;
  onCopy: CopyFn;
  target: ReturnFocus["target"];
}) {
  if (secret) {
    return (
      <div className="account-well account-api-secret">
        <strong>New API key</strong>
        <p>Copy it now. For security, the full key is shown only once.</p>
        <CopyValue
          label="New API key"
          copyName="Copy API key"
          tooltip="Copy this key before closing the account panel"
          value={secret}
          copied={copied === "key"}
          lit
          copyRef={target("copy-key")}
          onCopy={() => onCopy(secret, "key")}
        />
      </div>
    );
  }
  if (!status.has_key) {
    return <p className="account-panel-note">Create a personal key to use this workspace through its OpenAI-compatible API.</p>;
  }
  return (
    <div className="account-well account-api-existing">
      <span>
        <b>Active key</b>
        <code>{status.masked_value}</code>
      </span>
      <small>
        Created {formatApiTimestamp(status.created_at)}
        {status.last_used_at ? ` · Last used ${formatApiTimestamp(status.last_used_at)}` : " · Not used yet"}
      </small>
    </div>
  );
}

type KeyChangeProps = {
  hasKey: boolean;
  busy: boolean;
  canCreate: boolean;
  canRevoke: boolean;
  onCreate: (replace: boolean) => Promise<void>;
  onRevoke: () => Promise<void>;
  focus: ReturnFocus;
};

function KeyButtons({
  hasKey,
  busy,
  canCreate,
  canRevoke,
  onCreate,
  onAsk,
  focus,
}: Omit<KeyChangeProps, "onRevoke"> & { onAsk: (change: PendingChange) => void }) {
  return (
    <div className="drawer-form-actions">
      {hasKey && (
        <button
          ref={focus.target("revoke")}
          className="secondary-button"
          type="button"
          disabled={busy || !canRevoke}
          data-tooltip="Revoke the current key immediately"
          onClick={() => onAsk("revoke")}
        >
          Revoke
        </button>
      )}
      <button
        ref={focus.target("rotate")}
        className={hasKey ? "secondary-button" : "primary-button"}
        type="button"
        disabled={busy || !canCreate}
        data-tooltip={hasKey ? "Replace the current API key" : "Create a personal API key"}
        onClick={() => {
          if (hasKey) {
            onAsk("rotate");
            return;
          }
          focus.returnTo("rotate");
          void onCreate(false);
        }}
      >
        {hasKey ? <RefreshCw size={14} /> : <KeyRound size={14} />}
        {hasKey ? "Rotate key" : "Create key"}
      </button>
    </div>
  );
}

/** The change keys. Replacing or revoking a live key asks first, in place. */
function KeyChanges(props: KeyChangeProps) {
  const [pending, setPending] = useState<PendingChange | null>(null);
  const { focus } = props;

  if (!pending) return <KeyButtons {...props} onAsk={setPending} />;

  const confirm = async () => {
    // Success sends focus to what it revealed; otherwise it returns to the asker.
    focus.returnTo(pending);
    await (pending === "rotate" ? props.onCreate(true) : props.onRevoke());
    setPending(null);
  };

  return (
    <AccountConfirm
      message={CHANGE_COPY[pending].message}
      confirmLabel={CHANGE_COPY[pending].confirm}
      cancelLabel="Keep key"
      destructive={pending === "revoke"}
      busy={props.busy}
      onConfirm={() => void confirm()}
      onCancel={() => {
        focus.returnTo(pending);
        setPending(null);
      }}
    />
  );
}

function KeyPanel({
  status,
  secret,
  copied,
  onCopy,
  ...changes
}: Omit<KeyChangeProps, "hasKey"> & {
  status: AccountApiKeyStatus;
  secret: string | null;
  copied: CopyField | null;
  onCopy: CopyFn;
}) {
  return (
    <>
      <KeyState status={status} secret={secret} copied={copied} onCopy={onCopy} target={changes.focus.target} />
      <KeyChanges {...changes} hasKey={status.has_key} />
    </>
  );
}

function ApiAccessBody({
  status,
  onRetry,
  canLoad,
  ...panel
}: Omit<ComponentProps<typeof KeyPanel>, "status"> & {
  status: AccountApiKeyStatus | null;
  onRetry: () => void;
  canLoad: boolean;
}) {
  const apiBaseUrl = `${window.location.origin.replace(/\/$/, "")}/v1`;
  return (
    <>
      <div className="account-field">
        Platform URL
        <CopyValue
          label="Platform API URL"
          copyName="Copy platform API URL"
          tooltip="Copy the OpenAI-compatible base URL"
          value={apiBaseUrl}
          copied={panel.copied === "url"}
          onCopy={() => panel.onCopy(apiBaseUrl, "url")}
        />
      </div>
      {status ? (
        <KeyPanel status={status} {...panel} />
      ) : (
        // Without a status, a key may exist, and creating one would replace it.
        <div className="drawer-form-actions">
          <button ref={panel.focus.target("retry")} className="secondary-button" type="button" disabled={!canLoad} onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </>
  );
}

/** Personal OpenAI-compatible key: shown once, replaced or revoked in place. */
export function AccountApiAccess({
  initialAccess,
  ...handlers
}: ApiKeyHandlers & {
  /** Whether the local policy grants access before the server has answered. */
  initialAccess: boolean;
}) {
  const focus = useReturnFocus();
  const { status, secret, error, setError, busy, create, revoke, retryLoad } = useApiKey(handlers, focus.returnTo);
  const { copied, copy } = useCopy(setError);

  if (!(status?.enabled ?? initialAccess)) return null;

  return (
    <details className="account-disclosure">
      <summary className="account-row is-pressable">
        <AccountRowBody icon={Braces} title="API access" detail={status?.has_key ? "Personal key active" : "OpenAI-compatible access"} />
        <ChevronDown className="account-row-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="account-row-panel">
        {busy && status === null ? (
          <p className="account-panel-note">Checking your API access…</p>
        ) : (
          <ApiAccessBody
            status={status}
            secret={secret}
            busy={busy}
            copied={copied}
            onCopy={copy}
            onRetry={retryLoad}
            canLoad={Boolean(handlers.onLoad)}
            canCreate={Boolean(handlers.onCreate)}
            canRevoke={Boolean(handlers.onRevoke)}
            onCreate={create}
            onRevoke={revoke}
            focus={focus}
          />
        )}
        {error && <small className="drawer-error" role="alert">{error}</small>}
      </div>
    </details>
  );
}
