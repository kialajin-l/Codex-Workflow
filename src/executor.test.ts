import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeExecutorFailure, runExecutor, shouldRetryExecutor } from "./executor.js";

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }),
  );
});

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

  it("passes multiline prompts to spawn executors as one argument", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-executor-argv-"));
    cleanupDirs.add(rootDir);
    const scriptPath = path.join(rootDir, "argv-check.cjs");
    await fs.writeFile(scriptPath, [
      "const prompt = process.argv[2] ?? '';",
      "const ok = prompt.includes('Task: multiline smoke marker');",
      "process.stdout.write(JSON.stringify({",
      "  summary: 'argv check',",
      "  changes: ok ? 'saw full prompt' : 'missing marker',",
      "  risks: 'none',",
      "  status: ok ? 'ok' : 'blocked'",
      "}));",
    ].join("\n"), "utf8");

    const result = await runExecutor(
      {
        command: process.execPath,
        args: [scriptPath],
        timeoutMs: 5000,
      },
      [
        "Return exactly one JSON object.",
        "Schema: {\"summary\":\"string\",\"changes\":\"string\",\"risks\":\"string\",\"status\":\"ok|blocked\"}",
        "Task: multiline smoke marker",
      ].join("\n"),
      undefined,
      "schema",
    );

    assert.equal(result.status, "ok");
    assert.equal(result.parsed?.status, "ok");
  });
});
