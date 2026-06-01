import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeBatch } from "./summarize.js";
import type { WorkflowTask } from "./types.js";

function createTask(overrides: Partial<WorkflowTask>): WorkflowTask {
  const now = new Date().toISOString();
  return {
    id: "task-id",
    goal: "Test goal",
    executor: "mock",
    phase: "completed",
    createdAt: now,
    updatedAt: now,
    workerPrompt: "prompt",
    ...overrides,
  };
}

describe("batch summary", () => {
  it("counts worker result sources", () => {
    const summary = summarizeBatch([
      createTask({
        id: "executor-task",
        workerResult: {
          status: "ok",
          source: "executor",
          stdout: "{}",
          stderr: "",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      }),
      createTask({
        id: "fallback-task",
        workerResult: {
          status: "ok",
          source: "fallback-synthesized",
          stdout: "{}",
          stderr: "",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      }),
      createTask({
        id: "delegated-task",
        phase: "delegated_to_codex",
        workerResult: {
          status: "delegated",
          source: "delegated",
          stdout: "{}",
          stderr: "",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      }),
      createTask({
        id: "unknown-task",
        workerResult: {
          status: "ok",
          stdout: "{}",
          stderr: "",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      }),
    ]);

    assert.deepEqual(summary.resultSources, {
      executor: 1,
      fallbackSynthesized: 1,
      delegated: 1,
      unknown: 1,
    });
  });
});
