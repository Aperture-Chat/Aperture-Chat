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

describe("detectDraftHandoff: the deck request that stayed in chat", () => {
  it("offers a deck for the exact prompt that failed", () => {
    expect(
      detectDraftHandoff(
        "Creat for me a slide deck on the greatness of Napoleon and how he has similarities to our firm Spencer Fane L L P",
      ),
    ).toBe("deck");
  });

  it.each([
    "Do a PowerPoint on Napoleon",
    "Do a presentation on Napoleon",
    "Build a deck comparing Napoleon and Spencer Fane",
    "Create a Keynote on Napoleon",
    "We need to present on Napoleon, make a deck",
    "Slides please: Napoleon and Spencer Fane",
    "How would Napoleon run a law firm? Build a deck.",
    "Create for me a slide deck on Napoleon",
  ])("offers a deck for the reproduced miss %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });
});

describe("detectDraftHandoff: misspelled verbs", () => {
  it.each([
    "Creat a slide deck on Napoleon",
    "creat me a presentation on Napoleon",
    "Creat slides on Napoleon",
    "Craete a deck for the partners",
    "Cretae slides on the Battle of Austerlitz",
    "Crate a slide deck on Napoleon",
    "Wirte a presentation on Napoleon",
    "wrtie me a PowerPoint about Napoleon",
    "Genrate a slide deck on Napoleon",
    "Generat 12 slides on Napoleon",
    "Perpare a deck for the client meeting",
    "Prepar a presentation for the partners",
    "Comopse a slide deck on Napoleon",
    "Can you creat a deck on Napoleon?",
    "Please creat a PowerPoint on Napoleon",
    "We need to creat a presentation on Napoleon",
    "Help me creat a slide deck",
    "Hey, creat a deck on Napoleon",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "Creat a report on our Q3 sales",
    "Creat for me a cover letter",
    "Wirte an essay on Napoleon",
    "Genrate a memo for the board",
    "Perpare a proposal for the city council",
  ])("offers a document for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("document");
  });

  it.each([
    "Creat a spreadsheet of my monthly expenses",
    "Creat for me an Excel file of state capitals",
    "Genrate a spreadsheet for our inventory",
    "Creat a table comparing the three vendors",
  ])("offers a spreadsheet for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("spreadsheet");
  });

  it.each([
    "crate of apples",
    "A crate of apples, please",
    "Crate the bikes for shipping",
    "Crate a plan for moving the dog",
    "great slides",
    "Great slides, thanks",
    "Great deck!",
    "Great presentation",
    "Great report, thank you",
    "White slides look cleaner",
    "White a presentation",
    "Product slides look great",
    "Product presentation",
    "Crete presentation",
    "Kraft presentation",
    "Wrote a deck last night",
    "Wrote a report yesterday",
    "Creates a deck from your notes",
    "Generates a slide deck automatically",
    "Prepared slides for the meeting",
    "Produced a report last quarter",
    "Composed a memo",
    "Drafts a memo every week",
    "Drift a report",
    "Graft a report",
    "She creat a deck yesterday",
    "The creat deck",
    "Writer's block on my report",
    // A typo carries no benefit of the doubt: "draft" alone stands for a document.
    "Drfat a plan for Q3",
    "Creat a plan for Q3",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: how far a typo may stray", () => {
  it.each(["Creeate a deck", "Crezte a deck", "Cerate a deck", "Creat a deck"])(
    "accepts one slip in %j",
    (text) => {
      expect(detectDraftHandoff(text)).toBe("deck");
    },
  );

  it.each(["Cerat a deck on Napoleon", "Grate a deck on Napoleon", "Cream a report", "Greet a report", "Crater a deck"])(
    "refuses two slips in %j",
    (text) => {
      expect(detectDraftHandoff(text)).toBeNull();
    },
  );

  it.each(["Wite a deck on Napoleon", "Rite a memo", "Crat a deck", "Drat a memo"])(
    "refuses a word under five letters in %j",
    (text) => {
      expect(detectDraftHandoff(text)).toBeNull();
    },
  );

  it.each([
    "white", "wrote", "writs", "trite", "drift", "graft", "kraft", "crete", "crease", "product", "procure", "compost",
    "compote", "venerate", "cremate", "croft", "writhe",
  ])("never reads the real word %j as a misspelled verb", (word) => {
    expect(detectDraftHandoff(`${word} a report on Napoleon`)).toBeNull();
    expect(detectDraftHandoff(`${word} for me a slide deck on Napoleon`)).toBeNull();
  });

  it.each([
    "sides", "slices", "slice", "slimes", "slime", "glides", "glide", "elides", "elide", "snide", "sliders", "slider",
    "sideshow", "sideshows", "contact", "contacts", "contrast", "contrasts", "wordbook", "wordbooks", "resort", "repost",
    "retort", "assay", "police", "polity", "busyness", "persona", "employer", "deport",
  ])("never reads the real word %j as a misspelled noun", (word) => {
    expect(detectDraftHandoff(`Make a ${word} for the party`)).toBeNull();
  });

  it.each([
    "Could you creat a deck on Napoleon?",
    "Would you creat a deck on Napoleon?",
    "Will you creat a deck on Napoleon?",
    "Can we creat a deck on Napoleon?",
    "Could we creat a deck on Napoleon?",
    "Let's creat a deck on Napoleon",
    "Lets creat a deck on Napoleon",
    "Let us creat a deck on Napoleon",
    "I need you to creat a deck on Napoleon",
    "I want to creat a deck on Napoleon",
    "I'd like to creat a deck on Napoleon",
    "I'd love to creat a deck on Napoleon",
    "Are you able to creat a deck on Napoleon?",
    "Then creat a deck on Napoleon",
  ])("accepts a typo in the command position of %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "She said you creat a deck on Napoleon",
    "They can creat a deck on Napoleon",
    "It was fun to creat a deck on Napoleon",
    "Tell them to creat a deck on Napoleon",
  ])("refuses a typo outside command position in %j", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: beneficiaries and courtesy", () => {
  it.each([
    "Make for me a PowerPoint on Napoleon",
    "Build for us a deck on Napoleon",
    "Prepare for the partners a presentation on Napoleon",
    "Draft for our firm a slide deck on Napoleon",
    "Create on my behalf a slide deck on Napoleon",
    "Create for myself a deck on Napoleon",
    "Create please a slide deck on Napoleon",
    "Please make me a deck on Napoleon",
    "pls make a deck on Napoleon",
    "plz make me some slides on Napoleon",
    "Kindly prepare a presentation on Napoleon",
    "Kindly do a slide deck on Napoleon",
    "Make a deck on Napoleon pls",
    "A deck on Napoleon please",
    "Deck please",
    "PowerPoint please",
    "Slides, please",
    "Please, a deck on Napoleon",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "Write for me an essay on Napoleon",
    "Draft for us a proposal for the city council",
    "Draft for me a memo on the merger",
    "Kindly write a memo on the merger",
    "Write a memo on the merger pls",
    "Write a memo please about Q3",
    "Report please: Q3 churn",
    "Memo please",
  ])("offers a document for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("document");
  });

  it("offers a spreadsheet for a courteous bare request", () => {
    expect(detectDraftHandoff("Spreadsheet please: Q3 expenses")).toBe("spreadsheet");
  });

  it.each([
    "Prepare for my presentation",
    "Prepare me for the presentation tomorrow",
    "Help me prepare for my presentation on Napoleon",
    "Prepare for a presentation",
    "Prepare for my meeting with a client",
    "Write for me",
    "Create for me a plan",
    "Write for the web",
    "No slides please",
    "No PowerPoint please",
    "Not a deck, please",
    "No report please",
    "Coffee please",
    "Yes please",
    "The report, please",
    "Nice deck, please add a slide",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: do and phrasal request verbs", () => {
  it.each([
    "Can you do a deck on Napoleon?",
    "Could you do a PowerPoint on Napoleon?",
    "Please do a slide deck on Napoleon",
    "Let's do a presentation on Napoleon",
    "Lets do a deck on Napoleon",
    "Let us do a deck on Napoleon",
    "I need you to do a deck on Napoleon",
    "We need to do a PowerPoint on Napoleon",
    "I want to do a slide deck on Napoleon",
    "Are you able to do a deck on Napoleon?",
    "Help me do a deck on Napoleon",
    "Do me a PowerPoint on Napoleon",
    "Do us a deck on Napoleon",
    "Do 10 slides on Napoleon",
    "Do three slides on Napoleon",
    "Do some slides on Napoleon",
    "Do slides for the partners",
    "Can you do slides on Napoleon?",
    "Do for me a presentation on Napoleon",
    "Do up a deck on Napoleon",
    "Do this as a deck",
    "Do it in PowerPoint",
    "Ok, do a deck on Napoleon",
    "Just do a deck on Napoleon",
    "Work up a deck on Napoleon",
    "Spin up a presentation on Napoleon",
    "Pull together a slide deck on Napoleon",
    "Knock out a quick PowerPoint on Napoleon",
    "Build out a deck on Napoleon",
    "Whip up a deck on Napoleon",
    "Throw together some slides on Napoleon",
    "Crank out a deck on Napoleon",
    "Put together for me a deck on Napoleon",
    "Looking for a slide deck on Napoleon",
    "I'm looking for a PowerPoint on Napoleon",
    "We're looking for a presentation about Napoleon",
    "We are looking for a deck on Napoleon",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "Do a memo on the merger",
    "Can you do a report on Q3?",
    "Let's do a proposal for Henderson",
    "Knock out a memo for the partners",
    "Work up a proposal for the client",
    "Spin up a report on churn",
    "Pull together a report on churn",
    "Build out a business plan for the bakery",
  ])("offers a document for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("document");
  });

  it.each([
    "Do a spreadsheet of our Q3 expenses",
    "Can you do an Excel budget?",
    "Do this in Excel",
    "Knock out a spreadsheet of vendors",
    "Work up a budget spreadsheet",
    "Spin up an Excel tracker",
    "Pull together a spreadsheet of the deal terms",
  ])("offers a spreadsheet for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("spreadsheet");
  });

  it.each([
    "Do you have a slide deck on Napoleon?",
    "Do you do presentations?",
    "Do slides work better than handouts?",
    "Do most lawyers use PowerPoint?",
    "Do a lot of people make slides?",
    "Do I need a presentation?",
    "Do the slides need a title?",
    "Do these slides look OK",
    "Do the partners want me to create a deck?",
    "Do not make a deck",
    "Do slides with animations distract?",
    "Do presentations on Napoleon exist?",
    "Do decks need an agenda",
    "Do for loops run faster in Python?",
    "I do presentations for a living",
    "We do a deck every quarter",
    "They do a report each month",
    "What should I do a presentation on?",
    "Should I do a presentation on Napoleon?",
    "I had to do a presentation yesterday",
    "Do a search for Napoleon",
    "Do a barrel roll",
    "Do me a favor",
    "Do one thing for me",
    "Do my homework",
    "Do the dishes",
    "Spin up a server",
    "Spin up a Kubernetes cluster",
    "Work up a sweat",
    "Knock out a wall in my kitchen",
    "Pull together a team",
    "Build out the API",
    "Pull up a chair",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it.each([
    "I'm looking for a book on Napoleon",
    "Looking for a table for four",
    "Looking for a new lease",
    "I'm looking for a contract lawyer",
    "I'm looking for a memo about PTO",
    "Looking for a report on Q3 churn",
    "I'm looking for a deck builder in Austin",
    "Looking for a Pokémon deck",
    "Looking for a PowerPoint expert",
    "They're looking for a presentation on Napoleon",
    "You are looking for a deck on Napoleon",
    "Are you looking for a deck?",
  ])("keeps the lookup %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: requests the bare path used to catch by accident", () => {
  it.each([
    "Start a deck on Napoleon",
    "Start a presentation on Napoleon",
    "Begin a slide deck on Napoleon",
    "Let's start a deck on Napoleon",
    "Outline a deck on Napoleon",
    "Sketch a deck on Napoleon",
    "Get a deck together on Napoleon",
    "I would appreciate a slide deck on Napoleon",
    "Would love a deck on Napoleon",
    "Could use a deck on Napoleon",
    "I could use a deck on Napoleon",
    "Prep a deck on Napoleon",
    "Provide a presentation on Napoleon",
    "Devise a slide deck on Napoleon",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "Draw up a contract for the Henderson sale",
    "Type up a memo on the merger",
    "Pen a letter to my landlord",
    "Give me a first draft of my essay",
    "Give me a template for my report",
  ])("offers a document for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("document");
  });

  it("offers a spreadsheet for a phrasal request", () => {
    expect(detectDraftHandoff("Set up a spreadsheet to track expenses")).toBe("spreadsheet");
  });

  it.each([
    "Make a copy of the deck",
    "Make a copy of this report",
    "Make a shorter version of this report",
    "Can you send me a copy of the presentation?",
    "Get me a copy of the contract",
    "I need a copy of the lease",
    "Give me a sample of the report",
    "Presentation on Tuesday",
    "Deck on Friday",
    "Slides on Monday",
    "Keynote on Tuesday",
    "Memo on Thursday",
    "Report tomorrow",
    "I need to give a presentation on Friday",
    "I start a report every Monday",
    "We begin a deck each quarter",
    "Draft a deck outline",
    "Start the presentation",
    "Start my presentation",
    "Start a conversation about Napoleon",
    "Provide a summary of the deck",
    "Add a slide about Napoleon",
    "Recommend a book on Napoleon",
    "Suggest a paper about coral bleaching",
    "Read a report on churn",
    "Find a memo on the merger",
    "Attach a report on Q3",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: fragments that name a deliverable", () => {
  it.each([
    "pitch deck, seed round, b2b payroll software for restaurants",
    "a deck that explains our onboarding process to new hires",
    "slide deck: onboarding for new volunteers at the food bank",
    "google slides: 10 reasons to learn a second language",
    "quick one: slide deck introducing our consulting practice to prospects",
    "last minute request: presentation for tomorrow's parent night about reading",
    "powerpoint to teach the kitchen staff the new allergen protocol",
    "ppt to explain the new vacation rental rules to the association",
    "slides to onboard new franchise owners",
    "pitch deck to sell our house to a developer",
    "presentation that explains our return on investment",
    "powerpoint training for new bank tellers",
    "google slides pitch for a student-run coffee cart",
    "a keynote walking through a day in the life of our product",
    "powerpoint walking new customers through setup of our thermostat",
    "slideshow of our company history for the lobby tv",
    "a series of slides to teach my staff the new software",
    "a deck with 7 slides about cross training",
    "kickoff deck for a website redesign, client is a regional credit union",
    "creat a 6 slide intro to python for total beginners",
    "create a deck laying out options for settling the dispute",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "memo to all staff announcing the new hybrid schedule",
    "memo to the partners proposing a second office in Raleigh",
    "proposal to expand our after school program",
    "a proposal to the city for a community garden",
    "A cover letter please, for a marketing role at Lumen Outdoor",
    "Essay on the French Revolution",
  ])("offers a document for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("document");
  });

  it.each([
    "spreadsheet to track my medications and refill dates",
    "excel workbook to track my job applications",
    "Excell sheet to track mileage for taxes",
    "exel workbook for my fantasy football scores",
    "monthly expense tracker in excel with categories",
    "customer database in excel, name, phone, last visit",
    "excel file with a budget vs actuals comparison",
    "Workbook with a tab for each month",
    "workbok for tracking our nonprofit's grants",
    "build me a workbook that calculates loan payoff",
    "a timesheet for 15 employees with weekly totals",
    "a sales commission calculator spreadsheet, tiers at 5% and 7%",
    "spreadsheet where i can enter my hours and it calculates pay",
    "conference attendee tracker spreadsheet with dietary needs",
    "a pricing calculator spreadsheet for my bakery that works out cost per cupcake",
    "Track my expenses in a spreadsheet",
    "plan my wedding seating in a spreadsheet",
  ])("offers a spreadsheet for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("spreadsheet");
  });

  it.each([
    "Memo to all staff went out this morning",
    "Presentation to the board went well",
    "Slides for the meeting are in the shared drive",
    "Contract with Acme expires in June",
    "Deck from last week is on the drive",
    "Report to HR",
    "Presentation in 10 minutes",
    "Report in the morning",
    "Slides in the shared drive",
    "Spreadsheet in the shared drive",
    "Presentation: 3pm today",
    "Report: Q3 sales were up",
    "Deck: see attached",
    "Reminder: presentation tomorrow",
    "Update: report on Q3 went out",
    "Slides or handouts for the partners",
    "List the formulas in my spreadsheet",
    "Rank the slides in the deck",
    "pivot tables or sumifs for a monthly summary, which is better",
    "Explain how VLOOKUP works in a spreadsheet",
    "i'm preparing slides for tomorrow but i can't decide on a color",
    "my professor wants a presentation on the cold war, any thoughts on angles",
    "A student workbook for phonics",
    "Write a math workbook for second graders",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: the deck was already mentioned", () => {
  it.each([
    "i have to present to the school board on tuesday. can you build the slides?",
    "my partner wants a CLE presentation by friday. can you make the deck",
    "they asked for a 10 minute talk on a project i led. help me build the deck",
    "Build the presentation, include a site plan section",
    "my teacher wants a powerpoint on the Great Depression, 8 slides minimum, can you do it",
    "the board wants a deck on cybersecurity risk before the next meeting. can you start one?",
    "My boss wants a deck by Friday",
    "The client needs a presentation on Napoleon",
    "Can you gimme a slide deck on how to start investing",
    "can u make a presentaton on electric cars",
    "mak me a ppt about project management basics",
    "mke a ppt about digestion",
    "bild a presentation about the rainforest",
    "Biuld a slide deck on AI risk",
    "buld a competitive analysis deck",
    "Buid a deck on cybersecurity awareness",
    "make a dek of the top 10 trends in retail",
    "build a dek for the quarterly business review",
    "Can you create a slide dek about mergers?",
    "pwrpoint on blockchain for beginners",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "Make the deck shorter",
    "Make the deck in Spanish",
    "Make the slides with a dark background",
    "Do the slides for me",
    "Give me the report",
    "Show me the deck",
    "Send me the slides",
    "I'll make the slides",
    "We'll build the deck",
    "I will make a deck tonight",
    "We will build the deck",
    "I'm going to make a deck tonight",
    "We're going to create a deck next week",
    "The deck needs a new slide",
    "This presentation needs a slide on Napoleon",
    "The memo needs a table of results",
    "Nobody wants a deck",
    "Who wants a deck?",
    "My kid wants a book on dinosaurs",
    "My landlord wants a new lease",
    "He wants a lawyer",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: details the second hold-out exposed", () => {
  it.each([
    "Can you create a PowerPoint to explain the new vacation policy to employees?",
    "could you generate a slide deck out of the summary i gave you",
    "need to give a ted-style talk on burnout and want slides to go with it",
    "build the deck for our product demo day",
    "Make the slides for our new patient orientation night",
    "presentaton on public speaking tips for teens",
    "write the slides for my webinar on tax tips for freelancers",
    "need a clean, minimal deck for a design agency pitch",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "write a long, thorough proposal to the city for a pocket park",
    "Write a memo we can send to the partners",
  ])("offers a document for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("document");
  });

  it.each([
    "can you make a sheet that tracks my debts",
    "Sheet for tracking student attendance and tardies",
    "Make me a sheet to compare mortgage offers from four lenders",
    "excl sheet that tracks mileage for taxes",
    "can you build me a sheet that scores candidates",
    "create an sheet with a donation receipt log",
    "time tracking sheet for a team of 6 contractors",
    "make a spreadsheet i can use to compare prices per ounce",
    "Convert these numbers to Excel",
    "Move this to a spreadsheet",
  ])("offers a spreadsheet for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("spreadsheet");
  });

  it.each([
    "report: 3 people out sick, line 2 down, shipping on schedule",
    "Give me a sheet of paper",
    "Make a sheet pan dinner",
    "Write a term sheet review",
    "Make a fact sheet",
    "Make the deck for the client shorter than ten slides",
    "Write a thank you note to my boss",
    "Any thoughts on the deck?",
    "Tips for making a deck",
    "Cut this to 10 slides",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

// "Thanks." takes the first clause, so these reach the verb grammar and cannot
// lean on the bare path, which only reads a message's opening clause.
describe("detectDraftHandoff: grammar pinned at its edges", () => {
  it.each([
    ["Thanks. Draft 5 pages on photosynthesis", "document"],
    ["Thanks. Draft three pages on photosynthesis", "document"],
    ["Thanks. Write the next three pages on jazz", "document"],
    ["Thanks. Write a 10-page on coral bleaching", "document"],
    ["Thanks. Write 2,000 words on jazz", "document"],
    ["Thanks. Write 300 words on jazz", "document"],
    ["Thanks. Write 500 word on jazz", "document"],
    ["Thanks. Write a thousand words on jazz", "document"],
    ["Thanks. Write a hundred words on jazz", "document"],
    ["Write a memo for the board?", "document"],
    ["Do you mind helping me write a report?", "document"],
    ["Could we see a report on churn?", "document"],
    ["Can I get a deck on Napoleon?", "deck"],
    ["Make this a slide deck", "deck"],
    ["Make it a deck", "deck"],
    ["She wants a deck on Napoleon", "deck"],
    ["Build for the partners a deck on Napoleon", "deck"],
    ["Make a presentation of our Q3 results", "deck"],
    ["Build a deck on the future of the firm", "deck"],
    ["Convert these notes to the new deck", "deck"],
    ["Slides: Napoleon at Austerlitz", "deck"],
    ["Build a one two three four five six seven eight deck", "deck"],
    ["Turn one two three four five six seven eight nine into a deck", "deck"],
    ["North american regional sales training deck on Napoleon", "deck"],
    ["May I have a spreadsheet of vendors?", "spreadsheet"],
    ["Convert these notes to an Excel file", "spreadsheet"],
    ["Give me a budget in Excel", "spreadsheet"],
    ["Give me a budget using Google Sheets", "spreadsheet"],
    ["one two three four: essay on Napoleon", "document"],
    ["Create a Spanish version of the slide deck", "deck"],
    ["Can we make a deck on Napoleon?", "deck"],
    ["Could we build a deck on Napoleon?", "deck"],
    ["Build a deck on the future of the boat market", "deck"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "Thanks. Write 100 words on jazz",
    "Thanks. Write 299 words on jazz",
    "Thanks. Write a dozen words on jazz",
    "When should I write a report?",
    "Is it hard to write a report?",
    "People like a deck for training",
    "Folks love a presentation",
    "Can we discuss a deck?",
    "Wants a deck on Napoleon",
    "Make this report",
    "Make that slide deck",
    "Incident report to HR",
    "Presentation that is due Friday",
    "Copy of the deck",
    "Backyard project, build a deck",
    "Draft a better presentation of this legal argument",
    "Give me a report in Python",
    "Give me slides as HTML",
    "Build a one two three four five six seven eight nine deck",
    "Turn one two three four five six seven eight nine ten into a deck",
    "Big north american regional sales training deck on Napoleon",
    "one two three four five: essay on Napoleon",
    "Hello there. Essay on Napoleon",
    "Quick one: hello there. Essay on Napoleon",
    "We worked on a deck together",
    "Put this deck together",
    "Can I see the report?",
    "The client wants the deck",
    "Daxft a report on Q3",
    "Make me this report",
    "Create on my laptop a deck",
    "Explain how you write a report",
    "Tell me what you make a deck from",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it("reads a bare request only in a short message", () => {
    const fits = `Essay on ${"x".repeat(231)}`;
    expect(fits).toHaveLength(240);
    expect(detectDraftHandoff(fits)).toBe("document");
    expect(detectDraftHandoff(`${fits}x`)).toBeNull();
    expect(detectDraftHandoff(`Essay on Napoleon. ${"Some more context about the class. ".repeat(10)}`)).toBeNull();
  });
});

describe("detectDraftHandoff: deck vocabulary", () => {
  it.each([
    "Make a preso on Napoleon",
    "Make a prezo on Napoleon",
    "Make a Prezi on Napoleon",
    "Make a Power Point on Napoleon",
    "Make powerpoints about Napoleon",
    "Make a PPT on Napoleon",
    "Make a PPTX about Napoleon",
    "Make PPTs about Napoleon",
    "Create a Google Slides deck on Napoleon",
    "Create Google Slides on Napoleon",
    "Make a slideshow on Napoleon",
    "Make a slide show on Napoleon",
    "Make a slidedeck on Napoleon",
    "Build a pitch deck on Napoleon",
    "Make one slide on Napoleon",
    "Make a Keynote on Napoleon",
    "Make a keynote presentation on Napoleon",
    "Make a powerpont on Napoleon",
    "Make a powerpiont on Napoleon",
    "Make a powerpint about Napoleon",
    "Make a presentaion on Napoleon",
    "Make a presntation on Napoleon",
    "Make a presentatoin on Napoleon",
    "Make presentaions on Napoleon",
    "Make sildes on Napoleon",
    "Make a silde on Napoleon",
    "Make a slidshow on Napoleon",
    "Make a kenote on Napoleon",
    "presentaion on Napoleon",
    "sildes about Napoleon",
    "Creat a presentaion on Napoleon",
    "Turn this into a powerpont",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "Make a spreadhseet of my monthly expenses",
    "Create a spredsheet of vendors",
    "Build a speadsheet for the budget",
  ])("offers a spreadsheet for the misspelled %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("spreadsheet");
  });

  it.each([
    "Create a documnet outlining our remote work policy",
    "Write a porposal for the city council",
    "Draft a newslettr for the firm",
  ])("offers a document for the misspelled %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("document");
  });

  it("keeps a keynote speech a document", () => {
    expect(detectDraftHandoff("Write a keynote speech for the conference")).toBe("document");
  });

  it.each([
    "Make sides for Thanksgiving",
    "Make some sides for dinner",
    "Make sliders for the party",
    "Make a slice of pizza",
    "Make slime with the kids",
    "Create a sideshow for the carnival",
    "Create a contact in my phone",
    "Build a contrast between the two authors",
    "Build a slider component in React",
    "Create a slider for the volume",
    "Who is giving the keynote?",
    "Keynote speaker ideas for our conference",
    "Book a keynote speaker",
    "Get me a keynote speaker",
    "Is Keynote better than PowerPoint?",
    "Can PowerPoint export to PDF?",
    "Does Google Slides support animation?",
    "Why is my PPT so big?",
    "Make a slide rule",
    "Get a presentation clicker",
    "I need a slide projector",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: deck alone", () => {
  it.each([
    "Make a deck",
    "Build a deck",
    "Make me a short deck",
    "I need a deck on Napoleon",
    "We need a deck for Tuesday",
    "We should make a deck for this",
    "Need a deck on Napoleon",
    "Give me a deck on Napoleon",
    "Create a new deck for the partners",
    "Create a deck for our largest client",
    "Build a deck for the firm's retreat",
    "Create a deck about patio furniture sales",
    "Build a deck on pool safety",
    "Build a deck on the boat market",
    "Make a deck comparing cedar and composite siding",
    "Make a deck summarizing our Magic Kingdom visit",
    "Build a deck about the history of the tarot",
    "Make a deck for our credit card launch",
    "Turn this into a deck",
    "Put together a deck of slides",
    "Make a deck with ten slides",
    "Deck on Napoleon and Spencer Fane",
    "Create a 10-slide deck on Napoleon",
    "Build decks for each practice group",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });

  it.each([
    "Build a deck for my backyard",
    "Build a tarot deck",
    "Build a cedar deck",
    "Build a composite deck",
    "Build a wood deck",
    "Build a wooden deck behind the house",
    "Build a deck around my pool",
    "Build a deck on my boat",
    "Build a deck on the roof",
    "Build a deck on the back of my house",
    "Design a roof deck",
    "Design a rooftop deck",
    "Build a sun deck",
    "Design an observation deck",
    "Build a skateboard deck",
    "Build a Pokémon deck",
    "Build a Pokemon deck around Charizard",
    "Build a Magic deck",
    "Build a deck for Magic",
    "Draft a Magic deck",
    "Make a deck of cards",
    "Get me a deck of cards",
    "Build a card deck",
    "Make a flashcard deck for the bar exam",
    "Help me build a deck for my hot tub",
    "Build a deck with composite boards",
    "Build a deck out of cedar",
    "We need a new deck for the patio",
    "I want a deck like my neighbor's",
    "I want a deck that wraps around the house",
    "For my backyard, build a deck",
    "Build a deck for the boat",
    "Get me a deck chair",
    "I need a deck builder",
    "Build a slide for my backyard",
    "Build a water slide",
    "Build a playground slide",
    "How do I build a deck?",
    "How much does it cost to build a deck?",
    "Who should I hire to build a deck?",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: deck guards", () => {
  it.each(["Draft slides on Napoleon", "We need to draft slides on Napoleon", "I need you to draft Google Slides"])(
    "reads draft as the verb in %j",
    (text) => {
      expect(detectDraftHandoff(text)).toBe("deck");
    },
  );

  it.each(["Draft slides are attached", "The draft slides look good", "The draft deck is on the drive"])(
    "reads draft as a noun in %j",
    (text) => {
      expect(detectDraftHandoff(text)).toBeNull();
    },
  );

  it.each([
    "What makes a good slide deck?",
    "How do I make a PowerPoint?",
    "How would Napoleon run a law firm?",
    "Should I make a deck?",
    "Hey, should I make a deck?",
    "Okay, how do I make a PowerPoint?",
    "Quick question, should I build a deck?",
    "Thanks, do you think I need slides?",
    "Would it make sense to create a slide deck?",
    "Would this make a good presentation?",
    "Could a deck work better here?",
    "Will it make a deck for me?",
    "don't make slides",
    "Please don't create a presentation",
    "Never make a deck for this",
    "Make a deck right here in chat",
    "Create slides in this thread",
    "Just tell me what goes in a slide deck",
    "Any tips for making a deck?",
    "make the slide deck shorter",
    "Make this presentation more concise",
    "Make my slides prettier",
    "Add a slide about Napoleon",
    "Fix slide 3",
    "Make slide 3 about Napoleon",
    "Review my pitch deck",
    "Summarize this presentation",
    "Shorten the deck",
    "Update my PowerPoint with the new numbers",
    "Write a python script that generates slides",
    "Write a Python script to generate slides",
    "Write a function that generates a PowerPoint",
    "Use Python to make a deck",
    "Build an app to make slides",
    "Create an HTML presentation",
    "my presentation is tomorrow",
    "I gave a presentation yesterday",
    "I gave a great presentation on Napoleon yesterday",
    "We build decks for clients",
    "I make slides for a living",
    "I write reports for a living",
    "We draft contracts for clients",
    "When I make slides I use Keynote",
    "The team creates a deck every quarter",
    "Created a deck last week",
    "Give me feedback on the presentation of this argument",
    "What does the patient's presentation suggest?",
    "Write up the patient's presentation",
    "Draft a better presentation of this argument",
    "Write a clear presentation of the facts",
    "Describe the clinical presentation of lupus",
    "Write up the clinical presentation",
    "Write a summary of the clinical presentation",
    "Improve the presentation of this data",
    "Create a presentation layer in React",
    "Give me feedback on my presentation",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: round 2, who does the work", () => {
  it.each([
    ["Would it be possible to create a PowerPoint about the new EU AI Act?", "deck"],
    ["Would it be possible to write a memo on the new rule?", "document"],
    ["Would it be possible to create a spreadsheet of our vendors?", "spreadsheet"],
    ["Could it be possible to draft an NDA?", "document"],
    ["Is it possible to get a slide deck on our real estate practice?", "deck"],
    ["Is it possible for you to write a memo on the new rule?", "document"],
    ["Any chance you could do slides on phishing?", "deck"],
    ["Is there any chance you could build a deck on privacy?", "deck"],
    ["Do you think you could make me a PowerPoint on privilege logs?", "deck"],
    ["I was wondering if you could write a memo on the new rule", "document"],
    ["Would you be able to create a spreadsheet of our vendors?", "spreadsheet"],
    ["Might you write a memo on this?", "document"],
    ["Would you mind building a deck on our DEI program?", "deck"],
    ["Would you mind writing a memo on the new rule?", "document"],
    ["Would you mind building a spreadsheet for our vendors?", "spreadsheet"],
    ["Do you mind putting together a presentation on privacy?", "deck"],
    ["I need help making a deck on the merger", "deck"],
    ["I need help with a presentation on the merger", "deck"],
    ["I'd really appreciate a deck on the state of the Fed funds rate", "deck"],
    ["I'd really appreciate a memo on the new rule", "document"],
    ["We could really use a slide deck for next week's client pitch.", "deck"],
    ["We could really use a report on the new rule.", "document"],
    ["How about a slide deck on the history of Spencer Fane?", "deck"],
    ["Let's see a deck on our top risks", "deck"],
    ["Let's see a spreadsheet of our top risks", "spreadsheet"],
    ["pull a deck together on our Q3 pipeline", "deck"],
    ["pull a report together on our pipeline", "document"],
    ["throw a preso together for the CLE", "deck"],
    ["whip me up a PowerPoint on the new dress code", "deck"],
    ["Cook me up a deck on privacy", "deck"],
    ["cook me up a memo on privacy", "document"],
    ["Can you slap together a few slides on phishing?", "deck"],
    ["Find me a deck on Napoleon", "deck"],
    ["Shoot me a deck on our Q3 results", "deck"],
    ["The partners asked me to make a deck on Napoleon", "deck"],
    ["My boss wants me to make a deck", "deck"],
    ["I was told to create a slide deck", "deck"],
    ["I've been asked to prepare a report on the merger", "document"],
    ["I have to make a presentation on Friday", "deck"],
    ["We should make a deck for this", "deck"],
    ["Read this and make a deck", "deck"],
    ["Please review the notes and write a memo", "document"],
    ["I have a board meeting tomorrow so make a deck", "deck"],
    ["Using these notes make a deck", "deck"],
    ["Based on the attached create a slide deck", "deck"],
  ])("offers for %j", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "Sarah will make the slides",
    "Tom will create a presentation for the board",
    "Mark is going to make a deck.",
    "Sarah and Tom make slides for the partners",
    "Sarah will review it and make the slides",
    "The consultant shall prepare a report for the steering committee each quarter.",
    "Agency shall create a presentation for the board within 30 days.",
    "Contractor must prepare a monthly report",
    "We probably shouldn't make a deck for this",
    "I won't make a deck for this",
    "I can't make a deck for this",
    "They didn't write a report",
    "I used to make PowerPoint decks at McKinsey",
    "I can't decide if I should create a deck or a memo for this",
    "They have to make a deck",
    "They need to write a report",
    "She wants to make a presentation",
    "Our paralegal can draft a memo on that",
    "The associate could prepare a deck",
    "Priya might build the deck",
    "The team will write a proposal",
    "If you make a deck, keep it short",
    "Before you write a memo, read the file",
    "Do we need to make a deck?",
    "Why do we need to write a report?",
    "Do you want me to make a deck?",
    "Is anyone able to make a deck?",
  ])("keeps the report of someone else's work %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: round 2, words that need evidence", () => {
  it.each([
    "Make a Clash Royale deck with Hog Rider",
    "Build me a Lorcana deck",
    "Build a pauper deck for Modern night",
    "Make a burn deck for Standard",
    "Build a Balatro deck",
    "Design a 12x16 deck with stairs",
    "Build a ground-level deck with stairs",
    "Design a bridge deck for a 40 foot span",
    "I want a new deck, what's the cost per square foot?",
    "We need 40 decks of Uno for the store display",
    "Deck for sale in Kansas City",
    "Build a slide for my kid's playset",
    "Prepare H&E slides from the biopsy",
    "Drawer slides for kitchen cabinets: which size?",
    "Best slides for flat feet",
    "Adidas slides for men",
    "Nike slides on clearance",
    "Wet mount slide of pond water, what am I seeing?",
    "Presentation of the award will take place at noon.",
    "Make a character sheet for my D&D wizard",
    "Create a sign-up sheet for the potluck",
    "Make an answer sheet for the quiz",
    "Create a song sheet for the choir",
    "Create a call sheet for the video shoot",
    "Create a coloring sheet with dinosaurs",
    "Make a study sheet for the bar",
    "Workbook for 3rd grade math",
    "Create a student workbook for phonics",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it.each([
    ["Motion to compel standard in Missouri"],
    ["Motion to dismiss for lack of standing standard"],
    ["Motion for summary judgment standard in Kansas"],
    ["Speech to text app"],
    ["Book to read about Napoleon"],
    ["Novel to read at the beach"],
    ["Contract to buy a house meaning"],
    ["Policy to follow when a client dies"],
    ["Letter to the editor example"],
    ["Book that explains the stock market"],
    ["Essay with a strong thesis example"],
    ["Brief on the merits format"],
    ["Complaint for breach of contract elements"],
  ])("keeps the research fragment %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it.each([
    ["Draft a sell sheet for the new product", "document"],
    ["Memo to all staff about parking", "document"],
    ["Letter to my landlord about the leak", "document"],
    ["Make a sheet that tracks my expenses", "spreadsheet"],
    ["A workbook to calculate loan payoff", "spreadsheet"],
    ["board deck Q3", "deck"],
    ["Q3 earnings deck", "deck"],
    ["Investor deck", "deck"],
    ["Knock out a ten-slide overview of the Stark Law", "deck"],
    ["Pull together a twelve-slide summary of the deal", "deck"],
    ["Give me a one-slide summary of the deal", "deck"],
    ["Create me a slide dec on the history of Spencer Fane", "deck"],
    ["create a slide desk on our q3 results for the partners", "deck"],
    ["Create a slide back on the merger", "deck"],
    ["Make a power piont on the merger", "deck"],
    ["Prepair a slide deck on non-compete enforceability", "deck"],
    ["Put togehter a deck for the board", "deck"],
    ["Prepair a report on the new rule", "document"],
    ["Put togehter a report for the board", "document"],
    ["Create a pitchbook for the Acme panel", "deck"],
    ["Pitch book for the Acme panel", "deck"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    ["Write a keynote for the conference", null],
    ["Draft a keynote for the annual dinner", "document"],
    ["Create a Keynote on Napoleon", "deck"],
    ["Write a dek for this article", null],
    ["Make a dek of the top 10 trends in retail", "deck"],
    ["Draft a table of authorities", null],
    ["Table of authorities for my brief", null],
    ["Write a sentence about how to excel at work", null],
    ["Write VBA to export charts to PowerPoint", null],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });
});

describe("detectDraftHandoff: round 2, what the reviewer's corpus exposed", () => {
  it.each([
    ["Draft opening statement slides for the Jones trial", "deck"],
    ["Make closing argument slides for the jury on damages", "deck"],
    ["Create a practice group overview deck for the labor and employment group", "deck"],
    ["Build a beauty contest deck for the Acme panel", "deck"],
    ["Draft an answer to the complaint", "document"],
    ["pleaes make slids on the new benefits package", "deck"],
    ["Napoleon slides please", "deck"],
    ["Can you make slides out of the attached memo?", "deck"],
    ["Take the attached report and make a deck out of it", "deck"],
    ["Compile a slide deck of our top 10 wins", "deck"],
    ["Explain the new overtime rule in a PowerPoint", "deck"],
    ["Walk the board through the merger in a slide deck", "deck"],
    ["I need this as a PowerPoint", "deck"],
    ["Can I get this as a PowerPoint?", "deck"],
    ["Give me this as a slide deck", "deck"],
    ["I need this as a memo", "document"],
    ["Same thing but as a deck", "deck"],
    ["As slides please", "deck"],
    ["Can this be a slide deck?", "deck"],
    ["I have to give a presentation on Napoleon, make the slides for me", "deck"],
    ["Draft a workbook for the audit", "spreadsheet"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "Make me a flashcard deck on the bones of the hand",
    "Create a table in Word",
    "Book about Napoleon",
    "Manual for a 2015 Honda Civic",
    "Complaint about my neighbor's dog",
    "Presentation tomorrow, wish me luck",
    "PowerPoint for Mac download",
    "As a lawyer, what do I need?",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: round 2, evidence fits the risk", () => {
  it.each([
    ["make slides for my wedding toast", "deck"],
    ["create the slides for my capstone project on affordable housing", "deck"],
    ["make slides that explain our 3-year strategic plan to the full staff", "deck"],
    ["Slides for my thesis defense, 15 minutes", "deck"],
    ["slides for science fair: how different liquids affect plant growth", "deck"],
    ["last minute request: slides for a lunch and learn on phishing", "deck"],
    ["need a deck for a school fundraiser, selling cookie dough", "deck"],
    ["we need a deck for the fundraising gala, show the year in review", "deck"],
    ["Make me a deck for my sister's bachelorette", "deck"],
    ["A deck for the 5-year anniversary of our nonprofit", "deck"],
    ["deck for new tenants on how the building works", "deck"],
    ["design a deck for pitching a podcast to sponsors", "deck"],
    ["build a deck that makes the case for hiring two more engineers", "deck"],
    ["Build a client-ready steering committee update deck: status green overall", "deck"],
    ["Create a competitive analysis deck", "deck"],
    ["google slides deck: team intro, who we are, for our new interns", "deck"],
    ["need powerpoint slides for a tribute to our retiring principal", "deck"],
    ["i need powerpoint slides for our fundraising gala", "deck"],
    ["slide deck, topic is the histroy of the internet, colege level", "deck"],
    ["I'm pitching the city council on a bike lane and need a clean slide deck with the data", "deck"],
    ["cna you make a powerpoint on healthy eating", "deck"],
    ["gogle slides about the water cycle", "deck"],
    ["pich deck for my nonprofit", "deck"],
    ["pitch deck for a subscription meal kit aimed at college students", "deck"],
    ["we're a small law firm and need a spreadsheet to track billable hours", "spreadsheet"],
    ["grocery budget spreadsheet", "spreadsheet"],
    ["tax deduction tracker for a self employed photographer in excel", "spreadsheet"],
    ["attendance tracker for my karate class in google sheets", "spreadsheet"],
    ["budget for a small business in Excel, I make about 8k a month", "spreadsheet"],
    ["spreadsheet for tracking continuing education hours for my nursing license", "spreadsheet"],
    ["Monthly sales report workbook by region and rep", "spreadsheet"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "Build a deck for my dog",
    "Build a deck for the lake cabin",
    "Build a deck for grilling season",
    "Make a deck for Magic",
    "Fitness tracker for my wife",
    "Spreadsheet by Friday",
    "Give me a formula for sums in Excel",
    "Sarah and Tom want slides",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: round 2, documents that worked before the redesign", () => {
  it.each([
    ["a 10 page research paper on the effects of sleep deprivation, apa format", "document"],
    ["a full operating manual for our small brewery", "document"],
    ["a complete policy and procedures manual for a daycare", "document"],
    ["onboarding manual for new hires at a veterinary clinic", "document"],
    ["board governance manual for a nonprofit", "document"],
    ["Our board wants a strategic plan for the next three years", "document"],
    ["write a commercial lease for a retail space, 3 year term", "document"],
    ["My boss needs a report on Q3 churn", "document"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "What does this email want from me? Can you make a deck for Thursday's partner meeting?",
    "Prepare a slide for gram staining",
    "Decks for small backyards",
    "Slides for the kids at the park",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: round 2, the object ends where its description starts", () => {
  const descriptions = [
    "answering", "addressing", "focusing on", "exploring", "examining", "targeting", "giving", "featuring", "containing",
    "listing", "breaking down", "recapping", "defending", "recommending", "demonstrating", "illustrating", "evaluating",
    "assessing", "tracing", "making the case for", "aimed at", "geared toward", "tailored to", "designed for",
    "built around", "centered on", "focused on", "called", "titled", "named",
  ];

  it.each(descriptions)("sees past %j for all three kinds", (description) => {
    expect(detectDraftHandoff(`Create a slide deck ${description} the new overtime rule`)).toBe("deck");
    expect(detectDraftHandoff(`Write a report ${description} the new overtime rule`)).toBe("document");
    expect(detectDraftHandoff(`Build a spreadsheet ${description} the new overtime rule`)).toBe("spreadsheet");
  });

  it.each([
    ["Create a deck titled The Greatness of Napoleon", "deck"],
    ["Make a deck focusing on our Q3 wins", "deck"],
    ["Build a PowerPoint aimed at first-year associates", "deck"],
    ["Create a report writing workshop", null],
    ["Make a presentation skills course", null],
    ["powerpoint training for new bank tellers", "deck"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });
});

describe("detectDraftHandoff: round 2, the user's own words", () => {
  const notes = "Partner meeting notes. Attendance was strong and the group spent the first half hour on hiring. ".repeat(14);
  const contract = "12.4 Limitation of Liability. Neither party shall be liable for indirect damages under this Agreement. ".repeat(14);
  const email = "From: Dana Reyes. Sent: Monday. Subject: Intake. Hi all, a few things before Thursday. Please remind your teams. ".repeat(10);

  it.each([
    [`Here is the background.\n\n${notes}\n\nGiven all of that, I need a ten-slide deck for Thursday.\n\n${email}`, "deck"],
    [`${email}\n\nPlease create a PowerPoint on this for the board. Here is the contract:\n\n${contract}`, "deck"],
    [`${notes}\n\nMake me a deck from those numbers. ${"Keep the tone upbeat and confident for the chair. ".repeat(20)}`, "deck"],
    [`${notes}\n\nCan you put together a presentation on the hiring section only?\n\n${contract}`, "deck"],
    [`${contract}\n\nDraft a slide deck that walks the client through that clause.\n\n${email}`, "deck"],
    [`${notes}\n\nGiven all of that, write a memo for the partners.\n\n${contract}`, "document"],
    [`${notes}\n\nPut the hiring numbers in a spreadsheet for me.\n\n${contract}`, "spreadsheet"],
    [`${email}\n\nPlease put together a presentation answering these points.`, "deck"],
  ])("sees the request in a long message", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "Draft a reply to this email: Hi team, please prepare a deck for Thursday's board meeting.",
    "Summarize this email: Please create a presentation on the Acme deal by Friday.",
    "Translate this: Please write a memo to the board.",
    "What does this mean: Create a slide deck for the partners.",
    "Who is responsible for what in these minutes?\n\nAction items: Priya will build the deck. Tom will draft a memo.",
    "Summarize these notes:\n\nPrepare a deck for the board.\n\nCall Sam about the lease.",
    "Hi team, please prepare a deck for Thursday's board meeting.",
    "Hi team,\n\nPlease prepare a deck for Thursday's board meeting.\n\nThanks,\nDana",
    "Dear Sam,\n\nPlease write a report on the merger.\n\nRegards,\nDana",
    "What should I do first?\n- Prepare a deck for the board\n- Call Sam about the lease",
    "> Please create a slide deck for the board",
    "Here's the email: Hi Sam, please prepare a deck for Thursday.",
    "Notes from the call: prepare a report for the board and send it.",
    "From: Dana\nSubject: Board\nPlease prepare a deck for Thursday",
  ])("keeps pasted material out: %j", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it.each([
    ["Hi Dana,\n\nPlease prepare a deck.\n\nThanks,\nDana\n\nMake a slide deck from this email", "deck"],
    ["Hi there, make a deck on Napoleon", "deck"],
    ["Hi Aperture, please write a memo on the merger", "document"],
    ["Here are my notes:\n\nAttendance was strong.\n\nMake a deck from these.", "deck"],
    ["Make a deck from this email: Hi Sam, the board met on Tuesday.", "deck"],
  ])("still hears the user around pasted material: %j", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    ["Create a slide deck with some tips for new associates", "deck"],
    ["Make a deck for the board. Any ideas you have for the title are welcome.", "deck"],
  ])("does not read %j as asking for advice", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each(["I need to write an essay. Any tips?", "I need to write an essay, any tips?", "I'm making a deck, any advice on length?"])(
    "reads %j as asking for advice",
    (text) => {
      expect(detectDraftHandoff(text)).toBeNull();
    },
  );
});

describe("detectDraftHandoff: round 2, grammar pinned at its edges", () => {
  const padding = "The group met on Tuesday and reviewed the numbers. ";
  const buried = `${padding.repeat(6)}Make a deck on Napoleon. ${padding.repeat(9)}`;

  it("reads a long paragraph alone in a message, and only the edges of one among others", () => {
    expect(detectDraftHandoff(buried)).toBe("deck");
    expect(detectDraftHandoff(`${buried}\n\nShort note.`)).toBeNull();
    expect(detectDraftHandoff(`Short note.\n\n${buried}\n\nShort note.`)).toBeNull();
    expect(detectDraftHandoff(`Short note.\n\n${buried}`)).toBeNull();
    expect(detectDraftHandoff(`Write a memo summarizing the notes. ${padding.repeat(40)}`)).toBe("document");
  });

  it.each([
    ["Need to make a deck on Napoleon", "deck"],
    ["Turn this around and make a deck", "deck"],
    ["Compose this and make a deck", "deck"],
    ["Sketch it out and make a deck", "deck"],
    ["Want to present and need slides", "deck"],
    ["How about you make a deck on Napoleon?", "deck"],
    ["Convert this into PowerPoint slides", "deck"],
    ["Make a Napoleon deck on his marshals", "deck"],
    ["Build a deck for Tuesday", "deck"],
    ["Build a deck for me", "deck"],
    ["Build a deck for the board", "deck"],
    ["A spreadsheet where the total is calculated", "spreadsheet"],
    ["Memo on the elements of negligence", "document"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "Make a list from this: Create a deck for the board",
    "Like a deck on Napoleon",
    "Love a deck on Napoleon",
    "Spin a deck together",
    "Mention a deck on Napoleon",
    "Can this improve a deck on Napoleon?",
    "Tell me how you could make a deck",
    "Tell me what you could make a deck about",
    "Explain VLOOKUP in a spreadsheet",
    "The client wants the cities in a table",
    "Motion to compel standard under Rule 37",
    "Motion to compel standard for Missouri courts",
    "Report on",
    "Report with a chart please",
    "Memo, report, and deck ready",
    "Monthly sales workbook by 5pm",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: round 3, courteous framing in general", () => {
  const frames = [
    "Would you be willing to", "Would you be so kind as to", "Would you care to", "Could you please take a moment to",
    "Feel free to", "I was hoping you would", "I'd be grateful if you would", "I'm looking to", "We're looking to",
    "Looking to", "I'm planning to", "I have been tasked to", "I need your help to", "You should", "You can", "Time to",
    "Would you kindly", "Could you possibly", "Go ahead and", "I was hoping you could", "It would be great if you could",
    "It would help if you could", "Would love for you to", "Can I ask you to", "May I ask you to", "We are trying to",
    "I am hoping to", "The GC told me to", "My partner asked me to", "Are you free to", "Do you have time to",
    "Do you have a minute to", "Would you have a moment to", "If you'd", "I'd be obliged if you would", "Can someone",
    "Could somebody", "Would you mind if I asked you to", "Please could you", "Be a dear and", "Would you consider",
    "Would you be up for", "Won't you", "Couldn't you", "Can't you", "We should probably", "We'd better", "You'd better",
    "I should", "I must", "I ask that you", "Next up", "If possible", "At your convenience", "Real quick",
    "Would it be alright if you",
    "I'd appreciate it if you could", "Would it be okay if you could", "If you could", "Please be sure to", "Remember to",
  ];

  it.each(frames)("hears %j around all three kinds", (frame) => {
    expect(detectDraftHandoff(`${frame} write a memo on the new overtime rule`)).toBe("document");
    expect(detectDraftHandoff(`${frame} create a slide deck on the new overtime rule`)).toBe("deck");
    expect(detectDraftHandoff(`${frame} build a spreadsheet of our vendors`)).toBe("spreadsheet");
  });

  it.each([
    "Sarah is going to make a deck",
    "The partners need to make a deck for the retreat",
    "This role requires you to write reports and build decks",
    "Our CFO wants to build a spreadsheet of vendors",
    "Lawyers often write memos for clients",
    "Can you tell me if Sarah will make a deck?",
    "I forgot to make the slides",
    "I failed to write a report",
    "Trying to decide whether to make slides for the kickoff",
    "Do you think we need to make a deck?",
    "Do you know how to make a slide transparent in PowerPoint?",
    "Use Go to make a PowerPoint",
    "Tom plans to write a report",
    "The team wants to create a deck",
    "They are looking to make a presentation",
    "Sarah was asked to prepare a deck",
    "She told him to write a memo",
    "If you want to make a deck, open PowerPoint",
    "When you need to write a report, start early",
    "It took me hours to make the slides",
    "I think they need to write a report",
    "We use Python to make a deck",
    "Here are some ways to write a memo",
    "A good tool to make slides",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it.each([
    ["I wouldn't mind a slide deck on Napoleon", "deck"],
    ["I require a deck on Napoleon", "deck"],
    ["We request a presentation on Napoleon", "deck"],
    ["I'd prefer a deck on Napoleon", "deck"],
    ["Seeking a deck on Napoleon", "deck"],
    ["Requesting a slide deck on Napoleon", "deck"],
    ["Hoping for a PowerPoint on Napoleon", "deck"],
    ["We're in need of a presentation on Napoleon", "deck"],
    ["Could I trouble you for a deck on Napoleon?", "deck"],
    ["Can I ask you for a memo on the merger?", "document"],
    ["creating a slide deck on the Battle of Waterloo for our partners retreat please", "deck"],
    ["desgin a deck for the investor day", "deck"],
    ["Can we get a PowerPoint going on the tax changes?", "deck"],
    ["Could you take a stab at a deck on remote work?", "deck"],
    ["My boss asked me for a PowerPoint on recruiting, can you build it?", "deck"],
    ["make a presntaion on zoning variances", "deck"],
    ["hey create a presentation period the topic is Joan of Arc", "deck"],
    ["pls mke a deck for mondays staff mtg", "deck"],
    ["Powerpoint - antitrust basics", "deck"],
    ["Build a deck of trial demonstratives for the Ross case", "deck"],
    ["Make that a slide deck instead", "deck"],
    ["Make that a deck", "deck"],
    ["Can I get that in slide form?", "deck"],
    ["In PowerPoint format please", "deck"],
    ["Prepare a workbook tracking our AR", "spreadsheet"],
    ["Prepare a spreadsheet tracking our AR", "spreadsheet"],
    ["Make an Excel model forecasting revenue", "spreadsheet"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it("reads a courteous fragment anywhere in a long message", () => {
    const policy = "All staff must complete the annual training by the end of the quarter. ".repeat(20);
    expect(detectDraftHandoff(`${policy}\n\nSlides on this for Thursday's training please.`)).toBe("deck");
  });
});

describe("detectDraftHandoff: round 3, the last ask wins", () => {
  it.each([
    "Create a slide deck on the merger. Is that a fair thing to ask an intern?",
    "Draft a memo on this by noon. Is my boss being unreasonable?",
    "Build a deck for the client by Friday. That's the whole email. What do I say back?",
    "Please create a presentation on Q3 results for Tuesday. That's what my boss emailed me. How do I tell her the numbers aren't final?",
    "Make a slide deck for the all-hands, she said. I told her I was on vacation. Am I wrong?",
    "Can you put together some slides for the kickoff? Sure, when do you need them? Tomorrow.\n\nWas I rude in this text exchange?",
    "The client wrote back: we need you to prepare a PowerPoint on the findings. Does that fall under our engagement scope?",
    "Team, please build a deck on the outage and share it with the CIO. Translate this to Spanish.",
    "Please make a slide deck for the partners. Fix the grammar in that sentence.",
    "Create a slide deck for the kickoff. Draft the NDA. Email the landlord.\n\nPut these in priority order.",
    "Senior Paralegal. Duties: write a report each week. Summarize the responsibilities above.",
    "\"Please create a slide deck for the board.\" Is that sentence in active voice?",
    "Rails and slides for a server rack, what size?",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it.each([
    ["How would Napoleon run a law firm? Build a deck.", "deck"],
    ["The board meets Friday. Can you make a deck on Q3?", "deck"],
    ["Make a deck on Napoleon. Is that possible?", "deck"],
    ["Create a memo on the merger. Does that work?", "document"],
    ["Make a deck on Napoleon. Keep it short.", "deck"],
    ["Write a memo on the merger. Thanks.", "document"],
    ["What are the risks? Summarize them in a memo.", "document"],
    ["Based on that, what are the main risks, and can you make a deck on them?", "deck"],
    ["Make a deck on Napoleon.\nWrite a memo on Wellington.", "deck"],
  ])("still hears %j", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "paul: can you make a deck for friday\njen: sure what about\npaul: keep it short\njen: ok\n\nWas Paul being rude?",
    "paul: can you make a deck for friday\njen: sure",
    "TODO\n[ ] make a deck for the board\n[ ] write the memo\n[x] call Sam",
    "Next steps\nCreate a deck for the board\nWrite a memo to the partners\nBuild a spreadsheet of vendors",
    "Is this grammatical? Please create a deck for the board.",
    "What's the tone of this? Write a memo by Friday or else.",
    "[10:14 AM] Paul: make a deck for the merger\n[10:15 AM] Jen: when?\n[10:15 AM] Paul: Friday",
    "Q. Did you prepare a slide deck for the meeting?\nA. I did.",
  ])("treats labelled lines as a transcript: %j", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it("keeps a body's middle out but hears the words around it", () => {
    const body = (line: string) => `${"The board met on Tuesday and reviewed the audit plan in detail. ".repeat(6)}${line} ${"The committee will report back next quarter with its findings. ".repeat(6)}`;
    expect(detectDraftHandoff(`${body("Prepare a report for the auditors.")}\n\n${body("Create a deck for the partners.")}\n\nThanks.`)).toBeNull();
    expect(detectDraftHandoff(`${body("x")}\n\nMake a deck from that.\n\n${body("y")}`)).toBe("deck");
  });
});

describe("detectDraftHandoff: round 3, presentation needs evidence", () => {
  it.each([
    "Late presentation of appendicitis in the elderly",
    "Presentation of a negotiable instrument under UCC 3-501",
    "Presentation of the award will take place at noon.",
    "Atypical presentation of a heart attack",
    "Clinical presentation of lupus",
    "Write up the patient's presentation",
    "Write up the clinical presentation",
    "Draft a better presentation of this argument",
    "Write a clear presentation of the facts",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it.each([
    "Make a presentation of our Q3 results",
    "Create a presentation on the merger",
    "Presentation on the merger",
    "Presentation for tomorrow's client meeting",
    "Make a board presentation",
    "Make a short presentation",
    "Prepare a 10-minute presentation for the partners",
    "Make a sepsis presentation",
    "Make a sepsis presentation for the residents",
    "Create a Napoleon presentation",
    "Marketing plan presentation for the fall campaign",
    "Create a presentation",
    "I need a presentation for tomorrow",
  ])("offers a deck for %j", (text) => {
    expect(detectDraftHandoff(text)).toBe("deck");
  });
});

describe("detectDraftHandoff: round 3, grammar pinned at its edges", () => {
  const padding = "The group met on Tuesday and reviewed the numbers. ";

  it.each([
    [`Short note.\n\n${padding.repeat(10)}Make a deck on Napoleon.`, "deck"],
    ["Create a deck on Napoleon. Write a memo on Wellington. Build a spreadsheet of marshals.", "deck"],
    ["Draft something on the merger", "document"],
    ["Doing a presentation on Napoleon", "deck"],
    ["Sepsis presentation for the residents", "deck"],
    ["Make a Q3 deck", "deck"],
    ["Build a PowerPoint deck", "deck"],
    ["Make a marketing plan presentation of our Q3 results", "deck"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "We're preparing a deck for the client",
    "Knock a report out of the park",
    "Breech presentation",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: round 3, spreadsheet details", () => {
  it.each(["Periodic table of elements", "Build a tracker in Python"])("keeps %j out of spreadsheets", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: round 4, a question can follow a request or replace it", () => {
  const context = "Our client is a regional hospital system and the board meets next month. ".repeat(8);

  it.each([
    ["Creat for me a slide deck on the greatness of Napoleon and how he has similarities to our firm Spencer Fane L L P. How many slides do you recommend?", "deck"],
    ["Make me a deck on Q3 results. How many slides do you recommend?", "deck"],
    ["Build a presentation on the new overtime rule. What do you need from me?", "deck"],
    ["Make a deck for the partners on lateral hiring. Is that something you can do?", "deck"],
    ["Please create a slide deck on Napoleon. Who should the audience be?", "deck"],
    ["Put together a presentation on HIPAA. What format do you suggest?", "deck"],
    ["Prepare slides on the new lease standard. Should I send you the numbers?", "deck"],
    ["Write me a PowerPoint on estate tax. Is ten slides enough?", "deck"],
    ["Make slides for the kickoff. Where should I upload the notes?", "deck"],
    ["Create a deck on wage theft. What else should I tell you?", "deck"],
    ["Make a deck on Q3. Does it need an appendix?", "deck"],
    ["Create a deck on Q3. Should it be dark or light?", "deck"],
    ["Build a presentation on arbitration, ten slides. What's your plan?", "deck"],
    ["Create a deck on the merger. Translate it into Spanish.", "deck"],
    [`${context}\n\nPlease make me a deck on this.\n\nHow long do you think it should run?`, "deck"],
    [`${context} Please make me a deck on this. How long do you think it should run?`, "deck"],
    ["Draft a report on turnover. How long will it take?", "document"],
    ["I need a memo on spoliation. What do you need from me?", "document"],
    ["Write a proposal for the city. Should it mention our fees?", "document"],
    ["Write a memo on the merger. What should the memo cover?", "document"],
    [`${context}Write a memo on the merger. What should the memo cover?`, "document"],
    [`${context}Make a deck on this. How long will it take?`, "deck"],
    ["Never mind the old one, make a deck on Napoleon", "deck"],
    ["Build a budget spreadsheet for the retreat. What categories should I add?", "spreadsheet"],
  ])("keeps %j", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "Create a slide deck on the merger. Is that a fair thing to ask an intern?",
    "Create a slide deck on the merger. Is it fair to ask an intern?",
    "Draft a memo on this by noon. Is my boss being unreasonable?",
    "Make a slide deck for the all-hands, she said. Am I wrong?",
    "Write a report on turnover by Friday. How should I respond?",
    "Write a report on turnover by Friday. What do I say back?",
    "Please create a presentation for Tuesday. How do I tell her the numbers aren't final?",
    "Write a memo on the Elm Street dispute by Tuesday. Reword that as a polite request.",
    `${context}Write a report on the board. What's due first?`,
    "Forwarded message. Please create a presentation for the committee.\n\nWho's Dana likely to be here?",
    "Project brief. Design a deck on our capabilities.\n\nWhat is the budget likely to be for this kind of work?",
    "Make a deck. Keep it short. How do I ask for more detail?",
    "Greg asked: can you make a deck for the offsite? What should I charge?",
    "The client wrote back: we need you to prepare a PowerPoint on the findings.",
  ])("drops %j", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });

  it.each([
    "Actually, don't make slides. What is a good title?",
    "Make a deck on Napoleon. Actually, don't make slides. What is a good title?",
    "Make a deck on Napoleon. Never mind.",
    "Create a slide deck on the merger. Actually, scratch that.",
    "Write a memo on the merger. On second thought, forget it.",
    "Make a deck on Napoleon. Don't bother, what is a good title?",
  ])("honors the retraction in %j", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
  });
});

describe("detectDraftHandoff: round 4, neighbors of those fixes still offer", () => {
  it.each([
    ["Build a deck for Friday", "deck"],
    ["Build a deck for the Friday board meeting", "deck"],
    ["Make a table out of these numbers", "spreadsheet"],
    ["Presentation to explain the new rule", "deck"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });
});

describe("detectDraftHandoff: round 4, role frames", () => {
  it.each(["Your task is to", "Your job is to", "The task is to", "The goal is to", "Your assignment is to", "Would it be too much trouble to"])(
    "hears %j around all three kinds",
    (frame) => {
      expect(detectDraftHandoff(`${frame} write a memo on the new overtime rule`)).toBe("document");
      expect(detectDraftHandoff(`${frame} create a slide deck on the Clean Water Act`)).toBe("deck");
      expect(detectDraftHandoff(`${frame} build a spreadsheet of our vendors`)).toBe("spreadsheet");
    },
  );

  it.each([
    "The purpose of the meeting is to create a presentation",
    "Julia offered to make the slides",
    "Mark promised to draft a report",
    "Face presentation during labor",
    "Presentation to the grand jury without a target letter",
    "Build a Pioneer deck for the Friday tournament",
    "Make a table out of reclaimed barn wood",
  ])(
    "keeps %j in chat",
    (text) => {
      expect(detectDraftHandoff(text)).toBeNull();
    },
  );
});

describe("detectDraftHandoff: round 5, phrases the fourth hold-out lost", () => {
  it.each(["How does that sound?", "How's that sound?", "How does this look?", "Is that clear?", "Is that enough?", "How long will that take?"])(
    "keeps a request when it closes with %j",
    (closing) => {
      expect(detectDraftHandoff(`Create a slide deck on the Clean Water Act. ${closing}`)).toBe("deck");
      expect(detectDraftHandoff(`Write a memo on the new overtime rule. ${closing}`)).toBe("document");
      expect(detectDraftHandoff(`Build a spreadsheet of our vendors. ${closing}`)).toBe("spreadsheet");
    },
  );

  it.each(["Your role is to", "The ask is to", "The request is to"])("hears %j around all three kinds", (frame) => {
    expect(detectDraftHandoff(`${frame} write a memo on the new overtime rule`)).toBe("document");
    expect(detectDraftHandoff(`${frame} create a slide deck on the Clean Water Act`)).toBe("deck");
    expect(detectDraftHandoff(`${frame} build a spreadsheet of our vendors`)).toBe("spreadsheet");
  });

  it.each([
    ["hey Aperture create a slide deck about Justice Ginsburg", "deck"],
    ["Aperture, write a memo on the new overtime rule", "document"],
    ["assistant, build a spreadsheet of our vendors", "spreadsheet"],
    ["Draft demonstrative slides for the expert's damages testimony", "deck"],
  ])("reads %j as %s", (text, kind) => {
    expect(detectDraftHandoff(text)).toBe(kind);
  });

  it.each([
    "How does that deck sound to you?",
    "Is that memo clear?",
    "The role of the clerk is to draft a report",
    "The task of the clerk is to draft a report",
    "What aperture should I use for a slide deck photo?",
    "My assistant made the slides",
  ])("keeps %j in chat", (text) => {
    expect(detectDraftHandoff(text)).toBeNull();
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
