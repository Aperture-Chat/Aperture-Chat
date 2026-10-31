import { createContext, type ReactNode } from "react";
import {
  citationDestination,
  citationLocationLabel,
  markerEntryLabel,
  parseMarkerBracket,
  planMarkerBracket,
  type DocumentRequest,
  type MarkerEntry,
} from "../lib/citationTargets";
import type { ChatCitation } from "../lib/types";

/** The reply a marker belongs to. Surfaces with no citations to offer, such as
 * a reply still streaming, leave this unset and markers stay plain labels. */
export type CitationMarkerScope = {
  citations: readonly ChatCitation[];
  onOpen: (request: DocumentRequest) => void;
};

export const CitationMarkerContext = createContext<CitationMarkerScope | null>(null);

function PlainMarker({ label }: { label: string }) {
  return (
    <sup className="md-cite-marker" data-cite-index={label} title={`Source ${label}`}>
      {label}
    </sup>
  );
}

function markerName(label: string, citation: ChatCitation) {
  const location = citationLocationLabel(citation);
  return `Open source ${label}: ${citation.source_name}${location ? `, ${location}` : ""}`;
}

function MarkerControl({
  label,
  citation,
  onOpen,
}: {
  label: string;
  citation: ChatCitation;
  onOpen: CitationMarkerScope["onOpen"];
}) {
  const destination = citationDestination(citation);
  const name = markerName(label, citation);
  if (destination.kind === "none") return <PlainMarker label={label} />;
  return (
    <sup className="md-cite-marker is-open" data-cite-index={label}>
      {destination.kind === "viewer" ? (
        <button
          type="button"
          className="md-cite-open"
          aria-label={name}
          data-tooltip={name}
          onClick={(event) => {
            // Safari leaves focus behind on click, and closing returns it here.
            event.currentTarget.focus();
            onOpen(destination.request);
          }}
        >
          {label}
        </button>
      ) : (
        <a
          className="md-cite-open"
          href={destination.href}
          target="_blank"
          rel="noreferrer"
          aria-label={name}
          data-tooltip={name}
        >
          {label}
        </a>
      )}
    </sup>
  );
}

export type InlineCitations = { scope: CitationMarkerScope | null; preview: boolean; streaming: boolean };

export type RenderedBracket = {
  node: ReactNode;
  /** Nothing is left of the bracket, so the space before it goes too. */
  dropped: boolean;
};

/** The one form surfaces with no citations have always shown as a label. */
function isBareLabel(raw: string, entries: readonly MarkerEntry[]): boolean {
  const [{ letter, first }] = entries;
  if (entries.length !== 1 || raw !== `[${markerEntryLabel(entries[0])}]` || first < 1) return false;
  return letter === "K" ? first <= 99 : letter === "U" && first <= 9;
}

function repliedBracket(raw: string, entries: readonly MarkerEntry[], scope: CitationMarkerScope): RenderedBracket {
  const { matched, foreign } = planMarkerBracket(entries, scope.citations);
  // Nothing here belongs to this reply's sources: legal text uses these
  // brackets, and the renderer never edits a reply.
  if (matched.length === 0 && foreign.length === entries.length) return { node: raw, dropped: false };
  const keys = matched.map(({ label, citation }) => (
    <MarkerControl key={label} label={label} citation={citation} onOpen={scope.onOpen} />
  ));
  const written = foreign.map((entry) => `[${markerEntryLabel(entry)}]`).join(" ");
  return { node: <>{keys}{written}</>, dropped: matched.length === 0 && foreign.length === 0 };
}

/** `[K1](url)`, which the server counts as a citation and strips along with its
 * URL. Where the reply cited that letter it is the marker, and the model's URL
 * goes: it is not where the citation points. Anywhere else it is an ordinary
 * link, so `[W2](https://irs.example/w2)` still works. Null means leave it be. */
export function renderLinkedMarker(text: string, citations: InlineCitations): RenderedBracket | null {
  const { scope, preview, streaming } = citations;
  const raw = `[${text}]`;
  const entries = parseMarkerBracket(raw);
  if (entries.length === 0 || preview) return null;
  if (streaming) return renderCitationBracket(raw, citations);
  if (!scope) return null;
  const { matched, foreign } = planMarkerBracket(entries, scope.citations);
  return matched.length === 0 && foreign.length === entries.length ? null : repliedBracket(raw, entries, scope);
}

/** What one bracket in a reply becomes. Null means it is not a marker at all.
 * K and W open what they cite, and a number that letter's citations do not list
 * was invented, so it goes. A letter this reply never used stays as written. */
export function renderCitationBracket(
  raw: string,
  { scope, preview, streaming }: InlineCitations,
): RenderedBracket | null {
  const entries = parseMarkerBracket(raw);
  if (entries.length === 0) return null;
  if (streaming) {
    const pending = entries.map((entry) => markerEntryLabel(entry));
    return { node: pending.map((label) => <PlainMarker key={label} label={label} />), dropped: false };
  }
  if (scope && !preview) return repliedBracket(raw, entries, scope);
  const node = isBareLabel(raw, entries) ? <PlainMarker label={markerEntryLabel(entries[0])} /> : raw;
  return { node, dropped: false };
}
