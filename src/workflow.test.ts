import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseWorkerPayload, reviewWorkerResultForMode } from "./review.js";
import { verifyTaskCompletion } from "./verify.js";
import type { DeepworkPlannerResult, RouteDecision, WorkflowConfig, WorkflowTask } from "./types.js";
import { loadBatch } from "./store.js";
import { buildRetryPrompt, buildWorkerPrompt, createTask, inferDeepworkRole, resolveTaskPhase, runTask, runTaskBatch, runTaskWithFallbacks, synthesizeStructuredFallback } from "./workflow.js";

const cleanupDirs = new Set<string>();
const savedFenceEnabled = process.env.RULEFORGE_FENCE_ENABLED;
const savedFenceBin = process.env.RULEFORGE_FENCE_BIN;

beforeEach(() => {
  process.env.RULEFORGE_FENCE_ENABLED = "false";
});

afterEach(async () => {
  if (savedFenceEnabled === undefined) {
    delete process.env.RULEFORGE_FENCE_ENABLED;
  } else {
    process.env.RULEFORGE_FENCE_ENABLED = savedFenceEnabled;
  }
  if (savedFenceBin === undefined) {
    delete process.env.RULEFORGE_FENCE_BIN;
  } else {
    process.env.RULEFORGE_FENCE_BIN = savedFenceBin;
  }
  await Promise.all(
    [...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }),
  );
});

describe("workflow prompts", () => {
  it("builds planner schema prompts with concrete output instructions", () => {
    const prompt = buildWorkerPrompt(
      "Ship a health endpoint - produce a short implementation plan",
      "schema",
      "planner",
    );

    assert.match(prompt, /Return exactly one JSON object/i);
    assert.match(prompt, /Output must be valid JSON\./i);
    assert.match(prompt, /Do not add any text before or after the JSON object\./i);
    assert.match(prompt, /\"goal\":\"string\"/i);
    assert.match(prompt, /\"steps\":\[\s*\"string\"\s*\]/i);
  });

  it("builds implementer retry prompts with schema output instructions", () => {
    const prompt = buildRetryPrompt(
      "Ship a health endpoint - execute the highest-value next step",
      "schema",
      "implementer",
    );

    assert.match(prompt, /^Retry\. Your previous answer did not satisfy the required JSON schema\./i);
    assert.match(prompt, /Every required field in the schema must be present exactly once\./i);
    assert.match(prompt, /\"deliverable\":\"string\"/i);
    assert.match(prompt, /\"nextStep\":\"string\"/i);
  });

  it("builds artifact recovery prompts that request labeled plain text", () => {
    const prompt = buildRetryPrompt(
      "Ship a health endpoint - execute the highest-value next step",
      "artifact",
      "implementer",
    );

    assert.match(prompt, /^Retry\./i);
    assert.match(prompt, /Output format:/i);
    assert.match(prompt, /Deliverable/i);
    assert.match(prompt, /Only output the three labeled sections/i);
    assert.match(prompt, /Do not mention the workflow, retries, tasks, batches, logs, state, or existing files/i);
    assert.match(prompt, /Do not output tables, bullet lists, code blocks, file paths, or status summaries/i);
  });

  it("allows workspace access in prompts for workspace-capable executors", () => {
    const prompt = buildWorkerPrompt(
      "Ship a health endpoint - implement the highest-value next step and return a concrete deliverable",
      "schema",
      "implementer",
      true,
    );

    assert.match(prompt, /You may inspect and edit files in the current workspace/i);
    assert.match(prompt, /Only claim files were created, edited, or verified when that actually happened/i);
    assert.doesNotMatch(prompt, /You do not have repository or filesystem access/i);
  });

  it("keeps non-workspace executor prompts artifact-only", () => {
    const prompt = buildWorkerPrompt(
      "Ship a health endpoint - implement the highest-value next step and return a concrete deliverable",
      "schema",
      "implementer",
      false,
    );

    assert.match(prompt, /You do not have repository or filesystem access/i);
    assert.doesNotMatch(prompt, /You may inspect and edit files in the current workspace/i);
  });
});

describe("structured payload parsing", () => {
  it("parses planner deepwork schema payload", () => {
    const payload = parseWorkerPayload(JSON.stringify({
      summary: "Created a plan",
      changes: "Outlined the next steps",
      risks: "Endpoint wiring may touch routing",
      status: "ok",
      goal: "Ship a health endpoint",
      assumptions: ["Express app already exists"],
      steps: ["Add route", "Add test"],
    }));

    assert.ok(payload);
    assert.equal(payload.status, "ok");
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
    assert.deepEqual(record.steps, ["Add route", "Add test"]);
  });

  it("parses implementer deepwork schema payload", () => {
    const payload = parseWorkerPayload(JSON.stringify({
      summary: "Proposed the next change",
      changes: "Specified the deliverable and next step",
      risks: "No file edits were made",
      status: "ok",
      deliverable: "Add GET /health returning 200",
      assumptions: ["Node service uses Express"],
      nextStep: "Implement the route in the API layer",
    }));

    assert.ok(payload);
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.deliverable, "Add GET /health returning 200");
    assert.equal(record.nextStep, "Implement the route in the API layer");
  });

  it("salvages planner payload from labeled text", () => {
    const payload = parseWorkerPayload([
      "Summary: Created a plan",
      "Changes: Outlined the next steps",
      "Risks: Endpoint wiring may touch routing",
      "Goal: Ship a health endpoint",
      "Assumptions:",
      "- Express app already exists",
      "Steps:",
      "- Add route",
      "- Add test",
    ].join("\n"), "deepwork-planner");

    assert.ok(payload);
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
    assert.deepEqual(record.steps, ["Add route", "Add test"]);
  });

  it("salvages planner payload from wrapped json output", () => {
    const payload = parseWorkerPayload([
      "Here is the plan:",
      "```json",
      JSON.stringify({
        summary: "Created a plan",
        changes: "Outlined the next steps",
        risks: "Endpoint wiring may touch routing",
        status: "ok",
        goal: "Ship a health endpoint",
        assumptions: ["Express app already exists"],
        steps: ["Add route", "Add test"],
      }, null, 2),
      "```",
    ].join("\n"), "deepwork-planner");

    assert.ok(payload);
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
    assert.deepEqual(record.steps, ["Add route", "Add test"]);
  });

  it("salvages implementer payload from labeled text", () => {
    const payload = parseWorkerPayload([
      "Summary: Proposed the next change",
      "Changes: Specified the deliverable and next step",
      "Risks: No file edits were made",
      "Deliverable: Add GET /health returning 200",
      "Assumptions:",
      "- Node service uses Express",
      "Next step: Implement the route in the API layer",
    ].join("\n"), "deepwork-implementer");

    assert.ok(payload);
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.deliverable, "Add GET /health returning 200");
    assert.equal(record.nextStep, "Implement the route in the API layer");
  });

  it("salvages implementer payload from numbered section headings", () => {
    const payload = parseWorkerPayload([
      "Summary: Proposed the next change",
      "Changes: Specified the deliverable and next step",
      "Risks: No file edits were made",
      "1. Deliverable",
      "Add GET /health returning 200",
      "2. Assumptions",
      "- Node service uses Express",
      "3. Next step",
      "Implement the route in the API layer",
    ].join("\n"), "deepwork-implementer");

    assert.ok(payload);
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.deliverable, "Add GET /health returning 200");
    assert.deepEqual(record.assumptions, ["Node service uses Express"]);
    assert.equal(record.nextStep, "Implement the route in the API layer");
  });

  it("salvages planner payload from numbered section headings", () => {
    const payload = parseWorkerPayload([
      "Summary: Created a plan",
      "Changes: Outlined the next steps",
      "Risks: Endpoint wiring may touch routing",
      "1. Goal",
      "Ship a health endpoint",
      "2. Assumptions",
      "- Express app already exists",
      "3. Steps",
      "- Add route",
      "- Add test",
    ].join("\n"), "deepwork-planner");

    assert.ok(payload);
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
    assert.deepEqual(record.assumptions, ["Express app already exists"]);
    assert.deepEqual(record.steps, ["Add route", "Add test"]);
  });

  it("salvages planner payload from full-width labels and unicode bullets", () => {
    const payload = parseWorkerPayload([
      "Summary： Created a plan",
      "Changes： Outlined the next steps",
      "Risks： Endpoint wiring may touch routing",
      "Goal： Ship a health endpoint",
      "Assumptions：",
      "• Express app already exists",
      "Steps：",
      "• Add route",
      "• Add test",
    ].join("\n"), "deepwork-planner");

    assert.ok(payload);
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
    assert.deepEqual(record.steps, ["Add route", "Add test"]);
  });

  it("classifies salvageable planner text without JSON", () => {
    const payload = parseWorkerPayload([
      "Summary: Created a plan",
      "Changes: Outlined the next steps",
      "Risks: Endpoint wiring may touch routing",
      "Goal: Ship a health endpoint",
      "Assumptions:",
      "- Express app already exists",
      "Steps:",
      "- Add route",
      "- Add test",
    ].join("\n"), "deepwork-planner");

    assert.ok(payload);
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
  });
});

describe("structured fallback", () => {
  it("synthesizes a planner fallback payload", () => {
    const payload = synthesizeStructuredFallback({
      goal: "Ship a health endpoint - produce a short implementation plan",
      role: "planner",
      structuredMode: "deepwork-planner",
    });

    assert.ok(payload);
    assert.equal(payload.status, "blocked");
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
    assert.ok(Array.isArray(record.steps));
  });

  it("synthesizes an implementer fallback payload", () => {
    const payload = synthesizeStructuredFallback({
      goal: "Ship a health endpoint - execute the highest-value next step",
      role: "implementer" as const,
      structuredMode: "deepwork-implementer" as const,
    });

    assert.ok(payload);
    assert.equal(payload.status, "blocked");
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(typeof record.deliverable, "string");
    assert.equal(typeof record.nextStep, "string");
  });
});

describe("worker result provenance", () => {
  it("marks synthesized fallback results explicitly", () => {
    const fallback = synthesizeStructuredFallback({
      goal: "Ship a health endpoint - produce a short implementation plan",
      role: "planner",
      structuredMode: "deepwork-planner",
    });

    assert.ok(fallback);
    const workerResult = {
      status: "ok" as const,
      source: "fallback-synthesized" as const,
      stdout: JSON.stringify(fallback),
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
      parsed: fallback,
    };

    assert.equal(workerResult.source, "fallback-synthesized");
  });

  it("marks recovery text output as executor-salvaged for structured tasks", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-recovery-"));
    cleanupDirs.add(rootDir);
    const mockScriptPath = path.join(rootDir, "mock-executor.js");
    const counterPath = path.join(rootDir, "counter.txt");
    await fs.writeFile(mockScriptPath, [
      "const fs = require('node:fs');",
      `const counterPath = ${JSON.stringify(counterPath)};`,
      "const current = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : '0') + 1;",
      "fs.writeFileSync(counterPath, String(current));",
      "if (current >= 3) {",
      "  process.stdout.write([",
      "    'Summary: Created a plan',",
      "    'Changes: Outlined the next steps',",
      "    'Risks: Endpoint wiring may touch routing',",
      "    'Goal: Ship a health endpoint',",
      "    'Assumptions:',",
      "    '- Express app already exists',",
      "    'Steps:',",
      "    '- Add route',",
      "    '- Add test',",
      "  ].join('\\n'));",
      "} else {",
      "  process.stdout.write('not valid json');",
      "}",
      "",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const route: RouteDecision = {
      goal: "Ship a health endpoint - produce a short implementation plan",
      profile: "deepwork/planner-structured",
      executor: "mock",
      fallbackExecutors: [],
      role: "planner",
      complexity: "medium" as const,
      reason: "test",
    };

    const task = await createTask(
      rootDir,
      "Ship a health endpoint - produce a short implementation plan",
      "mock",
      config,
      route,
      { execMode: "cli" },
    );

    const completed = await runTaskWithFallbacks(rootDir, task, config);
    assert.equal(completed.phase, "completed");
    assert.equal(completed.workerResult?.source, "executor-salvaged");
    assert.equal(completed.review?.decision, "accept");
    const parsed = completed.workerResult?.parsed as Record<string, unknown> | undefined;
    if (parsed?.goal === undefined) {
      assert.fail(JSON.stringify({
        stdout: completed.workerResult?.stdout,
        parsed,
        review: completed.review,
      }, null, 2));
    }
    assert.equal(parsed?.goal, "Ship a health endpoint");
    assert.deepEqual(parsed?.steps, ["Add route", "Add test"]);
  });

  it("blocks executor-salvaged structured output in strict review mode", async () => {
    const now = new Date().toISOString();
    const task: WorkflowTask = {
      id: "strict-salvaged",
      goal: "Ship a health endpoint - produce a short implementation plan",
      executor: "mock",
      phase: "review",
      createdAt: now,
      updatedAt: now,
      workerPrompt: "test",
      expectedOutput: "schema",
      role: "planner",
      structuredMode: "deepwork-planner",
      reviewMode: "strict-review",
      workerResult: {
        status: "ok",
        source: "executor-salvaged",
        stdout: "Summary: Created a plan\nChanges: Outlined steps\nRisks: none\nGoal: Ship a health endpoint\nAssumptions:\n- Express app exists\nSteps:\n- Add route",
        stderr: "",
        exitCode: 0,
        startedAt: now,
        finishedAt: now,
        attempts: 1,
        parsed: {
          summary: "Created a plan",
          changes: "Outlined steps",
          risks: "none",
          status: "ok",
          goal: "Ship a health endpoint",
          assumptions: ["Express app exists"],
          steps: ["Add route"],
        } as DeepworkPlannerResult,
      },
      review: {
        decision: "accept",
        summary: "Accepted salvage.",
        issues: [],
        reviewedAt: now,
      },
    };

    assert.equal(resolveTaskPhase(task), "blocked");
  });

  it("switches implementer artifact retries to a fallback executor before retrying the same executor", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fallback-"));
    cleanupDirs.add(rootDir);
    const primaryPath = path.join(rootDir, "primary.js");
    const fallbackPath = path.join(rootDir, "fallback.js");

    await fs.writeFile(primaryPath, "process.stdout.write('What would you like me to retry?')\n", "utf8");
    await fs.writeFile(fallbackPath, [
      "process.stdout.write([",
      "  'Deliverable: Implement a helper validation utility with clear input and output constraints.',",
      "  'Assumptions:',",
      "  '- The project already has a utilities module.',",
      "  'Next step: Add the utility and cover one happy path plus one edge case.',",
      "].join('\\n'));",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "primary",
      executors: {
        primary: {
          command: "node",
          args: [primaryPath],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
        fallback: {
          command: "node",
          args: [fallbackPath],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const route: RouteDecision = {
      goal: "Implement a helper validation utility",
      profile: "deepseek/deepseek-v4-flash",
      executor: "primary",
      fallbackExecutors: ["fallback"],
      role: "implementer" as const,
      complexity: "low",
      reason: "test",
      attemptedExecutors: ["primary"],
    };

    const task = await createTask(
      rootDir,
      "Implement a helper validation utility",
      "primary",
      config,
      route,
      { execMode: "cli" },
    );

    const completed = await runTaskWithFallbacks(rootDir, task, config);
    assert.equal(completed.phase, "completed");
    assert.equal(completed.executor, "fallback");
    assert.equal(completed.review?.decision, "accept");
    assert.deepEqual(completed.route?.attemptedExecutors, ["primary", "fallback"]);
    assert.match(completed.workerResult?.stdout ?? "", /Deliverable:/);
  });
});

describe("batch persistence", () => {
  it("blocks a batch when all structured tasks end in synthesized fallback", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fallback-batch-"));
    cleanupDirs.add(rootDir);
    const mockScriptPath = path.join(rootDir, "failing-executor.js");
    await fs.writeFile(mockScriptPath, [
      "process.stderr.write('Unexpected server error');",
      "process.exit(1);",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const batch = await runTaskBatch(
      rootDir,
      [
        "Ship a health endpoint - produce a short implementation plan",
        "Ship a health endpoint - implement the highest-value next step and return a concrete deliverable",
      ],
      "mock",
      config,
      "parallel",
    );

    assert.equal(batch.phase, "blocked");
    assert.equal(batch.summary?.completed, 0);
    assert.equal(batch.summary?.blocked, 2);
    assert.equal(batch.summary?.resultSources.fallbackSynthesized, 2);
    assert.equal(batch.tasks.every((task) => task.phase === "blocked"), true);
    assert.equal(batch.tasks.every((task) => task.workerResult?.source === "fallback-synthesized"), true);
    assert.equal(batch.tasks.every((task) => task.workerResult?.parsed?.status === "blocked"), true);
    assert.equal(batch.summary?.nextSteps.some((step) => /deployment/i.test(step)), false);
  });

  it("persists batch state before parallel tasks finish", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-batch-"));
    cleanupDirs.add(rootDir);
    const mockScriptPath = path.join(rootDir, "slow-executor.js");
    await fs.writeFile(mockScriptPath, [
      "setTimeout(() => {",
      "  process.stdout.write(JSON.stringify({",
      '    summary: "Created a plan",',
      '    changes: "Outlined the next steps",',
      '    risks: "none",',
      '    status: "ok"',
      "  }));",
      "}, 300);",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          timeoutMs: 5000,
        },
      },
    };

    const batchPromise = runTaskBatch(
      rootDir,
      ["Task one", "Task two"],
      "mock",
      config,
      "parallel",
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    const stateDir = path.join(rootDir, ".workflow-state");
    const stateFiles = await fs.readdir(stateDir);
    const batchFile = stateFiles.find((file) => file.startsWith("batch."));
    assert.ok(batchFile, `expected batch file in ${stateDir}, got ${stateFiles.join(", ")}`);

    const batchId = batchFile.replace(/^batch\./, "").replace(/\.json$/, "");
    const persisted = await loadBatch(rootDir, batchId);
    assert.equal(persisted.phase, "partial");
    assert.equal(persisted.tasks.length, 2);
    assert.equal(persisted.finishedAt, persisted.startedAt);

    const completed = await batchPromise;
    assert.equal(completed.phase, "completed");
  });

  it("completes delegated tasks from a persisted partial batch", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-delegated-"));
    cleanupDirs.add(rootDir);

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: ["-e", "process.stdout.write('done')"],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const route: RouteDecision = {
      goal: "Design a migration architecture for auth modules",
      profile: "deepseek/deepseek-v4-pro",
      executor: "mock",
      fallbackExecutors: [],
      role: "architect",
      complexity: "high",
      reason: "test",
    };

    const delegatedTask = await createTask(rootDir, route.goal, "mock", config, route, { execMode: "codex" });
    delegatedTask.phase = "delegated_to_codex";
    delegatedTask.workerResult = {
      status: "delegated",
      source: "delegated",
      stdout: JSON.stringify({ action: "codex_subagent_required", taskId: delegatedTask.id }),
      stderr: "",
      exitCode: 0,
      startedAt: delegatedTask.updatedAt,
      finishedAt: delegatedTask.updatedAt,
      attempts: 1,
    };

    await fs.mkdir(path.join(rootDir, ".workflow-state"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, ".workflow-state", `${delegatedTask.id}.json`),
      JSON.stringify(delegatedTask, null, 2),
      "utf8",
    );

    const batch = {
      id: "batch-test",
      executor: "mock",
      mode: "parallel" as const,
      goals: [route.goal],
      startedAt: delegatedTask.createdAt,
      finishedAt: delegatedTask.createdAt,
      phase: "partial" as const,
      tasks: [delegatedTask],
      summary: {
        totalTasks: 1,
        completed: 0,
        blocked: 0,
        delegated: 1,
        resultSources: {
          executor: 0,
          executorSalvaged: 0,
          fallbackSynthesized: 0,
          delegated: 1,
          unknown: 0,
        },
        consensus: "none" as const,
        risks: [],
        nextSteps: ["1 task(s) delegated to Codex - complete them first"],
      },
    };

    await fs.writeFile(
      path.join(rootDir, ".workflow-state", "batch.batch-test.json"),
      JSON.stringify(batch, null, 2),
      "utf8",
    );

    const { spawn } = await import("node:child_process");
    const cliEntry = path.resolve("dist/index.js");
    const child = spawn(
      process.execPath,
      [
        cliEntry,
        "complete-delegated",
        "--batch",
        "batch-test",
        "--stdout",
        "Deliverable: Auth migration architecture with phased rollout.\nAssumptions:\n- Existing auth modules are separable.\nNext step: Draft the migration sequence by boundary.",
        "--status",
        "ok",
      ],
      {
        cwd: rootDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const exitCode: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    assert.equal(exitCode, 0, stderr || stdout);
    const persisted = await loadBatch(rootDir, "batch-test");
    assert.equal(persisted.phase, "completed");
    assert.equal(persisted.summary?.completed, 1);
    assert.equal(persisted.summary?.delegated, 0);
    assert.equal(persisted.tasks[0]?.phase, "completed");
    assert.equal(persisted.tasks[0]?.workerResult?.source, undefined);
  });

  it("completes only the delegated task selected by task id", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-delegated-target-"));
    cleanupDirs.add(rootDir);

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: ["-e", "process.stdout.write('done')"],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const plannerTask = await createTask(
      rootDir,
      "Ship a health endpoint - produce a short implementation plan",
      "mock",
      config,
      undefined,
      { execMode: "codex" },
    );
    plannerTask.phase = "delegated_to_codex";
    plannerTask.workerResult = {
      status: "delegated",
      source: "delegated",
      stdout: JSON.stringify({ action: "codex_subagent_required", taskId: plannerTask.id }),
      stderr: "",
      exitCode: 0,
      startedAt: plannerTask.updatedAt,
      finishedAt: plannerTask.updatedAt,
      attempts: 1,
    };

    const implementerTask = await createTask(
      rootDir,
      "Ship a health endpoint - implement the highest-value next step and return a concrete deliverable",
      "mock",
      config,
      undefined,
      { execMode: "codex" },
    );
    implementerTask.phase = "delegated_to_codex";
    implementerTask.workerResult = {
      status: "delegated",
      source: "delegated",
      stdout: JSON.stringify({ action: "codex_subagent_required", taskId: implementerTask.id }),
      stderr: "",
      exitCode: 0,
      startedAt: implementerTask.updatedAt,
      finishedAt: implementerTask.updatedAt,
      attempts: 1,
    };

    await fs.mkdir(path.join(rootDir, ".workflow-state"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, ".workflow-state", `${plannerTask.id}.json`),
      JSON.stringify(plannerTask, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, ".workflow-state", `${implementerTask.id}.json`),
      JSON.stringify(implementerTask, null, 2),
      "utf8",
    );

    const batch = {
      id: "batch-targeted",
      executor: "mock",
      mode: "parallel" as const,
      goals: [plannerTask.goal, implementerTask.goal],
      startedAt: plannerTask.createdAt,
      finishedAt: plannerTask.createdAt,
      phase: "partial" as const,
      tasks: [plannerTask, implementerTask],
      summary: {
        totalTasks: 2,
        completed: 0,
        blocked: 0,
        delegated: 2,
        resultSources: {
          executor: 0,
          executorSalvaged: 0,
          fallbackSynthesized: 0,
          delegated: 2,
          unknown: 0,
        },
        consensus: "none" as const,
        risks: [],
        nextSteps: ["2 task(s) delegated to Codex - complete them first"],
      },
    };

    await fs.writeFile(
      path.join(rootDir, ".workflow-state", "batch.batch-targeted.json"),
      JSON.stringify(batch, null, 2),
      "utf8",
    );

    const plannerResultPath = path.join(rootDir, "planner-result.json");
    await fs.writeFile(
      plannerResultPath,
      JSON.stringify({
        summary: "planner complete",
        changes: "created a concrete plan",
        risks: "none",
        status: "ok",
        goal: "Ship a health endpoint",
        assumptions: ["router exists"],
        steps: ["Add route", "Add focused test"],
      }),
      "utf8",
    );

    const { spawn } = await import("node:child_process");
    const cliEntry = path.resolve("dist/index.js");
    const child = spawn(
      process.execPath,
      [
        cliEntry,
        "complete-delegated",
        "--batch",
        "batch-targeted",
        "--task-id",
        plannerTask.id,
        "--stdout-file",
        plannerResultPath,
        "--status",
        "ok",
      ],
      {
        cwd: rootDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const exitCode: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    assert.equal(exitCode, 0, stderr || stdout);
    const persisted = await loadBatch(rootDir, "batch-targeted");
    assert.equal(persisted.phase, "partial");
    assert.equal(persisted.summary?.completed, 1);
    assert.equal(persisted.summary?.delegated, 1);
    assert.equal(persisted.tasks[0]?.id, plannerTask.id);
    assert.equal(persisted.tasks[0]?.phase, "completed");
    assert.equal(persisted.tasks[1]?.id, implementerTask.id);
    assert.equal(persisted.tasks[1]?.phase, "delegated_to_codex");
  });
});

describe("artifact review", () => {
  it("rejects generic artifact summaries for structured schema tasks", () => {
    const review = reviewWorkerResultForMode({
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
    }, "schema", "deepwork-planner");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /missing a valid json payload/i);
  });

  it("rejects clarification responses for artifact tasks", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "What kind of artifact? HTML page, code file, markdown doc, or something else?",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /asked for clarification/i);
  });

  it("rejects invented repository context for artifact tasks", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "Here is the project's package.json with the dependencies I found in the repository.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /repository context/i);
  });

  it("rejects clarification phrased without a question mark", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "I need clarification. Please specify the content or purpose of the artifact you want.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /asked for clarification/i);
  });

  it("rejects claims about first checking project context", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "Let me check the project context first. Here is one concrete artifact - a sample workflow configuration file.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /asked for clarification/i);
  });

  it("rejects claims of file creation without file access", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "Done. `workflows/fullstack-router.json` updated with the requested preset.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /written or updated files/i);
  });

  it("rejects workflow meta narration instead of an artifact", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "Let me retry the failed tasks using the workflow CLI's resume feature. The batch file doesn't exist, so I will complete the delegated task and then run the tests.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /process narration|workflow operations/i);
  });

  it("rejects claims about existing artifacts on disk as task output", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "Both pending artifacts already exist on disk. Updating the workflow state to reflect completion.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /process narration|workflow operations/i);
  });

  it("rejects opencode event stream output instead of an artifact", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: [
        '{"type":"step_start","timestamp":1}',
        '{"type":"tool_use","part":{"tool":"read","state":{"status":"completed"}}}',
        '{"type":"step_finish","timestamp":2}',
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /event stream|tool trace|workflow operations/i);
  });

  it("rejects tool trace output that inspects local files", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "{\"type\":\"tool_use\",\"part\":{\"tool\":\"read\",\"state\":{\"status\":\"completed\",\"input\":{\"filePath\":\"C:\\\\Users\\\\kiala\\\\.codex\\\\codex-workflow\\\\runtime\\\\package.json\"}}}}",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /event stream|tool trace|repository context/i);
  });

  it("accepts artifact output with the expected labeled structure", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: [
        "Deliverable: Add a GET /health endpoint returning 200 and a JSON status payload.",
        "Assumptions:",
        "- The service already has a router module.",
        "- Focused endpoint changes are acceptable.",
        "Next step: Implement the route and add a focused verification test.",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "accept");
  });

  it("accepts artifact output with numbered section headings", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: [
        "1. Deliverable",
        "",
        "Validation Plan: Small CLI Workflow",
        "",
        "2. Assumptions",
        "- CLI output is deterministic.",
        "",
        "3. Next step",
        "- Write the first smoke test.",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "accept");
  });

  it("rejects generic artifact text without the expected structure", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "Health endpoint plan ready.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /artifact structure|expected sections/i);
  });
});

describe("regression: blocked status overrides review accept", () => {
  it("parsed.status=blocked with review.accept → phase is blocked, not completed", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-e1-"));
    cleanupDirs.add(rootDir);
    const mockScriptPath = path.join(rootDir, "mock-blocked.js");

    // Executor returns valid JSON that self-reports blocked
    await fs.writeFile(mockScriptPath, [
      'process.stdout.write(JSON.stringify({',
      '  summary: "Cannot proceed",',
      '  changes: "None — blocked by missing dependency",',
      '  risks: "Missing upstream service",',
      '  status: "blocked"',
      '}));',
    ].join("\n"), "utf8");

    const config = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const route = {
      goal: "Ship a health endpoint",
      profile: "test/blocked",
      executor: "mock",
      fallbackExecutors: [],
      role: "implementer" as const,
      complexity: "medium" as const,
      reason: "test",
    };

    const task = await createTask(
      rootDir,
      "Ship a health endpoint",
      "mock",
      config,
      route,
      { execMode: "cli" },
    );

    const completed = await runTaskWithFallbacks(rootDir, task, config);

    // Even if review accepts the valid JSON, phase must be blocked
    assert.equal(completed.phase, "blocked",
      `Expected phase "blocked" but got "${completed.phase}". Review: ${JSON.stringify(completed.review)}`);
    assert.ok(completed.workerResult?.parsed);
    assert.equal(completed.workerResult?.parsed.status, "blocked");
  });
});

describe("regression: verify analysis-only implementer output", () => {
  it("verifyTaskCompletion blocks analysis-only implementer output", () => {
    const task = {
      id: "test",
      goal: "Implement auth middleware",
      executor: "mock",
      phase: "review" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workerPrompt: "test",
      structuredMode: "deepwork-implementer" as const,
      role: "implementer" as const,
      workerResult: {
        status: "ok" as const,
        source: "executor",
        stdout: [
          "I analyzed the repository and found that the auth middleware is missing.",
          "Based on the project structure, I would recommend adding Express middleware",
          "that validates JWT tokens. Let me check the current setup first.",
          "Here is my analysis of the current state.",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    } as WorkflowTask;

    const result = verifyTaskCompletion(task);
    assert.equal(result.verdict, "blocked",
      `Expected blocked but got ${result.verdict}: ${result.reason}`);
    assert.match(result.reason, /pure analysis/i);
  });

  it("verifyTaskCompletion accepts implementer output with a deliverable", () => {
    const task = {
      id: "test",
      goal: "Implement auth middleware",
      executor: "mock",
      phase: "review" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workerPrompt: "test",
      structuredMode: "deepwork-implementer" as const,
      role: "implementer" as const,
      workerResult: {
        status: "ok" as const,
        source: "executor",
        stdout: [
          "Deliverable: Added JWT validation middleware to the Express app.",
          "Created the auth module with token verification and role-based access.",
          "Assumptions: Express app already exists with a router module.",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    } as WorkflowTask;

    const result = verifyTaskCompletion(task);
    assert.notEqual(result.verdict, "blocked",
      `Should not block deliverable output: ${result.reason}`);
  });

  it("verifyTaskCompletion blocks implementer output that leaves implementation work in nextStep", () => {
    const task = {
      id: "test",
      goal: "Ship slugify - implement the highest-value next step and return a concrete deliverable",
      executor: "mock",
      phase: "review" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workerPrompt: "test",
      structuredMode: "deepwork-implementer" as const,
      role: "implementer" as const,
      workerResult: {
        status: "ok" as const,
        source: "executor",
        stdout: JSON.stringify({
          summary: "slugify should be moved into src/utils.",
          changes: "Create src/utils/slug.js and update slug.js.",
          risks: "low",
          status: "ok",
          deliverable: "src/utils/slug.js contains slugify and root slug.js re-exports it.",
          assumptions: ["Node.js project"],
          nextStep: "读取现有 slug.js 确认内容后迁移至 src/utils/slug.js",
        }),
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        attempts: 1,
        parsed: {
          summary: "slugify should be moved into src/utils.",
          changes: "Create src/utils/slug.js and update slug.js.",
          risks: "low",
          status: "ok",
          deliverable: "src/utils/slug.js contains slugify and root slug.js re-exports it.",
          assumptions: ["Node.js project"],
          nextStep: "读取现有 slug.js 确认内容后迁移至 src/utils/slug.js",
        },
      },
    } as WorkflowTask;

    const result = verifyTaskCompletion(task);
    assert.equal(result.verdict, "blocked");
    assert.match(result.reason, /nextStep/i);
  });

  it("verifyTaskCompletion accepts completed implementer output with a terminal nextStep", () => {
    const task = {
      id: "test",
      goal: "Ship slugify - implement the highest-value next step and return a concrete deliverable",
      executor: "mock",
      phase: "review" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workerPrompt: "test",
      structuredMode: "deepwork-implementer" as const,
      role: "implementer" as const,
      workerResult: {
        status: "ok" as const,
        source: "executor",
        stdout: JSON.stringify({
          summary: "Implemented slugify and verified tests.",
          changes: "Created src/utils/slug.js and ran node src/utils/slug.js.",
          risks: "low",
          status: "ok",
          deliverable: "src/utils/slug.js with slugify and passing inline assertions.",
          assumptions: ["Node.js project"],
          nextStep: "Task complete. No further action required.",
        }),
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        attempts: 1,
        parsed: {
          summary: "Implemented slugify and verified tests.",
          changes: "Created src/utils/slug.js and ran node src/utils/slug.js.",
          risks: "low",
          status: "ok",
          deliverable: "src/utils/slug.js with slugify and passing inline assertions.",
          assumptions: ["Node.js project"],
          nextStep: "Task complete. No further action required.",
        },
      },
    } as WorkflowTask;

    const result = verifyTaskCompletion(task);
    assert.notEqual(result.verdict, "blocked",
      `Should not block terminal nextStep output: ${result.reason}`);
  });
});

describe("regression: blocked status with fallback payload", () => {
  it("synthesizeStructuredFallback marks the task outcome as blocked", () => {
    const fallback = synthesizeStructuredFallback({
      goal: "Ship a health endpoint - produce a short implementation plan",
      role: "planner",
      structuredMode: "deepwork-planner",
    });
    assert.ok(fallback);
    assert.equal(fallback.status, "blocked",
      "Fallback payload should be blocked because it has no real executor artifact");
  });
});

describe("host-apply pending implementer artifacts", () => {
  it("resolves blocked implementer output with a deliverable to host_apply_pending", () => {
    const phase = resolveTaskPhase({
      id: "test",
      goal: "Ship slugify - implement the highest-value next step and return a concrete deliverable",
      executor: "mock",
      phase: "review",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workerPrompt: "test",
      structuredMode: "deepwork-implementer",
      role: "implementer",
      workerResult: {
        status: "ok",
        source: "executor",
        stdout: JSON.stringify({
          summary: "Created a host-applicable slugify artifact.",
          changes: "Provided complete slugify.js content.",
          risks: "Worker cannot write files directly.",
          status: "blocked",
          deliverable: "Create slugify.js with a slugify(input) function and inline assertions.",
          assumptions: ["Node.js is available"],
          nextStep: "Host agent should create slugify.js and run node slugify.js.",
        }),
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        parsed: {
          summary: "Created a host-applicable slugify artifact.",
          changes: "Provided complete slugify.js content.",
          risks: "Worker cannot write files directly.",
          status: "blocked",
          deliverable: "Create slugify.js with a slugify(input) function and inline assertions.",
          assumptions: ["Node.js is available"],
          nextStep: "Host agent should create slugify.js and run node slugify.js.",
        } as any,
      },
      review: { decision: "accept", summary: "accepted", issues: [], reviewedAt: new Date().toISOString() },
    } as WorkflowTask);

    assert.equal(phase, "host_apply_pending");
  });

  it("summarizes host-apply pending tasks separately from blocked tasks", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-host-apply-"));
    cleanupDirs.add(rootDir);
    const mockScriptPath = path.join(rootDir, "host-apply-worker.js");
    await fs.writeFile(mockScriptPath, [
      "process.stdout.write(JSON.stringify({",
      "  summary: 'Created a host-applicable slugify artifact.',",
      "  changes: 'Provided complete slugify.js content.',",
      "  risks: 'Worker cannot write files directly.',",
      "  status: 'blocked',",
      "  deliverable: 'Create slugify.js with a slugify(input) function and inline assertions.',",
      "  assumptions: ['Node.js is available'],",
      "  nextStep: 'Host agent should create slugify.js and run node slugify.js.'",
      "}));",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          timeoutMs: 5000,
        },
      },
    };

    const batch = await runTaskBatch(
      rootDir,
      ["Ship slugify - implement the highest-value next step and return a concrete deliverable"],
      "mock",
      config,
      "parallel",
    );

    assert.equal(batch.phase, "partial");
    assert.equal(batch.tasks[0]?.phase, "host_apply_pending");
    assert.equal(batch.summary?.blocked, 0);
    assert.equal((batch.summary as any)?.hostApplyPending, 1);
    assert.equal(batch.summary?.nextSteps.some((step) => /host agent|apply/i.test(step)), true);
  });
});


describe("regression: resolveTaskPhase terminal state contract", () => {
  it("resolves to blocked when parsed.status=blocked even with accept review (Fix 1)", () => {
    const phase = resolveTaskPhase({
      id: "test",
      goal: "Test",
      executor: "mock",
      phase: "review",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workerPrompt: "test",
      structuredMode: "deepwork-implementer",
      role: "implementer" as const,
      workerResult: {
        status: "ok" as const,
        source: "executor",
        stdout: JSON.stringify({ summary: "x", changes: "y", risks: "z", status: "blocked", deliverable: "", assumptions: ["a"], nextStep: "n" }),
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        parsed: { summary: "x", changes: "y", risks: "z", status: "blocked" },
      },
      review: { decision: "accept" as const, summary: "accepted", issues: [], reviewedAt: new Date().toISOString() },
    } as WorkflowTask);
    assert.equal(phase, "blocked", "resolveTaskPhase must return blocked when parsed.status=blocked");
  });

  it("resolves to blocked when review does not accept (no more non-terminal 'review' state) (Fix 2)", () => {
    const phase = resolveTaskPhase({
      id: "test",
      goal: "Test",
      executor: "mock",
      phase: "review",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workerPrompt: "test",
      structuredMode: "deepwork-planner",
      role: "planner" as const,
      workerResult: {
        status: "ok" as const,
        source: "fallback-synthesized",
        stdout: JSON.stringify({ summary: "x", changes: "y", risks: "z", status: "ok" }),
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        parsed: { summary: "x", changes: "y", risks: "z", status: "ok" },
      },
      review: { decision: "retry" as const, summary: "needs retry", issues: ["invalid"], reviewedAt: new Date().toISOString() },
    } as WorkflowTask);
    assert.equal(phase, "blocked", "resolveTaskPhase must return blocked when review does not accept");
  });

  it("resolves fallback-synthesized results to blocked even when review accepts", () => {
    const phase = resolveTaskPhase({
      id: "test",
      goal: "Test - produce a short implementation plan",
      executor: "mock",
      phase: "review",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workerPrompt: "test",
      structuredMode: "deepwork-planner",
      role: "planner" as const,
      workerResult: {
        status: "ok" as const,
        source: "fallback-synthesized",
        stdout: JSON.stringify({
          summary: "fallback",
          changes: "local handoff",
          risks: "no executor evidence",
          status: "ok",
          goal: "Test",
          assumptions: ["none"],
          steps: ["retry with another executor"],
        }),
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        parsed: {
          summary: "fallback",
          changes: "local handoff",
          risks: "no executor evidence",
          status: "ok",
          goal: "Test",
          assumptions: ["none"],
          steps: ["retry with another executor"],
        },
      },
      review: { decision: "accept" as const, summary: "accepted", issues: [], reviewedAt: new Date().toISOString() },
    } as WorkflowTask);

    assert.equal(phase, "blocked", "fallback-synthesized is diagnostic only and must not count as completed");
  });

  it("review rejects fallback-synthesized structured payloads", () => {
    const fallback = synthesizeStructuredFallback({
      goal: "Ship a health endpoint - produce a short implementation plan",
      role: "planner",
      structuredMode: "deepwork-planner",
    });
    assert.ok(fallback);

    const review = reviewWorkerResultForMode({
      status: "ok",
      source: "fallback-synthesized",
      stdout: JSON.stringify(fallback),
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
      parsed: fallback,
    }, "schema", "deepwork-planner");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /no executor evidence|fallback/i);
  });

  it("resolves to blocked for non-structured delegated task with blocked JSON payload (Fix non-structured)", () => {
    const phase = resolveTaskPhase({
      id: "test",
      goal: "Test",
      executor: "mock",
      phase: "review",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workerPrompt: "test",
      // No structuredMode — simulates a non-structured delegated task
      workerResult: {
        status: "ok" as const,
        source: "executor",
        stdout: JSON.stringify({ summary: "done", changes: "none", risks: "n/a", status: "blocked" }),
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        parsed: { summary: "done", changes: "none", risks: "n/a", status: "blocked" },
      },
      // review would accept valid JSON, but resolveTaskPhase vetoes on parsed.status="blocked"
      review: { decision: "accept" as const, summary: "accepted", issues: [], reviewedAt: new Date().toISOString() },
    } as WorkflowTask);
    assert.equal(phase, "blocked",
      "Non-structured delegated task with blocked payload must resolve to blocked, not completed");
  });
});

describe("inferDeepworkRole", () => {
  it("infers planner from standard suffix", () => {
    assert.equal(inferDeepworkRole("Ship a health endpoint - produce a short implementation plan"), "planner");
  });

  it("infers implementer from implement suffix", () => {
    assert.equal(inferDeepworkRole("Ship a health endpoint - implement the highest-value next step and return a concrete deliverable"), "implementer");
  });

  it("infers implementer from execute suffix (legacy variant)", () => {
    assert.equal(inferDeepworkRole("Ship a health endpoint - execute the highest-value next step"), "implementer");
  });

  it("returns undefined for non-deepwork goals", () => {
    assert.equal(inferDeepworkRole("Add a hello endpoint"), undefined);
  });
});

describe("deepwork task creation without route", () => {
  it("assigns planner role and structuredMode for planner goal without route", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-no-route-"));
    cleanupDirs.add(rootDir);
    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: { mock: { command: "mock", args: [] } },
    };
    const task = await createTask(
      rootDir,
      "Ship a health endpoint - produce a short implementation plan",
      "mock",
      config,
    );
    assert.equal(task.role, "planner");
    assert.equal(task.structuredMode, "deepwork-planner");
    assert.equal(task.expectedOutput, "schema");
    assert.match(task.workerPrompt, /"goal":"string"/);
    assert.match(task.workerPrompt, /"steps":\[/);
  });

  it("assigns implementer role and structuredMode for implementer goal without route", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-no-route-"));
    cleanupDirs.add(rootDir);
    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: { mock: { command: "mock", args: [] } },
    };
    const task = await createTask(
      rootDir,
      "Ship a health endpoint - implement the highest-value next step and return a concrete deliverable",
      "mock",
      config,
    );
    assert.equal(task.role, "implementer");
    assert.equal(task.structuredMode, "deepwork-implementer");
    assert.equal(task.expectedOutput, "schema");
    assert.match(task.workerPrompt, /"deliverable":"string"/);
    assert.match(task.workerPrompt, /"nextStep":"string"/);
  });

  it("prefers route role over inferred role", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-route-priority-"));
    cleanupDirs.add(rootDir);
    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: { mock: { command: "mock", args: [] } },
    };
    const route: RouteDecision = {
      goal: "Ship a health endpoint - produce a short implementation plan",
      profile: "test",
      executor: "mock",
      fallbackExecutors: [],
      role: "architect",
      complexity: "high",
      reason: "test",
      attemptedExecutors: ["mock"],
    };
    const task = await createTask(
      rootDir,
      route.goal,
      "mock",
      config,
      route,
    );
    assert.equal(task.role, "architect");
  });

  it("does not infer role for non-deepwork goals", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-no-infer-"));
    cleanupDirs.add(rootDir);
    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: { mock: { command: "mock", args: [], artifactMode: "text" } },
    };
    const task = await createTask(
      rootDir,
      "Add a hello endpoint",
      "mock",
      config,
    );
    assert.equal(task.role, undefined);
    assert.equal(task.structuredMode, undefined);
  });
});

describe("deepwork batch integration without route", () => {
  it("creates correct structuredMode and prompt for proactive-decomposition goals without auto-route", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-batch-integ-"));
    cleanupDirs.add(rootDir);
    const mockScriptPath = path.join(rootDir, "mock-executor.js");
    await fs.writeFile(mockScriptPath, [
      "process.stdout.write(JSON.stringify({",
      "  summary: 'done',",
      "  changes: 'none',",
      "  risks: 'none',",
      "  status: 'ok'",
      "}));",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          artifactMode: "text",
          timeoutMs: 5000,
        },
      },
    };

    const plannerGoal = "Smoke deepwork flow - produce a short implementation plan";
    const implementerGoal = "Smoke deepwork flow - implement the highest-value next step and return a concrete deliverable";

    const plannerTask = await createTask(rootDir, plannerGoal, "mock", config);
    const implementerTask = await createTask(rootDir, implementerGoal, "mock", config);

    assert.equal(plannerTask.role, "planner", "planner task must have role=planner without route");
    assert.equal(plannerTask.structuredMode, "deepwork-planner", "planner task must have structuredMode=deepwork-planner without route");
    assert.match(plannerTask.workerPrompt, /"goal":"string"/,
      "planner prompt must contain deepwork planner schema");
    assert.match(plannerTask.workerPrompt, /"steps":\[/,
      "planner prompt must contain steps array in schema");

    assert.equal(implementerTask.role, "implementer", "implementer task must have role=implementer without route");
    assert.equal(implementerTask.structuredMode, "deepwork-implementer", "implementer task must have structuredMode=deepwork-implementer without route");
    assert.match(implementerTask.workerPrompt, /"deliverable":"string"/,
      "implementer prompt must contain deepwork implementer schema");
    assert.match(implementerTask.workerPrompt, /"nextStep":"string"/,
      "implementer prompt must contain nextStep in schema");
  });

  it("injects completed planner context into the following serial implementer task", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-planner-context-"));
    cleanupDirs.add(rootDir);
    const mockScriptPath = path.join(rootDir, "planner-context-worker.js");
    await fs.writeFile(mockScriptPath, [
      "const prompt = process.argv[2] ?? '';",
      "if (prompt.includes('produce a short implementation plan')) {",
      "  process.stdout.write(JSON.stringify({",
      "    summary: 'Use TypeScript for slugify.',",
      "    changes: 'Plan src/utils/slugify.ts and tests/slugify.test.ts.',",
      "    risks: 'none',",
      "    status: 'ok',",
      "    goal: 'Ship slugify',",
      "    assumptions: ['Project uses TypeScript'],",
      "    steps: ['Create src/utils/slugify.ts', 'Create tests/slugify.test.ts']",
      "  }));",
      "} else if (prompt.includes('Planner context') && prompt.includes('src/utils/slugify.ts')) {",
      "  process.stdout.write(JSON.stringify({",
      "    summary: 'Prepared TypeScript slugify artifact.',",
      "    changes: 'Used planner path and language.',",
      "    risks: 'Worker cannot write files directly.',",
      "    status: 'blocked',",
      "    deliverable: 'Create src/utils/slugify.ts and tests/slugify.test.ts.',",
      "    assumptions: ['Project uses TypeScript'],",
      "    nextStep: 'Host agent should apply the TypeScript files.'",
      "  }));",
      "} else {",
      "  process.stdout.write(JSON.stringify({",
      "    summary: 'Planner context missing.',",
      "    changes: 'No implementation artifact.',",
      "    risks: 'Implementer did not receive planner output.',",
      "    status: 'blocked',",
      "    deliverable: '',",
      "    assumptions: ['Unknown project language'],",
      "    nextStep: 'Retry with planner context.'",
      "  }));",
      "}",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          timeoutMs: 5000,
        },
      },
    };

    const batch = await runTaskBatch(
      rootDir,
      [
        "Ship slugify - produce a short implementation plan",
        "Ship slugify - implement the highest-value next step and return a concrete deliverable",
      ],
      "mock",
      config,
      "serial",
    );

    assert.equal(batch.tasks[0]?.phase, "completed");
    assert.equal(batch.tasks[1]?.phase, "host_apply_pending");
    assert.match(batch.tasks[1]?.workerPrompt ?? "", /Planner context/i);
    assert.match(batch.tasks[1]?.workerPrompt ?? "", /src\/utils\/slugify\.ts/i);
  });

  it("blocks a serial implementer when the preceding planner did not complete", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-planner-gate-"));
    cleanupDirs.add(rootDir);
    const mockScriptPath = path.join(rootDir, "planner-gate-worker.js");
    const implementerCalledPath = path.join(rootDir, "implementer-called.txt");
    await fs.writeFile(mockScriptPath, [
      "const fs = require('node:fs');",
      "const prompt = process.argv[2] ?? '';",
      "if (prompt.includes('produce a short implementation plan')) {",
      "  process.stdout.write(JSON.stringify({",
      "    summary: 'Planner cannot proceed.',",
      "    changes: 'No plan produced.',",
      "    risks: 'Missing project context.',",
      "    status: 'blocked',",
      "    goal: 'Ship slugify',",
      "    assumptions: ['Unknown project language'],",
      "    steps: ['Retry planner with context']",
      "  }));",
      "} else {",
      `  fs.writeFileSync(${JSON.stringify(implementerCalledPath)}, 'called');`,
      "  process.stdout.write(JSON.stringify({",
      "    summary: 'Implementer should not run.',",
      "    changes: 'Unexpected execution.',",
      "    risks: 'Dependency gate failed.',",
      "    status: 'blocked',",
      "    deliverable: 'unexpected',",
      "    assumptions: ['none'],",
      "    nextStep: 'fix gate'",
      "  }));",
      "}",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          timeoutMs: 5000,
        },
      },
    };

    const batch = await runTaskBatch(
      rootDir,
      [
        "Ship slugify - produce a short implementation plan",
        "Ship slugify - implement the highest-value next step and return a concrete deliverable",
      ],
      "mock",
      config,
      "serial",
    );

    assert.equal(batch.tasks[0]?.phase, "blocked");
    assert.equal(batch.tasks[1]?.phase, "blocked");
    await assert.rejects(fs.access(implementerCalledPath));
    assert.match(batch.tasks[1]?.review?.summary ?? "", /planner/i);
  });
});

describe("delegated payload uses task.role", () => {
  it("single codex-mode task delegates instead of invoking the CLI executor", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-single-delegated-"));
    cleanupDirs.add(rootDir);
    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('this CLI should not run')"],
          artifactMode: "text",
          timeoutMs: 5000,
        },
      },
    };

    const task = await createTask(
      rootDir,
      "Ship a health endpoint",
      "mock",
      config,
      undefined,
      { execMode: "codex" },
    );

    const delegatedTask = await runTask(rootDir, task, config);

    assert.equal(delegatedTask.phase, "delegated_to_codex");
    assert.equal(delegatedTask.workerResult?.status, "delegated");
    assert.equal(delegatedTask.workerResult?.source, "delegated");
    const payload = JSON.parse(delegatedTask.workerResult!.stdout) as Record<string, unknown>;
    assert.equal(payload.action, "codex_subagent_required");
    assert.equal(payload.goal, "Ship a health endpoint");
    assert.equal(payload.taskId, task.id);
  });

  it("delegated planner goal without route carries role=planner, not implementer", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-delegated-role-"));
    cleanupDirs.add(rootDir);
    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: { mock: { command: "mock", args: [] } },
    };

    const batch = await runTaskBatch(
      rootDir,
      ["Ship a health endpoint - produce a short implementation plan"],
      "mock",
      config,
      "parallel",
      undefined,
      { execMode: "codex" },
    );

    const delegatedTask = batch.tasks[0];
    assert.equal(delegatedTask?.phase, "delegated_to_codex");
    assert.equal(delegatedTask?.role, "planner", "task.role must be planner from deepwork suffix inference");
    const payload = JSON.parse(delegatedTask.workerResult!.stdout) as Record<string, unknown>;
    assert.equal(payload.role, "planner",
      "delegated payload role must be planner, not fallback implementer");
  });

  it("delegated implementer goal without route carries role=implementer", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-delegated-role-"));
    cleanupDirs.add(rootDir);
    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: { mock: { command: "mock", args: [] } },
    };

    const batch = await runTaskBatch(
      rootDir,
      ["Ship a health endpoint - implement the highest-value next step and return a concrete deliverable"],
      "mock",
      config,
      "parallel",
      undefined,
      { execMode: "codex" },
    );

    const delegatedTask = batch.tasks[0];
    assert.equal(delegatedTask?.phase, "delegated_to_codex");
    assert.equal(delegatedTask?.role, "implementer");
    const payload = JSON.parse(delegatedTask.workerResult!.stdout) as Record<string, unknown>;
    assert.equal(payload.role, "implementer",
      "delegated payload role must be implementer");
  });
});

describe("ruleforge fence gate", () => {
  async function createMockFenceBin(rootDir: string, script: string): Promise<string> {
    const binPath = path.join(rootDir, "mock-fence.js");
    await fs.writeFile(binPath, script, "utf8");
    return `node ${binPath.replace(/\\/g, "/")}`;
  }

  it("blocks task with denied path before executor runs", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fence-deny-"));
    cleanupDirs.add(rootDir);

    const mockFenceBin = await createMockFenceBin(rootDir, [
      "const ctxPath = process.argv[process.argv.indexOf('--context') + 1];",
      "const ctx = JSON.parse(require('fs').readFileSync(ctxPath, 'utf8'));",
      "const isDenied = ctx.file_paths?.some(p => p.startsWith('dist/'));",
      "const decision = isDenied",
      "  ? { format:'synaptor-v1', type:'fence_decision', task_id:ctx.task_id, severity:'blocking', action:'deny', rule_id:'denied_paths_block', scale_tier:'single', reason:'denied path' }",
      "  : { format:'synaptor-v1', type:'fence_decision', task_id:ctx.task_id, severity:'info', action:'allow', rule_id:'all_passed', scale_tier:'single', reason:'ok' };",
      "process.stdout.write(JSON.stringify(decision));",
    ].join("\n"));

    process.env.RULEFORGE_FENCE_ENABLED = "true";
    process.env.RULEFORGE_FENCE_BIN = mockFenceBin;

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: ["-e", "process.stdout.write('should not run')"],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const task = await createTask(rootDir, "Modify dist/bundle.js to fix a build error", "mock", config);
    const completed = await runTask(rootDir, task, config);

    assert.equal(completed.phase, "blocked", "task must be blocked by fence gate");
    assert.equal(completed.workerResult?.status, "failed", "workerResult.status must be failed");
    assert.ok(
      completed.workerResult?.stderr.includes("[fence-gate]"),
      "stderr must contain fence-gate marker",
    );
    assert.ok(
      completed.workerResult?.stderr.includes("denied_paths_block"),
      "stderr must mention denied_paths_block",
    );
    assert.equal(completed.review?.decision, "reject", "review must reject");
  });

  it("blocks task with require_split before executor runs", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fence-split-"));
    cleanupDirs.add(rootDir);

    const mockFenceBin = await createMockFenceBin(rootDir, [
      "const ctxPath = process.argv[process.argv.indexOf('--context') + 1];",
      "const ctx = JSON.parse(require('fs').readFileSync(ctxPath, 'utf8'));",
      "const isOversized = ctx.file_count >= 20;",
      "const decision = isOversized",
      "  ? { format:'synaptor-v1', type:'fence_decision', task_id:ctx.task_id, severity:'blocking', action:'require_split', rule_id:'scale_limit_split', scale_tier:'oversized', reason:'too many files' }",
      "  : { format:'synaptor-v1', type:'fence_decision', task_id:ctx.task_id, severity:'info', action:'allow', rule_id:'all_passed', scale_tier:'single', reason:'ok' };",
      "process.stdout.write(JSON.stringify(decision));",
    ].join("\n"));

    process.env.RULEFORGE_FENCE_ENABLED = "true";
    process.env.RULEFORGE_FENCE_BIN = mockFenceBin;

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: ["-e", "process.stdout.write('should not run')"],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const goals = [
      "Modify src/file01.ts, src/file02.ts, src/file03.ts, src/file04.ts, src/file05.ts, src/file06.ts, src/file07.ts, src/file08.ts, src/file09.ts, src/file10.ts, src/file11.ts, src/file12.ts, src/file13.ts, src/file14.ts, src/file15.ts, src/file16.ts, src/file17.ts, src/file18.ts, src/file19.ts, src/file20.ts, src/file21.ts, src/file22.ts, src/file23.ts, src/file24.ts, src/file25.ts",
    ];

    const task = await createTask(rootDir, goals[0], "mock", config);
    const completed = await runTask(rootDir, task, config);

    assert.equal(completed.phase, "blocked", "task must be blocked by fence gate");
    assert.equal(completed.workerResult?.status, "failed", "workerResult.status must be failed");
    assert.ok(
      completed.workerResult?.stderr.includes("[fence-gate]"),
      "stderr must contain fence-gate marker",
    );
    assert.ok(
      completed.workerResult?.stderr.includes("require_split"),
      "stderr must mention require_split",
    );
  });

  it("allows task with safe path to proceed to executor", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fence-allow-"));
    cleanupDirs.add(rootDir);

    const mockFenceBin = await createMockFenceBin(rootDir, [
      "process.stdout.write(JSON.stringify({ format:'synaptor-v1', type:'fence_decision', task_id:'x', severity:'info', action:'allow', rule_id:'all_passed', scale_tier:'single', reason:'ok' }));",
    ].join("\n"));

    process.env.RULEFORGE_FENCE_ENABLED = "true";
    process.env.RULEFORGE_FENCE_BIN = mockFenceBin;

    const mockScriptPath = path.join(rootDir, "passing-executor.js");
    await fs.writeFile(mockScriptPath, [
      "process.stdout.write('1. Deliverable\\nA utility function for slug generation.\\n\\n2. Assumptions\\nThe function will be placed in src/utils/slug.ts.\\n\\n3. Next step\\nDone.');",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const task = await createTask(rootDir, "Add a tiny utility function in src/utils/slug.ts", "mock", config);
    const completed = await runTask(rootDir, task, config);

    assert.equal(completed.phase, "completed", "task must complete (fence allows)");
    assert.equal(completed.workerResult?.status, "ok", "workerResult.status must be ok");
  });

  it("blocks codex-delegated task with denied path before delegation", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fence-codex-"));
    cleanupDirs.add(rootDir);

    const mockFenceBin = await createMockFenceBin(rootDir, [
      "const ctxPath = process.argv[process.argv.indexOf('--context') + 1];",
      "const ctx = JSON.parse(require('fs').readFileSync(ctxPath, 'utf8'));",
      "const isDenied = ctx.file_paths?.some(p => p.startsWith('dist/'));",
      "const decision = isDenied",
      "  ? { format:'synaptor-v1', type:'fence_decision', task_id:ctx.task_id, severity:'blocking', action:'deny', rule_id:'denied_paths_block', scale_tier:'single', reason:'denied path' }",
      "  : { format:'synaptor-v1', type:'fence_decision', task_id:ctx.task_id, severity:'info', action:'allow', rule_id:'all_passed', scale_tier:'single', reason:'ok' };",
      "process.stdout.write(JSON.stringify(decision));",
    ].join("\n"));

    process.env.RULEFORGE_FENCE_ENABLED = "true";
    process.env.RULEFORGE_FENCE_BIN = mockFenceBin;

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: ["-e", "process.stdout.write('should not run')"],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const task = await createTask(rootDir, "Modify dist/bundle.js", "mock", config);
    task.execMode = "codex";
    const completed = await runTask(rootDir, task, config);

    assert.equal(completed.phase, "blocked", "codex task must be blocked by fence gate");
    assert.equal(completed.workerResult?.status, "failed");
    assert.ok(completed.workerResult?.stderr.includes("denied_paths_block"));
  });

  it("runTaskBatch goes through fence gate", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fence-batch-"));
    cleanupDirs.add(rootDir);

    const mockFenceBin = await createMockFenceBin(rootDir, [
      "const ctxPath = process.argv[process.argv.indexOf('--context') + 1];",
      "const ctx = JSON.parse(require('fs').readFileSync(ctxPath, 'utf8'));",
      "const isDenied = ctx.file_paths?.some(p => p.startsWith('dist/'));",
      "const decision = isDenied",
      "  ? { format:'synaptor-v1', type:'fence_decision', task_id:ctx.task_id, severity:'blocking', action:'deny', rule_id:'denied_paths_block', scale_tier:'single', reason:'denied path' }",
      "  : { format:'synaptor-v1', type:'fence_decision', task_id:ctx.task_id, severity:'info', action:'allow', rule_id:'all_passed', scale_tier:'single', reason:'ok' };",
      "process.stdout.write(JSON.stringify(decision));",
    ].join("\n"));

    process.env.RULEFORGE_FENCE_ENABLED = "true";
    process.env.RULEFORGE_FENCE_BIN = mockFenceBin;

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: ["-e", "process.stdout.write('ok')"],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const batch = await runTaskBatch(
      rootDir,
      ["Modify dist/bundle.js to fix a build error"],
      "mock",
      config,
      "serial",
    );

    const task = batch.tasks[0];
    assert.equal(task.phase, "blocked", "batch task must be blocked by fence gate");
    assert.ok(task.workerResult?.stderr.includes("denied_paths_block"));
  });

  it("skips fence when RULEFORGE_FENCE_ENABLED and RULEFORGE_FENCE_BIN are unset", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fence-auto-"));
    cleanupDirs.add(rootDir);

    delete process.env.RULEFORGE_FENCE_ENABLED;
    delete process.env.RULEFORGE_FENCE_BIN;

    const mockScriptPath = path.join(rootDir, "passing-executor.js");
    await fs.writeFile(mockScriptPath, [
      "process.stdout.write('1. Deliverable\\nDone.\\n\\n2. Assumptions\\nNone.\\n\\n3. Next step\\nNone.');",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const task = await createTask(rootDir, "Modify dist/bundle.js", "mock", config);
    const completed = await runTask(rootDir, task, config);

    assert.equal(completed.phase, "completed", "task must complete when fence auto-skips");
    assert.equal(completed.workerResult?.status, "ok");
    assert.ok(!completed.workerResult?.stderr.includes("[fence-gate]"), "stderr must not contain fence-gate marker");
  });

  it("fail-closed when RULEFORGE_FENCE_ENABLED=true but no bin", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fence-forced-"));
    cleanupDirs.add(rootDir);

    process.env.RULEFORGE_FENCE_ENABLED = "true";
    delete process.env.RULEFORGE_FENCE_BIN;

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: ["-e", "process.stdout.write('should not run')"],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const task = await createTask(rootDir, "Add src/utils/slug.ts", "mock", config);
    const completed = await runTask(rootDir, task, config);

    assert.equal(completed.phase, "blocked", "task must be blocked when forced but no bin");
    assert.equal(completed.workerResult?.status, "failed");
    assert.ok(completed.workerResult?.stderr.includes("fence_unavailable"));
  });

  it("skips fence when RULEFORGE_FENCE_ENABLED=false even with deny mock", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-fence-disabled-"));
    cleanupDirs.add(rootDir);

    const mockFenceBin = await createMockFenceBin(rootDir, [
      "process.stdout.write(JSON.stringify({ format:'synaptor-v1', type:'fence_decision', task_id:'x', severity:'blocking', action:'deny', rule_id:'denied_paths_block', scale_tier:'single', reason:'denied' }));",
    ].join("\n"));

    process.env.RULEFORGE_FENCE_ENABLED = "false";
    process.env.RULEFORGE_FENCE_BIN = mockFenceBin;

    const mockScriptPath = path.join(rootDir, "passing-executor.js");
    await fs.writeFile(mockScriptPath, [
      "process.stdout.write('1. Deliverable\\nDone.\\n\\n2. Assumptions\\nNone.\\n\\n3. Next step\\nNone.');",
    ].join("\n"), "utf8");

    const config: WorkflowConfig = {
      defaultExecutor: "mock",
      executors: {
        mock: {
          command: "node",
          args: [mockScriptPath],
          artifactMode: "text" as const,
          timeoutMs: 5000,
        },
      },
    };

    const task = await createTask(rootDir, "Modify dist/bundle.js", "mock", config);
    const completed = await runTask(rootDir, task, config);

    assert.equal(completed.phase, "completed", "task must complete when fence disabled");
    assert.equal(completed.workerResult?.status, "ok");
  });
});
