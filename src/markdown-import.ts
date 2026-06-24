import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { MemoryDocument } from "./domain.js";
import { allowedMemoryDocuments } from "./memory-allowlist.js";

const isInsideRoot = (rootDir: string, filePath: string) => {
  const relative = path.relative(rootDir, filePath);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export const loadAllowedMarkdownDocuments = async (
  rootDir: string,
  importedAt = new Date().toISOString(),
): Promise<MemoryDocument[]> => {
  const root = await realpath(rootDir);
  const documents: MemoryDocument[] = [];

  for (const allowed of allowedMemoryDocuments) {
    const requestedPath = path.resolve(root, allowed.canonicalPath);
    const realFilePath = await realpath(requestedPath);

    if (!isInsideRoot(root, realFilePath)) {
      throw new Error(`Refusing to import outside root: ${allowed.canonicalPath}`);
    }

    const fileStat = await stat(realFilePath);
    if (!fileStat.isFile()) {
      throw new Error(`Allowed memory path is not a file: ${allowed.canonicalPath}`);
    }
    if (fileStat.size > allowed.maxBytes) {
      throw new Error(
        `Allowed memory file is too large: ${allowed.canonicalPath} (${fileStat.size} bytes)`,
      );
    }

    documents.push({
      module: allowed.module,
      canonicalPath: allowed.canonicalPath,
      content: await readFile(realFilePath, "utf8"),
      version: 1,
      updatedAt: importedAt,
    });
  }

  return documents;
};

