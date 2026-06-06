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
        id: "salvaged-task",
        workerResult: {
          status: "ok",
          source: "executor-salvaged",
          stdout: "Summary: salvaged",
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
      executorSalvaged: 1,
      fallbackSynthesized: 1,
      delegated: 1,
      unknown: 1,
    });
  });

  it("reports blocked count and skips deployment nextStep when blocked tasks exist", () => {
    const summary = summarizeBatch([
      createTask({
        id: "completed-ok",
        phase: "completed",
        workerResult: {
          status: "ok",
          source: "executor",
          stdout: JSON.stringify({ summary: "done", changes: "yes", risks: "none", status: "ok" }),
          stderr: "",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          parsed: { summary: "done", changes: "yes", risks: "none", status: "ok" },
        },
      }),
      createTask({
        id: "blocked-task",
        phase: "blocked",
        workerResult: {
          status: "ok",
          source: "executor",
          stdout: JSON.stringify({ summary: "blocked", changes: "none", risks: "missing api key", status: "blocked" }),
          stderr: "",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          parsed: { summary: "blocked", changes: "none", risks: "missing api key", status: "blocked" },
        },
      }),
    ]);

    assert.equal(summary.blocked, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.consensus, "partial");
    // Must mention blocked tasks first
    assert.ok(summary.nextSteps.length > 0);
    assert.match(summary.nextSteps[0], /blocked/);
    // Must NOT suggest deployment when blocked tasks exist
    const deploymentStep = summary.nextSteps.find(s => /deployment/i.test(s));
    assert.equal(deploymentStep, undefined, "Should not suggest deployment when blocked tasks exist");
  });

  it("requires high consensus for deployment suggestion", () => {
    const summary = summarizeBatch([
      createTask({
        id: "completed-no-parsed",
        phase: "completed",
        workerResult: {
          status: "ok",
          source: "executor",
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      }),
    ]);

    // Completed without parsed → consensus cannot be high
    assert.equal(summary.consensus, "none");
    // Must NOT suggest deployment
    const deploymentStep = summary.nextSteps.find(s => /deployment/i.test(s));
    assert.equal(deploymentStep, undefined, "Should not suggest deployment without high consensus");
  });

  it("does not report high consensus while delegated tasks remain", () => {
    const summary = summarizeBatch([
      createTask({
        id: "completed-ok",
        phase: "completed",
        workerResult: {
          status: "ok",
          source: "executor",
          stdout: JSON.stringify({ summary: "done", changes: "yes", risks: "none", status: "ok" }),
          stderr: "",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          parsed: { summary: "done", changes: "yes", risks: "none", status: "ok" },
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
    ]);

    assert.equal(summary.completed, 1);
    assert.equal(summary.delegated, 1);
    assert.equal(summary.consensus, "partial");
  });
});
