import { expect, test } from "vitest";
import {
  folderProblems,
  foldersInDocuments,
  pathWithinFolder,
  groupFolderFiles,
  isHiddenOrSystemName,
  planFolderSync,
  relativeFolderPath,
  folderSyncSummary,
  type LocalFolderFile,
} from "./folderFiles";
import type { KnowledgeDocument, KnowledgeFolderManifest } from "./types";

function local(path: string, size = 10, lastModified = 1000): LocalFolderFile {
  const name = path.split("/").pop() ?? path;
  const file = new File(["x".repeat(size)], name, { lastModified });
  return { path, file };
}

const accept = (file: File) => (file.name.endsWith(".exe") ? "unsupported type" : null);

test("relative paths drop the leading slash and use forward slashes", () => {
  expect(relativeFolderPath("/Matter 12/Pleadings/brief.pdf")).toBe("Matter 12/Pleadings/brief.pdf");
  expect(relativeFolderPath("Matter 12\\brief.pdf")).toBe("Matter 12/brief.pdf");
});

test("hidden and system files are recognised", () => {
  expect(isHiddenOrSystemName(".DS_Store")).toBe(true);
  expect(isHiddenOrSystemName(".git")).toBe(true);
  expect(isHiddenOrSystemName("~$brief.docx")).toBe(true);
  expect(isHiddenOrSystemName("Thumbs.db")).toBe(true);
  expect(isHiddenOrSystemName("desktop.ini")).toBe(true);
  expect(isHiddenOrSystemName("brief.docx")).toBe(false);
});

test("files group under the folder they were chosen from", () => {
  const groups = groupFolderFiles([local("Beta/a.txt"), local("Alpha/x/b.txt"), local("Alpha/c.txt")]);
  expect(groups.map((group) => [group.name, group.files.map((item) => item.path)])).toEqual([
    ["Alpha", ["Alpha/x/b.txt", "Alpha/c.txt"]],
    ["Beta", ["Beta/a.txt"]],
  ]);
});

test("a first upload sends every readable file in path order", () => {
  const plan = planFolderSync([local("A/z.txt"), local("A/b.txt"), local("A/tool.exe")], undefined, accept);
  expect(plan.uploads.map((item) => [item.path, item.change])).toEqual([
    ["A/b.txt", "new"],
    ["A/z.txt", "new"],
  ]);
  expect(plan.skipped).toEqual([{ path: "A/tool.exe", reason: "unsupported type" }]);
  expect(plan.unchanged).toBe(0);
  expect(plan.keptOut).toBe(0);
});

test("a sync sends only new and changed files and keeps removed ones out", () => {
  const manifest: KnowledgeFolderManifest = {
    name: "A",
    files: [
      { path: "A/same.txt", size: 10, modified: 1000, document_id: "doc-1" },
      { path: "A/bigger.txt", size: 10, modified: 1000, document_id: "doc-2" },
      { path: "A/newer.txt", size: 10, modified: 1000, document_id: "doc-3" },
    ],
    removed: ["A/removed.txt"],
  };
  const plan = planFolderSync(
    [
      local("A/same.txt"),
      local("A/bigger.txt", 11),
      local("A/newer.txt", 10, 2000),
      local("A/removed.txt"),
      local("A/added.txt"),
      local("A/.DS_Store"),
      local("A/.git/config"),
    ],
    manifest,
    accept,
  );
  expect(plan.uploads.map((item) => [item.path, item.change])).toEqual([
    ["A/added.txt", "new"],
    ["A/bigger.txt", "changed"],
    ["A/newer.txt", "changed"],
  ]);
  expect(plan.unchanged).toBe(1);
  expect(plan.keptOut).toBe(1);
  expect(plan.skipped).toEqual([]);
});

test("fractional modified times compare as whole milliseconds", () => {
  const manifest: KnowledgeFolderManifest = {
    name: "A",
    files: [{ path: "A/a.txt", size: 10, modified: 1000, document_id: "doc-1" }],
    removed: [],
  };
  const file = local("A/a.txt");
  Object.defineProperty(file.file, "lastModified", { value: 1000.6 });
  expect(planFolderSync([file], manifest, accept).unchanged).toBe(1);
});

function folderDocument(id: string, path: string | null): KnowledgeDocument {
  return {
    id,
    knowledge_config_id: "kb",
    tenant_id: "t",
    name: path?.split("/").pop() ?? id,
    source_uri: "upload://x",
    source_type: "upload",
    status: "indexed",
    chunk_count: 1,
    acl_group_ids: [],
    updated_at: "now",
    citation_required: true,
    folder_file: path ? { path, size: 1, modified: 1 } : null,
  };
}

test("folders in a knowledge base are counted from their documents", () => {
  const documents = [
    folderDocument("d1", "Matter 12/a.txt"),
    folderDocument("d2", "Estate/b.txt"),
    folderDocument("d3", null),
    folderDocument("d4", "Matter 12/sub/c.txt"),
  ];
  expect(foldersInDocuments(documents)).toEqual([
    { name: "Estate", fileCount: 1 },
    { name: "Matter 12", fileCount: 2 },
  ]);
});

test("a sync summary says what happened in plain words", () => {
  const base = { added: 0, updated: 0, unchanged: 0, skipped: [], failed: [], keptOut: 0, stopped: false };
  expect(folderSyncSummary({ ...base, unchanged: 12 })).toBe("Everything was already up to date.");
  expect(folderSyncSummary({ ...base, added: 1 })).toBe("Added 1 new file.");
  expect(folderSyncSummary({ ...base, added: 3, updated: 1, unchanged: 40 })).toBe(
    "Added 3 new files and updated 1. 40 were already up to date.",
  );
  expect(folderSyncSummary({ ...base, updated: 2 })).toBe("Updated 2 files.");
  expect(
    folderSyncSummary({
      ...base,
      added: 1,
      skipped: [{ path: "A/x.exe", reason: "unsupported type" }],
      failed: [{ path: "A/y.pdf", message: "Server error" }],
      keptOut: 2,
    }),
  ).toBe(
    "Added 1 new file. 1 was skipped. 1 could not be added. 2 you removed in Aperture were left out.",
  );
  expect(folderSyncSummary({ ...base, added: 2, stopped: true })).toBe("Stopped. Added 2 new files.");
  expect(folderSyncSummary({ ...base, stopped: true })).toBe("Stopped. No files were added.");
  expect(folderSyncSummary({ ...base, keptOut: 1 })).toBe(
    "Everything was already up to date. 1 you removed in Aperture was left out.",
  );
  expect(folderSyncSummary({ ...base, added: 2, unchanged: 1, skipped: [{ path: "a", reason: "r" }, { path: "b", reason: "r" }] })).toBe(
    "Added 2 new files. 1 was already up to date. 2 were skipped.",
  );
});

test("the up-to-date count shows beside any change, however small", () => {
  const base = { added: 0, updated: 0, unchanged: 0, skipped: [], failed: [], keptOut: 0, stopped: false };
  expect(folderSyncSummary({ ...base, added: 1, updated: 1, unchanged: 2 })).toBe(
    "Added 1 new file and updated 1. 2 were already up to date.",
  );
  expect(folderSyncSummary({ ...base, added: 1, unchanged: 3 })).toBe("Added 1 new file. 3 were already up to date.");
});

test("files a sync could not add are named with their reason", () => {
  const base = { added: 0, updated: 0, unchanged: 0, skipped: [], failed: [], keptOut: 0, stopped: false };
  expect(folderProblems(base)).toBe("");
  expect(
    folderProblems({
      ...base,
      skipped: [{ path: "Matter 12/tools/setup.exe", reason: "unsupported type" }],
      failed: [{ path: "Matter 12/brief.pdf", message: "Server error" }],
    }),
  ).toBe("Not added: tools/setup.exe (unsupported type), brief.pdf (Server error).");
  const many = Array.from({ length: 5 }, (_, index) => ({ path: `M/${index}.exe`, reason: "unsupported type" }));
  expect(folderProblems({ ...base, skipped: many })).toBe(
    "Not added: 0.exe (unsupported type), 1.exe (unsupported type), 2.exe (unsupported type), and 2 more.",
  );
  expect(folderProblems({ ...base, skipped: many.slice(0, 4) })).toBe(
    "Not added: 0.exe (unsupported type), 1.exe (unsupported type), 2.exe (unsupported type), and 1 more.",
  );
  expect(folderProblems({ ...base, skipped: many.slice(0, 3) })).toBe(
    "Not added: 0.exe (unsupported type), 1.exe (unsupported type), 2.exe (unsupported type).",
  );
});

test("a path within its folder drops only the folder's own name", () => {
  expect(pathWithinFolder("Matter 12/Pleadings/brief.pdf")).toBe("Pleadings/brief.pdf");
  expect(pathWithinFolder("Matter 12/brief.pdf")).toBe("brief.pdf");
});
