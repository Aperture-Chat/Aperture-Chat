import { Lock } from "lucide-react";
import { Fragment, type ReactNode } from "react";

/** Matches the API's concealment tokens, e.g. "⟦SSN⟧" or "⟦CARD NUMBER⟧". */
const TOKEN_PATTERN = /⟦([A-Z][A-Z ]{1,30})⟧/g;

const ACRONYMS: Record<string, string> = {
  SSN: "SSN",
  ITIN: "ITIN",
  VIN: "VIN",
  IBAN: "IBAN",
  "IP ADDRESS": "IP address",
  "API KEY": "API key",
  "DRIVER LICENSE": "Driver's license",
  "MEDICARE ID": "Medicare ID",
  "HEALTH PLAN ID": "Health plan ID",
};

export function concealedTokenLabel(token: string): string {
  if (ACRONYMS[token]) return ACRONYMS[token];
  const lower = token.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function hasConcealedTokens(text: string): boolean {
  TOKEN_PATTERN.lastIndex = 0;
  const found = TOKEN_PATTERN.test(text);
  TOKEN_PATTERN.lastIndex = 0;
  return found;
}

export function ConcealedToken({ token }: { token: string }) {
  const label = concealedTokenLabel(token);
  return (
    <span
      className="concealed-token"
      role="img"
      aria-label={`${label} hidden`}
      data-tooltip={`${label} hidden by your organization's personal data protection. The original value is not stored or shown.`}
    >
      <Lock size={11} aria-hidden="true" />
      {label}
    </span>
  );
}

/** Splits text into plain runs and concealment chips. */
export function renderConcealed(text: string, keyPrefix = "c"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let index = 0;
  TOKEN_PATTERN.lastIndex = 0;
  for (let match = TOKEN_PATTERN.exec(text); match; match = TOKEN_PATTERN.exec(text)) {
    if (match.index > lastIndex) {
      nodes.push(<Fragment key={`${keyPrefix}-t${index++}`}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    nodes.push(<ConcealedToken key={`${keyPrefix}-k${index++}`} token={match[1]} />);
    lastIndex = TOKEN_PATTERN.lastIndex;
  }
  TOKEN_PATTERN.lastIndex = 0;
  if (lastIndex < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-t${index++}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return nodes;
}
