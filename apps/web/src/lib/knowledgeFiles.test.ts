import { expect, test } from "vitest";
import { knowledgeFileSkipReason } from "./knowledgeFiles";

const file = (name: string, size = 4, type = "") => new File(["x".repeat(size)], name, { type });

test("readable files are accepted", () => {
  expect(knowledgeFileSkipReason(file("brief.pdf"), 250)).toBeNull();
  expect(knowledgeFileSkipReason(file("Brief.DOCX"), 250)).toBeNull();
  expect(knowledgeFileSkipReason(file("call.m4a"), 250)).toBeNull();
  expect(knowledgeFileSkipReason(file(".pdf"), 250)).toBeNull();
});

test("files with a readable type but no known extension are accepted", () => {
  expect(knowledgeFileSkipReason(file("notes", 4, "text/plain"), 250)).toBeNull();
  expect(knowledgeFileSkipReason(file("scan", 4, "image/heic"), 250)).toBeNull();
  expect(knowledgeFileSkipReason(file("memo", 4, "audio/mpeg"), 250)).toBeNull();
  expect(knowledgeFileSkipReason(file("clip", 4, "video/mp4"), 250)).toBeNull();
});

test("old Office files are asked to be saved in the new format", () => {
  expect(knowledgeFileSkipReason(file("old.doc"), 250)).toBe("save it as .docx first");
  expect(knowledgeFileSkipReason(file("old.XLS"), 250)).toBe("save it as .xlsx first");
});

test("unreadable types are named as unsupported", () => {
  expect(knowledgeFileSkipReason(file("setup.exe", 4, "application/octet-stream"), 250)).toBe("unsupported type");
  expect(knowledgeFileSkipReason(file("README"), 250)).toBe("unsupported type");
});

test("files over the limit are refused only when the limit is known", () => {
  const twoMb = file("big.pdf", 2 * 1024 * 1024 + 1);
  expect(knowledgeFileSkipReason(twoMb, 2)).toBe("larger than 2 MB");
  expect(knowledgeFileSkipReason(file("exact.pdf", 2 * 1024 * 1024), 2)).toBeNull();
  expect(knowledgeFileSkipReason(twoMb, null)).toBeNull();
});
