/* Build the README's self-contained animated screenshot tour.
 * Run only after reviewing the final synthetic training captures:
 *   node apps/web/scripts/generate-readme-tour.cjs --reviewed-captures
 * The animation moves between captured states; it never fabricates typing,
 * provider responses, tool execution, usage counters, or connection results.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO = path.resolve(__dirname, "../../..");
const PUBLIC = path.resolve(__dirname, "../public");
const SECONDS = 75;
const SCENES = [
  ["user/chat-home.png", "YOUR WORKSPACE", "Choose a model. Start a conversation."],
  ["user/chat-response-actions.png", "CHAT", "Review the reply and choose your next step."],
  ["user/chat-trace-expanded.png", "WORK TRACE", "Inspect what happened behind the answer."],
  ["user/chat-images.png", "IMAGES", "Create with an image-capable model."],
  ["user/chat-session-panel.png", "SESSION DETAILS", "Understand context and reported usage."],
  ["user/drafts.png", "DRAFTS", "Develop the answer into a document."],
  ["user/deck-ai-applied.png", "SLIDE DECKS", "Build slides and refine their visuals."],
  ["user/agents.png", "AGENTS", "Keep purpose-built instructions together."],
  ["user/knowledge.png", "KNOWLEDGE", "Find and reference your available sources."],
  ["user/account-security-overview.png", "YOUR ACCOUNT", "Manage sign-in and recovery settings."],
  ["user/mobile-navigation.png", "MOBILE", "Keep the workspace close at hand."],
  ["user/help-library.png", "GUIDED LEARNING", "Follow the walkthroughs at your own pace."],
  ["admin/users.png", "WORKSPACE ADMINISTRATION", "Manage people and their access."],
  ["owner/providers.png", "PLATFORM OPERATIONS", "Connect providers and review readiness."],
  ["owner/policies-callout-current.png", "SHARED CONNECTIONS", "Your models. Your keys. Your workspace."],
];
const xml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function buildTour({ reviewed = false } = {}) {
  if (!reviewed) throw new Error("Review every synthetic capture, then pass --reviewed-captures.");
  const evidence = [];
  const sceneDuration = SECONDS / SCENES.length;
  const scenes = SCENES.map(([frame, label, caption], index) => {
    const png = fs.readFileSync(path.join(PUBLIC, "training", frame));
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Missing PNG capture: ${frame}`);
    }
    evidence.push({ frame, sha256: crypto.createHash("sha256").update(png).digest("hex"), label, caption });
    const end = (100 / SCENES.length).toFixed(5);
    // Every scene owns one five-second interval, with a short fade at either
    // edge. The first image remains the fallback for reduced-motion readers.
    return `<style>@keyframes scene${index}{0%,${(Number(end) - 0.45).toFixed(5)}%{opacity:1}${end}%,100%{opacity:0}}.s${index}{animation:scene${index} ${SECONDS}s linear ${index * sceneDuration}s infinite;opacity:${index === 0 ? 1 : 0}}</style>
<g class="scene s${index}"><rect x="28" y="78" width="1544" height="780" rx="16" fill="#0b171d"/>
<image x="28" y="78" width="1544" height="780" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${png.toString("base64")}"/>
<text x="50" y="898" font-size="13" letter-spacing="2.2" font-weight="700" fill="#70d2d9">${xml(label)}</text>
<text x="50" y="934" font-size="26" font-weight="600" fill="#f2f7f8">${xml(caption)}</text>
<text x="1548" y="934" text-anchor="end" font-size="14" fill="#91a6af">${String(index + 1).padStart(2, "0")} / ${SCENES.length}</text></g>`;
  }).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 980" width="1600" height="980" role="img" aria-labelledby="tourTitle tourDesc">
<title id="tourTitle">Aperture Chat — a 75-second tour of the current interface</title>
<desc id="tourDesc">An animated sequence of actual captures from a synthetic workspace: chat, runtime trace, a generated image, session details, Drafts, a slide deck, agents, knowledge, account security, mobile navigation, help, administration, providers, and shared connectors. Screens are captured states, not a real-time recording.</desc>
<rect width="1600" height="980" rx="22" fill="#06141c"/>
<text x="42" y="47" font-family="Arial,sans-serif" font-size="24" font-weight="700" fill="#f2f7f8">Aperture Chat</text>
<text x="1556" y="45" text-anchor="end" font-family="Arial,sans-serif" font-size="13" letter-spacing="1.4" fill="#91a6af">ACTUAL INTERFACE · SYNTHETIC WORKSPACE</text>
<g font-family="Arial,sans-serif">${scenes}</g>
<style>@media(prefers-reduced-motion:reduce){.scene{animation:none!important;opacity:0!important}.s0{opacity:1!important}}</style>
</svg>\n`;
  const out = path.join(REPO, "docs/images/sizzle-reel.svg");
  fs.writeFileSync(out, svg);
  const evidenceDir = path.join(REPO, "tmp/training-captures");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "readme-tour-build.json"), JSON.stringify({ seconds: SECONDS, scenes: evidence }, null, 2));
  return { frames: SCENES.length, seconds: SECONDS, bytes: Buffer.byteLength(svg) };
}

module.exports = { buildTour, SCENES };
if (require.main === module) {
  try {
    const result = buildTour({ reviewed: process.argv.includes("--reviewed-captures") });
    console.log(`Built ${result.frames} captured scenes, ${result.seconds} seconds, ${result.bytes} bytes.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
