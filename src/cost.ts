import type { BatchCost, ModelProfilesConfig, TaskCost, WorkflowTask } from "./types.js";

export function estimateTaskCost(
  task: WorkflowTask,
  profiles: ModelProfilesConfig,
): TaskCost | null {
  const profileName = task.route?.profile;
  if (!profileName) {
    return null;
  }

  const profile = profiles.modelProfiles[profileName];
  if (!profile?.costPer1K) {
    return null;
  }

  const promptChars = (task.workerPrompt ?? "").length;
  const resultChars = (task.workerResult?.stdout ?? "").length;
  const estimatedInputTokens = Math.ceil(promptChars / 4);
  const estimatedOutputTokens = Math.ceil(resultChars / 4);
  const estimatedCostUSD = (
    (estimatedInputTokens / 1000) * profile.costPer1K.input +
    (estimatedOutputTokens / 1000) * profile.costPer1K.output
  );

  return {
    taskId: task.id,
    goal: task.goal,
    model: profileName,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUSD: Math.round(estimatedCostUSD * 1_000_000) / 1_000_000,
  };
}

export function summarizeBatchCost(
  batchId: string,
  tasks: WorkflowTask[],
  profiles: ModelProfilesConfig,
): BatchCost | undefined {
  const taskCosts = tasks
    .map((task) => estimateTaskCost(task, profiles))
    .filter((taskCost): taskCost is TaskCost => taskCost !== null);

  if (taskCosts.length === 0) {
    return undefined;
  }

  return {
    batchId,
    tasks: taskCosts,
    totalInputTokens: taskCosts.reduce((sum, taskCost) => sum + taskCost.estimatedInputTokens, 0),
    totalOutputTokens: taskCosts.reduce((sum, taskCost) => sum + taskCost.estimatedOutputTokens, 0),
    totalCostUSD: Math.round(
      taskCosts.reduce((sum, taskCost) => sum + taskCost.estimatedCostUSD, 0) * 1_000_000,
    ) / 1_000_000,
  };
}
