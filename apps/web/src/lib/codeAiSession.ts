/**
 * The AI edit on a code block as a state machine: open on a selection, send
 * an instruction, stream, review the replacement, then accept or close.
 * Pure, so every transition is testable without a model or a browser.
 */
import type { AiComposerPhase } from "../components/AiEditComposer";
import type { ChatWireMessage } from "./api/chat";
import { splitAssistantThinking } from "./assistantThinking";
import {
  applyCodeReplacement,
  codeEditMessages,
  codeEditRefineMessages,
  codeReplacementFromReply,
  codeSelectionLabel,
  type CodeSelection,
} from "./codeAiEdit";

export type CodeAiSession = {
  phase: AiComposerPhase;
  selection: CodeSelection;
  /** The code the selection held when the session opened. */
  selectedText: string;
  /** “text” or “Lines 4–9”, naming the target in the composer. */
  label: string;
  runLabel: string;
  stream: string;
  /** Cleaned replacement code under review. */
  proposal: string;
  /** The model's reply as sent, so a refinement continues from it. */
  reply: string;
  /** Conversation that produced `reply`; `pending` is the last one sent. */
  messages: ChatWireMessage[];
  pending: ChatWireMessage[];
  error: string | null;
};

export type CodeAiAction =
  | { type: "open"; code: string; selection: CodeSelection }
  | { type: "send"; runLabel: string; messages: ChatWireMessage[] }
  | { type: "stream"; text: string }
  | { type: "reply"; text: string }
  | { type: "fail"; error: string }
  | { type: "close" };

export const CODE_AI_STOPPED = "Stopped before the suggestion finished. The code is unchanged.";
export const CODE_AI_NO_CODE = "The model did not return replacement code. Try again or rephrase the instruction.";
export const CODE_AI_MOVED = "The code changed since you selected it. Close this and select the code again.";

function opened(code: string, selection: CodeSelection): CodeAiSession {
  return {
    phase: "compose",
    selection,
    selectedText: code.slice(selection.start, selection.end),
    label: codeSelectionLabel(code, selection),
    runLabel: "",
    stream: "",
    proposal: "",
    reply: "",
    messages: [],
    pending: [],
    error: null,
  };
}

function reviewed(session: CodeAiSession, text: string): CodeAiSession {
  const reply = splitAssistantThinking(text).visibleContent;
  const proposal = codeReplacementFromReply(reply, session.selectedText);
  if (proposal === null) return { ...session, phase: "error", stream: "", error: CODE_AI_NO_CODE };
  return { ...session, phase: "review", stream: "", proposal, reply, messages: session.pending };
}

export function codeAiSessionReducer(session: CodeAiSession | null, action: CodeAiAction): CodeAiSession | null {
  if (action.type === "open") return opened(action.code, action.selection);
  if (!session || action.type === "close") return null;
  switch (action.type) {
    case "send":
      return { ...session, phase: "working", runLabel: action.runLabel, stream: "", error: null, pending: action.messages };
    case "stream":
      return session.phase === "working" ? { ...session, stream: splitAssistantThinking(action.text).visibleContent } : session;
    case "reply":
      return reviewed(session, action.text);
    case "fail":
      return { ...session, phase: "error", stream: "", error: action.error };
  }
}

/** The request for an instruction: a fresh edit, or a refinement that
 * continues from the suggestion on screen. */
export function codeAiRequest(
  session: CodeAiSession,
  input: { code: string; language: string; instruction: string; refine: boolean },
): { messages: ChatWireMessage[]; runLabel: string } {
  const { code, language, instruction, refine } = input;
  if (refine && session.reply) {
    return { messages: codeEditRefineMessages(session.messages, session.reply, instruction), runLabel: `Refine: ${instruction}` };
  }
  return { messages: codeEditMessages({ code, language, selection: session.selection, instruction }), runLabel: instruction };
}

/** The whole code with the suggestion applied, or null when the selected
 * code has changed since the session opened. */
export function codeAiAccepted(session: CodeAiSession, code: string): string | null {
  const { selection, selectedText, proposal } = session;
  if (code.slice(selection.start, selection.end) !== selectedText) return null;
  return applyCodeReplacement(code, selection, proposal);
}

export function codeAiFailure(error: unknown, stopped: boolean): string {
  if (stopped) return CODE_AI_STOPPED;
  return error instanceof Error && error.message ? error.message : CODE_AI_NO_CODE;
}
