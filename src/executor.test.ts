import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeExecutorFailure, shouldRetryExecutor } from "./executor.js";

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
        stdout: [
          "Deliverable: Add a GET /health endpoint.",
          "Assumptions:",
          "- A router already exists.",
          "Next step: Implement the route and add a focused test.",
        ].join("\n"),
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

  it("classifies opencode event streams as invalid artifact output before review", () => {
    const normalized = normalizeExecutorFailure(
      "opencode",
      [
        '{"type":"step_start","timestamp":1}',
        '{"type":"tool_use","part":{"tool":"read","state":{"status":"completed"}}}',
        '{"type":"step_finish","timestamp":2}',
      ].join("\n"),
      "",
      0,
    );

    assert.equal(normalized.status, "failed");
    assert.equal(normalized.failureCategory, "invalid-json");
    assert.match(normalized.stderr, /event stream|tool trace/i);
  });

  it("classifies opencode tool traces as invalid artifact output before review", () => {
    const normalized = normalizeExecutorFailure(
      "opencode",
      '{"type":"tool_use","part":{"tool":"read","state":{"status":"completed","input":{"filePath":"C:\\\\Users\\\\kiala\\\\.codex\\\\codex-workflow\\\\runtime\\\\package.json"}}}}',
      "",
      0,
    );

    assert.equal(normalized.status, "failed");
    assert.equal(normalized.failureCategory, "invalid-json");
    assert.match(normalized.stderr, /event stream|tool trace/i);
  });
});
