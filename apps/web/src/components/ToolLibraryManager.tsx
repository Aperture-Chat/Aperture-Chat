import { FileText, Plus, Save, ServerCog, Trash2, X } from "lucide-react";
import { useState } from "react";
import {
  createAdminPromptTemplate,
  createAdminSkillFile,
  deleteAdminPromptTemplate,
  deleteAdminSkillFile,
  updateAdminPromptTemplate,
  updateAdminSkillFile,
} from "../lib/api";
import type { BootstrapData, PromptTemplate, SkillFile } from "../lib/types";
import { Pill, StableLabel } from "./Primitives";

type LibraryDraft = {
  name: string;
  description: string;
  category: string;
  content: string;
};

type LibraryMode = "template" | "skill";

type LibraryEditorState = {
  mode: LibraryMode;
  itemId: string | null;
  draft: LibraryDraft;
};

export function ToolLibraryManager({
  data,
  mode,
  onDataChange,
}: {
  data: BootstrapData;
  mode: LibraryMode;
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<{
    tone: "success" | "warning";
    message: string;
  } | null>(null);
  const [editor, setEditor] = useState<LibraryEditorState | null>(null);

  function openNew(mode: LibraryMode) {
    setEditor({ mode, itemId: null, draft: defaultDraft(mode) });
    setActionStatus(null);
  }

  function openExisting(item: PromptTemplate | SkillFile) {
    setEditor({
      mode: isSkillFile(item) ? "skill" : "template",
      itemId: item.id,
      draft: draftFromItem(item),
    });
    setActionStatus(null);
  }

  function updateEditorDraft(patch: Partial<LibraryDraft>) {
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, ...patch } } : current,
    );
  }

  async function saveEditor() {
    if (!editor) return;
    const name = editor.draft.name.trim();
    const content = editor.draft.content.trim();
    if (!name || !content) {
      setActionStatus({
        tone: "warning",
        message:
          editor.mode === "template"
            ? "Template name and content are required before saving."
            : "Skill name and content are required before saving.",
      });
      return;
    }

    const pendingKey = `${editor.mode}:${editor.itemId ? "update" : "create"}`;
    setPendingAction(pendingKey);
    try {
      if (editor.mode === "template") {
        await saveTemplate(editor, name, content);
      } else {
        await saveSkill(editor, name, content);
      }
      setEditor(null);
    } finally {
      setPendingAction(null);
    }
  }

  async function saveTemplate(
    currentEditor: LibraryEditorState,
    name: string,
    content: string,
  ) {
    const payload = {
      name,
      description: currentEditor.draft.description.trim(),
      content,
      category: currentEditor.draft.category.trim() || "general",
      variables: extractVariables(content),
      group_ids: [],
      enabled: true,
    };
    try {
      if (currentEditor.itemId) {
        const saved = await updateAdminPromptTemplate(
          data.me.id,
          currentEditor.itemId,
          payload,
        );
        onDataChange((current) => ({
          ...current,
          promptTemplates: current.promptTemplates.map((template) =>
            template.id === saved.id ? saved : template,
          ),
        }));
        setActionStatus({
          tone: "success",
          message: `${saved.name} template updated.`,
        });
      } else {
        const saved = await createAdminPromptTemplate(data.me.id, {
          ...payload,
          id: `template-${Date.now()}`,
        });
        onDataChange((current) => ({
          ...current,
          promptTemplates: [...current.promptTemplates, saved],
        }));
        setActionStatus({
          tone: "success",
          message: `${saved.name} saved to the prompt template library.`,
        });
      }
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `Template was not saved: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  }

  async function saveSkill(
    currentEditor: LibraryEditorState,
    name: string,
    content: string,
  ) {
    const payload = {
      name,
      description: currentEditor.draft.description.trim(),
      content,
      category: currentEditor.draft.category.trim() || "workflow",
      format: "markdown",
      version: "1.0.0",
      group_ids: [],
      enabled: true,
    };
    try {
      if (currentEditor.itemId) {
        const saved = await updateAdminSkillFile(
          data.me.id,
          currentEditor.itemId,
          payload,
        );
        onDataChange((current) => ({
          ...current,
          skillFiles: current.skillFiles.map((skill) =>
            skill.id === saved.id ? saved : skill,
          ),
        }));
        setActionStatus({
          tone: "success",
          message: `${saved.name} skill updated.`,
        });
      } else {
        const saved = await createAdminSkillFile(data.me.id, {
          ...payload,
          id: `skill-${Date.now()}`,
        });
        onDataChange((current) => ({
          ...current,
          skillFiles: [...current.skillFiles, saved],
        }));
        setActionStatus({
          tone: "success",
          message: `${saved.name} saved to the skill file library.`,
        });
      }
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `Skill file was not saved: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    }
  }

  async function deleteTemplate(template: PromptTemplate) {
    if (!window.confirm(`Delete ${template.name}?`)) return;
    setPendingAction(`template:delete:${template.id}`);
    try {
      await deleteAdminPromptTemplate(data.me.id, template.id);
      onDataChange((current) => ({
        ...current,
        promptTemplates: current.promptTemplates.filter(
          (item) => item.id !== template.id,
        ),
        models: current.models.map((model) => ({
          ...model,
          prompt_template_ids: (model.prompt_template_ids ?? []).filter(
            (id) => id !== template.id,
          ),
        })),
        tools: current.tools.map((tool) => ({
          ...tool,
          prompt_templates: (tool.prompt_templates ?? []).filter(
            (id) => id !== template.id,
          ),
        })),
      }));
      setActionStatus({
        tone: "success",
        message: `${template.name} was deleted.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `Template was not deleted: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteSkill(skill: SkillFile) {
    if (!window.confirm(`Delete ${skill.name}?`)) return;
    setPendingAction(`skill:delete:${skill.id}`);
    try {
      await deleteAdminSkillFile(data.me.id, skill.id);
      onDataChange((current) => ({
        ...current,
        skillFiles: current.skillFiles.filter((item) => item.id !== skill.id),
        models: current.models.map((model) => ({
          ...model,
          skill_file_ids: (model.skill_file_ids ?? []).filter(
            (id) => id !== skill.id,
          ),
        })),
        tools: current.tools.map((tool) => ({
          ...tool,
          skill_files: (tool.skill_files ?? []).filter((id) => id !== skill.id),
        })),
      }));
      setActionStatus({
        tone: "success",
        message: `${skill.name} was deleted.`,
      });
    } catch (error) {
      setActionStatus({
        tone: "warning",
        message: `Skill file was not deleted: ${error instanceof Error ? error.message : "unknown error"}`,
      });
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="tool-library-section" aria-label="Reusable tool library">
      {actionStatus && (
        <div className="inline-warning" role="status">
          <Pill tone={actionStatus.tone}>
            {actionStatus.tone === "success" ? "Saved" : "Action"}
          </Pill>
          <span>{actionStatus.message}</span>
        </div>
      )}
      <LibraryCatalog
        mode={mode}
        title={
          mode === "template" ? "Prompt Template Library" : "Skill File Library"
        }
        subtitle={
          mode === "template"
            ? `${data.promptTemplates.length} saved templates`
            : `${data.skillFiles.length} saved skill files`
        }
        items={mode === "template" ? data.promptTemplates : data.skillFiles}
        pendingDeleteId={
          pendingAction?.startsWith(`${mode}:delete:`)
            ? pendingAction.replace(`${mode}:delete:`, "")
            : null
        }
        onNew={() => openNew(mode)}
        onOpen={openExisting}
        onDelete={(item) =>
          mode === "template"
            ? void deleteTemplate(item as PromptTemplate)
            : void deleteSkill(item as SkillFile)
        }
      />
      {editor && (
        <LibraryEditorModal
          editor={editor}
          pending={
            pendingAction ===
            `${editor.mode}:${editor.itemId ? "update" : "create"}`
          }
          onDraftChange={updateEditorDraft}
          onSave={() => void saveEditor()}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

function LibraryCatalog({
  mode,
  title,
  subtitle,
  items,
  pendingDeleteId,
  onNew,
  onOpen,
  onDelete,
}: {
  mode: LibraryMode;
  title: string;
  subtitle: string;
  items: Array<PromptTemplate | SkillFile>;
  pendingDeleteId: string | null;
  onNew: () => void;
  onOpen: (item: PromptTemplate | SkillFile) => void;
  onDelete: (item: PromptTemplate | SkillFile) => void;
}) {
  return (
    <div className="agent-library-workspace">
      <div className="agent-library-toolbar">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <button
          className="primary-button"
          type="button"
          data-tooltip={
            mode === "template"
              ? "Create a reusable prompt with {{variables}} for dynamic values"
              : "Create a reusable skill file that agents can attach for workflows"
          }
          onClick={onNew}
        >
          <Plus size={16} /> {mode === "template" ? "New Prompt" : "New Skill"}
        </button>
      </div>
      <div className="agent-library-list" aria-label={`${title} items`}>
        {items.map((item) => (
          <div className="agent-library-item" key={item.id}>
            <button
              className="agent-library-item-main"
              type="button"
              aria-label={`Open ${item.name}`}
              data-tooltip={`Open ${item.name} to review or edit its content`}
              onClick={() => onOpen(item)}
            >
              <strong>{item.name}</strong>
              <small>
                {item.category}
                {"version" in item ? ` · v${item.version}` : ""}
                {"variables" in item
                  ? ` · ${item.variables.length} ${plural(item.variables.length, "variable")}`
                  : ""}
              </small>
              <p>{item.description || excerpt(item.content)}</p>
            </button>
            <button
              className="danger-button compact-button"
              type="button"
              aria-label={`Delete ${item.name}`}
              data-tooltip={`Permanently delete ${item.name} from the shared library`}
              disabled={pendingDeleteId === item.id}
              onClick={() => onDelete(item)}
            >
              <Trash2 size={15} />{" "}
              <StableLabel
                label={pendingDeleteId === item.id ? "Deleting..." : "Delete"}
                reserve={["Deleting...", "Delete"]}
              />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function LibraryEditorModal({
  editor,
  pending,
  onDraftChange,
  onSave,
  onClose,
}: {
  editor: LibraryEditorState;
  pending: boolean;
  onDraftChange: (patch: Partial<LibraryDraft>) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const variables =
    editor.mode === "template" ? extractVariables(editor.draft.content) : [];
  const title = editor.itemId
    ? `Edit ${editor.draft.name}`
    : editor.mode === "template"
      ? "New Prompt Template"
      : "New Skill File";
  const saveLabel = pending
    ? "Saving..."
    : editor.itemId
      ? "Save Changes"
      : editor.mode === "template"
        ? "Save Prompt"
        : "Save Skill";

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal tool-library-popout"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-library-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            {editor.mode === "template" ? (
              <FileText size={20} />
            ) : (
              <ServerCog size={20} />
            )}
          </span>
          <div>
            <h2 id="tool-library-editor-title">{title}</h2>
            <p>
              {editor.mode === "template"
                ? "Build reusable prompt content with {{variables}} for dynamic values."
                : "Write reusable workflow instructions that agents can attach as skill files."}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close editor"
            data-tooltip="Close the editor and discard any unsaved changes"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="tool-library-editor-form">
            <label>
              Name
              <input
                value={editor.draft.name}
                onChange={(event) =>
                  onDraftChange({ name: event.target.value })
                }
              />
            </label>
            <label>
              Category
              <input
                value={editor.draft.category}
                onChange={(event) =>
                  onDraftChange({ category: event.target.value })
                }
              />
            </label>
            <label className="wide-field">
              Description
              <input
                value={editor.draft.description}
                onChange={(event) =>
                  onDraftChange({ description: event.target.value })
                }
              />
            </label>
            <label className="tool-library-content-field">
              Content
              <textarea
                value={editor.draft.content}
                onChange={(event) =>
                  onDraftChange({ content: event.target.value })
                }
              />
            </label>
          </div>
          {editor.mode === "template" && (
            <div
              className="template-variable-row"
              aria-label="Detected template variables"
            >
              <strong>Variables</strong>
              {variables.length ? (
                variables.map((variable) => (
                  <span key={variable}>{variable}</span>
                ))
              ) : (
                <small>None detected</small>
              )}
            </div>
          )}
        </div>
        <div className="modal-actions">
          <button
            className="secondary-button"
            type="button"
            data-tooltip="Discard your changes and return to the library list"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={pending}
            data-tooltip={
              editor.itemId
                ? "Save your edits so the library keeps the latest version"
                : editor.mode === "template"
                  ? "Add this prompt to the shared template library"
                  : "Add this skill to the shared skill file library"
            }
            onClick={onSave}
          >
            <Save size={16} />{" "}
            <StableLabel
              label={saveLabel}
              reserve={["Saving...", "Save Changes", "Save Prompt", "Save Skill"]}
            />
          </button>
        </div>
      </div>
    </div>
  );
}

function defaultDraft(mode: LibraryMode): LibraryDraft {
  return mode === "template"
    ? {
        name: "New Client Prompt",
        description: "",
        category: "client-communications",
        content:
          "Prepare a client update for {{matter_name}} using {{source_summary}} and flag {{approval_owner}} before sending.",
      }
    : {
        name: "New Workflow Skill",
        description: "",
        category: "legal-workflow",
        content: "# New Workflow Skill\n- Add workflow rules here.",
      };
}

function draftFromItem(item: PromptTemplate | SkillFile): LibraryDraft {
  return {
    name: item.name,
    description: item.description,
    category: item.category,
    content: item.content,
  };
}

function isSkillFile(item: PromptTemplate | SkillFile): item is SkillFile {
  return "format" in item;
}

function extractVariables(content: string): string[] {
  const matches = content.match(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g) ?? [];
  return unique(matches.map((match) => match.replace(/[{}\s]/g, "")));
}

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 120
    ? `${normalized.slice(0, 117)}...`
    : normalized;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
