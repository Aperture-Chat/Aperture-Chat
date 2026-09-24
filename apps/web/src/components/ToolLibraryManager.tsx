import {
  AlertTriangle,
  ArrowLeft,
  Blocks,
  CheckCircle2,
  Eye,
  FileText,
  Lock,
  PenLine,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  ChatRequestError,
  createAdminPromptTemplate,
  createAdminSkillFile,
  deleteAdminPromptTemplate,
  deleteAdminSkillFile,
  sendChat,
  updateAdminPromptTemplate,
  updateAdminSkillFile,
} from "../lib/api";
import { preferredModel, usableModels } from "../lib/modelAccess";
import { cleanImprovedPrompt, promptImproverSystemPrompt } from "../lib/promptImprover";
import type { BootstrapData, PromptTemplate, SkillFile } from "../lib/types";
import { OverflowMenu } from "./AgentWorkspaceConsole";
import { StableLabel } from "./Primitives";

type LibraryDraft = {
  name: string;
  description: string;
  category: string;
  content: string;
};

type LibraryMode = "template" | "skill";
type LibraryItem = PromptTemplate | SkillFile;

type LibraryEditorState = {
  itemId: string | null;
  original: LibraryDraft;
  draft: LibraryDraft;
};

/** How much of an attached prompt or skill an agent receives per message.
 * Mirrors PROMPT_LIBRARY_EXCERPT_CHARS in services/api/app/routes/chat.py. */
export const AGENT_ATTACHMENT_CHAR_LIMIT = 4000;

const EMPTY_DRAFT: LibraryDraft = { name: "", description: "", category: "", content: "" };

const COPY = {
  template: {
    plural: "prompts",
    singular: "prompt",
    newLabel: "New prompt",
    searchLabel: "Search prompts",
    backLabel: "All prompts",
    empty: "No shared prompts yet",
    emptyAdmin:
      "Prompts are reusable instructions people insert from the / menu in chat, or attach to an agent. Use {{variable}} for the parts that change each time.",
    emptyUser: "When an administrator adds a shared prompt, it appears here and in the / menu in chat.",
    readOnlyNotice: "Shared prompts are managed by administrators. You can read them here and insert them from the / menu in chat.",
    namePlaceholder: "e.g. Client status update",
    categoryPlaceholder: "e.g. client-communications",
    descriptionPlaceholder: "When to use this prompt",
    contentLabel: "Prompt",
    contentHelp: "The text people insert from the / menu. Use {{variable_name}} for values they fill in.",
    contentPlaceholder:
      "e.g. Draft a status update for {{client_name}} covering {{topic}}. Keep it under 200 words and flag open decisions.",
    defaultCategory: "general",
  },
  skill: {
    plural: "skills",
    singular: "skill",
    newLabel: "New skill",
    searchLabel: "Search skills",
    backLabel: "All skills",
    empty: "No skills yet",
    emptyAdmin:
      "Skills are written instructions — steps, rules, and output formats — that agents follow when the skill is attached to them.",
    emptyUser: "When an administrator adds a skill, it appears here and can be attached to agents.",
    readOnlyNotice: "Skills are managed by administrators. You can read them here.",
    namePlaceholder: "e.g. Citation discipline",
    categoryPlaceholder: "e.g. workflow",
    descriptionPlaceholder: "What this skill makes an agent do",
    contentLabel: "Instructions",
    contentHelp: "Plain language or Markdown. Describe the steps, the rules to follow, and what the output should look like.",
    contentPlaceholder: "# Skill name\n\n1. First step the agent should take\n2. Rules it must follow\n\nOutput format: …",
    defaultCategory: "workflow",
  },
} as const;

export function ToolLibraryManager({
  data,
  mode,
  onDataChange,
}: {
  data: BootstrapData;
  mode: LibraryMode;
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
}) {
  const copy = COPY[mode];
  // The API accepts library writes from administrators only.
  const canEdit = data.me.role === "TENANT_ADMIN" || data.me.role === "PLATFORM_OWNER";
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<{ tone: "success" | "warning"; message: string } | null>(null);
  const [editor, setEditor] = useState<LibraryEditorState | null>(null);
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const improvementModelId = preferredModel(usableModels(data))?.id ?? null;
  const items: LibraryItem[] = mode === "template" ? data.promptTemplates : data.skillFiles;
  const needle = query.trim().toLowerCase();
  const visibleItems = needle
    ? items.filter((item) =>
        [item.name, item.description, item.category, item.content].join(" ").toLowerCase().includes(needle),
      )
    : items;

  useEffect(() => {
    if (!actionStatus || editor) return;
    const timeoutId = window.setTimeout(() => setActionStatus(null), 20_000);
    return () => window.clearTimeout(timeoutId);
  }, [actionStatus, editor]);

  function openNew() {
    setEditor({ itemId: null, original: EMPTY_DRAFT, draft: EMPTY_DRAFT });
    setActionStatus(null);
  }

  function openExisting(item: LibraryItem) {
    const draft = draftFromItem(item);
    setEditor({ itemId: item.id, original: draft, draft });
    setActionStatus(null);
  }

  function closeEditor() {
    if (pendingAction) return;
    if (editor && canEdit && editorDirty(editor) && !window.confirm("Discard your unsaved changes?")) return;
    setEditor(null);
    setActionStatus(null);
  }

  async function saveEditor() {
    if (!editor) return;
    const name = editor.draft.name.trim();
    const content = editor.draft.content.trim();
    if (!name || !content) {
      setActionStatus({ tone: "warning", message: `Add a name and ${copy.contentLabel.toLowerCase()} before saving.` });
      return;
    }
    const pendingKey = `${mode}:${editor.itemId ? "update" : "create"}`;
    setPendingAction(pendingKey);
    setActionStatus(null);
    try {
      const saved = mode === "template" ? await saveTemplate(editor, name, content) : await saveSkill(editor, name, content);
      setEditor(null);
      setActionStatus({ tone: "success", message: `${saved.name} saved.` });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `${savedNoun(mode)} was not saved: ${error instanceof Error ? error.message : "unknown error"}. Your changes are still here; try again.`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function saveTemplate(current: LibraryEditorState, name: string, content: string): Promise<PromptTemplate> {
    const payload = {
      name,
      description: current.draft.description.trim(),
      content,
      category: current.draft.category.trim() || copy.defaultCategory,
      variables: extractVariables(content),
    };
    if (current.itemId) {
      const saved = await updateAdminPromptTemplate(data.me.id, current.itemId, payload);
      onDataChange((state) => ({
        ...state,
        promptTemplates: state.promptTemplates.map((template) => (template.id === saved.id ? saved : template)),
      }));
      return saved;
    }
    const saved = await createAdminPromptTemplate(data.me.id, { ...payload, group_ids: [], enabled: true });
    onDataChange((state) => ({ ...state, promptTemplates: [...state.promptTemplates, saved] }));
    return saved;
  }

  async function saveSkill(current: LibraryEditorState, name: string, content: string): Promise<SkillFile> {
    const payload = {
      name,
      description: current.draft.description.trim(),
      content,
      category: current.draft.category.trim() || copy.defaultCategory,
    };
    if (current.itemId) {
      const saved = await updateAdminSkillFile(data.me.id, current.itemId, payload);
      onDataChange((state) => ({
        ...state,
        skillFiles: state.skillFiles.map((skill) => (skill.id === saved.id ? saved : skill)),
      }));
      return saved;
    }
    const saved = await createAdminSkillFile(data.me.id, {
      ...payload,
      format: "markdown",
      version: "1.0.0",
      group_ids: [],
      enabled: true,
    });
    onDataChange((state) => ({ ...state, skillFiles: [...state.skillFiles, saved] }));
    return saved;
  }

  async function deleteItem(item: LibraryItem) {
    setOpenMenu(null);
    if (!window.confirm(`Delete ${item.name}? Agents that use it lose it. This can't be undone.`)) return;
    setPendingAction(`${mode}:delete:${item.id}`);
    try {
      if (mode === "template") {
        await deleteAdminPromptTemplate(data.me.id, item.id);
        onDataChange((state) => ({
          ...state,
          promptTemplates: state.promptTemplates.filter((template) => template.id !== item.id),
          models: state.models.map((model) => ({
            ...model,
            prompt_template_ids: (model.prompt_template_ids ?? []).filter((id) => id !== item.id),
          })),
          tools: state.tools.map((tool) => ({
            ...tool,
            prompt_templates: (tool.prompt_templates ?? []).filter((id) => id !== item.id),
          })),
        }));
      } else {
        await deleteAdminSkillFile(data.me.id, item.id);
        onDataChange((state) => ({
          ...state,
          skillFiles: state.skillFiles.filter((skill) => skill.id !== item.id),
          models: state.models.map((model) => ({
            ...model,
            skill_file_ids: (model.skill_file_ids ?? []).filter((id) => id !== item.id),
          })),
          tools: state.tools.map((tool) => ({
            ...tool,
            skill_files: (tool.skill_files ?? []).filter((id) => id !== item.id),
          })),
        }));
      }
      if (editor?.itemId === item.id) setEditor(null);
      setActionStatus({ tone: "success", message: `${item.name} was deleted.` });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `${item.name} was not deleted: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  if (editor) {
    const editingItem = editor.itemId ? items.find((item) => item.id === editor.itemId) : undefined;
    return (
      <LibraryItemEditor
        mode={mode}
        editor={editor}
        item={editingItem}
        data={data}
        canEdit={canEdit}
        pending={pendingAction === `${mode}:${editor.itemId ? "update" : "create"}`}
        deleting={Boolean(editingItem && pendingAction === `${mode}:delete:${editingItem.id}`)}
        modelId={improvementModelId}
        error={actionStatus?.tone === "warning" ? actionStatus.message : null}
        openMenu={openMenu}
        setOpenMenu={setOpenMenu}
        onDraftChange={(patch) =>
          setEditor((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))
        }
        onSave={() => void saveEditor()}
        onClose={closeEditor}
        onDelete={() => editingItem && void deleteItem(editingItem)}
      />
    );
  }

  return (
    <div className="tool-library-section" aria-label={`Shared ${copy.plural}`}>
      {actionStatus && (
        <div
          className={`ws-notice ${actionStatus.tone === "success" ? "is-success" : "is-warning"} tool-library-action-status`}
          role="status"
        >
          {actionStatus.tone === "success" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{actionStatus.message}</span>
          <button
            className="icon-button"
            type="button"
            aria-label="Dismiss notification"
            data-tooltip="Clear this message"
            onClick={() => setActionStatus(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {!canEdit && items.length > 0 && (
        <div className="ws-notice" role="note">
          <Lock size={15} />
          <span>{copy.readOnlyNotice}</span>
        </div>
      )}
      {items.length > 0 && (
        <div className="ws-toolbar">
          <label className="ws-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={copy.searchLabel}
              aria-label={copy.searchLabel}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {canEdit && (
            <div className="ws-toolbar-actions">
              <button className="primary-button compact-button" type="button" onClick={openNew}>
                <Plus size={16} /> {copy.newLabel}
              </button>
            </div>
          )}
        </div>
      )}
      {items.length === 0 ? (
        <div className="ws-empty">
          <span className="ws-empty-icon">{mode === "template" ? <FileText size={24} /> : <Blocks size={24} />}</span>
          <h2>{copy.empty}</h2>
          <p>{canEdit ? copy.emptyAdmin : copy.emptyUser}</p>
          {canEdit && (
            <div className="ws-empty-actions">
              <button className="primary-button compact-button" type="button" onClick={openNew}>
                <Plus size={16} /> {copy.newLabel}
              </button>
            </div>
          )}
        </div>
      ) : visibleItems.length === 0 ? (
        <p className="ws-no-results">No {copy.plural} match your search.</p>
      ) : (
        <div className="ws-card-grid" aria-label={`${copy.plural} list`}>
          {visibleItems.map((item) => (
            <LibraryCard
              key={item.id}
              item={item}
              mode={mode}
              data={data}
              canEdit={canEdit}
              deleting={pendingAction === `${mode}:delete:${item.id}`}
              openMenu={openMenu}
              setOpenMenu={setOpenMenu}
              onOpen={() => openExisting(item)}
              onDelete={() => void deleteItem(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function savedNoun(mode: LibraryMode) {
  return mode === "template" ? "The prompt" : "The skill";
}

function LibraryCard({
  item,
  mode,
  data,
  canEdit,
  deleting,
  openMenu,
  setOpenMenu,
  onOpen,
  onDelete,
}: {
  item: LibraryItem;
  mode: LibraryMode;
  data: BootstrapData;
  canEdit: boolean;
  deleting: boolean;
  openMenu: string | null;
  setOpenMenu: (value: string | null) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const updated = formatUpdatedAt(item.updated_at);
  // Counted from the content itself (what the editor shows and a save stores),
  // not from possibly stale stored metadata.
  const variableCount = mode === "template" ? extractVariables(item.content).length : 0;
  const meta = [
    item.category,
    variableCount ? `${variableCount} ${variableCount === 1 ? "variable" : "variables"}` : null,
    "version" in item ? `v${item.version}` : null,
    updated ? `Updated ${updated}` : null,
  ].filter(Boolean);
  const agentLength = agentVisibleLength(item.content);
  return (
    <article className={`ws-card lib-item-card ${item.enabled ? "" : "is-muted"}`} aria-label={item.name}>
      <div className="ws-card-head">
        <span className="ws-card-icon" aria-hidden="true">
          {mode === "template" ? <FileText size={18} /> : <Blocks size={18} />}
        </span>
        <div>
          <h3 className="ws-card-title">{item.name}</h3>
          <p className="ws-card-meta">{meta.join(" · ")}</p>
        </div>
        {!item.enabled && <span className="ws-badge is-muted">Off</span>}
      </div>
      <div className="ws-card-body">
        <p className={`lib-card-desc ${item.description ? "" : "is-excerpt"}`}>{item.description || excerpt(item.content)}</p>
        <ul className="ws-facts" aria-label={`${item.name} details`}>
          <li className="ws-fact">
            <Users size={13} /> {groupSummary(item.group_ids, data)}
          </li>
          {agentLength > AGENT_ATTACHMENT_CHAR_LIMIT && (
            <li className="ws-fact is-warn">
              <AlertTriangle size={13} /> Agents see the first {AGENT_ATTACHMENT_CHAR_LIMIT.toLocaleString()} characters
            </li>
          )}
        </ul>
      </div>
      <div className="ws-card-foot">
        <button className="secondary-button compact-button" type="button" aria-label={`Open ${item.name}`} onClick={onOpen} disabled={deleting}>
          {canEdit ? <PenLine size={15} /> : <Eye size={15} />} {canEdit ? "Edit" : "View"}
        </button>
        <span className="ws-spacer" />
        {canEdit && (
          <OverflowMenu id={`${mode}:${item.id}`} label={`More actions for ${item.name}`} openMenu={openMenu} setOpenMenu={setOpenMenu} up>
            <button type="button" role="menuitem" className="is-danger" disabled={deleting} onClick={onDelete}>
              <Trash2 size={15} /> {deleting ? "Deleting..." : `Delete ${item.name}`}
            </button>
          </OverflowMenu>
        )}
      </div>
    </article>
  );
}

function LibraryItemEditor({
  mode,
  editor,
  item,
  data,
  canEdit,
  pending,
  deleting,
  modelId,
  error,
  openMenu,
  setOpenMenu,
  onDraftChange,
  onSave,
  onClose,
  onDelete,
}: {
  mode: LibraryMode;
  editor: LibraryEditorState;
  item?: LibraryItem;
  data: BootstrapData;
  canEdit: boolean;
  pending: boolean;
  deleting: boolean;
  modelId: string | null;
  error: string | null;
  openMenu: string | null;
  setOpenMenu: (value: string | null) => void;
  onDraftChange: (patch: Partial<LibraryDraft>) => void;
  onSave: () => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const copy = COPY[mode];
  const titleId = useId();
  const contentId = useId();
  const readOnly = !canEdit || pending;
  const { draft } = editor;
  const variables = mode === "template" ? extractVariables(draft.content) : [];
  const agentLength = agentVisibleLength(draft.content);
  const dirty = editorDirty(editor);
  const canSave = canEdit && !pending && Boolean(draft.name.trim()) && Boolean(draft.content.trim()) && (dirty || !editor.itemId);
  const formLabel = editor.itemId ? `${canEdit ? "Edit" : "View"} ${item?.name ?? editor.original.name}` : copy.newLabel;
  const updated = item ? formatUpdatedAt(item.updated_at) : null;
  const [improving, setImproving] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [beforeImprove, setBeforeImprove] = useState<string | null>(null);

  async function improveContent() {
    const prompt = draft.content.trim();
    if (!prompt || !modelId || improving) return;
    setImproveError(null);
    setImproving(true);
    try {
      const reply = await sendChat(data.me.id, {
        model: modelId,
        messages: [
          { role: "system", content: promptImproverSystemPrompt("template") },
          { role: "user", content: `Draft prompt to improve:\n\n${prompt}` },
        ],
        runtime: { surface: "chat", webEnabled: false, citationsEnabled: false, maxCompletionTokens: 2000 },
      });
      const improved = cleanImprovedPrompt(reply.content ?? "");
      if (!improved) throw new ChatRequestError("The model did not return a usable rewrite.");
      setBeforeImprove((current) => current ?? draft.content);
      onDraftChange({ content: improved });
    } catch (nextError) {
      setImproveError(
        nextError instanceof Error && nextError.message
          ? nextError.message
          : "Could not improve this prompt. Check your connection and try again.",
      );
    } finally {
      setImproving(false);
    }
  }

  return (
    <div className="agent-editor-view tools-editor-view">
      <div className="agent-editor-head">
        <button
          className="agent-editor-back"
          type="button"
          aria-label="Close editor"
          data-tooltip={`Return to all ${copy.plural}`}
          disabled={pending}
          onClick={onClose}
        >
          <ArrowLeft size={16} /> {copy.backLabel}
        </button>
        <div className="agent-editor-title">
          <span className="ws-card-icon" aria-hidden="true">
            {mode === "template" ? <FileText size={18} /> : <Blocks size={18} />}
          </span>
          <div>
            <h2 id={titleId}>{editor.itemId ? draft.name.trim() || editor.original.name : copy.newLabel}</h2>
            <p>
              {editor.itemId
                ? [updated ? `Updated ${updated}` : null, groupSummary(item?.group_ids ?? [], data)].filter(Boolean).join(" · ")
                : `Not saved yet. Shared with everyone in the workspace once saved.`}
            </p>
          </div>
        </div>
        <div className="agent-editor-head-actions">
          {item && !item.enabled && <span className="ws-badge is-muted">Off</span>}
          {canEdit && item && (
            <OverflowMenu id={`${mode}:editor`} label={`More actions for ${item.name}`} openMenu={openMenu} setOpenMenu={setOpenMenu}>
              <button type="button" role="menuitem" className="is-danger" disabled={deleting || pending} onClick={onDelete}>
                <Trash2 size={15} /> {deleting ? "Deleting..." : `Delete ${copy.singular}`}
              </button>
            </OverflowMenu>
          )}
        </div>
      </div>

      {error && (
        <div className="ws-notice is-warning" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}
      {!canEdit && (
        <div className="ws-notice" role="note">
          <Lock size={15} />
          <span>{copy.readOnlyNotice}</span>
        </div>
      )}

      <form
        className="agent-editor-card"
        aria-label={formLabel}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) onSave();
        }}
      >
        <div className="tab-content tools-tab">
            <label className="lib-field">
              Name
              <input
                value={draft.name}
                readOnly={readOnly}
                placeholder={copy.namePlaceholder}
                onChange={(event) => onDraftChange({ name: event.target.value })}
              />
            </label>
            <div className="lib-field-row is-wide-second">
              <label className="lib-field">
                Category
                <input
                  value={draft.category}
                  readOnly={readOnly}
                  placeholder={copy.categoryPlaceholder}
                  onChange={(event) => onDraftChange({ category: event.target.value })}
                />
              </label>
              <label className="lib-field">
                Description
                <input
                  value={draft.description}
                  readOnly={readOnly}
                  placeholder={copy.descriptionPlaceholder}
                  onChange={(event) => onDraftChange({ description: event.target.value })}
                />
              </label>
            </div>
            <div className="lib-field">
              <div className="lib-field-label-row">
                <label htmlFor={contentId}>Content</label>
                {mode === "template" && canEdit && (
                  <span className="lib-inline-actions">
                    {beforeImprove !== null && (
                      <button
                        type="button"
                        className="secondary-button compact-button"
                        disabled={improving || pending}
                        onClick={() => {
                          onDraftChange({ content: beforeImprove });
                          setBeforeImprove(null);
                        }}
                      >
                        <Undo2 size={14} /> Restore original
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary-button compact-button"
                      disabled={improving || pending || !draft.content.trim() || !modelId}
                      data-tooltip={
                        modelId
                          ? "Rewrite this prompt with AI, keeping its intent and {{variables}}"
                          : "Connect an available AI model to improve prompts"
                      }
                      onClick={() => void improveContent()}
                    >
                      <Sparkles size={14} />{" "}
                      <StableLabel label={improving ? "Improving..." : "Improve with AI"} reserve={["Improving...", "Improve with AI"]} />
                    </button>
                  </span>
                )}
              </div>
              {improving && (
                // Indeterminate on purpose: the rewrite has no measurable progress.
                <div className="lib-busy-bar" role="progressbar" aria-label="Improving content" />
              )}
              <small className="lib-field-hint">{copy.contentHelp}</small>
              <textarea
                id={contentId}
                className={mode === "skill" ? "lib-code" : undefined}
                rows={12}
                value={draft.content}
                readOnly={readOnly || improving}
                placeholder={copy.contentPlaceholder}
                onChange={(event) => onDraftChange({ content: event.target.value })}
              />
              {improveError && (
                <small className="lib-field-hint is-error" role="alert">
                  {improveError}
                </small>
              )}
              <div className="lib-field-foot">
                <small className={`lib-field-hint ${agentLength > AGENT_ATTACHMENT_CHAR_LIMIT ? "is-warning" : ""}`}>
                  {agentLength > AGENT_ATTACHMENT_CHAR_LIMIT
                    ? `Agents this is attached to only see the first ${AGENT_ATTACHMENT_CHAR_LIMIT.toLocaleString()} characters.`
                    : `When attached to an agent, up to ${AGENT_ATTACHMENT_CHAR_LIMIT.toLocaleString()} characters are included in its instructions.`}
                  {mode === "template" ? " The / menu in chat inserts the full prompt." : ""}
                </small>
                <small className="lib-char-count">
                  {agentLength.toLocaleString()} / {AGENT_ATTACHMENT_CHAR_LIMIT.toLocaleString()}
                </small>
              </div>
            </div>
            {mode === "template" && (
              <div className="lib-field" aria-label="Detected template variables">
                <span>Variables</span>
                {variables.length ? (
                  <ul className="ws-facts">
                    {variables.map((variable) => (
                      <li className="ws-fact" key={variable}>
                        {`{{${variable}}}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <small className="lib-field-hint">None yet. Type {"{{name}}"} in the prompt to add one.</small>
                )}
              </div>
            )}
        </div>
        {canEdit && (
          <div className="agent-editor-foot">
            <span className="agent-editor-foot-note">
              {editor.itemId ? (dirty ? "You have unsaved changes." : "No changes yet.") : "Saved to the shared library for your workspace."}
            </span>
            <span className="ws-spacer" />
            <button className="secondary-button compact-button" type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button compact-button" type="submit" disabled={!canSave}>
              <StableLabel
                label={pending ? "Saving..." : editor.itemId ? "Save changes" : mode === "template" ? "Save prompt" : "Save skill"}
                reserve={["Saving...", "Save changes", "Save prompt", "Save skill"]}
              />
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function draftFromItem(item: LibraryItem): LibraryDraft {
  return {
    name: item.name,
    description: item.description,
    category: item.category,
    content: item.content,
  };
}

function editorDirty(editor: LibraryEditorState): boolean {
  const { draft, original } = editor;
  return (
    draft.name !== original.name ||
    draft.description !== original.description ||
    draft.category !== original.category ||
    draft.content !== original.content
  );
}

function groupSummary(groupIds: string[], data: BootstrapData): string {
  if (!groupIds.length) return "Everyone in the workspace";
  const names = groupIds.map((id) => data.groups.find((group) => group.id === id)?.name ?? "Unknown group");
  return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
}

/** Length as the chat runtime counts it (whitespace runs collapse to one space). */
function agentVisibleLength(content: string): number {
  return content.split(/\s+/).filter(Boolean).join(" ").length;
}

/** Real timestamps render as a date; legacy placeholder strings ("Just now")
 * are not dates, so nothing is shown rather than a made-up time. */
export function formatUpdatedAt(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g) ?? [];
  return Array.from(new Set(matches.map((match) => match.replace(/[{}\s]/g, ""))));
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
