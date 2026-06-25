import { describe, expect, it } from "vitest";

import {
  createSeedDocuments,
  InMemoryMemoryRepository,
  InMemoryTaskRepository,
} from "../src/in-memory-adapters.js";
import { OperatorService } from "../src/operator-service.js";

const createService = () =>
  new OperatorService(
    new InMemoryMemoryRepository(createSeedDocuments()),
    new InMemoryTaskRepository(),
  );

describe("OperatorService memory safety", () => {
  it("returns a safe mobile current context instead of a technical placeholder", async () => {
    const service = createService();

    const current = await service.getCurrent();
    const progress = await service.getProgress();

    expect(current.focus).toContain("Safe mobile context");
    expect(current.focus).toContain("read-only, no-auth bootstrap");
    expect(current.focus).not.toContain("loaded from NOW.md in the real deployment");
    expect(progress.waiting).toContain(
      "Todoist sync is not connected in the no-auth MVP. Personal tasks stay in Todoist until OAuth is added.",
    );
  });

  it("creates a revision and can undo the immediately following change", async () => {
    const service = createService();
    const before = await service.getContext("projects");

    const saved = await service.saveUpdate({
      module: "projects",
      expectedVersion: before.version,
      nextContent: `${before.content}\nMobile capture idea.`,
      reason: "Golden prompt capture",
    });

    expect(saved.document.version).toBe(before.version + 1);
    expect(saved.document.content).toContain("Mobile capture idea");

    const restored = await service.undoMemory(saved.revision.id);
    expect(restored.content).toBe(before.content);
    expect(restored.version).toBe(before.version + 2);
  });

  it("rejects stale writes instead of silently overwriting memory", async () => {
    const service = createService();
    const before = await service.getContext("projects");

    await service.saveUpdate({
      module: "projects",
      expectedVersion: before.version,
      nextContent: "First update",
      reason: "First writer",
    });

    await expect(
      service.saveUpdate({
        module: "projects",
        expectedVersion: before.version,
        nextContent: "Stale update",
        reason: "Stale writer",
      }),
    ).rejects.toThrow("Version conflict");
  });

  it("keeps concrete actions in the task repository", async () => {
    const service = createService();

    const task = await service.createTask({
      title: "Написать Тони и уточнить время встречи",
      due: "2026-06-25",
      priority: "p2",
      project: "Личные действия",
    });
    const progress = await service.getProgress();

    expect(task.id).toBeTruthy();
    expect(progress.active).toContain(task.title);
  });
});
