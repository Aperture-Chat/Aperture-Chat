import clsx from "clsx";

/** One person in a usage grid: full name, what they used, and labeled counts.
 * Clicking a card adds that person to the filter, when the list offers it. */
export function ActivityPersonCard({
  name,
  detail,
  count,
  countLabel,
  tokensLabel,
  onSelect,
  selected = false,
  tooltip,
}: {
  name: string;
  detail: string;
  count: number;
  /** What `count` counts, such as "messages". */
  countLabel: string;
  tokensLabel?: string;
  onSelect?: () => void;
  selected?: boolean;
  tooltip?: string;
}) {
  const content = (
    <>
      <span className="activity-person">
        <strong>{name}</strong>
        <small>{detail}</small>
      </span>
      <span className="activity-numbers">
        <b>{count.toLocaleString()}</b>
        <small>{countLabel}</small>
        {tokensLabel && <small>{tokensLabel}</small>}
      </span>
    </>
  );
  if (!onSelect) return <div className="model-user-activity-row" role="listitem">{content}</div>;
  return (
    <button
      className={clsx("model-user-activity-row usage-user-row", selected && "is-selected")}
      type="button"
      role="listitem"
      aria-pressed={selected}
      onClick={onSelect}
      data-tooltip={tooltip}
    >
      {content}
    </button>
  );
}
