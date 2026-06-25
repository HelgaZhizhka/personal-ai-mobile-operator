import { randomUUID } from "node:crypto";

import { Pool, type QueryResultRow } from "pg";

import type {
  MemoryDocument,
  MemoryImportResult,
  MemoryRepository,
  MemoryRevision,
  ReadableModule,
  WritableModule,
} from "./domain.js";
import { readableModules, writableModules } from "./domain.js";
import { postgresSchemaStatements } from "./postgres-schema.js";

interface QueryResult<T extends QueryResultRow> {
  rows: T[];
  rowCount: number | null;
}

export interface SqlExecutor {
  query<T extends QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface SqlDatabase extends SqlExecutor {
  transaction<T>(callback: (client: SqlExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export class PgDatabase implements SqlDatabase {
  constructor(private readonly pool: Pool) {}

  query<T extends QueryResultRow>(sql: string, params?: unknown[]) {
    return this.pool.query<T>(sql, params);
  }

  async transaction<T>(callback: (client: SqlExecutor) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}

interface DocumentRow extends QueryResultRow {
  module: string;
  canonical_path: string;
  content: string;
  version: number;
  updated_at: Date | string;
}

interface RevisionRow extends QueryResultRow {
  id: string;
  module: string;
  previous_content: string;
  previous_version: number;
  reason: string;
  created_at: Date | string;
}

const now = () => new Date().toISOString();

const parseReadableModule = (module: string): ReadableModule => {
  if (readableModules.includes(module as ReadableModule)) {
    return module as ReadableModule;
  }
  throw new Error(`Unknown readable module from database: ${module}`);
};

const parseWritableModule = (module: string): WritableModule => {
  if (writableModules.includes(module as WritableModule)) {
    return module as WritableModule;
  }
  throw new Error(`Unknown writable module from database: ${module}`);
};

const toIso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toDocument = (row: DocumentRow): MemoryDocument => ({
  module: parseReadableModule(row.module),
  canonicalPath: row.canonical_path,
  content: row.content,
  version: row.version,
  updatedAt: toIso(row.updated_at),
});

const toRevision = (row: RevisionRow): MemoryRevision => ({
  id: row.id,
  module: parseWritableModule(row.module),
  previousContent: row.previous_content,
  previousVersion: row.previous_version,
  reason: row.reason,
  createdAt: toIso(row.created_at),
});

export const createPgDatabase = (connectionString: string) =>
  new PgDatabase(
    new Pool({
      connectionString,
      max: 5,
    }),
  );

export const runPostgresMigrations = async (db: SqlExecutor) => {
  for (const statement of postgresSchemaStatements) {
    await db.query(statement);
  }
};

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly db: SqlDatabase) {}

  async get(module: ReadableModule): Promise<MemoryDocument> {
    return this.getWithExecutor(this.db, module);
  }

  async importDocuments(documents: MemoryDocument[]): Promise<MemoryImportResult> {
    const imported: ReadableModule[] = [];
    const skipped: ReadableModule[] = [];

    for (const document of documents) {
      const result = await this.db.query<{ module: string }>(
        `INSERT INTO documents (module, canonical_path, content, version, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (module) DO NOTHING
         RETURNING module`,
        [
          document.module,
          document.canonicalPath,
          document.content,
          document.version,
          document.updatedAt,
        ],
      );

      if (result.rows.length > 0) {
        imported.push(document.module);
      } else {
        skipped.push(document.module);
      }
    }

    return { imported, skipped };
  }

  async refreshSeedDocuments(documents: MemoryDocument[]): Promise<ReadableModule[]> {
    const updated: ReadableModule[] = [];

    for (const document of documents) {
      const result = await this.db.query<{ module: string }>(
        `UPDATE documents
         SET canonical_path = $2, content = $3, version = version + 1, updated_at = $4
         WHERE module = $1
           AND (canonical_path <> $2 OR content <> $3)
         RETURNING module`,
        [
          document.module,
          document.canonicalPath,
          document.content,
          document.updatedAt,
        ],
      );

      if (result.rows.length > 0) {
        updated.push(parseReadableModule(result.rows[0].module));
      }
    }

    return updated;
  }

  async save(input: {
    module: WritableModule;
    expectedVersion: number;
    nextContent: string;
    reason: string;
  }): Promise<{ document: MemoryDocument; revision: MemoryRevision }> {
    return this.db.transaction(async (client) => {
      const current = await this.getLocked(client, input.module);
      if (current.version !== input.expectedVersion) {
        throw new Error(
          `Version conflict for ${input.module}: expected ${input.expectedVersion}, current ${current.version}`,
        );
      }

      const createdAt = now();
      const revision: MemoryRevision = {
        id: randomUUID(),
        module: input.module,
        previousContent: current.content,
        previousVersion: current.version,
        reason: input.reason,
        createdAt,
      };

      await client.query(
        `INSERT INTO revisions
           (id, module, previous_content, previous_version, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          revision.id,
          revision.module,
          revision.previousContent,
          revision.previousVersion,
          revision.reason,
          revision.createdAt,
        ],
      );

      const updated = await client.query<DocumentRow>(
        `UPDATE documents
         SET content = $1, version = version + 1, updated_at = $2
         WHERE module = $3
         RETURNING module, canonical_path, content, version, updated_at`,
        [input.nextContent, now(), input.module],
      );

      const document = updated.rows[0];
      if (!document) {
        throw new Error(`Memory module not found after update: ${input.module}`);
      }

      return { document: toDocument(document), revision };
    });
  }

  async undo(revisionId: string): Promise<MemoryDocument> {
    return this.db.transaction(async (client) => {
      const revisionResult = await client.query<RevisionRow>(
        `SELECT id, module, previous_content, previous_version, reason, created_at
         FROM revisions
         WHERE id = $1`,
        [revisionId],
      );
      const revisionRow = revisionResult.rows[0];
      if (!revisionRow) {
        throw new Error(`Revision not found: ${revisionId}`);
      }

      const revision = toRevision(revisionRow);
      const current = await this.getLocked(client, revision.module);
      if (current.version !== revision.previousVersion + 1) {
        throw new Error(`Cannot undo revision ${revisionId}: the document changed afterwards`);
      }

      const restored = await client.query<DocumentRow>(
        `UPDATE documents
         SET content = $1, version = version + 1, updated_at = $2
         WHERE module = $3
         RETURNING module, canonical_path, content, version, updated_at`,
        [revision.previousContent, now(), revision.module],
      );

      await client.query("DELETE FROM revisions WHERE id = $1", [revisionId]);

      const document = restored.rows[0];
      if (!document) {
        throw new Error(`Memory module not found after undo: ${revision.module}`);
      }

      return toDocument(document);
    });
  }

  private async getWithExecutor(
    executor: SqlExecutor,
    module: ReadableModule,
  ): Promise<MemoryDocument> {
    const result = await executor.query<DocumentRow>(
      `SELECT module, canonical_path, content, version, updated_at
       FROM documents
       WHERE module = $1`,
      [module],
    );
    const document = result.rows[0];
    if (!document) {
      throw new Error(`Memory module not found: ${module}`);
    }

    return toDocument(document);
  }

  private async getLocked(
    executor: SqlExecutor,
    module: ReadableModule,
  ): Promise<MemoryDocument> {
    const result = await executor.query<DocumentRow>(
      `SELECT module, canonical_path, content, version, updated_at
       FROM documents
       WHERE module = $1
       FOR UPDATE`,
      [module],
    );
    const document = result.rows[0];
    if (!document) {
      throw new Error(`Memory module not found: ${module}`);
    }

    return toDocument(document);
  }
}
