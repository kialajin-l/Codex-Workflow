import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AutoProbeResult, WorkflowBatchResult, WorkflowTask } from "./types.js";

const STATE_DIR = ".workflow-state";

function parseStoredJson<T>(raw: string): T {
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
}

export async function ensureStateDir(rootDir: string): Promise<string> {
  const dir = path.join(rootDir, STATE_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function saveTask(rootDir: string, task: WorkflowTask): Promise<void> {
  const dir = await ensureStateDir(rootDir);
  const filePath = path.join(dir, `${task.id}.json`);
  await writeFile(filePath, JSON.stringify(task, null, 2), "utf8");
}

export async function loadTask(rootDir: string, id: string): Promise<WorkflowTask> {
  const filePath = path.join(rootDir, STATE_DIR, `${id}.json`);
  const raw = await readFile(filePath, "utf8");
  return parseStoredJson<WorkflowTask>(raw);
}

export async function saveBatch(rootDir: string, batch: WorkflowBatchResult): Promise<void> {
  const dir = await ensureStateDir(rootDir);
  const filePath = path.join(dir, `batch.${batch.id}.json`);
  await writeFile(filePath, JSON.stringify(batch, null, 2), "utf8");
}

export async function loadBatch(rootDir: string, id: string): Promise<WorkflowBatchResult> {
  const filePath = path.join(rootDir, STATE_DIR, `batch.${id}.json`);
  const raw = await readFile(filePath, "utf8");
  return parseStoredJson<WorkflowBatchResult>(raw);
}

export async function saveProbe(rootDir: string, probe: AutoProbeResult): Promise<void> {
  const dir = await ensureStateDir(rootDir);
  const filePath = path.join(dir, `probe.${probe.executor}.json`);
  await writeFile(filePath, JSON.stringify(probe, null, 2), "utf8");
}

export async function loadProbe(rootDir: string, executor: string): Promise<AutoProbeResult> {
  const filePath = path.join(rootDir, STATE_DIR, `probe.${executor}.json`);
  const raw = await readFile(filePath, "utf8");
  return parseStoredJson<AutoProbeResult>(raw);
}
