# README interface captures

The root README's screenshots and product tour were recaptured on
November 3, 2026 from the v0.5.21 interface: the **Share** button in the Drafts
top bar, the Share dialog, the folder drop zone and a folder kept in sync, a
knowledge base filed under a client-matter number, and the **Matter** row in
Send options. `chat-light.png`, `chat-dark.png`, `chat-mobile.png`, and
`sign-in.png` came out identical to the November 2 captures and were kept. The
images illustrate the current interface, not a claim that every pixel matches an
older published image.

Four pictures were added on November 10, 2026 from the v0.5.23 interface:
`chat-steps-light.png`, `chat-questions-light.png`,
`drafts-questions-light.png`, and `drafts-check-light.png`. Nothing else was
recaptured, so the product tour and the other pictures still show v0.5.21 and
do not show research steps, question cards, or the **Check** key.

One picture was added on November 13, 2026 from the v0.5.25 interface:
`chat-fallback-light.png`. It was taken on an isolated instance with a fresh
data directory and the seeded demo organization. Both models in it are
scripted stand-ins on a small local server. `qa-filtered` answered every
request with "I'm sorry, but I cannot assist with that request.", a
`content_filter` finish, and Azure named as the server, the way OpenRouter
reports Azure's filter. `qa-stub` streamed a fixed answer. The retries, the
switch to the other model, and the work trace are the application's own. No
real provider filter was pictured.

One picture was added on November 22, 2026 from the v0.5.27 interface:
`drafts-reasoning-light.png`. It was taken by the clean-install check on an
empty data volume with the release Compose file. The drafting model in it,
"Foundry GPT-5.5 stand-in", is a scripted stand-in on a small local server
registered as an Azure AI Foundry deployment named `gpt-5.5`. The
**Assistant settings** panel, the **Reasoning** stops, and the help line are
the application's own. No real model was called.

Two pictures were added on November 24, 2026 from the v0.5.28 interface:
`deck-add-block-light.png` and `tools-only-me-light.png`. Both were taken on
one isolated local instance (API, Vite, and a stand-in model server on
loopback ports) started from the release source on a fresh, empty data
directory with seeds off. The first owner was created through the bootstrap
flow; the organization was renamed Meridian Advisory Group, and Legal,
Operations, and Finance groups and a workspace admin, Priya Shah, were added
through the admin API. Both pictures are signed in as Priya Shah, a normal
workspace admin, in the light theme at 1440×900 and 2× scale, and were
compressed with `oxipng -o 4 --strip safe`. The model picker in the deck
picture reads `qa-stub`: a scripted stand-in on a small local server,
registered only so Drafts offers **Ask AI**. It was never sent a request
during either capture (its request log holds only a model-list call), and no
text in either picture came from it or from any other model. The Deck
Assistant's three suggestions are the application's built-in prompts.

- `deck-add-block-light.png`: a three-slide deck, "Q3 onboarding", built in
  the browser: a Title slide, a Two columns slide of goals and results, and a
  Title + bullets "Next steps" slide, each added with **Add slide** and typed
  into the slide, then kept with **Save version**. With layouts and themes
  folded away, the capture clicks the plus in the Next steps slide's empty
  space and shows the menu it opens.
- `tools-only-me-light.png`: an MCP (SSE) connection named Client Records
  Search, pointing at a reserved `example.test` address, added through
  **Add connection** in Library → Tools. The capture opens **Access &
  approval**, picks **Only me** under **Who can use it**, and saves. The
  connection was never turned on or tested.

One picture was added on November 25, 2026 from the v0.5.29 interface:
`prompt-audience-light.png`. It was taken on an isolated local instance (API
and Vite on loopback ports) started from the release source on a fresh, empty
data directory with seeds off. The first owner was created through the
bootstrap flow; the organization was renamed Meridian Advisory Group, and
Legal, Operations, and Finance groups and a workspace admin, Priya Shah, were
added through the admin API. The groups have no members, so each reads "0
people". The picture is signed in as Priya Shah in the light theme at
1440×900 and 2× scale, and was compressed with `oxipng -o 4 --strip safe`. No
model was registered on the instance, and none was called: the prompt's text
was typed into the editor by the capture script. The prompt was not saved.

## Capture content

- `product-tour-light.gif`, `product-tour-light.png`: the README hero, a
  crossfaded slideshow of twelve light-mode captures (a cited agent answer in
  chat, a structure diagram, a code block, Agents, Automations, Knowledge, a
  folder kept in sync, the document editor, the Share dialog, the slide editor,
  a spreadsheet, and the Admin Console), with the first frame as the
  reduced-motion fallback.
- `chat-light.png`: a Policy Assistant answer citing the uploaded travel
  policy.
- `chat-dark.png`: a colored Python code block with its Copy, Download,
  Preview, and Edit toolbar.
- `chat-diagram-light.png`, `chat-diagram-dark.png`: a structure diagram of the
  vendor approval workflow with its style and export toolbar.
- `chat-mobile.png`: the cited answer at a phone-sized breakpoint.
- `drafts-light.png`, `drafts-dark.png`: a manually authored project brief in
  the document editor.
- `drafts-share-light.png`: the Share dialog on that brief with **Specific
  people** chosen, two colleagues added, and the rest of the organization
  offered. The capture stops before **Save sharing**, so the brief stays
  private.
- `deck-light.png`, `deck-dark.png`: the same brief converted through the real
  Document/Deck switch and rebuilt by the deck assistant, shown in the Midnight
  (light interface) and Editorial (dark interface) designs on the big-number
  slide.
- `spreadsheet-light.png`, `spreadsheet-dark.png`: a three-sheet FY2027 budget
  workbook in the spreadsheet editor. The light capture shows the Budget sheet
  with a department table, a `SUM` formula in the formula bar, and a stacked
  column chart; the dark capture shows the By office sheet with a pivot table
  over the Expense log sheet, a share formula reading its totals, and a bar
  chart.
- `agents-light.png`, `automations-light.png`: three agents and three
  automations (weekly, weekday cron, and a paused one-time run).
- `knowledge-dark.png`, `tools-dark.png`: a knowledge base with a Word file's
  properties, sensitivity label, and ethical wall expanded, and the prompt
  templates in Tools.
- `knowledge-folders-light.png`: the Hartwell Acquisition knowledge base,
  created through the New knowledge base dialog with client-matter number
  100482-0007, after its five-file folder was added with **choose a folder**
  and **Keep in sync** was turned on. The folder was written to the capture
  browser's origin-private file system and handed to the folder picker, because
  an automated browser cannot open the system folder dialog; the upload, the
  indexing, and the sync check are the application's own.
- `chat-matter-light.png`: Send options in the London client workshop chat
  with the **Matter** row open, offering the saved number.
- `admin-light.png`, `platform-dark.png`: the Admin Console user list and the
  Platform Owner Console model availability table, both opened from the
  Account panel.
- `sign-in.png`: email sign-in, access requests, and the pre-login walkthrough.
- `chat-fallback-light.png`: a reply's work trace after a provider's filter
  withheld it on all three tries and another model answered, with the answer
  below it.
- `chat-steps-light.png`: a reply's work trace after it took research steps
  (two more searches of workspace knowledge and one worked-out figure), with
  the cited answer below it.
- `chat-questions-light.png`: a reply paused on its question card, question 1
  of 3, with a suggested choice, **Next**, **Decide for me**, and **Always
  decide for me**.
- `drafts-questions-light.png`: the Document Assistant paused under a request
  with question 1 of 2 before it writes anything.
- `drafts-reasoning-light.png`: Drafts **Assistant settings** with **Smart**
  chosen under **Reasoning** and its help line, beside an empty document.
- `drafts-check-light.png`: the **Check** panel beside a five-line consulting
  agreement typed into the editor, listing three blanks and two defined-term
  findings.
- `deck-add-block-light.png`: the slide editor on a typed Next steps slide
  with the add menu open from the plus in the slide's empty space, offering
  **Ask AI**, **Text box**, **Bullet list**, and **Picture**.
- `tools-only-me-light.png`: the Library connection editor for Client Records
  Search on **Access & approval**, with **Only me** chosen on the **Who can
  use it** rail beside **Everyone** and **Specific groups**, and the line
  "Only you can use this connection."
- `prompt-audience-light.png`: a new prompt, Deposition outline, in Library →
  Tools → **Prompts**, scrolled to the foot of its editor. **Specific groups**
  is chosen on the **Who can use it** rail, the Legal group is ticked, and the
  lines read "Only people in the groups you tick can use this prompt." and
  "Administrators can also open and edit it."

## Data and honesty

The organization ("Meridian Advisory Group"), people, policies, project brief,
budget workbook, agents, automations, prompts, and skills are synthetic. The
capture API ran the current source against an isolated local data store built
for the October 28 captures and migrated forward, with no seeded demo data, no
production configuration, and no private credentials.

The Hartwell Acquisition folder holds five short synthetic Markdown notes
written by the capture script.

Model output is real. Chat replies, the code block, the structure diagram,
automation runs, and the deck rebuild came from Qwen 3.5 9B, an open model served locally through an OpenAI-compatible
endpoint and registered through the normal provider, key, validation, and
model-sync flow. Those replies were generated for the October 28 captures and
reused here unchanged; no model ran for this recapture.

The spreadsheet workbook is not model output. Its names and figures are
synthetic, written by a script and saved through the drafts API. The table,
pivot table, and charts are defined in that file, and the editor calculated
every formula, total, and pivot result when it opened the workbook. The
Spreadsheet Assistant is shown in its empty state.

Knowledge documents were uploaded and indexed by the
application; citations point at those uploads. The Word files' properties
(author, policy owner, sensitivity label, ethical wall) were written into
synthetic files before upload and read back by the application. The deck
assistant was given the brief's facts in its request, and every slide was
checked against the brief. No provider
responses, connection results, or usage counters were edited or fabricated.
Screens that depend on external services (web search, cloud connectors, MCP
servers) are shown in their unconfigured state or not at all.

The four November 10 pictures are different, and the model picker in them
reads `qa-stub` to say so. They were taken on separate isolated instances
started with the application's seeded demo organization, and the model was a
scripted stand-in, not a real model: a small local server that returns a fixed
question block, a fixed request for research steps, and a fixed answer. What
the application did with those is real. It drew the question cards, ran the
knowledge searches against the seeded demo knowledge, worked out
`1250000 * 0.065 / 12` itself, matched the citation markers, and built the
work trace. The answer text in `chat-steps-light.png` is the stand-in's
script, so it is not evidence of what a real model would write. The **Check**
panel uses no model; its findings come from the text typed into the editor.
No real model has been pictured asking a question or taking a step yet.

## Refresh procedure

1. Run the current UI against an isolated local API with separate data paths,
   seeds disabled, and no private production configuration. Create the first
   owner through the bootstrap flow and use only synthetic accounts and files.
2. Connect a local model (for example Ollama or another OpenAI-compatible
   server) through the Platform Owner Console flow so answers are genuine.
   Review every answer for accuracy against the synthetic source documents
   before capturing it.
3. Capture the real interface in light and dark themes and at a mobile
   breakpoint (1440×900 at 2× device scale; 390×844 for mobile). Keep
   unconfigured-state notices visible; do not restyle the product or invent
   results for the image.
4. Stage captures in an ignored output directory and review every image for
   private data, credentials, unrelated history, transient tooltips, cut-off
   content, and correspondence with the current interface.
5. Rebuild the tour from the reviewed light captures, replace this directory's
   named files as one batch, and update this page and the README captions when
   scope changes. Preview the README, check relative links, and run
   `git diff --check`.

The tour is an FFmpeg slideshow of the reviewed PNGs: each frame is scaled to
1280 pixels wide at 10 frames per second, held for three seconds, and
crossfaded into the next over 0.3 seconds (`xfade`). It uses one shared
palette with ordered (Bayer) dithering and changed-rectangle encoding, so the
static holds cost almost nothing and interface text stays sharp.

README screenshots are separate from the in-app training frames and PDF/video
build pipeline; see [training publication](../TRAINING.md) before changing
those assets. The narrated product walkthrough lives on
[ApertureChat.com](https://aperturechat.com/#demoPanel); its source recordings
are maintained in the
[ApertureChat-Website](https://github.com/Aperture-Chat/ApertureChat-Website)
repository, and `apps/web/scripts/generate-readme-tour.cjs` can still transcode
them when a README copy of that walkthrough is wanted.
