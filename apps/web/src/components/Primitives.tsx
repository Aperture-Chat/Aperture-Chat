import clsx from "clsx";
import { Check, ChevronDown, ChevronUp, Lock, ShieldCheck, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

const BLADE = "M32 8.4 C40.1 9.1 47.2 14.5 49.7 22 C44.2 21.1 39.1 23.8 35.7 29.4 C33.2 24.8 31.4 16.5 32 8.4 Z";
const ANGLES = [0, 60, 120, 180, 240, 300];

export function ApertureMark({
  size = 28,
  className,
  title = "Aperture",
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  const gradientId = useId();
  const maskId = useId();
  return (
    <svg
      className={clsx("aperture-mark", className)}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
    >
      <defs>
        <linearGradient id={gradientId} x1="14" y1="8" x2="50" y2="56" gradientUnits="userSpaceOnUse">
          {/* Stops read brand-mark variables so a tenant accent recolors the default mark. */}
          <stop offset="0" style={{ stopColor: "var(--brand-mark-1, #41d3e2)" }} />
          <stop offset=".52" style={{ stopColor: "var(--brand-mark-2, #0aa4b5)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand-mark-3, #066a78)" }} />
        </linearGradient>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#ffffff" />
          <circle cx="32" cy="32" r="6.4" fill="#000000" />
        </mask>
      </defs>
      <g fill={`url(#${gradientId})`} opacity="0.96" mask={`url(#${maskId})`}>
        {ANGLES.map((angle) => (
          <path key={angle} d={BLADE} transform={`rotate(${angle} 32 32)`} />
        ))}
      </g>
    </svg>
  );
}

export function Logo({
  compact = false,
  brandName = "Aperture Chat",
  logoUrl,
}: {
  compact?: boolean;
  brandName?: string;
  logoUrl?: string | null;
}) {
  const label = brandName.trim() || "Aperture Chat";
  return (
    <div className="logo" aria-label={label}>
      <span className="logo-mark">
        {logoUrl ? <img src={logoUrl} alt="" className="custom-logo-mark" /> : <ApertureMark size={28} title={label} />}
      </span>
      {!compact && <span className="logo-word">{label}</span>}
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
