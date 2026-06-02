import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { loadModelProfiles } from "./config.js";
import { summarizeBatchCost } from "./cost.js";
import {
  loadHooks,
  applyReviewAfterHook,
  applyTaskAfterResultHook,
  applyTaskDispatchHook,
  matchesWhen,
  resolveInjectSkill,
} from "./hooks.js";
import { logBatchEnd, logBatchStart, logTaskComplete } from "./logger.js";
import type { RouteDecision, WorkflowBatchResult, WorkflowConfig, WorkflowTask } from "./types.js";
import { runExecutor } from "./executor.js";
import { expectedOutputMode, extractJsonObject, parseStructuredWorkerPayload, reviewWorkerResultForMode } from "./review.js";
import { saveBatch, saveTask } from "./store.js";
import { summarizeBatch } from "./summarize.js";
import type { DeepworkImplementerResult, DeepworkPlannerResult } from "./types.js";

type LoadedWorkflowHooks = {
  taskDispatchHook: Awaited<ReturnType<typeof loadHooks>>[number] | undefined;
  afterResultHook: Awaited<ReturnType<typeof loadHooks>>[number] | undefined;
  reviewAfterHook: Awaited<ReturnType<typeof loadHooks>>[number] | undefined;
  skillsDir: string;
};

type TaskExecutionOverrides = {
  execMode?: "cli" | "codex";
};

type RecoveryAction =
  | { kind: "retry-same-executor"; timeoutMs?: number; prompt?: string; expectedOutput?: "schema" | "artifact" }
  | { kind: "switch-executor" }
  | { kind: "fallback" };

function isDeepworkStructuredGoal(goal: string): boolean {
  return / - produce a short implementation plan$| - execute the highest-value next step$/i.test(goal);
}

function deepworkSchemaForRole(role?: WorkflowTask["role"]): string | null {
  if (role === "planner") {
    return "{\"summary\":\"string\",\"changes\":\"string\",\"risks\":\"string\",\"status\":\"ok|blocked\",\"goal\":\"string\",\"assumptions\":[\"string\"],\"steps\":[\"string\"]}";
  }

  if (role === "implementer") {
    return "{\"summary\":\"string\",\"changes\":\"string\",\"risks\":\"string\",\"status\":\"ok|blocked\",\"deliverable\":\"string\",\"assumptions\":[\"string\"],\"nextStep\":\"string\"}";
  }

  return null;
}

function buildDeepworkSchemaInstructions(goal: string, role?: WorkflowTask["role"], retry = false): string[] {
  const schema = deepworkSchemaForRole(role);
  if (!schema) {
    return [];
  }

  const lines = [
    retry ? "Retry. Your previous answer did not satisfy the required JSON schema." : "Return exactly one JSON object.",
    "Output must be valid JSON.",
    "Do not wrap the JSON in markdown fences.",
    "Do not add any text before or after the JSON object.",
    "Do not include comments, placeholders, or explanatory notes.",
    "Every required field in the schema must be present exactly once.",
    "If you are unsure, make the smallest reasonable assumption and still fill every field.",
    "Arrays must contain at least one concrete string item.",
    "Use short, concrete strings. Do not leave fields empty.",
    "You do not have repository or filesystem access in this task.",
    "Do not claim to have inspected package.json, source files, configs, or local code.",
    "Do not invent repository contents or quote files you were not given.",
    `Schema: ${schema}`,
    `Task: ${goal}`,
  ];

  if (role === "planner") {
    lines.splice(lines.length - 2, 0,
      "For planner tasks: goal must restate the base goal without the suffix.",
      "For planner tasks: steps must be ordered implementation steps, not headings.",
    );
  }

  if (role === "implementer") {
    lines.splice(lines.length - 2, 0,
      "For implementer tasks: deliverable must describe the concrete next change.",
      "For implementer tasks: nextStep must be one immediate follow-up action.",
    );
  }

  return lines;
}

function deepworkStructuredModeForRole(role?: WorkflowTask["role"]): WorkflowTask["structuredMode"] {
  if (role === "planner") {
    return "deepwork-planner";
  }

  if (role === "implementer") {
    return "deepwork-implementer";
  }

  return undefined;
}

function stripDeepworkSuffix(goal: string): string {
  return goal
    .replace(/ - produce a short implementation plan$/i, "")
    .replace(/ - execute the highest-value next step$/i, "");
}

function isPureJsonObject(stdout: string): boolean {
  const trimmed = stdout
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function synthesizeStructuredFallback(task: Pick<WorkflowTask, "goal" | "role" | "structuredMode">): DeepworkPlannerResult | DeepworkImplementerResult | null {
  const baseGoal = stripDeepworkSuffix(task.goal);

  if (task.structuredMode === "deepwork-planner") {
    return {
      summary: `Created a minimal execution plan for ${baseGoal}.`,
      changes: "Produced assumptions and ordered implementation steps locally after worker schema failures.",
      risks: "This fallback plan is generic and should be refined against real repository context before execution.",
      status: "ok",
      goal: baseGoal,
      assumptions: [
        "A service or app already exists for this project goal.",
        "The change can be delivered incrementally without broad refactors.",
      ],
      steps: [
        `Define the narrowest implementation surface for ${baseGoal}.`,
        "Implement the smallest working change first.",
        "Add or update verification for the new behavior.",
      ],
    };
  }

  if (task.structuredMode === "deepwork-implementer") {
    return {
      summary: `Prepared a minimal implementer handoff for ${baseGoal}.`,
      changes: "Produced a concrete deliverable and next step locally after worker schema failures.",
      risks: "This fallback does not modify files and may need repository-specific adjustment before coding.",
      status: "ok",
      deliverable: `A minimal implementation slice for ${baseGoal}.`,
      assumptions: [
        "Existing project structure can accept a focused change for this goal.",
        "No cross-module migration is required for the first pass.",
      ],
      nextStep: `Implement the smallest valid change for ${baseGoal}, then run focused verification.`,
    };
  }

  return null;
}

function buildArtifactInstructions(goal: string, role?: WorkflowTask["role"]): string[] {
  const shared = [
    "Provide one concrete artifact in plain text.",
    "Do not ask follow-up questions.",
    "Do not ask what format to use.",
    "Do not say you need more context.",
    "Do not ask for clarification or ask the user to specify missing details.",
    "Make reasonable assumptions and proceed.",
    "You do not have repository or filesystem access in this task.",
    "Do not claim to have inspected package.json, source files, configs, or local code.",
    "Do not invent repository contents or quote files you were not given.",
    "Do not claim to have created, edited, saved, or updated files.",
    "No markdown fences.",
    "No explanation about your process.",
  ];

  if (role === "planner" || /implementation plan/i.test(goal)) {
    return [
      ...shared,
      "Output format:",
      "1. Goal",
      "2. Assumptions",
      "3. Steps",
      "4. Risks",
    ];
  }

  if (role === "reviewer" || /review|audit|check|inspect/i.test(goal)) {
    return [
      ...shared,
      "Output format:",
      "1. Verdict",
      "2. Findings",
      "3. Next step",
    ];
  }

  return [
    ...shared,
    "Output format:",
    "1. Deliverable",
    "2. Assumptions",
    "3. Next step",
  ];
}

function classifyRecoveryAction(
  task: WorkflowTask,
  executorName: string,
): RecoveryAction {
  const failure = task.workerResult?.failureCategory;

  if (failure === "timeout") {
    return {
      kind: "retry-same-executor",
      timeoutMs: Math.max(60000, 2 * 30000),
    };
  }

  if (
    task.structuredMode
    && (failure === "invalid-json" || failure === "invalid-structured-text")
  ) {
    return {
      kind: "retry-same-executor",
      expectedOutput: "artifact",
      prompt: [
        ...buildArtifactInstructions(task.goal, task.role),
        "Your previous JSON output was invalid.",
        "Return the same content as labeled plain text so it can be converted into structured fields.",
        `Task: ${task.goal}`,
      ].join("\n"),
    };
  }

  if (task.route && executorName !== task.route.fallbackExecutors.at(-1)) {
    return { kind: "switch-executor" };
  }

  return { kind: "fallback" };
}

async function executeAndReviewTaskAttempt(
  rootDir: string,
  task: WorkflowTask,
  executor: WorkflowConfig["executors"][string],
  prompt: string,
  expectedOutput: "schema" | "artifact",
): Promise<NonNullable<WorkflowTask["review"]>> {
  const reviewExpectedOutput = task.structuredMode && expectedOutput === "artifact"
    ? "schema"
    : expectedOutput;

  task.workerResult = await runExecutor(
    executor,
    prompt,
    buildRetryPrompt(task.goal, expectedOutput, task.role),
    expectedOutput,
    task.structuredMode,
  );
  task.workerResult.source = "executor";
  task.phase = "review";
  task.updatedAt = new Date().toISOString();
  await saveTask(rootDir, task);

  const structuredPayload = task.structuredMode
    ? parseStructuredWorkerPayload(task.workerResult.stdout, task.structuredMode)
    : null;
  if (structuredPayload) {
    task.workerResult.parsed = structuredPayload;
  }

  task.review = reviewWorkerResultForMode(
    task.workerResult,
    reviewExpectedOutput,
    task.structuredMode,
  );

  if (
    task.review.decision === "accept"
    && task.workerResult.parsed
    && !isPureJsonObject(task.workerResult.stdout)
  ) {
    task.workerResult.source = "executor-salvaged";
  }

  return task.review;
}

async function runParallelWithLimit(
  tasks: WorkflowTask[],
  limit: number,
  runner: (task: WorkflowTask) => Promise<WorkflowTask>,
): Promise<WorkflowTask[]> {
  if (limit <= 0 || limit >= tasks.length) {
    return Promise.all(tasks.map(runner));
  }

  const results: WorkflowTask[] = [];
  const queue = [...tasks];

  while (queue.length > 0) {
    const batch = queue.splice(0, limit);
    const batchResults = await Promise.all(batch.map(runner));
    results.push(...batchResults);

    if (queue.length > 0) {
      console.error(`[workflow] Batch progress: ${results.length}/${tasks.length} tasks completed`);
    }
  }

  return results;
}

export function buildWorkerPrompt(goal: string, expected: "schema" | "artifact", role?: WorkflowTask["role"]): string {
  const deepworkSchema = isDeepworkStructuredGoal(goal) ? deepworkSchemaForRole(role) : null;
  if (expected === "schema" && deepworkSchema) {
    return buildDeepworkSchemaInstructions(goal, role, false).join("\n");
  }

  if (expected === "artifact") {
    return [
      ...buildArtifactInstructions(goal, role),
      `Task: ${goal}`,
    ].join("\n");
  }

  return [
    "Return exactly one JSON object.",
    "No markdown. No explanation. No questions.",
    "Schema: {\"summary\":\"string\",\"changes\":\"string\",\"risks\":\"string\",\"status\":\"ok|blocked\"}",
    `Task: ${goal}`,
  ].join("\n");
}

export function buildRetryPrompt(goal: string, expected: "schema" | "artifact", role?: WorkflowTask["role"]): string {
  const deepworkSchema = isDeepworkStructuredGoal(goal) ? deepworkSchemaForRole(role) : null;
  if (expected === "schema" && deepworkSchema) {
    return buildDeepworkSchemaInstructions(goal, role, true).join("\n");
  }

  if (expected === "artifact") {
    const retryLines = [
      "Retry.",
      ...buildArtifactInstructions(goal, role),
    ];

    if (role === "implementer") {
      retryLines.push(
        "Only output the three labeled sections exactly once.",
        "Do not mention the workflow, retries, tasks, batches, logs, state, or existing files.",
        "Do not output tables, bullet lists, code blocks, file paths, or status summaries.",
        "Do not say you are retrying, checking, updating, or marking anything complete.",
        "Do not describe prior attempts or missing context.",
        "If you are unsure, still provide the smallest concrete Deliverable, Assumptions, and Next step.",
      );
    }

    retryLines.push(`Task: ${goal}`);
    return retryLines.join("\n");
  }

  return [
    "Retry.",
    "Return exactly one JSON object.",
    "No markdown. No explanation. No questions.",
    "Schema: {\"summary\":\"string\",\"changes\":\"string\",\"risks\":\"string\",\"status\":\"ok|blocked\"}",
    `Task: ${goal}`,
  ].join("\n");
}

export async function createTask(
  rootDir: string,
  goal: string,
  executorName: string,
  config: WorkflowConfig,
  route?: RouteDecision,
  overrides?: TaskExecutionOverrides,
): Promise<WorkflowTask> {
  const now = new Date().toISOString();
  const expectedOutput = isDeepworkStructuredGoal(goal)
    ? "schema"
    : expectedOutputMode(config.executors[executorName]?.artifactMode);
  const task: WorkflowTask = {
    id: crypto.randomUUID(),
    goal,
    executor: executorName,
    phase: "planned",
    createdAt: now,
    updatedAt: now,
    workerPrompt: buildWorkerPrompt(goal, expectedOutput, route?.role),
    expectedOutput,
    route,
    execMode: overrides?.execMode,
    role: route?.role,
    complexity: route?.complexity,
    structuredMode: isDeepworkStructuredGoal(goal) ? deepworkStructuredModeForRole(route?.role) : undefined,
  };
  await saveTask(rootDir, task);
  return task;
}

export async function runTaskWithFallbacks(
  rootDir: string,
  task: WorkflowTask,
  config: WorkflowConfig,
): Promise<WorkflowTask> {
  const executorsToTry = task.route
    ? [task.route.executor, ...task.route.fallbackExecutors]
    : [task.executor];

  const attemptedExecutors: string[] = [];

  for (let index = 0; index < executorsToTry.length; index += 1) {
    const executorName = executorsToTry[index];
    const executor = config.executors[executorName];
    if (!executor) {
      continue;
    }

    attemptedExecutors.push(executorName);
    task.executor = executorName;
    if (task.route) {
      task.route.attemptedExecutors = [...attemptedExecutors];
    }

    task.phase = "dispatched";
    task.updatedAt = new Date().toISOString();
    await saveTask(rootDir, task);

    const effectiveExecutor = { ...executor };
    const initialExpectedOutput = task.expectedOutput ?? expectedOutputMode(effectiveExecutor.artifactMode);
    const initialReview = await executeAndReviewTaskAttempt(
      rootDir,
      task,
      effectiveExecutor,
      task.workerPrompt,
      initialExpectedOutput,
    );

    if (initialReview.decision === "accept") {
      task.phase = "completed";
      task.updatedAt = new Date().toISOString();
      await saveTask(rootDir, task);
      return task;
    }

    const recovery = classifyRecoveryAction(task, executorName);
    if (recovery.kind === "retry-same-executor") {
      const recoveredExecutor = {
        ...effectiveExecutor,
        timeoutMs: recovery.timeoutMs ?? effectiveExecutor.timeoutMs,
      };
      const recoveryPrompt = recovery.prompt ?? task.workerPrompt;
      const recoveryExpectedOutput = recovery.expectedOutput ?? task.expectedOutput ?? expectedOutputMode(recoveredExecutor.artifactMode);

      const recoveryReview = await executeAndReviewTaskAttempt(
        rootDir,
        task,
        recoveredExecutor,
        recoveryPrompt,
        recoveryExpectedOutput,
      );

      if (recoveryReview.decision === "accept") {
        task.phase = "completed";
        task.updatedAt = new Date().toISOString();
        await saveTask(rootDir, task);
        return task;
      }
    }
  }

  const fallbackPayload = synthesizeStructuredFallback(task);
  if (fallbackPayload) {
    task.workerResult = {
      status: "ok",
      source: "fallback-synthesized",
      stdout: JSON.stringify(fallbackPayload),
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
      parsed: fallbackPayload,
    };
    task.review = reviewWorkerResultForMode(
      task.workerResult,
      task.expectedOutput ?? "schema",
      task.structuredMode,
    );
    task.phase = task.review.decision === "accept" ? "completed" : "blocked";
    task.updatedAt = new Date().toISOString();
    await saveTask(rootDir, task);
    return task;
  }

  task.phase = "blocked";
  task.updatedAt = new Date().toISOString();
  await saveTask(rootDir, task);
  return task;
}

export async function runTask(
  rootDir: string,
  task: WorkflowTask,
  config: WorkflowConfig,
): Promise<WorkflowTask> {
  return runTaskWithFallbacks(rootDir, task, config);
}

function summarizeBatchPhase(tasks: WorkflowTask[]): "completed" | "blocked" | "partial" {
  const hasBlocked = tasks.some((task) => task.phase === "blocked");
  const hasCompleted = tasks.some((task) => task.phase === "completed");
  const hasDelegated = tasks.some((task) => task.phase === "delegated_to_codex");

  if (hasBlocked && hasCompleted) {
    return "partial";
  }

  if (hasBlocked) {
    return "blocked";
  }

  if (hasDelegated && hasCompleted) {
    return "partial";
  }

  if (hasDelegated) {
    return "partial";
  }

  return "completed";
}

async function loadWorkflowRuntime(): Promise<LoadedWorkflowHooks> {
  const workflowDir = path.join(os.homedir(), ".codex", "codex-workflow");
  const hooks = await loadHooks(workflowDir);

  return {
    taskDispatchHook: hooks.find((hook) => hook.event === "task:before_dispatch"),
    afterResultHook: hooks.find((hook) => hook.event === "task:after_result"),
    reviewAfterHook: hooks.find((hook) => hook.event === "review:after"),
    skillsDir: path.join(workflowDir, "skills"),
  };
}

async function prepareTasksForExecution(
  rootDir: string,
  tasks: WorkflowTask[],
  taskDispatchHook: LoadedWorkflowHooks["taskDispatchHook"],
  skillsDir: string,
): Promise<WorkflowTask[]> {
  if (!taskDispatchHook) {
    return tasks;
  }

  return Promise.all(tasks.map(async (task) => {
    const updated = applyTaskDispatchHook(taskDispatchHook, task);
    for (const rule of taskDispatchHook.rules) {
      if (!matchesWhen(rule, updated) || !rule.then.inject_skill) {
        continue;
      }
      const skillContent = await resolveInjectSkill(rule.then, skillsDir);
      if (skillContent) {
        updated.workerPrompt = `${skillContent}\n\n${updated.workerPrompt}`;
      }
    }
    if (updated !== task) {
      updated.updatedAt = new Date().toISOString();
      await saveTask(rootDir, updated);
    }
    return updated;
  }));
}

function createDispatchedTaskRunner(
  rootDir: string,
  batchId: string,
  config: WorkflowConfig,
  afterResultHook: LoadedWorkflowHooks["afterResultHook"],
): (task: WorkflowTask) => Promise<WorkflowTask> {
  return async (task: WorkflowTask): Promise<WorkflowTask> => {
    if (task.execMode === "codex") {
      const now = new Date().toISOString();
      const delegatedTask: WorkflowTask = {
        ...task,
        phase: "delegated_to_codex",
        updatedAt: now,
        workerResult: {
          status: "delegated",
          source: "delegated",
          stdout: JSON.stringify({
            action: "codex_subagent_required",
            goal: task.goal,
            role: task.route?.role ?? "implementer",
            complexity: task.route?.complexity ?? "medium",
            taskId: task.id,
          }),
          stderr: "",
          exitCode: 0,
          startedAt: now,
          finishedAt: now,
          attempts: 1,
        },
      };
      await saveTask(rootDir, delegatedTask);
      await logTaskComplete(rootDir, batchId, delegatedTask.id, delegatedTask.phase).catch(() => {});
      return delegatedTask;
    }

    const completedTask = await runTaskWithFallbacks(rootDir, task, config);

    if (afterResultHook && completedTask.phase === "completed") {
      const afterResult = applyTaskAfterResultHook(afterResultHook, completedTask);
      if (afterResult.action === "block") {
        completedTask.phase = "blocked";
        completedTask.review = {
          decision: "reject",
          summary: afterResult.reason,
          issues: [afterResult.reason],
          reviewedAt: new Date().toISOString(),
        };
        completedTask.updatedAt = new Date().toISOString();
      }
    }

    await saveTask(rootDir, completedTask);
    await logTaskComplete(rootDir, batchId, completedTask.id, completedTask.phase).catch(() => {});
    return completedTask;
  };
}

export async function runTaskBatch(
  rootDir: string,
  goals: string[],
  executorName: string,
  config: WorkflowConfig,
  mode: "serial" | "parallel",
  routes?: RouteDecision[],
  overrides?: TaskExecutionOverrides,
): Promise<WorkflowBatchResult> {
  const startedAt = new Date().toISOString();
  const batchId = crypto.randomUUID();
  await logBatchStart(rootDir, batchId, goals).catch(() => {});
  const baseTasks = await Promise.all(
    goals.map((goal, index) => {
      const route = routes?.[index];
      return createTask(rootDir, goal, route?.executor ?? executorName, config, route, overrides);
    }),
  );
  const { taskDispatchHook, afterResultHook, reviewAfterHook, skillsDir } = await loadWorkflowRuntime();
  const tasks = await prepareTasksForExecution(rootDir, baseTasks, taskDispatchHook, skillsDir);
  await saveBatch(rootDir, {
    id: batchId,
    executor: executorName,
    mode,
    goals,
    startedAt,
    finishedAt: startedAt,
    phase: "partial",
    routes,
    tasks,
    summary: summarizeBatch(tasks),
  });
  const runDispatchedTask = createDispatchedTaskRunner(rootDir, batchId, config, afterResultHook);

  const completedTasks = mode === "parallel"
    ? await runParallelWithLimit(tasks, config.maxParallel ?? 0, runDispatchedTask)
    : await tasks.reduce<Promise<WorkflowTask[]>>(async (promise, task) => {
      const results = await promise;
      const completed = await runDispatchedTask(task);
      results.push(completed);
      return results;
    }, Promise.resolve([]));

  if (reviewAfterHook) {
    for (const task of completedTasks) {
      const result = applyReviewAfterHook(reviewAfterHook, task);
      if (result.notification) {
        console.error(`[workflow] ${result.notification}`);
      }
    }
  }

  const phase = summarizeBatchPhase(completedTasks);
  const summary = summarizeBatch(completedTasks);
  const profiles = await loadModelProfiles(rootDir).catch(() => undefined);
  const cost = profiles ? summarizeBatchCost(batchId, completedTasks, profiles) : undefined;

  const batch: WorkflowBatchResult = {
    id: batchId,
    executor: executorName,
    mode,
    goals,
    startedAt,
    finishedAt: new Date().toISOString(),
    phase,
    routes,
    tasks: completedTasks,
    summary,
    cost,
  };

  await saveBatch(rootDir, batch);
  const durationMs = Date.now() - new Date(startedAt).getTime();
  await logBatchEnd(rootDir, batch.id, batch.phase, durationMs).catch(() => {});
  return batch;
}

export async function resumeTaskBatch(
  rootDir: string,
  batch: WorkflowBatchResult,
  config: WorkflowConfig,
): Promise<WorkflowBatchResult> {
  const pendingTasks = batch.tasks.filter(
    (task) => task.phase !== "completed" && task.phase !== "blocked",
  );

  if (pendingTasks.length === 0) {
    return batch;
  }

  await logBatchStart(rootDir, batch.id, pendingTasks.map((task) => task.goal)).catch(() => {});
  const { taskDispatchHook, afterResultHook, reviewAfterHook, skillsDir } = await loadWorkflowRuntime();
  const preparedPendingTasks = await prepareTasksForExecution(rootDir, pendingTasks, taskDispatchHook, skillsDir);
  const runDispatchedTask = createDispatchedTaskRunner(rootDir, batch.id, config, afterResultHook);
  const retried = batch.mode === "parallel"
    ? await runParallelWithLimit(preparedPendingTasks, config.maxParallel ?? 0, runDispatchedTask)
    : await preparedPendingTasks.reduce<Promise<WorkflowTask[]>>(async (promise, task) => {
      const results = await promise;
      results.push(await runDispatchedTask(task));
      return results;
    }, Promise.resolve([]));

  if (reviewAfterHook) {
    for (const task of retried) {
      const result = applyReviewAfterHook(reviewAfterHook, task);
      if (result.notification) {
        console.error(`[workflow] ${result.notification}`);
      }
    }
  }

  const allTasks = batch.tasks.map((task) => {
    const updated = retried.find((retriedTask) => retriedTask.id === task.id);
    return updated ?? task;
  });
  const finishedAt = new Date().toISOString();
  const profiles = await loadModelProfiles(rootDir).catch(() => undefined);
  const updatedBatch: WorkflowBatchResult = {
    ...batch,
    tasks: allTasks,
    phase: summarizeBatchPhase(allTasks),
    finishedAt,
    summary: summarizeBatch(allTasks),
    cost: profiles ? summarizeBatchCost(batch.id, allTasks, profiles) : undefined,
  };

  await saveBatch(rootDir, updatedBatch);
  const durationMs = Date.now() - new Date(batch.startedAt).getTime();
  await logBatchEnd(rootDir, updatedBatch.id, updatedBatch.phase, durationMs).catch(() => {});
  return updatedBatch;
}
