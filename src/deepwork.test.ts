import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildDeepworkExecutionPlan, createDeepworkResponse, deepworkPreferencesPath, loadDeepworkPreferences, saveDeepworkPreferences } from "./deepwork.js";

const execFileAsync = promisify(execFile);

describe("deepwork preferences", () => {
  const originalHome = process.env.CODEX_WORKFLOW_HOME;

  beforeEach(async () => {
    process.env.CODEX_WORKFLOW_HOME = path.join(os.tmpdir(), "codex-workflow-tests", `deepwork-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fs.rm(deepworkPreferencesPath(), { force: true });
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.CODEX_WORKFLOW_HOME;
      return;
    }
    process.env.CODEX_WORKFLOW_HOME = originalHome;
  });

  it("returns onboarding response when no preferences are saved", async () => {
    const response = await createDeepworkResponse({});
    assert.equal(response.entry, "/deepwork");
    assert.equal(response.status, "needs-onboarding");
    assert.equal(response.preferences.executionMode, "hybrid");
    assert.equal(response.preferences.goalStyle, "explicit-goals");
    assert.equal(response.preferences.reviewMode, "standard-review");
  });

  it("saves preferences when remember is true", async () => {
    await createDeepworkResponse({
      executionMode: "cli-first",
      goalStyle: "proactive-decomposition",
      reviewMode: "strict-review",
      remember: true,
    });

    const saved = await loadDeepworkPreferences();
    assert.ok(saved);
    assert.equal(saved.executionMode, "cli-first");
    assert.equal(saved.goalStyle, "proactive-decomposition");
    assert.equal(saved.reviewMode, "strict-review");
  });

  it("does not persist temporary overrides", async () => {
    await saveDeepworkPreferences({
      executionMode: "hybrid",
      goalStyle: "explicit-goals",
      reviewMode: "standard-review",
    });

    const response = await createDeepworkResponse({
      executionMode: "cli-first",
      temporary: true,
    });

    assert.equal(response.preferences.executionMode, "cli-first");
    assert.equal(response.preferences.temporaryOverride, true);

    const saved = await loadDeepworkPreferences();
    assert.ok(saved);
    assert.equal(saved.executionMode, "hybrid");
  });

  it("reuses saved defaults on returning entry", async () => {
    await saveDeepworkPreferences({
      executionMode: "codex-first",
      goalStyle: "proactive-decomposition",
      reviewMode: "strict-review",
    });

    const response = await createDeepworkResponse({});
    assert.equal(response.status, "ready");
    assert.match(response.message, /Current default is codex-first \+ proactive-decomposition \+ strict-review/i);
  });

  it("builds a single-task plan for explicit goals", () => {
    const plan = buildDeepworkExecutionPlan({
      executionMode: "cli-first",
      goalStyle: "explicit-goals",
      reviewMode: "standard-review",
      persisted: true,
      temporaryOverride: false,
    }, {
      goal: "Add a hello endpoint",
    });

    assert.equal(plan.mode, "single");
    assert.equal(plan.executor, "opencode");
    assert.equal(plan.execMode, "cli");
    assert.equal(plan.autoRoute, false);
    assert.deepEqual(plan.goals, ["Add a hello endpoint"]);
  });

  it("builds a proactive batch plan from a single goal", () => {
    const plan = buildDeepworkExecutionPlan({
      executionMode: "hybrid",
      goalStyle: "proactive-decomposition",
      reviewMode: "strict-review",
      persisted: true,
      temporaryOverride: false,
    }, {
      goal: "Ship a health endpoint",
      executor: "mock",
    });

    assert.equal(plan.mode, "batch");
    assert.equal(plan.executor, "mock");
    assert.equal(plan.execMode, undefined);
    assert.equal(plan.autoRoute, true);
    assert.equal(plan.goals.length, 2);
    assert.match(plan.goals[0], /produce a short implementation plan/i);
    assert.match(plan.goals[1], /implement the highest-value next step and return a concrete deliverable/i);
  });

  it("builds a codex-first batch plan from explicit multiple goals", () => {
    const plan = buildDeepworkExecutionPlan({
      executionMode: "codex-first",
      goalStyle: "explicit-goals",
      reviewMode: "standard-review",
      persisted: true,
      temporaryOverride: false,
    }, {
      goals: "Task A, Task B",
    });

    assert.equal(plan.mode, "batch");
    assert.equal(plan.execMode, "codex");
    assert.equal(plan.autoRoute, false);
    assert.deepEqual(plan.goals, ["Task A", "Task B"]);
  });

  it("parses valueless flags without swallowing following options", async () => {
    const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
    const homeDir = path.join(os.tmpdir(), "codex-workflow-tests", `deepwork-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      "deepwork",
      "--temporary",
      "--execution-mode",
      "codex-first",
    ], {
      env: {
        ...process.env,
        CODEX_WORKFLOW_HOME: homeDir,
      },
    });

    const response = JSON.parse(stdout);
    assert.equal(response.preferences.executionMode, "codex-first");
    assert.equal(response.preferences.temporaryOverride, true);
  });

  it("writes workflow state to CODEX_WORKFLOW_CALLER_CWD when launched from a runtime directory", async () => {
    const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-runtime-"));
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-target-"));
    const homeDir = path.join(os.tmpdir(), "codex-workflow-tests", `deepwork-caller-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    try {
      await fs.writeFile(path.join(targetDir, "workflow.config.json"), JSON.stringify({
        defaultExecutor: "mock",
        executors: {
          mock: {
            command: process.execPath,
            args: [
              "-e",
              "process.stdout.write(JSON.stringify({summary:'ok',changes:'verified target cwd',risks:'none',status:'ok'}))",
            ],
            artifactMode: "schema",
            timeoutMs: 5000,
          },
        },
      }, null, 2), "utf8");

      const { stdout } = await execFileAsync(process.execPath, [
        cliPath,
        "deepwork",
        "--temporary",
        "--execution-mode",
        "cli-first",
        "--goal-style",
        "explicit-goals",
        "--executor",
        "mock",
        "--goal",
        "Verify caller cwd state location",
      ], {
        cwd: runtimeDir,
        env: {
          ...process.env,
          CODEX_WORKFLOW_CALLER_CWD: targetDir,
          CODEX_WORKFLOW_HOME: homeDir,
        },
      });

      const response = JSON.parse(stdout);
      assert.equal(response.result.phase, "completed");

      const targetStateFiles = await fs.readdir(path.join(targetDir, ".workflow-state"));
      assert.ok(
        targetStateFiles.some((file) => file.endsWith(".json") && !file.startsWith("probe.")),
        `expected workflow state in target dir, got ${targetStateFiles.join(", ")}`,
      );
      await assert.rejects(fs.access(path.join(runtimeDir, ".workflow-state")));
    } finally {
      await fs.rm(runtimeDir, { recursive: true, force: true });
      await fs.rm(targetDir, { recursive: true, force: true });
    }
  });
});
