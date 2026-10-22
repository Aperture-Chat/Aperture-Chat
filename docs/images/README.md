# README interface captures

The root README's screenshots and product tour were recaptured on
October 21, 2026 from the v0.5.14 interface: the warm light palette, tactile
buttons and toggles, the Aperture Chat wordmark and icon, and the upgraded
deck editor with its left-hand slide panel. They illustrate the current
interface, not a claim that every pixel matches an older published image.

## Capture content

- `product-tour-light.gif`, `product-tour-light.png`: the README hero, a
  slideshow of seven light-mode captures (a cited agent answer in chat, Agents,
  Automations, Knowledge, the document editor, the slide editor, and the Admin
  Console), with the first frame as the reduced-motion fallback.
- `chat-light.png`, `chat-dark.png`: a Policy Assistant answer citing the
  uploaded travel policy, and a chat delivered by an automation's Run now.
- `chat-mobile.png`: the same cited answer at a phone-sized breakpoint.
- `drafts-light.png`, `drafts-dark.png`: a manually authored project brief in
  the document editor.
- `deck-light.png`, `deck-dark.png`: the same brief converted through the real
  Document/Deck switch and rebuilt by the deck assistant, with the slide panel
  and floating text toolbar.
- `agents-light.png`, `automations-light.png`: three agents and three
  automations (weekly, weekday cron, and a paused one-time run).
- `knowledge-dark.png`, `tools-dark.png`: a knowledge base with its uploaded
  documents, and the prompt templates in Tools.
- `admin-light.png`, `platform-dark.png`: the Admin Console user list and the
  Platform Owner Console model availability table.
- `sign-in.png`: email sign-in, access requests, and the pre-login walkthrough.

## Data and honesty

The organization ("Meridian Advisory Group"), people, policies, project brief,
agents, automations, prompts, and skills are synthetic. The capture API used
new local data stores, no seeded demo data, no production configuration, and no
private credentials.

Model output is real. Chat replies, automation runs, and the deck rebuild came
from Qwen 3.5 9B, an open model served locally through an OpenAI-compatible
endpoint and registered through the normal provider, key, validation, and
model-sync flow. Knowledge documents were uploaded and indexed by the
application; citations point at those uploads. No provider
responses, connection results, or usage counters were edited or fabricated.
Screens that depend on external services (web search, cloud connectors, MCP
servers) are shown in their unconfigured state or not at all.

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

The tour is a plain FFmpeg slideshow of the reviewed PNGs: each frame is scaled
to 1280 pixels wide, shown for about three seconds, and encoded with a
per-frame palette so interface text stays sharp.

README screenshots are separate from the in-app training frames and PDF/video
build pipeline; see [training publication](../TRAINING.md) before changing
those assets. The narrated product walkthrough lives on
[ApertureChat.com](https://aperturechat.com/#demoPanel); its source recordings
are maintained in the
[ApertureChat-Website](https://github.com/Aperture-Chat/ApertureChat-Website)
repository, and `apps/web/scripts/generate-readme-tour.cjs` can still transcode
them when a README copy of that walkthrough is wanted.
