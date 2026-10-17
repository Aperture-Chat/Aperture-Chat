import clsx from "clsx";
import { Check, ChevronDown, ChevronUp, Lock, ShieldCheck, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  DEFAULT_BRAND_MARK,
  DEFAULT_BRAND_NAME,
  brandLockup,
  compactBrandSources,
  isCompactBrandImage,
  type BrandAssets,
  type BrandLockup,
} from "../lib/brandIcon";

/** The default Aperture Chat icon, used wherever a tenant has not set its own. */
export function ApertureMark({
  size = 28,
  className,
  title = "Aperture",
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <img
      className={clsx("aperture-mark", className)}
      src={DEFAULT_BRAND_MARK}
      width={size}
      height={size}
      alt={title}
    />
  );
}

/** A compact brand slot: the first source that loads roughly square, else
 * the default Aperture Chat icon. A wordmark shrunk to icon size is unreadable, so wide
 * artwork is skipped here while full-size slots keep showing it. */
export function BrandIcon({
  sources,
  size = 28,
  title = "Aperture",
  className,
}: {
  sources: ReadonlyArray<string | null | undefined>;
  size?: number;
  title?: string;
  className?: string;
}) {
  const [rejected, setRejected] = useState<readonly string[]>([]);
  const [verified, setVerified] = useState<string | null>(null);
  const src = sources.map((source) => source?.trim() ?? "").find((source) => source && !rejected.includes(source));
  if (!src) return <ApertureMark size={size} title={title} className={className} />;
  return (
    <img
      key={src}
      src={src}
      alt=""
      className={className}
      // Hidden until checked so a wide image never flashes in the slot.
      data-brand-pending={verified === src ? undefined : ""}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (isCompactBrandImage(image.naturalWidth, image.naturalHeight)) setVerified(src);
        else setRejected((current) => [...current, src]);
      }}
      onError={() => setRejected((current) => [...current, src])}
    />
  );
}

/** Full-size artwork for a lockup, or the default icon without one. */
export function BrandArtwork({
  lockup,
  label,
  className,
  markSize = 28,
}: {
  lockup: BrandLockup;
  label: string;
  className?: string;
  markSize?: number;
}) {
  if (!lockup.imageUrl) return <ApertureMark size={markSize} title={label} />;
  // Decorative beside a visible name; otherwise the image is the name.
  return <img src={lockup.imageUrl} alt={lockup.name ? "" : label} className={className} />;
}

export function Logo({ compact = false, brand }: { compact?: boolean; brand?: BrandAssets | null }) {
  const label = brand?.chat_brand_name?.trim() || DEFAULT_BRAND_NAME;
  if (compact) {
    return (
      <div className="logo logo-compact" aria-label={label}>
        <span className="logo-mark">
          <BrandIcon sources={compactBrandSources(brand)} size={28} title={label} className="custom-logo-mark" />
        </span>
      </div>
    );
  }
  const lockup = brandLockup(brand);
  return (
    <div className={clsx("logo", lockup.source === "logo" && "has-logo-image", !lockup.name && "logo-image-only")} aria-label={label}>
      <span className="logo-mark">
        <BrandArtwork lockup={lockup} label={label} className="custom-logo-mark" />
      </span>
      {lockup.name && <span className="logo-word">{lockup.name}</span>}
    </div>
  );
}

export function Pill({
  children,
  tone = "neutral",
  icon,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
  icon?: ReactNode;
}) {
  return (
    <span className={clsx("pill", `pill-${tone}`)}>
      {icon}
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  disabled = false,
  onChange,
  label,
  tooltip,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
  /** Optional descriptive tooltip; falls back to the aria-label via the tooltip engine. */
  tooltip?: string;
}) {
  if (onChange) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        data-tooltip={tooltip}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx("toggle", checked && "is-on", disabled && "is-disabled")}
      >
        <span />
      </button>
    );
  }
  return (
    <span className={clsx("toggle", checked && "is-on", disabled && "is-disabled")} aria-hidden="true">
      <span />
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  children,
  actions,
  className,
  collapsible = true,
  defaultCollapsed = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const canCollapse = collapsible && Boolean(title);

  return (
    <section className={clsx("panel", collapsed && "is-panel-collapsed", className)}>
      {(title || actions) && (
        <div
          className={clsx("panel-header", canCollapse && "panel-header-toggle")}
          onClick={
            canCollapse
              ? (event) => {
                  /* The header doubles as the expander; interactive children
                   * (export buttons, the chevron itself) keep their own
                   * behavior without also toggling the panel. */
                  const target = event.target as HTMLElement;
                  if (target.closest("button, a, input, select, label")) return;
                  setCollapsed((value) => !value);
                }
              : undefined
          }
        >
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {(actions || canCollapse) && (
            <div className="panel-actions">
              {actions}
              {canCollapse && (
                <button
                  className="icon-button panel-collapse-button"
                  type="button"
                  aria-label={collapsed ? "Expand panel" : "Collapse panel"}
                  data-tooltip={
                    collapsed
                      ? "Expand this panel to show its content again"
                      : "Collapse this panel to hide its content and save space"
                  }
                  aria-expanded={!collapsed}
                  onClick={() => setCollapsed((value) => !value)}
                >
                  {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {!collapsed && children}
    </section>
  );
}

/**
 * Reserves the width of the widest possible label so state-driven text swaps
 * ("Save" → "Saving…", "Copy" → "Copied") never resize the control.
 */
export function StableLabel({
  label,
  reserve,
}: {
  label: ReactNode;
  reserve: string[];
}) {
  return (
    <span className="stable-label">
      {reserve.map((text) => (
        <span key={text} aria-hidden="true" data-ghost>
          {text}
        </span>
      ))}
      <span>{label}</span>
    </span>
  );
}

/** An in-flow informational banner with a close button. Dismissal persists
 * per device so the same notice does not keep reappearing. */
export function DismissibleNotice({
  id,
  label = "Workspace",
  children,
}: {
  id: string;
  label?: string;
  children: ReactNode;
}) {
  const storageKey = `aperture-notice-dismissed:${id}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(storageKey) === "true";
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div className="inline-warning workspace-notice" role="status">
      <Pill tone="warning">{label}</Pill>
      <span>{children}</span>
      <button
        className="icon-button notice-close-button"
        type="button"
        aria-label="Dismiss this notice"
        data-tooltip="Hide this notice on this device"
        onClick={() => {
          setDismissed(true);
          try {
            window.localStorage.setItem(storageKey, "true");
          } catch {
            /* Private-mode storage failures just make the dismissal non-sticky. */
          }
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function SecureNotice({ children }: { children: ReactNode }) {
  return (
    <div className="secure-notice">
      <ShieldCheck size={18} />
      <span>{children}</span>
    </div>
  );
}

export function HiddenSecretNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div className={clsx("hidden-secret", compact && "compact")}>
      <Lock size={16} />
      <div>
        <strong>Secrets hidden by org policy</strong>
        {!compact && <p>Sensitive data and secrets are not shown in this session.</p>}
      </div>
    </div>
  );
}

export function CheckLine({ children }: { children: ReactNode }) {
  return (
    <div className="check-line">
      <Check size={14} />
      <span>{children}</span>
    </div>
  );
}
