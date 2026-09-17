import { Check, Inbox, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  ChatRequestError,
  approveModelAccessRequest,
  declineModelAccessRequest,
  listAdminModelAccessRequests,
} from "../lib/api";
import type { AdminModelAccessRequestView, Group } from "../lib/types";
import { Panel } from "./Primitives";

/**
 * Pending per-model access requests for the administrator's tenant. Approving
 * adds the requester to a group; when that group does not yet carry the model
 * the server also grants the model to the group, only if the actor is allowed
 * to. The rendered post-state is the server's decision, never a guess.
 */
export function ModelAccessRequestsPanel({
  actorUserId,
  groups,
  tenantSlug,
  onResolved,
}: {
  actorUserId: string;
  groups: Group[];
  /** Platform owners must name a tenant; tenant admins are pinned server-side. */
  tenantSlug?: string;
  onResolved?: () => void;
}) {
  const [requests, setRequests] = useState<AdminModelAccessRequestView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [groupChoice, setGroupChoice] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRequests(await listAdminModelAccessRequests(actorUserId, { status: "pending", tenantSlug }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load access requests.");
    } finally {
      setLoading(false);
    }
  }, [actorUserId, tenantSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groupName = (id: string) => groups.find((group) => group.id === id)?.name ?? id;

  const resolve = async (view: AdminModelAccessRequestView, action: "approve" | "decline") => {
    const requestId = view.request.id;
    setBusyId(requestId);
    setNotice(null);
    try {
      if (action === "approve") {
        const groupId = groupChoice[requestId] ?? view.eligible_group_ids[0] ?? "";
        if (!groupId) {
          setNotice("Choose the group that should carry this model before approving.");
          return;
        }
        const result = await approveModelAccessRequest(actorUserId, requestId, { group_id: groupId });
        setNotice(
          result.decision.allowed
            ? `${view.requester_display_name} can now use ${view.model_name} through ${groupName(groupId)}.`
            : `Approved, but the server still reports: ${result.decision.reason}`,
        );
      } else {
        await declineModelAccessRequest(actorUserId, requestId, {});
        setNotice(`Declined the request from ${view.requester_display_name}.`);
      }
      setRequests((current) => (current ?? []).filter((item) => item.request.id !== requestId));
      onResolved?.();
    } catch (caught) {
      setNotice(caught instanceof ChatRequestError ? caught.message : "The request could not be updated.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Panel
      className="model-access-requests-panel"
      title="Access requests"
      subtitle="People asking to use a model their groups do not grant. Approving adds them to a group that carries it."
      actions={
        <button
          className="secondary-button"
          type="button"
          data-tooltip="Reload pending access requests"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw size={16} /> Refresh
        </button>
      }
    >
      {error && <p className="inline-warning" role="alert">{error}</p>}
      {notice && <p role="status" className="muted-copy">{notice}</p>}
      {loading && !requests && <p className="muted-copy" role="status">Loading access requests…</p>}
      {requests && requests.length === 0 && !loading && (
        <div className="audit-empty-state" role="status">
          <Inbox size={20} />
          <p>No pending access requests.</p>
        </div>
      )}
      {requests && requests.length > 0 && (
        <ul className="model-access-request-list" aria-label="Pending model access requests">
          {requests.map((view) => {
            const requestId = view.request.id;
            const tenantGroups = groups.filter((group) => group.id);
            const options = view.can_grant_new_group ? tenantGroups : tenantGroups.filter((group) => view.eligible_group_ids.includes(group.id));
            const chosen = groupChoice[requestId] ?? view.eligible_group_ids[0] ?? options[0]?.id ?? "";
            const widens = chosen !== "" && !view.eligible_group_ids.includes(chosen);
            return (
              <li key={requestId} className="model-access-request-row">
                <div className="model-access-request-copy">
                  <strong>{view.requester_display_name}</strong>
                  <small>{view.requester_email}</small>
                  <span>
                    Wants <strong>{view.model_name}</strong> ({view.model_provider_name}).
                  </span>
                  <small>Server reason: {view.decision.reason}</small>
                  {view.request.note && <small>Note: “{view.request.note}”</small>}
                </div>
                <div className="model-access-request-actions">
                  <label className="compact-select-field">
                    <span>Grant through group</span>
                    <select
                      aria-label={`Group for ${view.requester_display_name}`}
                      value={chosen}
                      onChange={(event) =>
                        setGroupChoice((current) => ({ ...current, [requestId]: event.target.value }))
                      }
                      disabled={busyId === requestId || options.length === 0}
                    >
                      {options.length === 0 && <option value="">No eligible groups</option>}
                      {options.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                          {view.eligible_group_ids.includes(group.id) ? "" : " (also grant model to group)"}
                        </option>
                      ))}
                    </select>
                  </label>
                  {widens && (
                    <small className="muted-copy">
                      This group does not carry the model yet; approving grants it to everyone in the group.
                    </small>
                  )}
                  <div className="model-access-request-buttons">
                    <button
                      className="primary-button compact"
                      type="button"
                      disabled={busyId === requestId || !chosen}
                      onClick={() => void resolve(view, "approve")}
                    >
                      <Check size={14} /> Approve
                    </button>
                    <button
                      className="secondary-button compact"
                      type="button"
                      disabled={busyId === requestId}
                      onClick={() => void resolve(view, "decline")}
                    >
                      <X size={14} /> Decline
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
