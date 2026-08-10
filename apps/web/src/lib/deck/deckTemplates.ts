/** Built-in deck starter templates.
 *
 * Each template builds a real, editable SlideDeck whose text is honest
 * scaffolding (visible prompts the user replaces), and exposes an outline the
 * deck assistant uses as structural guidance when generating with AI.
 */

import {
  DECK_SCHEMA_VERSION,
  defaultDeckTheme,
  parseSlideDeck,
  type DeckBullet,
  type SlideDeck,
} from "./deckModel";

export type BuiltInDeckTemplate = {
  id: string;
  name: string;
  category: "Pitch" | "Business" | "Project" | "Training";
  description: string;
  outline: string;
  build: (title: string) => SlideDeck;
};

function bullets(items: string[]): DeckBullet[] {
  return items.map((text) => ({ runs: [{ text }], level: 0 }));
}

/** Templates are authored with plain strings and normalized by the same
 * validator every other deck passes through, so scaffold text becomes rich
 * text runs without repeating the conversion at each literal. */
function deck(title: string, slides: Array<Record<string, unknown>>): SlideDeck {
  const parsed = parseSlideDeck({
    schema: DECK_SCHEMA_VERSION,
    title,
    theme: defaultDeckTheme(),
    slides,
  });
  if (!parsed.ok) {
    throw new Error(`Built-in deck template "${title}" is invalid: ${parsed.error}`);
  }
  return parsed.deck;
}

let templateSlideCounter = 0;
function slideId() {
  templateSlideCounter += 1;
  return `tpl-${templateSlideCounter}`;
}

export const BUILT_IN_DECK_TEMPLATES: BuiltInDeckTemplate[] = [
  {
    id: "deck-pitch",
    name: "Pitch deck",
    category: "Pitch",
    description: "Problem, solution, market, traction, team, and ask.",
    outline:
      "1 Title; 2 Problem (bullets); 3 Solution (bullets); 4 Market size (bullets); 5 Traction (bullets); 6 Team (two columns); 7 The ask (closing)",
    build: (title) =>
      deck(title, [
        { id: slideId(), notes: "", layout: "title", title, subtitle: "Company pitch" },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "The problem",
          bullets: bullets(["Who feels this pain", "What it costs them today", "Why now"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Our solution",
          bullets: bullets(["What we do in one sentence", "Why it wins", "Proof it works"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Market",
          bullets: bullets(["Market size and segment", "Who we sell to first", "How we expand"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Traction",
          bullets: bullets(["Key metric and trend", "Customers or pilots", "What changed recently"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "two-column",
          title: "Team",
          left: bullets(["Founder — background", "Founder — background"]),
          right: bullets(["Key hire — background", "Advisor — background"]),
        },
        { id: slideId(), notes: "", layout: "closing", title: "The ask", body: "What you need and what it unlocks" },
      ]),
  },
  {
    id: "deck-qbr",
    name: "Quarterly review",
    category: "Business",
    description: "Results, wins, misses, and next-quarter plan.",
    outline:
      "1 Title; 2 Quarter results (bullets with numbers); 3 Wins (bullets); 4 Misses and lessons (bullets); 5 Next quarter priorities (two columns: goals vs owners); 6 Risks (bullets); 7 Closing",
    build: (title) =>
      deck(title, [
        { id: slideId(), notes: "", layout: "title", title, subtitle: "Quarterly business review" },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Results",
          bullets: bullets(["Revenue vs plan", "Pipeline vs plan", "Customer count and churn"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Wins",
          bullets: bullets(["Biggest win and why it matters", "Team win", "Customer win"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Misses and lessons",
          bullets: bullets(["What missed and by how much", "Root cause", "What changes"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "two-column",
          title: "Next quarter",
          left: bullets(["Priority 1", "Priority 2", "Priority 3"]),
          right: bullets(["Owner and milestone", "Owner and milestone", "Owner and milestone"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Risks",
          bullets: bullets(["Top risk and mitigation", "Watch item"]),
        },
        { id: slideId(), notes: "", layout: "closing", title: "Discussion", body: "Decisions needed today" },
      ]),
  },
  {
    id: "deck-kickoff",
    name: "Project kickoff",
    category: "Project",
    description: "Goals, scope, timeline, roles, and working agreements.",
    outline:
      "1 Title; 2 Why this project (bullets); 3 Goals and non-goals (two columns); 4 Timeline (bullets by phase); 5 Roles (two columns); 6 Working agreements (bullets); 7 Closing next steps",
    build: (title) =>
      deck(title, [
        { id: slideId(), notes: "", layout: "title", title, subtitle: "Project kickoff" },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Why this project",
          bullets: bullets(["The problem or opportunity", "What success looks like", "Why now"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "two-column",
          title: "Goals and non-goals",
          left: bullets(["Goal 1", "Goal 2", "Goal 3"]),
          right: bullets(["Out of scope 1", "Out of scope 2"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Timeline",
          bullets: bullets(["Phase 1 — dates and outcome", "Phase 2 — dates and outcome", "Launch — date"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "two-column",
          title: "Roles",
          left: bullets(["Sponsor", "Lead", "Core team"]),
          right: bullets(["Decision rights", "Escalation path"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Working agreements",
          bullets: bullets(["Meeting cadence", "Status updates", "Where work lives"]),
        },
        { id: slideId(), notes: "", layout: "closing", title: "Next steps", body: "First milestones and owners" },
      ]),
  },
  {
    id: "deck-proposal",
    name: "Client proposal",
    category: "Business",
    description: "Client need, approach, plan, pricing, and proof.",
    outline:
      "1 Title; 2 Your situation (bullets); 3 Our approach (bullets); 4 Plan and timeline (bullets); 5 Investment (bullets); 6 Why us (quote or proof); 7 Closing next steps",
    build: (title) =>
      deck(title, [
        { id: slideId(), notes: "", layout: "title", title, subtitle: "Proposal" },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Your situation",
          bullets: bullets(["What we heard", "What it is costing you", "What good looks like"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Our approach",
          bullets: bullets(["How we would solve it", "What makes this work", "What we need from you"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Plan and timeline",
          bullets: bullets(["Phase 1 — outcome", "Phase 2 — outcome", "Go-live"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Investment",
          bullets: bullets(["Option A — scope and price", "Option B — scope and price", "What is included"]),
        },
        { id: slideId(), notes: "", layout: "quote", quote: "A client result worth quoting.", attribution: "Client name, role" },
        { id: slideId(), notes: "", layout: "closing", title: "Next steps", body: "Decision timeline and first action" },
      ]),
  },
  {
    id: "deck-training",
    name: "Training session",
    category: "Training",
    description: "Objectives, concepts, walkthrough, practice, recap.",
    outline:
      "1 Title; 2 What you will learn (bullets); 3 Section: concept; 4 Concept explained (bullets); 5 Walkthrough (image-caption placeholder); 6 Practice (bullets); 7 Recap closing",
    build: (title) =>
      deck(title, [
        { id: slideId(), notes: "", layout: "title", title, subtitle: "Training session" },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "What you will learn",
          bullets: bullets(["Objective 1", "Objective 2", "Objective 3"]),
        },
        { id: slideId(), notes: "", layout: "section", title: "The core concept", subtitle: "" },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "How it works",
          bullets: bullets(["Key idea", "Common mistake", "Rule of thumb"]),
        },
        {
          id: slideId(),
          notes: "",
          layout: "image-caption",
          title: "Walkthrough",
          image: { src: "", alt: "Screenshot or diagram of the workflow" },
          caption: "Add a screenshot or diagram of the workflow",
        },
        {
          id: slideId(),
          notes: "",
          layout: "title-bullets",
          title: "Practice",
          bullets: bullets(["Exercise", "What to watch for", "How to check your work"]),
        },
        { id: slideId(), notes: "", layout: "closing", title: "Recap", body: "Three things to remember" },
      ]),
  },
];

export function builtInDeckTemplate(id: string | null): BuiltInDeckTemplate | null {
  if (!id) return null;
  return BUILT_IN_DECK_TEMPLATES.find((template) => template.id === id) ?? null;
}
