import type { BootstrapData } from "../lib/types";
import { RailSwitch, type RailSwitchOption } from "./RailSwitch";

/** Who can use a Library item: its owner alone, the whole workspace, or chosen groups. */
export type Audience = "only" | "everyone" | "groups";

export const NO_GROUP_TICKED = "Tick at least one group, or choose Everyone.";

/** The audience a saved item has, from its Only me flag and its group shares. */
export function audienceOf(onlyMe: boolean | undefined, groupIds: string[]): Audience {
  if (onlyMe) return "only";
  return groupIds.length > 0 ? "groups" : "everyone";
}

/** The rail stops, in the same order everywhere: Only me, Everyone, Specific groups. */
export function audienceOptions(owner: string | null, offerOnly: boolean, offerGroups: boolean): RailSwitchOption<Audience>[] {
  return [
    ...(offerOnly ? [{ value: "only" as const, label: owner ? `Only ${owner}` : "Only me" }] : []),
    { value: "everyone", label: "Everyone" },
    ...(offerGroups ? [{ value: "groups" as const, label: "Specific groups" }] : []),
  ];
}

/** The chosen audience as one plain sentence about "this connection", "this prompt", and so on. */
export function audienceSentence(audience: Audience, owner: string | null, noun = "connection"): string {
  if (audience === "only") return `Only ${owner ?? "you"} can use this ${noun}.`;
  if (audience === "everyone") return `Everyone in the workspace can use this ${noun}.`;
  return `Only people in the groups you tick can use this ${noun}.`;
}

/**
 * "Who can use it": a rail with Only me, Everyone, and Specific groups, the
 * choice in words, and the group list while Specific groups is chosen.
 * `owner` is someone else's name when they own the item; `offerOnly` is false
 * for a viewer who may not make it private.
 */
export function AudienceChoice({
  groups,
  audience,
  groupIds,
  owner,
  offerOnly,
  disabled,
  noun,
  onAudience,
  onGroups,
}: {
  groups: BootstrapData["groups"];
  audience: Audience;
  groupIds: string[];
  owner: string | null;
  offerOnly: boolean;
  disabled: boolean;
  noun: string;
  onAudience: (audience: Audience) => void;
  onGroups: (ids: string[]) => void;
}) {
  const picking = audience === "groups";
  const options = audienceOptions(owner, offerOnly, groups.length > 0 || picking);
  return (
    <>
      <RailSwitch ariaLabel="Who can use it" options={options} value={audience} disabled={disabled} onChange={onAudience} />
      <p className="lib-field-static">{audienceSentence(audience, owner, noun)}</p>
      {!offerOnly && <small className="lib-field-hint">Only the person who created this {noun} can make it private.</small>}
      {picking && <GroupChecks groups={groups} selected={groupIds} disabled={disabled} onChange={onGroups} />}
      {picking && groupIds.length === 0 && <small className="lib-field-hint is-warning">{NO_GROUP_TICKED}</small>}
      {groups.length === 0 && (
        <small className="lib-field-hint">No groups are synced yet, so it can&apos;t be shared with specific groups.</small>
      )}
    </>
  );
}

export function GroupChecks({
  groups,
  selected,
  disabled,
  onChange,
}: {
  groups: BootstrapData["groups"];
  selected: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="lib-check-grid">
      {groups.map((group) => (
        <label className="lib-check" key={group.id}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={selected.includes(group.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? Array.from(new Set([...selected, group.id]))
                  : selected.filter((id) => id !== group.id),
              )
            }
          />
          <span>
            <strong>{group.name}</strong>
            <small>
              {group.user_count} {group.user_count === 1 ? "person" : "people"}
            </small>
          </span>
        </label>
      ))}
    </div>
  );
}
