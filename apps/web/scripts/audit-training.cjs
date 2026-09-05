/* Read-only training inventory. --check fails when media, narration timing,
 * focus frames, or the two distribution copies of a PDF are incomplete. */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseDeck } = require("./training-catalog.cjs");
const { sectionsForRole } = require("./guide-pdfs/content.cjs");
const { FRAME_ALIASES } = require("./training-frame-aliases.cjs");
const webRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webRoot, "../..");
const publicRoot = path.join(webRoot, "public");
const issues = [];
const draftIssues = [];
const includeDrafts = process.argv.includes("--include-drafts");
let ffprobeAvailable = true;
try { execFileSync("ffprobe", ["-version"], { stdio: "ignore" }); } catch { ffprobeAvailable = false; }
if (!ffprobeAvailable) issues.push("ffprobe is unavailable; audio durations cannot be verified.");

const roles = ["user", "admin", "owner"].map((role) => {
  const captureScripts = { user: ["training", "deck"], admin: ["admin", "admin-analytics"], owner: ["owner"] }[role];
  if (["user", "admin"].includes(role)) captureScripts.push(`${role}-support`, "auth-onboarding");
  if (role === "admin") captureScripts.push("admin-sso-readonly");
  if (role === "owner") captureScripts.push("first-owner");
  const captureSource = captureScripts.map((name) => fs.readFileSync(path.join(__dirname, `capture-${name}-frames.cjs`), "utf8")).join("\n");
  const extraSource = role === "user" ? fs.readFileSync(path.join(__dirname, "capture-report-submission.cjs"), "utf8")
    : role === "owner" ? fs.readFileSync(path.join(__dirname, "capture-owner-provider-readiness.cjs"), "utf8") : "";
  const captureFrames = new Set([...`${captureSource}\n${extraSource}`.matchAll(/await shot\((?:\w+,\s*)?"([a-z0-9-]+)"/g)].map((match) => `training/${role}/${match[1]}.png`));
  const sourcePath = path.join(webRoot, "src/components/trainingDecks", `${role}.tsx`);
  const lessons = parseDeck(fs.readFileSync(sourcePath, "utf8"), role, { includeDrafts });
  for (const lesson of lessons) {
    const lessonIssues = lesson.publication === "draft" ? draftIssues : issues;
    lesson.durationSeconds = lesson.scenes.reduce((sum, scene) => sum + scene.duration, 0);
    lesson.frames = [...new Set(lesson.scenes.map((scene) => scene.frame))];
    for (const frame of lesson.frames) {
      if (!frame || !fs.existsSync(path.join(publicRoot, frame))) lessonIssues.push(`${role}/${lesson.id}: missing frame ${frame || "(unmapped)"}`);
      if (frame && !captureFrames.has(frame) && !FRAME_ALIASES[frame]) lessonIssues.push(`${role}/${lesson.id}: no capture step for ${frame}`);
      if (FRAME_ALIASES[frame] && fs.existsSync(path.join(publicRoot, frame))) {
        const origin = path.join(publicRoot, FRAME_ALIASES[frame]);
        if (!fs.existsSync(origin) || !fs.readFileSync(origin).equals(fs.readFileSync(path.join(publicRoot, frame)))) {
          lessonIssues.push(`${role}/${lesson.id}: onboarding view differs from its reviewed source ${FRAME_ALIASES[frame]}`);
        }
      }
    }
    const audioPath = path.join(publicRoot, lesson.audio_src);
    if (lesson.audio_missing) lessonIssues.push(`${role}/${lesson.id}: narration has no source mapping.`);
    if (!fs.existsSync(audioPath)) lessonIssues.push(`${role}/${lesson.id}: missing audio ${lesson.audio_src}`);
    else if (ffprobeAvailable) {
      try {
        const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath], { encoding: "utf8" }));
        lesson.audioDurationSeconds = Number(seconds.toFixed(3));
        if (!Number.isFinite(seconds) || Math.abs(seconds - lesson.durationSeconds) > 0.3) {
          lessonIssues.push(`${role}/${lesson.id}: ${lesson.durationSeconds}s timeline differs from ${seconds.toFixed(2)}s audio.`);
        }
      } catch {
        lessonIssues.push(`${role}/${lesson.id}: audio could not be decoded.`);
      }
    }
  }
  const pdfName = `aperture-${role}-guide.pdf`;
  const servedPdf = path.join(publicRoot, "docs", pdfName);
  const repoPdf = path.join(repoRoot, "docs", pdfName);
  if (!fs.existsSync(servedPdf) || !fs.existsSync(repoPdf)) issues.push(`${role}: both public/docs and repository docs must contain ${pdfName}.`);
  else if (!fs.readFileSync(servedPdf).equals(fs.readFileSync(repoPdf))) issues.push(`${role}: public and repository PDF copies differ.`);
  return { role, pdfName, guideSections: sectionsForRole(role).map((section) => section.id), lessons };
});

if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ roles, issues, draftIssues }, null, 2)}\n`);
else {
  for (const { role, lessons, guideSections } of roles) {
    console.log(`${role}: ${lessons.length} lessons, ${lessons.reduce((sum, lesson) => sum + lesson.scenes.length, 0)} scenes, ${guideSections.length} guide sections`);
    for (const lesson of lessons) console.log(`  ${lesson.id}: ${lesson.durationSeconds}s, ${lesson.frames.length} frames, ${lesson.audio_missing ? "captions only" : "narration mapped"}${lesson.publication === "draft" ? ", UNPUBLISHED DRAFT" : ""}`);
  }
  for (const issue of issues) console.log(`INCOMPLETE: ${issue}`);
  for (const issue of draftIssues) console.log(`DRAFT PENDING: ${issue}`);
  console.log(issues.length ? `${issues.length} training checks need attention.` : "Training files and audio timelines are consistent. Visual and content review is still required.");
  if (includeDrafts) console.log(`${draftIssues.length} draft checks remain; drafts are excluded from the live playlists.`);
}
if (process.argv.includes("--check") && (issues.length || draftIssues.length)) process.exitCode = 1;
