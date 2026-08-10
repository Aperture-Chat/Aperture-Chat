import { EllipsisVertical, Share, Smartphone, SquarePlus, X } from "lucide-react";
import { useId, useState } from "react";
import { getCapturedInstallPrompt, type MobilePlatform } from "../lib/pwa";
import { ApertureMark } from "./Primitives";

/* Prompt to put the workspace on the phone's home screen with the tenant's
 * own icon and name (served per-tenant by /api/pwa/*). Android Chromium
 * exposes a real install API, so when its prompt event was captured the
 * primary button opens the native install sheet. iOS has no install API —
 * Apple only allows installs through the browser's share menu — and Android
 * browsers that never fired the event (or an already-installed app) get the
 * browser-menu route, so both of those paths show honest manual steps
 * instead of a button that couldn't work. */
export function PwaInstallPrompt({
  platform,
  brandName,
  brandLogoUrl,
  onDismiss,
}: {
  platform: MobilePlatform;
  brandName: string;
  brandLogoUrl: string | null;
  onDismiss: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  const titleId = useId();
  const oneTapInstall = platform === "android" && Boolean(getCapturedInstallPrompt());

  async function installOnAndroid() {
    const installPrompt = getCapturedInstallPrompt();
    if (!installPrompt) {
      onDismiss();
      return;
    }
    setInstalling(true);
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } finally {
      /* The native sheet was answered either way; don't nag this device again. */
      onDismiss();
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onDismiss}>
      <section
        className="modal pwa-install-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-icon">
            <Smartphone size={20} />
          </span>
          <div>
            <h2 id={titleId}>Add {brandName} to your home screen</h2>
            <p>
              {oneTapInstall
                ? "Install for one-tap, full-screen access."
                : "One tap from your home screen, full screen."}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close install prompt"
            data-tooltip="Close without installing; reopen any time from Install app in the sidebar"
            onClick={onDismiss}
          >
            <X size={17} />
          </button>
        </div>
        <div className="pwa-install-preview">
          <span className="pwa-install-preview-icon">
            {brandLogoUrl ? <img src={brandLogoUrl} alt="" /> : <ApertureMark size={30} />}
          </span>
          <span className="pwa-install-preview-name">
            <strong>{brandName}</strong>
            <span>Installs with this icon and name</span>
          </span>
        </div>
        {platform === "ios" && (
          <ol className="pwa-install-steps">
            <li>
              <span className="pwa-install-step-badge">1</span>
              <span>
                Tap the <Share size={14} aria-label="Share" /> Share button in your browser
                toolbar.
              </span>
            </li>
            <li>
              <span className="pwa-install-step-badge">2</span>
              <span>
                Scroll the share sheet and choose <SquarePlus size={14} aria-hidden /> "Add to
                Home Screen".
              </span>
            </li>
            <li>
              <span className="pwa-install-step-badge">3</span>
              <span>Tap Add — {brandName} appears on your home screen.</span>
            </li>
          </ol>
        )}
        {platform === "android" && !oneTapInstall && (
          <ol className="pwa-install-steps">
            <li>
              <span className="pwa-install-step-badge">1</span>
              <span>
                Open your browser's <EllipsisVertical size={14} aria-label="Menu" /> menu.
              </span>
            </li>
            <li>
              <span className="pwa-install-step-badge">2</span>
              <span>Choose "Add to Home screen" or "Install app".</span>
            </li>
            <li>
              <span className="pwa-install-step-badge">3</span>
              <span>Confirm — {brandName} appears on your home screen.</span>
            </li>
          </ol>
        )}
        <div className="pwa-install-actions">
          {oneTapInstall ? (
            <>
              <button className="secondary-button" type="button" onClick={onDismiss}>
                Not now
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={installing}
                data-tooltip="Open this phone's install dialog for the app"
                onClick={() => void installOnAndroid()}
              >
                {installing ? "Opening install..." : "Install app"}
              </button>
            </>
          ) : (
            <button className="primary-button" type="button" onClick={onDismiss}>
              Got it
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
