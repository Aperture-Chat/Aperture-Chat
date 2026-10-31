import { useEffect, useState } from "react";
import { getMyUsageBudget, type MyUsageBudgetCap } from "../lib/api/auth";
import {
  capDetail,
  capPercent,
  capSpent,
  capTitle,
  exactCount,
  finishedReplyCount,
  getMyUsageSummary,
  usageCountLabel,
  usageResetLabel,
  usageTokensLabel,
  usageTokensNote,
  usageTokensUnreported,
  type MyUsageSummary,
} from "../lib/accountDrawer";
import type { ChatThread } from "../lib/types";
import { AccountSection } from "./AccountRow";

type UsageState = { status: "loading" } | { status: "failed" } | { status: "ready"; summary: MyUsageSummary };

/** This month's ledger and any caps that apply, refreshed when a reply lands. */
function useAccountUsage(userId: string, threads: ChatThread[]) {
  const [usage, setUsage] = useState<UsageState>({ status: "loading" });
  const [caps, setCaps] = useState<MyUsageBudgetCap[]>([]);
  const finishedReplies = finishedReplyCount(threads);

  useEffect(() => {
    let active = true;
    getMyUsageSummary(userId)
      .then((summary) => {
        if (active) setUsage({ status: "ready", summary });
      })
      .catch(() => {
        if (active) setUsage({ status: "failed" });
      });
    getMyUsageBudget(userId)
      .then((budget) => {
        if (active) setCaps(budget.caps);
      })
      .catch(() => {
        if (active) setCaps([]);
      });
    return () => {
      active = false;
    };
  }, [userId, finishedReplies]);

  return { usage, caps };
}

/** A shortened figure keeps the exact number for hover and screen readers. */
function UsageFigure({ label, value, exact, muted = false }: { label: string; value: string; exact: string; muted?: boolean }) {
  const shortened = value !== exact;
  return (
    <div>
      <dt>{label}</dt>
      <dd className={muted ? "is-unreported" : undefined} title={shortened ? exact : undefined}>
        <span aria-hidden={shortened || undefined}>{value}</span>
        {shortened && <span className="sr-only">{exact}</span>}
      </dd>
    </div>
  );
}

function UsageStats({ summary }: { summary: MyUsageSummary }) {
  const tokens = usageTokensLabel(summary);
  return (
    <dl className="account-well account-usage-stats">
      <UsageFigure label="Requests" value={usageCountLabel(summary.requests)} exact={exactCount(summary.requests)} />
      <UsageFigure label="Chats" value={usageCountLabel(summary.chats)} exact={exactCount(summary.chats)} />
      <UsageFigure
        label="Tokens"
        value={tokens}
        exact={summary.total_tokens === null ? tokens : exactCount(summary.total_tokens)}
        muted={usageTokensUnreported(summary)}
      />
    </dl>
  );
}

function CapMeter({ cap }: { cap: MyUsageBudgetCap }) {
  const percent = capPercent(cap);
  const title = capTitle(cap);
  return (
    <div className={capSpent(cap) ? "account-meter is-spent" : "account-meter"}>
      <div className="account-meter-copy">
        <strong>{title}</strong>
        <small>{capDetail(cap)}</small>
      </div>
      <span
        className="account-meter-track"
        role="meter"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={capDetail(cap)}
      >
        <span className="account-meter-fill" style={{ width: `${percent}%` }} />
      </span>
    </div>
  );
}

export function AccountUsage({ userId, threads }: { userId: string; threads: ChatThread[] }) {
  const { usage, caps } = useAccountUsage(userId, threads);
  const summary = usage.status === "ready" ? usage.summary : null;
  const failed = usage.status === "failed";
  return (
    <AccountSection
      title="Usage this month"
      className="account-usage"
      aside={summary && <small className="account-section-aside">{usageResetLabel(summary)}</small>}
    >
      <div className="account-slab account-slab-padded">
        {summary ? (
          <>
            <UsageStats summary={summary} />
            <small className="account-usage-note">
              Every model request for your account, including automatic chat titles. {usageTokensNote(summary)}
            </small>
          </>
        ) : (
          <p className="account-well account-usage-status" role={failed ? "status" : undefined}>
            {failed ? "Usage is unavailable right now." : "Loading usage…"}
          </p>
        )}
        {caps.map((cap) => (
          <CapMeter key={`${cap.scope}:${cap.label}`} cap={cap} />
        ))}
      </div>
    </AccountSection>
  );
}
