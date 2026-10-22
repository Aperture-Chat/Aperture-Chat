/* Retired: the deck editor's training frames are captured by complete
 * walkthrough modules run with capture-walkthroughs.cjs, which perform each
 * task for real on an isolated synthetic instance:
 *
 *   walkthroughs/user-drafts.cjs        user-decks: converting a document,
 *     an outline-built deck and its fit check, the layouts and themes strip,
 *     speaker notes, presenter view, PowerPoint export, a starter template,
 *     and the synthetic brand template in fixtures/brand-template.pptx.
 *   walkthroughs/user-deck-editing.cjs  user-deck-editing: Add a slide,
 *     Change layout, Slide pictures with fixtures/deck-background.jpg, the
 *     slide text toolbar, Edit slide with AI reviewed in the left panel, the
 *     slide background menu, and the deck assistant's fit check.
 *
 *   node apps/web/scripts/capture-walkthroughs.cjs user-decks,user-deck-editing
 *
 * This file is kept so older references resolve; it captures nothing.
 */
console.error("capture-deck-frames.cjs is retired. Run: node apps/web/scripts/capture-walkthroughs.cjs user-decks,user-deck-editing");
process.exitCode = 1;
