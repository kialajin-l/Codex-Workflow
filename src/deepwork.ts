import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deepworkExecutionModeSchema,
  deepworkGoalStyleSchema,
  deepworkPreferencesSchema,
  deepworkReviewModeSchema,
} from "./schema.js";
import { codexWorkflowHome } from "./workflow-config.js";
import type {
  DeepworkExecutionMode,
  DeepworkGoalStyle,
  DeepworkOnboardingResponse,
  DeepworkPreferences,
  DeepworkReviewMode,
  DeepworkSessionConfig,
} from "./types.js";

const DEFAULT_PREFERENCES: DeepworkPreferences = {
  executionMode: "hybrid",
  goalStyle: "explicit-goals",
  reviewMode: "standard-review",
};

const EXECUTION_MODE_OPTIONS = [
  { id: "codex-first", label: "Codex-first", description: "Stay mostly inside Codex and prefer chat-led execution." },
  { id: "cli-first", label: "CLI-first", description: "Prefer external CLI workers when tools can execute faster or deeper." },
  { id: "hybrid", label: "Hybrid", description: "Route by task type automatically and mix Codex with CLI workers." },
] as const;

const GOAL_STYLE_OPTIONS = [
  { id: "explicit-goals", label: "Explicit goals", description: "Wait for clear goals before execution and keep tighter user control." },
  { id: "proactive-decomposition", label: "Proactive decomposition", description: "Break work down and start pushing it forward with less user micromanagement." },
] as const;

const REVIEW_MODE_OPTIONS = [
  { id: "standard-review", label: "Standard review", description: "Keep review lightweight so progress stays faster." },
  { id: "strict-review", label: "Strict review", description: "Add more checks before tasks count as done." },
] as const;

function parseJsonText<T>(raw: string): T {
  return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
}

function deepworkHomeDir(): string {
  return process.env.CODEX_WORKFLOW_HOME || codexWorkflowHome();
}

export function deepworkPreferencesPath(): string {
  return path.join(deepworkHomeDir(), "preferences.json");
}

export function defaultDeepworkPreferences(): DeepworkPreferences {
  return { ...DEFAULT_PREFERENCES };
}

export async function loadDeepworkPreferences(): Promise<DeepworkPreferences | null> {
  try {
    const raw = await readFile(deepworkPreferencesPath(), "utf8");
    return deepworkPreferencesSchema.parse(parseJsonText(raw));
  } catch {
    return null;
  }
}

export async function saveDeepworkPreferences(
  preferences: DeepworkPreferences,
  source: DeepworkPreferences["source"] = "cli",
): Promise<DeepworkPreferences> {
  const parsed = deepworkPreferencesSchema.parse({
    ...preferences,
    updatedAt: new Date().toISOString(),
    source,
  });
  await mkdir(deepworkHomeDir(), { recursive: true });
  await writeFile(deepworkPreferencesPath(), JSON.stringify(parsed, null, 2), "utf8");
  return parsed;
}

export interface DeepworkSelectionInput {
  executionMode?: string;
  goalStyle?: string;
  reviewMode?: string;
  remember?: boolean;
  temporary?: boolean;
}

export function resolveDeepworkSelection(
  saved: DeepworkPreferences | null,
  input: DeepworkSelectionInput,
): DeepworkSessionConfig {
  const base = saved ?? defaultDeepworkPreferences();
  const executionMode = input.executionMode
    ? deepworkExecutionModeSchema.parse(input.executionMode)
    : base.executionMode;
  const goalStyle = input.goalStyle
    ? deepworkGoalStyleSchema.parse(input.goalStyle)
    : base.goalStyle;
  const reviewMode = input.reviewMode
    ? deepworkReviewModeSchema.parse(input.reviewMode)
    : base.reviewMode;

  return {
    executionMode,
    goalStyle,
    reviewMode,
    persisted: Boolean(saved),
    temporaryOverride: Boolean(input.temporary),
  };
}

export async function createDeepworkResponse(input: DeepworkSelectionInput): Promise<DeepworkOnboardingResponse> {
  const saved = await loadDeepworkPreferences();
  const hasExplicitSelection = Boolean(input.executionMode || input.goalStyle || input.reviewMode);
  const shouldPersist = hasExplicitSelection && input.remember && !input.temporary;

  let activePreferences: DeepworkPreferences | null = saved;
  if (hasExplicitSelection) {
    const selected = resolveDeepworkSelection(saved, input);
    if (shouldPersist) {
      activePreferences = await saveDeepworkPreferences({
        executionMode: selected.executionMode,
        goalStyle: selected.goalStyle,
        reviewMode: selected.reviewMode,
      }, "cli");
    }
  }

  const session = resolveDeepworkSelection(activePreferences, input);
  const isFirstRun = !saved && !hasExplicitSelection;
  const status = isFirstRun ? "needs-onboarding" : "ready";
  const message = isFirstRun
    ? "You have entered /deepwork. Choose a mode, goal style, and review level before starting real work."
    : `Current default is ${session.executionMode} + ${session.goalStyle} + ${session.reviewMode}. Continue or switch.`;

  return {
    entry: "/deepwork",
    status,
    message,
    preferences: session,
    options: {
      executionModes: EXECUTION_MODE_OPTIONS.map((item) => ({ ...item })),
      goalStyles: GOAL_STYLE_OPTIONS.map((item) => ({ ...item })),
      reviewModes: REVIEW_MODE_OPTIONS.map((item) => ({ ...item })),
    },
  };
}

export function buildDeepworkPreferenceSummary(preferences: DeepworkSessionConfig): string {
  return `${preferences.executionMode} + ${preferences.goalStyle} + ${preferences.reviewMode}`;
}
