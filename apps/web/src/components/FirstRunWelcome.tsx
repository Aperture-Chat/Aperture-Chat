import { ArrowRight, BookOpen, Check, Settings2, X } from "lucide-react";
import type { BootstrapData } from "../lib/types";
import { usableModels } from "../lib/modelAccess";
import type { ViewKey } from "./AppShell";

export function FirstRunWelcome({ data, onDismiss, onGuide, onNavigate }: {
  data: BootstrapData;
  onDismiss: () => void;
  onGuide: () => void;
  onNavigate: (view: ViewKey) => void;
}) {
  const owner = data.me.role === "PLATFORM_OWNER";
  const admin = data.me.role === "TENANT_ADMIN";
  const models = usableModels(data);
  const ready = models.length > 0;
  return (
    <section className="first-run-welcome" aria-labelledby="first-run-title">
      <div className="first-run-heading">
        <div>
          <span className="first-run-eyebrow">GETTING STARTED</span>
          <h2 id="first-run-title">{owner ? "Build your team's workspace." : "A good place to begin."}</h2>
        </div>
        <button className="icon-button" type="button" aria-label="Dismiss welcome" onClick={onDismiss}><X size={18} /></button>
      </div>
      <ol className="first-run-steps">
        <li><span className="first-run-step is-done"><Check size={14} /></span><div><strong>You're signed in</strong><p>Your account and workspace are ready to explore.</p></div></li>
        <li><span className={`first-run-step ${ready ? "is-done" : ""}`}>{ready ? <Check size={14} /> : "2"}</span><div><strong>{ready ? "Choose your model" : owner ? "Connect your first model" : "Model access is next"}</strong><p>{ready ? `${models.length} ${models.length === 1 ? "model is" : "models are"} available to your account. Select one above your conversation.` : owner ? "Add a provider, validate its connection, then enable the models your team can use." : admin ? "Review model access and group membership in the Admin console." : "Ask your workspace administrator to enable a model for your account."}</p></div></li>
        <li><span className="first-run-step">3</span><div><strong>{owner || admin ? "Bring your team in" : "Make it your own"}</strong><p>{owner || admin ? "Review access requests, assign groups, and share sign-in instructions with approved users." : "Start a conversation, add a source, or open Drafts to work on a document."}</p></div></li>
      </ol>
      <div className="first-run-actions">
        {(owner || admin) && <button className="primary-button" type="button" onClick={() => onNavigate(owner && !ready ? "platform" : "admin")}><Settings2 size={16} />{owner && !ready ? "Set up models" : "Manage access"}<ArrowRight size={15} /></button>}
        <button className="secondary-button" type="button" onClick={onGuide}><BookOpen size={16} />{owner ? "Open owner guide" : admin ? "Open admin guide" : "Open quick-start guide"}</button>
        <button className="link-button" type="button" onClick={onDismiss}>I'll explore on my own</button>
      </div>
    </section>
  );
}
