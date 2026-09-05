import { SelectControl } from "./SelectControl";
import "./auth-refresh.css";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowRight,
  CheckCircle2,
  Building2,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserRound,
  UserPlus,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ChatRequestError,
  MfaRequestError,
  confirmMfaEnrollment,
  fetchMfaPreauthStatus,
  registerMfaChallengeUiHandler,
  requestWorkspaceAccess,
  ssoAuthorizeUrl,
  startMfaEnrollmentWithChallenge,
  verifyMfaChallenge,
  type MfaEnrollmentStart,
  type MfaMethod,
  type MfaPreauthChallenge,
  type NormalizedLoginResponse,
} from "../lib/api";
import type {
  AuthBootstrapOwnerRequest,
  AuthLoginRequest,
  AuthOptionsResponse,
  AuthProviderOption,
} from "../lib/types";
import { ApertureMark } from "./Primitives";

type AuthLoginHandler = (payload: AuthLoginRequest) => void | Promise<void>;
type LocalAuthHandler = (payload?: AuthLoginRequest) => void | Promise<void>;
type BootstrapOwnerHandler = (payload: AuthBootstrapOwnerRequest) => void | Promise<void>;

/* In-memory state for a pending pre-session MFA challenge. Challenge tokens,
 * enrollment secrets, and recovery codes live only here while the view is on
 * screen; they are cleared on completion or cancellation and never persisted. */
type MfaFlowUiState = {
  challenge: MfaPreauthChallenge;
  method: MfaMethod;
  code: string;
  pending: boolean;
  error: string | null;
  /** Server-provided 429 Retry-After, counted down for honest display. */
  retryAfterSeconds: number | null;
  /** Present between enroll and enroll/confirm; holds the show-once secret. */
  enrollment: MfaEnrollmentStart | null;
  enrollmentAcknowledged: boolean;
  /** Show-once recovery codes returned by enroll/confirm. */
  recoveryCodes: string[] | null;
  recoveryAcknowledged: boolean;
  /** The verified login held until the recovery codes are acknowledged. */
  verifiedLogin: NormalizedLoginResponse | null;
  /** True once the server says the challenge can no longer succeed. */
  terminal: boolean;
};

type PendingMfaSession = {
  resolve: (result: NormalizedLoginResponse) => void;
  reject: (error: unknown) => void;
};

function initialMfaUiState(challenge: MfaPreauthChallenge): MfaFlowUiState {
  return {
    challenge,
    method: challenge.methods.includes("totp") ? "totp" : (challenge.methods[0] ?? "totp"),
    code: "",
    pending: false,
    error: null,
    retryAfterSeconds: null,
    enrollment: null,
    enrollmentAcknowledged: false,
    recoveryCodes: null,
    recoveryAcknowledged: false,
    verifiedLogin: null,
    terminal: false,
  };
}

type MfaFailure = { message: string; status?: number; retryAfterSeconds?: number };

function describeMfaFailure(error: unknown): MfaFailure {
  if (error instanceof MfaRequestError) {
    return { message: error.message, status: error.status, retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error instanceof ChatRequestError) {
    return { message: error.message, status: error.status };
  }
  return { message: error instanceof Error ? error.message : "The verification request failed." };
}

function formatChallengeTime(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return isoTimestamp;
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export type AuthScreenProps = {
  options?: AuthOptionsResponse | null;
  authOptions?: AuthOptionsResponse | null;
  tenantName?: string;
  tenantLogoUrl?: string | null;
  initialEmail?: string;
  initialDisplayName?: string;
  loading?: boolean;
  isLoading?: boolean;
  isSubmitting?: boolean;
  error?: string | null;
  onSubmit?: AuthLoginHandler;
  onSsoLogin?: AuthLoginHandler;
  onLocalLogin?: LocalAuthHandler;
  onBootstrapOwner?: BootstrapOwnerHandler;
  /** Navigates the browser to the IdP authorize URL. Overridable in tests. */
  onSsoRedirect?: (url: string) => void;
  onRetry?: () => void;
};

export function AuthScreen({
  options,
  authOptions,
  tenantName = "Aperture Chat",
  tenantLogoUrl = null,
  initialEmail = "",
  initialDisplayName = "",
  loading = false,
  isLoading = false,
  isSubmitting = false,
  error,
  onSubmit,
  onSsoLogin,
  onLocalLogin,
  onBootstrapOwner,
  onSsoRedirect,
  onRetry,
}: AuthScreenProps) {
  const emailId = useId();
  const displayNameId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();
  const providerId = useId();
  const errorId = useId();
  const mfaCodeId = useId();
  const mfaErrorId = useId();
  const accessFirstNameId = useId();
  const accessLastNameId = useId();
  const accessEmailId = useId();
  const resolvedOptions = authOptions ?? options;
  const providers = resolvedOptions?.providers ?? [];
  const bootstrapRequired = Boolean(resolvedOptions?.bootstrap_required);
  const passwordAuthEnabled = Boolean(resolvedOptions?.password_auth_enabled);
  const [email, setEmail] = useState(initialEmail);
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [preferredMethod, setPreferredMethod] = useState<"sso" | "local">("sso");
  const [signInHelp, setSignInHelp] = useState(false);
  const [recoveryCopyStatus, setRecoveryCopyStatus] = useState<string | null>(null);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState(providers[0]?.id ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [mfa, setMfa] = useState<MfaFlowUiState | null>(null);
  const [accessMode, setAccessMode] = useState(false);
  const [accessDraft, setAccessDraft] = useState({ firstName: "", lastName: "", email: initialEmail });
  const [accessPending, setAccessPending] = useState(false);
  const [accessComplete, setAccessComplete] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const mfaSessionRef = useRef<PendingMfaSession | null>(null);

  /* A pending 202 login (or restored #sso_mfa challenge) is delivered here.
   * The returned promise settles only with the server's verified login
   * response, so the caller's session-storage path stays unchanged. */
  const beginMfaSession = useCallback(
    (challenge: MfaPreauthChallenge) =>
      new Promise<NormalizedLoginResponse>((resolve, reject) => {
        mfaSessionRef.current?.reject(
          new MfaRequestError("This sign-in attempt was replaced by a newer one."),
        );
        mfaSessionRef.current = { resolve, reject };
        setMfa(initialMfaUiState(challenge));
      }),
    [],
  );

  useEffect(() => {
    registerMfaChallengeUiHandler(beginMfaSession);
    return () => {
      registerMfaChallengeUiHandler(null);
      // Never leave a caller's login promise hanging on unmount.
      mfaSessionRef.current?.reject(
        new MfaRequestError("Multi-factor sign-in was interrupted before it finished."),
      );
      mfaSessionRef.current = null;
    };
  }, [beginMfaSession]);

  /* Count the server's Retry-After down for honest display; the server stays
   * the authority — an early retry would simply receive another 429. */
  const retryCountdownActive = Boolean(mfa && mfa.retryAfterSeconds !== null && mfa.retryAfterSeconds > 0);
  useEffect(() => {
    if (!retryCountdownActive) return;
    const timer = window.setInterval(() => {
      setMfa((current) => {
        if (!current || current.retryAfterSeconds === null) return current;
        const next = current.retryAfterSeconds - 1;
        return { ...current, retryAfterSeconds: next > 0 ? next : null };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryCountdownActive]);

  const completeMfa = (login: NormalizedLoginResponse) => {
    const session = mfaSessionRef.current;
    mfaSessionRef.current = null;
    /* Clear challenge, secret, and recovery-code state before handing the
     * session over: show-once values must not outlive this view. */
    setMfa(null);
    session?.resolve(login);
  };

  const cancelMfa = (reason: string) => {
    const session = mfaSessionRef.current;
    mfaSessionRef.current = null;
    setMfa(null);
    session?.reject(new MfaRequestError(reason));
  };

  const submitMfaVerify = async () => {
    if (!mfa || mfa.pending) return;
    const code = mfa.code.trim();
    if (!code) {
      setMfa((current) =>
        current && {
          ...current,
          error:
            current.method === "totp"
              ? "Enter the code from your authenticator app."
              : "Enter one of your recovery codes.",
        },
      );
      return;
    }
    setMfa((current) => current && { ...current, pending: true, error: null });
    try {
      const login = await verifyMfaChallenge({
        challenge_token: mfa.challenge.challenge_token,
        method: mfa.method,
        code,
      });
      completeMfa(login);
    } catch (error) {
      const failure = describeMfaFailure(error);
      if (failure.status === 401) {
        /* Re-read the surviving challenge state from the server instead of
         * guessing attempts or methods client-side. */
        try {
          const status = await fetchMfaPreauthStatus(mfa.challenge.challenge_token);
          setMfa((current) =>
            current && {
              ...current,
              pending: false,
              code: "",
              error: failure.message,
              challenge: {
                ...current.challenge,
                purpose: status.purpose,
                expires_at: status.expires_at,
                methods: status.methods,
                attempts_remaining: status.attempts_remaining,
              },
              method: status.methods.includes(current.method) ? current.method : "totp",
            },
          );
        } catch (statusProbe) {
          const probeFailure = describeMfaFailure(statusProbe);
          setMfa((current) =>
            current && {
              ...current,
              pending: false,
              code: "",
              terminal: probeFailure.status === 401 ? true : current.terminal,
              error: probeFailure.status === 401 ? probeFailure.message : failure.message,
              retryAfterSeconds:
                probeFailure.status === 429
                  ? (probeFailure.retryAfterSeconds ?? current.retryAfterSeconds)
                  : current.retryAfterSeconds,
            },
          );
        }
        return;
      }
      setMfa((current) =>
        current && {
          ...current,
          pending: false,
          error: failure.message,
          retryAfterSeconds:
            failure.status === 429
              ? (failure.retryAfterSeconds ?? current.retryAfterSeconds)
              : current.retryAfterSeconds,
        },
      );
    }
  };

  const beginMfaEnrollment = async () => {
    if (!mfa || mfa.pending) return;
    setMfa((current) => current && { ...current, pending: true, error: null });
    try {
      const enrollment = await startMfaEnrollmentWithChallenge(mfa.challenge.challenge_token);
      setMfa((current) =>
        current && {
          ...current,
          pending: false,
          enrollment,
          enrollmentAcknowledged: false,
          code: "",
          error: null,
        },
      );
    } catch (error) {
      const failure = describeMfaFailure(error);
      setMfa((current) =>
        current && {
          ...current,
          pending: false,
          error: failure.message,
          terminal: failure.status === 401 ? true : current.terminal,
          retryAfterSeconds:
            failure.status === 429
              ? (failure.retryAfterSeconds ?? current.retryAfterSeconds)
              : current.retryAfterSeconds,
        },
      );
    }
  };

  const submitMfaEnrollmentConfirm = async () => {
    if (!mfa?.enrollment || mfa.pending || !mfa.enrollmentAcknowledged) return;
    const code = mfa.code.trim();
    if (!code) {
      setMfa((current) =>
        current && { ...current, error: "Enter the 6-digit code from your authenticator app." },
      );
      return;
    }
    const enrollmentToken = mfa.enrollment.enrollment_token;
    setMfa((current) => current && { ...current, pending: true, error: null });
    try {
      const confirmation = await confirmMfaEnrollment({ enrollment_token: enrollmentToken, code });
      setMfa((current) =>
        current && {
          ...current,
          pending: false,
          code: "",
          error: null,
          enrollment: null, // Drop the show-once secret immediately.
          recoveryCodes: confirmation.recovery_codes,
          recoveryAcknowledged: false,
          verifiedLogin: confirmation.login,
        },
      );
    } catch (error) {
      const failure = describeMfaFailure(error);
      setMfa((current) =>
        current && {
          ...current,
          pending: false,
          error: failure.message,
          retryAfterSeconds:
            failure.status === 429
              ? (failure.retryAfterSeconds ?? current.retryAfterSeconds)
              : current.retryAfterSeconds,
        },
      );
    }
  };

  const finishMfaEnrollment = () => {
    if (!mfa?.verifiedLogin || !mfa.recoveryAcknowledged) return;
    completeMfa(mfa.verifiedLogin);
  };
  const selectedProvider = providerFromId(providers, selectedProviderId);
  const effectiveProviderId = selectedProvider?.id ?? "";
  const statusMessage = validationError ?? error ?? null;
  const busy = loading || isLoading || isSubmitting;
  const brandName = tenantName.trim() || "Aperture Chat";
  const brandLogoUrl = tenantLogoUrl?.trim() || "";
  const hasConfiguredSso = providers.length > 0;
  const canUseSso = providers.length > 0 && !busy && !bootstrapRequired;
  const canUsePassword = passwordAuthEnabled && !busy && !bootstrapRequired;
  const primaryAuthMethod = bootstrapRequired
    ? "bootstrap"
    : hasConfiguredSso && !(passwordAuthEnabled && preferredMethod === "local")
      ? "sso"
      : passwordAuthEnabled
        ? "local"
        : "unavailable";
  const primaryDisabled =
    primaryAuthMethod === "bootstrap"
      ? busy
      : primaryAuthMethod === "sso"
        ? !canUseSso
        : primaryAuthMethod === "local"
          ? !canUsePassword
          : true;
  const primaryButtonLabel = bootstrapRequired
    ? "Create platform owner"
    : busy && !resolvedOptions
      ? "Loading sign-in…"
    : primaryAuthMethod === "sso"
      ? "Continue with SSO"
      : primaryAuthMethod === "local"
        ? "Sign in"
        : "Sign-in unavailable";

  const buildPayload = (authMethod: "local", requireIdentity: boolean): AuthLoginRequest | null => {
    const nextEmail = email.trim();
    const nextDisplayName = displayName.trim();

    if (!nextEmail) {
      if (requireIdentity) setValidationError("Enter your email to continue.");
      return null;
    }

    if (!isEmailLike(nextEmail)) {
      if (requireIdentity) setValidationError("Enter a valid email address.");
      return null;
    }

    if (!password) {
      setValidationError("Enter your password.");
      return null;
    }

    const request: AuthLoginRequest = {
      email: nextEmail,
      display_name: nextDisplayName || null,
      auth_method: authMethod,
      provider_id: null,
    };
    request.password = password;
    return request;
  };

  const submitBootstrapOwner = () => {
    if (!onBootstrapOwner) {
      setValidationError("First-owner setup is not connected.");
      return;
    }
    const nextEmail = email.trim();
    const nextDisplayName = displayName.trim();
    if (!nextEmail || !nextDisplayName) {
      setValidationError("Enter your email and display name to create the first owner.");
      return;
    }
    if (!isEmailLike(nextEmail)) {
      setValidationError("Enter a valid email address.");
      return;
    }
    if (password.length < 12) {
      setValidationError("Use a password with at least 12 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setValidationError("The passwords do not match.");
      return;
    }
    setValidationError(null);
    void onBootstrapOwner({
      email: nextEmail,
      display_name: nextDisplayName,
      password,
    });
  };

  const submitSso = () => {
    // Real OIDC: identity is asserted by the provider, so the browser is sent to
    // the IdP's hosted sign-in page instead of posting a typed email.
    if (!selectedProvider) {
      setValidationError("No SSO provider is configured for this tenant.");
      return;
    }
    const nextEmail = email.trim();
    if (nextEmail && !isEmailLike(nextEmail)) {
      setValidationError("Enter a valid email address.");
      return;
    }
    if (
      nextEmail &&
      selectedProvider.domains.length > 0 &&
      !selectedProvider.domains.includes(nextEmail.split("@")[1]?.toLowerCase() ?? "")
    ) {
      setValidationError(
        `${selectedProvider.name} is configured for ${selectedProvider.domains.join(", ")} accounts. Pick the matching provider or leave the email blank.`,
      );
      return;
    }
    setValidationError(null);
    const redirect = onSsoRedirect ?? ((url: string) => window.location.assign(url));
    redirect(ssoAuthorizeUrl(selectedProvider.id));
  };

  const submitLocal = () => {
    const payload = buildPayload("local", true);
    if (!payload) return;
    if (onLocalLogin) {
      setValidationError(null);
      void onLocalLogin(payload);
      return;
    }

    if (!onSubmit) {
      setValidationError("Local sign-in is not connected.");
      return;
    }

    setValidationError(null);
    void onSubmit(payload);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (primaryDisabled) return;
    if (bootstrapRequired) {
      submitBootstrapOwner();
      return;
    }
    if (primaryAuthMethod === "local") {
      submitLocal();
      return;
    }
    submitSso();
  };

  const submitAccessRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (accessPending) return;
    const firstName = accessDraft.firstName.trim();
    const lastName = accessDraft.lastName.trim();
    const requestEmail = accessDraft.email.trim();
    if (!firstName || !lastName) {
      setAccessError("Enter your first and last name.");
      return;
    }
    if (!isEmailLike(requestEmail)) {
      setAccessError("Enter a valid email address.");
      return;
    }
    setAccessPending(true);
    setAccessError(null);
    try {
      await requestWorkspaceAccess({
        first_name: firstName,
        last_name: lastName,
        email: requestEmail,
      });
      setAccessComplete(true);
    } catch (requestError) {
      setAccessError(requestError instanceof Error ? requestError.message : "The access request could not be submitted.");
    } finally {
      setAccessPending(false);
    }
  };

  const renderMfaStatusAlert = (state: MfaFlowUiState) => {
    const retryLocked = state.retryAfterSeconds !== null && state.retryAfterSeconds > 0;
    if (!state.error && !retryLocked) return null;
    return (
      <div className="auth-error" id={mfaErrorId} role="alert">
        <LockKeyhole size={16} />
        <span>
          {state.error}
          {retryLocked ? `${state.error ? " " : ""}Try again in ${state.retryAfterSeconds}s.` : ""}
        </span>
      </div>
    );
  };

  const renderMfaPanel = (state: MfaFlowUiState) => {
    const retryLocked = state.retryAfterSeconds !== null && state.retryAfterSeconds > 0;
    const attemptsLabel =
      state.challenge.attempts_remaining === 1
        ? "1 attempt remaining"
        : `${state.challenge.attempts_remaining} attempts remaining`;

    if (state.recoveryCodes) {
      return (
        <>
          <div className="auth-heading">
            <h1 id="auth-title">Save your recovery codes</h1>
            <p>
              Each code signs you in once if your authenticator app is unavailable. They are shown
              only now and cannot be retrieved later.
            </p>
          </div>
          <div className="auth-form">
            <ul className="auth-recovery-codes">
              {state.recoveryCodes.map((recoveryCode) => (
                <li key={recoveryCode}>{recoveryCode}</li>
              ))}
            </ul>
            <button
              type="button"
              className="secondary-button auth-local-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(state.recoveryCodes!.join("\n"));
                  setRecoveryCopyStatus("Recovery codes copied. Store them somewhere safe.");
                } catch {
                  setRecoveryCopyStatus("Copy was unavailable. Select the codes above and copy them manually.");
                }
              }}
            >
              <Copy size={16} /> Copy recovery codes
            </button>
            {recoveryCopyStatus && <p className="auth-field-help" role="status">{recoveryCopyStatus}</p>}
            <label className="auth-mfa-ack">
              <input
                type="checkbox"
                checked={state.recoveryAcknowledged}
                onChange={(event) =>
                  setMfa((current) =>
                    current && { ...current, recoveryAcknowledged: event.target.checked },
                  )
                }
              />
              <span>
                I stored these recovery codes in a safe place and understand they will not be shown
                again.
              </span>
            </label>
            <div className="auth-actions">
              <button
                className="primary-button auth-submit-button"
                type="button"
                disabled={!state.recoveryAcknowledged}
                onClick={finishMfaEnrollment}
                data-tooltip="Finish sign-in with your newly verified authenticator"
              >
                <KeyRound size={17} />
                <span>Continue to workspace</span>
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </>
      );
    }

    if (state.enrollment) {
      return (
        <>
          <div className="auth-heading">
            <h1 id="auth-title">Set up your authenticator app</h1>
            <p>
              Scan the QR code or enter the secret in your authenticator app, then confirm with a
              6-digit code. The secret is shown only now.
            </p>
          </div>
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitMfaEnrollmentConfirm();
            }}
            noValidate
          >
            <div className="auth-mfa-secret-panel">
              <QRCodeSVG value={state.enrollment.provisioning_uri} size={148} level="M" includeMargin />
              <code className="auth-mfa-secret">{state.enrollment.secret}</code>
              <small>Setup expires at {formatChallengeTime(state.enrollment.expires_at)}</small>
            </div>
            <label className="auth-mfa-ack">
              <input
                type="checkbox"
                checked={state.enrollmentAcknowledged}
                onChange={(event) =>
                  setMfa((current) =>
                    current && { ...current, enrollmentAcknowledged: event.target.checked },
                  )
                }
              />
              <span>
                I added this account to my authenticator app and understand the secret will not be
                shown again.
              </span>
            </label>
            <label className="auth-field" htmlFor={mfaCodeId}>
              <span>Authenticator code</span>
              <span className="auth-input-wrap">
                <ShieldCheck size={17} />
                <input
                  id={mfaCodeId}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={16}
                  value={state.code}
                  onChange={(event) => {
                    const code = event.target.value;
                    setMfa((current) => current && { ...current, code });
                  }}
                  placeholder="123456"
                  aria-describedby={state.error ? mfaErrorId : undefined}
                />
              </span>
            </label>
            {renderMfaStatusAlert(state)}
            <div className="auth-actions">
              <button
                className="primary-button auth-submit-button"
                type="submit"
                disabled={state.pending || retryLocked || !state.enrollmentAcknowledged}
                data-tooltip="Verify the code and enable multi-factor authentication"
              >
                {state.pending ? <Loader2 className="auth-spinner" size={17} /> : <ShieldCheck size={17} />}
                <span>Verify and enable MFA</span>
              </button>
              <button
                className="secondary-button auth-local-button"
                type="button"
                disabled={state.pending}
                onClick={() =>
                  cancelMfa("Multi-factor setup was cancelled before it finished. Sign in again to retry.")
                }
                data-tooltip="Abandon this setup and return to the sign-in screen"
              >
                Back to sign in
              </button>
            </div>
          </form>
        </>
      );
    }

    if (state.terminal) {
      return (
        <>
          <div className="auth-heading">
            <h1 id="auth-title">Verification unavailable</h1>
            <p>This sign-in challenge can no longer be completed. Sign in again to start over.</p>
          </div>
          <div className="auth-form">
            {renderMfaStatusAlert(state)}
            <div className="auth-actions">
              <button
                className="secondary-button auth-local-button"
                type="button"
                onClick={() =>
                  cancelMfa(state.error ?? "The sign-in challenge is no longer valid. Sign in again.")
                }
                data-tooltip="Return to the sign-in screen"
              >
                Back to sign in
              </button>
            </div>
          </div>
        </>
      );
    }

    if (state.challenge.purpose === "enroll") {
      return (
        <>
          <div className="auth-heading">
            <h1 id="auth-title">Set up two-step verification</h1>
            <p>
              Your organization requires an authenticator app before this sign-in can finish.
              You will scan a QR code and confirm one code.
            </p>
          </div>
          <div className="auth-form">
            <div className="auth-mfa-meta">
              <span>Challenge expires at {formatChallengeTime(state.challenge.expires_at)}</span>
            </div>
            {renderMfaStatusAlert(state)}
            <div className="auth-actions">
              <button
                className="primary-button auth-submit-button"
                type="button"
                disabled={state.pending || retryLocked}
                onClick={() => void beginMfaEnrollment()}
                data-tooltip="Generate the authenticator secret for this account"
              >
                {state.pending ? <Loader2 className="auth-spinner" size={17} /> : <ShieldCheck size={17} />}
                <span>Begin authenticator setup</span>
                <ArrowRight size={16} />
              </button>
              <button
                className="secondary-button auth-local-button"
                type="button"
                disabled={state.pending}
                onClick={() =>
                  cancelMfa("Multi-factor setup was cancelled before it finished. Sign in again to retry.")
                }
                data-tooltip="Abandon this setup and return to the sign-in screen"
              >
                Back to sign in
              </button>
            </div>
          </div>
        </>
      );
    }

    const recoveryAvailable = state.challenge.methods.includes("recovery_code");
    return (
      <>
        <div className="auth-heading">
          <h1 id="auth-title">Two-step verification</h1>
          <p>
            {state.method === "totp"
              ? "Enter the code from your authenticator app to finish signing in."
              : "Enter one of your unused recovery codes to finish signing in. Each code works once."}
          </p>
        </div>
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitMfaVerify();
          }}
          noValidate
        >
          <div className="auth-mfa-meta">
            <span>{attemptsLabel}</span>
            <span>Expires at {formatChallengeTime(state.challenge.expires_at)}</span>
          </div>
          <label className="auth-field" htmlFor={mfaCodeId}>
            <span>{state.method === "totp" ? "Authenticator code" : "Recovery code"}</span>
            <span className="auth-input-wrap">
              <ShieldCheck size={17} />
              <input
                id={mfaCodeId}
                type="text"
                inputMode={state.method === "totp" ? "numeric" : "text"}
                autoComplete="one-time-code"
                maxLength={64}
                value={state.code}
                onChange={(event) => {
                  const code = event.target.value;
                  setMfa((current) => current && { ...current, code });
                }}
                placeholder={state.method === "totp" ? "123456" : "Recovery code"}
                aria-describedby={state.error ? mfaErrorId : undefined}
              />
            </span>
          </label>
          {recoveryAvailable && (
            <button
              type="button"
              className="link-button"
              onClick={() =>
                setMfa((current) =>
                  current && {
                    ...current,
                    method: current.method === "totp" ? "recovery_code" : "totp",
                    code: "",
                    error: null,
                  },
                )
              }
            >
              {state.method === "totp" ? "Use a recovery code instead" : "Use an authenticator code instead"}
            </button>
          )}
          {renderMfaStatusAlert(state)}
          <div className="auth-actions">
            <button
              className="primary-button auth-submit-button"
              type="submit"
              disabled={state.pending || retryLocked}
              data-tooltip="Verify the code with the server and finish signing in"
            >
              {state.pending ? <Loader2 className="auth-spinner" size={17} /> : <ShieldCheck size={17} />}
              <span>Verify and continue</span>
              <ArrowRight size={16} />
            </button>
            <button
              className="secondary-button auth-local-button"
              type="button"
              disabled={state.pending}
              onClick={() =>
                cancelMfa("Multi-factor sign-in was cancelled before verification. Sign in again to retry.")
              }
              data-tooltip="Abandon this challenge and return to the sign-in screen"
            >
              Back to sign in
            </button>
          </div>
        </form>
      </>
    );
  };

  return (
    <main className="auth-screen auth-refresh">
      <section className="auth-shell" aria-labelledby="auth-title">
        <div className="auth-panel" aria-busy={mfa ? mfa.pending : busy || accessPending}>
          <div className="auth-brand">
            {brandLogoUrl ? (
              <span className="auth-brand-mark">
                <img src={brandLogoUrl} alt="" />
              </span>
            ) : (
              <ApertureMark size={34} title={brandName} />
            )}
            <div>
              <span>{brandName}</span>
              <strong>{mfa ? "Two-step verification" : accessMode ? "Access request" : bootstrapRequired ? "Workspace setup" : "Account sign-in"}</strong>
            </div>
          </div>

          {mfa ? (
            renderMfaPanel(mfa)
          ) : accessMode ? (
            <>
              <div className="auth-heading auth-access-heading">
                <span className="auth-eyebrow">Workspace access</span>
                <h1 id="auth-title">{accessComplete ? "Request received" : "Ask to join"}</h1>
                <p>
                  {accessComplete
                    ? "If this email is new to the workspace, your request is now waiting for administrator review."
                    : `Start with your name and work email. A ${brandName} administrator will review your request.`}
                </p>
              </div>
              {accessComplete ? (
                <div className="auth-access-success" role="status">
                  <span className="auth-access-success-mark"><CheckCircle2 size={22} /></span>
                  <div>
                    <strong>Request submitted for {accessDraft.email.trim()}</strong>
                    <span>Your administrator will arrange your sign-in method after approval. Contact them for an update; this form does not send an email or set a password.</span>
                  </div>
                  <ol className="auth-next-steps">
                    <li><span>1</span> Administrator reviews your access.</li>
                    <li><span>2</span> Get your organization sign-in or temporary password.</li>
                    <li><span>3</span> Return here and open your workspace.</li>
                  </ol>
                  <button
                    className="secondary-button auth-local-button"
                    type="button"
                    onClick={() => { setEmail(accessDraft.email.trim()); setAccessMode(false); }}
                  >
                    Back to sign in
                  </button>
                </div>
              ) : (
                <form className="auth-form auth-access-form" onSubmit={(event) => void submitAccessRequest(event)} noValidate>
                  <div className="auth-name-grid">
                    <label className="auth-field" htmlFor={accessFirstNameId}>
                      <span>First name</span>
                      <span className="auth-input-wrap">
                        <UserRound size={17} />
                        <input
                          id={accessFirstNameId}
                          disabled={accessPending}
                          autoComplete="given-name"
                          value={accessDraft.firstName}
                          onChange={(event) => setAccessDraft((current) => ({ ...current, firstName: event.target.value }))}
                          placeholder="Jane"
                          maxLength={80}
                          required
                        />
                      </span>
                    </label>
                    <label className="auth-field" htmlFor={accessLastNameId}>
                      <span>Last name</span>
                      <span className="auth-input-wrap">
                        <UserRound size={17} />
                        <input
                          id={accessLastNameId}
                          disabled={accessPending}
                          autoComplete="family-name"
                          value={accessDraft.lastName}
                          onChange={(event) => setAccessDraft((current) => ({ ...current, lastName: event.target.value }))}
                          placeholder="Smith"
                          maxLength={80}
                          required
                        />
                      </span>
                    </label>
                  </div>
                  <label className="auth-field" htmlFor={accessEmailId}>
                    <span>Work email</span>
                    <span className="auth-input-wrap">
                      <Mail size={17} />
                      <input
                        id={accessEmailId}
                        disabled={accessPending}
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        value={accessDraft.email}
                        onChange={(event) => setAccessDraft((current) => ({ ...current, email: event.target.value }))}
                        placeholder="you@company.com"
                        maxLength={320}
                        aria-describedby={accessError ? errorId : undefined}
                        required
                      />
                    </span>
                  </label>
                  {accessError && (
                    <div className="auth-error" id={errorId} role="alert">
                      <LockKeyhole size={16} />
                      <span>{accessError}</span>
                    </div>
                  )}
                  <div className="auth-actions">
                    <button className="primary-button auth-submit-button" type="submit" disabled={accessPending}>
                      {accessPending ? <Loader2 className="auth-spinner" size={17} /> : <UserPlus size={17} />}
                      <span>{accessPending ? "Submitting…" : "Submit access request"}</span>
                      {!accessPending && <ArrowRight size={16} />}
                    </button>
                    <button
                      className="secondary-button auth-local-button"
                      type="button"
                      disabled={accessPending}
                      onClick={() => {
                        setAccessMode(false);
                        setAccessError(null);
                      }}
                    >
                      Back to sign in
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : (
            <>
          <div className="auth-heading">
            <span className="auth-eyebrow">{bootstrapRequired ? "First-time setup" : "Your workspace, ready when you are"}</span>
            <h1 id="auth-title">{bootstrapRequired ? "Create the first platform owner" : "Sign in to continue"}</h1>
            <p>
              {bootstrapRequired
                ? "Create your account to configure this installation. Next, connect a model provider and invite your team."
                : primaryAuthMethod === "sso"
                  ? "Continue with your organization's sign-in. Your identity provider will verify your account."
                  : "Use your email and password to pick up where you left off."}
            </p>
          </div>

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            {!bootstrapRequired && hasConfiguredSso && passwordAuthEnabled && (
              <div className="auth-method-switch" aria-label="Sign-in method">
                <button type="button" aria-pressed={primaryAuthMethod === "sso"} disabled={busy}
                  onClick={() => { setPreferredMethod("sso"); setValidationError(null); }}>
                  <Building2 size={16} /> Organization SSO
                </button>
                <button type="button" aria-pressed={primaryAuthMethod === "local"} disabled={busy}
                  onClick={() => { setPreferredMethod("local"); setValidationError(null); }}>
                  <Mail size={16} /> Email & password
                </button>
              </div>
            )}
            <label className="auth-field" htmlFor={emailId}>
              <span>Email</span>
              <span className="auth-input-wrap">
                <Mail size={17} />
                <input
                  id={emailId}
                  aria-label="Email"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(event) => {
                    const nextEmail = event.target.value;
                    setEmail(nextEmail);
                    const domain = nextEmail.split("@")[1]?.trim().toLowerCase();
                    if (!domain) return;
                    const match = providers.find((provider) => provider.domains.includes(domain));
                    if (match) setSelectedProviderId(match.id);
                  }}
                  placeholder="you@company.com"
                  aria-describedby={statusMessage ? errorId : undefined}
                  required={bootstrapRequired || primaryAuthMethod === "local"}
                />
              </span>
              {primaryAuthMethod === "sso" && <small className="auth-field-help">Optional. Helps select your organization's sign-in provider.</small>}
            </label>

            {bootstrapRequired && (
              <label className="auth-field" htmlFor={displayNameId}>
                <span>Display name</span>
                <span className="auth-input-wrap">
                  <UserRound size={17} />
                  <input
                    id={displayNameId}
                    type="text"
                    autoComplete="name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    placeholder="Jane Smith"
                    aria-describedby={statusMessage ? errorId : undefined}
                    required={bootstrapRequired}
                  />
                </span>
              </label>
            )}

            {(bootstrapRequired || primaryAuthMethod === "local") && (
              <label className="auth-field" htmlFor={passwordId}>
                <span>{bootstrapRequired ? "Create password" : "Password"}</span>
                <span className="auth-input-wrap auth-password-wrap">
                  <LockKeyhole size={17} />
                  <input
                    id={passwordId}
                    aria-label={bootstrapRequired ? "Create password" : "Password"}
                    type={passwordVisible ? "text" : "password"}
                    autoComplete={bootstrapRequired ? "new-password" : "current-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={bootstrapRequired ? "At least 12 characters" : "Password"}
                    aria-describedby={statusMessage ? errorId : undefined}
                    required={bootstrapRequired || passwordAuthEnabled}
                  />
                  <button className="auth-reveal" type="button" aria-label={passwordVisible ? "Hide password" : "Show password"}
                    aria-pressed={passwordVisible} onClick={() => setPasswordVisible((visible) => !visible)}>
                    {passwordVisible ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </span>
                {bootstrapRequired && <small className="auth-field-help">At least 12 characters. A memorable passphrase works well.</small>}
              </label>
            )}

            {bootstrapRequired && (
              <label className="auth-field" htmlFor={confirmPasswordId}>
                <span>Confirm password</span>
                <span className="auth-input-wrap">
                  <LockKeyhole size={17} />
                  <input
                    id={confirmPasswordId}
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="Repeat password"
                    aria-describedby={statusMessage ? errorId : undefined}
                    required
                  />
                </span>
              </label>
            )}

            {!bootstrapRequired && primaryAuthMethod === "sso" && providers.length > 1 && (
              <label className="auth-field" htmlFor={providerId}>
                <span>SSO provider</span>
                <span className="auth-select-wrap">
                  <Building2 size={17} />
                  <SelectControl
                    id={providerId}
                    value={effectiveProviderId}
                    onChange={(event) => setSelectedProviderId(event.target.value)}
                  >
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </SelectControl>
                </span>
              </label>
            )}

            {!bootstrapRequired && primaryAuthMethod === "sso" && selectedProvider && (
              <div className="auth-provider-status">
                <ShieldCheck size={16} />
                <span>{providerStatusText(selectedProvider)}</span>
              </div>
            )}

            {statusMessage && (
              <div className="auth-error" id={errorId} role="alert">
                <LockKeyhole size={16} />
                <span>{statusMessage}</span>
              </div>
            )}
            {!resolvedOptions && !busy && onRetry && (
              <button type="button" className="secondary-button auth-local-button" onClick={onRetry}>Retry connection</button>
            )}

            <div className="auth-actions">
              <button
                className="primary-button auth-submit-button"
                type="submit"
                disabled={primaryDisabled}
                data-tooltip={
                  bootstrapRequired
                    ? "Create the first owner account with full platform control"
                    : primaryAuthMethod === "sso"
                      ? "Go to your identity provider's sign-in page to authenticate"
                      : primaryAuthMethod === "local"
                        ? "Sign in with your email and password"
                        : "Sign-in stays unavailable until an owner configures authentication"
                }
              >
                {busy ? <Loader2 className="auth-spinner" size={17} /> : <KeyRound size={17} />}
                <span>{primaryButtonLabel}</span>
                {!busy && <ArrowRight size={16} />}
              </button>

            </div>
            {!bootstrapRequired && (
              <div className="auth-help-section">
                <button className="link-button" type="button" aria-expanded={signInHelp} onClick={() => setSignInHelp((open) => !open)}>
                  Trouble signing in?
                </button>
                {signInHelp && <p className="auth-field-help" role="status">
                  For organization SSO, use your organization's password recovery. For an email-and-password account, ask your workspace administrator for a temporary password. After approval, your administrator must arrange your sign-in before you can enter.
                </p>}
              </div>
            )}
            {!bootstrapRequired && resolvedOptions && (
              <div className="auth-request-entry">
                <span><Clock3 size={15} /> Need an account?</span>
                <button
                  className="link-button auth-request-button"
                  type="button"
                  onClick={() => {
                    setAccessDraft((current) => ({ ...current, email: current.email || email }));
                    setAccessMode(true);
                    setAccessError(null);
                  }}
                >
                  Request access <ArrowRight size={14} />
                </button>
              </div>
            )}
          </form>
            </>
          )}
        </div>

        <aside className="auth-context" aria-label="Authentication requirements">
          <div className="auth-context-intro">
            <span className="auth-eyebrow">Made for focused work</span>
            <h2>A clearer space<br />for your best work.</h2>
            <p>Conversations, knowledge, and the tools your team needs. All in one workspace.</p>
          </div>
          {mfa ? (
            <>
              <div className="auth-context-item">
                <ShieldCheck size={18} />
                <span>This extra step helps keep your account secure.</span>
              </div>
              <div className="auth-context-item">
                <LockKeyhole size={18} />
                <span>Keep your recovery codes somewhere safe in case you lose access to your authenticator.</span>
              </div>
              <div className="auth-context-item">
                <Building2 size={18} />
                <span>Your organization chooses when two-step verification is required.</span>
              </div>
            </>
          ) : accessMode ? (
            <>
              <div className="auth-context-item">
                <Clock3 size={18} />
                <span>Every request stays pending until an administrator reviews it.</span>
              </div>
              <div className="auth-context-item">
                <ShieldCheck size={18} />
                <span>An administrator needs to approve your request before you can sign in.</span>
              </div>
              <div className="auth-context-item">
                <UserPlus size={18} />
                <span>Your administrator will arrange your sign-in method and workspace access.</span>
              </div>
            </>
          ) : (
            <>
              <div className="auth-context-item">
                <ShieldCheck size={18} />
                <span>{bootstrapRequired ? "Your owner account manages this installation and its workspaces." : "Use the work email associated with your workspace."}</span>
              </div>
              <div className="auth-context-item">
                <Building2 size={18} />
                <span>
                  {bootstrapRequired
                    ? "Keep your owner credentials somewhere secure."
                    : hasConfiguredSso
                    ? "Your organization manages sign-in and workspace access."
                    : "Received a temporary password? Sign in, then choose a password of your own."}
                </span>
              </div>
              <div className="auth-context-item">
                <LockKeyhole size={18} />
                <span>{bootstrapRequired ? "After setup, connect a model provider and give your team access." : "New here? Request access and your workspace administrator will help you get started."}</span>
              </div>
            </>
          )}
        </aside>
      </section>
    </main>
  );
}

function providerFromId(providers: AuthProviderOption[], id: string): AuthProviderOption | null {
  return providers.find((provider) => provider.id === id) ?? providers[0] ?? null;
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function providerStatusText(provider: AuthProviderOption): string {
  return `Sign in with ${provider.name}${provider.enforced ? " · Required by your organization" : ""}${provider.mfa_enforced ? " · Two-step verification required" : ""}`;
}

/* Shown after a successful sign-in with an admin-issued temporary password:
 * the account must choose its own password before entering the workspace. */
export function ForcedPasswordScreen({
  displayName,
  onSubmit,
  onCancel,
}: {
  displayName: string;
  onSubmit: (newPassword: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newPasswordId = useId();
  const confirmPasswordId = useId();
  const errorId = useId();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (newPassword.length < 12) {
      setError("Use a password with at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSubmit(newPassword);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The password was not changed.");
      setPending(false);
    }
  }

  return (
    <main className="auth-screen auth-refresh auth-refresh-single">
      <section className="auth-shell" aria-labelledby="forced-password-title">
        <div className="auth-panel" aria-busy={pending}>
          <div className="auth-heading">
            <span className="auth-eyebrow">One last step</span>
            <h1 id="forced-password-title">Set a new password</h1>
            <p>
              Welcome, {displayName}. Your temporary password worked — choose your own password to finish signing
              in.
            </p>
          </div>
          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <label className="auth-field" htmlFor={newPasswordId}>
              <span>New password</span>
              <span className="auth-input-wrap auth-password-wrap">
                <LockKeyhole size={17} />
                <input
                  id={newPasswordId}
                  type={passwordVisible ? "text" : "password"}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="At least 12 characters"
                  aria-describedby={error ? errorId : undefined}
                  required
                />
                <button className="auth-reveal" type="button" aria-label={passwordVisible ? "Hide password" : "Show password"}
                  aria-pressed={passwordVisible} onClick={() => setPasswordVisible((visible) => !visible)}>
                  {passwordVisible ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </span>
            </label>
            <label className="auth-field" htmlFor={confirmPasswordId}>
              <span>Confirm password</span>
              <span className="auth-input-wrap">
                <LockKeyhole size={17} />
                <input
                  id={confirmPasswordId}
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Repeat password"
                  aria-describedby={error ? errorId : undefined}
                  required
                />
              </span>
            </label>
            {error && (
              <div className="auth-error" id={errorId} role="alert">
                <LockKeyhole size={16} />
                <span>{error}</span>
              </div>
            )}
            <div className="auth-actions">
              <button
                className="primary-button auth-submit-button"
                type="submit"
                disabled={pending}
                data-tooltip="Save your new password and enter the workspace"
              >
                {pending ? <Loader2 className="auth-spinner" size={17} /> : <KeyRound size={17} />}
                <span>Set password and continue</span>
                {!pending && <ArrowRight size={16} />}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={pending}
                onClick={onCancel}
                data-tooltip="Return to the sign-in screen without changing the password"
              >
                Back to sign-in
              </button>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
