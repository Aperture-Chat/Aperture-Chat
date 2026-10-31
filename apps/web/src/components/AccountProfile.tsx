import { Camera, Pencil } from "lucide-react";
import { useEffect, useId, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes } from "react";
import {
  authMethodLabel,
  photoFileProblem,
  profileDraftChanged,
  profileDraftFromUser,
  profileDraftProblem,
  profileUpdateFromDraft,
  roleLabel,
  type ProfileDraft,
} from "../lib/accountDrawer";
import type { AccountProfileUpdateRequest, Role, User } from "../lib/types";
import { UNSAVED_NOTE, useAnnounce, useFirstFieldFocus, useFormEscape, useReturnFocus } from "./AccountRow";
import { UserAvatar } from "./UserAvatar";

/* Avatars render at 96px or smaller but the data URL is stored inline on the
 * user record and shipped with every bootstrap/session-resume payload, so
 * uploads are downscaled before storing. 512px covers retina rendering. */
const PROFILE_PHOTO_MAX_EDGE = 512;

async function downscaleProfilePhotoToDataUrl(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PROFILE_PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // JPEG keeps photos small; PNG sources stay PNG so transparency survives.
    return file.type === "image/png"
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return null;
  }
}

function readProfilePhotoAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" && reader.result ? reader.result : null);
    });
    reader.addEventListener("error", () => resolve(null));
    reader.readAsDataURL(file);
  });
}

async function photoFileToDataUrl(file: File): Promise<string | null> {
  const downscaled = typeof createImageBitmap === "function" ? await downscaleProfilePhotoToDataUrl(file) : null;
  // No bitmap/canvas support here: store the raw file, which the 5 MB gates at
  // selection and submit time still bound.
  return downscaled ?? readProfilePhotoAsDataUrl(file);
}

/** Lets a long address break after the @ before it breaks anywhere else. */
function EmailAddress({ email }: { email: string }) {
  const [local, ...domain] = email.split("@");
  if (domain.length === 0) return <small>{email}</small>;
  return (
    <small>
      {local}@<wbr />
      {domain.join("@")}
    </small>
  );
}

function ProfileDetails({ user }: { user: User }) {
  const details = [
    { label: "Phone", value: user.phone },
    { label: "Firm", value: user.firm_name },
    { label: "Website", value: user.website_url },
    { label: "Bio", value: user.bio },
  ].filter((detail): detail is { label: string; value: string } => Boolean(detail.value));
  if (details.length === 0) return null;
  return (
    <dl className="account-profile-details">
      {details.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PhotoEditor({
  user,
  draft,
  onPhotoChange,
  onProblem,
}: {
  user: User;
  draft: ProfileDraft;
  onPhotoChange: (avatarUrl: string) => void;
  onProblem: (problem: string | null) => void;
}) {
  const inputId = useId();

  const choosePhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const problem = photoFileProblem(file);
    onProblem(problem);
    if (problem) return;
    void photoFileToDataUrl(file).then((dataUrl) => {
      if (dataUrl) onPhotoChange(dataUrl);
      else onProblem("Could not read that image file.");
    });
  };

  return (
    <div className="account-photo-editor">
      <UserAvatar
        user={{ ...user, display_name: draft.displayName || user.display_name, avatar_url: draft.avatarUrl || null }}
        className="avatar account-profile-avatar"
      />
      <div className="account-photo-actions">
        <div className="account-photo-keys">
          <label className="secondary-button" htmlFor={inputId} data-tooltip="Choose an image from your device for your profile photo">
            <Camera size={14} />
            Upload photo
          </label>
          <input id={inputId} className="sr-only" type="file" accept="image/*" onChange={choosePhoto} />
          {draft.avatarUrl && (
            <button
              className="secondary-button"
              type="button"
              data-tooltip="Remove your photo and go back to your initials avatar"
              onClick={() => onPhotoChange("")}
            >
              Remove
            </button>
          )}
        </div>
        <small>Image files up to 5 MB.</small>
      </div>
    </div>
  );
}

function ProfileField({ id, label, ...input }: { id: string; label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label htmlFor={id}>
      {label}
      <input id={id} {...input} />
    </label>
  );
}

function ProfileForm({
  user,
  onSave,
  onCancel,
}: {
  user: User;
  onSave: (payload: AccountProfileUpdateRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const formId = useId();
  const [draft, setDraft] = useState<ProfileDraft>(() => profileDraftFromUser(user));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const formRef = useFirstFieldFocus<HTMLFormElement>();
  const heldByEscape = useFormEscape(!saving, profileDraftChanged(draft, user), onCancel);
  const usingUploadedPhoto = draft.avatarUrl.startsWith("data:");
  const setValue = (field: keyof ProfileDraft, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const bind = (field: keyof ProfileDraft) => ({
    value: draft[field],
    onChange: (event: ChangeEvent<HTMLInputElement>) => setValue(field, event.target.value),
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = profileDraftProblem(draft);
    setError(problem);
    if (problem) return;
    setSaving(true);
    try {
      await onSave(profileUpdateFromDraft(draft));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save profile.");
      setSaving(false);
    }
  };

  return (
    <form ref={formRef} className="account-form" onSubmit={(event) => void submit(event)} noValidate>
      <PhotoEditor user={user} draft={draft} onPhotoChange={(avatarUrl) => setValue("avatarUrl", avatarUrl)} onProblem={setError} />
      <ProfileField id={`${formId}-name`} label="Display name" {...bind("displayName")} placeholder="Your display name" maxLength={120} />
      <ProfileField id={`${formId}-phone`} label="Phone number" {...bind("phone")} placeholder="+1 555 0100" maxLength={40} />
      <ProfileField id={`${formId}-firm`} label="Firm or organization" {...bind("firmName")} placeholder="Organization name" maxLength={160} />
      <ProfileField id={`${formId}-website`} label="Website" type="url" {...bind("websiteUrl")} placeholder="https://example.com" maxLength={2048} />
      <ProfileField
        id={`${formId}-photo-url`}
        label="Profile photo URL"
        {...bind("avatarUrl")}
        value={usingUploadedPhoto ? "" : draft.avatarUrl}
        placeholder={usingUploadedPhoto ? "Using an uploaded photo" : "https://example.com/photo.jpg"}
      />
      <label htmlFor={`${formId}-bio`}>
        Bio
        <textarea
          id={`${formId}-bio`}
          value={draft.bio}
          onChange={(event) => setValue("bio", event.target.value)}
          placeholder="Add a short note about your role or focus."
          rows={4}
          maxLength={500}
        />
      </label>
      {error && <small className="drawer-error" role="alert">{error}</small>}
      {heldByEscape && <small className="account-panel-note" role="status">{UNSAVED_NOTE}</small>}
      <div className="drawer-form-actions">
        <button className="secondary-button" type="button" data-tooltip="Discard your profile edits and keep your current details" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary-button" type="submit" disabled={saving} data-tooltip="Save these profile changes so teammates see them">
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </form>
  );
}

/** Who you are: the summary, the facts the workspace knows, and the editor. */
export function AccountIdentity({
  user,
  actualRole,
  organization,
  onProfileUpdate,
}: {
  user: User;
  actualRole: Role;
  organization: string;
  onProfileUpdate?: (payload: AccountProfileUpdateRequest) => unknown;
}) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const { returnTo, target } = useReturnFocus();
  const close = () => {
    returnTo("edit");
    setEditing(false);
  };

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 4000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const announce = useAnnounce();
  const save = async (payload: AccountProfileUpdateRequest) => {
    if (!onProfileUpdate) throw new Error("Profile updates are not connected.");
    await onProfileUpdate(payload);
    close();
    setSaved(true);
    announce("Profile saved.");
  };

  return (
    <section className="account-identity" aria-label="Your profile">
      {editing ? (
        <ProfileForm user={user} onSave={save} onCancel={close} />
      ) : (
        <>
          <div className="account-identity-head">
            <UserAvatar user={user} />
            <div className="account-identity-copy">
              <strong>{user.display_name}</strong>
              <EmailAddress email={user.email} />
            </div>
            <button
              ref={target("edit")}
              className="secondary-button"
              type="button"
              aria-label={`Edit account profile for ${user.display_name}`}
              data-tooltip="Edit your display name, firm, website, bio, phone number, and photo"
              onClick={() => {
                setSaved(false);
                setEditing(true);
              }}
            >
              <Pencil size={14} />
              <span className="account-edit-label">Edit</span>
            </button>
          </div>
          <div className="account-well">
            <ul className="account-facts" aria-label="Account details">
              <li>
                <b>Role</b>
                <span>{roleLabel(actualRole)}</span>
              </li>
              <li>
                <b>Organization</b>
                <span>{organization}</span>
              </li>
              <li>
                <b>Sign-in</b>
                <span>{authMethodLabel(user.auth_method)}</span>
              </li>
            </ul>
            <ProfileDetails user={user} />
          </div>
        </>
      )}
      {saved && <small className="drawer-success">Profile saved.</small>}
    </section>
  );
}
