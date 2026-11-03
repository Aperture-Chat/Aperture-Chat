import { Clock3, Eye } from "lucide-react";
import { useState } from "react";
import type { RuntimeRecord } from "../lib/runtimeRecords";
import type { UserPromptRecord } from "../lib/types";
import { RunConversationPreview } from "./PromptActivityList";

function RuntimeRecordText({ record }: { record: RuntimeRecord }) {
  return (
    <span>
      <strong>{record.title}</strong>
      <small>{record.detail}</small>
      <p>{record.metadata}</p>
    </span>
  );
}

function RuntimeIcon() {
  return (
    <span className="feedback-icon is-positive">
      <Clock3 size={15} />
    </span>
  );
}

/** The log of AI runs. A chat run opens its saved conversation; a draft run is
 * a record only, because draft text stays with its author. */
export function RuntimeRecordList({
  records,
  ariaLabel,
  formatTime,
  loadThreadRecords,
}: {
  records: RuntimeRecord[];
  ariaLabel: string;
  formatTime: (value: string) => string;
  loadThreadRecords?: (threadId: string) => Promise<UserPromptRecord[] | void> | UserPromptRecord[] | void;
}) {
  const [opened, setOpened] = useState<(RuntimeRecord & { threadId: string }) | null>(null);

  return (
    <>
      <div className="feedback-event-list scrollable-log-list" aria-label={ariaLabel}>
        {records.map((record) => {
          const { threadId } = record;
          const when = <time dateTime={record.executedAt}>{formatTime(record.executedAt)}</time>;
          if (!threadId || !loadThreadRecords) {
            return (
              <div className="feedback-event-row" key={record.id}>
                <RuntimeIcon />
                <RuntimeRecordText record={record} />
                {when}
              </div>
            );
          }
          return (
            <button
              className="feedback-event-row is-clickable"
              type="button"
              key={record.id}
              aria-label={`Open the conversation: ${record.title}`}
              onClick={() => setOpened({ ...record, threadId })}
            >
              <RuntimeIcon />
              <RuntimeRecordText record={record} />
              <span className="feedback-row-side">
                {when}
                <span className="prompt-activity-preview-label" aria-hidden="true">
                  <Eye size={14} /> Open chat
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {opened && (
        <RunConversationPreview
          item={opened}
          ranLabel={formatTime(opened.executedAt)}
          loadThreadRecords={loadThreadRecords}
          onClose={() => setOpened(null)}
        />
      )}
    </>
  );
}
