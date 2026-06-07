import type { WorkflowTask } from "./types.js";

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
  }

  return { verdict: "unverified", reason: "Verification has no additional signal; deferred to review." };
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
