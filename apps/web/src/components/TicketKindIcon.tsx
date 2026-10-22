import { Bug, CircleHelp, Lightbulb, MessageSquareHeart, ShieldAlert } from "lucide-react";

import type { IssueReportKind } from "../lib/types";

const KIND_ICONS = {
  bug: Bug,
  feature: Lightbulb,
  question: CircleHelp,
  feedback: MessageSquareHeart,
  security: ShieldAlert,
} as const;

export function TicketKindIcon({ kind, size = 13 }: { kind: IssueReportKind; size?: number }) {
  const Icon = KIND_ICONS[kind] ?? Bug;
  return <Icon size={size} aria-hidden="true" />;
}
