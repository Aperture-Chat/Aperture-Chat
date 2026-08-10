import clsx from "clsx";
import { Check } from "lucide-react";
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type FocusEvent,
  type OptionHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

/* Drop-in replacement for <select> that keeps the real element in the DOM —
 * so form semantics, existing CSS hooks, and tests (fireEvent.change) all
 * keep working — but suppresses the operating system's native popup and shows
 * a platform-styled listbox instead (the same visual language as the chat
 * model menu). Focus never leaves the native select; the popup is a purely
 * visual affordance, so assistive tech keeps the plain select experience.
 *
 * Usage: replace <select …>{options}</select> with
 * <SelectControl …>{options}</SelectControl>. Only flat <option> children are
 * supported (no optgroup — nothing in the app uses one). */

type Item = { value: string; label: string; disabled: boolean };

function textContent(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement(node)) return textContent((node.props as { children?: ReactNode }).children);
  return "";
}

function collectItems(children: ReactNode, items: Item[] = []): Item[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === "option") {
      const props = child.props as OptionHTMLAttributes<HTMLOptionElement>;
      const label = textContent(props.children);
      items.push({
        value: props.value != null ? String(props.value) : label,
        label,
        disabled: Boolean(props.disabled),
      });
    } else {
      const nested = (child.props as { children?: ReactNode }).children;
      if (nested) collectItems(nested, items);
    }
  });
  return items;
}

/* Sets the select's value the way testing-library does, so React's onChange
 * fires exactly as if the user had picked the option natively. */
function commitNativeValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const MENU_MAX_HEIGHT = 280;

type MenuPlacement = { left: number; width: number; top?: number; bottom?: number };

export function SelectControl(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { children, onMouseDown, onKeyDown, onBlur, ...rest } = props;
  const selectRef = useRef<HTMLSelectElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef<{ buffer: string; at: number }>({ buffer: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const [activeValue, setActiveValue] = useState<string>("");

  const items = collectItems(children);
  const enabledItems = items.filter((item) => !item.disabled);
  const selectedValue = rest.value != null ? String(rest.value) : (selectRef.current?.value ?? "");

  const openMenu = useCallback(() => {
    const select = selectRef.current;
    if (!select) return;
    const rect = select.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < MENU_MAX_HEIGHT + 16 && rect.top > spaceBelow;
    setPlacement({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
      width: rect.width,
      ...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
    setActiveValue(select.value);
    setOpen(true);
  }, []);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setPlacement(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      /* The menu scrolls internally (arrow keys, wheel) — only close when the
       * page or a surrounding container scrolls away from the anchor. */
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      closeMenu();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open, closeMenu]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeValue]);

  /* The menu sizes to its widest option, so it can end up wider than the
   * anchoring select — nudge it back inside the viewport after it renders. */
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !placement) return;
    const rect = menuRef.current.getBoundingClientRect();
    const overflow = rect.right - (window.innerWidth - 8);
    if (overflow > 0) {
      setPlacement((current) =>
        current ? { ...current, left: Math.max(8, current.left - overflow) } : current,
      );
    }
  }, [open, placement]);

  const commit = useCallback(
    (value: string) => {
      const select = selectRef.current;
      if (select && select.value !== value) commitNativeValue(select, value);
      closeMenu();
    },
    [closeMenu],
  );

  const moveActive = useCallback(
    (delta: number) => {
      if (!enabledItems.length) return;
      const index = enabledItems.findIndex((item) => item.value === activeValue);
      const next = index === -1 ? (delta > 0 ? 0 : enabledItems.length - 1) : Math.min(Math.max(index + delta, 0), enabledItems.length - 1);
      setActiveValue(enabledItems[next].value);
    },
    [activeValue, enabledItems],
  );

  const handleMouseDown = (event: MouseEvent<HTMLSelectElement>) => {
    onMouseDown?.(event);
    if (event.defaultPrevented || rest.disabled) return;
    /* Swallow the native popup; the branded menu opens instead. */
    event.preventDefault();
    selectRef.current?.focus();
    if (open) closeMenu();
    else openMenu();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSelectElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || rest.disabled) return;
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (enabledItems.length) setActiveValue(enabledItems[event.key === "Home" ? 0 : enabledItems.length - 1].value);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeValue);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // only dismiss the menu, not a surrounding modal
      closeMenu();
    } else if (event.key === "Tab") {
      closeMenu();
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const now = Date.now();
      const state = typeahead.current;
      state.buffer = now - state.at > 700 ? event.key : state.buffer + event.key;
      state.at = now;
      const match = enabledItems.find((item) => item.label.toLowerCase().startsWith(state.buffer.toLowerCase()));
      if (match) setActiveValue(match.value);
    }
  };

  const handleBlur = (event: FocusEvent<HTMLSelectElement>) => {
    onBlur?.(event);
    closeMenu();
  };

  return (
    <>
      <select
        {...rest}
        ref={selectRef}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      >
        {children}
      </select>
      {open &&
        placement &&
        createPortal(
          <div
            className="apx-select-menu"
            ref={menuRef}
            aria-hidden="true"
            style={{
              left: placement.left,
              top: placement.top,
              bottom: placement.bottom,
              minWidth: placement.width,
            }}
            onMouseDown={(event) => event.preventDefault() /* keep focus on the select */}
          >
            {items.map((item) => (
              <button
                type="button"
                key={item.value}
                tabIndex={-1}
                disabled={item.disabled}
                className={clsx(
                  "apx-select-option",
                  item.value === selectedValue && "is-selected",
                  item.value === activeValue && "is-active",
                )}
                onClick={() => commit(item.value)}
              >
                <span>{item.label}</span>
                {item.value === selectedValue && <Check size={14} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
