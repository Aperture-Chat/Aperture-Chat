import { FileText, Globe2, Quote } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { messageWithActiveResponseVersion } from "../lib/chatStore";
import {
  citationDestination,
  citationLocationLabel,
  type CitationDestination,
  type DocumentRequest,
} from "../lib/citationTargets";
import type { ChatCitation, ChatMessage } from "../lib/types";

const DISPLAY_LIMIT = 6;

export function citationKey(citation: ChatCitation): string {
  const base = `${citation.source_type}|${citation.source_uri || citation.source_name}`;
  // Distinct chunks from the same source stay distinct entries; legacy
  // citations without a chunk id keep the historical source-level key.
  return citation.chunk_id ? `${base}|chunk:${citation.chunk_id}` : base;
}

function uniqueCitations(citations: ChatCitation[]): ChatCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citationKey(citation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The chat's sources, read from the response version on screen: a regenerated
 * reply's citations are not the ones its earlier version made. */
export function sessionSourceSets(messages: readonly ChatMessage[], focusedMessageId: string | null | undefined) {
  const active = messages.map(messageWithActiveResponseVersion);
  const all = uniqueCitations(active.flatMap((message) => message.citations ?? []));
  const focusedMessage = focusedMessageId ? active.find((message) => message.id === focusedMessageId) : undefined;
  const focused = uniqueCitations(focusedMessage?.citations ?? []);
  const focusedKeys = new Set(focused.map(citationKey));
  const remaining = focused.length ? all.filter((citation) => !focusedKeys.has(citationKey(citation))) : all;
  return {
    all,
    focused,
    web: remaining.filter((citation) => citation.source_type === "web"),
    workspace: remaining.filter((citation) => citation.source_type !== "web"),
  };
}

/** The marker a citation answers to. `cited: false` wrote no marker, so it
 * has none to show. */
function markerLabel(citation: ChatCitation): string | null {
  if (citation.cited === false) return null;
  if (citation.k_index) return `K${citation.k_index}`;
  return citation.w_index ? `W${citation.w_index}` : null;
}

function SourcePlace({ citation, opensAtPassage = false }: { citation: ChatCitation; opensAtPassage?: boolean }) {
  const marker = markerLabel(citation);
  const location = citationLocationLabel(citation) ?? (opensAtPassage ? "Opens at the passage" : null);
  if (!marker && !location) return null;
  return (
    <span className="session-source-location">
      {marker && (
        // Only `cited: true` proves the reply wrote this marker.
        <span
          className="session-source-marker"
          data-tooltip={citation.cited === true ? `Cited inline as [${marker}]` : `Passage ${marker}`}
        >
          {marker}
        </span>
      )}
      {location && <span>{location}</span>}
    </span>
  );
}

/** The cited sentence when the server chose one, otherwise the chunk's opening. */
function SourceSnippet({ citation }: { citation: ChatCitation }) {
  const text = citation.passage?.replace(/\s+/g, " ").trim() || citation.snippet;
  return text ? <span className="session-source-snippet">{text}</span> : null;
}

function DocumentSourceRow({
  citation,
  request,
  onOpenDocument,
}: {
  citation: ChatCitation;
  request: DocumentRequest;
  onOpenDocument: (request: DocumentRequest) => void;
}) {
  const location = citationLocationLabel(citation);
  const opensAtPassage = !location && Boolean(request.chunkId);
  return (
    <li className="is-document">
      <button
        type="button"
        className="session-source-open"
        aria-label={`Open ${citation.source_name}${location ? `, ${location}` : ""}`}
        data-tooltip="Open the document at this passage"
        onClick={(event) => {
          // Safari leaves focus behind on click, and closing returns it here.
          event.currentTarget.focus();
          onOpenDocument(request);
        }}
      >
        <strong>{citation.source_name}</strong>
        <SourcePlace citation={citation} opensAtPassage={opensAtPassage} />
        <SourceSnippet citation={citation} />
      </button>
    </li>
  );
}

function PlainSourceRow({
  citation,
  destination,
}: {
  citation: ChatCitation;
  destination: Exclude<CitationDestination, { kind: "viewer" }>;
}) {
  const origin = destination.kind === "link" ? destination.host : citation.source_type;
  return (
    <li>
      {destination.kind === "link" ? (
        <a
          href={destination.href}
          target="_blank"
          rel="noreferrer"
          data-tooltip={`Open ${citation.source_name} in a new browser tab`}
        >
          {citation.source_name}
        </a>
      ) : (
        <strong>{citation.source_name}</strong>
      )}
      <small>{citation.cited === false ? `${origin} · Consulted, not cited` : origin}</small>
      <SourcePlace citation={citation} />
      <SourceSnippet citation={citation} />
    </li>
  );
}

function SourceRow({
  citation,
  onOpenDocument,
}: {
  citation: ChatCitation;
  onOpenDocument: (request: DocumentRequest) => void;
}) {
  const destination = citationDestination(citation);
  if (destination.kind === "viewer") {
    return <DocumentSourceRow citation={citation} request={destination.request} onOpenDocument={onOpenDocument} />;
  }
  return <PlainSourceRow citation={citation} destination={destination} />;
}

/** "Cited" is said only of rows the reply is on record as citing. Attachments,
 * tool results, and old records carry no marker to prove it. */
function moreLabel(hidden: ChatCitation[], expanded: boolean, scope: "chat" | "response") {
  const plural = hidden.length === 1 ? "" : "s";
  const allCited = hidden.every((citation) => citation.cited === true);
  if (expanded) return `Hide ${hidden.length} ${allCited ? "cited " : ""}source${plural}`;
  return allCited
    ? `Show ${hidden.length} more cited in this ${scope}`
    : `Show ${hidden.length} more source${plural} in this ${scope}`;
}

function SourceGroup({
  icon,
  label,
  sources,
  moreScope,
  onOpenDocument,
}: {
  icon: ReactNode;
  label: string;
  sources: ChatCitation[];
  moreScope: "chat" | "response";
  onOpenDocument: (request: DocumentRequest) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = sources.slice(DISPLAY_LIMIT);
  const visible = expanded ? sources : sources.slice(0, DISPLAY_LIMIT);
  if (sources.length === 0) return null;
  return (
    <div className="session-source-group">
      <span className="session-source-label">
        {icon}
        {label}
      </span>
      <ul>
        {visible.map((citation) => (
          <SourceRow key={citationKey(citation)} citation={citation} onOpenDocument={onOpenDocument} />
        ))}
      </ul>
      {hidden.length > 0 && (
        <button
          type="button"
          className="session-source-more"
          data-tooltip={
            expanded ? `Hide the extra sources from this ${moreScope}` : `Show the remaining sources from this ${moreScope}`
          }
          onClick={() => setExpanded((value) => !value)}
        >
          {moreLabel(hidden, expanded, moreScope)}
        </button>
      )}
    </div>
  );
}

export function SessionSources({
  messages,
  focusedMessageId,
  onOpenDocument,
}: {
  messages: readonly ChatMessage[];
  focusedMessageId?: string | null;
  onOpenDocument: (request: DocumentRequest) => void;
}) {
  const { focused, web, workspace } = sessionSourceSets(messages, focusedMessageId);
  const others = web.length + workspace.length;
  const block = useRef<HTMLDivElement | null>(null);
  // Choosing a response asks to see its sources, which can sit below the fold.
  useEffect(() => {
    if (focusedMessageId) block.current?.scrollIntoView?.({ block: "start" });
  }, [focusedMessageId]);
  if (focused.length + others === 0) return null;
  return (
    <div className="session-sources" ref={block}>
      <div className="audit-heading">
        <h3>Sources gathered</h3>
      </div>
      <SourceGroup
        key={`selected-${focusedMessageId}`}
        icon={<Quote size={12} />}
        label={`Selected response · ${focused.length}`}
        sources={focused}
        moreScope="response"
        onOpenDocument={onOpenDocument}
      />
      {focused.length > 0 && others > 0 && <span className="session-source-divider">Other sources in this chat</span>}
      <SourceGroup
        icon={<Globe2 size={12} />}
        label={`Web · ${web.length}`}
        sources={web}
        moreScope="chat"
        onOpenDocument={onOpenDocument}
      />
      <SourceGroup
        icon={<FileText size={12} />}
        label={`Workspace · ${workspace.length}`}
        sources={workspace}
        moreScope="chat"
        onOpenDocument={onOpenDocument}
      />
    </div>
  );
}
