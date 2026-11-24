import { useState } from "react";
import {
  loadReasoningLevel,
  storeReasoningLevel,
  type ReasoningLevel,
} from "../components/ReasoningSlider";

/** What the platform can see about a request when it picks a reasoning level
 * for the user. Chat and Drafts both describe a request this way. */
export type ReasoningSignals = {
  /** The user's own words: the chat message or the Drafts instruction. */
  text: string;
  /** Files, pictures, or documents sent along with the request. */
  attachmentCount?: number;
  /** Characters of working document the request acts on (Drafts). */
  documentLength?: number;
};

/** The user's sticky reasoning choice: a level they set, or Auto. */
export type ReasoningPreference = {
  level: ReasoningLevel;
  /** On, the platform picks the level for each request. Off by default. */
  auto: boolean;
};

// --- Auto's rules -----------------------------------------------------------
// Smart wins over everything; Fast needs a clearly trivial request with
// nothing riding along; anything in between, or any doubt, is Balanced.

/** An acknowledgment longer than this is saying something more. */
export const ACK_MAX_WORDS = 8;
/** A define/spell/translate/convert lookup is trivial only when this short. */
export const SIMPLE_ASK_MAX_WORDS = 8;
/** A prompt this long carries enough material to deserve depth. */
export const LONG_PROMPT_WORDS = 250;
/** Questions or list items that make a request multi-part. */
export const MULTI_PART_MIN = 3;
/** A working document this many characters long (about three pages) is large. */
export const LARGE_DOCUMENT_CHARS = 8000;

/** Whole words or phrases, case-insensitive; spaces match any whitespace. */
function cueRegex(cues: readonly string[]) {
  const alternatives = cues.map((cue) => cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  return new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "i");
}

const ANALYSIS_CUES = cueRegex([
  "analyze", "analyse", "analysis", "analyzing", "analysing", "compare", "comparison", "contrast",
  "evaluate", "evaluation", "assess", "assessment", "critique", "weigh", "pros and cons",
  "trade-offs", "trade-off", "tradeoffs", "tradeoff", "trade offs", "implications", "risk", "risks",
  "strategy", "strategic", "root cause", "explain why", "step by step", "step-by-step",
  "prove", "derive", "derivation", "in depth", "in-depth",
]);

const LEGAL_CUES = cueRegex([
  "clause", "clauses", "indemnification", "indemnify", "indemnity", "liability", "liabilities",
  "statute", "statutes", "statutory", "precedent", "precedents", "case law", "compliance",
  "due diligence", "jurisdiction", "jurisdictions", "jurisdictional", "fiduciary", "choice of law",
]);

const ENGINEERING_CUES = cueRegex([
  "debug", "debugging", "refactor", "refactoring", "architecture", "design a system", "system design",
  "race condition", "memory leak", "stack trace",
]);

// "brief" is the legal document only when nothing but a preposition or the
// end follows it: "a brief for the appeal", never "a brief summary".
const LEGAL_DOCUMENT =
  "(?:memo|memorandum|motion|contract|agreement|policy|complaint|pleading|lease|nda|petition|" +
  "settlement agreement|term sheet|opinion letter|demand letter|engagement letter|" +
  "brief(?=\\s*(?:$|[.,;:!?)]|(?:for|of|in|on|to|that|about|regarding|with|opposing|supporting)\\b)))";
const LEGAL_DRAFTING = new RegExp(
  `\\b(?:draft|drafting|write|writing|prepare|review|reviewing|redline|revise|mark up)\\b(?:\\s+\\S+){0,4}?\\s+${LEGAL_DOCUMENT}`,
  "i",
);

const CODE_BLOCK = /```/;
// Line starts match spaces and tabs only: `\s` also crosses line breaks, and
// a paste with long runs of blank lines then takes seconds to judge.
const STACK_TRACE = /^[ \t]*at[ \t]+\S.*:\d+(?::\d+)?\)?[ \t]*$|Traceback \(most recent call last\)|^[ \t]*File ".+", line \d+/m;
const QUESTION = /\?/g;
const LIST_ITEM = /^[ \t]*(?:\d+[.)]|[-*\u2022])[ \t]+\S/gm;

/** Judging what came along: deep when files are attached. Reading a file
 * back (a summary, an explanation) is ordinary work and stays Balanced. */
const REVIEW_CUES = cueRegex([
  "review", "identify", "extract", "flag", "check", "audit", "go through", "look over",
  "walk me through", "redline", "mark up",
]);

/** Remaking a working document rather than touching it up. */
const REWRITE_CUES = cueRegex([
  "rewrite", "redraft", "restructure", "reorganize", "reorganise", "overhaul", "expand",
  "generate", "consolidate", "turn this into", "turn it into",
]);

/** Surface fixes: whatever their size, they need care, not depth. */
const LIGHT_EDIT_CUES = cueRegex([
  "typo", "typos", "spelling", "spell check", "spellcheck", "grammar", "proofread", "punctuation",
  "capitalization", "rephrase", "reword", "paraphrase", "shorten", "shorter",
]);

/** Fresh facts or sources: never a fast-path answer. */
const RESEARCH_CUES = cueRegex([
  "latest", "current", "currently", "today", "recent", "recently", "news", "this week", "yesterday",
  "search", "look up", "lookup", "find sources", "cite", "citation", "citations", "sources",
]);

/** A lookup with one short answer. Rewording and proofreading are left out:
 * they are work on text whose weight Auto cannot see. */
const SIMPLE_ASK = new RegExp(
  `${cueRegex([
    "define", "definition of", "meaning of", "how do you spell", "spelling of", "synonym", "synonyms",
    "antonym", "antonyms", "another word for", "translate",
  ]).source}|\\bconvert\\s+\\d|\\bhow many \\w+ (?:are )?in an? \\w+|\\bwhat does .{1,40} mean\\b`,
  "i",
);

/** The ask leans on something Auto cannot see: the conversation, a document,
 * a matter, or a body of law. A lookup like that is not trivial. */
const POINTS_ELSEWHERE = cueRegex([
  "this", "that", "these", "those", "it", "our", "my", "us", "we", "here", "above", "attached",
  "section", "provision", "paragraph", "article", "exhibit", "under", "law", "court", "case",
]);

// Greetings, thanks, and praise only. A go-ahead ("yes", "ok", "sure", "go
// ahead") is left out on purpose: it continues an earlier request whose
// weight Auto cannot see, so it stays Balanced.
const ACK_WORDS = new Set([
  "hi", "hello", "hey", "hiya", "thanks", "thank", "you", "ty", "thx", "much", "so", "very",
  "appreciate", "it", "good", "great", "perfect", "cool", "nice", "awesome", "excellent",
  "bye", "goodbye", "morning", "afternoon", "evening", "there", "cheers", "wow",
]);

type Request = {
  text: string;
  words: string[];
  attachmentCount: number;
  documentLength: number;
};

function describeRequest({ text: raw, attachmentCount = 0, documentLength = 0 }: ReasoningSignals): Request {
  const text = raw.trim();
  return { text, words: text ? text.split(/\s+/) : [], attachmentCount, documentLength };
}

function asksForDepth({ text }: Request) {
  return [ANALYSIS_CUES, LEGAL_CUES, ENGINEERING_CUES, LEGAL_DRAFTING, CODE_BLOCK, STACK_TRACE].some(
    (cue) => cue.test(text),
  );
}

function isMultiPart({ text }: Request) {
  const questions = [...text.matchAll(QUESTION)].length;
  const items = [...text.matchAll(LIST_ITEM)].length;
  return Math.max(questions, items) >= MULTI_PART_MIN;
}

/** Size and shape that call for depth, unless the ask is only a surface fix. */
function hasDepthByVolume(request: Request) {
  if (LIGHT_EDIT_CUES.test(request.text)) return false;
  return (
    request.words.length >= LONG_PROMPT_WORDS ||
    isMultiPart(request) ||
    (request.attachmentCount > 0 && REVIEW_CUES.test(request.text)) ||
    (request.documentLength >= LARGE_DOCUMENT_CHARS && REWRITE_CUES.test(request.text))
  );
}

function isAcknowledgment({ words }: Request) {
  const bare = words.map((word) => word.toLowerCase().replace(/[^a-z']/g, "")).filter(Boolean);
  return bare.length > 0 && words.length <= ACK_MAX_WORDS && bare.every((word) => ACK_WORDS.has(word));
}

function isSimpleAsk({ words, text }: Request) {
  return words.length <= SIMPLE_ASK_MAX_WORDS && SIMPLE_ASK.test(text) && !POINTS_ELSEWHERE.test(text);
}

/** Nothing rides along and nothing needs fresh facts. */
function standsAlone(request: Request) {
  return request.attachmentCount === 0 && request.documentLength === 0 && !RESEARCH_CUES.test(request.text);
}

function isTrivial(request: Request) {
  return standsAlone(request) && (isAcknowledgment(request) || isSimpleAsk(request));
}

/** The platform's educated guess at the level a request needs. Pure and
 * rule-based: no model call, so it adds no latency, cost, or provider use. */
export function chooseReasoningLevel(signals: ReasoningSignals): ReasoningLevel {
  const request = describeRequest(signals);
  if (asksForDepth(request) || hasDepthByVolume(request)) return "smart";
  return isTrivial(request) ? "fast" : "balanced";
}

/** The one place that decides which level a request is sent at. */
export function reasoningLevelForSend(
  preference: ReasoningPreference,
  signals: ReasoningSignals,
): ReasoningLevel {
  return preference.auto ? chooseReasoningLevel(signals) : preference.level;
}

function autoStorageKey(userId: string) {
  return `aperture-reasoning-auto-${userId}`;
}

/** Auto is off until the user checks it; then it stays checked in this
 * browser across sessions, on both chat and Drafts. */
export function loadReasoningAuto(userId: string): boolean {
  try {
    return localStorage.getItem(autoStorageKey(userId)) === "on";
  } catch {
    return false;
  }
}

export function storeReasoningAuto(userId: string, auto: boolean) {
  try {
    localStorage.setItem(autoStorageKey(userId), auto ? "on" : "off");
  } catch {
    // Private-mode storage failures only lose the sticky preference.
  }
}

/** The sticky per-user reasoning choice shared by chat and Drafts. */
export function useReasoningPreference(userId: string): ReasoningPreference & {
  setLevel: (level: ReasoningLevel) => void;
  setAuto: (auto: boolean) => void;
} {
  const [level, setLevelState] = useState<ReasoningLevel>(() => loadReasoningLevel(userId));
  const [auto, setAutoState] = useState(() => loadReasoningAuto(userId));
  return {
    level,
    auto,
    setLevel(next) {
      setLevelState(next);
      storeReasoningLevel(userId, next);
    },
    setAuto(next) {
      setAutoState(next);
      storeReasoningAuto(userId, next);
    },
  };
}
