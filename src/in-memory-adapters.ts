import { randomUUID } from "node:crypto";

import type {
  CreatedTask,
  MemoryDocument,
  MemoryRepository,
  MemoryRevision,
  ProgressSnapshot,
  ReadableModule,
  TaskDraft,
  TaskRepository,
  WritableModule,
} from "./domain.js";

const now = () => new Date().toISOString();

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly documents = new Map<ReadableModule, MemoryDocument>();
  private readonly revisions = new Map<string, MemoryRevision>();

  constructor(seed: MemoryDocument[]) {
    for (const document of seed) {
      this.documents.set(document.module, structuredClone(document));
    }
  }

  async get(module: ReadableModule): Promise<MemoryDocument> {
    const document = this.documents.get(module);
    if (!document) {
      throw new Error(`Memory module not found: ${module}`);
    }

    return structuredClone(document);
  }

  async save(input: {
    module: WritableModule;
    expectedVersion: number;
    nextContent: string;
    reason: string;
  }): Promise<{ document: MemoryDocument; revision: MemoryRevision }> {
    const current = await this.get(input.module);
    if (current.version !== input.expectedVersion) {
      throw new Error(
        `Version conflict for ${input.module}: expected ${input.expectedVersion}, current ${current.version}`,
      );
    }

    const revision: MemoryRevision = {
      id: randomUUID(),
      module: input.module,
      previousContent: current.content,
      previousVersion: current.version,
      reason: input.reason,
      createdAt: now(),
    };
    const document: MemoryDocument = {
      ...current,
      content: input.nextContent,
      version: current.version + 1,
      updatedAt: now(),
    };

    this.revisions.set(revision.id, revision);
    this.documents.set(input.module, document);

    return {
      document: structuredClone(document),
      revision: structuredClone(revision),
    };
  }

  async undo(revisionId: string): Promise<MemoryDocument> {
    const revision = this.revisions.get(revisionId);
    if (!revision) {
      throw new Error(`Revision not found: ${revisionId}`);
    }

    const current = await this.get(revision.module);
    if (current.version !== revision.previousVersion + 1) {
      throw new Error(`Cannot undo revision ${revisionId}: the document changed afterwards`);
    }

    const restored: MemoryDocument = {
      ...current,
      content: revision.previousContent,
      version: current.version + 1,
      updatedAt: now(),
    };

    this.documents.set(revision.module, restored);
    this.revisions.delete(revisionId);
    return structuredClone(restored);
  }
}

export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks: CreatedTask[] = [];

  async create(task: TaskDraft): Promise<CreatedTask> {
    const created: CreatedTask = {
      ...task,
      id: randomUUID(),
      createdAt: now(),
    };
    this.tasks.push(created);
    return structuredClone(created);
  }

  async getProgress(): Promise<ProgressSnapshot> {
    return {
      completed: [],
      active: this.tasks.map((task) => task.title),
      waiting:
        this.tasks.length === 0
          ? [
              "Todoist sync is not connected in the no-auth MVP. Personal tasks stay in Todoist until OAuth is added.",
            ]
          : [],
    };
  }
}

export const createSeedDocuments = (): MemoryDocument[] => {
  const updatedAt = now();
  return [
    {
      module: "current",
      canonicalPath: "00-Inbox/NOW.md",
      content: [
        "Safe mobile context for Personal AI Operator.",
        "",
        "Mode: read-only, no-auth bootstrap. This deployment does not expose Olga's local Markdown files, Todoist tasks, health details, therapy notes, or private trip details.",
        "",
        "Current focus:",
        "- Keep the mobile ChatGPT connector working from phone while the Mac is off.",
        "- Continue the Ukraine trip with local Todoist as the canonical task list.",
        "- Keep Personal AI Operator, AI learning, AI Radar, and AI Club as active directions.",
        "",
        "Why details are limited: real obligations and task statuses require OAuth before they can be safely exposed to a public remote MCP endpoint.",
        "",
        "Next technical step: add OAuth/Auth0, then connect a narrow read-only Todoist and Markdown context.",
      ].join("\n"),
      version: 1,
      updatedAt,
    },
    {
      module: "system",
      canonicalPath: "PROJECT.md",
      content: "Personal AI Operator: Markdown memory, System HQ, Todoist actions.",
      version: 1,
      updatedAt,
    },
    {
      module: "profile",
      canonicalPath: "01-Profile/profile.md",
      content: "Olga prefers short, direct, warm answers with one next step.",
      version: 1,
      updatedAt,
    },
    {
      module: "languages",
      canonicalPath: "03-Languages/languages.md",
      content: "English Tutor and practical Bulgarian translations are available on request.",
      version: 1,
      updatedAt,
    },
    {
      module: "blog",
      canonicalPath: "04-Content-Blog/blog.md",
      content: "Blog drafts start from a live thought or experience, not a content quota.",
      version: 1,
      updatedAt,
    },
    {
      module: "projects",
      canonicalPath: "05-Projects/projects.md",
      content: [
        "Active safe directions:",
        "- Personal AI Operator mobile MVP.",
        "- AI learning and AI Club.",
        "- AI Radar as a source for useful engineering signals.",
        "- Current trips, tracked concretely in Todoist and local Markdown, not exposed through no-auth cloud mode.",
      ].join("\n"),
      version: 1,
      updatedAt,
    },
    {
      module: "subscriptions",
      canonicalPath: "06-Subscriptions-Tools/subscriptions.md",
      content: "Subscriptions are reviewed only when a concrete decision is needed.",
      version: 1,
      updatedAt,
    },
  ];
};
