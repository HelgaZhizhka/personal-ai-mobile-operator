import path from "node:path";

import { createAuthConfigFromEnv } from "./auth.js";
import {
  createSeedDocuments,
  InMemoryMemoryRepository,
  InMemoryTaskRepository,
} from "./in-memory-adapters.js";
import { createHttpApp } from "./http-app.js";
import { loadAllowedMarkdownDocuments } from "./markdown-import.js";
import type { MemoryDocument } from "./domain.js";
import { OperatorService } from "./operator-service.js";
import {
  createPgDatabase,
  PostgresMemoryRepository,
  runPostgresMigrations,
} from "./postgres-adapters.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const databaseUrl = process.env.DATABASE_URL;
const memoryRootDir = process.env.MEMORY_ROOT_DIR ?? path.resolve(process.cwd(), "../..");
const writesEnabled = process.env.MOBILE_OPERATOR_ENABLE_WRITES === "1";
const auth = createAuthConfigFromEnv(process.env);
const buildId =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ??
  process.env.APP_BUILD_ID ??
  "noauth-2026-06-25";

const loadBootstrapDocuments = async (): Promise<{
  documents: MemoryDocument[];
  source: "markdown" | "seed";
}> => {
  try {
    return {
      documents: await loadAllowedMarkdownDocuments(memoryRootDir),
      source: "markdown",
    };
  } catch (error) {
    if (process.env.MEMORY_ROOT_DIR) {
      throw error;
    }

    console.warn(
      "Allowed Markdown memory was not found. Falling back to safe bootstrap seed documents.",
    );
    return { documents: createSeedDocuments(), source: "seed" };
  }
};

const database = databaseUrl ? createPgDatabase(databaseUrl) : undefined;
let memory: InMemoryMemoryRepository | PostgresMemoryRepository;

if (database) {
  await runPostgresMigrations(database);
  memory = new PostgresMemoryRepository(database);

  const { documents, source } = await loadBootstrapDocuments();
  const result = await memory.importDocuments(documents);
  console.log(
    `Imported memory documents: ${result.imported.length}, skipped existing: ${result.skipped.length}`,
  );
  if (source === "seed" && !writesEnabled) {
    const refreshed = await memory.refreshSeedDocuments(documents);
    console.log(`Refreshed safe seed documents: ${refreshed.length}`);
  }
} else {
  memory = new InMemoryMemoryRepository(createSeedDocuments());
}

const tasks = new InMemoryTaskRepository();
const service = new OperatorService(memory, tasks);
const app = createHttpApp(service, host, { writesEnabled, buildId, auth });

const listener = app.listen(port, host, () => {
  console.log(`Personal AI Mobile Operator listening on http://${host}:${port}`);
  console.log(`MCP write tools enabled: ${writesEnabled ? "yes" : "no"}`);
  console.log(`MCP auth required: ${auth?.required ? "yes" : "no"}`);
  console.log(`Build id: ${buildId}`);
});

listener.on("error", (error) => {
  console.error("Failed to start mobile operator", error);
  process.exit(1);
});

const shutdown = async () => {
  await database?.close?.();
};

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
