import { Loader2, LockKeyhole, LogOut, RefreshCw } from "lucide-react";
import { ApertureMark } from "./Primitives";
import { readBrandBoot } from "../lib/brandTheme";

/* The stock favicon is not a tenant logo; only a cached custom icon may brand
 * the mark slot. Mirrors DEFAULT_FAVICON_HREF in App.tsx. */
const DEFAULT_FAVICON_HREF = "/favicon.svg";

/** Full-page hold shown while a stored session resumes, and the honest
 * recovery screen when that resume fails outside dev/demo builds. Rendered
 * instead of the workspace shell so the bundled sample identity never appears
 * in place of the real signed-in account. Branding comes from the boot cache
 * left by the previous load, so white-labeled installs keep their own name. */
export function SessionRestoreScreen({
  error,
  onRetry,
  onSignOut,
}: {
  error?: string | null;
  onRetry?: () => void;
  onSignOut?: () => void;
}) {
  const boot = readBrandBoot();
  const brandName = boot?.name?.trim() || "Aperture Chat";
  const bootFavicon = boot?.favicon?.trim() || "";
  const brandLogoUrl =
    bootFavicon && bootFavicon !== DEFAULT_FAVICON_HREF ? bootFavicon : null;

  return (
    <main className="auth-screen">
      <section className="auth-shell" aria-labelledby="auth-title">
        <div className="auth-panel" aria-busy={!error}>
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
              <strong>{error ? "Session recovery" : "Account sign-in"}</strong>
            </div>
          </div>

          {error ? (
            <>
              <div className="auth-heading">
                <h1 id="auth-title">Your workspace could not be loaded</h1>
                <p>
                  Your saved sign-in is still on this device; nothing was
                  changed. Retry the connection or sign in again.
                </p>
              </div>
              <div className="auth-error" role="alert">
                <LockKeyhole size={16} />
                <span>{error}</span>
              </div>
              <div className="auth-actions">
                <button
                  type="button"
                  className="primary-button auth-submit-button"
                  onClick={onRetry}
                >
                  <RefreshCw size={17} />
                  Try again
                </button>
                <button
                  type="button"
                  className="secondary-button auth-local-button"
                  onClick={onSignOut}
                >
                  <LogOut size={17} />
                  Sign in again
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="auth-heading">
                <h1 id="auth-title">Restoring your session</h1>
                <p>Confirming your account and loading workspace controls.</p>
              </div>
              <div className="auth-provider-status" role="status">
                <Loader2 className="auth-spinner" size={17} />
                <span>Contacting {brandName}...</span>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
