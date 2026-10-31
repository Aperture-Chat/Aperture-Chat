import type { LucideIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

const AnnounceContext = createContext<(message: string) => void>(() => {});

/** Says a finished action aloud for people who cannot see the row change. */
export function useAnnounce() {
  return useContext(AnnounceContext);
}

export function AccountAnnouncer({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  return (
    <AnnounceContext.Provider value={setMessage}>
      {children}
      <div className="sr-only account-live-region" role="status" aria-live="polite">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

export type EscapeLayer = { current: () => void };

export const EscapeLayersContext = createContext<EscapeLayer[]>([]);

/** While active, this layer takes Escape before the drawer does, wherever focus
 * is. The most recently opened layer goes first. */
export function useEscapeLayer(active: boolean, onEscape: () => void) {
  const layers = useContext(EscapeLayersContext);
  const layer = useRef(onEscape);
  layer.current = onEscape;
  useEffect(() => {
    if (!active) return;
    layers.push(layer);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
    };
  }, [active, layers]);
}

/** Escape closes a clean form. A form with typed text keeps it, and says how to
 * leave. Returns whether that note should show. */
export function useFormEscape(active: boolean, dirty: boolean, onClose: () => void) {
  const [held, setHeld] = useState(false);
  useEscapeLayer(active, () => {
    if (dirty) setHeld(true);
    else onClose();
  });
  return held && dirty;
}

export const UNSAVED_NOTE = "Unsaved changes. Choose Cancel to discard them.";

/** Puts focus on the first field when a form opens. */
export function useFirstFieldFocus<T extends HTMLElement>() {
  const formRef = useRef<T>(null);
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('input:not([type="file"]), textarea')?.focus();
  }, []);
  return formRef;
}

/** Sends focus back to the key that opened something, once it is on screen again. */
export function useReturnFocus() {
  const pending = useRef<string | null>(null);
  return {
    returnTo: (key: string) => {
      pending.current = key;
    },
    target: (key: string) => (element: HTMLElement | null) => {
      if (!element || pending.current !== key || element.matches(":disabled")) return;
      pending.current = null;
      element.focus({ preventScroll: true });
    },
  };
}

/** A titled group of the drawer. The title is the only label a group needs. */
export function AccountSection({
  title,
  aside,
  className,
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className={className ? `account-section ${className}` : "account-section"} aria-labelledby={titleId}>
      <div className="account-section-heading">
        <h3 id={titleId}>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The left two thirds of every row: a recessed icon tile and two lines of text. */
export function AccountRowBody({
  icon: Icon,
  title,
  detail,
}: {
  icon: LucideIcon;
  title: string;
  detail?: ReactNode;
}) {
  return (
    <>
      <span className="account-row-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className="account-row-copy">
        <strong>{title}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </>
  );
}

/** Asks in place, with the safe answer focused, so nothing leaves the drawer. */
export function AccountConfirm({
  message,
  confirmLabel,
  confirmName,
  cancelLabel,
  cancelName,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel: string;
  confirmName?: string;
  cancelLabel: string;
  cancelName?: string;
  destructive?: boolean;
  /** Keeps both keys focusable, so focus survives while the request runs. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEscapeLayer(!busy, onCancel);
  useEffect(() => {
    cancelRef.current?.focus({ preventScroll: true });
    groupRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <div ref={groupRef} className="account-confirm" role="group" aria-label={message}>
      <p>{message}</p>
      <div className="drawer-form-actions">
        <button
          ref={cancelRef}
          className="secondary-button"
          type="button"
          aria-label={cancelName}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onCancel();
          }}
        >
          {cancelLabel}
        </button>
        <button
          className={destructive ? "danger-button" : "primary-button"}
          type="button"
          aria-label={confirmName}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
