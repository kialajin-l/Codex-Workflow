import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRetryExecutor } from "./executor.js";

describe("executor retry policy", () => {
  it("retries schema tasks when the first output is not valid schema", () => {
    const result = shouldRetryExecutor(
      {
        command: "mock-executor",
        args: [],
      },
      {
        status: "ok",
        stdout: "This is not valid JSON.",
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        attempts: 1,
      },
      "retry prompt",
      "schema",
      "deepwork-planner",
    );

    assert.equal(result, true);
  });

  it("does not retry artifact tasks that already pass review", () => {
    const result = shouldRetryExecutor(
      {
        command: "mock-executor",
        args: [],
        artifactMode: "text",
      },
      {
        status: "ok",
        stdout: "Deliverable\nAssumptions\nNext step",
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        attempts: 1,
      },
      "retry prompt",
      "artifact",
    );

    assert.equal(result, false);
  });

  it("retries structured planner tasks when output is only an artifact summary", () => {
    const result = shouldRetryExecutor(
      {
        command: "mock-executor",
        args: [],
        artifactMode: "text",
      },
      {
        status: "ok",
        stdout: "not valid json",
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        attempts: 1,
        parsed: {
          summary: "not valid json",
          changes: "See artifact content.",
          risks: "Artifact fallback was used instead of strict schema output.",
          status: "ok",
        },
        artifact: {
          type: "text",
          content: "not valid json",
        },
      },
      "retry prompt",
      "schema",
      "deepwork-planner",
    );

    assert.equal(result, true);
  });
});
