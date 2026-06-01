import type { BatchSummary, WorkflowTask } from "./types.js";

export function summarizeBatch(tasks: WorkflowTask[]): BatchSummary {
  const summary: BatchSummary = {
    totalTasks: tasks.length,
    completed: tasks.filter((task) => task.phase === "completed").length,
    blocked: tasks.filter((task) => task.phase === "blocked").length,
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

  const completedTasks = tasks.filter((task) => task.phase === "completed" && task.workerResult?.parsed);
  const allOk = completedTasks.every((task) => task.workerResult?.parsed?.status === "ok");
  summary.consensus = completedTasks.length === 0 ? "none" : allOk ? "high" : "partial";

  for (const task of tasks) {
    const risk = task.workerResult?.parsed?.risks;
    if (risk && risk.toLowerCase() !== "none") {
      summary.risks.push(`[${task.goal}]: ${risk}`);
    }
  }

  if (summary.blocked > 0) {
    summary.nextSteps.push(`${summary.blocked} task(s) blocked - review and retry`);
  }
  if (summary.delegated > 0) {
    summary.nextSteps.push(`${summary.delegated} task(s) delegated to Codex - complete them first`);
  }
  if (summary.completed === summary.totalTasks) {
    summary.nextSteps.push("All tasks completed - proceed to integration or deployment");
  }

  return summary;
}
