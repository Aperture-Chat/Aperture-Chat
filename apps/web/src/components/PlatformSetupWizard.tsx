import { AlertTriangle, ArrowRight, CheckCircle2, Circle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ChatRequestError, getPlatformSetupStatus, validatePlatformProvider } from "../lib/api";
import type { AppRoute } from "../lib/appRoute";
import type {
  PlatformSetupProviderStatus,
  PlatformSetupStatus,
  PlatformSetupStep,
  ProviderModelSyncResult,
} from "../lib/types";
import { Panel } from "./Primitives";

const STEP_COPY: Record<PlatformSetupStep["key"], { title: string; action: string; route: AppRoute }> = {
  provider: { title: "1. Add a provider", action: "Open Providers", route: { kind: "platform", section: "providers" } },
  credential: { title: "2. Store a credential", action: "Manage keys", route: { kind: "platform", section: "providers" } },
  validate: { title: "3. Validate the connection", action: "Open Providers", route: { kind: "platform", section: "providers" } },
  catalog: { title: "4. Sync the model catalog", action: "Open Providers", route: { kind: "platform", section: "providers" } },
  enable: { title: "5. Enable models", action: "Open Models", route: { kind: "platform", section: "models" } },
  grant: { title: "6. Grant models to groups", action: "Open Model Access", route: { kind: "admin", section: "model-access" } },
};

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function StatePill({ state }: { state: PlatformSetupStep["state"] }) {
  if (state === "done") {
    return (
      <span className="pill pill-success">
        <CheckCircle2 size={12} aria-hidden="true" /> Done
      </span>
    );
  }
  if (state === "attention") {
    return (
      <span className="pill pill-warning">
        <AlertTriangle size={12} aria-hidden="true" /> Needs attention
      </span>
    );
  }
  return (
    <span className="pill pill-info">
      <Circle size={12} aria-hidden="true" /> To do
    </span>
  );
}

/**
 * Owner setup wizard. Every state pill and summary is the server's
 * `setup-status`; nothing turns green because a button was clicked. Quick
 * actions call the same endpoints the Providers/Models screens use and then
 * refetch the status so the cards reflect what really happened.
 */
export function PlatformSetupWizard({
  actorUserId,
  onNavigate,
  onSyncProvider,
}: {
  actorUserId: string;
  onNavigate: (route: AppRoute) => void;
  /** Existing Providers-tab sync action (discovery + runtime test). */
  onSyncProvider?: (providerId: string) => Promise<ProviderModelSyncResult>;
}) {
  const [status, setStatus] = useState<PlatformSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<{ tone: "success" | "warning"; message: string } | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await getPlatformSetupStatus(actorUserId, { signal }));
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : "Could not load setup status.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [actorUserId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const validate = async (provider: PlatformSetupProviderStatus) => {
    setBusyProviderId(provider.id);
    setLastAction(null);
    try {
      const result = await validatePlatformProvider(actorUserId, provider.id);
      setLastAction({
        tone: "success",
        message: `${provider.name}: runtime test passed with ${result.model_name} in ${result.latency_ms} ms.`,
      });
    } catch (caught) {
      setLastAction({
        tone: "warning",
        message: `${provider.name}: ${caught instanceof ChatRequestError ? caught.message : "validation did not complete."}`,
      });
    } finally {
      setBusyProviderId(null);
      await refresh();
    }
  };

  const sync = async (provider: PlatformSetupProviderStatus) => {
    if (!onSyncProvider) return;
    setBusyProviderId(provider.id);
    setLastAction(null);
    try {
      const result = await onSyncProvider(provider.id);
      setLastAction({ tone: "success", message: result.message });
    } catch (caught) {
      setLastAction({
        tone: "warning",
        message: `${provider.name}: ${caught instanceof ChatRequestError ? caught.message : "catalog sync did not complete."}`,
      });
    } finally {
      setBusyProviderId(null);
      await refresh();
    }
  };

  return (
    <div className="console-main-col">
      <Panel
        className="setup-wizard-panel"
        title="Setup"
        subtitle="Provider → credential → validate → catalog → enable → grant. Each card shows what the server has actually recorded."
        collapsible={false}
        actions={
          <button className="secondary-button" type="button" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw size={16} /> Refresh
          </button>
        }
      >
        {error && <p className="inline-warning" role="alert">{error}</p>}
        {lastAction && (
          <p role="status" className={`setup-wizard-action-result is-${lastAction.tone}`}>
            {lastAction.message}
          </p>
        )}
        {loading && !status && <p role="status" className="muted-copy">Checking setup status…</p>}
        {status && (
          <>
            <p className={`setup-wizard-ready ${status.ready_for_users ? "is-ready" : ""}`} role="status">
              {status.ready_for_users
                ? "Ready for users: at least one enabled model is granted to a group with active members."
                : "Not ready for users yet. Work through the cards below; states update from the server after every action."}
            </p>
            <ol className="setup-wizard-steps" aria-label="Setup steps">
              {status.steps.map((step) => {
                const copy = STEP_COPY[step.key];
                return (
                  <li key={step.key} className={`setup-wizard-step is-${step.state}`}>
                    <div className="setup-wizard-step-heading">
                      <strong>{copy.title}</strong>
                      <StatePill state={step.state} />
                    </div>
                    <p className="setup-wizard-summary">{step.summary}</p>
                    {step.key === "validate" && step.providers.length > 0 && (
                      <ul className="setup-wizard-providers" aria-label="Provider validation">
                        {step.providers.map((provider) => (
                          <li key={provider.id}>
                            <span className="setup-wizard-provider-copy">
                              <strong>{provider.name}</strong>
                              <small>
                                {provider.last_validation_status === "passed"
                                  ? `Passed with ${provider.last_validation_model_id ?? "a model"} · ${formatWhen(provider.last_validated_at)}`
                                  : provider.last_validation_status === "auth_failed"
                                    ? `Credential rejected · ${formatWhen(provider.last_validated_at)}`
                                    : provider.last_validation_status === "failed"
                                      ? `Failed · ${formatWhen(provider.last_validated_at)}`
                                      : "Never validated"}
                                {" · "}
                                {provider.model_count} model{provider.model_count === 1 ? "" : "s"}
                                {provider.supports_model_sync ? "" : " · manual catalog"}
                                {provider.has_active_platform_key ? "" : " · no active platform key"}
                              </small>
                              {provider.status_message && <small className="setup-wizard-status-message">{provider.status_message}</small>}
                            </span>
                            <span className="setup-wizard-provider-actions">
                              <button
                                className="secondary-button compact"
                                type="button"
                                disabled={busyProviderId === provider.id || !provider.has_active_platform_key}
                                data-tooltip={
                                  provider.has_active_platform_key
                                    ? "Send one small live request through this provider"
                                    : "Store an active platform key first"
                                }
                                onClick={() => void validate(provider)}
                              >
                                Validate now
                              </button>
                              {onSyncProvider && provider.supports_model_sync && (
                                <button
                                  className="secondary-button compact"
                                  type="button"
                                  disabled={busyProviderId === provider.id || !provider.has_active_platform_key}
                                  onClick={() => void sync(provider)}
                                >
                                  Sync catalog
                                </button>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {step.key === "grant" && step.per_tenant.length > 0 && (
                      <ul className="setup-wizard-tenants" aria-label="Per-organization grants">
                        {step.per_tenant.map((tenant) => (
                          <li key={tenant.tenant_id}>
                            <strong>{tenant.tenant_name}</strong>: {tenant.groups_with_any_model} of {tenant.groups_total} groups carry a model;{" "}
                            {tenant.active_users_with_model} of {tenant.active_users} active users can use one
                            {tenant.pending_access_requests > 0
                              ? `; ${tenant.pending_access_requests} access request${tenant.pending_access_requests === 1 ? "" : "s"} waiting`
                              : ""}
                            .
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="setup-wizard-step-actions">
                      <button className="primary-button compact" type="button" onClick={() => onNavigate(copy.route)}>
                        {copy.action} <ArrowRight size={14} aria-hidden="true" />
                      </button>
                      {step.key === "grant" && (
                        <button
                          className="secondary-button compact"
                          type="button"
                          onClick={() => onNavigate({ kind: "admin", section: "groups" })}
                        >
                          Open Groups
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            <small className="muted-copy">Status generated {formatWhen(status.generated_at)}.</small>
          </>
        )}
      </Panel>
    </div>
  );
}
