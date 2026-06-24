import { describe, expect, it } from "vitest";

import { goldenPrompts } from "./fixtures.js";

const readOnlyTools = new Set([
  "operator_get_current",
  "operator_get_context",
  "operator_get_progress",
]);
const writeTools = new Set([
  "operator_save_update",
  "operator_create_task",
  "operator_undo_memory",
]);

describe("mobile golden prompts", () => {
  it("covers the five initial real-world scenarios", () => {
    expect(goldenPrompts).toHaveLength(5);
  });

  it.each(goldenPrompts)(
    "$prompt",
    ({ expectedTools, allowsWrite }) => {
      for (const tool of expectedTools) {
        expect(readOnlyTools.has(tool) || writeTools.has(tool)).toBe(true);
        if (!allowsWrite) {
          expect(writeTools.has(tool)).toBe(false);
        }
      }
    },
  );
});
