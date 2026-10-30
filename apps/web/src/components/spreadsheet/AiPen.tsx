import { PenLine, Sparkles } from "lucide-react";

/** The Drafts "edit with AI" mark (pen + spark), shared with the document and deck editors' styling. */
export function AiPen({ size = 18 }: { size?: number }) {
  return (
    <span className="ai-pen-icon" aria-hidden="true">
      <PenLine size={size} />
      <Sparkles size={Math.max(9, Math.round(size * 0.62))} className="ai-pen-icon-spark" />
    </span>
  );
}
