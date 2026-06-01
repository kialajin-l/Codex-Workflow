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
import { expectedOutputMode, reviewWorkerResultForMode } from "./review.js";
import { saveBatch, saveTask } from "./store.js";
import { summarizeBatch } from "./summarize.js";

type LoadedWorkflowHooks = {
  taskDispatchHook: Awaited<ReturnType<typeof loadHooks>>[number] | undefined;
  afterResultHook: Awaited<ReturnType<typeof loadHooks>>[number] | undefined;
  reviewAfterHook: Awaited<ReturnType<typeof loadHooks>>[number] | undefined;
  skillsDir: string;
};

type TaskExecutionOverrides = {
  execMode?: "cli" | "codex";
};

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
  if (expected === "artifact") {
    return [
      "Retry.",
      ...buildArtifactInstructions(goal, role),
      `Task: ${goal}`,
    ].join("\n");
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
  const expectedOutput = expectedOutputMode(config.executors[executorName]?.artifactMode);
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

  for (const executorName of executorsToTry) {
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

    task.workerResult = await runExecutor(
      executor,
      task.workerPrompt,
      buildRetryPrompt(task.goal, task.expectedOutput ?? expectedOutputMode(executor.artifactMode), task.role),
    );
    task.phase = "review";
    task.updatedAt = new Date().toISOString();
    await saveTask(rootDir, task);

    task.review = reviewWorkerResultForMode(
      task.workerResult,
      task.expectedOutput ?? expectedOutputMode(executor.artifactMode),
    );

    if (task.review.decision === "accept") {
      task.phase = "completed";
      task.updatedAt = new Date().toISOString();
      await saveTask(rootDir, task);
      return task;
    }
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
