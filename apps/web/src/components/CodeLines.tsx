import { useCodeHighlight, type HighlightedLine } from "../lib/codeHighlight";

/** Zero-based line range drawn as the AI edit's target. */
export type MarkedLines = { first: number; last: number };

export function isMarkedLine(marked: MarkedLines | null | undefined, line: number) {
  return Boolean(marked && line >= marked.first && line <= marked.last);
}

/** One line's text, colored when highlight tokens are available. */
export function CodeLineText({ text, tokens }: { text: string; tokens?: HighlightedLine }) {
  if (!tokens) return <>{text}</>;
  return (
    <>
      {tokens.map((token, index) =>
        token.scope ? (
          <span className={token.scope} key={index}>
            {token.text}
          </span>
        ) : (
          token.text
        ),
      )}
    </>
  );
}

/** Numbered, read-only code view shared by chat code blocks, diagram source
 * views, and the artifact canvas. With a `language` the lines are colored. */
export function CodeLines({
  lines,
  language,
  marked,
  preview = false,
}: {
  lines: string[];
  language?: string;
  marked?: MarkedLines | null;
  preview?: boolean;
}) {
  const highlighted = useCodeHighlight(lines.join("\n"), language);
  return (
    <pre className="md-code-block" tabIndex={preview ? undefined : 0}>
      <code className="md-code-lines">
        {lines.map((line, lineIndex) => (
          <span
            className={`md-code-line${isMarkedLine(marked, lineIndex) ? " is-marked" : ""}`}
            data-code-row=""
            key={lineIndex}
          >
            <span className="md-code-line-number" aria-hidden="true">
              {lineIndex + 1}
            </span>
            <span className="md-code-line-text">
              <CodeLineText text={line} tokens={highlighted?.[lineIndex]} />
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}
