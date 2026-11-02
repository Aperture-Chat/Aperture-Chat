import clsx from "clsx";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";

export type RailSwitchOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  count?: number;
  tooltip?: string;
};

function RailStop<T extends string>({
  option,
  selected,
  disabled,
  onChoose,
}: {
  option: RailSwitchOption<T>;
  selected: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      className={clsx("rail-switch-option", selected && "is-active")}
      data-tooltip={option.tooltip}
      onClick={onChoose}
    >
      {option.icon}
      <span className="rail-switch-label">{option.label}</span>
      {option.count !== undefined && <b className="rail-switch-count"> {option.count}</b>}
    </button>
  );
}

const RAIL_KEY_STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** The stop a key lands on, or null for a key the rail does not handle. */
function railKeyTarget(key: string, index: number, count: number): number | null {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = RAIL_KEY_STEPS[key];
  return step ? (index + step + count) % count : null;
}

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
  disabled = false,
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
  /** Keep the current stop visible while refusing every change. */
  disabled?: boolean;
  className?: string;
}) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const style = { "--rail-count": options.length, "--rail-index": index } as CSSProperties;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = railKeyTarget(event.key, index, options.length);
    if (next === null) return;
    event.preventDefault();
    onChange(options[next].value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  return (
    <div
      className={clsx("rail-switch", block && "is-block", stacked && "is-stacked", disabled && "is-disabled", className)}
      role="radiogroup"
      aria-label={ariaLabel}
      style={style}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => (
        <RailStop
          key={option.value}
          option={option}
          selected={option.value === value}
          disabled={disabled}
          onChoose={() => onChange(option.value)}
        />
      ))}
    </div>
  );
}
