import { Check, Copy, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  confirmMfaEnrollment,
  disableMfa,
  getSessionToken,
  loadMfaAccountStatus,
  MfaRequestError,
  regenerateMfaRecoveryCodes,
  setSessionToken,
  startVoluntaryMfaEnrollment,
  type MfaAccountStatus,
  type MfaEnrollmentStart,
  type MfaMethod,
} from "../lib/api";
import type { User } from "../lib/types";
import "./account-security.css";

type Step = "overview" | "start" | "enroll" | "recovery" | "regenerate" | "disable";

type AccountSecurityProps = {
  user: User;
  onSignOut?: () => void;
  /** Prevent drawer dismissal while a mutation or unsaved codes need attention. */
  onCloseGuardChange?: (blocked: boolean) => void;
};

export function AccountSecurity(props: AccountSecurityProps) {
  // Changing accounts destroys all password, enrollment, and code state.
  return <AccountSecurityForUser key={props.user.id} {...props} />;
}

function AccountSecurityForUser({
  user,
  onSignOut,
  onCloseGuardChange,
}: AccountSecurityProps) {
  const [status, setStatus] = useState<MfaAccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [step, setStep] = useState<Step>("overview");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [method, setMethod] = useState<MfaMethod>("totp");
  const [enrollment, setEnrollment] = useState<MfaEnrollmentStart | null>(null);
  const [savedAuthenticator, setSavedAuthenticator] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [savedCodes, setSavedCodes] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [retrySeconds, setRetrySeconds] = useState(0);
  const id = useId();
  const generation = useRef(0);
  const mutationPending = useRef(false);
  const guardCallback = useRef(onCloseGuardChange);
  guardCallback.current = onCloseGuardChange;

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void loadMfaAccountStatus(user.id, { signal: controller.signal }).then((result) => {
      if (generation.current === current) setStatus(result);
    }).catch((failure: unknown) => {
      if (generation.current === current && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "Could not load your security settings.");
      }
    }).finally(() => {
      if (generation.current === current) setLoading(false);
    });
    return () => { generation.current += 1; controller.abort(); };
  }, [user.id, loadAttempt]);

  const blocked = pending || (step === "recovery" && !savedCodes);
  useEffect(() => { guardCallback.current?.(blocked); }, [blocked]);
  useEffect(() => {
    if (!blocked) return;
    const protectUnsavedCodes = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsavedCodes);
    return () => window.removeEventListener("beforeunload", protectUnsavedCodes);
  }, [blocked]);
  useEffect(() => () => { guardCallback.current?.(false); }, []);
  useEffect(() => {
    if (!retrySeconds) return;
    const timer = window.setTimeout(() => setRetrySeconds((remaining) => Math.max(0, remaining - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [retrySeconds]);

  function resetEditor() {
    setStep("overview");
    setError(null);
    setPassword("");
    setCode("");
    setEnrollment(null);
    setSavedAuthenticator(false);
    setRecoveryCodes(null);
    setSavedCodes(false);
    setCopyStatus(null);
    setMethod("totp");
  }

  function begin(nextStep: Step) {
    resetEditor();
    setStep(nextStep);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mutationPending.current || retrySeconds > 0) return;
    if (step === "start" && !password) { setError("Enter your current password to continue."); return; }
    if (step !== "start" && !code.trim()) { setError("Enter a verification code to continue."); return; }
    if (step === "enroll" && (!enrollment || !savedAuthenticator)) return;
    if (step === "disable" && (!status?.can_disable || !onSignOut)) return;
    const current = generation.current;
    const sessionAtStart = getSessionToken();
    const isCurrent = () => generation.current === current && getSessionToken() === sessionAtStart;
    mutationPending.current = true;
    setPending(true);
    setError(null);
    try {
      if (step === "start") {
        const started = await startVoluntaryMfaEnrollment(user.id, password);
        if (!isCurrent()) return;
        setPassword("");
        setEnrollment(started);
        setStep("enroll");
      } else if (step === "enroll" && enrollment) {
        const confirmed = await confirmMfaEnrollment({ enrollment_token: enrollment.enrollment_token, code: code.trim() });
        if (!isCurrent()) return;
        if (confirmed.login.user.id !== user.id || !confirmed.login.session?.token || confirmed.login.session.mfa_assured !== true) {
          throw new Error("Security settings changed. Sign in again to check your account.");
        }
        // Confirmation revokes the previous session. Install only the server's
        // verified replacement before background account requests can resume.
        setSessionToken(confirmed.login.session.token);
        setEnrollment(null);
        setCode("");
        setRecoveryCodes(confirmed.recovery_codes);
        setStatus((previous) => ({
          enabled: true,
          tenant_required: previous?.tenant_required ?? false,
          can_disable: !(previous?.tenant_required ?? false),
          confirmed_at: null,
          recovery_codes_remaining: confirmed.recovery_codes.length,
        }));
        setStep("recovery");
      } else if (step === "regenerate") {
        const replacement = await regenerateMfaRecoveryCodes(user.id, { method, code: code.trim() });
        if (!isCurrent()) return;
        setCode("");
        setRecoveryCodes(replacement.recovery_codes);
        setStatus((previous) => previous && { ...previous, recovery_codes_remaining: replacement.recovery_codes.length });
        setStep("recovery");
      } else if (step === "disable") {
        await disableMfa(user.id, { method, code: code.trim() });
        if (!isCurrent()) return;
        setCode("");
        setSessionToken(null);
        onSignOut?.();
      }
    } catch (failure) {
      if (generation.current !== current) return;
      setError(failure instanceof Error ? failure.message : "Your security settings could not be updated.");
      if (failure instanceof MfaRequestError && failure.retryAfterSeconds) setRetrySeconds(failure.retryAfterSeconds);
    } finally {
      mutationPending.current = false;
      if (generation.current === current) setPending(false);
    }
  }

  return (
    <section className="drawer-card account-security" aria-labelledby={`${id}-title`} aria-busy={loading || pending}>
      <header className="account-security-heading">
        <span className="account-security-icon"><ShieldCheck size={18} /></span>
        <div><h3 id={`${id}-title`}>Two-step verification</h3><p>An extra layer of protection for your account.</p></div>
        {status && <span className={`account-security-badge ${status.enabled ? "is-enabled" : ""}`}>{status.enabled ? "On" : "Off"}</span>}
      </header>
      {loading ? <p className="account-security-note" role="status"><Loader2 size={15} className="spin" /> Loading security settings…</p> : !status ? (
        <button className="secondary-button compact" type="button" onClick={() => setLoadAttempt((value) => value + 1)}>Retry security settings</button>
      ) : step === "overview" ? (
        <>
          {status.tenant_required && <p className="account-security-note">Required by your organization. You cannot turn this off.</p>}
          {status.enabled ? <>
            <p className="account-security-note">Your authenticator is connected. {status.recovery_codes_remaining} recovery {status.recovery_codes_remaining === 1 ? "code remains" : "codes remain"}.</p>
            <div className="account-security-actions">
              <button className="secondary-button compact" type="button" onClick={() => begin("regenerate")}><KeyRound size={15} /> Replace recovery codes</button>
              {status.can_disable && onSignOut && <button className="secondary-button compact" type="button" onClick={() => begin("disable")}>Turn off verification</button>}
            </div>
          </> : user.auth_method === "local" ? (
            <button className="secondary-button compact" type="button" onClick={() => begin("start")}><ShieldCheck size={15} /> Set up authenticator</button>
          ) : <p className="account-security-note">Your organization manages sign-in. Use your identity provider's security settings to manage verification. Contact your administrator if this workspace requires an additional authenticator.</p>}
        </>
      ) : step === "recovery" && recoveryCodes ? (
        <div className="account-security-form">
          <h4>Save your recovery codes</h4>
          <p className="account-security-note">These are shown only now. Each code works once if you cannot use your authenticator. Any previous recovery codes have been replaced.</p>
          <ul className="account-security-codes">{recoveryCodes.map((recoveryCode) => <li key={recoveryCode}>{recoveryCode}</li>)}</ul>
          <button className="secondary-button compact" type="button" onClick={async () => {
            try { await navigator.clipboard.writeText(recoveryCodes.join("\n")); setCopyStatus("Codes copied. Store them somewhere safe."); }
            catch { setCopyStatus("Copy was unavailable. Select and copy the codes manually."); }
          }}><Copy size={15} /> Copy recovery codes</button>
          {copyStatus && <p className="account-security-note" role="status">{copyStatus}</p>}
          <label className="account-security-check"><input type="checkbox" checked={savedCodes} onChange={(event) => setSavedCodes(event.target.checked)} />I stored these recovery codes somewhere safe.</label>
          <button className="primary-button compact" type="button" disabled={!savedCodes} onClick={() => { resetEditor(); setLoadAttempt((value) => value + 1); }}><Check size={15} /> Done</button>
        </div>
      ) : (
        <form className="account-security-form" onSubmit={(event) => void submit(event)} noValidate>
          {step === "start" ? <>
            <p className="account-security-note">Confirm your current password before connecting an authenticator app.</p>
            <label htmlFor={`${id}-password`}>Current password<input id={`${id}-password`} type="password" autoComplete="current-password" value={password} disabled={pending} onChange={(event) => setPassword(event.target.value)} required /></label>
          </> : <>
            {step === "enroll" && enrollment ? <>
              <p className="account-security-note">Scan this QR code with your authenticator app, or enter the setup key manually.</p>
              <div className="account-security-qr"><QRCodeSVG value={enrollment.provisioning_uri} size={156} /></div>
              <span className="account-security-note">Setup key</span><code className="account-security-secret">{enrollment.secret}</code>
              <label className="account-security-check"><input type="checkbox" checked={savedAuthenticator} disabled={pending} onChange={(event) => setSavedAuthenticator(event.target.checked)} />I added this account to my authenticator.</label>
            </> : <>
              <h4>{step === "disable" ? "Turn off two-step verification?" : "Replace your recovery codes?"}</h4>
              <p className="account-security-note">{step === "disable" ? "Your authenticator and recovery codes will stop working. You will be signed out and can sign in again using your usual sign-in method." : "Your old recovery codes will stop working. Enter a current code to create a new set."}</p>
            </>}
            <label htmlFor={`${id}-code`}>{method === "totp" ? "Authenticator code" : "Recovery code"}<input id={`${id}-code`} type="text" inputMode={method === "totp" ? "numeric" : "text"} autoComplete="one-time-code" maxLength={64} disabled={pending} value={code} onChange={(event) => setCode(event.target.value)} placeholder={method === "totp" ? "6-digit code" : "Recovery code"} required /></label>
            {step !== "enroll" && (status?.recovery_codes_remaining ?? 0) > 0 && <button className="link-button" type="button" disabled={pending} onClick={() => { setMethod((value) => value === "totp" ? "recovery_code" : "totp"); setCode(""); setError(null); }}>{method === "totp" ? "Use a recovery code instead" : "Use an authenticator code instead"}</button>}
          </>}
          <div className="account-security-actions">
            <button className="primary-button compact" type="submit" disabled={pending || retrySeconds > 0 || (step === "enroll" && !savedAuthenticator)}>{pending ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}{step === "start" ? "Continue setup" : step === "enroll" ? "Verify authenticator" : step === "disable" ? "Turn off and sign out" : "Create new recovery codes"}</button>
            <button className="secondary-button compact" type="button" disabled={pending} onClick={resetEditor}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="drawer-error" role="alert">{error}</p>}
      {retrySeconds > 0 && <p className="account-security-note" role="status">Try again in {retrySeconds} seconds.</p>}
    </section>
  );
}
