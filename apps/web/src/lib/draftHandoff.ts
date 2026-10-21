/**
 * Chat → Drafts handoff. When a chat message asks for a whole document or a
 * slide deck, chat holds the message and offers to build it in Drafts. This
 * module decides which offer (if any) applies and assembles what Drafts needs
 * to start the same request without the user retyping it.
 *
 * Detection reads the request's grammar rather than matching keywords: a
 * creation verb ("write", "draft", "put together", "I want to see") whose
 * object's head noun is a document or a deck. Questions about writing,
 * negations, code, and short-form writing (emails, poems, replies) stay in
 * chat, because a false offer costs the user a click on every such message.
 */
import { splitAssistantThinking } from "./assistantThinking";
import { messageWithActiveResponseVersion } from "./chatStore";
import type { ChatAttachment, ChatMessage } from "./types";

export type DraftHandoffKind = "document" | "deck";

export type DraftHandoffAttachment = {
  attachmentId: string;
  name: string;
  size: string;
  /** False when the server extracted no readable text (the model sees only the name). */
  hasText: boolean;
};

/** Everything Drafts needs to start a request that began in chat. */
export type DraftHandoffRequest = {
  id: string;
  kind: DraftHandoffKind;
  prompt: string;
  /** The chat composer's web search switch at send time. */
  webSearch: boolean;
  /** The chat's selected model; Drafts uses it unless a drafting default is starred. */
  modelId: string | null;
  knowledgeIds: string[];
  attachments: DraftHandoffAttachment[];
  /** Earlier turns of the chat, for requests that refer back to them. */
  chatContext: string | null;
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Multi-word nouns collapse to one token before parsing, so "statement of
 * work" is not split at "of" and "slide deck" reads as a single head noun. */
const DECK_PHRASES = [
  /\bslide[\s-]?decks?\b/g,
  /\bslide[\s-]?shows?\b/g,
  /\bpitch[\s-]?decks?\b/g,
  /\bgoogle slides\b/g,
  /\bpower[\s-]?points?\b/g,
  /\bpptx? (?:files?|decks?)\b/g,
];
const DOC_PHRASES = [
  /\bstatements? of (?:work|purpose)\b/g,
  /\bscopes? of work\b/g,
  /\bterms of (?:service|use)\b/g,
  /\bletters? of (?:recommendation|intent|support|reference|resignation)\b/g,
  /\b(?:cover|recommendation|reference|resignation|demand|engagement|offer|appeal|complaint|fundraising|motivation) letters?\b/g,
  /\bstandard operating procedures?\b/g,
  /\brequests? for (?:proposals?|information|quotes?)\b/g,
  /\bcase stud(?:y|ies)\b/g,
  /\bpress releases?\b/g,
  /\bblog posts?\b/g,
  /\bjob descriptions?\b/g,
  /\bmeeting minutes\b/g,
  /\b(?:lesson|business|marketing|project|strategic|communications?|action|implementation|go-to-market|sales|training|operating|financial|content|succession|transition|contingency|research|launch|product|migration|onboarding|development|growth|study|30-60-90(?:-day)?|90-day) plans?\b/g,
  /\b(?:research|term|position|white|discussion|policy|concept|working) papers?\b/g,
  /\bliterature reviews?\b/g,
  /\bperformance reviews?\b/g,
  /\bbook reports?\b/g,
  /\b(?:user|style|study|onboarding|field|reference|training|employee|buyer'?s|beginner'?s|quick[\s-]?start|setup|installation|implementation|brand|program|resource|parent|student|teacher|travel) guides?\b/g,
  /\bexecutive summar(?:y|ies)\b/g,
  /\bprivacy polic(?:y|ies)\b/g,
  /\b(?:personal|position|purpose|impact) statements?\b/g,
  /\bop[\s-]?eds?\b/g,
  /\bone[\s-]?pagers?\b/g,
];
const DECK_TOKEN = "__deck__";
const DOC_TOKEN = "__doc__";

const DECK_HEADS = new Set([
  DECK_TOKEN, "presentation", "presentations", "slides", "slide", "ppt", "pptx", "slideshow", "slideshows",
]);
/** "deck" alone could be a patio or a card deck; it counts only when qualified. */
const DECK_QUALIFIERS = new Set([
  "slide", "sales", "investor", "investors", "board", "presentation", "marketing", "strategy", "training",
  "kickoff", "kick-off", "onboarding", "product", "company", "quarterly", "qbr", "conference", "webinar",
  "startup", "fundraising", "keynote", "client", "customer", "team", "all-hands", "roadshow", "demo",
  "overview", "intro", "update", "status", "budget", "project", "roadmap", "research", "results", "earnings",
  "recruiting", "hiring", "sponsorship", "partnership", "lecture", "class", "course", "workshop", "seminar",
  "briefing", "review", "ppt", "pptx",
]);
const DECK_TOPIC_STOPS = new Set([
  "on", "about", "covering", "summarizing", "summarising", "explaining", "outlining", "presenting", "introducing",
  "highlighting", "reviewing", "showing", "walking", "pitching", "showcasing", "regarding",
]);
const DECK_AUDIENCE_WORDS = new Set([
  "meeting", "meetings", "presentation", "talk", "board", "investors", "investor", "pitch", "conference",
  "webinar", "client", "clients", "customer", "customers", "class", "lecture", "kickoff", "review", "demo",
  "workshop", "training", "all-hands", "offsite", "qbr", "stakeholders", "leadership", "executives", "team",
  "seminar", "course", "students", "interview", "quarterly",
]);
const DOC_HEADS = new Set([
  DOC_TOKEN, "essay", "essays", "report", "reports", "memo", "memos", "memorandum", "letter", "letters",
  "proposal", "proposals", "whitepaper", "whitepapers", "article", "articles", "paper", "papers", "policy",
  "policies", "contract", "contracts", "agreement", "agreements", "nda", "ndas", "brief", "briefs", "briefing",
  "document", "documents", "doc", "docs", "manuscript", "chapter", "chapters", "resume", "résumé", "cv",
  "newsletter", "newsletters", "handbook", "manual", "playbook", "sow", "rfp", "rfi", "rfq", "thesis",
  "dissertation", "biography", "syllabus", "eulogy", "speech", "editorial", "book", "ebook", "e-book", "novel",
  "screenplay", "motion", "pleading", "complaint", "lease", "addendum", "charter", "constitution", "bylaws",
]);
/** Short-form writing that a "draft …" request keeps in chat. */
const SHORT_HEADS = new Set([
  "email", "emails", "e-mail", "mail", "message", "messages", "text", "texts", "sms", "reply", "replies",
  "response", "responses", "tweet", "tweets", "post", "posts", "caption", "captions", "comment", "comments",
  "dm", "dms", "note", "notes", "bio", "headline", "headlines", "title", "titles", "tagline", "taglines",
  "slogan", "slogans", "subject", "prompt", "prompts", "poem", "poems", "haiku", "limerick", "song", "songs",
  "lyrics", "joke", "jokes", "toast", "quote", "quotes", "sentence", "sentences", "paragraph", "paragraphs",
  "line", "lines", "list", "lists", "name", "names", "question", "questions", "answer", "answers", "survey",
  "quiz", "description", "descriptions", "summary", "summaries", "recap", "overview", "tldr", "outline", "outlines", "skeleton", "ad", "ads", "team", "player", "players", "lineup", "roster", "pick",
  "picks", "round", "qb", "quarterback",
]);
/** Code and spreadsheets are not Drafts documents, whatever they are called. */
const CODE_WORDS = new Set([
  "python", "javascript", "js", "typescript", "java", "kotlin", "swift", "golang", "rust", "ruby", "php",
  "perl", "bash", "shell", "powershell", "sql", "html", "css", "json", "yaml", "xml", "csv", "latex", "regex",
  "api", "react", "vue", "angular", "node", "nodejs", "excel", "spreadsheet", "spreadsheets", "sheets", "vba",
  "macro", "jupyter", "code", "script", "scripts", "function", "functions", "program", "app", "website",
  "webpage", "component", "cli", "sdk", "generator", "parser", "bot", "chatbot",
]);
/** Head nouns that name a form of something else: "memo template", "a first draft of my essay". */
const INHERIT_HEADS = new Set([
  "template", "templates", "draft", "drafts", "version", "versions", "copy", "sample", "samples", "example",
  "examples", "file", "files",
]);
const TRAILING_FILLERS = new Set([
  "please", "now", "today", "tonight", "tomorrow", "quickly", "asap", "too", "also", "again", "real", "quick",
  "together", "thanks", "thx", "instead",
]);
const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "fifteen",
  "twenty", "thirty", "forty", "fifty", "hundred", "thousand", "couple", "few", "several",
]);

const STRONG_VERBS = new Set([
  "write", "draft", "create", "generate", "prepare", "produce", "compose", "author", "craft",
]);
/** Weaker verbs that also edit existing work ("make the essay longer"), so
 * they only count when the object is new, not "the/this/my …". */
const SOFT_VERBS = new Set(["make", "build", "design", "develop", "assemble"]);
/** Verbs that only reshape existing content: "turn this into a deck". */
const TRANSFORM_VERBS = new Set([
  "turn", "convert", "transform", "rewrite", "reformat", "restructure", "repurpose", "recast", "adapt",
  "change", "organize", "summarize", "summarise", "condense", "distill", "compile", "present", "put", "redo",
  "format", "expand", "write", "draft", "make", "create", "build", "develop",
]);
const TRANSFORM_CONNECTORS = new Set(["into", "to", "as", "in"]);
const EXISTING_OBJECTS = new Set([
  "the", "this", "that", "these", "those", "it", "its", "my", "our", "your", "his", "her", "their",
]);
const PARTICLES = new Set(["me", "us", "up", "out"]);
const DRAFT_VERB_NEXT = new Set([
  "a", "an", "the", "my", "our", "your", "his", "her", "their", "this", "that", "these", "those", "some", "me",
  "us", "up", "out", "it", "something", "new",
]);
/** "the draft", "my first draft": draft used as a noun. */
const DRAFT_NOUN_PREV = new Set([
  "a", "an", "the", "my", "your", "our", "his", "her", "their", "this", "that", "first", "second", "third",
  "final", "rough", "new", "latest", "current", "previous", "old", "initial", "early", "working", "revised",
  "next", "its", "whose", "which",
]);
const PHRASE_STOPS = new Set([
  ",", "of", "about", "on", "for", "to", "from", "with", "in", "into", "regarding", "re", "covering", "based",
  "that", "which", "who", "whose", "where", "so", "because", "if", "when", "while", "by", "at", "as", "than",
  "using", "via", "explaining", "summarizing", "summarising", "describing", "showing", "outlining", "detailing",
  "highlighting", "comparing", "discussing", "analyzing", "analysing", "arguing", "persuading", "convincing",
  "introducing", "announcing", "asking", "requesting", "thanking", "telling", "including", "then", "but",
  "please",
]);
const CONJUNCTIONS = new Set(["and", "or", "plus", "&"]);
const QUESTION_STARTS = new Set([
  "how", "what", "why", "where", "which", "who", "whom", "whose", "is", "are", "was", "were", "does", "do",
  "did", "should", "shall", "am", "has", "have", "had", "isn't", "aren't", "doesn't", "didn't", "wasn't",
  "weren't", "whats", "what's", "how's", "hows",
]);
const LEAD_INS = new Set(["so", "ok", "okay", "hey", "hi", "hello", "um", "well", "and", "but", "also", "now"]);
const NEGATIONS = new Set(["don't", "dont", "not", "never", "no", "without", "instead", "rather", "stop", "avoid"]);
const ADVICE_BEFORE_TO = new Set([
  "tips", "way", "ways", "learn", "learning", "steps", "advice", "strategies", "ideas", "techniques", "how",
]);
const BARE_TOPIC_STOPS = new Set([
  "on", "about", "covering", "for", "regarding", "explaining", "summarizing", "summarising", "outlining",
  "comparing", "analyzing", "analysing", "arguing", "discussing", "describing",
]);

/** The user asked for the answer here, or is asking how to write something. */
const KEEP_IN_CHAT =
  /\b(?:(?:in|inside|within) (?:the |this )?chat|here in (?:the )?chat|in this (?:conversation|thread)|right here|just (?:reply|answer|tell me|respond))\b/;
const ADVICE_CUE =
  /\b(?:(?:any|some) (?:tips|advice|suggestions|pointers)|tips (?:for|on)|how (?:should|do|can|would) (?:i|we) (?:start|begin|structure|approach|organize|format)|where (?:do|should) (?:i|we) (?:start|begin))\b/;

/** Long messages are mostly pasted material: the request sits at the start or the end. */
const SCAN_HEAD_CHARS = 700;
const SCAN_TAIL_CHARS = 500;
const BARE_REQUEST_MAX_CHARS = 240;

type Verb = { word: string; start: number; soft: boolean; transformOnly: boolean };
type HeadClass = DraftHandoffKind | "short" | "inherit" | "code" | "unknown" | null;

/** Which Drafts editor fits this chat message, or null to answer it in chat. */
export function detectDraftHandoff(input: string): DraftHandoffKind | null {
  const withoutCode = input.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const trimmed = withoutCode.trim();
  if (!trimmed) return null;
  const scanned =
    trimmed.length > SCAN_HEAD_CHARS + SCAN_TAIL_CHARS
      ? `${trimmed.slice(0, SCAN_HEAD_CHARS)}\n${trimmed.slice(-SCAN_TAIL_CHARS)}`
      : trimmed;
  const text = collapsePhrases(normalize(scanned));
  if (KEEP_IN_CHAT.test(text) || ADVICE_CUE.test(text)) return null;
  const clauses = text.match(/[^.!?;:\n]+[.!?;:\n]*/g) ?? [];
  const allowBare = trimmed.length <= BARE_REQUEST_MAX_CHARS;
  for (const [index, rawClause] of clauses.entries()) {
    const tokens = tokenize(rawClause);
    if (!tokens.length) continue;
    const kind = clauseKind(tokens, rawClause.trim().endsWith("?"), allowBare && index === 0);
    if (kind) return kind;
  }
  return null;
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/(\d+)\s*-\s*(slides?|pages?|words?)\b/g, "$1-$2");
}

function collapsePhrases(value: string) {
  let next = value;
  // Spaced so "10-slide deck" still yields a separate head token.
  for (const pattern of DECK_PHRASES) next = next.replace(pattern, ` ${DECK_TOKEN} `);
  for (const pattern of DOC_PHRASES) next = next.replace(pattern, ` ${DOC_TOKEN} `);
  return next;
}

function tokenize(clause: string) {
  return clause.match(/,|[a-z0-9&_à-ÿ][a-z0-9'&_à-ÿ-]*/g)?.map((token) => token.replace(/'+$/, "")) ?? [];
}

function clauseKind(tokens: string[], isQuestion: boolean, allowBare: boolean): DraftHandoffKind | null {
  let first = 0;
  while (first < tokens.length && LEAD_INS.has(tokens[first])) first += 1;
  const opener = tokens[first];
  if (opener && (QUESTION_STARTS.has(opener) || (opener === "when" && isQuestion)) && !politeOpener(tokens, first)) {
    return null;
  }

  for (let index = first; index < tokens.length; index += 1) {
    const verb = verbAt(tokens, index);
    if (!verb || blockedBefore(tokens, index, first)) continue;
    const transformed = TRANSFORM_VERBS.has(verb.word) ? transformKind(tokens, verb.start) : null;
    if (transformed) return transformed;
    if (verb.transformOnly) continue;
    const { phrase, stop, stopIndex } = phraseAfter(tokens, verb.start);
    let object = phrase;
    if (verb.soft && object.length && EXISTING_OBJECTS.has(object[0])) {
      // "make this a slide deck" names a new artifact; "make the essay longer" edits one.
      if (!(["it", "this", "that"].includes(object[0]) && ["a", "an"].includes(object[1] ?? ""))) continue;
      object = object.slice(1);
    }
    const kind = objectKind(object, stop, tokens, stopIndex, verb.word === "draft");
    if (kind) return kind;
  }

  if (allowBare) {
    // "Essay on the French Revolution", "PowerPoint about solar energy".
    const { phrase, stop, stopIndex } = phraseAfter(tokens, first);
    if (stop && BARE_TOPIC_STOPS.has(stop) && phrase.length <= 6) {
      const kind = objectKind(phrase, stop, tokens, stopIndex, false);
      if (kind) return kind;
    }
  }
  return null;
}

/** "Is it possible to…", "Are you able to…", "Do you mind…" ask for the work, not about it. */
function politeOpener(tokens: string[], first: number) {
  const [opener, second, third] = tokens.slice(first, first + 3);
  if (opener === "is") return second === "it" && third === "possible";
  if (opener === "are") return second === "you" && (third === "able" || third === "capable");
  if (opener === "do") return second === "you" && third === "mind";
  return false;
}

function verbAt(tokens: string[], index: number): Verb | null {
  const word = tokens[index];
  const next = tokens[index + 1];
  const previous = tokens[index - 1];
  const beforePrevious = tokens[index - 2];
  if (word === "draft") {
    if (previous && DRAFT_NOUN_PREV.has(previous)) return null;
    if (!next || !(DRAFT_VERB_NEXT.has(next) || /^\d/.test(next) || NUMBER_WORDS.has(next))) return null;
  }
  if (STRONG_VERBS.has(word)) return { word, start: skipParticles(tokens, index + 1), soft: false, transformOnly: false };
  if (SOFT_VERBS.has(word)) return { word, start: skipParticles(tokens, index + 1), soft: true, transformOnly: false };
  if (word === "put" && next === "together") return { word, start: index + 2, soft: true, transformOnly: false };
  if (word === "put" && tokens.slice(index + 1, index + 9).includes("together")) {
    // "put a deck together": the trailing "together" drops as filler.
    return { word, start: index + 1, soft: true, transformOnly: false };
  }
  if (["throw", "whip", "mock"].includes(word) && (next === "together" || next === "up")) {
    return { word, start: index + 2, soft: true, transformOnly: false };
  }
  if (word === "come" && next === "up" && tokens[index + 2] === "with") {
    return { word, start: index + 3, soft: true, transformOnly: false };
  }
  if (["give", "show", "send", "get"].includes(word) && (next === "me" || next === "us")) {
    return { word, start: index + 2, soft: true, transformOnly: false };
  }
  if (word === "help" && (next === "me" || next === "us") && tokens[index + 2] === "with") {
    return { word, start: index + 3, soft: true, transformOnly: false };
  }
  const firstPerson = (token: string | undefined) => token === "i" || token === "we" || token === "i'd" || token === "we'd";
  if (
    ["want", "need", "like", "love"].includes(word) &&
    (firstPerson(previous) || (previous === "would" && firstPerson(beforePrevious)))
  ) {
    let start = index + 1;
    if (tokens[start] === "to" && ["see", "have", "get", "receive", "view", "read"].includes(tokens[start + 1] ?? "")) {
      start += 2;
    }
    return { word, start, soft: true, transformOnly: false };
  }
  if (
    ["get", "have", "see"].includes(word) &&
    firstPerson(previous) &&
    ["can", "could", "may"].includes(beforePrevious ?? "")
  ) {
    return { word, start: index + 1, soft: true, transformOnly: false };
  }
  if (TRANSFORM_VERBS.has(word)) return { word, start: index + 1, soft: false, transformOnly: true };
  return null;
}

function skipParticles(tokens: string[], start: number) {
  let index = start;
  while (index < tokens.length && PARTICLES.has(tokens[index])) index += 1;
  return index;
}

/** Questions about writing ("how to write a memo"), refusals ("don't make
 * slides"), and advice ("tips to write a resume") are not requests. */
function blockedBefore(tokens: string[], index: number, clauseStart: number) {
  for (let cursor = clauseStart; cursor < index; cursor += 1) {
    if (tokens[cursor] === "how" || tokens[cursor] === "what") return true;
  }
  // A comma ends the refusal: "No, write a memo instead" is a request.
  for (let cursor = index - 1; cursor >= Math.max(clauseStart, index - 5) && tokens[cursor] !== ","; cursor -= 1) {
    if (NEGATIONS.has(tokens[cursor])) return true;
  }
  return tokens[index - 1] === "to" && ADVICE_BEFORE_TO.has(tokens[index - 2] ?? "");
}

function phraseAfter(tokens: string[], start: number) {
  const phrase: string[] = [];
  let index = start;
  for (; index < tokens.length && phrase.length < 10; index += 1) {
    const token = tokens[index];
    // A second request verb starts a new clause ("write a memo, then make slides");
    // "draft" used as a noun ("the first draft of") does not.
    const nextVerb = phrase.length > 0 && (STRONG_VERBS.has(token) || SOFT_VERBS.has(token)) && verbAt(tokens, index);
    if (PHRASE_STOPS.has(token) || nextVerb) {
      return { phrase, stop: token, stopIndex: index };
    }
    phrase.push(token);
  }
  return { phrase, stop: null as string | null, stopIndex: index };
}

/** "turn this into a slide deck", "write the above up as a memo". */
function transformKind(tokens: string[], start: number): DraftHandoffKind | null {
  for (let index = start; index < Math.min(tokens.length, start + 10); index += 1) {
    const token = tokens[index];
    if (token === ",") return null;
    if (!TRANSFORM_CONNECTORS.has(token) || index === start) continue;
    const { phrase, stop, stopIndex } = phraseAfter(tokens, index + 1);
    const kind = objectKind(phrase, stop, tokens, stopIndex, false);
    if (kind) return kind;
  }
  return null;
}

function objectKind(
  phrase: string[],
  stop: string | null,
  tokens: string[],
  stopIndex: number,
  draftVerb: boolean,
): DraftHandoffKind | null {
  if (!phrase.length) return null;
  const conjuncts: string[][] = [[]];
  for (const token of phrase) {
    if (CONJUNCTIONS.has(token)) conjuncts.push([]);
    else conjuncts[conjuncts.length - 1].push(token);
  }
  const classes = conjuncts.map((words, position) =>
    headClass(words, position === conjuncts.length - 1 ? stop : null, tokens, stopIndex),
  );
  if (classes.includes("code")) return null;
  const found = classes.find((value): value is DraftHandoffKind => value === "document" || value === "deck");
  if (found) {
    // "a report in Python", "slides as HTML": the deliverable is code.
    const after = tokens.slice(stopIndex + 1, stopIndex + 4);
    if (stop && ["in", "using", "with", "as", "via"].includes(stop) && after.some((word) => CODE_WORDS.has(word))) {
      return null;
    }
    return found;
  }
  const lastClass = classes[classes.length - 1];
  if (lastClass === "inherit" && (stop === "of" || stop === "for")) {
    // "a first draft of my essay", "a template for a board presentation".
    const { phrase: owner, stop: ownerStop, stopIndex: ownerStopIndex } = phraseAfter(tokens, stopIndex + 1);
    const ownerClass = headClass(owner, ownerStop, tokens, ownerStopIndex);
    if (ownerClass === "document" || ownerClass === "deck") return ownerClass;
  }
  if (draftVerb && classes.every((value) => value === "unknown" || value === "inherit")) return "document";
  return null;
}

function headClass(words: string[], stop: string | null, tokens: string[], stopIndex: number): HeadClass {
  const trimmed = [...words];
  while (trimmed.length && TRAILING_FILLERS.has(trimmed[trimmed.length - 1])) trimmed.pop();
  if (!trimmed.length) return null;
  if (trimmed.some((word) => CODE_WORDS.has(word))) return "code";
  let headIndex = trimmed.length - 1;
  if (INHERIT_HEADS.has(trimmed[headIndex])) {
    // "memo template", "pptx file": the form takes its noun's
    // kind; "the first draft" alone waits for an "of …" owner.
    let owner = headIndex - 1;
    while (owner >= 0 && headClass([trimmed[owner]], null, tokens, stopIndex) === "unknown") owner -= 1;
    if (owner < 0) return "inherit";
    headIndex = owner;
  }
  const head = trimmed[headIndex];
  const modifier = trimmed[headIndex - 1] ?? "";
  if (DECK_HEADS.has(head) || /^\d+-slides?$/.test(head)) return "deck";
  if (head === "deck" || head === "decks") {
    if (DECK_QUALIFIERS.has(modifier) || /^\d+-slides?$/.test(modifier)) return "deck";
    if (stop && DECK_TOPIC_STOPS.has(stop)) return "deck";
    if (stop === "of" && tokens[stopIndex + 1] === "slides") return "deck";
    if (stop === "for" && tokens.slice(stopIndex + 1, stopIndex + 4).some((word) => DECK_AUDIENCE_WORDS.has(word))) {
      return "deck";
    }
    return "unknown";
  }
  if (DOC_HEADS.has(head)) return "document";
  if ((head === "pages" || head === "page") && isCount(modifier)) return "document";
  if ((head === "words" || head === "word") && isWordCount(modifier)) return "document";
  if (/^\d+-pages?$/.test(head)) return "document";
  if (SHORT_HEADS.has(head)) return "short";
  return "unknown";
}

function isCount(word: string) {
  return /^\d+$/.test(word) || NUMBER_WORDS.has(word);
}

/** A few hundred words is an answer; a long-form word count is a document. */
function isWordCount(word: string) {
  if (/^\d+$/.test(word)) return Number(word) >= 300;
  return word === "hundred" || word === "thousand";
}

// ---------------------------------------------------------------------------
// Context that travels with the request
// ---------------------------------------------------------------------------

const CHAT_CONTEXT_CHAR_LIMIT = 16000;
const CHAT_CONTEXT_MESSAGE_CHAR_LIMIT = 6000;
const HANDOFF_ATTACHMENT_LIMIT = 8;

/** Earlier turns of the chat as plain text for the drafting prompt, newest
 * kept first when the conversation is longer than the budget. Null for a new
 * chat. Thinking traces, failed replies, and still-streaming replies are left out. */
export function draftHandoffChatContext(
  messages: readonly ChatMessage[],
  limit = CHAT_CONTEXT_CHAR_LIMIT,
): string | null {
  const turns = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => message.status !== "pending" && message.status !== "error")
    .map((message) => {
      const active = messageWithActiveResponseVersion(message);
      const text = (
        active.role === "assistant" ? splitAssistantThinking(active.content).visibleContent : active.content
      ).trim();
      const attached = (active.attachments ?? []).map((attachment) => attachment.name).filter(Boolean);
      if (!text && !attached.length) return null;
      const clipped =
        text.length > CHAT_CONTEXT_MESSAGE_CHAR_LIMIT
          ? `${text.slice(0, CHAT_CONTEXT_MESSAGE_CHAR_LIMIT).trimEnd()} […]`
          : text;
      const label = active.role === "user" ? "User" : "Assistant";
      const files = attached.length ? `\n(Attached: ${attached.join(", ")})` : "";
      return `${label}: ${clipped}${files}`;
    })
    .filter((turn): turn is string => Boolean(turn));
  if (!turns.length) return null;
  const kept: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (kept.length && used + turn.length > limit) break;
    kept.unshift(turn.length > limit ? `${turn.slice(0, limit).trimEnd()} […]` : turn);
    used += turn.length + 2;
  }
  const omitted = turns.length - kept.length;
  return [omitted > 0 ? `[${omitted} earlier message${omitted === 1 ? "" : "s"} omitted]` : "", ...kept]
    .filter(Boolean)
    .join("\n\n");
}

/** Files Drafts should read: the ones on this message first, then the
 * newest files shared earlier in the chat. Only uploaded files (with an id)
 * can travel; duplicates collapse. */
export function draftHandoffAttachments(
  current: readonly ChatAttachment[],
  messages: readonly ChatMessage[],
  limit = HANDOFF_ATTACHMENT_LIMIT,
): DraftHandoffAttachment[] {
  const earlier = [...messages]
    .reverse()
    .filter((message) => message.role === "user")
    .flatMap((message) => message.attachments ?? []);
  const seen = new Set<string>();
  const result: DraftHandoffAttachment[] = [];
  for (const attachment of [...current, ...earlier]) {
    const id = attachment.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      attachmentId: id,
      name: attachment.name,
      size: attachment.size,
      hasText: Boolean(attachment.text_preview?.trim()) || attachment.kind.trim().toLowerCase() === "image",
    });
    if (result.length >= limit) break;
  }
  return result;
}
