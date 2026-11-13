import { useCallback, useRef, type ComponentProps } from "react";
import type { DraftSlot } from "../lib/draftSlots";
import { DocumentAssistantWorkspace } from "./DocumentAssistantWorkspace";

type WorkspaceProps = ComponentProps<typeof DocumentAssistantWorkspace>;

type KeptDraftWorkspaceProps = Pick<
  WorkspaceProps,
  | "data"
  | "brandName"
  | "actorUserId"
  | "initialDraft"
  | "initialRequest"
  | "onInitialRequestStarted"
  | "onCloseDraft"
  | "onNavigationGuardChange"
> & {
  slot: DraftSlot;
  /** The person is elsewhere in the app: the workspace keeps working, out of
   * sight and out of reach of the keyboard, the pointer and screen readers. */
  parked: boolean;
  onWorkingChange: (slotKey: string, working: boolean) => void;
};

/**
 * One Drafts workspace the app keeps mounted (see lib/draftSlots). On screen
 * it is the workspace as it always was. Parked, it finishes what the
 * assistant is doing and can no longer steer the app: it holds no navigation
 * guard, cannot close itself, and starts no handed-over request.
 */
export function KeptDraftWorkspace({
  slot,
  parked,
  initialDraft,
  initialRequest,
  onCloseDraft,
  onNavigationGuardChange,
  onWorkingChange,
  ...workspace
}: KeptDraftWorkspaceProps) {
  // What a workspace opens with is read once: a later transfer belongs to a
  // newer workspace, never to one already open.
  const openedWith = useRef(initialDraft);
  const reportWorking = useCallback(
    (working: boolean) => onWorkingChange(slot.key, working),
    [onWorkingChange, slot.key],
  );
  return (
    <div className="draft-slot" data-parked={parked ? "true" : undefined} inert={parked} aria-hidden={parked || undefined}>
      <DocumentAssistantWorkspace
        {...workspace}
        parked={parked}
        initialDraft={slot.draftId ? null : openedWith.current}
        initialRequest={parked || slot.draftId ? null : initialRequest}
        initialServerDraftId={slot.draftId}
        onCloseDraft={parked ? undefined : onCloseDraft}
        onNavigationGuardChange={parked ? undefined : onNavigationGuardChange}
        onWorkingChange={reportWorking}
      />
    </div>
  );
}
