import type {
  CurrentSnapshot,
  MemoryRepository,
  ProgressSnapshot,
  ReadableModule,
  TaskDraft,
  TaskRepository,
  WritableModule,
} from "./domain.js";

export class OperatorService {
  constructor(
    private readonly memory: MemoryRepository,
    private readonly tasks: TaskRepository,
  ) {}

  async getCurrent(): Promise<CurrentSnapshot> {
    const current = await this.memory.get("current");
    const projects = await this.memory.get("projects");
    return {
      focus: current.content,
      obligations: [],
      directions: [projects.content],
    };
  }

  getContext(module: ReadableModule) {
    return this.memory.get(module);
  }

  getProgress(): Promise<ProgressSnapshot> {
    return this.tasks.getProgress();
  }

  saveUpdate(input: {
    module: WritableModule;
    expectedVersion: number;
    nextContent: string;
    reason: string;
  }) {
    return this.memory.save(input);
  }

  createTask(task: TaskDraft) {
    return this.tasks.create(task);
  }

  undoMemory(revisionId: string) {
    return this.memory.undo(revisionId);
  }
}
