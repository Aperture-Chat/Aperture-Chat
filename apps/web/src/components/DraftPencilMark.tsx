/** Pencil-and-paper mark for the Drafts assistant, drawn as a single-color
 * line icon (currentColor) so it sits on the lit key of the tactile
 * controls: a sheet with a folded corner, two lines of copy, and a pencil
 * finishing a handwritten stroke. The stroke draws itself once on mount
 * (skipped for reduced motion). */
export function DraftPencilMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`draft-pencil-mark ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <g className="draft-pencil-mark-sheet">
        {/* The right edge breaks where the pencil crosses it. */}
        <path d="M14 8h13l9 9v4M36 29.5V38a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3" />
        <path d="M27 8v6a3 3 0 0 0 3 3h6" />
        <path d="M17 20h7" />
        <path d="M17 26h10" opacity=".7" />
      </g>
      <path
        className="draft-pencil-mark-stroke"
        d="M16.5 34c1.2-2.2 2.3-2.2 3 0 .7 2.1 1.8 2.1 2.8 0"
        pathLength={1}
      />
      <g className="draft-pencil-mark-pencil">
        <path d="M24 36 25.4 31 34.9 21.5 38.5 25.1 29 34.6Z" />
        <path d="M25.4 31 29 34.6M32.4 24 36 27.6" />
      </g>
      <path className="draft-pencil-mark-spark" d="M40.5 6.5v5M38 9h5" strokeWidth="2.4" />
    </svg>
  );
}
