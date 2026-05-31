import { z } from "zod";

export const executorConfigSchema = z.object({
  mode: z.enum(["spawn", "serve"]).optional(),
  command: z.string().min(1),
  args: z.array(z.string()),
  probePrompt: z.string().min(1).optional(),
  endpoint: z.string().url().optional(),
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  artifactMode: z.enum(["schema", "text"]).optional(),
});

export const workflowConfigSchema = z.object({
  defaultExecutor: z.string().min(1),
  maxParallel: z.number().int().nonnegative().optional(),
  executors: z.record(z.string(), executorConfigSchema),
});

export const modelCostPer1KSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

export const modelProfileSchema = z.object({
  executor: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  maxComplexity: z.enum(["low", "medium", "high"]),
  preferredRoles: z.array(z.enum(["implementer", "reviewer", "planner", "debugger", "architect", "copywriter"])).min(1),
  costRank: z.number().int().positive(),
  costPer1K: modelCostPer1KSchema.optional(),
  fallbackExecutors: z.array(z.string().min(1)).optional(),
});

export const modelProfilesConfigSchema = z.object({
  modelProfiles: z.record(z.string(), modelProfileSchema),
});

export const workerPayloadSchema = z.object({
  summary: z.string().min(1),
  changes: z.string().min(1),
  risks: z.string().min(1),
  status: z.enum(["ok", "blocked"]),
});

export const hookEventSchema = z.enum([
  "workflow:plan:before",
  "task:before_dispatch",
  "task:after_result",
  "review:after",
  "workflow:end",
]);
export const execModeSchema = z.enum(["cli", "codex"]);

export const hookRuleWhenSchema = z.record(z.string(), z.unknown());

export const hookRuleThenSchema = z.record(z.string(), z.unknown()).refine((value) => {
  if ("exec_mode" in value && value.exec_mode !== undefined) {
    return execModeSchema.safeParse(value.exec_mode).success;
  }
  if ("executor" in value && value.executor !== undefined) {
    return typeof value.executor === "string" && value.executor.length > 0;
  }
  if ("inject_skill" in value && value.inject_skill !== undefined) {
    return typeof value.inject_skill === "string" && value.inject_skill.length > 0;
  }
  if ("enable_mcp" in value && value.enable_mcp !== undefined) {
    return Array.isArray(value.enable_mcp) && value.enable_mcp.every((item) => typeof item === "string");
  }
  if ("disable_mcp" in value && value.disable_mcp !== undefined) {
    return Array.isArray(value.disable_mcp) && value.disable_mcp.every((item) => typeof item === "string");
  }
  return true;
}, {
  message: "Hook rule 'then' contains invalid values.",
});

export const hookRuleSchema = z.object({
  when: hookRuleWhenSchema,
  then: hookRuleThenSchema,
});

export const hookConfigSchema = z.object({
  event: hookEventSchema,
  default_exec_mode: execModeSchema.optional(),
  rules: z.array(hookRuleSchema),
});

export const workflowPresetSchema = z.object({
  name: z.string().min(1),
  hooks: z.record(z.string(), hookConfigSchema),
  skills: z.record(z.string(), z.string()).optional(),
});
