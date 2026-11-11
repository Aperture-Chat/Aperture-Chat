import { X } from "lucide-react";
import { FINDING_GROUP_LABELS, type DocumentFinding, type FindingGroup } from "../lib/documentChecks";

type Props = {
  findings: DocumentFinding[];
  onJump: (finding: DocumentFinding) => void;
  onClose: () => void;
};

const GROUPS = Object.keys(FINDING_GROUP_LABELS) as FindingGroup[];

/** What a careful proofreader would point at before the document goes out:
 * each finding in the document's own words, click to go to it. */
export function DocumentCheckPanel({ findings, onJump, onClose }: Props) {
  const groups = GROUPS.map((group) => ({ group, items: findings.filter((finding) => finding.group === group) })).filter(
    ({ items }) => items.length > 0,
  );
  return (
    <aside className="document-outline document-check" aria-label="Document check">
      <div className="document-outline-head">
        <strong>Check</strong>
        <button type="button" aria-label="Close check" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="document-check-body">
        <p className="document-check-summary" role="status">
          {findings.length === 0
            ? "Nothing to fix."
            : `${findings.length} ${findings.length === 1 ? "thing" : "things"} to look at`}
        </p>
        {findings.length === 0 && (
          <p className="document-outline-empty">
            No blanks or placeholders, no unused or undefined terms, no broken cross-references, and no numbering gaps
            were found.
          </p>
        )}
        {groups.map(({ group, items }) => (
          <section key={group} aria-label={FINDING_GROUP_LABELS[group]}>
            <h3 className="document-check-group">
              {FINDING_GROUP_LABELS[group]} <span>{items.length}</span>
            </h3>
            <ol>
              {items.map((finding, index) => (
                <li key={`${finding.block}-${index}-${finding.title}`}>
                  <button type="button" title={finding.title} onClick={() => onJump(finding)}>
                    <strong>{finding.title}</strong>
                    <small>{finding.detail}</small>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ))}
        <p className="document-check-note">
          These checks read the words on the page. They do not replace your own read.
        </p>
      </div>
    </aside>
  );
}
