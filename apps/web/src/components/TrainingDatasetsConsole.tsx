import {
  Archive,
  ArchiveRestore,
  BarChart3,
  Briefcase,
  Check,
  Database,
  Download,
  Layers,
  ListChecks,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Scale,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Undo2,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createTrainingDataset,
  deleteTrainingDataset,
  downloadTrainingDataset,
  getTrainingOverview,
  getTrainingPolicy,
  getTrainingTaxonomy,
  listTrainingExamples,
  reviewTrainingExamples,
  scanTrainingChats,
  updateTrainingDataset,
  updateTrainingPolicy,
  type TrainingExampleQuery,
} from "../lib/api/dataProtection";
import { triggerBlobDownload } from "../lib/clipboard";
import type {
  Group,
  ModelConfig,
  TrainingBreakdownItem,
  TrainingCapturePolicy,
  TrainingCapturePolicyUpdateRequest,
  TrainingDataset,
  TrainingDatasetRules,
  TrainingDatasetWriteRequest,
  TrainingExample,
  TrainingExampleStatus,
  TrainingFormat,
  TrainingOverview,
  TrainingSignal,
  TrainingTaxonomy,
} from "../lib/types";
import { useModalFocus } from "../lib/useModalFocus";
import { renderConcealed } from "./ConcealedText";
import { Panel, Pill, Toggle } from "./Primitives";
import { SelectControl } from "./SelectControl";

const PAGE_SIZE = 25;

const FORMAT_DETAILS: Record<TrainingFormat, { label: string; detail: string }> = {
  sft: {
    label: "Supervised fine-tuning",
    detail: "Chat transcripts ending in the answer people approved, or the revised answer after a correction.",
  },
  preference: {
    label: "Preference pairs (DPO)",
    detail: "The original answer as rejected and the revised answer as preferred, from corrections and regenerations.",
  },
  kto: {
    label: "Binary feedback (KTO)",
    detail: "Every judged answer labeled good or bad. Works with thumbs ratings alone.",
  },
};

const SIGNAL_DETAILS: Record<TrainingSignal, { label: string; tone: "success" | "danger" | "info" }> = {
  positive: { label: "Rated helpful", tone: "success" },
  negative: { label: "Rated unhelpful", tone: "danger" },
  correction: { label: "Corrected", tone: "info" },
};

const STATUS_FILTERS: Array<{
  key: TrainingExampleStatus | "all";
  label: string;
}> = [
  { key: "pending", label: "Waiting for review" },
  { key: "approved", label: "Approved" },
  { key: "excluded", label: "Excluded" },
  { key: "all", label: "All" },
];

const EMPTY_RULES: TrainingDatasetRules = {
  signals: [],
  practice_areas: [],
  task_types: [],
  group_ids: [],
  model_ids: [],
};

type EditorState = {
  dataset: TrainingDataset | null;
  draft: TrainingDatasetWriteRequest;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function plural(count: number, word: string) {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

function toggleValue<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** Admin console "Datasets" tab: capture policy, routing, review, and export. */
export function TrainingDatasetsConsole({
  actorUserId,
  groups,
  models,
}: {
  actorUserId: string;
  groups: Group[];
  models: ModelConfig[];
}) {
  const [policy, setPolicy] = useState<TrainingCapturePolicy | null>(null);
  const [overview, setOverview] = useState<TrainingOverview | null>(null);
  const [taxonomy, setTaxonomy] = useState<TrainingTaxonomy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [scan, setScan] = useState<{
    running: boolean;
    scanned: number;
    captured: number;
  } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [downloadTarget, setDownloadTarget] = useState<TrainingDataset | null>(null);
  const [statusFilter, setStatusFilter] = useState<TrainingExampleStatus | "all">("pending");
  const [signalFilter, setSignalFilter] = useState<TrainingSignal | "all">("all");
  const [datasetFilter, setDatasetFilter] = useState<string>("all");
  const [practiceFilter, setPracticeFilter] = useState<string>("all");
  const [examples, setExamples] = useState<{
    total: number;
    items: TrainingExample[];
  } | null>(null);
  const [examplesLoading, setExamplesLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const reviewPanelRef = useRef<HTMLDivElement>(null);

  const tenantGroups = useMemo(() => groups.filter((group) => !group.default_group), [groups]);
  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);
  const modelNames = useMemo(() => new Map(models.map((model) => [model.id, model.name])), [models]);
  const practiceLabels = useMemo(
    () => new Map((taxonomy?.practice_areas ?? []).map((item) => [item.key, item.label])),
    [taxonomy],
  );
  const taskLabels = useMemo(
    () => new Map((taxonomy?.task_types ?? []).map((item) => [item.key, item.label])),
    [taxonomy],
  );
  const datasets = useMemo(() => overview?.datasets ?? [], [overview]);
  const datasetNames = useMemo(() => new Map(datasets.map((dataset) => [dataset.id, dataset.name])), [datasets]);

  const practiceLabel = useCallback(
    (key: string) => (key ? (practiceLabels.get(key) ?? key) : "Unclassified"),
    [practiceLabels],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([getTrainingPolicy(actorUserId), getTrainingTaxonomy(actorUserId)])
      .then(([loadedPolicy, loadedTaxonomy]) => {
        if (cancelled) return;
        setPolicy(loadedPolicy);
        setTaxonomy(loadedTaxonomy);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError, "Training data settings could not be loaded."));
      });
    return () => {
      cancelled = true;
    };
  }, [actorUserId]);

  useEffect(() => {
    let cancelled = false;
    getTrainingOverview(actorUserId)
      .then((loaded) => {
        if (!cancelled) setOverview(loaded);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError, "Captured examples could not be loaded."));
      });
    return () => {
      cancelled = true;
    };
  }, [actorUserId, refreshTick]);

  const exampleQuery = useMemo<TrainingExampleQuery>(
    () => ({
      status: statusFilter === "all" ? undefined : statusFilter,
      signal: signalFilter === "all" ? undefined : signalFilter,
      datasetId: datasetFilter !== "all" && datasetFilter !== "unrouted" ? datasetFilter : undefined,
      unrouted: datasetFilter === "unrouted",
      practiceArea: practiceFilter === "all" ? undefined : practiceFilter,
    }),
    [datasetFilter, practiceFilter, signalFilter, statusFilter],
  );

  useEffect(() => {
    let cancelled = false;
    setExamplesLoading(true);
    listTrainingExamples(actorUserId, {
      ...exampleQuery,
      limit: PAGE_SIZE,
      offset: 0,
    })
      .then((loaded) => {
        if (!cancelled) setExamples(loaded);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorMessage(loadError, "Examples could not be loaded."));
      })
      .finally(() => {
        if (!cancelled) setExamplesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actorUserId, exampleQuery, refreshTick]);

  const refresh = () => setRefreshTick((tick) => tick + 1);

  async function savePolicy(patch: TrainingCapturePolicyUpdateRequest) {
    if (savingPolicy) return;
    setSavingPolicy(true);
    setError(null);
    try {
      setPolicy(await updateTrainingPolicy(actorUserId, patch));
    } catch (saveError) {
      setError(errorMessage(saveError, "The setting was not saved."));
    } finally {
      setSavingPolicy(false);
    }
  }

  async function runScan() {
    if (scan?.running) return;
    setError(null);
    setNotice(null);
    let scanned = 0;
    let captured = 0;
    let after = "";
    setScan({ running: true, scanned, captured });
    try {
      // Bounded: one page of chats per request, at most 200 pages per click.
      for (let page = 0; page < 200; page += 1) {
        const result = await scanTrainingChats(actorUserId, after);
        scanned += result.scanned;
        captured += result.captured;
        setScan({ running: true, scanned, captured });
        if (!result.next_after) break;
        after = result.next_after;
      }
      setNotice(`Scanned ${plural(scanned, "chat")} and captured ${plural(captured, "new example")}.`);
    } catch (scanError) {
      setError(errorMessage(scanError, "The scan stopped before it finished."));
    } finally {
      setScan({ running: false, scanned, captured });
      refresh();
    }
  }

  async function review(ids: string[], status: TrainingExampleStatus) {
    if (reviewing || ids.length === 0) return;
    setReviewing(true);
    setError(null);
    try {
      const result = await reviewTrainingExamples(actorUserId, ids, status);
      setNotice(
        `${plural(result.reviewed, "example")} ${
          status === "approved" ? "approved" : status === "excluded" ? "excluded" : "returned to review"
        }.`,
      );
      refresh();
    } catch (reviewError) {
      setError(errorMessage(reviewError, "The review was not saved."));
    } finally {
      setReviewing(false);
    }
  }

  async function loadMore() {
    if (!examples || examplesLoading) return;
    setExamplesLoading(true);
    try {
      const next = await listTrainingExamples(actorUserId, {
        ...exampleQuery,
        limit: PAGE_SIZE,
        offset: examples.items.length,
      });
      setExamples({
        total: next.total,
        items: [...examples.items, ...next.items],
      });
    } catch (loadError) {
      setError(errorMessage(loadError, "More examples could not be loaded."));
    } finally {
      setExamplesLoading(false);
    }
  }

  async function saveDataset(state: EditorState) {
    setError(null);
    const saved = state.dataset
      ? await updateTrainingDataset(actorUserId, state.dataset.id, state.draft)
      : await createTrainingDataset(actorUserId, state.draft);
    setEditor(null);
    setNotice(`${saved.name} ${state.dataset ? "updated" : "created"}.`);
    refresh();
  }

  async function archiveDataset(dataset: TrainingDataset, archived: boolean) {
    setError(null);
    try {
      await updateTrainingDataset(actorUserId, dataset.id, {
        name: dataset.name,
        description: dataset.description,
        format: dataset.format,
        rules: dataset.rules,
        system_prompt: dataset.system_prompt,
        archived,
      });
      refresh();
    } catch (archiveError) {
      setError(errorMessage(archiveError, "The dataset was not updated."));
    }
  }

  async function removeDataset(dataset: TrainingDataset) {
    if (
      !window.confirm(
        `Delete the ${dataset.name} dataset? Its examples stay captured and keep routing to other datasets.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await deleteTrainingDataset(actorUserId, dataset.id);
      setNotice(`${dataset.name} deleted.`);
      if (datasetFilter === dataset.id) setDatasetFilter("all");
      refresh();
    } catch (deleteError) {
      setError(errorMessage(deleteError, "The dataset was not deleted."));
    }
  }

  function showDatasetExamples(dataset: TrainingDataset) {
    setDatasetFilter(dataset.id);
    setStatusFilter("all");
    reviewPanelRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  const enabled = Boolean(policy?.enabled);
  const policyDisabled = savingPolicy || policy === null;
  const pendingShown = (examples?.items ?? []).filter((item) => item.status === "pending").map((item) => item.id);

  return (
    <div className="datasets-console">
      {(error || notice) && (
        <div
          className={error ? "inline-warning datasets-status is-error" : "inline-warning datasets-status"}
          role={error ? "alert" : "status"}
        >
          <Pill tone={error ? "danger" : "success"}>{error ? "Error" : "Done"}</Pill>
          <span>{error ?? notice}</span>
          <button
            className="icon-button"
            type="button"
            aria-label="Dismiss message"
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      <Panel
        className="datasets-capture-panel"
        title={
          <>
            <Database size={18} /> Training Data Capture
          </>
        }
        subtitle="Keep a private, de-identified record of how your people rate and correct answers, so you can fine-tune an open-weight model on your own work later."
        actions={
          policy ? <Pill tone={enabled ? "success" : "neutral"}>{enabled ? "Capturing" : "Off"}</Pill> : undefined
        }
      >
        <div className="datasets-policy-stack">
          <div className="permission-row policy-toggle-row">
            <span>
              <strong>Capture training signals</strong>
              <small>
                {enabled
                  ? "Rated answers and the corrections people make are copied, de-identified, into this organization's training store as chats are saved."
                  : "Nothing is captured. Chats, ratings, and corrections are used only for their normal purpose."}
              </small>
            </span>
            <Toggle
              checked={enabled}
              disabled={policyDisabled}
              label="Capture training signals"
              tooltip="Start or stop capturing de-identified training examples for this organization"
              onChange={(next) => void savePolicy({ enabled: next })}
            />
          </div>
          <div className="datasets-signal-picker" role="group" aria-label="Signals to capture">
            <span className="datasets-field-label">Capture these signals</span>
            <div className="datasets-chip-row">
              <ChipToggle
                pressed={Boolean(policy?.capture_positive)}
                disabled={policyDisabled}
                icon={<ThumbsUp size={13} />}
                onClick={() => void savePolicy({ capture_positive: !policy?.capture_positive })}
              >
                Helpful ratings
              </ChipToggle>
              <ChipToggle
                pressed={Boolean(policy?.capture_negative)}
                disabled={policyDisabled}
                icon={<ThumbsDown size={13} />}
                onClick={() => void savePolicy({ capture_negative: !policy?.capture_negative })}
              >
                Unhelpful ratings and notes
              </ChipToggle>
              <ChipToggle
                pressed={Boolean(policy?.capture_corrections)}
                disabled={policyDisabled}
                icon={<Wand2 size={13} />}
                onClick={() =>
                  void savePolicy({
                    capture_corrections: !policy?.capture_corrections,
                  })
                }
              >
                Corrections and regenerations
              </ChipToggle>
            </div>
          </div>
          <div className="permission-row policy-toggle-row">
            <span>
              <strong>Review before export</strong>
              <small>
                {policy?.require_review
                  ? "New examples wait for an administrator to approve them. Downloads include approved examples only."
                  : "New examples are approved as they are captured. You can still exclude any of them."}
              </small>
            </span>
            <Toggle
              checked={Boolean(policy?.require_review)}
              disabled={policyDisabled}
              label="Review before export"
              tooltip="Require an administrator to approve each example before it can be downloaded"
              onChange={(next) => void savePolicy({ require_review: next })}
            />
          </div>
          <div className="permission-row policy-toggle-row">
            <span>
              <strong>Skip sensitive or regulated chats</strong>
              <small>
                Chats carrying a sensitive or regulated retention tag, confirmed or suggested, are never captured.
              </small>
            </span>
            <Toggle
              checked={Boolean(policy?.exclude_sensitive_chats)}
              disabled={policyDisabled}
              label="Skip sensitive or regulated chats"
              tooltip="Never capture chats tagged sensitive or regulated"
              onChange={(next) => void savePolicy({ exclude_sensitive_chats: next })}
            />
          </div>
          <div className="permission-row policy-toggle-row">
            <span>
              <strong>Conceal people and client names</strong>
              <small>
                Full names of people in this workspace and your configured client and matter names become placeholders.
                Identifiers such as SSNs and account numbers are always concealed.
              </small>
            </span>
            <Toggle
              checked={Boolean(policy?.conceal_names)}
              disabled={policyDisabled}
              label="Conceal people and client names"
              tooltip="Replace workspace people's names and configured client or matter names in captured examples"
              onChange={(next) => void savePolicy({ conceal_names: next })}
            />
          </div>
          {tenantGroups.length > 0 && (
            <div className="datasets-signal-picker" role="group" aria-label="Groups never captured">
              <span className="datasets-field-label">Never capture from these groups</span>
              <div className="datasets-chip-row">
                {tenantGroups.map((group) => {
                  const excluded = Boolean(policy?.excluded_group_ids.includes(group.id));
                  return (
                    <ChipToggle
                      key={group.id}
                      pressed={excluded}
                      disabled={policyDisabled}
                      tone="danger"
                      onClick={() =>
                        void savePolicy({
                          excluded_group_ids: toggleValue(policy?.excluded_group_ids ?? [], group.id),
                        })
                      }
                    >
                      {group.name}
                    </ChipToggle>
                  );
                })}
              </div>
            </div>
          )}
          <div className="datasets-capture-actions">
            <button
              className="secondary-button compact"
              type="button"
              disabled={!enabled || Boolean(scan?.running)}
              data-tooltip={
                enabled
                  ? "Look through chats saved before capture was on and capture their ratings and corrections"
                  : "Turn on capture before scanning existing chats"
              }
              onClick={() => void runScan()}
            >
              <RefreshCw size={14} className={scan?.running ? "spin" : undefined} />
              {scan?.running ? `Scanning… ${plural(scan.scanned, "chat")}` : "Scan existing chats"}
            </button>
            <span className="datasets-capture-hint">
              New chats are captured automatically as they are saved and rated.
            </span>
          </div>
          <div className="policy-callout datasets-zdr-callout">
            <Lock size={15} />
            <span>
              Your model providers keep running under zero data retention: captured examples never go to a provider.
              They stay in this deployment until an administrator downloads a dataset, and every download is audited.
              Examples follow their chat, so deleting a chat or a retention purge removes its examples too.
            </span>
          </div>
        </div>
      </Panel>

      <Panel
        className="datasets-overview-panel"
        title={
          <>
            <BarChart3 size={18} /> Captured Signals
          </>
        }
        subtitle="What has been captured so far, sorted by practice area, kind of work, and department."
        actions={
          <button
            className="secondary-button compact"
            type="button"
            onClick={refresh}
            data-tooltip="Reload captured examples"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        }
      >
        <div className="feedback-summary-grid">
          <div className="feedback-summary-card">
            <span>Captured</span>
            <strong>{(overview?.total ?? 0).toLocaleString()}</strong>
            <small>{plural(overview?.by_signal.correction ?? 0, "correction")}</small>
          </div>
          <div className="feedback-summary-card">
            <span>Waiting for review</span>
            <strong>{(overview?.pending ?? 0).toLocaleString()}</strong>
            <small>{plural(overview?.unrouted ?? 0, "example")} not in any dataset</small>
          </div>
          <div className="feedback-summary-card">
            <span>Approved</span>
            <strong>{(overview?.approved ?? 0).toLocaleString()}</strong>
            <small>{plural(overview?.excluded ?? 0, "example")} excluded</small>
          </div>
          <div className="feedback-summary-card">
            <span>Values de-identified</span>
            <strong>{(overview?.redactions ?? 0).toLocaleString()}</strong>
            <small>Concealed before storage</small>
          </div>
        </div>
        {overview && overview.total > 0 ? (
          <div className="datasets-mix-grid">
            <MixList title="Practice areas" items={overview.by_practice_area} />
            <MixList title="Kinds of work" items={overview.by_task_type} />
            <MixList
              title="Departments"
              items={overview.by_group}
              empty="No department groups on captured examples yet."
            />
          </div>
        ) : (
          <div className="audit-empty-state">
            <Database size={20} />
            <span>
              <strong>No examples captured yet</strong>
              <small>
                {enabled
                  ? "Examples appear here as people rate answers or correct the assistant. Scan existing chats to include earlier work."
                  : "Turn on capture above. Nothing is collected until you do."}
              </small>
            </span>
          </div>
        )}
        {overview && overview.suggestions.length > 0 && (
          <div className="datasets-suggestions">
            <h3 className="privacy-section-title">
              <Sparkles size={15} /> Suggested datasets
            </h3>
            <div className="datasets-suggestion-grid">
              {overview.suggestions.map((suggestion) => (
                <article className="datasets-suggestion" key={suggestion.key}>
                  <div>
                    <strong>{suggestion.name}</strong>
                    <small>{suggestion.reason}</small>
                    <Pill tone="info">{FORMAT_DETAILS[suggestion.format].label}</Pill>
                  </div>
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={() =>
                      setEditor({
                        dataset: null,
                        draft: {
                          name: suggestion.name,
                          description: suggestion.reason,
                          format: suggestion.format,
                          rules: { ...EMPTY_RULES, ...suggestion.rules },
                          system_prompt: "",
                          archived: false,
                        },
                      })
                    }
                  >
                    <Plus size={14} /> Create
                  </button>
                </article>
              ))}
            </div>
          </div>
        )}
      </Panel>

      <Panel
        className="datasets-list-panel"
        title={
          <>
            <Layers size={18} /> Datasets
          </>
        }
        subtitle="Each dataset routes matching examples automatically. One example can feed several datasets."
        actions={
          <button
            className="primary-button compact"
            type="button"
            disabled={!taxonomy}
            onClick={() =>
              setEditor({
                dataset: null,
                draft: {
                  name: "",
                  description: "",
                  format: "sft",
                  rules: EMPTY_RULES,
                  system_prompt: "",
                  archived: false,
                },
              })
            }
          >
            <Plus size={15} /> New dataset
          </button>
        }
      >
        {datasets.length === 0 ? (
          <div className="audit-empty-state">
            <Layers size={20} />
            <span>
              <strong>No datasets yet</strong>
              <small>
                Create one per practice group, department, or kind of work. For example: litigation corrections as
                preference pairs, or approved tax research answers for supervised fine-tuning.
              </small>
            </span>
          </div>
        ) : (
          <div className="datasets-card-grid">
            {datasets.map((dataset) => (
              <article className={dataset.archived ? "datasets-card is-archived" : "datasets-card"} key={dataset.id}>
                <header>
                  <div>
                    <h3>{dataset.name}</h3>
                    <div className="datasets-card-pills">
                      <Pill tone="info">{FORMAT_DETAILS[dataset.format].label}</Pill>
                      {dataset.archived && <Pill tone="neutral">Archived</Pill>}
                    </div>
                  </div>
                </header>
                {dataset.description && <p className="datasets-card-description">{dataset.description}</p>}
                <RuleSummary
                  rules={dataset.rules}
                  practiceLabel={practiceLabel}
                  taskLabels={taskLabels}
                  groupNames={groupNames}
                  modelNames={modelNames}
                />
                <div className="datasets-card-counts">
                  <span>
                    <strong>{dataset.approved_count.toLocaleString()}</strong> approved
                  </span>
                  <span>
                    <strong>{dataset.pending_count.toLocaleString()}</strong> waiting
                  </span>
                </div>
                <footer className="datasets-card-actions">
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={() => showDatasetExamples(dataset)}
                  >
                    <ListChecks size={14} /> Review
                  </button>
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={dataset.example_count === 0}
                    data-tooltip={
                      dataset.example_count === 0
                        ? "No examples match this dataset yet"
                        : "Download this dataset as a ZIP bundle"
                    }
                    onClick={() => setDownloadTarget(dataset)}
                  >
                    <Download size={14} /> Download
                  </button>
                  <span className="datasets-card-icon-actions">
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Edit ${dataset.name}`}
                      data-tooltip="Edit name, format, and routing rules"
                      onClick={() =>
                        setEditor({
                          dataset,
                          draft: {
                            name: dataset.name,
                            description: dataset.description,
                            format: dataset.format,
                            rules: dataset.rules,
                            system_prompt: dataset.system_prompt,
                            archived: dataset.archived,
                          },
                        })
                      }
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={dataset.archived ? `Restore ${dataset.name}` : `Archive ${dataset.name}`}
                      data-tooltip={
                        dataset.archived
                          ? "Restore this dataset so it routes examples again"
                          : "Archive: stop routing examples here"
                      }
                      onClick={() => void archiveDataset(dataset, !dataset.archived)}
                    >
                      {dataset.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                    </button>
                    <button
                      className="icon-button danger-icon-button"
                      type="button"
                      aria-label={`Delete ${dataset.name}`}
                      data-tooltip="Delete this dataset definition; examples stay captured"
                      onClick={() => void removeDataset(dataset)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </span>
                </footer>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <div ref={reviewPanelRef}>
        <Panel
          className="datasets-review-panel"
          title={
            <>
              <ListChecks size={18} /> Review Examples
            </>
          }
          subtitle="Every example is shown exactly as it would be exported, already de-identified."
        >
          <div className="datasets-review-toolbar">
            <div className="datasets-segmented" role="group" aria-label="Review state">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  aria-pressed={statusFilter === filter.key}
                  onClick={() => setStatusFilter(filter.key)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <label className="compact-select-field datasets-filter">
              <ThumbsUp size={14} aria-hidden="true" />
              <SelectControl
                aria-label="Filter examples by signal"
                value={signalFilter}
                onChange={(event) => setSignalFilter(event.target.value as TrainingSignal | "all")}
              >
                <option value="all">All signals</option>
                {(Object.keys(SIGNAL_DETAILS) as TrainingSignal[]).map((key) => (
                  <option key={key} value={key}>
                    {SIGNAL_DETAILS[key].label}
                  </option>
                ))}
              </SelectControl>
            </label>
            <label className="compact-select-field datasets-filter">
              <Layers size={14} aria-hidden="true" />
              <SelectControl
                aria-label="Filter examples by dataset"
                value={datasetFilter}
                onChange={(event) => setDatasetFilter(event.target.value)}
              >
                <option value="all">All datasets</option>
                <option value="unrouted">Not in any dataset</option>
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name}
                  </option>
                ))}
              </SelectControl>
            </label>
            <label className="compact-select-field datasets-filter">
              <Scale size={14} aria-hidden="true" />
              <SelectControl
                aria-label="Filter examples by practice area"
                value={practiceFilter}
                onChange={(event) => setPracticeFilter(event.target.value)}
              >
                <option value="all">All practice areas</option>
                <option value="">Unclassified</option>
                {(taxonomy?.practice_areas ?? []).map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </SelectControl>
            </label>
          </div>
          {pendingShown.length > 1 && (
            <div className="datasets-bulk-row">
              <span>{plural(pendingShown.length, "example")} shown are waiting for review.</span>
              <button
                className="secondary-button compact"
                type="button"
                disabled={reviewing}
                onClick={() => void review(pendingShown, "approved")}
              >
                <Check size={14} /> Approve all shown
              </button>
              <button
                className="secondary-button compact"
                type="button"
                disabled={reviewing}
                onClick={() => void review(pendingShown, "excluded")}
              >
                <X size={14} /> Exclude all shown
              </button>
            </div>
          )}
          {examples === null ? (
            <div className="audit-empty-state">
              <ListChecks size={20} />
              <span>
                <strong>Loading examples</strong>
                <small>Reading captured examples for this organization.</small>
              </span>
            </div>
          ) : examples.items.length === 0 ? (
            <div className="audit-empty-state">
              <ListChecks size={20} />
              <span>
                <strong>No examples match these filters</strong>
                <small>Change the review state or filters to see other examples.</small>
              </span>
            </div>
          ) : (
            <div className="datasets-example-list">
              {examples.items.map((example) => (
                <ExampleCard
                  key={example.id}
                  example={example}
                  busy={reviewing}
                  practiceLabel={practiceLabel}
                  taskLabel={(key) => taskLabels.get(key) ?? key}
                  groupNames={groupNames}
                  datasetNames={datasetNames}
                  modelName={(id) => modelNames.get(id) ?? id}
                  onReview={(status) => void review([example.id], status)}
                />
              ))}
              {examples.items.length < examples.total && (
                <button
                  className="secondary-button datasets-load-more"
                  type="button"
                  disabled={examplesLoading}
                  onClick={() => void loadMore()}
                >
                  {examplesLoading
                    ? "Loading…"
                    : `Show more (${(examples.total - examples.items.length).toLocaleString()} left)`}
                </button>
              )}
            </div>
          )}
        </Panel>
      </div>

      {editor && taxonomy && (
        <DatasetEditorDialog
          state={editor}
          taxonomy={taxonomy}
          groups={tenantGroups}
          models={models}
          onClose={() => setEditor(null)}
          onSave={saveDataset}
        />
      )}
      {downloadTarget && (
        <DownloadDialog
          actorUserId={actorUserId}
          dataset={downloadTarget}
          onClose={() => setDownloadTarget(null)}
          onDownloaded={(message) => {
            setDownloadTarget(null);
            setNotice(message);
          }}
        />
      )}
    </div>
  );
}

function ChipToggle({
  pressed,
  disabled,
  onClick,
  icon,
  tone = "teal",
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon?: ReactNode;
  tone?: "teal" | "danger";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`datasets-chip is-${tone}`}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {pressed ? <Check size={13} /> : icon}
      {children}
    </button>
  );
}

function MixList({ title, items, empty }: { title: string; items: TrainingBreakdownItem[]; empty?: string }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <section className="datasets-mix">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="datasets-mix-empty">{empty ?? "Nothing yet."}</p>
      ) : (
        <ul>
          {items.slice(0, 8).map((item) => (
            <li key={item.key || "none"}>
              <span className="datasets-mix-label">{item.label}</span>
              <span className="datasets-mix-count">{item.count.toLocaleString()}</span>
              <span className="datasets-mix-track" aria-hidden="true">
                <span style={{ width: `${Math.max(4, (item.count / max) * 100)}%` }} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RuleSummary({
  rules,
  practiceLabel,
  taskLabels,
  groupNames,
  modelNames,
}: {
  rules: TrainingDatasetRules;
  practiceLabel: (key: string) => string;
  taskLabels: Map<string, string>;
  groupNames: Map<string, string>;
  modelNames: Map<string, string>;
}) {
  const rows: Array<[string, string[]]> = [
    ["Signals", rules.signals.map((key) => SIGNAL_DETAILS[key].label)],
    ["Practice", rules.practice_areas.map(practiceLabel)],
    ["Work", rules.task_types.map((key) => taskLabels.get(key) ?? key)],
    ["Departments", rules.group_ids.map((id) => groupNames.get(id) ?? "Removed group")],
    ["Models", rules.model_ids.map((id) => modelNames.get(id) ?? id)],
  ];
  const active = rows.filter(([, values]) => values.length > 0);
  if (active.length === 0) {
    return <p className="datasets-rule-summary is-open">Routes every captured example its format can use.</p>;
  }
  return (
    <dl className="datasets-rule-summary">
      {active.map(([label, values]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{values.join(", ")}</dd>
        </div>
      ))}
    </dl>
  );
}

function ExampleCard({
  example,
  busy,
  practiceLabel,
  taskLabel,
  groupNames,
  datasetNames,
  modelName,
  onReview,
}: {
  example: TrainingExample;
  busy: boolean;
  practiceLabel: (key: string) => string;
  taskLabel: (key: string) => string;
  groupNames: Map<string, string>;
  datasetNames: Map<string, string>;
  modelName: (id: string) => string;
  onReview: (status: TrainingExampleStatus) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const signal = SIGNAL_DETAILS[example.signal];
  const lastPrompt = [...example.prompt].reverse().find((message) => message.role === "user");
  const earlier = example.prompt.slice(0, example.prompt.length - 1);
  const isCorrection = example.signal === "correction";
  return (
    <article className={`datasets-example is-${example.status}`}>
      <header className="datasets-example-head">
        <div className="datasets-example-pills">
          <Pill tone={signal.tone}>
            {isCorrection && example.correction_kind === "regenerate" ? "Regenerated" : signal.label}
          </Pill>
          <Pill tone="neutral" icon={<Scale size={11} aria-label="Practice area" />}>
            {practiceLabel(example.practice_area)}
          </Pill>
          <Pill tone="neutral" icon={<Briefcase size={11} aria-label="Kind of work" />}>
            {taskLabel(example.task_type)}
          </Pill>
          {example.group_ids.map((id) => (
            <Pill tone="neutral" key={id} icon={<Users size={11} aria-label="Department" />}>
              {groupNames.get(id) ?? "Removed group"}
            </Pill>
          ))}
          {example.redaction_count > 0 && (
            <Pill tone="info" icon={<Lock size={11} />}>
              {plural(example.redaction_count, "value")} concealed
            </Pill>
          )}
        </div>
        <small className="datasets-example-meta">
          {example.user_name} · {formatDate(example.captured_at)} · {modelName(example.model_id)}
          {example.dataset_ids.length > 0
            ? ` · In ${example.dataset_ids.map((id) => datasetNames.get(id) ?? id).join(", ")}`
            : " · Not in any dataset"}
          {example.practice_source === "keywords" ? " · Practice area from keywords" : ""}
        </small>
      </header>

      {expanded &&
        earlier.map((message, index) => (
          <ExampleBlock
            key={index}
            label={message.role === "user" ? "Earlier prompt" : "Earlier answer"}
            tone="context"
          >
            {message.content}
          </ExampleBlock>
        ))}
      {lastPrompt && (
        <ExampleBlock label="Prompt" tone="prompt">
          {lastPrompt.content}
        </ExampleBlock>
      )}
      <ExampleBlock
        label={
          isCorrection ? (example.correction_kind === "regenerate" ? "First answer" : "Original answer") : "Answer"
        }
        tone={isCorrection || example.signal === "negative" ? "rejected" : "chosen"}
        collapsible
      >
        {example.completion}
      </ExampleBlock>
      {example.comment && (
        <ExampleBlock label="Note from the person who rated it" tone="note">
          {example.comment}
        </ExampleBlock>
      )}
      {isCorrection && example.correction && (
        <ExampleBlock label="Correction" tone="note">
          {example.correction}
        </ExampleBlock>
      )}
      {isCorrection && example.revision && (
        <ExampleBlock
          label={example.correction_kind === "regenerate" ? "Kept answer" : "Revised answer"}
          tone={example.revision_accepted ? "chosen" : "context"}
          badge={example.revision_accepted ? "Preferred" : "Not used as preferred"}
          collapsible
        >
          {example.revision}
        </ExampleBlock>
      )}

      <footer className="datasets-example-actions">
        {earlier.length > 0 && (
          <button className="link-button" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Hide earlier context" : `Show earlier context (${earlier.length})`}
          </button>
        )}
        <span className="datasets-example-buttons">
          {example.status !== "approved" && (
            <button
              className="primary-button compact"
              type="button"
              disabled={busy}
              onClick={() => onReview("approved")}
            >
              <Check size={14} /> Approve
            </button>
          )}
          {example.status !== "excluded" && (
            <button
              className="secondary-button compact"
              type="button"
              disabled={busy}
              onClick={() => onReview("excluded")}
            >
              <X size={14} /> Exclude
            </button>
          )}
          {example.status !== "pending" && (
            <button
              className="secondary-button compact"
              type="button"
              disabled={busy}
              onClick={() => onReview("pending")}
            >
              <Undo2 size={14} /> Back to review
            </button>
          )}
        </span>
      </footer>
    </article>
  );
}

function ExampleBlock({
  label,
  tone,
  badge,
  collapsible = false,
  children,
}: {
  label: string;
  tone: "prompt" | "chosen" | "rejected" | "note" | "context";
  badge?: string;
  collapsible?: boolean;
  children: string;
}) {
  const [open, setOpen] = useState(false);
  const long = collapsible && children.length > 600;
  const text = long && !open ? `${children.slice(0, 600).trimEnd()}…` : children;
  return (
    <div className={`datasets-block is-${tone}`}>
      <span className="datasets-block-label">
        {label}
        {badge && <em>{badge}</em>}
      </span>
      <p>{renderConcealed(text, label)}</p>
      {long && (
        <button className="link-button" type="button" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

function DatasetEditorDialog({
  state,
  taxonomy,
  groups,
  models,
  onClose,
  onSave,
}: {
  state: EditorState;
  taxonomy: TrainingTaxonomy;
  groups: Group[];
  models: ModelConfig[];
  onClose: () => void;
  onSave: (state: EditorState) => Promise<void>;
}) {
  const [draft, setDraft] = useState<TrainingDatasetWriteRequest>(state.draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const systemId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus(dialogRef, true, () => {
    if (!saving) onClose();
  });

  const setRules = (patch: Partial<TrainingDatasetRules>) =>
    setDraft((current) => ({
      ...current,
      rules: { ...current.rules, ...patch },
    }));

  async function submit() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ dataset: state.dataset, draft });
    } catch (saveError) {
      setError(errorMessage(saveError, "The dataset was not saved."));
      setSaving(false);
    }
  }

  const primaries = taxonomy.practice_areas.filter((item) => !item.key.includes("/"));

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !saving && onClose()}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="modal datasets-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Layers size={20} />
          </span>
          <div>
            <h2 id={titleId}>{state.dataset ? `Edit ${state.dataset.name}` : "New dataset"}</h2>
            <p>Choose a training format and which examples belong here. Leave a rule empty to accept everything.</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close dataset editor"
            onClick={onClose}
            disabled={saving}
          >
            <X size={17} />
          </button>
        </div>

        <div className="datasets-editor-body">
          <label className="datasets-field" htmlFor={nameId}>
            <span className="datasets-field-label">Name</span>
            <input
              id={nameId}
              value={draft.name}
              maxLength={120}
              placeholder="Litigation corrections"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
            />
          </label>
          <label className="datasets-field" htmlFor={descriptionId}>
            <span className="datasets-field-label">Description</span>
            <textarea
              id={descriptionId}
              rows={2}
              value={draft.description}
              maxLength={1000}
              placeholder="What this dataset teaches, and for whom"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
          </label>

          <fieldset className="datasets-fieldset">
            <legend className="datasets-field-label">Training format</legend>
            <div className="datasets-format-grid">
              {(Object.keys(FORMAT_DETAILS) as TrainingFormat[]).map((format) => (
                <label
                  className={draft.format === format ? "datasets-format is-selected" : "datasets-format"}
                  key={format}
                >
                  <input
                    type="radio"
                    name={`${titleId}-format`}
                    checked={draft.format === format}
                    onChange={() => setDraft((current) => ({ ...current, format }))}
                  />
                  <strong>{FORMAT_DETAILS[format].label}</strong>
                  <small>{FORMAT_DETAILS[format].detail}</small>
                </label>
              ))}
            </div>
          </fieldset>

          <ChipField label="Signals">
            {taxonomy.signals.map((item) => (
              <ChipToggle
                key={item.key}
                pressed={draft.rules.signals.includes(item.key)}
                onClick={() =>
                  setRules({
                    signals: toggleValue(draft.rules.signals, item.key),
                  })
                }
              >
                {item.label}
              </ChipToggle>
            ))}
          </ChipField>
          <ChipField label="Practice areas" hint="A broad area includes its specialties.">
            {primaries.map((primary) => (
              <span
                className={
                  taxonomy.practice_areas.some((item) => item.key.startsWith(`${primary.key}/`))
                    ? "datasets-practice-group has-specialties"
                    : "datasets-practice-group"
                }
                key={primary.key}
              >
                <ChipToggle
                  pressed={draft.rules.practice_areas.includes(primary.key)}
                  onClick={() =>
                    setRules({
                      practice_areas: toggleValue(draft.rules.practice_areas, primary.key),
                    })
                  }
                >
                  {primary.label}
                </ChipToggle>
                {taxonomy.practice_areas
                  .filter((item) => item.key.startsWith(`${primary.key}/`))
                  .map((item) => (
                    <ChipToggle
                      key={item.key}
                      pressed={draft.rules.practice_areas.includes(item.key)}
                      onClick={() =>
                        setRules({
                          practice_areas: toggleValue(draft.rules.practice_areas, item.key),
                        })
                      }
                    >
                      {item.label.split(" · ")[1] ?? item.label}
                    </ChipToggle>
                  ))}
              </span>
            ))}
          </ChipField>
          <ChipField label="Kinds of work">
            {taxonomy.task_types.map((item) => (
              <ChipToggle
                key={item.key}
                pressed={draft.rules.task_types.includes(item.key)}
                onClick={() =>
                  setRules({
                    task_types: toggleValue(draft.rules.task_types, item.key),
                  })
                }
              >
                {item.label}
              </ChipToggle>
            ))}
          </ChipField>
          {groups.length > 0 && (
            <ChipField label="Departments">
              {groups.map((group) => (
                <ChipToggle
                  key={group.id}
                  pressed={draft.rules.group_ids.includes(group.id)}
                  onClick={() =>
                    setRules({
                      group_ids: toggleValue(draft.rules.group_ids, group.id),
                    })
                  }
                >
                  {group.name}
                </ChipToggle>
              ))}
            </ChipField>
          )}
          {models.length > 0 && (
            <ChipField label="Models">
              {models.map((model) => (
                <ChipToggle
                  key={model.id}
                  pressed={draft.rules.model_ids.includes(model.id)}
                  onClick={() =>
                    setRules({
                      model_ids: toggleValue(draft.rules.model_ids, model.id),
                    })
                  }
                >
                  {model.name}
                </ChipToggle>
              ))}
            </ChipField>
          )}
          <label className="datasets-field" htmlFor={systemId}>
            <span className="datasets-field-label">System prompt for every example (optional)</span>
            <textarea
              id={systemId}
              rows={3}
              value={draft.system_prompt}
              maxLength={4000}
              placeholder="You are an assistant for the litigation group…"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  system_prompt: event.target.value,
                }))
              }
            />
          </label>
          {error && (
            <div className="inline-warning" role="alert">
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="datasets-editor-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={saving || draft.name.trim().length < 2}
            onClick={() => void submit()}
          >
            <Check size={15} /> {saving ? "Saving…" : state.dataset ? "Save changes" : "Create dataset"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ChipField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="datasets-chip-field" role="group" aria-label={label}>
      <span className="datasets-field-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <div className="datasets-chip-row">{children}</div>
    </div>
  );
}

function DownloadDialog({
  actorUserId,
  dataset,
  onClose,
  onDownloaded,
}: {
  actorUserId: string;
  dataset: TrainingDataset;
  onClose: () => void;
  onDownloaded: (message: string) => void;
}) {
  const [includePending, setIncludePending] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus(dialogRef, true, () => {
    if (!downloading) onClose();
  });
  const count = dataset.approved_count + (includePending ? dataset.pending_count : 0);

  async function download() {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const { blob, filename } = await downloadTrainingDataset(actorUserId, dataset.id, includePending);
      triggerBlobDownload(blob, filename);
      onDownloaded(`Downloaded ${dataset.name} (${plural(count, "example")}).`);
    } catch (downloadError) {
      setError(errorMessage(downloadError, "The download did not start."));
      setDownloading(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !downloading && onClose()}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="modal datasets-download-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Download size={20} />
          </span>
          <div>
            <h2 id={titleId}>Download {dataset.name}</h2>
            <p>
              A ZIP with <code>train.jsonl</code> in {FORMAT_DETAILS[dataset.format].label} format, line-aligned labels
              in <code>metadata.jsonl</code>, and a dataset card. No user names or chat ids are included.
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close download dialog"
            onClick={onClose}
            disabled={downloading}
          >
            <X size={17} />
          </button>
        </div>
        <div className="permission-row policy-toggle-row datasets-download-toggle">
          <span>
            <strong>Include examples waiting for review</strong>
            <small>
              {dataset.pending_count > 0
                ? `${plural(dataset.pending_count, "example")} ${dataset.pending_count === 1 ? "has" : "have"} not been approved yet.`
                : "Every matching example has been reviewed."}
            </small>
          </span>
          <Toggle
            checked={includePending}
            disabled={downloading || dataset.pending_count === 0}
            label="Include examples waiting for review"
            onChange={setIncludePending}
          />
        </div>
        <p className="datasets-download-note">
          <Lock size={13} /> This download is recorded in the audit log. Keep the file inside your organization.
        </p>
        {error && (
          <div className="inline-warning" role="alert">
            <span>{error}</span>
          </div>
        )}
        <div className="datasets-editor-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={downloading}>
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={downloading || count === 0}
            onClick={() => void download()}
          >
            <Download size={15} /> {downloading ? "Preparing…" : `Download ${plural(count, "example")}`}
          </button>
        </div>
      </section>
    </div>
  );
}
