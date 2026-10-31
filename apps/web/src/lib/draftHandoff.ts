/**
 * Chat → Drafts handoff. When a chat message asks for a whole document, a
 * slide deck, or a spreadsheet, chat holds the message and offers to build it
 * in Drafts. This
 * module decides which offer (if any) applies and assembles what Drafts needs
 * to start the same request without the user retyping it.
 *
 * Detection works on positive evidence, because a false offer costs the user
 * a click on every such message, and a miss only leaves the answer in chat.
 * Each step has to earn the next:
 *
 * 1. Whose words: quoted lines, transcripts, and letters to someone else drop
 *    out, and a long paragraph among others keeps only its first and last
 *    sentences. The last word wins: a message that goes on to ask something
 *    else is asking about what came first.
 * 2. Spelling: one pass corrects typos, so the grammar never sees one.
 * 3. Who does the work: after a break a verb gives an order, after a modal its
 *    subject decides, and after "to" the frame around it does. That covers any
 *    courteous framing and leaves out reports ("Sarah will make the slides").
 * 4. What it names: the object's head noun must be a deliverable. Words with a
 *    second life ("deck", "slides", "sheet", "presentation") need evidence that
 *    they mean this one.
 *
 * A short message can also skip the verb ("Spreadsheet to track my meds"), if
 * the fragment opens with a deliverable and goes on to say what it is for.
 */
import { splitAssistantThinking } from "./assistantThinking";
import { messageWithActiveResponseVersion } from "./chatStore";
import type { ChatAttachment, ChatMessage } from "./types";

export type DraftHandoffKind = "document" | "deck" | "spreadsheet";

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
  /\b(?:slide|deck|powerpoint)[\s-]?(?:form|format)\b/g,
  /\bslide[\s-]?(?:decks?|deks?|dec|desk)\b/g,
  /\bslide back(?= (?:on|about|for)\b)/g,
  /\bslide[\s-]?shows?\b/g,
  /\bpitch[\s-]?(?:decks?|books?)\b/g,
  /\bgoogle slides\b/g,
  /\bpower[\s-]?p(?:oint|iont|ont|oin|int|onit)s?\b/g,
  /\bpptx? (?:files?|decks?)\b/g,
];
const SHEET_PHRASES = [
  /\bgoogle sheets?\b/g,
  /\bspread[\s-]?sheets?\b/g,
  /\bpivot[\s-]?tables?\b/g,
  /\bexcel (?:work[\s-]?books?|files?|sheets?|documents?|docs?)\b/g,
  /\bxlsx(?: files?)?\b/g,
];
const DOC_PHRASES = [
  /\bstatements? of (?:work|purpose)\b/g,
  /\banswers? to (?:the |a |an |this )?(?:complaint|petition|counterclaim|cross-?claim)\b/g,
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
const SHEET_TOKEN = "__sheet__";

// Spelling. One pass, ahead of the grammar, so nothing below sees a typo.

/** Slips too short or too far for the one-edit rule. None is a word. */
const KNOWN_SLIPS = new Map([
  ["mak", "make"], ["mke", "make"], ["mkae", "make"], ["maek", "make"], ["amke", "make"], ["bild", "build"],
  ["buld", "build"], ["buid", "build"], ["wrte", "write"],
  ["prepair", "prepare"], ["leter", "letter"], ["memmo", "memo"], ["polcy", "policy"], ["eassy", "essay"],
  ["handbok", "handbook"], ["exel", "excel"], ["exell", "excel"], ["excell", "excel"], ["excl", "excel"],
  ["dekc", "deck"], ["pwrpoint", "powerpoint"], ["pich", "pitch"], ["cna", "can"], ["coudl", "could"], ["woudl", "would"],
  ["yuo", "you"], ["gogle", "google"], ["pleaes", "please"], ["plese", "please"], ["plaese", "please"], ["pleae", "please"],
]);
/** Words worth correcting by one edit, listed rather than derived from the
 * vocabulary: "pleading" is a slip from "leading", "complaint" from "compliant". */
const SPELLED_WORDS = [
  "write", "draft", "create", "generate", "prepare", "produce", "compose", "author", "craft", "build", "design", "develop",
  "together", "presentation",
  "presentations", "powerpoint", "powerpoints", "slideshow", "slideshows", "slide", "slides", "keynote", "keynotes",
  "spreadsheet", "spreadsheets", "workbook", "workbooks", "document", "documents", "proposal", "proposals", "contract",
  "contracts", "agreement", "agreements", "newsletter", "newsletters", "memorandum", "dissertation", "whitepaper",
  "whitepapers", "report", "reports", "essay", "essays", "policy", "business", "personal", "literature", "employee",
  "handbook",
];
/** A word this short has too many real neighbors to call it a typo. */
const MIN_TYPO_LETTERS = 5;
/** Long enough to survive two slips: "presntaion". */
const TWO_SLIP_WORDS = ["presentation", "presentations", "powerpoint", "spreadsheet"];
/** Real words one edit from a spelled word. */
const NOT_TYPOS = new Set([
  "white", "wrote", "writs", "trite", "drift", "graft", "kraft", "crete", "crease", "product", "procure", "compost",
  "compote", "venerate", "sides", "slices", "slice", "slimes", "slime", "glides", "glide", "elides", "elide", "snide",
  "sliders", "slider", "sideshow", "sideshows", "contact", "contacts", "contrast", "contrasts", "wordbook", "wordbooks",
  "resort", "resorts", "repost", "reposts", "retort", "retorts", "repot", "assay", "assays", "police", "polity",
  "busyness", "persona", "personas", "employer", "employed", "tethers", "deport", "deports", "bushiness", "cremate", "croft",
  "writhe", "lease", "leases", "built", "guild", "resign", "deign", "builds",
]);

// Who is speaking.

const QUOTED_SPAN = /["“][^"”\n]{12,}["”]/g;
const QUOTED_LINE = /^\s*(?:>|[-*•]\s|\d+[.)]\s|\[[ x]?\])/i;
/** Every line labelled by its speaker: a transcript or a chat log. */
const SPEAKER_LABEL = /^\s*(?:\[[^\]]*\]\s*)?(?:[a-z][\w.' -]{0,24}:|[a-z]\.)\s/i;
const MATERIAL_REFERENCE = /\b(?:(?:this|these|the following)\s+(?:email|e-mail|message|thread|notes?|minutes|letter|text)\b|this\s*\?$|^\W*(?:is|does|did|was)\s+this\b)/;
/** "Here's the email: Hi Sam, please…": the paragraph goes on quoting it. */
const INLINE_MATERIAL = /^([^:\n]{0,80}\b(?:email|e-mail|message|thread|notes?|minutes|transcript|text|letter)\b[^:\n]{0,40}:)\s+\S[\s\S]*$/i;
const LETTER_HEADER = /^\s*(?:from|to|sent|subject|date|cc|bcc):/i;
const LETTER_HEADER_MAX_CHARS = 100;
const LETTER_OPENING = /^\s*(?:hi|hello|hey|dear|good (?:morning|afternoon))\s+([a-z]+)\s*[,!:]/i;
const LETTER_CLOSING = /^\s*(?:thanks|thank you|regards|best|cheers|sincerely|best regards|kind regards|many thanks)\b[^\n]{0,20}[,.!]?\s*(?:\n|$)/i;
/** Names a greeting can use and still be talking to the assistant. */
const ASSISTANT_NAMES = new Set(["there", "aperture", "assistant", "claude", "chatgpt", "ai", "bot", "again", "friend"]);
/** Long messages are mostly pasted material: the request sits at the start, at
 * the end, or in a short paragraph of its own. */
const SCAN_HEAD_CHARS = 700;
const SCAN_TAIL_CHARS = 500;
/** In a message of several paragraphs, a longer one is a body, not the user's voice. */
const BODY_MIN_CHARS = 400;
const BARE_REQUEST_MAX_CHARS = 240;
const PREAMBLE_MAX_WORDS = 4;
const TASK_LIST_MIN_LINES = 3;
/** Words that make a colon-closed clause a label: fewer than this after it reads as a note. */
const TITLE_MIN_WORDS = 3;
/** The user asked for the answer here, or is asking how to write something. */
const KEEP_IN_CHAT =
  /\b(?:(?:in|inside|within) (?:the |this )?chat|here in (?:the )?chat|in this (?:conversation|thread)|right here|just (?:reply|answer|tell me|respond))\b/;
/** Advice is asked for at the start of a clause and stands alone there. "A deck
 * with some tips for associates" and "any ideas you have" do not ask for any. */
const ADVICE_CUE =
  /(?:^|[,.!?;:\n]\s*)(?:(?:any|some) (?:tips|advice|suggestions|pointers|thoughts|ideas)\s*(?:[?.!]|$|on\b|for\b|about\b)|tips (?:for|on)\b)|\bhow (?:should|do|can|would) (?:i|we) (?:start|begin|structure|approach|organize|format)\b|\bwhere (?:do|should) (?:i|we) (?:start|begin)\b/m;
/** Closing check-ins that ask nothing new: "Does that work?". */
const CHECK_IN = /^(?:(?:is|does|would|will|can) (?:that|this|it) (?:be )?(?:ok|okay|alright|all right|fine|possible|doable|work|make sense|clear|enough|good|right)\b|how(?:'s| does| do| would) (?:that|this|it) (?:sound|look|seem)\b|how long (?:will|would) (?:that|this|it) take\b)/;
/** "Translate this", "Summarize the terms above": aimed back at what came first. */
const POINTS_BACK = new Set(["this", "that", "these", "those", "above", "here"]);
/** A closing question replaces the request when it turns to the text, to other
 * people, or to how the user should react. Anything else follows the request. */
const TURNS_AWAY = new Set([
  ...POINTS_BACK, "he", "she", "they", "him", "her", "them", "fair", "reasonable", "unreasonable", "rude", "normal",
  "allowed", "wrong", "say", "respond", "reply", "push", "ask", "tell",
]);
/** "Greg asked:": the words after the colon are someone else's. */
const SAYING_VERBS = new Set(["said", "says", "asked", "asks", "wrote", "writes", "emailed", "texted", "replied", "back"]);
const RETRACTION = /\b(?:never ?mind|scratch that|forget (?:it|that)|on second thought|don't bother|cancel that|actually,? (?:no|don't|do not|skip))\b/;
/** Instructions about pasted material: what follows their colon is the material. */
const CHAT_TASK_VERBS = new Set([
  "reply", "respond", "answer", "summarize", "summarise", "review", "translate", "proofread", "fix", "edit", "explain",
  "analyze", "analyse", "rewrite", "check", "extract", "shorten", "tell", "read", "critique", "improve", "correct",
  "paraphrase", "simplify", "classify", "identify", "find", "look", "reword", "rephrase",
]);

// Who does the work.

/** Words that can stand in front of a verb without changing who does the work. */
const FILLERS = new Set([
  "ok", "okay", "hey", "hi", "hello", "um", "well", "also", "now", "just", "maybe", "perhaps", "really", "quickly", "possibly", "aperture", "assistant",
  "simply", "actually", "probably", "go", "ahead", "yes", "yeah", "sure", "there", "next", "up", "asap", "quick", "real",
]);
/** Each of these starts a fresh chance to give an order. */
const SEGMENT_BREAKS = new Set([",", "so", "then", "but"]);
/** Courtesy carries no grammar, so it drops before parsing: "Create please a deck". */
const POLITE_WORDS = new Set(["please", "pls", "plz", "kindly"]);
/** Right before a verb, these hand it over. Everything else about who does the
 * work comes from the grammar around "to" and the modals, not from a list of openers. */
const DIRECT_CUES = new Set([
  "let's", "lets", "let us", "help me", "help us", "help", "mind", "gotta", "wanna", "need", "use", "you'd", "you'll",
  "better", "that you",
]);
/** A clause that opens "could you …" or "won't you …" asks, whatever comes between. */
const INVERTED_MODALS = new Set(["can", "could", "would", "will", "might", "can't", "couldn't", "wouldn't", "won't"]);
const MODALS = new Set(["can", "could", "would", "will", "shall", "should", "may", "might", "must"]);
const ADDRESSEES = new Set(["you", "u", "you'd", "you'll", "someone", "somebody", "anyone"]);
const FIRST_PERSON = new Set(["i", "we", "i'd", "we'd", "i'm", "im", "we're", "i've", "we've"]);
/** Before "to": someone else's task, not a frame around a request. */
const THIRD_PERSON = new Set(["he", "she", "they", "him", "her", "them", "who"]);
const REPORTING_VERBS = new Set(["is", "was", "were", "are", "has", "had", "did", "does", "will", "shall", "took", "hired", "paid"]);
/** Right before "to": "tips to write", "a script to generate", "going to make". */
const NOT_FRAMES = new Set([
  "tips", "way", "ways", "learn", "learning", "steps", "advice", "strategies", "ideas", "techniques", "how", "tool", "tools",
  "permit", "going", "used", "use", "whether", "forgot", "failed", "refused", "offered", "promised",
]);
/** "Your task is to …", "the goal is to …": the sentence hands over the work. */
const ROLE_NOUNS = new Set(["task", "job", "goal", "assignment", "mission", "role", "ask", "request"]);
/** "If you want to make a deck, open PowerPoint" sets a scene. */
const SUBORDINATORS = new Set(["if", "when", "whenever", "once", "while", "before", "unless", "until"]);
/** After these, an order can follow a leading phrase: "Using these notes make a deck". */
const FRONTING_WORDS = new Set(["based", "using", "from", "with", "given", "per", "for", "after", "if", "at", "once", "as", "in"]);
const STRONG_VERBS = new Set(["write", "draft", "create", "generate", "prepare", "produce", "compose", "author", "craft"]);
/** Verbs that also edit existing work ("make the essay longer"), so they want a new object. */
const SOFT_VERBS = new Set([
  "make", "build", "design", "develop", "assemble", "compile", "start", "begin", "outline", "sketch", "provide", "formulate",
  "devise", "construct", "pen", "prep", "storyboard", "ghostwrite",
]);
/** "Build the slides" makes them; "start the presentation" runs one. */
const MAKING_VERBS = new Set(["make", "build", "design", "develop", "assemble", "prep"]);
/** Carpentry verbs: "build a deck for X" needs X to be someone who sits through slides. */
const CONSTRUCTION_VERBS = new Set(["build", "design", "construct", "assemble"]);
/** "write", "draft", and "compose" a keynote or a dek in words, not slides. */
const WRITING_VERBS = new Set(["write", "draft", "compose", "pen", "author"]);
const VERB_FORMS = [...STRONG_VERBS, ...SOFT_VERBS, "do", "put", "pull", "whip", "throw", "help"];
/** After these, "making a deck" asks for one. */
const GERUND_CUES = new Set(["mind", "help", "try", "consider", "for"]);
const GERUNDS = new Map(
  VERB_FORMS.map((verb) => [`${verb.replace(/e$/, "")}${["put"].includes(verb) ? "ting" : "ing"}`, verb]),
);
/** Word sequences that open a request; the object comes right after them. */
const REQUEST_PHRASES = [
  "come up with", "give me", "give us", "gimme", "show me", "show us", "send me", "send us", "get me", "get us",
  "help me with", "help us with", "help with", "how about", "let's see", "lets see", "let me see", "let us see",
  "take a stab at", "take a crack at", "have a go at", "work on", "ask you for", "trouble you for", "bother you for",
].map((phrase) => phrase.split(" "));
/** "whip up a deck", "whip me up a deck", "pull a deck together". */
const PHRASAL_VERBS = new Map([
  ["put", ["together"]], ["get", ["together", "going"]], ["pull", ["together"]], ["slap", ["together"]], ["cobble", ["together"]],
  ["piece", ["together"]], ["throw", ["together", "up"]], ["whip", ["together", "up"]], ["mock", ["together", "up"]],
  ["knock", ["together", "out"]], ["bang", ["together", "out"]], ["work", ["up"]], ["spin", ["up"]], ["cook", ["up"]],
  ["draw", ["up"]], ["type", ["up"]], ["set", ["up"]], ["crank", ["out"]], ["churn", ["out"]], ["rough", ["out"]],
]);
const WISH_VERBS = new Set(["want", "need", "like", "love", "appreciate", "require", "request", "seek", "prefer", "welcome", "mind"]);
/** "Can I get a deck", "I'd like to see a report". */
const RECEIVE_VERBS = new Set(["get", "have", "see", "receive", "view", "read"]);
const RECEIVE_CUES = new Set(["can i", "could i", "may i", "can we", "could we", "possible to", "want to", "like to", "love to"]);
const LOOKUP_PHRASES = ["looking for", "seeking", "requesting", "hoping for", "in need of"].map((phrase) => phrase.split(" "));
const RECASTABLE = new Set(["it", "this", "that"]);
/** Verbs that only reshape existing content: "turn this into a deck". */
const TRANSFORM_VERBS = new Set([
  "turn", "convert", "transform", "rewrite", "reformat", "restructure", "repurpose", "recast", "adapt", "change",
  "organize", "summarize", "summarise", "condense", "distill", "compile", "present", "put", "redo", "export", "move",
  "copy", "format", "expand", "write", "draft", "make", "create", "build", "develop", "do",
]);
const TRANSFORM_CONNECTORS = new Set(["into", "to", "as", "in"]);
/** Imperatives that ask for a format rather than name an object: "List the
 * states in a table", "Compare the plans in a matrix". */
const FORMAT_VERBS = new Set([
  "list", "compare", "tabulate", "rank", "break", "lay", "map", "sort", "group", "track", "plan", "calculate", "log",
]);
/** "Explain the rule in a PowerPoint": a deck is a way to tell it, a table is not. */
const TELLING_VERBS = new Set(["explain", "walk", "describe", "teach", "show"]);
const PARTICLES = new Set(["me", "us", "up", "out"]);
/** "Create for me a deck": who the work is for, ahead of its object. */
const BENEFICIARY_PRONOUNS = new Set(["me", "us", "myself", "ourselves", "him", "her", "them"]);
const DRAFT_OBJECT_OPENERS = new Set(["out", "something", "new"]);
/** "Do a deck" is a command; "do the slides need a title" and "do you" are not. */
const DO_COMMAND_NEXT = new Set(["a", "an", "some", "me", "us", "up", "this", "that", "it", "for"]);
const NEGATIONS = new Set([
  "don't", "dont", "not", "never", "no", "nobody", "without", "instead", "rather", "stop", "avoid",
]);
const QUESTION_STARTS = new Set([
  "how", "what", "why", "where", "which", "who", "whom", "whose", "is", "are", "was", "were", "does", "do", "did",
  "should", "shall", "am", "has", "have", "had", "isn't", "aren't", "doesn't", "didn't", "wasn't", "weren't", "whats",
  "what's", "how's", "hows",
]);
/** A clause that opens like a question and still asks for the work. */
const ADDRESSED =
  /\b(?:you|u) (?:could|can|would|will|might|mind)\b|\b(?:you|u) (?!want me|need me)(?:(?!i |we |they |he |she )\S+ ){0,3}to\b|\bpossible (?:to|for)\b|\bhow about\b/;
const WH_WORDS = new Set(["what", "which", "how", "who", "why", "where", "whats", "what's", "how's", "hows", "who's"]);

// What it names.

/** Words that name a spreadsheet as the deliverable. */
const SHEET_HEADS = new Set([SHEET_TOKEN, "excel", "xlsx", "timesheet", "timesheets"]);
/** A paper sheet or a classroom workbook unless something says otherwise. */
const CUED_SHEET_HEADS = new Set(["sheet", "sheets", "workbook", "workbooks"]);
const SHEET_CUES = new Set([
  "track", "tracks", "tracking", "tracker", "calculate", "calculates", "calculating", "compare", "compares", "comparing",
  "score", "scores", "tally", "tallies", "rank", "ranks", "log", "logs", "tab", "tabs", "formula", "formulas", "totals",
  "budget", "expense", "expenses", "balance", "time", "analysis", "sales", "financial", "audit", "forecast", "reconciliation",
  "schedule", "plan", "headcount",
]);
/** "an Excel tracker", "a Google Sheets budget": these nouns become a
 * spreadsheet when a spreadsheet word qualifies them. "An Excel formula" or
 * "an Excel chart" stays in chat. */
const SHEET_QUALIFIED_HEADS = new Set([
  "tracker", "trackers", "template", "templates", "model", "models", "budget", "budgets", "dashboard", "dashboards",
  "calculator", "calculators", "planner", "planners", "table", "tables", "log", "logs", "schedule", "schedules", "sheet",
  "sheets", "database", "list", "lists", "ledger", "roster", "inventory",
]);
/** Tabular deliverables: "a state-by-state matrix", "a table comparing the
 * vendors", "a habit tracker". They are offered as a spreadsheet only when
 * nothing in the request names a document or a deck, so "a report with the
 * results in a table" stays a document. */
const TABLE_HEADS = new Set(["table", "tables", "matrix", "matrices", "tracker", "trackers", "crosswalk", "crosswalks"]);
/** "A markdown table" asks for chat formatting, not a workbook. */
const TABLE_CHAT_FORMATS = new Set(["markdown", "ascii", "text", "plaintext", "plain-text", "inline", "word", "notion"]);
/** "A coffee table" is furniture. */
const TABLE_FURNITURE = new Set([
  "coffee", "dining", "kitchen", "picnic", "side", "end", "bedside", "nightstand", "folding", "pool", "ping-pong", "poker",
  "card", "patio", "farmhouse", "drafting", "console", "banquet", "changing", "water", "wooden", "wood", "periodic",
]);

const DECK_HEADS = new Set([
  DECK_TOKEN, "deck", "decks", "presentation", "presentations", "slides", "slide", "ppt", "ppts", "pptx", "pptxs",
  "keynote", "keynotes", "preso", "presos", "prezo", "prezos", "prezi", "dek", "deks",
]);
/** Heads that also name real things: a backyard deck, a playground slide, Adidas slides. */
const AMBIGUOUS_DECK_HEADS = new Set(["deck", "decks", "slide", "slides", "presentation", "presentations"]);
/** "Write a keynote" is a speech, and "write a dek" is a subheadline. */
const WRITTEN_SENSE_HEADS = new Set(["keynote", "keynotes", "dek", "deks"]);
/** Slides live here: before an ambiguous head ("a board deck") or after "for"
 * ("a deck for the board"). A word missing from this list stays in chat. */
const DECK_CONTEXT = new Set([
  "demonstrative", "demonstratives",
  "sales", "investor", "investors", "board", "marketing", "strategy", "training", "kickoff", "kick-off", "onboarding", "orientation", "product", "company", "quarterly", "qbr", "conference", "webinar", "startup",
  "fundraising", "client", "clients", "customer", "customers", "team", "all-hands", "roadshow", "demo", "overview",
  "intro", "update", "status", "budget", "project", "roadmap", "research", "results", "earnings", "recruiting", "hiring",
  "sponsorship", "partnership", "lecture", "class", "course", "workshop", "seminar", "briefing", "review",
  "compliance", "privacy", "litigation", "legal", "finance", "financial", "hr", "benefits", "policy", "risk", "merger", "deal",
  "practice", "firm", "partner", "partners", "associate", "associates", "cle", "dei", "annual", "monthly", "weekly", "year-end",
  "capabilities", "case", "executive", "executives", "leadership", "management", "stakeholders", "analysis", "competitive",
  "proposal", "walkthrough", "walk-through", "steering", "meeting", "meetings", "talk", "pitch", "pitching", "offsite",
  "retreat", "summit", "launch", "session", "call", "interview", "students", "attorneys", "lawyers", "staff", "employees",
  "committee", "council", "group", "groups", "trial", "jury", "judge", "court", "hearing", "mediation", "deposition", "panel",
]);
/** Say nothing about which deck: "a short deck for my patio" could be either.
 * The comma in "a long, thorough proposal" does not end the object. */
const PLAIN_ADJECTIVES = new Set([
  "new", "short", "quick", "brief", "simple", "clean", "full", "basic", "good", "great", "nice", "detailed", "professional",
  "polished", "minimal", "modern", "some", "little", "big", "long", "clear", "concise", "punchy", "engaging", "compelling",
  "visual", "fresh", "updated", "final", "thorough", "comprehensive", "formal", "persuasive",
]);
/** Label-like compounds that ask for themselves: "Q3 earnings deck", "Investor deck". */
const DECK_LABELS = new Set(["board", "investor", "investors", "sales", "earnings"]);
/** "a deck for me", "a deck for next week". */
const DUE_WORDS = new Set(["me", "us", "next", "this", "end"]);
const SCHEDULE_DAYS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "tomorrow", "today", "tonight",
]);
/** "a deck with ten slides": things only slides have. */
const SLIDE_CONTENTS = new Set([
  "slides", "slide", "charts", "graphs", "visuals", "images", "speaker", "bullets", "agenda", DECK_TOKEN,
]);
/** Places and materials that put a deck outside the screen, anywhere ahead of its topic. */
const DECK_ELSEWHERE = new Set([
  "backyard", "patio", "porch", "yard", "garden", "pool", "boat", "ship", "house", "roof", "cabin", "cedar", "lumber", "wood",
  "flashcard", "flashcards", "anki", "quizlet", "magic", "pokemon", "pokémon", "commander", "tarot", "hearthstone", "yugioh",
  "cards", "sale", "rent", "backyards", "patios", "yards", "pools", "boats", "park", "playground",
]);
const DECK_TOPIC_STOPS = new Set(["on", "about", "regarding", "re", "covering"]);
/** "PowerPoint training", "a 6 slide intro": a deck word turns these into a deck. */
const DECK_QUALIFIED_HEADS = new Set([
  "training", "trainings", "pitch", "intro", "introduction", "overview", "summary", "walkthrough", "explainer", "tutorial",
  "lesson", "lecture", "recap", "primer",
]);
const DOC_HEADS = new Set([
  DOC_TOKEN, "essay", "essays", "report", "reports", "memo", "memos", "memorandum", "letter", "letters", "proposal",
  "proposals", "whitepaper", "whitepapers", "article", "articles", "paper", "papers", "policy", "policies", "contract",
  "contracts", "agreement", "agreements", "nda", "ndas", "brief", "briefs", "briefing", "document", "documents", "doc",
  "docs", "manuscript", "chapter", "chapters", "resume", "résumé", "cv", "newsletter", "newsletters", "handbook", "manual",
  "playbook", "sow", "rfp", "rfi", "rfq", "thesis", "dissertation", "biography", "syllabus", "eulogy", "speech", "editorial",
  "book", "ebook", "e-book", "novel", "screenplay", "motion", "pleading", "complaint", "lease", "addendum", "charter",
  "constitution", "bylaws",
]);
/** Short-form writing that a "draft …" request keeps in chat. */
const SHORT_HEADS = new Set([
  "email", "emails", "e-mail", "mail", "message", "messages", "text", "texts", "sms", "reply", "replies", "response",
  "responses", "tweet", "tweets", "post", "posts", "caption", "captions", "comment", "comments", "dm", "dms", "note",
  "notes", "bio", "headline", "headlines", "title", "titles", "tagline", "taglines", "slogan", "slogans", "subject",
  "prompt", "prompts", "poem", "poems", "haiku", "limerick", "song", "songs", "lyrics", "joke", "jokes", "toast", "quote",
  "quotes", "sentence", "sentences", "paragraph", "paragraphs", "line", "lines", "list", "lists", "name", "names",
  "question", "questions", "answer", "answers", "survey", "quiz", "description", "descriptions", "summary", "summaries",
  "recap", "overview", "tldr", "outline", "outlines", "skeleton", "ad", "ads", "team", "player", "players", "lineup",
  "roster", "pick", "picks", "round", "qb", "quarterback", "toc", "formula", "formulas",
]);
/** Code is not a Drafts deliverable, whatever it is called. Spreadsheets are
 * (the spreadsheet editor), but VBA macros and scripts that touch them are code. */
const CODE_WORDS = new Set([
  "python", "javascript", "js", "typescript", "java", "kotlin", "swift", "golang", "rust", "ruby", "php", "perl", "bash",
  "shell", "powershell", "sql", "html", "css", "json", "yaml", "xml", "csv", "latex", "regex", "api", "react", "vue",
  "angular", "node", "nodejs", "vba", "macro", "jupyter", "code", "script", "scripts", "function", "functions", "program",
  "app", "website", "webpage", "component", "cli", "sdk", "generator", "parser", "bot", "chatbot",
]);
/** Head nouns that name a form of something else: "memo template", "a first draft of my essay". */
const INHERIT_HEADS = new Set([
  "template", "templates", "draft", "drafts", "version", "versions", "copy", "sample", "samples", "example", "examples",
  "file", "files", "series", "set", "collection",
]);
/** Forms that start new work even of something existing: "a first draft of my essay". */
const NEW_WORK_FORMS = new Set(["draft", "drafts", "template", "templates"]);
const TRAILING_FILLERS = new Set([
  "out", "now", "today", "tonight", "tomorrow", "quickly", "asap", "too", "also", "again", "real", "quick", "together",
  "thanks", "thx", "instead", "going",
]);
/** "board deck Q3": a period after the head names no other noun. */
const PERIOD_LABEL = /^(?:q[1-4]|fy\d{2,4}|20\d{2})$/;
const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "fifteen", "twenty",
  "thirty", "forty", "fifty", "hundred", "thousand", "couple", "few", "several",
]);
const EXISTING_OBJECTS = new Set([
  "the", "this", "that", "these", "those", "it", "its", "my", "our", "your", "his", "her", "their",
]);
/** Comparatives that make "make the X" an edit of X. */
const EDIT_COMPLEMENTS = new Set([
  "shorter", "longer", "better", "cleaner", "simpler", "tighter", "clearer", "stronger", "bigger", "smaller", "prettier",
  "punchier", "more", "less",
]);
const PHRASE_STOPS = new Set([
  ",", "of", "about", "on", "for", "to", "from", "with", "in", "into", "regarding", "re", "covering", "based", "that",
  "which", "who", "whose", "where", "so", "because", "if", "when", "while", "by", "at", "as", "than", "using", "via",
  "including", "then", "but", "i", "we",
]);
/** Past participles that start a description: "a deck titled X". */
const POST_MODIFIERS = new Set([
  "called", "titled", "entitled", "named", "aimed", "geared", "tailored", "designed", "focused", "centered", "built",
]);
/** -ing words that are nouns: "a report writing workshop". The rest start a description. */
const ING_NOUNS = new Set([
  ...DECK_QUALIFIED_HEADS, "writing", "meeting", "marketing", "planning", "building", "pricing", "filing", "reading",
  "hearing", "drafting", "funding", "budgeting", "accounting", "banking", "consulting", "engineering", "manufacturing",
  "licensing", "lending", "housing", "nursing", "recruiting", "onboarding", "mentoring", "coaching", "tutoring",
  "scheduling", "printing", "staining", "during",
]);
const CONJUNCTIONS = new Set(["and", "or", "plus", "&"]);
const SHEET_TOOL_STOPS = ["in", "using", "as", "via"];
const CODE_TOOL_STOPS = ["in", "using", "with", "as", "via"];

// Fragments with no verb.

const BARE_TOPIC_STOPS = new Set([...DECK_TOPIC_STOPS, "for"]);
/** What a deck or a spreadsheet fragment may continue with: "Spreadsheet to track my meds". */
const BARE_TOOL_STOPS = new Set(["to", "that", "where", "with", ","]);
/** "Memo to all staff", "Proposal to expand": documents that are addressed or argue for something. */
const ADDRESSED_HEADS = new Set(["memo", "memos", "letter", "letters", "proposal", "proposals", DOC_TOKEN]);
/** "Motion to compel standard in Missouri": asks about the thing, not for one. */
const RESEARCH_WORDS = new Set([
  "standard", "standards", "test", "elements", "requirements", "meaning", "definition", "example", "examples", "sample",
  "samples", "format", "deadline", "deadlines",
]);
/** Documents someone is handed as work, not ones they shop for. */
const WORK_PRODUCT_HEADS = new Set([DOC_TOKEN, "report", "reports", "memo", "memos", "proposal", "proposals"]);
/** Things a fragment looks up rather than asks to have written. */
const LOOKED_UP_HEADS = new Set(["book", "books", "novel", "novels", "manual", "manuals", "complaint", "complaints"]);
const SOFTWARE_LOOKUPS = new Set(["download", "install", "login"]);
/** A verb after the phrase makes it a statement: "Memo to staff went out". */
const BARE_PREDICATES = new Set([
  "is", "are", "was", "were", "went", "goes", "has", "had", "got", "came", "looks", "looked", "seems", "starts", "started",
  "ends", "ended", "expires", "expired", "passed", "failed", "says", "said", "will", "won't", "keeps", "take", "takes",
  "took",
]);
/** Reports and praise open statements: "Prepared slides for the meeting", "Great slides, thanks". */
const STATEMENT_OPENERS = new Set([
  "wrote", "written", "drafted", "created", "generated", "prepared", "produced", "composed", "authored", "crafted", "made",
  "built", "designed", "developed", "assembled", "great", "nice", "good", "awesome", "amazing", "excellent", "beautiful",
  "lovely", "cool", "solid", "perfect", "wonderful", "fantastic", "terrible", "bad", "awful", "best",
]);
/** People who open a statement, never a bare deliverable. */
const SPEAKERS = new Set([...FIRST_PERSON, "they", "he", "she", "i'll", "we'll", "they'll", "he'll", "she'll"]);
const BARE_OPENER_REJECTS = [EXISTING_OBJECTS, SPEAKERS, STATEMENT_OPENERS, CHAT_TASK_VERBS, TELLING_VERBS];

/** How far a request reaches. `any`: any object, even an existing one ("write
 * the report"). `new`: only something new. `reshape`: only "into …". `format`:
 * only a table shape. `tell`: only "in a deck". `slides`: only a new deck.
 * `work`: a new deck or work product, handed down by someone else. */
type Reach = "any" | "new" | "reshape" | "format" | "tell" | "slides" | "work";
type Request = { word: string; object: number; reach: Reach };
/** A noun phrase, how it ended, and the clause it sits in. */
type Phrase = { words: string[]; stop: string | null; stopIndex: number; tokens: string[] };
type HeadClass = DraftHandoffKind | "table" | "short" | "inherit" | "code" | "unknown" | null;

const NO_CONTEXT: Phrase = { words: [], stop: null, stopIndex: 0, tokens: [] };
/** "Napoleon slides please": asking outright, with no verb to do it. */
const COURTESY: Request = { word: "please", object: 0, reach: "new" };

/** Which Drafts editor fits this chat message, or null to answer it in chat. */
export function detectDraftHandoff(input: string): DraftHandoffKind | null {
  const message = input.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ").trim();
  if (!message) return null;
  const text = collapsePhrases(respell(normalize(userWords(message))));
  if (KEEP_IN_CHAT.test(text) || ADVICE_CUE.test(text)) return null;
  return firstRequest(text.match(/[^.!?;:\n]+[.!?;:\n]*/g) ?? [], message.length <= BARE_REQUEST_MAX_CHARS);
}

/** The parts of a message the user wrote: quoted lines and letters drop out,
 * and each surviving paragraph is cut to the windows a request can sit in. */
function userWords(message: string) {
  const paragraphs = withoutLetters(message.replace(QUOTED_SPAN, " ").split(/\n\s*\n/))
    .map(withoutQuotes)
    .filter(Boolean);
  if (paragraphs.length === 1) return window(paragraphs[0], SCAN_HEAD_CHARS, SCAN_TAIL_CHARS);
  return paragraphs.map(bodyEdges).join("\n");
}

/** A body keeps only its first and last sentences, where a user's own words sit. */
function bodyEdges(paragraph: string) {
  if (paragraph.length < BODY_MIN_CHARS) return paragraph;
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  return `${sentences[0]}\n${sentences[sentences.length - 1]}`;
}

function withoutQuotes(paragraph: string) {
  const lines = paragraph.split("\n").filter((line) => !QUOTED_LINE.test(line));
  if (lines.length > 1 && lines.every((line) => SPEAKER_LABEL.test(line))) return "";
  return lines.join("\n").replace(INLINE_MATERIAL, "$1").trim();
}

function window(text: string, head: number, tail: number) {
  return text.length <= head + tail ? text : `${text.slice(0, head)}\n${text.slice(-tail)}`;
}

/** Drops letters to someone else, from the greeting through the sign-off, and
 * any paragraph that opens with mail headers. */
function withoutLetters(paragraphs: string[]) {
  const kept: string[] = [];
  let inLetter = false;
  for (const paragraph of paragraphs) {
    if (!inLetter) inLetter = opensLetter(paragraph);
    if (!inLetter && !LETTER_HEADER.test(paragraph)) kept.push(paragraph);
    if (LETTER_CLOSING.test(paragraph)) inLetter = false;
  }
  return kept;
}

function opensLetter(paragraph: string) {
  const name = LETTER_OPENING.exec(paragraph)?.[1].toLowerCase();
  return (name !== undefined && !ASSISTANT_NAMES.has(name)) || isHeaderBlock(paragraph);
}

/** "From: Dana\nSubject: Board": the body follows in the next paragraph. */
function isHeaderBlock(paragraph: string) {
  return paragraph.split("\n").every((line) => LETTER_HEADER.test(line) && line.length <= LETTER_HEADER_MAX_CHARS);
}

function firstRequest(clauses: readonly string[], allowBare: boolean): DraftHandoffKind | null {
  for (const [index, rawClause] of clauses.entries()) {
    const opening = index === 0 || (index === 1 && isPreamble(clauses[0]));
    const kind = clauseKind(rawClause, allowBare && opening, clauses[index + 1] ?? "");
    if (kind) return isSomeoneElsesAsk(clauses, index) ? null : kind;
    if (opensMaterial(rawClause)) return null;
  }
  return null;
}

function isSomeoneElsesAsk(clauses: readonly string[], index: number) {
  return endsOnAnotherAsk(clauses, index) || isTaskList(clauses, index) || clauses.slice(index + 1).some((clause) => RETRACTION.test(clause));
}

/** The last word wins when it replaces the request ("Create a deck on the
 * merger. Is that fair to ask an intern?"), not when it follows it ("How many
 * slides do you recommend?"). Losing a real request costs more than a click,
 * so a closing question needs evidence before it cancels anything. */
function endsOnAnotherAsk(clauses: readonly string[], index: number) {
  const last = clauses[clauses.length - 1];
  if (index === clauses.length - 1 || clauses[clauses.length - 2].trim().endsWith(":")) return false;
  return isChatAsk(last) && !clauseKind(last, false, "") && replacesRequest(clauses, tokenize(last));
}

function replacesRequest(clauses: readonly string[], words: string[]) {
  if (words.some((word) => word === "your" || ADDRESSEES.has(word))) return false;
  if (words.some((word) => TURNS_AWAY.has(word))) return true;
  // After a long body, a question that names no work is about the body.
  const namesWork = words.some((word) => word === "it" || namesDeliverable(word));
  return !namesWork && clauses.slice(0, -1).join("").length >= BODY_MIN_CHARS;
}

/** Three or more lines in a row that each give an order are someone's to-do list. */
function isTaskList(clauses: readonly string[], index: number) {
  const lines = clauses.slice(index, index + TASK_LIST_MIN_LINES);
  if (lines.length < TASK_LIST_MIN_LINES || lines.slice(0, -1).some((clause) => !clause.includes("\n"))) return false;
  return lines.every((clause) => clauseKind(clause, false, "") !== null);
}

function isChatAsk(clause: string) {
  const trimmed = clause.trim();
  const tokens = tokenize(clause).filter((token) => !POLITE_WORDS.has(token));
  const opener = tokens[clauseStart(tokens)];
  if (CHECK_IN.test(trimmed)) return false;
  if (WH_WORDS.has(opener) || (trimmed.endsWith("?") && QUESTION_STARTS.has(opener))) return true;
  return (CHAT_TASK_VERBS.has(opener) || FORMAT_VERBS.has(opener) || opener === "put") && tokens.some((token) => POINTS_BACK.has(token));
}

/** "Quick one:" sits ahead of the request. */
function isPreamble(clause: string) {
  return clause.trim().endsWith(":") && tokenize(clause).length <= PREAMBLE_MAX_WORDS;
}

/** "Summarize this email:" and "What does this email want?" ask for something
 * else, and whatever comes next is what they are asking about. */
function opensMaterial(clause: string) {
  const trimmed = clause.trim();
  const tokens = tokenize(clause).filter((token) => !POLITE_WORDS.has(token));
  const opener = tokens[clauseStart(tokens)];
  if (trimmed.endsWith("?")) return QUESTION_STARTS.has(opener) && MATERIAL_REFERENCE.test(trimmed);
  if (!trimmed.endsWith(":")) return false;
  return SAYING_VERBS.has(tokens[tokens.length - 1]) || CHAT_TASK_VERBS.has(opener) || STRONG_VERBS.has(opener) || SOFT_VERBS.has(opener) || QUESTION_STARTS.has(opener);
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/(\d+)\s*-\s*(slides?|pages?|words?)\b/g, "$1-$2")
    .replace(/\s(?:period|full stop)\s+(?=(?:the|this|it|i|we|please|and|make|use|keep)\b)/g, ". ")
    .replace(/\s[-–—]\s/g, ": ");
}

function respell(text: string) {
  return text.replace(/[a-z][a-z-]+/g, correctSpelling);
}

/** The word as meant. A misspelled "draft" reads as "create", because only the
 * exact word may stand for a document whatever its object. */
function correctSpelling(word: string) {
  const known = KNOWN_SLIPS.get(word);
  if (known) return known;
  if (word.length < MIN_TYPO_LETTERS || NOT_TYPOS.has(word) || SPELLED_WORDS.includes(word)) return word;
  const target = SPELLED_WORDS.find((spelled) => slipped(word, spelled));
  return target === "draft" ? "create" : (target ?? word);
}

function slipped(word: string, target: string) {
  if (oneSlipApart(word, target)) return !inflects(word, target);
  return TWO_SLIP_WORDS.includes(target) && [...target].some((_, at) => oneSlipApart(word, target.slice(0, at) + target.slice(at + 1)));
}

/** "creates", "created", "writer", "drafty", as opposed to the slip "writee". */
function inflects(word: string, target: string) {
  return word.startsWith(target) && "sdry".includes(word.at(-1) ?? "");
}

/** One typing slip: a letter dropped, added, or changed, or two neighbors
 * swapped. Callers rule out identical words. */
function oneSlipApart(left: string, right: string) {
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (long.length - short.length > 1) return false;
  let at = 0;
  while (at < short.length && short[at] === long[at]) at += 1;
  if (short.length < long.length) return short.slice(at) === long.slice(at + 1);
  if (short.slice(at + 1) === long.slice(at + 1)) return true;
  return short[at] === long[at + 1] && short[at + 1] === long[at] && short.slice(at + 2) === long.slice(at + 2);
}

function collapsePhrases(value: string) {
  let next = value;
  // Spaced so "10-slide deck" still yields a separate head token.
  for (const pattern of DECK_PHRASES) next = next.replace(pattern, ` ${DECK_TOKEN} `);
  for (const pattern of SHEET_PHRASES) next = next.replace(pattern, ` ${SHEET_TOKEN} `);
  for (const pattern of DOC_PHRASES) next = next.replace(pattern, ` ${DOC_TOKEN} `);
  // Tables of contents and authorities are parts of a document, not tables to build.
  return next.replace(/\btables? of (?:contents|authorities)\b/g, " toc ");
}

function tokenize(clause: string) {
  return clause.match(/,|[a-z0-9&_à-ÿ][a-z0-9'&_à-ÿ-]*/g)?.map((token) => token.replace(/'+$/, "")) ?? [];
}

/** "Would you mind building" and "need help making" read as the base verb. */
function withBaseVerbs(tokens: string[]) {
  return tokens.map((token, index) => (GERUND_CUES.has(tokens[index - 1]) ? (GERUNDS.get(token) ?? token) : token));
}

function clauseKind(rawClause: string, allowBare: boolean, nextClause: string): DraftHandoffKind | null {
  const spoken = tokenize(rawClause);
  const tokens = withBaseVerbs(spoken.filter((token) => !POLITE_WORDS.has(token)));
  const isQuestion = rawClause.trim().endsWith("?");
  const first = clauseStart(tokens);
  if (asksAbout(tokens, first, isQuestion) || endsAskingElse(tokens, isQuestion)) return null;
  const kind = verbKind(tokens, first, isQuestion);
  const polite = tokens.length < spoken.length;
  if (kind || !(allowBare || polite)) return kind;
  return bareKind(tokens, first, polite, hasTitle(rawClause, nextClause));
}

/** "I want a new deck, what's the cost per square foot?" */
function endsAskingElse(tokens: string[], isQuestion: boolean) {
  return isQuestion && WH_WORDS.has(tokens[tokens.lastIndexOf(",") + 1]) && tokens.includes(",");
}

function clauseStart(tokens: string[]) {
  let first = 0;
  while (isClauseFiller(tokens[first])) first += 1;
  return first;
}

function isClauseFiller(token: string) {
  return FILLERS.has(token) || SEGMENT_BREAKS.has(token) || token === "and";
}

/** The first request any word in the clause makes. */
function verbKind(tokens: string[], first: number, isQuestion: boolean): DraftHandoffKind | null {
  let table = false;
  for (let index = first; index < tokens.length; index += 1) {
    const request = requestAt(tokens, index);
    if (!request || blockedBefore(tokens, index, first, isQuestion)) continue;
    table ||= tableRequested(tokens, request);
    const kind = requestedKind(tokens, request);
    if (kind) return kind;
  }
  // Checked after every verb had its say: a document or deck named anywhere
  // in the clause wins over a table it mentions.
  return table ? "spreadsheet" : null;
}

const REQUEST_READERS = [
  verbRequest, gerundRequest, doRequest, phrasalRequest, wishRequest, receiveRequest, lookupRequest, delegatedRequest, dativeRequest,
  recastRequest, reshapeRequest,
];

function requestAt(tokens: string[], index: number): Request | null {
  for (const read of REQUEST_READERS) {
    const request = read(tokens, index);
    if (request) return request;
  }
  return null;
}

/** The words in front of a verb, back to the last break. */
function wordsBefore(tokens: string[], index: number) {
  const words: string[] = [];
  for (let cursor = index - 1; cursor >= 0 && !SEGMENT_BREAKS.has(tokens[cursor]); cursor -= 1) {
    if (!FILLERS.has(tokens[cursor])) words.unshift(tokens[cursor]);
  }
  return words;
}

/** Whether this verb is asked of the assistant or is the user's own task. A verb
 * has three possible places: after a break it gives an order, after a modal
 * the modal's subject decides, and after "to" the frame around it does. That
 * covers any courteous framing without listing them, and leaves out reports
 * like "Sarah will make the slides". */
function isAsked(tokens: string[], index: number) {
  const before = wordsBefore(tokens, index);
  const last = before[before.length - 1];
  if (last === undefined || opensByAddressing(before)) return true;
  if (last === "to") return infinitiveIsAsked(before);
  if (last === "and") return !before.some(reportsOnSomeone) && !isElsewhereFrame(before, "");
  return modalAsks(before) || handsOverDirectly(before) || followsFronting(before);
}

/** "let's", "help me", and "would it be alright if you". */
function handsOverDirectly(before: string[]) {
  const pair = before.slice(-2).join(" ");
  return DIRECT_CUES.has(before[before.length - 1]) || DIRECT_CUES.has(pair) || (pair === "if you" && MODALS.has(before[0]));
}

/** "Would you consider …", "Won't you please …", unless it goes on to report: "Can you tell me if Sarah will …". */
function opensByAddressing(before: string[]) {
  return INVERTED_MODALS.has(before[0]) && ADDRESSEES.has(before[1]) && !before.slice(2).some(reportsOnSomeone);
}

/** "can you", "you could", "we should". "Sarah will" and "I can" do not. */
function modalAsks(before: string[]) {
  const [previous, last] = before.slice(-2);
  if (MODALS.has(last)) return subjectHandsOver(previous, last, before.length);
  return MODALS.has(previous) && (ADDRESSEES.has(last) || last === "we");
}

/** "you could", "we should", and at a clause's start "I should" or "I must". */
function subjectHandsOver(subject: string, modal: string, wordCount: number) {
  if (ADDRESSEES.has(subject)) return true;
  if (subject === "we") return modal !== "will";
  return subject === "i" && wordCount === 2 && (modal === "should" || modal === "must");
}

/** "Would you be so kind as to", "I'm looking to", "Time to": any frame, unless
 * it gives a purpose, sets a scene, or belongs to someone else. */
function infinitiveIsAsked(before: string[]) {
  const main = before[before.length - 2];
  if (main === "is" && ROLE_NOUNS.has(before[before.length - 3])) return true;
  if (NOT_FRAMES.has(main) || CODE_WORDS.has(main) || isElsewhereFrame(before, main)) return false;
  return main === "possible" || main === "trouble" || before.some((word) => ADDRESSEES.has(word)) || isOwnFrame(before, main);
}

function isOwnFrame(before: string[], main: string) {
  if (MODALS.has(before[0])) return false;
  return FIRST_PERSON.has(before[0]) || !(before.some(reportsOnSomeone) || isThirdPersonVerb(main));
}

/** A scene ("if you want to"), someone else ("they need to"), or a subject of
 * its own ("the partners need to"), unless the task lands on the user ("my boss asked me to"). */
function isElsewhereFrame(before: string[], main: string) {
  if (SUBORDINATORS.has(before[0]) || before.some((word) => THIRD_PERSON.has(word))) return true;
  return EXISTING_OBJECTS.has(before[0]) && main !== "me" && main !== "us";
}

function reportsOnSomeone(word: string) {
  return THIRD_PERSON.has(word) || REPORTING_VERBS.has(word);
}

/** "plans", "needs", "hopes". */
function isThirdPersonVerb(word = "") {
  return word.length > 3 && word !== "this" && /[^s]s$/.test(word);
}

function followsFronting(before: string[]) {
  const last = before[before.length - 1];
  return FRONTING_WORDS.has(before[0]) && !MODALS.has(last) && !SPEAKERS.has(last) && last !== "you";
}

function softRequest(word: string, object: number): Request {
  return { word, object, reach: "new" };
}

/** "write", "build", and the like. */
function verbRequest(tokens: string[], index: number): Request | null {
  const word = tokens[index];
  const soft = SOFT_VERBS.has(word);
  if ((!soft && !STRONG_VERBS.has(word)) || !isAsked(tokens, index)) return null;
  if (word === "draft" && !draftTakesObject(tokens, index)) return null;
  return { word, object: objectStart(tokens, index + 1), reach: soft ? "new" : "any" };
}

/** "Creating a slide deck for the partners retreat": the fragment of a request. */
function gerundRequest(tokens: string[], index: number): Request | null {
  const base = GERUNDS.get(tokens[index]);
  if (!base || wordsBefore(tokens, index).length > 0) return null;
  return softRequest(base, objectStart(tokens, index + 1));
}

/** "Draft a memo" orders one; "draft picks" and "draft slides are attached" do not. */
function draftTakesObject(tokens: string[], index: number) {
  const next = tokens[index + 1] ?? "";
  if (DO_COMMAND_NEXT.has(next) || isCount(next) || EXISTING_OBJECTS.has(next) || DRAFT_OBJECT_OPENERS.has(next)) return true;
  return namesDeliverable(phraseAt(tokens, index + 1).words.at(-1) ?? "");
}

/** "Do a deck", "can you do a deck": a command only, never "I do presentations". */
function doRequest(tokens: string[], index: number): Request | null {
  if (tokens[index] !== "do" || !doTakesObject(tokens[index + 1]) || !isAsked(tokens, index)) return null;
  return softRequest("do", objectStart(tokens, index + 1));
}

function doTakesObject(next = "") {
  return DO_COMMAND_NEXT.has(next) || DECK_HEADS.has(next) || isCount(next);
}

function phrasalRequest(tokens: string[], index: number): Request | null {
  const object = phrasalObject(tokens, index);
  // "Could I trouble you for a deck" names who it asks.
  if (object === null || !(tokens[index + 1] === "you" || isAsked(tokens, index))) return null;
  return softRequest(tokens[index], objectStart(tokens, object));
}

/** Where the object of a multi-word verb starts. In "pull a deck together" it
 * follows the verb, and the trailing "together" drops as filler. */
function phrasalObject(tokens: string[], index: number) {
  const phrase = REQUEST_PHRASES.find((words) => words.every((word, offset) => tokens[index + offset] === word));
  if (phrase) return index + phrase.length;
  const particles = PHRASAL_VERBS.get(tokens[index]);
  if (!particles) return null;
  const after = ["me", "us"].includes(tokens[index + 1]) ? index + 2 : index + 1;
  if (particles.includes(tokens[after])) return after + 1;
  const split = particles.filter((word) => word === "together" || word === "going");
  return split.some((word) => tokens.slice(index + 1, index + 9).includes(word)) ? index + 1 : null;
}

/** "I need a deck", "we could use a report", or just "need a deck". */
function wishRequest(tokens: string[], index: number): Request | null {
  if (!isWish(tokens, index)) return null;
  return softRequest(tokens[index], index + 1);
}

function isWish(tokens: string[], index: number) {
  const word = tokens[index];
  const before = wordsBefore(tokens, index);
  const last = before[before.length - 1];
  if (word === "use") return last === "could";
  if (!WISH_VERBS.has(word)) return false;
  if (before.length === 0 || last === "and") return (word === "need" || word === "want") && startsOwnTask(tokens, last);
  return saidByUser(before);
}

/** "I want", "we'd like", "I would love", or just "would love". */
function saidByUser(before: string[]) {
  const last = before[before.length - 1];
  if (last === "would" || last === "wouldn't") return before.length === 1 || FIRST_PERSON.has(before[before.length - 2]);
  return FIRST_PERSON.has(last);
}

/** "Need to give a talk and want slides": the user's own, unlike "Sarah and Tom want slides". */
function startsOwnTask(tokens: string[], last: string | undefined) {
  const opener = tokens[clauseStart(tokens)];
  return last !== "and" || opener === "need" || opener === "want" || FIRST_PERSON.has(opener);
}

function receiveRequest(tokens: string[], index: number): Request | null {
  if (!RECEIVE_VERBS.has(tokens[index])) return null;
  const cue = wordsBefore(tokens, index).slice(-2).join(" ");
  return RECEIVE_CUES.has(cue) ? softRequest(tokens[index], index + 1) : null;
}

/** "I'm looking for a deck on Napoleon": a request only for slides. A book, a
 * lease, or a report someone is looking for already exists. */
function lookupRequest(tokens: string[], index: number): Request | null {
  const phrase = LOOKUP_PHRASES.find((words) => words.every((word, offset) => tokens[index + offset] === word));
  if (!phrase) return null;
  const before = wordsBefore(tokens, index);
  const last = before[before.length - 1];
  const seeker = before.length === 0 || FIRST_PERSON.has(last) || (last === "am" || last === "are") && before.at(-2) !== "you";
  return seeker ? { word: phrase[0], object: index + phrase.length, reach: "slides" } : null;
}

/** "The board wants a deck on cyber risk": work handed to the user. "The deck
 * needs a slide" edits, and "my kid wants a book" is shopping. */
function delegatedRequest(tokens: string[], index: number): Request | null {
  if (tokens[index] === "asked" && tokens[index + 2] === "for" && ["me", "us"].includes(tokens[index + 1])) {
    return { word: "asked", object: index + 3, reach: "work" };
  }
  if ((tokens[index] !== "wants" && tokens[index] !== "needs") || index === 0) return null;
  return namesDeliverable(tokens[index - 1]) ? null : { word: tokens[index], object: index + 1, reach: "work" };
}

/** "Find me a deck", "shoot me a deck": asked of the assistant, for slides. */
function dativeRequest(tokens: string[], index: number): Request | null {
  const [pronoun, article] = [tokens[index + 1], tokens[index + 2]];
  if ((pronoun !== "me" && pronoun !== "us") || !["a", "an", "some"].includes(article)) return null;
  return isAsked(tokens, index) ? { word: tokens[index], object: index + 2, reach: "slides" } : null;
}

/** Follow-ups that recast what is on the table: "As a deck", "Same thing but
 * as slides", "Can this be a slide deck?". */
function recastRequest(tokens: string[], index: number): Request | null {
  const before = wordsBefore(tokens, index);
  const opensRecast = before.length === 0 && (tokens[index] === "as" || (tokens[index] === "in" && tokens[index + 1] === DECK_TOKEN));
  const asksRecast = tokens[index] === "be" && RECASTABLE.has(before[before.length - 1]) && MODALS.has(before[before.length - 2]);
  return opensRecast || asksRecast ? { word: tokens[index], object: index + 1, reach: "slides" } : null;
}

function reshapeRequest(tokens: string[], index: number): Request | null {
  const reach = reshapingReach(tokens[index]);
  return reach && isAsked(tokens, index) ? { word: tokens[index], object: index + 1, reach } : null;
}

function reshapingReach(word: string): Reach | null {
  if (word === "do") return null;
  if (TRANSFORM_VERBS.has(word)) return "reshape";
  if (FORMAT_VERBS.has(word)) return "format";
  return TELLING_VERBS.has(word) ? "tell" : null;
}

/** Particles and beneficiaries sit between a verb and its object. */
function objectStart(tokens: string[], start: number) {
  let index = start;
  for (;;) {
    const next = PARTICLES.has(tokens[index]) ? index + 1 : afterBeneficiary(tokens, index);
    if (next === index) return index;
    index = next;
  }
}

/** Past "for me", "on my behalf", or "for the partners" when an article opens
 * the object next. Without one, "prepare for my presentation" names no object. */
function afterBeneficiary(tokens: string[], index: number) {
  const next = tokens[index + 1];
  if (tokens[index] === "on") return ["my", "our"].includes(next) && tokens[index + 2] === "behalf" ? index + 3 : index;
  if (tokens[index] !== "for") return index;
  if (BENEFICIARY_PRONOUNS.has(next)) return index + 2;
  if (!EXISTING_OBJECTS.has(next)) return index;
  const article = tokens.slice(index + 2, index + 6).findIndex((token) => token === "a" || token === "an");
  return article < 0 ? index : index + 2 + article;
}

/** Whether the clause opening here asks about something rather than for it. */
function asksAbout(tokens: string[], index: number, isQuestion: boolean) {
  const opener = tokens[index];
  if (!QUESTION_STARTS.has(opener) && !(opener === "when" && isQuestion)) return false;
  return !addressesAssistant(tokens) && !doOpensRequest(tokens, index, isQuestion);
}

/** "Is it possible to…", "Do you think you could…", "Are you able to…". */
function addressesAssistant(tokens: string[]) {
  return ADDRESSED.test(tokens.join(" "));
}

function doOpensRequest(tokens: string[], index: number, isQuestion: boolean) {
  return tokens[index] === "do" && !isQuestion && doTakesObject(tokens[index + 1]);
}

/** Questions about writing ("explain how you write a memo") and refusals ("I
 * don't want you to make slides") are not requests. */
function blockedBefore(tokens: string[], index: number, clauseStartIndex: number, isQuestion: boolean) {
  return askedEarlier(tokens, index, clauseStartIndex, isQuestion) || refusedJustBefore(tokens, index, clauseStartIndex);
}

/** A question blocks a verb in its own stretch of the clause, not past a comma:
 * "what are the risks, and can you make a deck on them?" still asks for one. */
function askedEarlier(tokens: string[], index: number, clauseStartIndex: number, isQuestion: boolean) {
  const segment = Math.max(clauseStartIndex, tokens.lastIndexOf(",", index) + 1);
  if (segment > clauseStartIndex && asksAbout(tokens, segment, isQuestion)) return true;
  return tokens.slice(segment, index).some((token) => token === "how" || token === "what");
}

/** A comma ends the refusal: "No, write a memo instead" is a request. */
function refusedJustBefore(tokens: string[], index: number, clauseStartIndex: number) {
  for (let cursor = index - 1; cursor >= Math.max(clauseStartIndex, index - 5) && tokens[cursor] !== ","; cursor -= 1) {
    if (NEGATIONS.has(tokens[cursor])) return true;
  }
  return false;
}

/** The document, deck, or spreadsheet a request asks for, if any. */
function requestedKind(tokens: string[], request: Request): DraftHandoffKind | null {
  if (request.reach === "format" || request.reach === "tell") return formattedAsDeck(tokens, request.object);
  if (request.reach === "reshape") return reshapedKind(tokens, request);
  const phrase = phraseAt(tokens, request.object);
  // "I need this as a PowerPoint": any request can reshape what is on the table.
  const onExisting = EXISTING_OBJECTS.has(phrase.words[0]) ? transformKind(tokens, request.object) : null;
  return onExisting ?? objectOrReshaped(tokens, request, phrase);
}

function objectOrReshaped(tokens: string[], request: Request, phrase: Phrase) {
  const kind = newObject(request, phrase) ? objectKind(phrase, request) : null;
  if (kind) return withinReach(kind, request, phrase) ? kind : null;
  return settlesObject(phrase) ? null : reshapedKind(tokens, request);
}

function reshapedKind(tokens: string[], request: Request) {
  return TRANSFORM_VERBS.has(request.word) ? transformKind(tokens, request.object) : null;
}

function withinReach(kind: DraftHandoffKind, { reach }: Request, phrase: Phrase) {
  if (reach === "slides") return kind === "deck";
  if (reach === "work") return kind === "deck" || WORK_PRODUCT_HEADS.has(phrase.words[phrase.words.length - 1]);
  return true;
}

/** "Explain the rule in a PowerPoint", but not "rank the slides in the deck". */
function formattedAsDeck(tokens: string[], start: number): DraftHandoffKind | null {
  for (let index = start; index < tokens.length && tokens[index] !== ","; index += 1) {
    if (!isShapeConnector(tokens[index])) continue;
    const phrase = phraseAt(tokens, index + 1);
    if (!EXISTING_OBJECTS.has(phrase.words[0]) && objectKind(phrase, null) === "deck") return "deck";
  }
  return null;
}

/** "a sentence about how to excel" and "VBA to export to PowerPoint" have an
 * object, so a later "to Excel" cannot replace it. */
function settlesObject(phrase: Phrase) {
  return objectClasses(phrase, null).some((value) => value === "short" || value === "code");
}

/** Whether the request's object is new work. "make this a slide deck" recasts;
 * "make the essay longer" edits; and in "can you build the slides?" nothing
 * edits them, so the verb makes them. */
function newObject(request: Request, phrase: Phrase) {
  if (request.reach === "any" || !EXISTING_OBJECTS.has(phrase.words[0])) return true;
  if (recastsAs(phrase.words)) return true;
  return phrase.words[0] === "the" && MAKING_VERBS.has(request.word) && nothingEdits(phrase);
}

function recastsAs(words: string[]) {
  return RECASTABLE.has(words[0]) && ["a", "an"].includes(words[1]);
}

/** "Make the deck for the board" orders one; "…for the board shorter" edits one. */
function nothingEdits({ stop, tokens, stopIndex }: Phrase) {
  if (stop === "for") return !tokens.slice(stopIndex).some((word) => EDIT_COMPLEMENTS.has(word));
  return stop === null || stop === ",";
}

/** The request asks for a table: as its object ("create a matrix of …") or as
 * the shape of the answer ("show me the cities in a table"). */
function tableRequested(tokens: string[], request: Request): boolean {
  if (request.reach === "slides" || request.reach === "work" || request.reach === "tell") return false;
  return objectIsTable(tokens, request) ?? shapedAsTable(tokens, request.object);
}

/** True or false when the object decides; null when it leaves the shape open. */
function objectIsTable(tokens: string[], request: Request) {
  if (request.reach !== "any" && request.reach !== "new") return null;
  const phrase = phraseAt(tokens, request.object);
  if (newObject(request, phrase) && isTablePhrase(phrase)) return true;
  return settlesObject(phrase) ? false : null;
}

function shapedAsTable(tokens: string[], start: number) {
  for (let index = start; index < tokens.length && tokens[index] !== ","; index += 1) {
    if (isShapeConnector(tokens[index]) && namesNewTable(phraseAt(tokens, index + 1).words)) return true;
  }
  return false;
}

function isShapeConnector(word: string) {
  return word !== "to" && TRANSFORM_CONNECTORS.has(word);
}

/** "in a table", "in a spreadsheet"; not "in my spreadsheet", which already exists. */
function namesNewTable(words: string[]) {
  return !EXISTING_OBJECTS.has(words[0]) && splitConjuncts(words).some(isTabular);
}

function isTabular(words: string[]) {
  const value = headClass(words, NO_CONTEXT, null);
  return value === "table" || value === "spreadsheet";
}

function splitConjuncts(words: string[]) {
  const conjuncts: string[][] = [[]];
  for (const token of words) {
    if (CONJUNCTIONS.has(token)) conjuncts.push([]);
    else conjuncts[conjuncts.length - 1].push(token);
  }
  return conjuncts;
}

function isTablePhrase(phrase: Phrase): boolean {
  return splitConjuncts(phrase.words).some((conjunct) => headClass(conjunct, phrase, null) === "table");
}

/** The noun phrase from here to its first stop. */
function phraseAt(tokens: string[], start: number): Phrase {
  const words: string[] = [];
  let index = start;
  for (; index < tokens.length && words.length < 10; index += 1) {
    const token = tokens[index];
    if (token === "," && PLAIN_ADJECTIVES.has(words[1])) continue;
    const opensWithThat = token === "that" && words.length === 0;
    if ((PHRASE_STOPS.has(token) && !opensWithThat) || startsDescription(token, words[words.length - 1])) {
      return { words, stop: token, stopIndex: index, tokens };
    }
    words.push(token);
  }
  return { words, stop: null, stopIndex: index, tokens };
}

/** "a deck titled X", "a report evaluating vendors": once a noun names the
 * work, a participle describes it. */
function startsDescription(token: string, previous: string | undefined) {
  return isDescriptive(token) && previous !== undefined && (namesDeliverable(previous) || SHORT_HEADS.has(previous));
}

function isDescriptive(token: string) {
  return POST_MODIFIERS.has(token) || (/[a-z]{3,}ing$/.test(token) && !ING_NOUNS.has(token));
}

function namesDeliverable(word: string) {
  return [DECK_HEADS, DOC_HEADS, SHEET_HEADS, CUED_SHEET_HEADS, TABLE_HEADS, SHEET_QUALIFIED_HEADS].some((heads) => heads.has(word));
}

/** "turn this into a slide deck", "write the above up as a memo". */
function transformKind(tokens: string[], start: number): DraftHandoffKind | null {
  for (let index = start; index < Math.min(tokens.length, start + 10); index += 1) {
    const token = tokens[index];
    if (token === ",") return null;
    if (!TRANSFORM_CONNECTORS.has(token) || index === start) continue;
    const phrase = phraseAt(tokens, index + 1);
    const kind = isPurpose(token, phrase.words) ? null : objectKind(phrase, null);
    if (kind) return kind;
  }
  return null;
}

/** "to explain the policy", "to generate slides": why, not what into. */
function isPurpose(connector: string, words: string[]) {
  const opensNoun = words[0] === "a" || words[0] === "an" || EXISTING_OBJECTS.has(words[0]);
  return connector === "to" && words.length > 1 && !opensNoun;
}

function isDeliverable(value: HeadClass): value is DraftHandoffKind {
  return value === "document" || value === "deck" || value === "spreadsheet";
}

function toolNamed(stop: string | null, stops: string[], after: string[], tools: Set<string>) {
  return stop !== null && stops.includes(stop) && after.some((word) => tools.has(word));
}

function objectClasses(phrase: Phrase, request: Request | null) {
  const conjuncts = splitConjuncts(phrase.words);
  return conjuncts.map((words, position) =>
    headClass(words, position === conjuncts.length - 1 ? phrase : { ...phrase, stop: null }, request),
  );
}

function objectKind(phrase: Phrase, request: Request | null): DraftHandoffKind | null {
  if (!phrase.words.length) return null;
  const classes = objectClasses(phrase, request);
  if (classes.includes("code")) return null;
  const after = phrase.tokens.slice(phrase.stopIndex + 1, phrase.stopIndex + 4);
  // "a budget in Excel", "a workbook in Google Sheets": the tool names the deliverable.
  if (toolNamed(phrase.stop, SHEET_TOOL_STOPS, after, SHEET_HEADS)) return "spreadsheet";
  const found = classes.find(isDeliverable);
  // "a report in Python", "slides as HTML": the deliverable is code.
  if (found) return toolNamed(phrase.stop, CODE_TOOL_STOPS, after, CODE_WORDS) ? null : found;
  return inheritedKind(phrase, classes[classes.length - 1], request) ?? (draftStandsAlone(classes, request) ? "document" : null);
}

/** "Draft a plan for Q3": whatever it is called, it will be a document. */
function draftStandsAlone(classes: HeadClass[], request: Request | null) {
  return request?.word === "draft" && classes.every((value) => value === "unknown" || value === "inherit");
}

/** "a first draft of my essay", "a template for a board presentation". A copy
 * of "the deck" only duplicates work that already exists. */
function inheritedKind(phrase: Phrase, last: HeadClass, request: Request | null): DraftHandoffKind | null {
  if (last !== "inherit" || (phrase.stop !== "of" && phrase.stop !== "for")) return null;
  const owner = phraseAt(phrase.tokens, phrase.stopIndex + 1);
  const copies = EXISTING_OBJECTS.has(owner.words[0]) && !NEW_WORK_FORMS.has(phrase.words[phrase.words.length - 1]);
  if (copies && request?.reach !== "any") return null;
  const ownerClass = headClass(owner.words, owner, request);
  return isDeliverable(ownerClass) ? ownerClass : null;
}

function headClass(words: string[], context: Phrase, request: Request | null): HeadClass {
  const trimmed = [...words];
  while (trimmed.length && isTrailingFiller(trimmed[trimmed.length - 1])) trimmed.pop();
  if (!trimmed.length) return null;
  if (trimmed.some((word) => CODE_WORDS.has(word))) return "code";
  const headIndex = ownerIndex(trimmed);
  if (headIndex < 0) return "inherit";
  const head = trimmed[headIndex];
  const modifiers = trimmed.slice(0, headIndex);
  return (
    tabularClass(head, modifiers, context) ??
    deckClass(head, modifiers, context, request) ??
    writtenClass(head, modifiers[modifiers.length - 1] ?? "")
  );
}

function isTrailingFiller(word: string) {
  return TRAILING_FILLERS.has(word) || PERIOD_LABEL.test(word);
}

/** Where the head noun sits. "memo template", "pptx file": the form takes its
 * noun's kind; "the first draft" alone waits for an "of …" owner (-1). */
function ownerIndex(words: string[]) {
  const last = words.length - 1;
  if (!INHERIT_HEADS.has(words[last])) return last;
  let owner = last - 1;
  while (owner >= 0 && headClass([words[owner]], NO_CONTEXT, null) === "unknown") owner -= 1;
  return owner;
}

/** A spreadsheet word or a table head with the words before it; null for any other head. */
function tabularClass(head: string, modifiers: string[], context: Phrase): HeadClass {
  if (isSpreadsheetWord(head, modifiers, context)) return "spreadsheet";
  if (!TABLE_HEADS.has(head)) return null;
  const tool = context.stop === "in" ? context.tokens[context.stopIndex + 1] : "";
  if (TABLE_CHAT_FORMATS.has(tool) || CODE_WORDS.has(tool) || modifiers.some((word) => TABLE_CHAT_FORMATS.has(word))) return "short";
  if (isMadeOfMaterial(context)) return "unknown";
  return TABLE_FURNITURE.has(modifiers[modifiers.length - 1]) ? "unknown" : "table";
}

/** "a table out of barn wood", as opposed to "a table out of these numbers". */
function isMadeOfMaterial({ words, stop, tokens, stopIndex }: Phrase) {
  return stop === "of" && words[words.length - 1] === "out" && !EXISTING_OBJECTS.has(tokens[stopIndex + 1]);
}

function isSpreadsheetWord(head: string, modifiers: string[], { tokens, stopIndex }: Phrase) {
  if (SHEET_HEADS.has(head)) return true;
  const after = tokens.slice(stopIndex);
  if (SHEET_QUALIFIED_HEADS.has(head) && [...modifiers, ...toolAhead(after)].some((word) => SHEET_HEADS.has(word))) return true;
  return CUED_SHEET_HEADS.has(head) && [...modifiers, ...after].some((word) => SHEET_CUES.has(word));
}

/** "a tracker for my karate class in Google Sheets": the words after "in". */
function toolAhead(words: string[]) {
  const segment = untilComma(words);
  const connector = segment.lastIndexOf("in");
  return connector < 0 ? [] : segment.slice(connector + 1, connector + 3);
}

/** The deck the head names. "short" keeps it in chat whatever the verb,
 * because a tarot deck is no more a document than a slide deck. */
function deckClass(head: string, modifiers: string[], context: Phrase, request: Request | null): HeadClass {
  if (DECK_QUALIFIED_HEADS.has(head) && modifiers.some(isDeckHead)) return "deck";
  if (!isDeckHead(head)) return null;
  if (WRITTEN_SENSE_HEADS.has(head) && WRITING_VERBS.has(request?.word ?? "")) return "unknown";
  return meansSomethingElse(head, modifiers, context, request) ? "short" : "deck";
}

function meansSomethingElse(head: string, modifiers: string[], context: Phrase, request: Request | null) {
  if (head === "presentation" || head === "presentations") return !isPresentationDeck(modifiers, context, request);
  return AMBIGUOUS_DECK_HEADS.has(head) && !isSlideSense(head, modifiers, context, request);
}

/** Courts and clinics use "presentation" too. A presentation "of" something
 * takes a request that is not for prose, and an unknown modifier takes a new
 * object or a topic: "Late presentation of appendicitis", "the patient's
 * presentation", and "write a clear presentation of the facts" all stay out. */
function isPresentationDeck(modifiers: string[], context: Phrase, request: Request | null) {
  if (context.stop === "of") return request !== null && !WRITING_VERBS.has(request.word) && !modifiers.some(isUnknownModifier);
  if (!modifiers.some(isUnknownModifier)) return true;
  return request === null ? context.stop !== null : !EXISTING_OBJECTS.has(context.words[0]);
}

function isUnknownModifier(word: string) {
  return !isPlainModifier(word);
}

function isDeckHead(word: string) {
  return DECK_HEADS.has(word) || isSlideCount(word);
}

/** "10-slide", "ten-slide". */
function isSlideCount(word: string) {
  const [count, unit] = word.split("-");
  return (unit === "slide" || unit === "slides") && isCount(count);
}

/** Positive evidence that an ambiguous head means slides. Plain "slides" is
 * slides. A qualifier right before the head settles it. A word the grammar does
 * not know names some other deck, so it needs a topic or an audience. */
function isSlideSense(head: string, modifiers: string[], context: Phrase, request: Request | null) {
  if (pointsElsewhere(context)) return false;
  const named = modifiers.filter((word) => !isPlainModifier(word));
  if (qualifiesDeck(modifiers[modifiers.length - 1])) return true;
  if (named.length === 0) return head === "slides" || tailShowsSlides(head, context, request);
  if (request === COURTESY) return true;
  return (request !== null || head.startsWith("deck")) && (opensTopicAt(context) || audienceFollows(context));
}

function audienceFollows({ stop, tokens, stopIndex }: Phrase) {
  return stop === "for" && namesAudience(followingWords(tokens, stopIndex));
}

function followingWords(tokens: string[], stopIndex: number) {
  return tokens.slice(stopIndex + 1, stopIndex + 7).map((word) => word.replace(/'s$/, ""));
}

function qualifiesDeck(word: string | undefined) {
  return word !== undefined && (DECK_CONTEXT.has(word) || isDeckHead(word) || PERIOD_LABEL.test(word));
}

function isPlainModifier(word: string) {
  return (
    word.startsWith("__") ||
    qualifiesDeck(word) || PLAIN_ADJECTIVES.has(word) || EXISTING_OBJECTS.has(word) || word === "a" || word === "an" || isCount(word) || GERUNDS.has(word)
  );
}

function opensTopicAt({ stop, stopIndex, tokens }: Phrase) {
  return stop !== null && opensTopic(tokens, stopIndex);
}

/** What a stop after a bare "deck" takes to show it means slides. */
const TAIL_EVIDENCE = new Map<string, (next: string[], words: string[]) => boolean>([
  [",", () => true],
  ["that", () => true],
  ["of", (next, words) => (words.at(-1) === "out" ? EXISTING_OBJECTS.has(next[0]) : namesSlideContents(next) || namesAudience(next))],
  ["with", namesSlideContents],
  ["from", (next) => EXISTING_OBJECTS.has(next[0])],
  ["by", (next) => SCHEDULE_DAYS.has(next[0]) || DUE_WORDS.has(next[0])],
]);

function namesSlideContents(next: string[]) {
  return next.some((word) => SLIDE_CONTENTS.has(word));
}

function tailShowsSlides(head: string, { words, stop, stopIndex, tokens }: Phrase, request: Request | null) {
  if (stop === null) return true;
  const next = followingWords(tokens, stopIndex);
  if (stop === "for") return (head !== "slide" && !CONSTRUCTION_VERBS.has(request?.word ?? "")) || namesAudience(next);
  return TAIL_EVIDENCE.get(stop)?.(next, words) ?? opensTopic(tokens, stopIndex);
}

function namesAudience(words: string[]) {
  return SCHEDULE_DAYS.has(words[0]) || words.some((word) => DECK_CONTEXT.has(word) || DUE_WORDS.has(word));
}

/** Places outside the screen anywhere ahead of the topic: "for my backyard, build a deck". */
function pointsElsewhere({ tokens, stopIndex }: Phrase) {
  const topic = tokens.findIndex((_, index) => index >= stopIndex && opensTopic(tokens, index));
  return tokens.slice(0, topic < 0 ? tokens.length : topic).some((word) => DECK_ELSEWHERE.has(word));
}

/** "on pool safety" is a topic, "to sell our house" a purpose; "on my boat"
 * and "next to the pool" are places. */
function opensTopic(tokens: string[], index: number) {
  const word = tokens[index];
  if (word === "on" || word === "to") return !namesPlace(tokens, index + 1);
  return DECK_TOPIC_STOPS.has(word) || isDescriptive(word);
}

function namesPlace(tokens: string[], start: number): boolean {
  const { words, stop, stopIndex } = phraseAt(tokens, start);
  if (!EXISTING_OBJECTS.has(words[0])) return false;
  return DECK_ELSEWHERE.has(words.at(-1) ?? "") || (stop === "of" && namesPlace(tokens, stopIndex + 1));
}

function writtenClass(head: string, modifier: string): HeadClass {
  if (DOC_HEADS.has(head) || namesLength(head, modifier)) return "document";
  return SHORT_HEADS.has(head) ? "short" : "unknown";
}

/** "10-page", "three pages", "2,000 words". */
function namesLength(head: string, modifier: string) {
  if (/^\d+-pages?$/.test(head)) return true;
  if (head === "pages" || head === "page") return isCount(modifier);
  return (head === "words" || head === "word") && isWordCount(modifier);
}

function isCount(word: string) {
  return /^\d+$/.test(word) || NUMBER_WORDS.has(word);
}

/** A few hundred words is an answer; a long-form word count is a document. */
function isWordCount(word: string) {
  if (/^\d+$/.test(word)) return Number(word) >= 300;
  return word === "hundred" || word === "thousand";
}

/** A request with no verb: "Essay on the French Revolution", "Slides please",
 * "Spreadsheet to track my meds". Courtesy or a title means nothing else need
 * follow; a title does not close a document, because "Report:" is a label. */
function bareKind(tokens: string[], first: number, polite: boolean, titled: boolean): DraftHandoffKind | null {
  const phrase = phraseAt(tokens, first);
  const rest = tokens.slice(phrase.stopIndex + 1);
  if (!isBareObject(phrase.words) || isStatement(phrase, rest)) return null;
  const kind = objectKind(phrase, polite ? COURTESY : null);
  if (isLookup(phrase, kind)) return null;
  if (kind && phrase.words.length <= 6 && bareIsRequest(kind, phrase, rest, closes(phrase.words, kind, polite, titled))) return kind;
  return isTableOf(kind, phrase) ? "spreadsheet" : null;
}

function closes(words: string[], kind: DraftHandoffKind | null, polite: boolean, titled: boolean) {
  return polite || (titled && kind !== "document") || isLabel(words, kind);
}

/** "Memo to staff went out" reports on one. A relative clause has verbs of its
 * own, so only "that is …" gives it away. */
function isStatement({ stop }: Phrase, rest: string[]) {
  if (stop === ",") return false;
  if (stop === "that" || stop === "where") return BARE_PREDICATES.has(rest[0]);
  return saysSomething(rest);
}

/** "Book about Napoleon" and "PowerPoint for Mac download" look something up. */
function isLookup(phrase: Phrase, kind: DraftHandoffKind | null) {
  const { words, tokens, stopIndex } = phrase;
  const fragment = [...words, ...tokens.slice(stopIndex)];
  if (fragment.some((word) => SOFTWARE_LOOKUPS.has(word))) return true;
  if (kind !== "document") return false;
  return (words.length === 1 && LOOKED_UP_HEADS.has(words[0])) || asksAboutDocument(fragment);
}

/** "Motion to compel standard in Missouri": the fragment ends on what it asks
 * about. "Memo on the elements of negligence" goes on to its topic. */
function asksAboutDocument(fragment: string[]) {
  const opening = untilComma(fragment);
  return opening.some((word, index) => RESEARCH_WORDS.has(word) && !continuesTopic(opening[index + 1]));
}

function continuesTopic(next: string | undefined) {
  return next !== undefined && next !== "in" && next !== "under" && next !== "for";
}

/** "Q3 earnings deck", "grocery budget spreadsheet": compounds that ask for themselves. */
function isLabel(words: string[], kind: DraftHandoffKind | null) {
  if (words.length < 2) return false;
  return kind === "spreadsheet" || (kind === "deck" && words.some((word) => DECK_LABELS.has(word)));
}

function bareIsRequest(kind: DraftHandoffKind, { words, stop }: Phrase, rest: string[], closed: boolean) {
  if (rest.length === 0 || stop === null) return closed;
  if (stop === "on" && SCHEDULE_DAYS.has(rest[0])) return false;
  if (stop === "," && closed) return true;
  return kind === "document" ? documentContinues(words, stop) : toolContinues(kind, stop, rest);
}

/** A deck or spreadsheet fragment can go on to say what it is for. */
function toolContinues(kind: DraftHandoffKind, stop: string, rest: string[]) {
  if (stop === "of") return kind === "deck";
  if (stop === "in") return rest.slice(0, 3).some((word) => SHEET_HEADS.has(word));
  if (stop === "by") return !SCHEDULE_DAYS.has(rest[0]) && !/^\d/.test(rest[0]);
  if (stop === "to") return !EXISTING_OBJECTS.has(rest[0]);
  return BARE_TOPIC_STOPS.has(stop) || BARE_TOOL_STOPS.has(stop) || isDescriptive(stop);
}

/** A document fragment needs a topic, or an address it is written to. */
function documentContinues(words: string[], stop: string) {
  if (stop === "to") return ADDRESSED_HEADS.has(words[words.length - 1]);
  return BARE_TOPIC_STOPS.has(stop) || isDescriptive(stop);
}

/** "Spreadsheet of the top 50 US cities", "Matrix of state taxes": a table of something. */
function isTableOf(kind: DraftHandoffKind | null, phrase: Phrase) {
  const { words, stop } = phrase;
  return stop === "of" && words.length <= 4 && (kind === "spreadsheet" || isTablePhrase(phrase));
}

/** A noun phrase on its own. "My slides", "Great slides", "No slides", "Add a
 * slide", "Check the deck", "Slides or handouts", "Explain how decks work", "I
 * do presentations", and "Prepared slides" are not. */
function isBareObject(words: string[]) {
  if (BARE_OPENER_REJECTS.some((rejects) => rejects.has(words[0]))) return false;
  const inside = words.slice(1);
  const determinerInside = inside.some((word) => word === "a" || word === "an" || EXISTING_OBJECTS.has(word));
  return !determinerInside && !inside.some((word) => STRONG_VERBS.has(word) && word !== "draft") && !words.some(cannotSitInBareObject);
}

function cannotSitInBareObject(word: string) {
  return word === "or" || NEGATIONS.has(word) || QUESTION_STARTS.has(word) || SCHEDULE_DAYS.has(word);
}

/** "Slide deck: onboarding for new volunteers". The next clause titles the
 * deliverable, unless it says something of its own ("Report: sales were up"). */
function hasTitle(clause: string, nextClause: string) {
  const title = tokenize(nextClause);
  const enough = clause.includes(DECK_TOKEN) ? TITLE_MIN_WORDS - 1 : TITLE_MIN_WORDS;
  return clause.trim().endsWith(":") && title.length >= enough && !saysSomething(title);
}

/** A predicate before the next comma: details after a comma can be full sentences. */
function saysSomething(words: string[]) {
  return untilComma(words).some((word) => BARE_PREDICATES.has(word));
}

function untilComma(words: string[]) {
  const comma = words.indexOf(",");
  return comma < 0 ? words : words.slice(0, comma);
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
