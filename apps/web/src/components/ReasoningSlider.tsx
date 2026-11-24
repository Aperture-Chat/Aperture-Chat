import { RailSwitch, type RailSwitchOption } from "./RailSwitch";

/** Composer reasoning positions: fast = minimal effort, smart = deeper thinking. */
export type ReasoningLevel = "fast" | "balanced" | "smart";

export const REASONING_LEVELS: ReasoningLevel[] = ["fast", "balanced", "smart"];

export type ReasoningEffort = "minimal" | "medium" | "high";

// Providers receive low, medium, and high. Fast is sent as "minimal", the
// app's fast-path marker: the API forwards it to providers as "low" and also
// answers concisely, skips research steps, and prefers throughput routing.
// Balanced is explicit because model defaults differ (Sonnet 5.5 defaults to
// high, Opus and Haiku 5.5 to medium).
export const REASONING_EFFORT_BY_LEVEL: Record<ReasoningLevel, ReasoningEffort> = {
  fast: "minimal",
  balanced: "medium",
  smart: "high",
};

function reasoningStorageKey(userId: string) {
  return `aperture-reasoning-level-${userId}`;
}

export function loadReasoningLevel(userId: string): ReasoningLevel {
  try {
    const stored = localStorage.getItem(reasoningStorageKey(userId));
    return REASONING_LEVELS.includes(stored as ReasoningLevel) ? (stored as ReasoningLevel) : "balanced";
  } catch {
    return "balanced";
  }
}

export function storeReasoningLevel(userId: string, level: ReasoningLevel) {
  try {
    localStorage.setItem(reasoningStorageKey(userId), level);
  } catch {
    // Private-mode storage failures only lose the sticky preference.
  }
}

const REASONING_STOPS: RailSwitchOption<ReasoningLevel>[] = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "smart", label: "Smart" },
];

const REASONING_HELP: Record<ReasoningLevel, string> = {
  fast: "Quicker answers, less time thinking.",
  balanced: "A middle ground between speed and depth.",
  smart: "Takes longer and thinks it through.",
};

const AUTO_HELP = "Aperture picks the level for each message.";

export function reasoningHelp(level: ReasoningLevel, supported: boolean, modelName: string, auto = false) {
  if (!supported) return `${modelName} does not support reasoning levels.`;
  return auto ? AUTO_HELP : REASONING_HELP[level];
}

/** Every level named on its own stop, for chat's Send options and the Drafts settings. */
export function ReasoningRail({
  level,
  supported,
  auto = false,
  onChange,
}: {
  /** The user's level, or with `auto` the level picked for this request. */
  level: ReasoningLevel;
  supported: boolean;
  /** Auto is choosing: the rail shows the pick and cannot be moved. */
  auto?: boolean;
  onChange: (level: ReasoningLevel) => void;
}) {
  return (
    <RailSwitch
      block
      ariaLabel="Model reasoning level"
      options={REASONING_STOPS}
      value={supported ? level : "balanced"}
      disabled={!supported || auto}
      className={supported && auto ? "is-auto" : undefined}
      onChange={onChange}
    />
  );
}

/** The opt-in box that lets the platform pick the reasoning level. Shared by
 * chat's Send options and the Drafts settings. */
export function ReasoningAutoCheckbox({
  checked,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (auto: boolean) => void;
}) {
  return (
    <label className={`reasoning-auto${disabled ? " is-disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label="Auto: choose the reasoning level automatically"
        onChange={(event) => {
          if (!disabled) onChange(event.target.checked);
        }}
      />
      <span aria-hidden="true">Auto</span>
    </label>
  );
}
