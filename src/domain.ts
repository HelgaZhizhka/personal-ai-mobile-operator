export const readableModules = [
  "current",
  "system",
  "profile",
  "languages",
  "blog",
  "projects",
  "subscriptions",
] as const;

export const writableModules = [
  "profile",
  "languages",
  "blog",
  "projects",
  "subscriptions",
] as const;

export type ReadableModule = (typeof readableModules)[number];
export type WritableModule = (typeof writableModules)[number];
export type TaskPriority = "p1" | "p2" | "p3" | "p4";

export interface MemoryDocument {
  module: ReadableModule;
  canonicalPath: string;
  content: string;
  version: number;
  updatedAt: string;
}

export interface MemoryRevision {
  id: string;
  module: WritableModule;
  previousContent: string;
  previousVersion: number;
  reason: string;
  createdAt: string;
}

export interface TaskDraft {
  title: string;
  due?: string;
  priority: TaskPriority;
  project?: string;
}

export interface CreatedTask extends TaskDraft {
  id: string;
  createdAt: string;
}

export interface CurrentSnapshot {
  focus: string;
  obligations: string[];
  directions: string[];
}

export interface ProgressSnapshot {
  completed: string[];
  active: string[];
  waiting: string[];
}

export interface MemoryRepository {
  get(module: ReadableModule): Promise<MemoryDocument>;
  save(input: {
    module: WritableModule;
    expectedVersion: number;
    nextContent: string;
    reason: string;
  }): Promise<{ document: MemoryDocument; revision: MemoryRevision }>;
  undo(revisionId: string): Promise<MemoryDocument>;
}

export interface MemoryImportResult {
  imported: ReadableModule[];
  skipped: ReadableModule[];
}

export interface TaskRepository {
  create(task: TaskDraft): Promise<CreatedTask>;
  getProgress(): Promise<ProgressSnapshot>;
}
