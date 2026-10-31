import clsx from "clsx";
import { Brain, ChevronRight, Eye, KeyRound, Lock, LogOut, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { loadMfaAccountStatus, type MfaAccountStatus } from "../lib/api";
import {
  availablePreviewRoles,
  mfaNeedsRecoveryCodes,
  mfaSummary,
  passwordDraftDirty,
  passwordDraftProblem,
  previewRoleLabel,
  roleLabel,
  type PasswordDraft,
} from "../lib/accountDrawer";
import type {
  AccountApiKeyCreateResponse,
  AccountApiKeyStatus,
  AccountPasswordUpdateRequest,
  AccountProfileUpdateRequest,
  BootstrapData,
  ChatThread,
  Role,
  User,
} from "../lib/types";
import { AccountApiAccess } from "./AccountApiAccess";
import { AccountArchive } from "./AccountArchive";
import { AccountIdentity } from "./AccountProfile";
import {
  AccountAnnouncer,
  AccountRowBody,
  AccountSection,
  EscapeLayersContext,
  UNSAVED_NOTE,
  useAnnounce,
  useFirstFieldFocus,
  useFormEscape,
  useReturnFocus,
  type EscapeLayer,
} from "./AccountRow";
import { AccountSecurity } from "./AccountSecurity";
import { AccountUsage } from "./AccountUsage";
import { RailSwitch, type RailSwitchOption } from "./RailSwitch";

type ConsoleKey = "admin" | "platform";

export type AccountConsole = { key: ConsoleKey; icon: LucideIcon; tooltip: string };

type AccountDrawerProps = {
  data: BootstrapData;
  actualRole: Role;
  viewAsRole: Role | null;
  onViewAsRoleChange: (role: Role | null) => void;
  threads: ChatThread[];
  /** The consoles this role can open; the drawer only lays them out. */
  consoles: AccountConsole[];
  currentView: string;
  onSelectView: (view: ConsoleKey) => void;
  onSecurityCloseGuardChange: (blocked: boolean) => void;
  escapeLayers: EscapeLayer[];
  apiAccessGranted: boolean;
  onApiKeyLoad?: () => Promise<AccountApiKeyStatus>;
  onApiKeyCreate?: (options: { replace: boolean }) => Promise<AccountApiKeyCreateResponse>;
  onApiKeyRevoke?: () => Promise<AccountApiKeyStatus>;
  onProfileUpdate?: (payload: AccountProfileUpdateRequest) => unknown;
  onPasswordUpdate?: (payload: AccountPasswordUpdateRequest) => unknown;
  memoryHint: string | null;
  onOpenMemory?: () => void;
  onRestoreThread: (chatId: string) => void;
  onDeleteThread: (chatId: string) => void;
  onSignOut?: () => void;
  onRequestSignOut?: () => void;
};

/** Everything outside `keep` under `root` goes inert; returns what to restore. */
function makeOutsideInert(root: Element, keep: Element): Element[] {
  const marked: Element[] = [];
  for (let node = keep; node !== root && node.parentElement; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node) continue;
      sibling.setAttribute("inert", "");
      marked.push(sibling);
    }
  }
  return marked;
}

function consoleCopy(key: ConsoleKey, pendingRequests: number) {
  if (key === "platform") {
    return { label: "Platform owner console", description: "Providers, organization policy, and audit" };
  }
  return {
    label: "Admin console",
    description:
      pendingRequests > 0
        ? `${pendingRequests} model access ${pendingRequests === 1 ? "request" : "requests"} waiting`
        : "Users, groups, model access, and connections",
  };
}

function ConsoleRows({
  consoles,
  currentView,
  pendingRequests,
  onSelectView,
}: Pick<AccountDrawerProps, "consoles" | "currentView" | "onSelectView"> & { pendingRequests: number }) {
  return (
    <>
      {consoles.map(({ key, icon, tooltip }) => {
        const isActive = currentView === key;
        const waiting = key === "admin" ? pendingRequests : 0;
        const { label, description } = consoleCopy(key, waiting);
        return (
          <button
            key={key}
            className={clsx("account-row", "is-pressable", isActive && "is-active")}
            type="button"
            aria-current={isActive ? "page" : undefined}
            data-tooltip={tooltip}
            onClick={() => onSelectView(key)}
          >
            <AccountRowBody icon={icon} title={label} detail={description} />
            <span className="account-row-trailing">
              {waiting > 0 && (
                <span className="pill pill-warning" aria-label={`${waiting} pending model access requests`}>
                  {waiting}
                </span>
              )}
              <ChevronRight size={15} aria-hidden="true" />
            </span>
          </button>
        );
      })}
    </>
  );
}

function ViewAsRow({
  actualRole,
  viewAsRole,
  onViewAsRoleChange,
}: Pick<AccountDrawerProps, "actualRole" | "viewAsRole" | "onViewAsRoleChange">) {
  const roles = availablePreviewRoles(actualRole);
  const options: RailSwitchOption<Role>[] = roles.map((role) => ({
    value: role,
    label: previewRoleLabel(role),
    tooltip:
      role === actualRole
        ? "Return to your own role and stop previewing"
        : `Preview the workspace with ${previewRoleLabel(role)} access`,
  }));
  return (
    <div>
      <div className="account-row">
        <AccountRowBody icon={Eye} title="View as" detail="Preview the workspace with another role." />
      </div>
      <div className="account-row-panel">
        <RailSwitch
          block
          ariaLabel="Preview role"
          options={options}
          value={viewAsRole ?? actualRole}
          onChange={(role) => onViewAsRoleChange(role === actualRole ? null : role)}
        />
        {viewAsRole && (
          <small className="account-view-as-note" role="status">
            Previewing {previewRoleLabel(viewAsRole)}. Your account role is {roleLabel(actualRole)}.
          </small>
        )}
      </div>
    </div>
  );
}

function SecurityRow({
  user,
  blocked,
  onGuardChange,
  onSignOut,
}: {
  user: User;
  blocked: boolean;
  onGuardChange: (blocked: boolean) => void;
  onSignOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<MfaAccountStatus | null>(null);
  const panelId = useId();

  useEffect(() => {
    const controller = new AbortController();
    loadMfaAccountStatus(user.id, { signal: controller.signal })
      .then(setStatus)
      .catch(() => {
        // The row keeps its general description; the panel reports real failures.
      });
    return () => controller.abort();
  }, [user.id]);

  const summary = mfaSummary(status, user.auth_method);
  return (
    <div className="account-security-section">
      <div className="account-row">
        <AccountRowBody
          icon={Lock}
          title="Security"
          detail={mfaNeedsRecoveryCodes(status) ? <span className="account-warning">{summary}</span> : summary}
        />
        <button
          className="secondary-button"
          type="button"
          aria-label={open ? "Close security" : "Manage security"}
          aria-expanded={open}
          aria-controls={panelId}
          data-tooltip={open ? "Close the security panel" : "Set up or change two-step verification and recovery codes"}
          disabled={blocked}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Close" : "Manage"}
        </button>
      </div>
      {open && (
        <div id={panelId} className="account-row-panel">
          {blocked && (
            <p className="account-security-guard-note" role="status">
              Finish verification or save your recovery codes before leaving this panel.
            </p>
          )}
          <AccountSecurity user={user} onSignOut={onSignOut} onCloseGuardChange={onGuardChange} onStatusChange={setStatus} />
        </div>
      )}
    </div>
  );
}

const EMPTY_PASSWORD_DRAFT: PasswordDraft = { currentPassword: "", newPassword: "", confirmPassword: "" };

function PasswordForm({
  id,
  onPasswordUpdate,
  onSaved,
  onCancel,
}: {
  id: string;
  onPasswordUpdate: (payload: AccountPasswordUpdateRequest) => unknown;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<PasswordDraft>(EMPTY_PASSWORD_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formRef = useFirstFieldFocus<HTMLFormElement>();
  const heldByEscape = useFormEscape(!saving, passwordDraftDirty(draft), onCancel);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = passwordDraftProblem(draft);
    setError(problem);
    if (problem) return;
    setSaving(true);
    try {
      await onPasswordUpdate({ current_password: draft.currentPassword, new_password: draft.newPassword });
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update password.");
      setSaving(false);
    }
  };

  const field = (name: keyof PasswordDraft, label: string, autoComplete: string, placeholder?: string): ReactNode => (
    <label htmlFor={`${formId}-${name}`}>
      {label}
      <input
        id={`${formId}-${name}`}
        type="password"
        autoComplete={autoComplete}
        value={draft[name]}
        placeholder={placeholder}
        onChange={(event) => {
          const { value } = event.target;
          setDraft((current) => ({ ...current, [name]: value }));
        }}
      />
    </label>
  );

  return (
    <form
      ref={formRef}
      id={id}
      className="account-row-panel account-form"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      {field("currentPassword", "Current password", "current-password")}
      {field("newPassword", "New password", "new-password", "At least 12 characters")}
      {field("confirmPassword", "Confirm new password", "new-password")}
      {error && <small className="drawer-error" role="alert">{error}</small>}
      {heldByEscape && <small className="account-panel-note" role="status">{UNSAVED_NOTE}</small>}
      <div className="drawer-form-actions">
        <button className="secondary-button" type="button" data-tooltip="Close the password form and keep your current password" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary-button" type="submit" disabled={saving} data-tooltip="Replace your current password with the new one">
          {saving ? "Updating…" : "Update password"}
        </button>
      </div>
    </form>
  );
}

function PasswordRow({
  onPasswordUpdate,
}: {
  onPasswordUpdate?: (payload: AccountPasswordUpdateRequest) => unknown;
}) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const formId = useId();
  const { returnTo, target } = useReturnFocus();
  const announce = useAnnounce();

  const close = () => {
    returnTo("change");
    setEditing(false);
  };

  return (
    <div>
      <div className="account-row">
        <AccountRowBody icon={KeyRound} title="Password" detail={saved ? "Password updated." : "Used with your email to sign in"} />
        <button
          ref={target("change")}
          className="secondary-button"
          type="button"
          aria-label={editing ? "Close password form" : "Change password"}
          aria-expanded={editing}
          aria-controls={formId}
          data-tooltip={editing ? "Close the password form without making changes" : "Open the form to set a new account password"}
          disabled={!onPasswordUpdate}
          onClick={() => {
            setSaved(false);
            setEditing((current) => !current);
          }}
        >
          {editing ? "Close" : "Change"}
        </button>
      </div>
      {editing && onPasswordUpdate && (
        <PasswordForm
          id={formId}
          onPasswordUpdate={onPasswordUpdate}
          onCancel={close}
          onSaved={() => {
            close();
            setSaved(true);
            announce("Password updated.");
          }}
        />
      )}
    </div>
  );
}

function WorkspaceSection({
  consoles,
  currentView,
  pendingRequests,
  onSelectView,
  actualRole,
  viewAsRole,
  onViewAsRoleChange,
}: Pick<AccountDrawerProps, "consoles" | "currentView" | "onSelectView" | "actualRole" | "viewAsRole" | "onViewAsRoleChange"> & {
  pendingRequests: number;
}) {
  const showViewAs = availablePreviewRoles(actualRole).length > 1;
  if (consoles.length === 0 && !showViewAs) return null;
  return (
    <AccountSection title="Workspace">
      <div className="account-slab">
        <ConsoleRows consoles={consoles} currentView={currentView} pendingRequests={pendingRequests} onSelectView={onSelectView} />
        {showViewAs && <ViewAsRow actualRole={actualRole} viewAsRole={viewAsRole} onViewAsRoleChange={onViewAsRoleChange} />}
      </div>
    </AccountSection>
  );
}

function MemoryRow({ hint, onOpen }: { hint: string; onOpen: () => void }) {
  return (
    <button
      className="account-row is-pressable"
      type="button"
      data-tooltip="Review, correct, or delete what the assistant remembers about you"
      onClick={onOpen}
    >
      <AccountRowBody icon={Brain} title="Personalization memory" detail={hint} />
      <span className="account-row-trailing">
        <ChevronRight size={15} aria-hidden="true" />
      </span>
    </button>
  );
}

/** Two things hold the drawer open: a security flow, which also locks the rest of
 * the drawer, and a key or delete request, whose result must reach the screen. */
function useExitGuard(onChange: (blocked: boolean) => void) {
  const report = useRef(onChange);
  report.current = onChange;
  const flow = useRef(false);
  const mutation = useRef(false);
  const [flowBlocked, setFlowBlocked] = useState(false);
  const onFlowChange = useCallback((blocked: boolean) => {
    flow.current = blocked;
    setFlowBlocked(blocked);
    report.current(blocked || mutation.current);
  }, []);
  const onMutationChange = useCallback((running: boolean) => {
    mutation.current = running;
    report.current(running || flow.current);
  }, []);
  return { flowBlocked, onFlowChange, onMutationChange };
}

/** Keeps a running security flow the only interactive part of the drawer. Its
 * recovery codes must survive navigation, profile and password changes, role
 * previews, sign-out, and keyboard shortcuts until acknowledged. */
function useSecurityFlowLock(listRef: RefObject<HTMLDivElement | null>, locked: boolean) {
  useLayoutEffect(() => {
    const list = listRef.current;
    const keep = list?.querySelector(".account-security-section");
    if (!locked || !list || !keep) return;
    const marked = makeOutsideInert(list, keep);
    return () => {
      for (const element of marked) element.removeAttribute("inert");
    };
  }, [listRef, locked]);
}

export function AccountDrawer({
  data,
  actualRole,
  viewAsRole,
  onViewAsRoleChange,
  threads,
  consoles,
  currentView,
  onSelectView,
  onSecurityCloseGuardChange,
  escapeLayers,
  apiAccessGranted,
  onApiKeyLoad,
  onApiKeyCreate,
  onApiKeyRevoke,
  onProfileUpdate,
  onPasswordUpdate,
  memoryHint,
  onOpenMemory,
  onRestoreThread,
  onDeleteThread,
  onSignOut,
  onRequestSignOut,
}: AccountDrawerProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const { flowBlocked, onFlowChange, onMutationChange } = useExitGuard(onSecurityCloseGuardChange);
  useSecurityFlowLock(listRef, flowBlocked);

  return (
    <EscapeLayersContext.Provider value={escapeLayers}>
    <AccountAnnouncer>
    <div ref={listRef} className="account-drawer-list">
      <AccountIdentity
        user={data.me}
        actualRole={actualRole}
        organization={data.currentTenant.name}
        onProfileUpdate={onProfileUpdate}
      />
      <WorkspaceSection
        consoles={consoles}
        currentView={currentView}
        pendingRequests={data.modelAccessRequestCount ?? 0}
        onSelectView={onSelectView}
        actualRole={actualRole}
        viewAsRole={viewAsRole}
        onViewAsRoleChange={onViewAsRoleChange}
      />
      <AccountSection title="Preferences and security">
        <div className="account-slab">
          {memoryHint !== null && onOpenMemory && <MemoryRow hint={memoryHint} onOpen={onOpenMemory} />}
          <SecurityRow user={data.me} blocked={flowBlocked} onGuardChange={onFlowChange} onSignOut={onSignOut} />
          {data.me.auth_method === "local" && <PasswordRow onPasswordUpdate={onPasswordUpdate} />}
          <AccountApiAccess
            initialAccess={apiAccessGranted}
            onLoad={onApiKeyLoad}
            onCreate={onApiKeyCreate}
            onRevoke={onApiKeyRevoke}
            onMutationChange={onMutationChange}
          />
        </div>
      </AccountSection>
      <AccountUsage userId={data.me.id} threads={threads} />
      <AccountArchive threads={threads} onRestoreThread={onRestoreThread} onDeleteThread={onDeleteThread} onMutationChange={onMutationChange} />
      {onSignOut && (
        <button
          className="secondary-button account-signout"
          type="button"
          data-tooltip={`Sign out of ${data.currentTenant.chat_brand_name?.trim() || "Aperture Chat"} and end this session`}
          onClick={onRequestSignOut ?? onSignOut}
        >
          <LogOut size={15} />
          Sign out
        </button>
      )}
    </div>
    </AccountAnnouncer>
    </EscapeLayersContext.Provider>
  );
}
