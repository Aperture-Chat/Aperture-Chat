/** Pencil-and-paper mark for the Drafts assistant: a sheet with a folded
 * corner, three lines of copy, and a pencil finishing a handwritten stroke.
 * The stroke draws itself once on mount (skipped for reduced motion). */
export function DraftPencilMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={`draft-pencil-mark ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g className="draft-pencil-mark-sheet">
        <path d="M11.5 9.5h15.2l6.8 6.8v22.2a2.5 2.5 0 0 1-2.5 2.5H11.5A2.5 2.5 0 0 1 9 38.5V12a2.5 2.5 0 0 1 2.5-2.5Z" fill="#0b3b3a" opacity=".22" transform="translate(1.4 1.6)" />
        <path d="M11.5 8h15.2l6.8 6.8V37a2.5 2.5 0 0 1-2.5 2.5H11.5A2.5 2.5 0 0 1 9 37V10.5A2.5 2.5 0 0 1 11.5 8Z" fill="#ffffff" />
        <path d="M26.7 8v4.3a2.5 2.5 0 0 0 2.5 2.5h4.3Z" fill="#cfe7e4" />
        <rect x="13" y="16" width="10" height="2.2" rx="1.1" fill="#0f766e" opacity=".85" />
        <rect x="13" y="21.2" width="16" height="1.8" rx=".9" fill="#0f766e" opacity=".32" />
        <rect x="13" y="25.6" width="13" height="1.8" rx=".9" fill="#0f766e" opacity=".32" />
      </g>
      <path
        className="draft-pencil-mark-stroke"
        d="M13.4 33.2c1.4-2.4 2.6-2.4 3.4 0 .8 2.3 2 2.3 3.2 0 1-2 2.2-2.1 3.1-.4.6 1 1.3 1.3 2.1.9"
        stroke="#0f766e"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
      />
      <g className="draft-pencil-mark-pencil" transform="translate(25.4 33.4) rotate(-42) scale(.78)">
        <path d="M0 0 6.4-3.4v6.8Z" fill="#f6d7a7" />
        <path d="M0 0 2.5-1.35v2.7Z" fill="#1e293b" />
        <rect x="6.4" y="-3.4" width="17" height="6.8" fill="#fbbf24" />
        <rect x="6.4" y=".9" width="17" height="2.5" fill="#f59e0b" />
        <rect x="23.4" y="-3.4" width="3.6" height="6.8" fill="#d6dde4" />
        <rect x="24.5" y="-3.4" width=".7" height="6.8" fill="#a8b3bf" />
        <rect x="25.9" y="-3.4" width=".7" height="6.8" fill="#a8b3bf" />
        <path d="M27 -3.4h2.6a2.2 2.2 0 0 1 2.2 2.2v2.4a2.2 2.2 0 0 1-2.2 2.2H27Z" fill="#fb7185" />
      </g>
      <path
        className="draft-pencil-mark-spark"
        d="M38.5 6.5c.4 2 1 2.6 3 3-2 .4-2.6 1-3 3-.4-2-1-2.6-3-3 2-.4 2.6-1 3-3Z"
        fill="#ffffff"
      />
    </svg>
  );
}
