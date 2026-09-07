# README interface captures

The root README opens with the light-mode product walkthrough described below.
Its separate interface screenshots were refreshed on
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
5. Preview the root README, check relative links, and run `git diff --check`.

README screenshots are separate from the in-app training frames and PDF/video
build pipeline; see [training publication](../TRAINING.md) before changing those assets.

## Website product walkthrough

The README hero uses the six complete **light-mode v6 recordings** from
[ApertureChat-Website](https://github.com/Aperture-Chat/ApertureChat-Website),
matching the player at [ApertureChat.com](https://aperturechat.com/#demoPanel).
The order is Ask, Research, Draft, Slides, Team, Platform. These are the existing
public product recordings with their real research responses and editorial
pointer cues, not the synthetic no-provider screenshots described above.
The original edit shortens waiting time and intermediate editorial work.

`product-walkthrough-light.gif` transcodes those recordings at 960 pixels wide
and 10 frames per second, retaining the full sequence and timing. Clicking it
opens the website player with chapter selection, playback controls, and fullscreen.
`product-walkthrough-light.png` is the opening-frame fallback for reduced motion
where the README renderer supports the picture media query. GitHub controls
which playback and accessibility features its README renderer permits.

To regenerate with Node.js and FFmpeg installed:

```bash
node apps/web/scripts/generate-readme-tour.cjs --reviewed-captures --source-dir ../ApertureChat-Website
```

Pass a local checkout of the website repository containing the six
`assets/hero/{chat,followup,draft,slides,team,platform}-v6-light.mp4` files.
Review any changed clips for public suitability before rebuilding. The generator
records source and output SHA-256 hashes in `product-walkthrough-manifest.json`;
it does not download media, capture private application state, or alter the website.
