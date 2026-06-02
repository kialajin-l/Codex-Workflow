import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseWorkerPayload, reviewWorkerResultForMode } from "./review.js";
import type { RouteDecision, WorkflowConfig } from "./types.js";
import { loadBatch } from "./store.js";
import { buildRetryPrompt, buildWorkerPrompt, createTask, runTaskBatch, runTaskWithFallbacks, synthesizeStructuredFallback } from "./workflow.js";

const cleanupDirs = new Set<string>();

afterEach(async () => {
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
    assert.equal(payload.status, "ok");
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
    assert.ok(Array.isArray(record.steps));
  });

  it("synthesizes an implementer fallback payload", () => {
    const payload = synthesizeStructuredFallback({
      goal: "Ship a health endpoint - execute the highest-value next step",
      role: "implementer",
      structuredMode: "deepwork-implementer",
    });

    assert.ok(payload);
    assert.equal(payload.status, "ok");
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
          artifactMode: "text",
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
      complexity: "medium",
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
});

describe("batch persistence", () => {
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
          artifactMode: "text",
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
