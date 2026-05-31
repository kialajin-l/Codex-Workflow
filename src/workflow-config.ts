import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { workflowPresetSchema } from "./schema.js";
import type { HookConfig, WorkflowPreset } from "./types.js";

export function codexWorkflowHome(): string {
  return path.join(os.homedir(), ".codex", "codex-workflow");
}

export function workflowConfigDir(): string {
  return path.join(codexWorkflowHome(), "workflows");
}

export function hooksConfigDir(): string {
  return path.join(codexWorkflowHome(), "hooks");
}

export function skillsConfigDir(): string {
  return path.join(codexWorkflowHome(), "skills");
}

export async function ensureWorkflowConfigDirs(): Promise<void> {
  await Promise.all([
    mkdir(codexWorkflowHome(), { recursive: true }),
    mkdir(workflowConfigDir(), { recursive: true }),
    mkdir(hooksConfigDir(), { recursive: true }),
    mkdir(skillsConfigDir(), { recursive: true }),
  ]);
}

function hookFileName(event: HookConfig["event"]): string {
  return event.replace(/:/g, ".") + ".json";
}

function hookEventFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.json$/i, "");
  if (stem === "task.before_dispatch") {
    return "task:before_dispatch";
  }
  if (stem === "task.after_result") {
    return "task:after_result";
  }
  if (stem === "review.after") {
    return "review:after";
  }
  if (stem === "workflow.plan.before") {
    return "workflow:plan:before";
  }
  if (stem === "workflow.end") {
    return "workflow:end";
  }
  return stem.replace(/\./g, ":");
}

export async function saveWorkflowPreset(name: string, hooks: HookConfig[]): Promise<WorkflowPreset> {
  await ensureWorkflowConfigDirs();
  const skillEntries = await readdir(skillsConfigDir()).catch(() => [] as string[]);
  const skills = Object.fromEntries(await Promise.all(skillEntries
    .filter((entry) => entry.endsWith(".md"))
    .sort()
    .map(async (entry) => [entry, await readFile(path.join(skillsConfigDir(), entry), "utf8")] as const)));

  const preset: WorkflowPreset = {
    name,
    hooks: Object.fromEntries(hooks.map((hook) => [hookFileName(hook.event), hook])),
    skills,
  };

  const parsed = workflowPresetSchema.parse(preset);
  await writeFile(
    path.join(workflowConfigDir(), `${name}.json`),
    JSON.stringify(parsed, null, 2),
    "utf8",
  );

  return parsed;
}

export async function loadWorkflowPreset(name: string): Promise<WorkflowPreset> {
  const raw = await readFile(path.join(workflowConfigDir(), `${name}.json`), "utf8");
  return workflowPresetSchema.parse(JSON.parse(raw));
}

export async function listWorkflowPresets(): Promise<string[]> {
  await ensureWorkflowConfigDirs();
  const entries = await readdir(workflowConfigDir());
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.replace(/\.json$/i, ""))
    .sort();
}

export async function applyWorkflowPreset(name: string): Promise<WorkflowPreset> {
  await ensureWorkflowConfigDirs();
  const preset = await loadWorkflowPreset(name);

  await Promise.all(Object.entries(preset.hooks).map(async ([fileName, hook]) => {
    await writeFile(path.join(hooksConfigDir(), fileName), JSON.stringify(hook, null, 2), "utf8");
  }));

  await Promise.all(Object.entries(preset.skills ?? {}).map(async ([fileName, content]) => {
    await writeFile(path.join(skillsConfigDir(), fileName), content, "utf8");
  }));

  const existingHookFiles = await readdir(hooksConfigDir()).catch(() => [] as string[]);
  await Promise.all(existingHookFiles
    .filter((fileName) => fileName.endsWith(".json") && !(fileName in preset.hooks))
    .map((fileName) => writeFile(path.join(hooksConfigDir(), fileName), JSON.stringify({
      event: hookEventFromFileName(fileName),
      rules: [],
    }, null, 2), "utf8")));

  return preset;
}
