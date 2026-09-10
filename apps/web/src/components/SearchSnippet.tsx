import { Fragment, type ReactNode } from "react";

/** Compact, noninteractive Markdown: search rows must not contain links or media. */
export function SearchSnippet({ text }: { text: string }) {
  const source = text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\n+/g, " ");
  const nodes: ReactNode[] = [];
  const tokens = /\*\*(\S(?:.*?\S)?)\*\*|__(\S(?:.*?\S)?)__|`([^`]+)`|(?<!\*)\*(?!\*)([^*]+)\*(?!\*)|(?<!_)_(?!_)([^_]+)_(?!_)|~~(.+?)~~/g;
  let end = 0;
  for (const match of source.matchAll(tokens)) {
    // Snippets may start or end midway through a formatted span.
    nodes.push(<Fragment key={`text-${end}`}>{source.slice(end, match.index).replace(/\*\*|__|~~/g, "")}</Fragment>);
    const key = `format-${match.index}`;
    if (match[1] || match[2]) nodes.push(<strong key={key}>{match[1] || match[2]}</strong>);
    else if (match[3]) nodes.push(<code key={key}>{match[3]}</code>);
    else if (match[6]) nodes.push(<s key={key}>{match[6]}</s>);
    else nodes.push(<em key={key}>{match[4] || match[5]}</em>);
    end = match.index! + match[0].length;
  }
  nodes.push(<Fragment key="tail">{source.slice(end).replace(/\*\*|__|~~/g, "")}</Fragment>);
  return <>{nodes}</>;
}
