const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseDeck } = require("./training-catalog.cjs");

test("caption-only lessons own their narration and receive a distinct output path", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/components/trainingDecks/user.tsx"), "utf8");
  const lessons = parseDeck(source, "user");
  const scheduled = lessons.find((lesson) => lesson.id === "scheduled-automations");
  const preview = lessons.find((lesson) => lesson.id === "chat-previews");
  assert.equal(scheduled.scenes.length, 4);
  assert.equal(preview.scenes.length, 1);
  assert.equal(preview.audio_src, "training/user/chat-previews.mp3");
  assert.ok(!scheduled.scenes.some((scene) => scene.narration.includes("Pause over any chat name")));
});

test("escaped narration, alternate property order, and Unicode offsets remain exact", () => {
  const source = `const USER_TRAINING_VIDEOS = [{ id: "example", title: "Example 😀", scenes: [{ durationSeconds: 7, title: "Scene", narration: "Choose \\"Save\\".\\nNext step.", focus: "save" }] }];`;
  const [lesson] = parseDeck(source, "user");
  assert.equal(lesson.audio_missing, true);
  assert.equal(lesson.scenes[0].narration, 'Choose "Save".\nNext step.');
  const [start, end] = lesson.scenes[0].span;
  assert.equal(Array.from(source).slice(start, end).join(""), "7");
  assert.equal(Array.from(source).slice(lesson.audio_insert, lesson.audio_insert + 5).join(""), "title");
});

test("duplicate ids and non-literal durations fail before synthesis", () => {
  assert.throws(() => parseDeck('const USER_TRAINING_VIDEOS = [{ id: "bad", title: "Bad", scenes: [{durationSeconds: seconds}] }]', "user"), /Invalid scene duration/);
  assert.throws(() => parseDeck('const USER_TRAINING_VIDEOS = [{ id: "../bad", title: "Bad" }]', "user"), /Invalid or duplicate/);
});

test("draft lessons and regions require explicit inclusion and retain exact source offsets", () => {
  const source = `
    const FOCUS_REGIONS = { live: { frame: "training/user/live.png" } };
    const PENDING_USER_FOCUS_REGIONS = { pending: { frame: "training/user/pending.png" } };
    const USER_TRAINING_VIDEOS = [{ id: "live", title: "Live", scenes: [{ title: "Live", narration: "Live text", durationSeconds: 7, focus: "live" }] }];
    const PENDING_USER_TRAINING_VIDEOS = [{ id: "pending", title: "Pending 😀", scenes: [{ title: "Draft", narration: "Draft text", durationSeconds: 12, focus: "pending" }] }];
  `;
  assert.deepEqual(parseDeck(source, "user").map((lesson) => lesson.id), ["live"]);
  const lessons = parseDeck(source, "user", { includeDrafts: true });
  assert.deepEqual(lessons.map((lesson) => lesson.publication), ["published", "draft"]);
  assert.equal(lessons[1].scenes[0].frame, "training/user/pending.png");
  const [start, end] = lessons[1].scenes[0].span;
  assert.equal(Array.from(source).slice(start, end).join(""), "12");
  assert.throws(() => parseDeck(source.replace('id: "pending"', 'id: "live"'), "user", { includeDrafts: true }), /duplicate/);
});
