import { Lock, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { RailSwitch, type RailSwitchOption } from "./RailSwitch";
import { StableLabel } from "./Primitives";
import type { KnowledgeDocumentAccessMode } from "../lib/api";
import type {
  Group,
  KnowledgeDocument,
  KnowledgeDocumentWall,
  KnowledgeDocumentWallOverride,
} from "../lib/types";

type GroupRef = Pick<Group, "id" | "name">;

/** Short badge for a walled document's row; nothing when it has no wall. */
export function WallBadge({ document, groups }: { document: KnowledgeDocument; groups: GroupRef[] }) {
  const wall = document.wall;
  if (!wall) return null;
  if (!wall.group_ids.length) {
    return (
      <span className="ws-badge is-danger knowledge-wall-badge" data-tooltip="Its wall names no group in this workspace, so nobody can find it">
        <ShieldAlert size={12} aria-hidden="true" /> Hidden
      </span>
    );
  }
  return (
    <span className="ws-badge is-warn knowledge-wall-badge" data-tooltip={`Only ${groupNames(wall.group_ids, groups)} can find it`}>
      <Lock size={12} aria-hidden="true" /> Walled
    </span>
  );
}

/**
 * Expanded row content: the file's preserved properties, its ethical wall,
 * and (for people who manage the base) the control to change who can find it.
 */
export function KnowledgeDocumentDetails({
  document,
  groups,
  override,
  canSetWalls,
  canOpenWalls,
  saving,
  onSetAccess,
}: {
  document: KnowledgeDocument;
  groups: GroupRef[];
  override: KnowledgeDocumentWallOverride | undefined;
  canSetWalls: boolean;
  canOpenWalls: boolean;
  saving: boolean;
  onSetAccess: (mode: KnowledgeDocumentAccessMode, groupIds: string[]) => Promise<boolean>;
}) {
  const properties = Object.entries(document.metadata ?? {});
  return (
    <div className="knowledge-document-details">
      <section aria-label={`${document.name} properties`}>
        <span className="ws-section-label">Properties</span>
        {properties.length ? (
          <dl className="knowledge-properties">
            {properties.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="knowledge-details-note">This file carried no properties beyond its name.</p>
        )}
      </section>
      <section aria-label={`Who can find ${document.name}`}>
        <span className="ws-section-label">Who can find it</span>
        <p className="knowledge-details-note">{wallSummary(document, override, groups)}</p>
        {canSetWalls && (
          <AccessEditor
            document={document}
            groups={groups}
            override={override}
            canOpenWalls={canOpenWalls}
            saving={saving}
            onSetAccess={onSetAccess}
          />
        )}
      </section>
    </div>
  );
}

function AccessEditor({
  document,
  groups,
  override,
  canOpenWalls,
  saving,
  onSetAccess,
}: {
  document: KnowledgeDocument;
  groups: GroupRef[];
  override: KnowledgeDocumentWallOverride | undefined;
  canOpenWalls: boolean;
  saving: boolean;
  onSetAccess: (mode: KnowledgeDocumentAccessMode, groupIds: string[]) => Promise<boolean>;
}) {
  const current = currentMode(override);
  const [mode, setMode] = useState<KnowledgeDocumentAccessMode>(current);
  const [groupIds, setGroupIds] = useState<string[]>(() => initialGroupIds(override, document));
  useEffect(() => {
    setMode(current);
    setGroupIds(initialGroupIds(override, document));
  }, [current, document, override]);
  const canSave = !saving && accessChanged(mode, groupIds, current, override) && !(mode === "restricted" && !groupIds.length);
  return (
    <form
      className="knowledge-access-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSetAccess(mode, mode === "restricted" ? groupIds : []);
      }}
    >
      <RailSwitch
        ariaLabel={`Access for ${document.name}`}
        options={accessOptions(canOpenWalls)}
        value={mode}
        onChange={setMode}
      />
      {mode === "restricted" && <GroupChecklist groups={groups} selected={groupIds} onChange={setGroupIds} />}
      <div className="knowledge-form-actions">
        <button className="primary-button compact-button" type="submit" disabled={!canSave}>
          <StableLabel label={saving ? "Saving..." : "Save access"} reserve={["Saving...", "Save access"]} />
        </button>
      </div>
    </form>
  );
}

function GroupChecklist({
  groups,
  selected,
  onChange,
}: {
  groups: GroupRef[];
  selected: string[];
  onChange: (groupIds: string[]) => void;
}) {
  if (!groups.length) {
    return <p className="knowledge-details-note">Create a group first; walls admit members of groups.</p>;
  }
  return (
    <div className="knowledge-group-grid">
      {groups.map((group) => (
        <label key={group.id} className="knowledge-inline-check">
          <input
            type="checkbox"
            checked={selected.includes(group.id)}
            onChange={(event) =>
              onChange(event.target.checked ? [...selected, group.id] : selected.filter((id) => id !== group.id))
            }
          />
          <span>{group.name}</span>
        </label>
      ))}
    </div>
  );
}

function initialGroupIds(
  override: KnowledgeDocumentWallOverride | undefined,
  document: KnowledgeDocument,
): string[] {
  return override?.group_ids ?? document.wall?.group_ids ?? [];
}

function accessOptions(canOpenWalls: boolean): RailSwitchOption<KnowledgeDocumentAccessMode>[] {
  const options: RailSwitchOption<KnowledgeDocumentAccessMode>[] = [
    { value: "metadata", label: "Follow file", tooltip: "Use the wall named in the file's own metadata, if any" },
    { value: "restricted", label: "Limit", tooltip: "Only the groups you choose can find it" },
  ];
  if (canOpenWalls) {
    options.push({ value: "open", label: "Open", tooltip: "Lift any wall: everyone who can use this base can find it" });
  }
  return options;
}

function accessChanged(
  mode: KnowledgeDocumentAccessMode,
  groupIds: string[],
  current: KnowledgeDocumentAccessMode,
  override: KnowledgeDocumentWallOverride | undefined,
): boolean {
  if (mode !== current) return true;
  return mode === "restricted" && groupIds.join("|") !== (override?.group_ids ?? []).join("|");
}

function currentMode(override: KnowledgeDocumentWallOverride | undefined): KnowledgeDocumentAccessMode {
  if (override?.mode === "restricted" || override?.mode === "open") return override.mode;
  return "metadata";
}

export function wallSummary(
  document: KnowledgeDocument,
  override: KnowledgeDocumentWallOverride | undefined,
  groups: GroupRef[],
): string {
  const wall = document.wall;
  if (!wall) {
    return override?.mode === "open"
      ? "An administrator lifted this file's wall. Everyone who can use this knowledge base can find it."
      : "Everyone who can use this knowledge base can find it.";
  }
  return wall.source === "manual" ? manualWallSummary(wall, groups) : metadataWallSummary(wall, groups);
}

function manualWallSummary(wall: KnowledgeDocumentWall, groups: GroupRef[]): string {
  return wall.group_ids.length
    ? `Limited to ${groupNames(wall.group_ids, groups)} by an administrator. Nobody else can find it, administrators included.`
    : "Limited to groups that no longer exist, so nobody can find it.";
}

function metadataWallSummary(wall: KnowledgeDocumentWall, groups: GroupRef[]): string {
  const field = wall.field ? `the file's "${wall.field}" property` : "the file's metadata";
  const unresolved = unresolvedNote(wall.unresolved ?? []);
  if (!wall.group_ids.length) {
    return `Ethical wall from ${field}. It names no group in this workspace, so nobody can find it until the group exists.${unresolved}`;
  }
  return `Ethical wall from ${field}: only ${groupNames(wall.group_ids, groups)} can find it, administrators included.${unresolved}`;
}

function unresolvedNote(values: string[]): string {
  if (!values.length) return "";
  const one = values.length === 1;
  const names = listWords(values.map((value) => `"${value}"`));
  return ` ${names} ${one ? "matches" : "match"} no group, so ${one ? "it admits" : "they admit"} nobody.`;
}

function groupNames(groupIds: string[], groups: GroupRef[]): string {
  return listWords(groupIds.map((id) => groups.find((group) => group.id === id)?.name ?? id));
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
