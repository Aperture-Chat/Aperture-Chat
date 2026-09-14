import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ChatRequestError, getSearchIndexStatus, rebuildSearchIndex } from "../lib/api";
import type { SearchIndexStatus } from "../lib/types";
import { Panel } from "./Primitives";

/** Owner view of the relational search index: per-tenant readiness and a rebuild. */
export function SearchIndexCard({ actorUserId }: { actorUserId: string }) {
  const [status, setStatus] = useState<SearchIndexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setStatus(await getSearchIndexStatus(actorUserId, { signal }));
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(caught instanceof Error ? caught.message : "Could not load the search index status.");
    }
  }, [actorUserId]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const rebuild = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const next = await rebuildSearchIndex(actorUserId);
      setStatus(next);
      setNotice(`Rebuilt ${next.total_entries} index ${next.total_entries === 1 ? "entry" : "entries"} from live records.`);
    } catch (caught) {
      setNotice(caught instanceof ChatRequestError ? caught.message : "The rebuild did not complete.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      className="search-index-card"
      title="Search index"
      subtitle="Relational index behind Ctrl/⌘ K for chats and drafts. Every hit is re-verified against the live record; the index never grants access."
      actions={
        <button className="secondary-button" type="button" disabled={busy || status?.enabled === false} onClick={() => void rebuild()}>
          <RefreshCw size={16} /> {busy ? "Rebuilding…" : "Rebuild index"}
        </button>
      }
    >
      {error && <p className="inline-warning" role="alert">{error}</p>}
      {notice && <p role="status" className="muted-copy">{notice}</p>}
      {status && !status.enabled && (
        <p className="muted-copy">The index is disabled (APERTURE_SEARCH_INDEX_ENABLED=false); search scans records on every request.</p>
      )}
      {status && status.enabled && (
        <ul className="search-index-tenants" aria-label="Search index by organization">
          {status.tenants.map((tenant) => (
            <li key={tenant.tenant_id}>
              <strong>{tenant.tenant_name}</strong>{" "}
              <span className={`pill ${tenant.ready ? "pill-success" : "pill-warning"}`}>
                {tenant.ready ? "Ready" : "Backfilling"}
              </span>{" "}
              <small className="muted-copy">
                {tenant.entry_count} {tenant.entry_count === 1 ? "entry" : "entries"} · mode {tenant.fts_mode}
                {tenant.backfill_completed_at ? ` · completed ${new Date(tenant.backfill_completed_at).toLocaleString()}` : ""}
              </small>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
