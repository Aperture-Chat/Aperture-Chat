import { expect, test } from "vitest";
import { parseMarkdownBlocks, replaceCodeFence } from "./markdown";

const REPLY = [
  "Here is the script:",
  "",
  '```python title="greet.py"',
  "name = 'Ada'",
  "print(name)",
  "```",
  "",
  "And again:",
  "",
  "```python",
  "name = 'Ada'",
  "print(name)",
  "```",
  "Done.",
].join("\n");

function codeBlocks(content: string) {
  return parseMarkdownBlocks(content).filter((block) => block.kind === "code");
}

test("replaces the matching block's code and keeps its fence, info, and the prose around it", () => {
  const next = replaceCodeFence(REPLY, "name = 'Ada'\nprint(name)", "name = 'Grace'\nprint(name)");
  expect(next).toBe(REPLY.replace("name = 'Ada'", "name = 'Grace'"));
  expect(next).toContain('```python title="greet.py"\nname = \'Grace\'');
});

test("targets a later identical block by its occurrence", () => {
  const next = replaceCodeFence(REPLY, "name = 'Ada'\nprint(name)", "x = 1", 1)!;
  expect(codeBlocks(next).map((block) => block.kind === "code" && block.text)).toEqual(["name = 'Ada'\nprint(name)", "x = 1"]);
  expect(next.endsWith("x = 1\n```\nDone.")).toBe(true);
});

test("returns null when no block holds the code", () => {
  expect(replaceCodeFence(REPLY, "missing()", "x")).toBeNull();
  expect(replaceCodeFence(REPLY, "name = 'Ada'\nprint(name)", "x", 2)).toBeNull();
});

test("closes a reply that ended inside the block", () => {
  expect(replaceCodeFence("Intro\n```js\nlet a = 1;", "let a = 1;", "let a = 2;")).toBe("Intro\n```js\nlet a = 2;\n```");
});

test("lengthens the fence when the new code contains a line that would close it", () => {
  const next = replaceCodeFence("```md\nold\n```\nafter", "old", "Example:\n```\ncode\n```")!;
  expect(next).toBe("````md\nExample:\n```\ncode\n```\n````\nafter");
  expect(codeBlocks(next).map((block) => block.kind === "code" && block.text)).toEqual(["Example:\n```\ncode\n```"]);
});

test("reads Windows line endings like the renderer does", () => {
  expect(replaceCodeFence("```sh\r\necho hi\r\n```", "echo hi", "echo bye")).toBe("```sh\necho bye\n```");
});
