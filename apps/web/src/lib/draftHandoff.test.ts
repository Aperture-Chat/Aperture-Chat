import { describe, expect, it } from "vitest";
import { detectDraftHandoff, draftHandoffAttachments, draftHandoffChatContext } from "./draftHandoff";
import type { ChatMessage } from "./types";

describe("detectDraftHandoff", () => {
  it.each([
    "Write an essay about the French Revolution",
    "write me a 1500-word persuasive essay on remote work",
    "Can you draft a memo to the board about Q3 results?",
    "Draft an NDA between Harbor Labs and Northwind",
    "Please write a cover letter for a product manager role",
    "Write a letter to my landlord about the broken heater",
    "Help me write a research paper on coral bleaching",
    "I need a 5 page paper on World War II",
    "Write 2,000 words on the history of jazz",
    "write three pages about photosynthesis",
    "Prepare a report on our Q3 sales performance",
    "Put together a proposal for the city council",
    "Give me a business plan for a coffee shop",
    "Create a document outlining our remote work policy",
    "Generate an executive summary of the attached findings",
    "I'd like a press release announcing our new office",
    "Write the first draft of my thesis introduction chapter",
    "Draft a plan for the Q3 offsite",
    "Can you write up a statement of work for the migration?",
    "Write a blog post about sustainable fashion",
    "Turn this into a memo for the leadership team",
    "Write this up as a one-pager",
    "Essay on the causes of the Great Depression",
    "Compose a speech for my sister's graduation",
    "Is it possible to write a privacy policy for my app store listing?",
    "No, write a formal report instead",
    "Hey, can you write a book report on Hatchet?",
    "write my thesis",
    "Can you create a Google Doc with our meeting notes?",
    "we need a proposal for the Henderson account",
  ])("offers a document for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("document");
  });

  it.each([
    "Create a slide deck about our Q3 results",
    "I want to see a PowerPoint on renewable energy",
    "hey create a slide deck",
    "Make me a presentation about the solar system",
    "Can you put together a 10-slide pitch deck for my startup?",
    "Build a deck on our product roadmap",
    "Make slides for my biology lecture",
    "Generate 12 slides on onboarding best practices",
    "Draft a slide deck for the board meeting",
    "I need a presentation for tomorrow's client meeting",
    "Turn this into a slide deck",
    "Convert these notes to a PowerPoint",
    "Can you put this in a presentation?",
    "Slides about the water cycle for my 5th graders",
    "PowerPoint about cybersecurity awareness",
    "Help me with a presentation for my board meeting",
    "Write a presentation on the history of flight",
    "Design a sales deck for our enterprise tier",
    "Are you able to create a pptx file about our benefits?",
    "make a ppt on the solar system",
    "slideshow on volcanoes",
    "lets make a deck for the QBR",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "Write a report with the results in a table",
    "Write a report with a table of quarterly results",
    "Draft a memo that compares the vendors in a matrix",
  ])("offers a document for %j even though it mentions a table", (text) => {
    expect(detectDraftHandoff(text)).toBe("document");
  });

  it.each([
    "Create a spreadsheet of my monthly expenses",
    "Make me an Excel spreadsheet to track our hiring pipeline",
    "Can you build a budget in Excel?",
    "I need an excel file with every state's population and capital",
    "Put together a sales tracker spreadsheet with a monthly pivot",
    "Build a pivot table of revenue by region and quarter",
    "Generate a workbook in Excel for our inventory",
    "Turn this into a spreadsheet",
    "Convert these numbers to Excel",
    "Export this table to Excel",
    "make an excel for my wedding budget",
    "Create a Google Sheets tracker for the volunteer schedule",
    "Spreadsheet of the top 50 US cities by population",
    "Draft a project plan spreadsheet with owners and due dates",
    "Can you put this in a spreadsheet?",
    "I'd like an xlsx file comparing the three vendor quotes",
    // Tables and matrices are tabular deliverables: offer the spreadsheet editor.
    "Create a state-by-state matrix for P&L management",
    "I need a matrix of state taxes by business type",
    "Build me a P&L matrix by state",
    "Can you create a decision matrix for choosing a vendor?",
    "Create a table comparing the three vendors",
    "Make a comparison table of the top CRM tools",
    "Give me a table of the 10 largest US cities",
    "Show me the top 10 cities by population in a table",
    "Summarize the findings in a table",
    "Put this in a table",
    "Turn this into a matrix",
    "List the 50 states and their capitals in a table",
    "Compare the iPhone 17 and the Pixel 11 in a matrix",
    "Break down our Q3 costs into a table by department",
    "Build a habit tracker",
    "Matrix of state taxes by entity type",
    "Quarterly state tax matrix of revenue by entity",
  ])("offers a spreadsheet for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("spreadsheet");
  });

  it.each([
    "How do I make a pivot table in Excel?",
    "What's the Excel formula for compound interest?",
    "Write an Excel formula that sums column B when column A says Paid",
    "Write a VBA macro for my spreadsheet",
    "Explain how VLOOKUP works in a spreadsheet",
    "Why does my spreadsheet show #REF!?",
    "I made a spreadsheet yesterday",
    "Make this spreadsheet prettier",
    "Write a Python script that exports a spreadsheet",
    "Create a spreadsheet right here in chat",
    "Is Excel or Google Sheets better for budgeting?",
    "Create a cheat sheet for Git commands",
    "How do I make a table in Word?",
    "What should a P&L matrix include?",
    "Create a table of contents for my thesis",
    "Help me build a coffee table",
    "Build a picnic table for my backyard",
    "Create a markdown table of the planets",
    "Explain the periodic table",
    "Write a Python function that builds a matrix",
    "Make the table shorter",
    "Add a column to the table",
    "Don't put it in a table",
    "List three reasons to learn Spanish",
    "List the tables in the database",
    "Write a haiku about Mondays, please",
    "Build a sturdy coffee table",
    "Make markdown tables of the planets",
  ])("keeps the spreadsheet question %j in chat (or as a document)", (text) => {
    expect(detectDraftHandoff(text)).not.toBe("spreadsheet");
  });

  it.each([
    "How do I write a good essay?",
    "What makes a strong cover letter?",
    "Should I write a cover letter for this job?",
    "Can you tell me how to write a research paper?",
    "Tips for writing a memo",
    "I need to write an essay, any tips?",
    "Give me tips to write a better resume",
    "Help me draft a message. Here is the audience, purpose, and context: ",
    "Draft an email to my boss asking for Friday off",
    "draft a reply to this text",
    "Write a poem about autumn",
    "Write a short story about a dragon",
    "Write a summary of this article",
    "Draft an NDA summary",
    "Draft a quick recap of the call",
    // An outline is what was asked for, even an outline for a deck.
    "Create a presentation outline for the kickoff",
    "Give me an outline for a presentation on cybersecurity",
    "Draft an outline for my essay",
    "Write a brief summary of the meeting",
    "Write a Python script that generates a PDF report",
    "Write a function that creates a slide deck",
    "Create a report in SQL that lists inactive users",
    "Create an HTML presentation",
    "Build a deck in my backyard",
    "Help me build a deck for my backyard",
    "Build a Magic deck around green creatures",
    "Make this document shorter",
    "Make the essay more persuasive",
    "Improve my essay",
    "Review the draft the team sent",
    "Who should I draft first in fantasy football?",
    "draft picks for 2026",
    "Don't write an essay, just give me three bullet points",
    "I don't want you to make slides",
    "Write an essay right here in chat",
    "Explain how to make a PowerPoint",
    "Thoughts on my presentation?",
    "Write a LinkedIn post about our launch",
    "Create an image of a lighthouse",
    "Make a paper airplane",
    "Summarize this report",
    "Write the conclusion",
    "What's the difference between a memo and a report?",
    "I wrote an essay last night",
    "Rewrite this in a more formal tone",
    "Turn this into an email",
    "",
    "   ",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it("ignores requests that only appear inside code blocks", () => {
    expect(detectDraftHandoff("Why does this fail?\n```\n// write an essay about dogs\n```")).toBeNull();
  });

  it("reads the request at either end of a long pasted message", () => {
    const pasted = "Quarterly revenue rose on partner leads and lower churn. ".repeat(60);
    expect(detectDraftHandoff(`${pasted}\n\nTurn this into a slide deck for the board.`)).toBe("deck");
    expect(detectDraftHandoff(`Write a memo summarizing the following:\n\n${pasted}`)).toBe("document");
    // A phrase buried in the middle of pasted material is not the user's request.
    expect(detectDraftHandoff(`${pasted} We should write a report. ${pasted} What stood out?`)).toBeNull();
  });
});

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: "m", role: "user", content: "", createdAt: "9:00 AM", status: "ok", ...overrides };
}

describe("draftHandoffChatContext", () => {
  it("returns null for a new chat", () => {
    expect(draftHandoffChatContext([])).toBeNull();
  });

  it("labels turns, drops thinking, failures, and pending replies, and names attached files", () => {
    const context = draftHandoffChatContext([
      message({ id: "u1", content: "Our churn fell to 2.1%.", attachments: [{ name: "q3.pdf", size: "1 KB", kind: "PDF" }] }),
      message({ id: "a1", role: "assistant", content: "<think>private</think>Great news on churn." }),
      message({ id: "a2", role: "assistant", content: "Upstream failed", status: "error" }),
      message({ id: "a3", role: "assistant", content: "", status: "pending" }),
    ]);
    expect(context).toBe("User: Our churn fell to 2.1%.\n(Attached: q3.pdf)\n\nAssistant: Great news on churn.");
    expect(context).not.toContain("private");
  });

  it("keeps the newest turns when the conversation is longer than the budget", () => {
    const messages = Array.from({ length: 6 }, (_, index) =>
      message({ id: `u${index}`, content: `Turn ${index} ${"x".repeat(40)}` }),
    );
    const context = draftHandoffChatContext(messages, 120) ?? "";
    expect(context.startsWith("[4 earlier messages omitted]")).toBe(true);
    expect(context).toContain("Turn 5");
    expect(context).toContain("Turn 4");
    expect(context).not.toContain("Turn 3");
  });
});

describe("draftHandoffAttachments", () => {
  it("puts this message's files first, then newer earlier files, without duplicates or unsent files", () => {
    const attachments = draftHandoffAttachments(
      [{ id: "upload-new", name: "brief.docx", size: "2 KB", kind: "Word", text_preview: "Brief" }],
      [
        message({ id: "u1", attachments: [{ id: "upload-old", name: "old.pdf", size: "1 KB", kind: "PDF" }] }),
        message({ id: "u2", attachments: [{ id: "upload-new", name: "brief.docx", size: "2 KB", kind: "Word" }] }),
        message({ id: "u3", attachments: [{ name: "local-only.txt", size: "1 KB", kind: "Text" }] }),
        message({ id: "u4", attachments: [{ id: "upload-photo", name: "site.png", size: "9 KB", kind: "Image" }] }),
      ],
    );
    expect(attachments).toEqual([
      { attachmentId: "upload-new", name: "brief.docx", size: "2 KB", hasText: true },
      { attachmentId: "upload-photo", name: "site.png", size: "9 KB", hasText: true },
      { attachmentId: "upload-old", name: "old.pdf", size: "1 KB", hasText: false },
    ]);
  });

  it("caps how many files travel", () => {
    const current = Array.from({ length: 12 }, (_, index) => ({
      id: `upload-${index}`,
      name: `f${index}.txt`,
      size: "1 KB",
      kind: "Text",
    }));
    expect(draftHandoffAttachments(current, [])).toHaveLength(8);
  });
});
