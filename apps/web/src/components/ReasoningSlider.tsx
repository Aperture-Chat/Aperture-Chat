/** Composer reasoning positions: fast = minimal effort, smart = deeper thinking. */
export type ReasoningLevel = "fast" | "balanced" | "smart";

export const REASONING_LEVELS: ReasoningLevel[] = ["fast", "balanced", "smart"];

// Fast asks for the smallest reasoning spend the model supports plus
// throughput-priority provider routing; the API degrades "minimal" to "low"
// for models without a minimal level.
export const REASONING_EFFORT_BY_LEVEL: Record<ReasoningLevel, "minimal" | "high" | null> = {
  fast: "minimal",
  balanced: null,
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

export function ReasoningSlider({
  level,
  supported,
  modelName,
  onChange,
}: {
  level: ReasoningLevel;
  supported: boolean;
  modelName: string;
  onChange: (level: ReasoningLevel) => void;
}) {
  const value = supported ? REASONING_LEVELS.indexOf(level) : 1;
  const activeLevel = supported ? level : "balanced";
  const tooltip = supported
    ? "Reasoning level: Fast favors quicker answers, Smart makes the model think longer for more detailed output"
    : `${modelName} does not support reasoning levels`;
  return (
    <div
      className={`reasoning-slider${supported ? "" : " is-disabled"}${
        supported && activeLevel !== "balanced" ? " is-active" : ""
      }`}
      data-tooltip={tooltip}
    >
      <span
        className={`reasoning-slider-label${activeLevel === "fast" ? " is-current" : ""}`}
        aria-hidden="true"
      >
        Fast
      </span>
      <input
        type="range"
        min={0}
        max={2}
        step={1}
        value={value}
        disabled={!supported}
        aria-label="Model reasoning level"
        aria-valuetext={
          activeLevel === "fast" ? "Fast" : activeLevel === "smart" ? "Smart" : "Balanced"
        }
        onChange={(event) => {
          const next = REASONING_LEVELS[Number(event.target.value)];
          if (next) onChange(next);
        }}
      />
      <span
        className={`reasoning-slider-label${activeLevel === "smart" ? " is-current" : ""}`}
        aria-hidden="true"
      >
        Smart
      </span>
    </div>
  );
}
