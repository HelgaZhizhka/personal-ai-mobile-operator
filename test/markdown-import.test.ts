import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAllowedMarkdownDocuments } from "../src/markdown-import.js";
import { allowedMemoryDocuments } from "../src/memory-allowlist.js";

const createAllowedTree = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mobile-memory-"));

  for (const document of allowedMemoryDocuments) {
    const filePath = path.join(root, document.canonicalPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `# ${document.module}\nAllowed memory`, "utf8");
  }

  return root;
};

describe("allowed Markdown import", () => {
  it("loads only explicitly allowed memory documents", async () => {
    const root = await createAllowedTree();
    const documents = await loadAllowedMarkdownDocuments(root, "2026-06-24T10:00:00.000Z");

    expect(documents.map((document) => document.module)).toEqual([
      "current",
      "system",
      "profile",
      "languages",
      "blog",
      "projects",
      "subscriptions",
    ]);
    expect(documents.every((document) => document.version === 1)).toBe(true);
    expect(documents.every((document) => document.updatedAt === "2026-06-24T10:00:00.000Z")).toBe(
      true,
    );
  });

  it("does not include health or therapy paths in the MVP allowlist", () => {
    expect(allowedMemoryDocuments.map((document) => document.canonicalPath)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^02-Health\//),
        expect.stringMatching(/^07-Therapy\//),
      ]),
    );
  });
});

