import path from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { loadConfig, loadModelProfiles } from "./config.js";
import { expectedOutputMode, parseStructuredWorkerPayload, parseWorkerPayload, reviewWorkerResultForMode } from "./review.js";
import { ensureStateDir, loadBatch, loadTask, saveBatch, saveProbe, saveTask } from "./store.js";
import { preferExplicitExecutor, routeGoals, summarizeRouteMix } from "./router.js";
import { runExecutor } from "./executor.js";
import { createTask, resumeTaskBatch, runTask, runTaskBatch, resolveTaskPhase } from "./workflow.js";
import { ensureWorkflowConfigDirs, listWorkflowPresets, loadWorkflowPreset, saveWorkflowPreset, applyWorkflowPreset, hooksConfigDir } from "./workflow-config.js";
import { loadHooks } from "./hooks.js";
import { summarizeBatch } from "./summarize.js";
import { handleHello } from "./routes/hello.js";
import { buildDeepworkExecutionPlan, createDeepworkResponse, resolveDeepworkSelection } from "./deepwork.js";
import type { AutoProbeResult, ProbeResult, WorkerResult, WorkflowBatchResult, WorkflowTask } from "./types.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[token.slice(2)] = "true";
      } else {
        args[token.slice(2)] = next;
        i += 1;
      }
    }
  }
  return args;
}

function parseJsonText<T>(raw: string): T {
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
}

async function initProject(rootDir: string): Promise<void> {
  await ensureStateDir(rootDir);
  console.log(`Initialized workflow state at ${path.join(rootDir, ".workflow-state")}`);
}

async function runWorkflow(rootDir: string, args: Record<string, string>): Promise<void> {
  const goal = args.goal;
  if (!goal) {
    throw new Error("Missing required --goal");
  }

  const config = await loadConfig(rootDir);
  const executor = args.executor || config.defaultExecutor;

  let route;
  try {
    const [computed] = await routeGoals(rootDir, [goal], config, await loadModelProfiles(rootDir));
    route = preferExplicitExecutor(computed, executor);
  } catch {
    route = undefined;
  }

  const task = await createTask(rootDir, goal, executor, config, route);
  const completed = await runTask(rootDir, task, config);

  console.log(JSON.stringify(completed, null, 2));
}

async function showStatus(rootDir: string, args: Record<string, string>): Promise<void> {
  const batchId = args.batch;
  if (batchId) {
    const batch = await loadBatch(rootDir, batchId);
    console.log(JSON.stringify(batch, null, 2));
    return;
  }

  const id = args.id;
  if (!id) {
    throw new Error("Missing required --id or --batch");
  }
  const task = await loadTask(rootDir, id);
  console.log(JSON.stringify(task, null, 2));
}

async function probeExecutor(rootDir: string, args: Record<string, string>): Promise<void> {
  const config = await loadConfig(rootDir);
  const executorName = args.executor || config.defaultExecutor;
  const executor = config.executors[executorName];

  if (!executor) {
    throw new Error(`Unknown executor: ${executorName}`);
  }

  if (args.auto === "true" || args.auto === "1" || "auto" in args) {
    const attempts: ProbeResult[] = [];
    const prompt = executor.probePrompt ?? [
      "Return exactly one JSON object.",
      "No markdown. No explanation. No questions.",
      "Schema: {\"summary\":\"string\",\"changes\":\"string\",\"risks\":\"string\",\"status\":\"ok|blocked\"}",
      "Task: reply with a successful probe result.",
    ].join("\n");
    const probeExecutorConfig = {
      ...executor,
      timeoutMs: Math.max(executor.timeoutMs ?? 30000, 30000),
    };
    for (let index = 0; index < 3; index += 1) {
      const result = await runExecutor(probeExecutorConfig, prompt);
      attempts.push({
        executor: executorName,
        command: probeExecutorConfig.command,
        args: probeExecutorConfig.args,
        workerResult: result,
        review: reviewWorkerResultForMode(result, "schema"),
      });
    }

    const schemaSuccesses = attempts.filter((attempt) => attempt.review.decision === "accept").length;
    const recommendedArtifactMode = schemaSuccesses === attempts.length ? "schema" : "text";
    const autoProbe: AutoProbeResult = {
      executor: executorName,
      attempts,
      recommendedArtifactMode,
      schemaSuccesses,
      recordedAt: new Date().toISOString(),
    };
    await saveProbe(rootDir, autoProbe);

    const configPath = path.join(rootDir, "workflow.config.json");
    const current = parseJsonText<{
      defaultExecutor: string;
      executors: Record<string, Record<string, unknown>>;
    }>(await readFile(configPath, "utf8"));
    current.executors[executorName] = {
      ...current.executors[executorName],
      artifactMode: recommendedArtifactMode,
    };
    await writeFile(configPath, JSON.stringify(current, null, 2), "utf8");
    console.log(JSON.stringify(autoProbe, null, 2));
    return;
  }

  const prompt = executor.probePrompt ?? [
    "Return exactly one JSON object.",
    "No markdown. No explanation. No questions.",
    "Schema: {\"summary\":\"string\",\"changes\":\"string\",\"risks\":\"string\",\"status\":\"ok|blocked\"}",
    "Task: reply with a successful probe result.",
  ].join("\n");

  const result = await runExecutor(executor, prompt);
  const probe: ProbeResult = {
    executor: executorName,
    command: executor.command,
    args: executor.args,
    workerResult: result,
    review: reviewWorkerResultForMode(result, "schema"),
  };

  console.log(JSON.stringify(probe, null, 2));
}

async function demoSubagent(rootDir: string): Promise<void> {
  const config = await loadConfig(rootDir);
  const task = await createTask(
    rootDir,
    "Produce a short artifact about adding a hello-world endpoint",
    "opencode-serve",
    config,
  );
  const completed = await runTask(rootDir, task, config);
  console.log(JSON.stringify(completed, null, 2));
}

function splitGoals(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseGoalsFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runBatch(rootDir: string, args: Record<string, string>): Promise<void> {
  const config = await loadConfig(rootDir);
  const executorName = args.executor || config.defaultExecutor;
  const mode = args.mode === "serial" ? "serial" : "parallel";
  const autoRoute = args["auto-route"] === "true" || args["auto-route"] === "1" || "auto-route" in args;
  const goals = args.goals
    ? splitGoals(args.goals)
    : args["goals-file"]
      ? parseGoalsFile(await readFile(path.resolve(rootDir, args["goals-file"]), "utf8"))
      : [];

  if (goals.length === 0) {
    throw new Error("Missing required --goals or --goals-file");
  }

  const routes = autoRoute
    ? await routeGoals(rootDir, goals, config, await loadModelProfiles(rootDir))
    : undefined;

  if (routes) {
    console.error(`Auto-route selected: ${summarizeRouteMix(routes)}`);
    for (const route of routes) {
      console.error(`  ${route.goal} -> ${route.executor} (${route.reason})`);
    }
  }

  const batch = await runTaskBatch(rootDir, goals, executorName, config, mode, routes);
  const durationMs = Date.now() - new Date(batch.startedAt).getTime();
  console.error(`[workflow] Batch ${batch.id}: ${batch.phase}`);
  console.error(`[workflow]   Completed: ${batch.summary?.completed ?? 0}/${batch.tasks.length}`);
  console.error(`[workflow]   Blocked:   ${batch.summary?.blocked ?? 0}`);
  console.error(`[workflow]   Delegated: ${batch.summary?.delegated ?? 0}`);
  if (batch.summary?.nextSteps?.length) {
    for (const step of batch.summary.nextSteps) {
      console.error(`[workflow]   -> ${step}`);
    }
  }
  console.error(`[workflow]   Duration: ${(durationMs / 1000).toFixed(1)}s`);
  if (batch.cost) {
    console.error(`[workflow]   Est. cost: $${batch.cost.totalCostUSD.toFixed(6)}`);
  }
  console.log(JSON.stringify(batch, null, 2));
}

async function resumeBatch(rootDir: string, args: Record<string, string>): Promise<void> {
  const batchId = args.resume;
  if (!batchId) {
    throw new Error("Missing required --resume <batch-id>");
  }

  const batch = await loadBatch(rootDir, batchId);
  const config = await loadConfig(rootDir);
  const pendingTasks = batch.tasks.filter(
    (task) => task.phase !== "completed" && task.phase !== "blocked",
  );

  if (pendingTasks.length === 0) {
    console.log(JSON.stringify({
      message: "All tasks already completed or blocked",
      batch,
    }, null, 2));
    return;
  }

  console.error(`[workflow] Resuming ${pendingTasks.length} pending tasks from batch ${batch.id}`);
  const updatedBatch = await resumeTaskBatch(rootDir, batch, config);
  const durationMs = Date.now() - new Date(updatedBatch.startedAt).getTime();
  console.error(`[workflow] Batch ${updatedBatch.id}: ${updatedBatch.phase}`);
  console.error(`[workflow]   Completed: ${updatedBatch.summary?.completed ?? 0}/${updatedBatch.tasks.length}`);
  console.error(`[workflow]   Blocked:   ${updatedBatch.summary?.blocked ?? 0}`);
  console.error(`[workflow]   Delegated: ${updatedBatch.summary?.delegated ?? 0}`);
  if (updatedBatch.summary?.nextSteps?.length) {
    for (const step of updatedBatch.summary.nextSteps) {
      console.error(`[workflow]   -> ${step}`);
    }
  }
  console.error(`[workflow]   Duration: ${(durationMs / 1000).toFixed(1)}s`);
  if (updatedBatch.cost) {
    console.error(`[workflow]   Est. cost: $${updatedBatch.cost.totalCostUSD.toFixed(6)}`);
  }
  console.log(JSON.stringify(updatedBatch, null, 2));
}

async function saveWorkflow(rootDir: string, args: Record<string, string>): Promise<void> {
  const name = args.name;
  if (!name) {
    throw new Error("Missing required --name");
  }

  await ensureWorkflowConfigDirs();
  const hooks = await loadHooks(path.dirname(hooksConfigDir()));
  const preset = await saveWorkflowPreset(name, hooks);
  console.log(JSON.stringify(preset, null, 2));
}

async function loadWorkflow(_rootDir: string, args: Record<string, string>): Promise<void> {
  const name = args.name;
  if (!name) {
    throw new Error("Missing required --name");
  }

  const preset = await applyWorkflowPreset(name);
  console.log(JSON.stringify(preset, null, 2));
}

async function listWorkflows(): Promise<void> {
  const presets = await listWorkflowPresets();
  console.log(JSON.stringify(presets, null, 2));
}

async function showWorkflow(rootDir: string, args: Record<string, string>): Promise<void> {
  const name = args.name;
  if (!name) {
    throw new Error("Missing required --name");
  }

  const preset = await loadWorkflowPreset(name);
  console.log(JSON.stringify(preset, null, 2));
}

async function demoPair(rootDir: string, mode: "serial" | "parallel"): Promise<void> {
  const config = await loadConfig(rootDir);
  const goals = [
    "Produce a short plan for adding a hello endpoint",
    "Produce a short plan for adding a health endpoint",
    "Create a short artifact explaining how to use environment variables in a Next.js project",
  ];
  const batch: WorkflowBatchResult = await runTaskBatch(
    rootDir,
    goals,
    "opencode-serve",
    config,
    mode,
  );
  console.log(JSON.stringify(batch, null, 2));
}

function resolveRootDir(): string {
  const callerDir = process.env.CODEX_WORKFLOW_CALLER_CWD?.trim();
  return callerDir ? path.resolve(callerDir) : process.cwd();
}

async function deepworkEntry(rootDir: string, args: Record<string, string>): Promise<void> {
  const input = {
    executionMode: args["execution-mode"],
    goalStyle: args["goal-style"],
    reviewMode: args["review-mode"],
    remember: args.remember === "true" || args.remember === "1" || "remember" in args,
    temporary: args.temporary === "true" || args.temporary === "1" || "temporary" in args,
  };
  const response = await createDeepworkResponse(input);

  if (!args.goal && !args.goals) {
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  const config = await loadConfig(rootDir);
  const selection = resolveDeepworkSelection(response.preferences.persisted ? {
    executionMode: response.preferences.executionMode,
    goalStyle: response.preferences.goalStyle,
    reviewMode: response.preferences.reviewMode,
  } : null, input);
  const plan = buildDeepworkExecutionPlan(selection, {
    goal: args.goal,
    goals: args.goals,
    executor: args.executor,
  });

  if (plan.mode === "single") {
    const task = await createTask(rootDir, plan.goals[0], plan.executor, config, undefined, {
      execMode: plan.execMode,
      reviewMode: selection.reviewMode,
    });
    const completed = await runTask(rootDir, task, config);
    console.log(JSON.stringify({
      entry: "/deepwork",
      preferences: response.preferences,
      plan,
      result: completed,
    }, null, 2));
    return;
  }

  const routes = plan.autoRoute
    ? await routeGoals(rootDir, plan.goals, config, await loadModelProfiles(rootDir))
    : undefined;
  const batchMode = plan.goals.some((goal) => / - produce a short implementation plan$/i.test(goal))
    && plan.goals.some((goal) => / - implement the highest-value next step and return a concrete deliverable$/i.test(goal))
    ? "serial"
    : "parallel";
  const batch = await runTaskBatch(rootDir, plan.goals, plan.executor, config, batchMode, routes, {
    execMode: plan.execMode,
    reviewMode: selection.reviewMode,
  });
  console.log(JSON.stringify({
    entry: "/deepwork",
    preferences: response.preferences,
    plan,
    result: batch,
  }, null, 2));
}

async function completeDelegatedBatch(rootDir: string, args: Record<string, string>): Promise<void> {
  const batchId = args.batch;
  if (!batchId) {
    throw new Error("Missing required --batch");
  }
  const taskId = args["task-id"];

  const batch = await loadBatch(rootDir, batchId);
  const now = new Date().toISOString();
  let updated = false;

  const tasks: WorkflowTask[] = [];
  for (const task of batch.tasks) {
    if (task.phase !== "delegated_to_codex" || !task.workerResult) {
      tasks.push(task);
      continue;
    }
    if (taskId && task.id !== taskId) {
      tasks.push(task);
      continue;
    }

    const prompt = args["stdout-file"]
      ? await readFile(path.resolve(rootDir, args["stdout-file"]), "utf8")
      : args.stdout || `Delegated task completed: ${task.goal}`;
    const workerResult: WorkerResult = {
      status: args.status === "failed" ? "failed" : "ok",
      stdout: prompt,
      stderr: "",
      exitCode: args.status === "failed" ? 1 : 0,
      startedAt: task.workerResult.startedAt ?? now,
      finishedAt: now,
      attempts: 1,
    };
    const review = reviewWorkerResultForMode(workerResult, task.expectedOutput ?? "artifact", task.structuredMode);
    if (task.structuredMode) {
      const structuredPayload = parseStructuredWorkerPayload(workerResult.stdout, task.structuredMode);
      if (structuredPayload) {
        workerResult.parsed = structuredPayload;
      }
    } else {
      const genericPayload = parseWorkerPayload(workerResult.stdout);
      if (genericPayload) {
        workerResult.parsed = genericPayload;
      }
    }
    const completedTask: WorkflowTask = {
      ...task,
      workerResult,
      review,
      updatedAt: now,
    };
    completedTask.phase = resolveTaskPhase(completedTask);
    await saveTask(rootDir, completedTask);
    tasks.push(completedTask);
    updated = true;
  }

  if (!updated) {
    if (taskId) {
      throw new Error(`Batch ${batchId} has no delegated_to_codex task matching --task-id ${taskId}.`);
    }
    throw new Error(`Batch ${batchId} has no delegated_to_codex tasks.`);
  }

  const hasBlocked = tasks.some((task) => task.phase === "blocked");
  const hasDelegated = tasks.some((task) => task.phase === "delegated_to_codex");
  const hasCompleted = tasks.some((task) => task.phase === "completed");
  const phase = hasDelegated
    ? "partial"
    : hasBlocked && hasCompleted
      ? "partial"
      : hasBlocked
        ? "blocked"
        : "completed";

  const updatedBatch: WorkflowBatchResult = {
    ...batch,
    tasks,
    phase,
    finishedAt: now,
    summary: summarizeBatch(tasks),
  };

  await saveBatch(rootDir, updatedBatch);
  console.log(JSON.stringify(updatedBatch, null, 2));
}

async function main(): Promise<void> {
  const rootDir = resolveRootDir();
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "init":
      await initProject(rootDir);
      return;
    case "run":
      await runWorkflow(rootDir, args);
      return;
    case "run-batch":
      if (args.resume) {
        await resumeBatch(rootDir, args);
        return;
      }
      await runBatch(rootDir, args);
      return;
    case "status":
      await showStatus(rootDir, args);
      return;
    case "probe":
      await probeExecutor(rootDir, args);
      return;
    case "workflow-save":
      await saveWorkflow(rootDir, args);
      return;
    case "workflow-load":
      await loadWorkflow(rootDir, args);
      return;
    case "workflow-list":
      await listWorkflows();
      return;
    case "workflow-show":
      await showWorkflow(rootDir, args);
      return;
    case "complete-delegated":
      await completeDelegatedBatch(rootDir, args);
      return;
    case "hello":
      console.log(JSON.stringify(handleHello()));
      return;
    case "demo-subagent":
      await demoSubagent(rootDir);
      return;
    case "demo-serial-pair":
      await demoPair(rootDir, "serial");
      return;
    case "demo-parallel":
      await demoPair(rootDir, "parallel");
      return;
    case "deepwork":
      await deepworkEntry(rootDir, args);
      return;
    default:
      console.log("Usage:");
      console.log("  node dist/index.js init");
      console.log("  node dist/index.js run --goal \"task\" [--executor omp]");
      console.log("  node dist/index.js run-batch --executor opencode-serve --goals \"task1,task2\" --mode parallel");
      console.log("  node dist/index.js run-batch --goals \"task1,task2\" --mode parallel --auto-route");
      console.log("  node dist/index.js run-batch --resume <batch-id>");
      console.log("  node dist/index.js status --id <task-id>");
      console.log("  node dist/index.js status --batch <batch-id>");
      console.log("  node dist/index.js probe [--executor opencode]");
      console.log("  node dist/index.js probe --executor opencode-serve --auto");
      console.log("  node dist/index.js workflow-save --name <name>");
      console.log("  node dist/index.js workflow-load --name <name>");
      console.log("  node dist/index.js workflow-list");
      console.log("  node dist/index.js workflow-show --name <name>");
      console.log("  node dist/index.js deepwork [--execution-mode codex-first|cli-first|hybrid] [--goal-style explicit-goals|proactive-decomposition] [--review-mode standard-review|strict-review] [--remember] [--temporary] [--goal \"task\"] [--goals \"task1,task2\"] [--executor name]");
      console.log("  node dist/index.js complete-delegated --batch <batch-id> [--task-id <task-id>] [--stdout <text>|--stdout-file <path>] [--status ok|failed]");
      console.log("  node dist/index.js demo-subagent");
      console.log("  node dist/index.js demo-serial-pair (runs 3 goals: task A, task B, task C)");
      console.log("  node dist/index.js demo-parallel (runs 2 goals: task A, task B)");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
