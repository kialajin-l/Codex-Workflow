import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeExecutorFailure, normalizeOpencodeModelArgs, prepareOpencodeArgs, runExecutor, shouldRetryExecutor, withOpencodeTitle, withOpencodeWorkDir } from "./executor.js";

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

  it("does not synthesize ok parsed payloads from failed text executors", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-executor-failed-text-"));
    cleanupDirs.add(rootDir);
    const scriptPath = path.join(rootDir, "failed-text.cjs");
    await fs.writeFile(scriptPath, [
      "process.stdout.write('Unexpected server error. Check server logs for details.');",
      "process.exit(1);",
    ].join("\n"), "utf8");

    const result = await runExecutor(
      {
        command: process.execPath,
        args: [scriptPath],
        artifactMode: "text",
        timeoutMs: 5000,
      },
      "Say exactly hello",
    );

    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.equal(result.parsed, undefined);
    assert.equal(result.artifact?.content, "Unexpected server error. Check server logs for details.");
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

  it("adds a git-safe working directory to opencode args", () => {
    const oldCallerCwd = process.env.CODEX_WORKFLOW_CALLER_CWD;
    process.env.CODEX_WORKFLOW_CALLER_CWD = process.cwd();
    try {
      const args = withOpencodeWorkDir(["run", "--format", "json"]);
      assert.deepEqual(args.slice(0, 3), ["run", "--format", "json"]);
      assert.equal(args[3], "--dir");
      assert.equal(typeof args[4], "string");
      assert.ok(args[4]?.length);
      assert.deepEqual(
        withOpencodeWorkDir(["run", "--dir", "D:\\explicit", "--format", "json"]),
        ["run", "--dir", "D:\\explicit", "--format", "json"],
      );
    } finally {
      if (oldCallerCwd === undefined) {
        delete process.env.CODEX_WORKFLOW_CALLER_CWD;
      } else {
        process.env.CODEX_WORKFLOW_CALLER_CWD = oldCallerCwd;
      }
    }
  });

  it("normalizes legacy MIMO model ids for opencode", () => {
    assert.deepEqual(
      normalizeOpencodeModelArgs(["run", "--model", "openrouter/xiaomi/mimo-v2.5:free"]),
      ["run", "--model", "opencode/mimo-v2.5-free"],
    );
    assert.deepEqual(
      normalizeOpencodeModelArgs(["run", "--model", "opencode/mimo-v2.5-free"]),
      ["run", "--model", "opencode/mimo-v2.5-free"],
    );
  });

  it("adds a stable title to opencode run args", () => {
    assert.deepEqual(
      withOpencodeTitle(["run", "--pure", "--format", "json"]),
      ["run", "--pure", "--format", "json", "--title", "codex-workflow-task"],
    );
    assert.deepEqual(
      withOpencodeTitle(["run", "--title", "custom-title", "--pure"]),
      ["run", "--title", "custom-title", "--pure"],
    );
    assert.deepEqual(
      withOpencodeTitle(["serve", "--port", "4196"]),
      ["serve", "--port", "4196"],
    );
  });

  it("prepares opencode args with model aliases and git-safe workdir", () => {
    const oldCallerCwd = process.env.CODEX_WORKFLOW_CALLER_CWD;
    process.env.CODEX_WORKFLOW_CALLER_CWD = process.cwd();
    try {
      const args = prepareOpencodeArgs(["run", "--model", "openrouter/xiaomi/mimo-v2.5:free"]);
      assert.deepEqual(args.slice(0, 3), ["run", "--model", "opencode/mimo-v2.5-free"]);
      assert.equal(args[3], "--title");
      assert.equal(args[4], "codex-workflow-task");
      assert.equal(args[5], "--dir");
      assert.equal(typeof args[6], "string");
      assert.ok(args[6]?.length);
    } finally {
      if (oldCallerCwd === undefined) {
        delete process.env.CODEX_WORKFLOW_CALLER_CWD;
      } else {
        process.env.CODEX_WORKFLOW_CALLER_CWD = oldCallerCwd;
      }
    }
  });
});
