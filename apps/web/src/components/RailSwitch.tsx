import clsx from "clsx";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

export type RailSwitchOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
  tooltip?: string;
};

/**
 * Single-choice switch in the same tactile rail as the Drafts Document/Deck
 * toggle: a recessed track with a lit thumb that slides to the selection.
 * The Drafts switch has two fixed stops; this one takes two to five options.
 * Radio semantics with arrow-key movement.
 */
export function RailSwitch<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  block = false,
  stacked = false,
  className,
}: {
  options: RailSwitchOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Stretch to the container width instead of hugging the labels. */
  block?: boolean;
  /** Icon above the label, for compact multi-option pickers. */
  stacked?: boolean;
  className?: string;
}) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const style = { "--rail-count": options.length, "--rail-index": index } as CSSProperties;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const jump = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
    if (!step && jump === null) return;
    event.preventDefault();
    const next = jump ?? (index + step + options.length) % options.length;
    onChange(options[next].value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  return (
    <div
      className={clsx("rail-switch", block && "is-block", stacked && "is-stacked", className)}
      role="radiogroup"
      aria-label={ariaLabel}
      style={style}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={clsx("rail-switch-option", selected && "is-active")}
            data-tooltip={option.tooltip}
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            <span className="rail-switch-label">{option.label}</span>
            {option.count !== undefined && <b className="rail-switch-count"> {option.count}</b>}
          </button>
        );
      })}
    </div>
  );
}
