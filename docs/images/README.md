# README interface captures

The root README uses the PNGs in this directory and the self-contained
`sizzle-reel.svg` generated from them. The screenshots were refreshed on
September 7, 2026 from the current working tree based on v0.5.0; the sign-in
capture also reflects the in-progress sign-in/Help changes in that checkout.
They illustrate the development interface, not a claim that every pixel is in
an already published image.

## Capture content

- `chat-light.png`, `chat-dark.png`: clean workspace before connecting a model.
- `drafts-light.png`, `drafts-dark.png`: manually authored project brief with the compact document toolbar.
- `deck-light.png`, `deck-dark.png`: the brief converted through the real Document/Deck UI, with a manually edited subtitle.
- `agents-dark.png`, `library-dark.png`: current section switches and empty configuration states.
- `chat-mobile.png`: narrow-screen chat composer.
- `sign-in.png`: access requests and the pre-login walkthrough entry point.

The account and document content are synthetic. The capture API used new local
data stores, no production environment configuration, and no model provider.
No provider responses, connection successes, or usage counters were fabricated.
Existing legacy browser history was excluded from screenshots and not imported.

## Refresh procedure

1. Run the current UI against an isolated local API with separate data paths,
   synthetic accounts, and no private production configuration. Use a clean
   browser profile/origin where possible; never clear someone else's history.
2. Capture the real interface in light/dark themes and at a mobile breakpoint.
   Restore only known synthetic documents. Keep any unconfigured-state notices
   visible; do not restyle the product or invent results for the image.
3. Stage captures in an ignored output directory. Review every image for private
   data, credentials, unrelated browser history, transient tooltips, cut-off
   content, and correspondence with the current interface.
4. Replace this directory's named PNGs as one reviewed batch. Update the capture
   date, descriptions, and root README captions when scope changes.
5. Regenerate the tour from the repository root:

   ```bash
   node apps/web/scripts/generate-readme-tour.cjs --reviewed-captures
   ```

6. Preview the root README and SVG, check relative links, and run
   `git diff --check`. The generator records input hashes in an ignored build
   manifest. Its reduced-motion fallback displays the first captured frame.

This tour is a sequence of screenshots, not a video of live execution.
README images are separate from the in-app training frames and PDF/video build
pipeline; see [training publication](../TRAINING.md) before changing those assets.
