import { readableModules, writableModules } from "./domain.js";

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");

export const postgresSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS documents (
    module text PRIMARY KEY CHECK (module IN (${sqlList(readableModules)})),
    canonical_path text NOT NULL,
    content text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    updated_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS revisions (
    id uuid PRIMARY KEY,
    module text NOT NULL CHECK (module IN (${sqlList(writableModules)})),
    previous_content text NOT NULL,
    previous_version integer NOT NULL CHECK (previous_version > 0),
    reason text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS action_log (
    id uuid PRIMARY KEY,
    action text NOT NULL,
    status text NOT NULL,
    summary text NOT NULL,
    created_at timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id uuid PRIMARY KEY,
    action text NOT NULL,
    status text NOT NULL,
    requested_at timestamptz NOT NULL,
    decided_at timestamptz
  )`,
];

