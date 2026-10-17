import { Loader2, LockKeyhole, LogOut, RefreshCw } from "lucide-react";
import { BrandArtwork } from "./Primitives";
import { readBrandBoot } from "../lib/brandTheme";
import { DEFAULT_BRAND_ICON, DEFAULT_BRAND_NAME, brandLockup } from "../lib/brandIcon";

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
  const brandName = boot?.name?.trim() || DEFAULT_BRAND_NAME;
  // The stock favicon is not a tenant icon; only a verified custom one may
  // stand in when no logo was cached.
  const bootFavicon = boot?.faviconVerified ? boot.favicon?.trim() || "" : "";
  const brandMark = brandLockup({
    chat_brand_name: boot?.displayName ?? brandName,
    logo_url: boot?.logo,
    icon_url: bootFavicon !== DEFAULT_BRAND_ICON ? bootFavicon : null,
  });

  return (
    <main className="auth-screen">
      <section className="auth-shell" aria-labelledby="auth-title">
        <div className="auth-panel" aria-busy={!error}>
          <div className={`auth-brand${brandMark.source === "logo" ? " has-logo-image" : ""}`} aria-label={brandName}>
            {brandMark.imageUrl ? (
              <span className="auth-brand-mark">
                <BrandArtwork lockup={brandMark} label={brandName} />
              </span>
            ) : (
              <BrandArtwork lockup={brandMark} label={brandName} markSize={34} />
            )}
            <div>
              {brandMark.name && <span>{brandMark.name}</span>}
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
