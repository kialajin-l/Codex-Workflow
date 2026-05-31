import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { hookConfigSchema } from "./schema.js";
import type { ExecMode, HookConfig, HookRule, WorkflowTask } from "./types.js";

function readTaskPath(task: WorkflowTask, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = task;

  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

export function matchesWhen(rule: HookRule, task: WorkflowTask): boolean {
  for (const [key, expected] of Object.entries(rule.when)) {
    if (key === "goalIncludes" && typeof expected === "string") {
      if (!task.goal.toLowerCase().includes(expected.toLowerCase())) {
        return false;
      }
      continue;
    }

    const actual = readTaskPath(task, key);

    if (actual !== expected) {
      return false;
    }
  }

  return true;
}

export async function loadHooks(configDir: string): Promise<HookConfig[]> {
  const hooksDir = path.join(configDir, "hooks");
  let entries: string[];

  try {
    entries = await readdir(hooksDir);
  } catch {
    return [];
  }

  const loaded = await Promise.all(entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map(async (entry) => {
      const raw = await readFile(path.join(hooksDir, entry), "utf8");
      return hookConfigSchema.parse(JSON.parse(raw));
    }));

  return loaded;
}

export async function resolveInjectSkill(
  then: Record<string, unknown>,
  skillsDir: string,
): Promise<string | undefined> {
  const skillName = typeof then.inject_skill === "string" ? then.inject_skill : undefined;
  if (!skillName) {
    return undefined;
  }

  try {
    const content = await readFile(path.join(skillsDir, skillName), "utf8");
    return `## Additional Instructions\n${content}`;
  } catch {
    return undefined;
  }
}

export function applyTaskDispatchHook(hook: HookConfig, task: WorkflowTask): WorkflowTask {
  if (hook.event !== "task:before_dispatch") {
    return task;
  }

  const updated: WorkflowTask = {
    ...task,
    execMode: task.execMode ?? hook.default_exec_mode ?? "cli",
  };

  for (const rule of hook.rules) {
    if (!matchesWhen(rule, updated)) {
      continue;
    }

    if (rule.then.exec_mode === "cli" || rule.then.exec_mode === "codex") {
      updated.execMode = rule.then.exec_mode as ExecMode;
    }

    if (typeof rule.then.executor === "string") {
      updated.executor = rule.then.executor;
      if (updated.route) {
        updated.route = {
          ...updated.route,
          executor: rule.then.executor,
        };
      }
    }

    if (Array.isArray(rule.then.enable_mcp)) {
      updated.mcpEnabled = rule.then.enable_mcp.filter((item): item is string => typeof item === "string");
    }

    if (Array.isArray(rule.then.disable_mcp)) {
      updated.mcpDisabled = rule.then.disable_mcp.filter((item): item is string => typeof item === "string");
    }
  }

  return updated;
}

export function applyTaskAfterResultHook(
  hook: HookConfig,
  task: WorkflowTask,
): { action: "proceed" | "retry" | "block"; reason: string } {
  if (hook.event !== "task:after_result") {
    return { action: "proceed", reason: "no hook" };
  }

  for (const rule of hook.rules) {
    if (!matchesWhen(rule, task)) {
      continue;
    }

    if (rule.then.action === "retry") {
      return {
        action: "retry",
        reason: typeof rule.then.reason === "string" ? rule.then.reason : "hook rule matched retry",
      };
    }

    if (rule.then.action === "block") {
      return {
        action: "block",
        reason: typeof rule.then.reason === "string" ? rule.then.reason : "hook rule matched block",
      };
    }

    if (rule.then.action === "lint" && task.workerResult) {
      const output = `${task.workerResult.stdout}\n${task.workerResult.stderr}`;
      const hasLintError = task.workerResult.exitCode !== 0 || /^\s*error[: ]/im.test(output) || /\bFAIL\b/i.test(output);
      if (hasLintError) {
        return { action: "block", reason: "lint check failed" };
      }
    }
  }

  return { action: "proceed", reason: "no matching rule or rule passed" };
}

export function applyReviewAfterHook(
  hook: HookConfig,
  task: WorkflowTask,
): { shouldContinue: boolean; notification?: string } {
  if (hook.event !== "review:after") {
    return { shouldContinue: true };
  }

  for (const rule of hook.rules) {
    if (!matchesWhen(rule, task)) {
      continue;
    }

    if (rule.then.action === "notify") {
      return {
        shouldContinue: true,
        notification: typeof rule.then.message === "string" ? rule.then.message : "Review completed",
      };
    }

    if (rule.then.action === "stop") {
      return { shouldContinue: false };
    }
  }

  return { shouldContinue: true };
}
