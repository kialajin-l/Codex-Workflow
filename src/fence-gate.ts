import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowTask } from "./types.js";

export type FenceAction =
  | "allow"
  | "deny"
  | "warn"
  | "require_confirmation"
  | "require_scope_clarification"
  | "require_split";

export interface FenceDecision {
  format: string;
  type: string;
  task_id: string;
  severity: string;
  action: FenceAction;
  rule_id: string;
  scale_tier: string;
  reason: string;
  triggered_rules?: Array<{
    rule_id: string;
    severity: string;
    action: string;
    reason: string;
  }>;
  suggested_fix?: {
    title: string;
    description: string;
    options: Array<{ label: string; action: string; target?: string }>;
  };
}

export interface FenceGateResult {
  decision: FenceDecision;
  allowed: boolean;
  limitation?: string;
}

type FenceMode = "disabled" | "forced" | "auto";

function resolveFenceMode(): FenceMode {
  const env = process.env.RULEFORGE_FENCE_ENABLED;
  if (env === "false" || env === "0") {
    return "disabled";
  }
  if (env === "true" || env === "1") {
    return "forced";
  }
  return "auto";
}

function getFenceBin(): string | null {
  return process.env.RULEFORGE_FENCE_BIN ?? null;
}

function inferActionFromGoal(goal: string): "write" | "read" | "execute" {
  const lower = goal.toLowerCase();
  if (/(read|check|inspect|review|analyze|view|show|list)/.test(lower)) {
    return "read";
  }
  if (/(run|execute|deploy|build|test)/.test(lower)) {
    return "execute";
  }
  return "write";
}

function extractFilePaths(goal: string): string[] {
  const matches = goal.match(/(?:src|tests?|dist|lib|app|packages?)\/[^\s,;]+/gi);
  return matches ? [...new Set(matches)] : [];
}

function buildRuleContext(task: WorkflowTask): {
  context: Record<string, unknown>;
  limitation?: string;
} {
  const filePaths = task.filePaths ?? extractFilePaths(task.goal);
  const limitation = !task.filePaths && filePaths.length === 0
    ? "file_paths inferred as empty; gate cannot check path scope"
    : undefined;

  return {
    context: {
      format: "ruleforge-v1",
      type: "fence_check",
      task_id: task.id,
      goal: task.goal,
      action: inferActionFromGoal(task.goal),
      file_paths: filePaths,
      file_count: filePaths.length,
      mode: "edit",
      permissions: "write",
      allowed_paths: task.allowedPaths ?? ["src/**", "tests/**"],
      denied_paths: task.deniedPaths ?? ["dist/**", "node_modules/**", ".env"],
    },
    limitation,
  };
}

function runFenceCli(bin: string, contextPath: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts = bin.split(/\s+/);
    const command = parts[0];
    const args = [...parts.slice(1), "fence", "--context", contextPath];

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`fence gate timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`fence gate exited ${code}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function fenceGate(task: WorkflowTask): Promise<FenceGateResult | null> {
  const mode = resolveFenceMode();
  const bin = getFenceBin();

  if (mode === "disabled") {
    return null;
  }

  if (mode === "auto" && !bin) {
    return null;
  }

  if (!bin) {
    return {
      decision: {
        format: "synaptor-v1",
        type: "fence_decision",
        task_id: task.id,
        severity: "error",
        action: "deny",
        rule_id: "fence_unavailable",
        scale_tier: "unknown",
        reason: "RuleForge Fence forced but no bin configured (set RULEFORGE_FENCE_BIN)",
      },
      allowed: false,
      limitation: "fence forced but RULEFORGE_FENCE_BIN not set",
    };
  }

  const { context, limitation } = buildRuleContext(task);
  const tmpDir = path.join(os.tmpdir(), "codex-workflow-fence");
  mkdirSync(tmpDir, { recursive: true });

  const contextPath = path.join(tmpDir, `${task.id}.json`);
  writeFileSync(contextPath, JSON.stringify(context, null, 2), "utf8");

  try {
    const stdout = await runFenceCli(bin, contextPath);
    const decision = JSON.parse(stdout) as FenceDecision;

    return {
      decision,
      allowed: decision.action === "allow" || decision.action === "warn" || decision.action === "require_confirmation",
      limitation,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[fence-gate] fence call failed: ${message}`);
    return {
      decision: {
        format: "synaptor-v1",
        type: "fence_decision",
        task_id: task.id,
        severity: "error",
        action: "deny",
        rule_id: "fence_unavailable",
        scale_tier: "unknown",
        reason: `RuleForge Fence unavailable: ${message}`,
      },
      allowed: false,
      limitation: `fence CLI error: ${message}`,
    };
  } finally {
    try {
      rmSync(contextPath, { force: true });
    } catch {
      // best effort cleanup
    }
  }
}
