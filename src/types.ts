export type WorkflowPhase =
  | "planned"
  | "dispatched"
  | "review"
  | "completed"
  | "blocked"
  | "delegated_to_codex";
export type ExecutorMode = "spawn" | "serve";
export type ExecMode = "cli" | "codex";
export type TaskComplexity = "low" | "medium" | "high";
export type TaskRole = "implementer" | "reviewer" | "planner" | "debugger" | "architect" | "copywriter";
export type HookEvent =
  | "workflow:plan:before"
  | "task:before_dispatch"
  | "task:after_result"
  | "review:after"
  | "workflow:end";

export interface ExecutorConfig {
  mode?: ExecutorMode;
  command: string;
  args: string[];
  probePrompt?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  artifactMode?: "schema" | "text";
}

export interface WorkflowConfig {
  defaultExecutor: string;
  maxParallel?: number;
  executors: Record<string, ExecutorConfig>;
}

export interface ModelCostPer1K {
  input: number;
  output: number;
}

export interface ModelProfile {
  executor: string;
  tags: string[];
  maxComplexity: TaskComplexity;
  preferredRoles: TaskRole[];
  costRank: number;
  costPer1K?: ModelCostPer1K;
  fallbackExecutors?: string[];
}

export interface ModelProfilesConfig {
  modelProfiles: Record<string, ModelProfile>;
}

export interface RouteDecision {
  goal: string;
  profile: string;
  executor: string;
  fallbackExecutors: string[];
  role: TaskRole;
  complexity: TaskComplexity;
  reason: string;
  attemptedExecutors?: string[];
}

export interface HookRule {
  when: Record<string, unknown>;
  then: Record<string, unknown>;
}

export interface HookConfig {
  event: HookEvent;
  default_exec_mode?: ExecMode;
  rules: HookRule[];
}

export interface WorkflowTask {
  id: string;
  goal: string;
  executor: string;
  phase: WorkflowPhase;
  createdAt: string;
  updatedAt: string;
  workerPrompt: string;
  expectedOutput?: "schema" | "artifact";
  execMode?: ExecMode;
  mcpEnabled?: string[];
  mcpDisabled?: string[];
  route?: RouteDecision;
  role?: TaskRole;
  complexity?: TaskComplexity;
  workerResult?: WorkerResult;
  review?: ReviewResult;
  structuredMode?: "deepwork-planner" | "deepwork-implementer";
}

export interface WorkerResult {
  status: "ok" | "failed" | "delegated";
  source?: "executor" | "executor-salvaged" | "fallback-synthesized" | "delegated";
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  attempts?: number;
  parsed?: WorkerPayload;
  artifact?: WorkerArtifact;
  failureCategory?: "empty-output" | "invalid-json" | "invalid-structured-text" | "non-zero-exit" | "timeout" | "unknown";
}

export interface ReviewResult {
  decision: "accept" | "reject" | "retry";
  summary: string;
  issues: string[];
  reviewedAt: string;
}

export interface WorkerPayload {
  summary: string;
  changes: string;
  risks: string;
  status: "ok" | "blocked";
}

export interface WorkerArtifact {
  type: "text";
  content: string;
}

export interface ProbeResult {
  executor: string;
  command: string;
  args: string[];
  workerResult: WorkerResult;
  review: ReviewResult;
}

export interface AutoProbeResult {
  executor: string;
  attempts: ProbeResult[];
  recommendedArtifactMode: "schema" | "text";
  schemaSuccesses: number;
  recordedAt: string;
}

export interface BatchSummary {
  totalTasks: number;
  completed: number;
  blocked: number;
  delegated: number;
  resultSources: {
    executor: number;
    executorSalvaged: number;
    fallbackSynthesized: number;
    delegated: number;
    unknown: number;
  };
  consensus: "high" | "partial" | "none";
  risks: string[];
  nextSteps: string[];
}

export interface TaskCost {
  taskId: string;
  goal: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUSD: number;
}

export interface BatchCost {
  batchId: string;
  tasks: TaskCost[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
}

export interface WorkflowBatchResult {
  id: string;
  executor: string;
  mode: "serial" | "parallel";
  goals: string[];
  startedAt: string;
  finishedAt: string;
  phase: "completed" | "blocked" | "partial";
  routes?: RouteDecision[];
  tasks: WorkflowTask[];
  summary?: BatchSummary;
  cost?: BatchCost;
}

export interface WorkflowPreset {
  name: string;
  hooks: Record<string, HookConfig>;
  skills?: Record<string, string>;
}

export type DeepworkExecutionMode = "codex-first" | "cli-first" | "hybrid";
export type DeepworkGoalStyle = "explicit-goals" | "proactive-decomposition";
export type DeepworkReviewMode = "standard-review" | "strict-review";

export interface DeepworkPreferences {
  executionMode: DeepworkExecutionMode;
  goalStyle: DeepworkGoalStyle;
  reviewMode: DeepworkReviewMode;
  updatedAt?: string;
  source?: "chat-confirmed" | "cli";
}

export interface DeepworkSessionConfig {
  executionMode: DeepworkExecutionMode;
  goalStyle: DeepworkGoalStyle;
  reviewMode: DeepworkReviewMode;
  persisted: boolean;
  temporaryOverride: boolean;
}

export interface DeepworkOptionSet {
  id: string;
  label: string;
  description: string;
}

export interface DeepworkOnboardingResponse {
  entry: "/deepwork";
  status: "needs-onboarding" | "ready";
  message: string;
  preferences: DeepworkSessionConfig;
  options?: {
    executionModes: DeepworkOptionSet[];
    goalStyles: DeepworkOptionSet[];
    reviewModes: DeepworkOptionSet[];
  };
}

export interface DeepworkExecutionPlan {
  mode: "single" | "batch";
  executor: string;
  autoRoute: boolean;
  execMode?: ExecMode;
  goals: string[];
}

export interface DeepworkPlannerResult {
  summary: string;
  changes: string;
  risks: string;
  status: "ok" | "blocked";
  goal: string;
  assumptions: string[];
  steps: string[];
}

export interface DeepworkImplementerResult {
  summary: string;
  changes: string;
  risks: string;
  status: "ok" | "blocked";
  deliverable: string;
  assumptions: string[];
  nextStep: string;
}

export type DeepworkStructuredResult = DeepworkPlannerResult | DeepworkImplementerResult;
