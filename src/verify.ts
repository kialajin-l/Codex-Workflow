import type { WorkerPayload, WorkflowTask } from "./types.js";

export interface VerificationVerdict {
  verdict: "completed" | "blocked" | "unverified";
  reason: string;
}

/**
 * Lightweight task completion verification.
 * Checks invariants that review does not cover: primarily whether the
 * worker self-reported blocked, and whether implementer tasks produced
 * a real deliverable versus analysis-only output.
 */
export function verifyTaskCompletion(task: WorkflowTask): VerificationVerdict {
  const parsed = task.workerResult?.parsed;

  // (1) Self-reported blocked is a hard veto.
  if (parsed?.status === "blocked") {
    return { verdict: "blocked", reason: "Worker self-reported status: blocked." };
  }

  // (2) Fallback-synthesized results carry no execution evidence.
  if (task.workerResult?.source === "fallback-synthesized" && task.structuredMode) {
    return { verdict: "blocked", reason: "Result was synthesized locally; no executor evidence." };
  }

  // (3) Implementer tasks: require observable execution, not pure analysis.
  if (task.structuredMode === "deepwork-implementer" && task.workerResult?.stdout) {
    const output = task.workerResult.stdout;
    if (isPureAnalysisOutput(output)) {
      return { verdict: "blocked", reason: "Implementer output is pure analysis; no concrete deliverable." };
    }
    if (hasPendingImplementationNextStep(parsed)) {
      return { verdict: "blocked", reason: "Implementer marked status ok but left the core implementation action as nextStep." };
    }
  }

  return { verdict: "unverified", reason: "Verification has no additional signal; deferred to review." };
}

function hasPendingImplementationNextStep(parsed: WorkerPayload | undefined): boolean {
  if (!parsed || parsed.status !== "ok" || !("nextStep" in parsed) || typeof parsed.nextStep !== "string") {
    return false;
  }

  const nextStep = parsed.nextStep.trim();
  if (!nextStep) {
    return false;
  }

  if (/(task complete|no further action|nothing else|无需|不需要|已完成|任务完成|无后续)/i.test(nextStep)) {
    return false;
  }

  return /\b(read|inspect|create|add|write|edit|update|move|migrate|implement|run|verify)\b|读取|检查|创建|新增|写入|编辑|更新|移动|迁移|实现|运行|验证/.test(nextStep);
}

/**
 * Heuristic: does the output read as pure analysis/planning
 * rather than describing an executed observable action?
 */
function isPureAnalysisOutput(stdout: string): boolean {
  const normalized = stdout.toLowerCase().replace(/^```[\s\S]*?\n|```\s*$/g, "").trim();

  // Patterns that suggest analysis-only output
  const analysisPatterns = [
    /\bi analyzed\b/i,
    /\bi reviewed the repository\b/i,
    /\bi inspected\b/i,
    /\bbased on the (repository|codebase|project structure)\b/i,
    /\bfrom the codebase\b/i,
    /\bi (can|could|would) (recommend|suggest|propose)\b/i,
    /\bhere('s| is) (a |an |my |the )?(plan|analysis|assessment|evaluation|summary)\b/i,
    /\blet me (check|look|examine|review|understand|investigate)\b/i,
    /\bto (proceed|continue|start|begin),?\s+(I|we|you) (need|should|could|would)\b/i,
    /\bnext steps?:?\s*\n/i,
    /\bthis (is|was) (an? |the )?analysis\b/i,
  ];

  // If the output is very short (< 100 chars), it's likely not a deliverable
  if (normalized.length < 100) {
    return true;
  }

  // Check for deliverable indicators
  const hasDeliverable = /deliverable[:\s]/i.test(normalized);
  const hasCodeBlock = /```[\s\S]*?\n[\s\S]*?\n```/.test(stdout);
  const hasFileCreation = /\b(wrote|created|added|implemented|built|generated)\b/i.test(normalized);

  if (hasDeliverable || hasCodeBlock || hasFileCreation) {
    return false;
  }

  // Count analysis patterns; if 2+ match, treat as analysis-only.
  const matchCount = analysisPatterns.filter((p) => p.test(normalized)).length;
  return matchCount >= 2;
}
