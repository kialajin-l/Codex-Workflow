import type { BatchSummary, WorkflowTask } from "./types.js";

export function summarizeBatch(tasks: WorkflowTask[]): BatchSummary {
  const summary: BatchSummary = {
    totalTasks: tasks.length,
    completed: tasks.filter((task) => task.phase === "completed").length,
    blocked: tasks.filter((task) => task.phase === "blocked").length,
    hostApplyPending: tasks.filter((task) => task.phase === "host_apply_pending").length,
    delegated: tasks.filter((task) => task.phase === "delegated_to_codex").length,
    resultSources: {
      executor: 0,
      executorSalvaged: 0,
      fallbackSynthesized: 0,
      delegated: 0,
      unknown: 0,
    },
    consensus: "none",
    risks: [],
    nextSteps: [],
  };

  for (const task of tasks) {
    switch (task.workerResult?.source) {
      case "executor":
        summary.resultSources.executor += 1;
        break;
      case "executor-salvaged":
        summary.resultSources.executorSalvaged += 1;
        break;
      case "fallback-synthesized":
        summary.resultSources.fallbackSynthesized += 1;
        break;
      case "delegated":
        summary.resultSources.delegated += 1;
        break;
      default:
        summary.resultSources.unknown += task.workerResult ? 1 : 0;
        break;
    }
  }

  // Consensus: requires every task to be completed with a reliable parsed payload.
  // If any non-completed task has a blocked payload, or any completed task lacks parsed,
  // consensus can never be "high".
  const completedWithParsed = tasks.filter((task) => task.phase === "completed" && task.workerResult?.parsed);
  const completedWithoutParsed = tasks.some((task) => task.phase === "completed" && !task.workerResult?.parsed);
  const completedWithSalvagedSource = tasks.some(
    (task) => task.phase === "completed" && task.workerResult?.source === "executor-salvaged",
  );
  const nonCompletedWithBlocked = tasks.some(
    (task) => task.phase !== "completed" && task.workerResult?.parsed?.status === "blocked",
  );

  if (completedWithParsed.length === 0) {
    summary.consensus = "none";
  } else if (
    summary.completed !== summary.totalTasks ||
    nonCompletedWithBlocked ||
    completedWithoutParsed ||
    completedWithSalvagedSource
  ) {
    // Any unresolved blocked payload or unreliable completed task → not high
    summary.consensus = "partial";
  } else {
    const allOk = completedWithParsed.every((task) => task.workerResult?.parsed?.status === "ok");
    summary.consensus = allOk ? "high" : "partial";
  }

  for (const task of tasks) {
    const risk = task.workerResult?.parsed?.risks;
    if (risk && risk.toLowerCase() !== "none") {
      summary.risks.push(`[${task.goal}]: ${risk}`);
    }
  }

  if (summary.blocked > 0) {
    summary.nextSteps.push(`${summary.blocked} task(s) blocked - review and retry`);
  }
  if (summary.hostApplyPending > 0) {
    summary.nextSteps.push(`${summary.hostApplyPending} task(s) waiting for host agent to apply artifacts`);
  }
  if (summary.delegated > 0) {
    summary.nextSteps.push(`${summary.delegated} task(s) delegated to Codex - complete them first`);
  }
  // Only suggest deployment when every task is cleanly completed with high consensus
  if (
    summary.blocked === 0 &&
    summary.hostApplyPending === 0 &&
    summary.delegated === 0 &&
    summary.consensus === "high" &&
    summary.completed === summary.totalTasks
  ) {
    summary.nextSteps.push("All tasks completed - proceed to integration or deployment");
  }

  return summary;
}
