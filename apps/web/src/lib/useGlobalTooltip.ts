import { useEffect } from "react";

/** Elements the shared tooltip watches. Text comes from data-tooltip, then
 * field context for form controls, then aria-label, then title (which is
 * absorbed so the native tooltip never doubles up with the themed one). */
const TOOLTIP_TARGET_SELECTOR =
  [
    "button",
    '[role="button"]',
    "a[href]",
    "summary",
    "[data-tooltip]",
    'input:not([type="hidden"])',
    "select",
    "textarea",
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="slider"]',
  ].join(", ");

const SHOW_DELAY_MS = 350;
const EDGE_MARGIN = 8;
const TARGET_GAP = 10;

/** Mounts a single platform-wide tooltip layer. Buttons, links, summaries,
 * form fields, and [data-tooltip] elements get a themed tooltip on hover and
 * keyboard focus. */
export function useGlobalTooltip(): void {
  useEffect(() => {
    const tip = document.createElement("div");
    tip.className = "apx-tooltip";
    tip.setAttribute("role", "tooltip");
    tip.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "apx-tooltip-label";
    const arrow = document.createElement("span");
    arrow.className = "apx-tooltip-arrow";
    tip.append(label, arrow);
    document.body.appendChild(tip);

    let showTimer = 0;
    let pendingTarget: HTMLElement | null = null;
    let activeTarget: HTMLElement | null = null;

    function tooltipTextFor(target: HTMLElement): string {
      const title = target.getAttribute("title");
      if (title) {
        if (!target.dataset.tooltip) target.dataset.tooltip = title;
        target.removeAttribute("title");
      }
      const authoredTooltip = target.dataset.tooltip?.trim();
      if (authoredTooltip) return authoredTooltip;
      if (isFieldTarget(target)) {
        const fieldTooltip = fieldTooltipFor(target);
        if (fieldTooltip) return fieldTooltip;
      }
      return (target.getAttribute("aria-label") ?? "").trim();
    }

    function hide() {
      window.clearTimeout(showTimer);
      showTimer = 0;
      pendingTarget = null;
      activeTarget = null;
      tip.classList.remove("is-visible");
      tip.setAttribute("aria-hidden", "true");
    }

    function show(target: HTMLElement) {
      const text = tooltipTextFor(target);
      if (!text || !target.isConnected) return;
      pendingTarget = null;
      activeTarget = target;
      label.textContent = text;
      tip.setAttribute("aria-hidden", "false");

      // Make it measurable before computing the final position.
      tip.style.left = "0px";
      tip.style.top = "0px";
      tip.classList.add("is-visible");
      const rect = target.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const left = Math.min(
        Math.max(centerX - tipRect.width / 2, EDGE_MARGIN),
        window.innerWidth - tipRect.width - EDGE_MARGIN,
      );
      let top = rect.top - tipRect.height - TARGET_GAP;
      let below = false;
      if (top < EDGE_MARGIN) {
        top = rect.bottom + TARGET_GAP;
        below = true;
      }
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
      tip.classList.toggle("is-below", below);
      const arrowX = Math.min(
        Math.max(centerX - left, 14),
        tipRect.width - 14,
      );
      tip.style.setProperty("--apx-tooltip-arrow-x", `${Math.round(arrowX)}px`);
    }

    function findTarget(node: EventTarget | null): HTMLElement | null {
      if (!(node instanceof Element)) return null;
      return node.closest<HTMLElement>(TOOLTIP_TARGET_SELECTOR);
    }

    function onMouseOver(event: MouseEvent) {
      const target = findTarget(event.target);
      if (!target || target === activeTarget || target === pendingTarget) return;
      hide();
      pendingTarget = target;
      showTimer = window.setTimeout(() => show(target), SHOW_DELAY_MS);
    }

    function onMouseOut(event: MouseEvent) {
      const target = findTarget(event.target);
      if (!target) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) {
        return;
      }
      if (target === activeTarget || target === pendingTarget) hide();
    }

    function onFocusIn(event: FocusEvent) {
      const target = findTarget(event.target);
      if (!target || !target.matches(":focus-visible")) return;
      hide();
      show(target);
    }

    function onFocusOut(event: FocusEvent) {
      const target = findTarget(event.target);
      if (target && (target === activeTarget || target === pendingTarget)) hide();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") hide();
    }

    // jsdom (tests) has no matchMedia; treat that environment as hover-capable.
    const hoverCapable =
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(hover: hover)").matches;
    if (hoverCapable) {
      document.addEventListener("mouseover", onMouseOver);
      document.addEventListener("mouseout", onMouseOut);
    }
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("mousedown", hide);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);

    // If the anchor element unmounts (view switch, async re-render) no
    // mouseout/mousedown ever fires, so the tooltip would linger orphaned.
    const unmountWatcher = new MutationObserver(() => {
      if (
        (activeTarget && !activeTarget.isConnected) ||
        (pendingTarget && !pendingTarget.isConnected)
      ) {
        hide();
      }
    });
    unmountWatcher.observe(document.body, { childList: true, subtree: true });

    return () => {
      unmountWatcher.disconnect();
      if (hoverCapable) {
        document.removeEventListener("mouseover", onMouseOver);
        document.removeEventListener("mouseout", onMouseOut);
      }
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("mousedown", hide);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.clearTimeout(showTimer);
      tip.remove();
    };
  }, []);
}

function isFieldTarget(target: HTMLElement): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    target.getAttribute("role") === "textbox" ||
    target.getAttribute("role") === "combobox"
  );
}

function fieldTooltipFor(target: HTMLElement): string {
  const label = labelTextFor(target);
  const context = contextTextFor(target, label);
  const control =
    target instanceof HTMLSelectElement
      ? "select"
      : target instanceof HTMLTextAreaElement ||
          target.isContentEditable ||
          target.getAttribute("role") === "textbox"
        ? "textarea"
        : target instanceof HTMLInputElement
          ? target.type || "text"
          : "field";
  const placeholder =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      ? target.placeholder.trim()
      : "";

  if (!label && !context && !placeholder) return "";

  const fieldName = label || placeholder || "this field";
  const contextPhrase = context ? ` in ${context}` : "";

  if (target instanceof HTMLSelectElement) {
    const optionLabels = Array.from(target.options)
      .map((option) => option.textContent?.trim() ?? "")
      .filter(Boolean)
      .slice(0, 4);
    const optionText = optionLabels.length
      ? ` Choices include ${joinPreview(optionLabels)}.`
      : "";
    return `Choose ${fieldName}${contextPhrase}.${optionText}`.trim();
  }

  if (target instanceof HTMLInputElement) {
    if (control === "checkbox") {
      return `Turn ${fieldName} on or off${contextPhrase}.`;
    }
    if (control === "radio") {
      return `Select ${fieldName}${contextPhrase}.`;
    }
    if (control === "file") {
      const accepts = target.accept.trim();
      return accepts
        ? `Choose files for ${fieldName}${contextPhrase}. Accepted formats: ${accepts}.`
        : `Choose files for ${fieldName}${contextPhrase}.`;
    }
    if (control === "password") {
      return `Enter the hidden ${fieldName}${contextPhrase}. The value stays masked while you type.`;
    }
    if (control === "color") {
      return `Pick the ${fieldName}${contextPhrase}. The selected color applies immediately.`;
    }
    if (control === "time" || control === "datetime-local" || control === "date") {
      return `Set ${fieldName}${contextPhrase}.`;
    }
    if (control === "number" || control === "range") {
      return `Set the numeric ${fieldName}${contextPhrase}.`;
    }
    const example = placeholder ? ` Example: ${placeholder}.` : "";
    return `Enter ${fieldName}${contextPhrase}.${example}`.trim();
  }

  const example = placeholder ? ` Example: ${placeholder}.` : "";
  return `Write ${fieldName}${contextPhrase}.${example}`.trim();
}

function labelTextFor(target: HTMLElement): string {
  const labelledBy = target.getAttribute("aria-labelledby");
  const labelledByText = labelledBy
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .map(cleanText)
    .filter(Boolean)
    .join(" ");
  if (labelledByText) return labelledByText;

  const id = target.getAttribute("id");
  if (id) {
    const explicitLabel = document.querySelector<HTMLLabelElement>(
      `label[for="${cssEscapeForSelector(id)}"]`,
    );
    const text = explicitLabel ? cleanedLabelText(explicitLabel) : "";
    if (text) return text;
  }

  const wrappingLabel = target.closest("label");
  if (wrappingLabel) {
    const text = cleanedLabelText(wrappingLabel);
    if (text) return text;
  }

  return cleanText(target.getAttribute("aria-label") ?? "");
}

function cleanedLabelText(label: HTMLLabelElement): string {
  const clone = label.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll("input, select, textarea, button, svg, option")
    .forEach((node) => node.remove());
  return cleanText(clone.textContent ?? "");
}

function contextTextFor(target: HTMLElement, label: string): string {
  const ignored = new Set(
    [label, target.getAttribute("aria-label") ?? ""].map(cleanText).filter(Boolean),
  );
  let current = target.parentElement;
  let depth = 0;
  while (current && depth < 8) {
    const labelledBy = current.getAttribute("aria-labelledby");
    const labelledByText = labelledBy
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .map(cleanText)
      .filter(Boolean)
      .join(" ");
    const ariaLabel = cleanText(current.getAttribute("aria-label") ?? "");
    const heading = directHeadingText(current);
    const candidate = labelledByText || ariaLabel || heading;
    if (candidate && !ignored.has(candidate)) return candidate;
    current = current.parentElement;
    depth += 1;
  }
  return "";
}

function directHeadingText(element: HTMLElement): string {
  const heading = element.querySelector<HTMLElement>(
    ":scope > h1, :scope > h2, :scope > h3, :scope > header h1, :scope > header h2, :scope > header h3, :scope > header strong",
  );
  return cleanText(heading?.textContent ?? "");
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function joinPreview(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, or ${values[values.length - 1]}`;
}

function cssEscapeForSelector(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}
