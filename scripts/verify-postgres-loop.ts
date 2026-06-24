import { stat } from "node:fs/promises";
import path from "node:path";

import { loadAllowedMarkdownDocuments } from "../src/markdown-import.js";
import {
  createPgDatabase,
  PostgresMemoryRepository,
  runPostgresMigrations,
} from "../src/postgres-adapters.js";

const databaseUrl = process.env.DATABASE_URL;
const writeSmokeEnabled = process.env.POSTGRES_VERIFY_WRITE === "1";
const memoryRootDir = path.resolve(
  process.env.MEMORY_ROOT_DIR ?? path.join(process.cwd(), "../.."),
);

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for npm run verify:postgres.");
}

const assertMemoryRoot = async () => {
  const projectFile = path.join(memoryRootDir, "PROJECT.md");
  const projectFileStat = await stat(projectFile);
  if (!projectFileStat.isFile()) {
    throw new Error(`MEMORY_ROOT_DIR does not look like Personal AI Operator: ${memoryRootDir}`);
  }
};

const main = async () => {
  await assertMemoryRoot();

  const database = createPgDatabase(databaseUrl);
  try {
    await runPostgresMigrations(database);

    const memory = new PostgresMemoryRepository(database);
    const documents = await loadAllowedMarkdownDocuments(memoryRootDir);
    const importResult = await memory.importDocuments(documents);
    const current = await memory.get("current");
    const projects = await memory.get("projects");

    console.log("Postgres migrations: ok");
    console.log(
      `Markdown import: imported ${importResult.imported.length}, skipped ${importResult.skipped.length}`,
    );
    console.log(`Read check: current v${current.version}, projects v${projects.version}`);

    if (!writeSmokeEnabled) {
      console.log("Write smoke: skipped. Set POSTGRES_VERIFY_WRITE=1 to test save + undo.");
      return;
    }

    const marker = `\n\n<!-- postgres-smoke:${new Date().toISOString()} -->`;
    const saved = await memory.save({
      module: "projects",
      expectedVersion: projects.version,
      nextContent: `${projects.content}${marker}`,
      reason: "Postgres smoke test",
    });
    const restored = await memory.undo(saved.revision.id);

    if (restored.content !== projects.content) {
      throw new Error("Postgres smoke failed: undo did not restore previous content.");
    }

    console.log(
      `Write smoke: ok, projects restored as version ${restored.version}. Content unchanged.`,
    );
  } finally {
    await database.close();
  }
};

await main();

