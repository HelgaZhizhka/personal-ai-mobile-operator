# Personal AI Mobile Operator

Provider-neutral TypeScript scaffold for the remote Personal AI Operator MCP server.

## Current status

Implemented:

- six narrow MCP tool contracts;
- explicit exclusion of health and therapy modules;
- versioned in-memory Markdown updates with conflict detection and undo;
- PostgreSQL schema and memory repository foundation;
- safe Markdown import from an explicit allowlist;
- in-memory task adapter;
- stateless Streamable HTTP `/mcp` endpoint;
- `/health` endpoint;
- five golden prompts for later ChatGPT connector evaluation.

Not connected yet:

- Todoist;
- Auth0 OAuth 2.1;
- Railway deployment;
- real cloud Markdown synchronization.

By default the server still uses synthetic in-memory seed data and cannot change the canonical project files or Olga's Todoist account. When `DATABASE_URL` is set, it creates PostgreSQL tables and uses the PostgreSQL memory repository. When `MEMORY_ROOT_DIR` is also set, it imports only the explicitly allowed non-sensitive Markdown files if the database does not already contain that module.

For a standalone GitHub deployment, this directory can be pushed as its own private repository. The local `railway.json` runs the app, exposes `/health`, and uses safe bootstrap seed documents when the full Personal AI Operator Markdown root is not present.

## Local verification

```bash
npm run typecheck
npm test
npm run build
npm start
```

The local server listens on `http://127.0.0.1:3000` by default. Cloud deployment must set `HOST=0.0.0.0` and add OAuth before exposing personal data or write tools.

## PostgreSQL verification

Run migrations, import the allowed Markdown memory, and read the current/project modules:

```bash
DATABASE_URL="postgres://..." npm run verify:postgres
```

Run the full save + undo smoke check on a development database only:

```bash
DATABASE_URL="postgres://..." POSTGRES_VERIFY_WRITE=1 npm run verify:postgres
```

Optional:

```bash
MEMORY_ROOT_DIR="/path/to/Personal-AI-Operator"
```

If `MEMORY_ROOT_DIR` is omitted, the app and verification script expect to run from `apps/mobile-operator` and use the project root two directories up.

On Railway standalone deploys, omitting `MEMORY_ROOT_DIR` is safe: if the full Markdown root is not present, the app initializes PostgreSQL from non-sensitive bootstrap seed documents instead of importing personal files.

## Memory import allowlist

The first MVP imports only:

- `00-Inbox/NOW.md`
- `PROJECT.md`
- `01-Profile/profile.md`
- `03-Languages/languages.md`
- `04-Content-Blog/blog.md`
- `05-Projects/projects.md`
- `06-Subscriptions-Tools/subscriptions.md`

It intentionally excludes `02-Health`, `07-Therapy`, secrets, email, Drive, NotebookLM, and Legacy Archive material.
