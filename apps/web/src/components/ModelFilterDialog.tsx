import { FlaskConical, Pencil, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type {
  AdminContentFilterCreateRequest,
  AdminContentFilterUpdateRequest,
  ContentFilter,
  ContentFilterPreviewResult,
  ContentFilterRule,
  ModelConfig,
} from "../lib/types";
import { Pill, StableLabel, Toggle } from "./Primitives";
import { SelectControl } from "./SelectControl";

/* Per-model content-filter configuration. Filters are declarative regex rule
 * sets enforced server-side in the chat pipeline: "block" refuses the request
 * or withholds the output, "redact" rewrites matches before they cross the
 * platform boundary. Presets ship read-only; admins author custom filters
 * here and can dry-run rules against sample text before saving. */

export type ModelFilterDialogApi = {
  listFilters: () => Promise<ContentFilter[]>;
  createFilter: (payload: AdminContentFilterCreateRequest) => Promise<ContentFilter>;
  updateFilter: (filterId: string, payload: AdminContentFilterUpdateRequest) => Promise<ContentFilter>;
  deleteFilter: (filterId: string) => Promise<void>;
  previewFilter: (rules: ContentFilterRule[], sample: string) => Promise<ContentFilterPreviewResult>;
  setModelFilters: (modelId: string, filterIds: string[]) => Promise<ModelConfig>;
};

type EditorRule = ContentFilterRule & { key: string };

type EditorState = {
  filterId: string | null; // null = creating
  name: string;
  description: string;
  rules: EditorRule[];
};

let ruleKeyCounter = 0;
function nextRuleKey(): string {
  ruleKeyCounter += 1;
  return `rule-key-${ruleKeyCounter}`;
}

function blankRule(): EditorRule {
  return { key: nextRuleKey(), id: "", label: "", pattern: "", action: "redact", applies_to: "input" };
}

function editorFromFilter(filter: ContentFilter | null): EditorState {
  if (!filter) {
    return { filterId: null, name: "", description: "", rules: [blankRule()] };
  }
  return {
    filterId: filter.id,
    name: filter.name,
    description: filter.description,
    rules: filter.rules.map((rule) => ({ ...rule, key: nextRuleKey() })),
  };
}

function slugifyRuleId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const SCOPE_LABELS: Record<ContentFilterRule["applies_to"], string> = {
  input: "User input",
  output: "Model output",
  both: "Input and output",
};

export function ModelFilterDialog({
  model,
  api,
  onClose,
  onModelUpdated,
}: {
  model: ModelConfig;
  api: ModelFilterDialogApi;
  onClose: () => void;
  onModelUpdated: (model: ModelConfig) => void;
}) {
  const titleId = useId();
  const [filters, setFilters] = useState<ContentFilter[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attachedIds, setAttachedIds] = useState<string[]>(model.content_filter_ids ?? []);
  const [pendingFilterId, setPendingFilterId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testSample, setTestSample] = useState("");
  const [testResult, setTestResult] = useState<ContentFilterPreviewResult | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listFilters()
      .then((loaded) => {
        if (!cancelled) setFilters(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Filters could not load.");
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function toggleFilter(filter: ContentFilter, next: boolean) {
    const nextIds = next ? [...attachedIds, filter.id] : attachedIds.filter((id) => id !== filter.id);
    setPendingFilterId(filter.id);
    setStatusMessage(null);
    try {
      const updated = await api.setModelFilters(model.id, nextIds);
      setAttachedIds(updated.content_filter_ids ?? nextIds);
      onModelUpdated(updated);
      setStatusMessage(
        next ? `${filter.name} is now enforced on ${model.name}.` : `${filter.name} removed from ${model.name}.`,
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "The filter assignment did not save.");
    } finally {
      setPendingFilterId(null);
    }
  }

  function openEditor(filter: ContentFilter | null) {
    setEditor(editorFromFilter(filter));
    setEditorError(null);
    setTestResult(null);
  }

  function updateEditorRule(key: string, patch: Partial<ContentFilterRule>) {
    setEditor((current) =>
      current
        ? {
            ...current,
            rules: current.rules.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)),
          }
        : current,
    );
  }

  function editorRulesForApi(state: EditorState): ContentFilterRule[] {
    return state.rules.map(({ key: _key, ...rule }, index) => ({
      ...rule,
      id: rule.id.trim() || slugifyRuleId(rule.label) || `rule-${index + 1}`,
    }));
  }

  async function saveEditor() {
    if (!editor) return;
    setSaving(true);
    setEditorError(null);
    try {
      const rules = editorRulesForApi(editor);
      const saved = editor.filterId
        ? await api.updateFilter(editor.filterId, {
            name: editor.name,
            description: editor.description,
            rules,
          })
        : await api.createFilter({ name: editor.name, description: editor.description, rules });
      setFilters((current) => {
        const existing = current ?? [];
        const replaced = existing.some((item) => item.id === saved.id);
        return replaced ? existing.map((item) => (item.id === saved.id ? saved : item)) : [...existing, saved];
      });
      setEditor(null);
      setStatusMessage(`${saved.name} saved.`);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "The filter did not save.");
    } finally {
      setSaving(false);
    }
  }

  async function removeFilter(filter: ContentFilter) {
    setPendingFilterId(filter.id);
    setStatusMessage(null);
    try {
      await api.deleteFilter(filter.id);
      setFilters((current) => (current ?? []).filter((item) => item.id !== filter.id));
      if (attachedIds.includes(filter.id)) {
        const nextIds = attachedIds.filter((id) => id !== filter.id);
        setAttachedIds(nextIds);
        onModelUpdated({ ...model, content_filter_ids: nextIds });
      }
      setStatusMessage(`${filter.name} deleted.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "The filter could not be deleted.");
    } finally {
      setPendingFilterId(null);
    }
  }

  async function runRuleTest() {
    if (!editor) return;
    setTesting(true);
    setEditorError(null);
    try {
      const result = await api.previewFilter(editorRulesForApi(editor), testSample);
      setTestResult(result);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "The test run failed.");
      setTestResult(null);
    } finally {
      setTesting(false);
    }
  }

  const editorValid =
    editor !== null &&
    editor.name.trim().length > 0 &&
    editor.rules.length > 0 &&
    editor.rules.every((rule) => rule.label.trim() && rule.pattern.trim());

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal model-filter-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <ShieldCheck size={20} />
          </span>
          <div>
            <h2 id={titleId}>Content filters for {model.name}</h2>
            <p>
              Filters run inside the chat pipeline for this model: block rules refuse the request, redact rules
              rewrite matches before they leave the platform. All filters start off.
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close content filter dialog"
            data-tooltip="Close this dialog"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>

        <div className="modal-body model-filter-body">
          {editor === null ? (
            <>
              {statusMessage && (
                <p className="model-filter-status" role="status">
                  {statusMessage}
                </p>
              )}
              {loadError && <p className="connector-config-error">{loadError}</p>}
              {filters === null && !loadError && <p className="model-filter-loading">Loading filters…</p>}
              {filters !== null && (
                <div className="model-filter-list">
                  {filters.map((filter) => {
                    const attached = attachedIds.includes(filter.id);
                    return (
                      <div className="model-filter-row" key={filter.id}>
                        <span className="model-filter-row-main">
                          <strong>
                            {filter.name}
                            {filter.builtin && <Pill tone="info">Preset</Pill>}
                            {attached && <Pill tone="success">Enforced</Pill>}
                          </strong>
                          <small>
                            {filter.description || "No description."} · {filter.rules.length} rule
                            {filter.rules.length === 1 ? "" : "s"}
                          </small>
                        </span>
                        <span className="row-actions">
                          {!filter.builtin && (
                            <>
                              <button
                                className="icon-button"
                                type="button"
                                aria-label={`Edit ${filter.name}`}
                                data-tooltip={`Edit the rules in ${filter.name}`}
                                onClick={() => openEditor(filter)}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                className="icon-button"
                                type="button"
                                aria-label={`Delete ${filter.name}`}
                                data-tooltip={`Delete ${filter.name} and detach it from every model`}
                                disabled={pendingFilterId === filter.id}
                                onClick={() => void removeFilter(filter)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </>
                          )}
                          <Toggle
                            checked={attached}
                            disabled={pendingFilterId === filter.id}
                            label={`Enforce ${filter.name} on ${model.name}`}
                            tooltip={
                              attached
                                ? `Stop enforcing ${filter.name} on ${model.name}`
                                : `Enforce ${filter.name} on every ${model.name} conversation`
                            }
                            onChange={(next) => void toggleFilter(filter, next)}
                          />
                        </span>
                      </div>
                    );
                  })}
                  {filters.length === 0 && (
                    <p className="model-filter-loading">No filters exist yet. Create the first one below.</p>
                  )}
                </div>
              )}
              <div className="modal-actions">
                <button
                  className="secondary-button"
                  type="button"
                  data-tooltip="Author a custom filter with your own regex rules"
                  onClick={() => openEditor(null)}
                >
                  <Plus size={15} /> New custom filter
                </button>
                <button className="primary-button" type="button" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <div className="model-filter-editor">
              <label className="auth-field model-filter-field">
                <span>Filter name</span>
                <input
                  value={editor.name}
                  placeholder="e.g. Client codenames"
                  onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                />
              </label>
              <label className="auth-field model-filter-field">
                <span>Description</span>
                <input
                  value={editor.description}
                  placeholder="What this filter protects and why"
                  onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                />
              </label>

              <div className="model-filter-rules">
                <strong>Rules</strong>
                <small>
                  Each rule is a Python regular expression. Redact rewrites matches as
                  {" [REDACTED · label]"}; block refuses the whole message.
                </small>
                {editor.rules.map((rule) => (
                  <div className="model-filter-rule-row" key={rule.key}>
                    <input
                      aria-label="Rule label"
                      value={rule.label}
                      placeholder="Label (shown in redactions)"
                      onChange={(event) => updateEditorRule(rule.key, { label: event.target.value })}
                    />
                    <input
                      aria-label="Rule pattern"
                      className="model-filter-pattern"
                      value={rule.pattern}
                      placeholder="Regular expression"
                      spellCheck={false}
                      onChange={(event) => updateEditorRule(rule.key, { pattern: event.target.value })}
                    />
                    <SelectControl
                      aria-label="Rule action"
                      value={rule.action}
                      onChange={(event) =>
                        updateEditorRule(rule.key, { action: event.target.value as ContentFilterRule["action"] })
                      }
                    >
                      <option value="redact">Redact</option>
                      <option value="block">Block</option>
                    </SelectControl>
                    <SelectControl
                      aria-label="Rule scope"
                      value={rule.applies_to}
                      onChange={(event) =>
                        updateEditorRule(rule.key, {
                          applies_to: event.target.value as ContentFilterRule["applies_to"],
                        })
                      }
                    >
                      {Object.entries(SCOPE_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </SelectControl>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label="Remove rule"
                      data-tooltip="Remove this rule"
                      disabled={editor.rules.length === 1}
                      onClick={() =>
                        setEditor({ ...editor, rules: editor.rules.filter((item) => item.key !== rule.key) })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  className="secondary-button compact"
                  type="button"
                  data-tooltip="Add another rule to this filter"
                  onClick={() => setEditor({ ...editor, rules: [...editor.rules, blankRule()] })}
                >
                  <Plus size={14} /> Add rule
                </button>
              </div>

              <div className="model-filter-test">
                <strong>Test against sample text</strong>
                <textarea
                  aria-label="Sample text for rule testing"
                  value={testSample}
                  rows={3}
                  placeholder="Paste sample text to see what these rules match. Nothing is saved or alerted."
                  onChange={(event) => setTestSample(event.target.value)}
                />
                <div className="model-filter-test-actions">
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={!editorValid || !testSample.trim() || testing}
                    data-tooltip="Dry-run these rules on the server against the sample"
                    onClick={() => void runRuleTest()}
                  >
                    <FlaskConical size={14} /> {testing ? "Testing…" : "Test rules"}
                  </button>
                </div>
                {testResult && (
                  <div className="model-filter-test-result" role="status">
                    {testResult.matches.length === 0 ? (
                      <p>No rule matched the sample.</p>
                    ) : (
                      <>
                        <p>
                          {testResult.would_block
                            ? "This sample would be blocked."
                            : "This sample would be redacted."}
                        </p>
                        <ul>
                          {testResult.matches.map((match) => (
                            <li key={match.rule_id}>
                              <strong>{match.label}</strong> ({match.action}) — {match.match_count} match
                              {match.match_count === 1 ? "" : "es"}
                            </li>
                          ))}
                        </ul>
                        <pre className="model-filter-test-sample">{testResult.redacted_sample}</pre>
                      </>
                    )}
                  </div>
                )}
              </div>

              {editorError && <p className="connector-config-error">{editorError}</p>}
              <div className="modal-actions">
                <button className="secondary-button" type="button" onClick={() => setEditor(null)}>
                  Back to filters
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={!editorValid || saving}
                  data-tooltip="Save this filter for the whole tenant"
                  onClick={() => void saveEditor()}
                >
                  <StableLabel
                    label={saving ? "Saving…" : editor.filterId ? "Save changes" : "Create filter"}
                    reserve={["Saving…", "Save changes", "Create filter"]}
                  />
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
