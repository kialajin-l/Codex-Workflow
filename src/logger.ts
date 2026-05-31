import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.join(".workflow-state", "logs");

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
  batchId?: string;
  taskId?: string;
  message: string;
  data?: Record<string, unknown>;
}

async function ensureLogDir(rootDir: string): Promise<string> {
  const dir = path.join(rootDir, LOG_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function log(rootDir: string, entry: LogEntry): Promise<void> {
  const dir = await ensureLogDir(rootDir);
  const date = entry.timestamp.slice(0, 10);
  const logPath = path.join(dir, `workflow-${date}.log`);
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function logBatchStart(rootDir: string, batchId: string, goals: string[]): Promise<void> {
  await log(rootDir, {
    timestamp: new Date().toISOString(),
    level: "info",
    event: "batch.start",
    batchId,
    message: `Batch started with ${goals.length} goals`,
    data: {
      goalCount: goals.length,
      goals,
    },
  });
}

export async function logTaskComplete(
  rootDir: string,
  batchId: string,
  taskId: string,
  phase: string,
): Promise<void> {
  await log(rootDir, {
    timestamp: new Date().toISOString(),
    level: phase === "completed" ? "info" : "warn",
    event: "task.complete",
    batchId,
    taskId,
    message: `Task ${taskId} ${phase}`,
    data: {
      phase,
    },
  });
}

export async function logBatchEnd(
  rootDir: string,
  batchId: string,
  phase: string,
  durationMs: number,
): Promise<void> {
  await log(rootDir, {
    timestamp: new Date().toISOString(),
    level: phase === "completed" ? "info" : "warn",
    event: "batch.end",
    batchId,
    message: `Batch ${batchId} ${phase} in ${durationMs}ms`,
    data: {
      phase,
      durationMs,
    },
  });
}
