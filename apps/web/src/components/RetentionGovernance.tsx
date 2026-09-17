import { useEffect, useId, useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { RetentionHold, RetentionPreview, RetentionSource, RetentionTaggedThread, TenantRetentionPolicy, TenantRetentionPolicyUpdateRequest } from "../lib/types";
import { createAdminRetentionHold, listAdminRetentionHolds, previewAdminRetentionPolicy, releaseAdminRetentionHold, reviewAdminRetentionTags, scanAdminRetentionSources, updateAdminRetentionPolicy } from "../lib/api/admin";
const PRESETS = [365, 1825, 2555, 3650, 0];
const LABELS = ["1 year", "5 years", "7 years", "10 years", "Forever"];
const errorText = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed.";
export function RetentionGovernance({ actorUserId, policy, onSaved }: {
    actorUserId: string;
    policy: TenantRetentionPolicy;
    onSaved: (policy: TenantRetentionPolicy) => void;
}) {
    const id = useId();
    const [draft, setDraft] = useState<TenantRetentionPolicy>(policy);
    const [days, setDays] = useState(policy.enabled && policy.automation_enabled ? policy.chat_retention_days : 0);
    const [scopedOnly, setScopedOnly] = useState(policy.enabled && policy.automation_enabled && policy.chat_retention_days === 0);
    const [preview, setPreview] = useState<RetentionPreview | null>(null);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const [sourceName, setSourceName] = useState("");
    const [sourceKind, setSourceKind] = useState<RetentionSource["kind"]>("client");
    const [aliases, setAliases] = useState("");
    useEffect(() => { setDraft(policy); setDays(policy.enabled && policy.automation_enabled ? policy.chat_retention_days : 0); setScopedOnly(Boolean(policy.enabled && policy.automation_enabled && policy.chat_retention_days === 0)); setPreview(null); }, [policy]);
    const change = (patch: Partial<TenantRetentionPolicy>) => { setDraft(value => ({ ...value, ...patch })); setPreview(null); setStatus(""); };
    const active = days > 0 || scopedOnly;
    const patch: TenantRetentionPolicyUpdateRequest = { enabled: active, automation_enabled: active, chat_retention_days: scopedOnly ? 0 : days, retention_basis: draft.retention_basis as "created" | "last_activity", grace_days: Math.max(7, draft.grace_days), action: draft.action as "purge" | "archive_then_purge", rules: draft.rules, sources: draft.sources ?? [], sensitive_tagging_enabled: Boolean(draft.sensitive_tagging_enabled) };
    const choose = (value: number) => { setDays(value); setScopedOnly(false); setPreview(null); setStatus(""); };
    async function review() {
        setBusy(true);
        setStatus("");
        try {
            setPreview(await previewAdminRetentionPolicy(actorUserId, patch));
        }
        catch (error) {
            setStatus(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    async function save() {
        setBusy(true);
        setStatus("");
        try {
            const saved = await updateAdminRetentionPolicy(actorUserId, { ...patch, preview_token: preview?.preview_token });
            onSaved(saved);
            setStatus(active ? "Retention policy saved. Existing and future chats use this schedule; legal holds remain protected." : "Forever saved. Automatic deletion is off for all chats.");
        }
        catch (error) {
            setPreview(null);
            setStatus(errorText(error));
        }
        finally {
            setBusy(false);
        }
    }
    function addSource() {
        if (sourceName.trim().length < 2) {
            setStatus("Enter a source name of at least two characters.");
            return;
        }
        const sourceAliases = aliases.split(",").map(value => value.trim()).filter(Boolean);
        if (sourceAliases.some(value => value.length < 3 || value.length > 160)) {
            setStatus("Aliases must be 3–160 characters long.");
            return;
        }
        change({ sources: [...(draft.sources ?? []), { id: crypto.randomUUID(), kind: sourceKind, name: sourceName.trim(), aliases: sourceAliases }] });
        setSourceName("");
        setAliases("");
    }
    function sourceRule(source: {
        kind: string;
        id: string;
    }, value: string) {
        const rules = draft.rules.filter(rule => !(rule.tag_namespace === source.kind && rule.tag_key === source.id));
        if (value !== "none")
            rules.push({ id: `source-${source.id}`, tag_namespace: source.kind, tag_key: source.id, retention_days: Number(value), action: "purge" });
        change({ rules });
    }
    return <div className="retention-governance">
    <div className="retention-governance-heading"><ShieldCheck size={19}/><div><h3>Chat retention schedule</h3><p>Forever is the default. Set a time limit whenever you are ready.</p></div><span className="retention-mode">{policy.enabled && policy.automation_enabled ? "Active" : "Automatic deletion off"}</span></div>
    <fieldset disabled={busy} className="retention-schedule-fields">
      <label htmlFor={`${id}-duration`}>Keep chats for <strong>{scopedOnly ? "each label’s schedule" : days === 0 ? "Forever" : `${days / 365} years`}</strong></label>
      <input id={`${id}-duration`} className="retention-duration-slider" type="range" min="0" max="4" step="1" aria-valuetext={scopedOnly ? "Only classified chats" : LABELS[PRESETS.indexOf(days)] ?? `${days} days`} value={PRESETS.includes(days) ? PRESETS.indexOf(days) : 4} onChange={event => choose(PRESETS[Number(event.target.value)])}/>
      <div className="retention-preset-labels">{LABELS.map((label, index) => <button type="button" key={label} aria-pressed={!scopedOnly && days === PRESETS[index]} onClick={() => choose(PRESETS[index])}>{label}</button>)}</div>
      <p className="retention-explanation">Changing the schedule recalculates eligibility for existing and future chats. Longer matching rules and legal holds take precedence. Increasing the duration cannot restore deleted chats. One year is 365 days.</p>
      <label className="retention-checkbox"><input type="checkbox" checked={scopedOnly} onChange={event => { setScopedOnly(event.target.checked); setPreview(null); }}/>Apply time limits only to labels with a rule</label>
      {active && <div className="retention-field-grid"><label>Count age from<select value={draft.retention_basis} onChange={event => change({ retention_basis: event.target.value })}><option value="last_activity">Last message change</option><option value="created">Chat creation</option></select></label><label>Review window<select value={Math.max(7, draft.grace_days)} onChange={event => change({ grace_days: Number(event.target.value) })}>{[...new Set([7, 14, 30, Math.max(7, draft.grace_days)])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{value} days</option>)}</select></label></div>}
      <div className="retention-source-section"><h4>Clients, matters, and regulated records</h4><p>Use a stable source for each client or matter. Names and aliases find possible mentions in saved message text. Confirm those suggestions in Tags and holds before they govern retention.</p>
      <div className="retention-field-grid"><label>Source type<select value={sourceKind} onChange={event => setSourceKind(event.target.value as RetentionSource["kind"])}><option value="client">Client</option><option value="matter">Matter</option><option value="regulated">Regulated record category</option></select></label><label>Name or reference<input value={sourceName} maxLength={160} onChange={event => setSourceName(event.target.value)} placeholder="Example: Northwind Industries"/></label></div>
      <label>Aliases, separated by commas<input value={aliases} onChange={event => setAliases(event.target.value)} placeholder="Example: Northwind, Client 1042"/></label><button type="button" className="secondary-button compact" onClick={addSource}>Add source to policy</button>
      {[...(draft.sources ?? []), ...(draft.sensitive_tagging_enabled ? [{ id: "ssn", kind: "sensitive", name: "Social Security number", aliases: [] }, { id: "payment_card", kind: "sensitive", name: "Payment card", aliases: [] }, { id: "email", kind: "sensitive", name: "Email address", aliases: [] }] : [])].map(source => { const rule = draft.rules.find(item => item.tag_namespace === source.kind && item.tag_key === source.id); return <div className="retention-source-row" key={source.id}><div><strong>{source.name}</strong><small>{source.kind}{source.aliases.length ? ` · ${source.aliases.join(", ")}` : ""}</small></div><label>Retention rule<select aria-label={`Retention for ${source.name}`} value={rule ? String(rule.retention_days) : "none"} onChange={event => sourceRule(source, event.target.value)}><option value="none">Use default schedule</option>{PRESETS.map((value, index) => <option key={value} value={value}>{LABELS[index]}</option>)}{rule && !PRESETS.includes(rule.retention_days) && <option value={rule.retention_days}>{rule.retention_days} days</option>}</select></label></div>; })}
      <label className="retention-checkbox"><input type="checkbox" checked={Boolean(draft.sensitive_tagging_enabled)} onChange={event => change({ sensitive_tagging_enabled: event.target.checked })}/>Suggest sensitive-data labels</label><p className="retention-explanation">Checks saved text for email addresses, possible Social Security numbers, and payment card numbers. Suggestions can miss information or be incorrect. They do not classify all regulated data or inspect original files, exports, or backups. Confirm categories after review; raw sensitive values are never stored in labels.</p>
      </div>
    </fieldset>
    {preview && <div className="retention-impact" role="status"><strong>Effect on {preview.total.toLocaleString()} saved chats</strong><p>{preview.eligible.toLocaleString()} currently old enough · {preview.held.toLocaleString()} on legal hold · {preview.kept.toLocaleString()} without a deletion deadline</p><p>{active ? `Eligible chats enter a review window of at least ${preview.review_days} days before automatic deletion. Saving a changed policy restarts that window.` : "All chats stay stored. No scheduled deletion will run."}</p></div>}
    <div className="retention-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void review()}>Preview effect</button><button type="button" className="primary-button" disabled={busy || (active && !preview)} onClick={() => void save()}>{busy ? "Working…" : active ? "Save retention policy" : "Save Forever"}</button></div>
    {status && <p role="status">{status}</p>}
  </div>;
}
export function RetentionTagActions({ actorUserId, policy, selected, rows, onRefresh }: {
    actorUserId: string;
    policy: TenantRetentionPolicy | null;
    selected: string[];
    rows: RetentionTaggedThread[];
    onRefresh: () => void;
}) {
    const [target, setTarget] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [holdName, setHoldName] = useState("");
    const [holds, setHolds] = useState<RetentionHold[]>([]);
    const [releasing, setReleasing] = useState<string | null>(null);
    const choices = new Map<string, string>();
    for (const source of policy?.sources ?? [])
        choices.set(`${source.kind}:${source.id}`, `${source.kind}: ${source.name}`);
    for (const row of rows) {
        if (row.matter_id)
            choices.set(`matter:${row.matter_id}`, `matter: ${row.matter_label ?? row.matter_id}`);
        for (const tag of row.tags) {
            const ns = tag.namespace.replace(/^suggested_/, "");
            if (["client", "matter", "regulated", "sensitive"].includes(ns))
                choices.set(`${ns}:${tag.key}`, `${ns}: ${tag.value ?? tag.key}`);
        }
    }
    async function run(action: () => Promise<string>) { setBusy(true); setMessage(""); try {
        setMessage(await action());
        onRefresh();
    }
    catch (error) {
        setMessage(errorText(error));
    }
    finally {
        setBusy(false);
    } }
    async function scan() { let after = "", scanned = 0, suggestions = 0; do {
        const result = await scanAdminRetentionSources(actorUserId, after);
        scanned += result.scanned;
        suggestions += result.suggestions;
        setMessage(`Reviewed ${scanned} chats…`);
        after = result.next_after ?? "";
    } while (after); return `Reviewed ${scanned} saved chats; ${suggestions} new suggestions. No chats were deleted.`; }
    async function tag(action: "confirm" | "remove") { const [namespace, key] = target.split(":"); let reviewed = 0; for (let i = 0; i < selected.length; i += 500) {
        reviewed += (await reviewAdminRetentionTags(actorUserId, { thread_ids: selected.slice(i, i + 500), namespace, key, action })).reviewed;
    } return `${action === "confirm" ? "Confirmed" : "Removed or dismissed"} the label on ${reviewed} chats.`; }
    return <div className="retention-tag-management"><p>Suggested labels need review. Confirm a client, matter, or record category on selected chats, or dismiss an incorrect match.</p><div className="retention-actions"><button type="button" className="secondary-button compact" disabled={busy} onClick={() => void run(scan)}>Scan existing chats</button><select aria-label="Retention label to apply" value={target} onChange={event => setTarget(event.target.value)}><option value="">Choose a label</option>{[...choices].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button type="button" className="secondary-button compact" disabled={busy || !selected.length || !target} onClick={() => void run(() => tag("confirm"))}>Confirm label</button><button type="button" className="secondary-button compact" disabled={busy || !selected.length || !target} onClick={() => void run(() => tag("remove"))}>Remove / dismiss label</button></div>
    <details><summary>Legal holds</summary><div className="retention-hold-content"><p>A hold protects the selected chats from deletion until it is released. It covers this selection; for ongoing client preservation, also set that source’s rule to Forever.</p><label>Hold name<input value={holdName} maxLength={160} onChange={event => setHoldName(event.target.value)}/></label><div className="retention-actions"><button type="button" className="secondary-button compact" disabled={busy || !selected.length || selected.length > 500 || holdName.trim().length < 3} onClick={() => void run(async () => { const result = await createAdminRetentionHold(actorUserId, { thread_ids: selected, name: holdName.trim(), reason: "Administrator applied from the retention console" }); return `Legal hold protects ${result.held} selected chats.`; })}>Hold selected chats</button><button type="button" className="secondary-button compact" disabled={busy} onClick={() => void run(async () => { const current = await listAdminRetentionHolds(actorUserId); setHolds(current); return `${current.length} active holds.`; })}>Load active holds</button></div>{holds.map(hold => <div className="retention-source-row" key={hold.id}><strong>{hold.name}</strong>{releasing === hold.id ? <><span>Release this hold? Retention may apply after a new review window.</span><button className="secondary-button compact" disabled={busy} onClick={() => void run(async () => { await releaseAdminRetentionHold(actorUserId, hold.id); setHolds(items => items.filter(item => item.id !== hold.id)); setReleasing(null); return "Hold released."; })}>Confirm release</button><button className="secondary-button compact" onClick={() => setReleasing(null)}>Cancel</button></> : <button className="secondary-button compact" onClick={() => setReleasing(hold.id)}>Release hold</button>}</div>)}</div></details>
    {message && <p role="status">{message}</p>}
  </div>;
}
