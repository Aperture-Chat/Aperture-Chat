import type { ReactNode } from "react";
import { KnowledgeLibrary } from "./KnowledgeLibrary";
import { ToolsLibrary } from "./ToolsLibrary";
import type { BootstrapData } from "../lib/types";

/** Library page shell: Knowledge (knowledge bases) and Tools (connections, prompts, skills). */
export function LibraryConsole({
  data,
  view,
  onDataChange,
  sectionTabs,
}: {
  data: BootstrapData;
  view: "knowledge" | "tools";
  onDataChange: (updater: (current: BootstrapData) => BootstrapData) => void;
  sectionTabs?: ReactNode;
}) {
  const isKnowledge = view === "knowledge";
  return (
    <div className="console-page feature-console-page library-page">
      <header className="console-header">
        <div>
          <h1>Library</h1>
          <p>
            {isKnowledge
              ? "Organize the documents and sources your assistants can search. Access follows your workspace permissions."
              : "Connect the tools your assistants can use, with access and approvals set by your workspace."}
          </p>
        </div>
        {sectionTabs}
      </header>
      {isKnowledge ? (
        <KnowledgeLibrary data={data} onDataChange={onDataChange} />
      ) : (
        <ToolsLibrary data={data} onDataChange={onDataChange} />
      )}
    </div>
  );
}
