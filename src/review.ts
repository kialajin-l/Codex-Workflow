import { deepworkImplementerPayloadSchema, deepworkPlannerPayloadSchema, workerPayloadSchema } from "./schema.js";
import type { ReviewResult, WorkerArtifact, WorkerPayload, WorkerResult, WorkflowTask } from "./types.js";

export function expectedOutputMode(artifactMode?: "schema" | "text"): "schema" | "artifact" {
  return artifactMode === "text" ? "artifact" : "schema";
}

function normalizeStatus(value: unknown): "ok" | "blocked" | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["ok", "done", "complete", "completed", "success"].includes(normalized)) {
    return "ok";
  }
  if (["blocked", "failed", "error"].includes(normalized)) {
    return "blocked";
  }
  return null;
}

export function extractJsonObject(stdout: string): string | null {
  const output = stdout
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }
  return output.slice(start, end + 1);
}

function readLabeledField(text: string, labels: string[]): string | null {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const label of labels) {
      const pattern = new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+)$`, "i");
      const match = line.match(pattern);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
  }
  return null;
}

function readBulletBlock(text: string, labels: string[]): string[] {
  const lines = text.split(/\r?\n/);
  const items: string[] = [];
  let collecting = false;

  for (const line of lines) {
    if (!collecting) {
      const startsSection = labels.some((label) => new RegExp(`^\\s*${label}\\s*[:：]?\\s*$`, "i").test(line));
      if (startsSection) {
        collecting = true;
        continue;
      }
    }

    if (!collecting) {
      continue;
    }

    if (/^\s*$/.test(line)) {
      if (items.length > 0) {
        break;
      }
      continue;
    }

    if (/^\s*[A-Za-z][A-Za-z ]+\s*[:：]\s*/.test(line) && !/^\s*(?:[-*•]|\d+[.)])/.test(line)) {
      break;
    }

    const bulletMatch = line.match(/^\s*(?:[-*•]|\d+[.)])\s*(.+)$/);
    if (bulletMatch?.[1]?.trim()) {
      items.push(bulletMatch[1].trim());
      continue;
    }

    if (items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`.trim();
    }
  }

  return items.filter(Boolean);
}

function salvageDeepworkPayload(
  stdout: string,
  mode?: WorkflowTask["structuredMode"],
): WorkerPayload | null {
  if (mode === "deepwork-planner") {
    const candidate = {
      summary: readLabeledField(stdout, ["summary", "result", "overview"]),
      changes: readLabeledField(stdout, ["changes", "change", "work", "deliverable"]),
      risks: readLabeledField(stdout, ["risks", "risk", "caveats"]),
      status: normalizeStatus(readLabeledField(stdout, ["status"]) ?? "ok"),
      goal: readLabeledField(stdout, ["goal", "target"]),
      assumptions: readBulletBlock(stdout, ["assumptions", "assumption"]),
      steps: readBulletBlock(stdout, ["steps", "plan", "implementation steps"]),
    };
    const parsed = deepworkPlannerPayloadSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }

  if (mode === "deepwork-implementer") {
    const candidate = {
      summary: readLabeledField(stdout, ["summary", "result", "overview"]),
      changes: readLabeledField(stdout, ["changes", "change", "work"]),
      risks: readLabeledField(stdout, ["risks", "risk", "caveats"]),
      status: normalizeStatus(readLabeledField(stdout, ["status"]) ?? "ok"),
      deliverable: readLabeledField(stdout, ["deliverable", "output", "implementation"]),
      assumptions: readBulletBlock(stdout, ["assumptions", "assumption"]),
      nextStep: readLabeledField(stdout, ["next step", "nextstep", "follow-up"]),
    };
    const parsed = deepworkImplementerPayloadSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }

  return null;
}

function parseDeepworkPayload(
  stdout: string,
  mode?: WorkflowTask["structuredMode"],
): WorkerPayload | null {
  const jsonBlock = extractJsonObject(stdout);
  if (jsonBlock) {
    try {
      const parsed = JSON.parse(jsonBlock) as Record<string, unknown>;
      if (mode === "deepwork-planner") {
        const planner = deepworkPlannerPayloadSchema.safeParse(parsed);
        if (planner.success) {
          return planner.data;
        }
      }

      if (mode === "deepwork-implementer") {
        const implementer = deepworkImplementerPayloadSchema.safeParse(parsed);
        if (implementer.success) {
          return implementer.data;
        }
      }

      const planner = deepworkPlannerPayloadSchema.safeParse(parsed);
      if (planner.success) {
        return planner.data;
      }

      const implementer = deepworkImplementerPayloadSchema.safeParse(parsed);
      if (implementer.success) {
        return implementer.data;
      }
    } catch {
      // Fall through to salvage heuristics.
    }
  }

  return salvageDeepworkPayload(stdout, mode);
}

export function parseStructuredWorkerPayload(
  stdout: string,
  mode?: WorkflowTask["structuredMode"],
): WorkerPayload | null {
  return parseDeepworkPayload(stdout, mode);
}

export function parseWorkerPayload(stdout: string, mode?: WorkflowTask["structuredMode"]): WorkerPayload | null {
  const deepworkPayload = parseStructuredWorkerPayload(stdout, mode);
  if (deepworkPayload) {
    return deepworkPayload;
  }

  if (mode) {
    return null;
  }

  const jsonBlock = extractJsonObject(stdout);
  if (!jsonBlock) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonBlock) as Record<string, unknown>;
    if (" summary" in parsed && !("summary" in parsed)) {
      parsed.summary = parsed[" summary"];
    }
    if (!("summary" in parsed) && parsed.status === "success") {
      parsed.summary = "Probe completed without structured payload.";
      parsed.changes = "none";
      parsed.risks = "worker ignored requested schema";
    }
    const normalized = {
      ...parsed,
      status: normalizeStatus(parsed.status),
    };
    return workerPayloadSchema.parse(normalized);
  } catch {
    try {
      const repaired = jsonBlock
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, "$1\"$2\"$3")
        .replace(/:\s*([A-Za-z_][A-Za-z0-9_ \-]*)(\s*[,}])/g, (_match, value, suffix) => {
          return `: "${String(value).trim()}"${suffix}`;
        });
      const parsed = JSON.parse(repaired) as Record<string, unknown>;
      if (" summary" in parsed && !("summary" in parsed)) {
        parsed.summary = parsed[" summary"];
      }
      const normalized = {
        ...parsed,
        status: normalizeStatus(parsed.status),
      };
      return workerPayloadSchema.parse(normalized);
    } catch {
      return null;
    }
  }
}

export function isStructuredPayload(
  payload: WorkerPayload | null | undefined,
  mode?: WorkflowTask["structuredMode"],
): boolean {
  if (!payload) {
    return false;
  }

  if (mode === "deepwork-planner") {
    const candidate = payload as unknown as Record<string, unknown>;
    return typeof candidate.goal === "string" && Array.isArray(candidate.steps);
  }

  if (mode === "deepwork-implementer") {
    const candidate = payload as unknown as Record<string, unknown>;
    return typeof candidate.deliverable === "string" && typeof candidate.nextStep === "string";
  }

  return true;
}

export function extractWorkerArtifact(stdout: string): WorkerArtifact | null {
  const content = stdout.trim();
  if (!content) {
    return null;
  }

  return {
    type: "text",
    content,
  };
}

export function summarizeArtifact(artifact: WorkerArtifact): WorkerPayload {
  const normalized = artifact.content.replace(/\s+/g, " ").trim();
  const summary = normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;

  return {
    summary: summary || "Worker returned text output.",
    changes: "See artifact content.",
    risks: "Artifact fallback was used instead of strict schema output.",
    status: "ok",
  };
}

function hasExpectedArtifactStructure(output: string): boolean {
  const normalized = output.trim();
  if (!normalized) {
    return false;
  }

  const hasDeliverable = /(?:^|\n)\s*(?:1\.\s*)?deliverable\s*[:\-]/i.test(normalized);
  const hasGoal = /(?:^|\n)\s*(?:1\.\s*)?goal\s*[:\-]/i.test(normalized);
  const hasVerdict = /(?:^|\n)\s*(?:1\.\s*)?verdict\s*[:\-]/i.test(normalized);
  const hasAssumptions = /(?:^|\n)\s*(?:2\.\s*)?assumptions\s*[:\-]/i.test(normalized);
  const hasSteps = /(?:^|\n)\s*(?:3\.\s*)?steps\s*[:\-]/i.test(normalized);
  const hasFindings = /(?:^|\n)\s*(?:2\.\s*)?findings\s*[:\-]/i.test(normalized);
  const hasRisks = /(?:^|\n)\s*(?:4\.\s*)?risks\s*[:\-]/i.test(normalized);
  const hasNextStep = /(?:^|\n)\s*(?:3\.\s*)?next step\s*[:\-]/i.test(normalized);

  if (hasDeliverable && hasAssumptions && hasNextStep) {
    return true;
  }

  if (hasGoal && hasAssumptions && hasSteps) {
    return true;
  }

  if (hasVerdict && hasFindings && hasNextStep) {
    return true;
  }

  if (hasGoal && hasAssumptions && hasSteps && hasRisks) {
    return true;
  }

  return false;
}

function categorizeWorkerFailure(
  result: WorkerResult,
  expected: "schema" | "artifact",
  payload: WorkerPayload | null,
  artifact: WorkerArtifact | null,
  mode?: WorkflowTask["structuredMode"],
): WorkerResult["failureCategory"] | undefined {
  const output = result.stdout.trim();
  const stderr = result.stderr.toLowerCase();

  if (result.status !== "ok") {
    if (stderr.includes("timeout")) {
      return "timeout";
    }
    return "non-zero-exit";
  }

  if (!output) {
    return "empty-output";
  }

  if (expected === "schema" && !isStructuredPayload(payload, mode)) {
    return extractJsonObject(result.stdout) ? "invalid-structured-text" : "invalid-json";
  }

  if (expected === "artifact" && !payload && !artifact) {
    return "invalid-json";
  }

  return undefined;
}

export function reviewWorkerResult(result: WorkerResult): ReviewResult {
  return reviewWorkerResultForMode(result, "artifact");
}

export function reviewWorkerResultForMode(
  result: WorkerResult,
  expected: "schema" | "artifact",
  mode?: WorkflowTask["structuredMode"],
): ReviewResult {
  const issues: string[] = [];
  const output = result.stdout.trim();
  const payload = mode
    ? parseStructuredWorkerPayload(result.stdout, mode)
    : (result.parsed ?? parseWorkerPayload(result.stdout, mode));
  const artifact = result.artifact ?? extractWorkerArtifact(result.stdout);
  const normalizedOutput = output.toLowerCase();
  result.failureCategory = categorizeWorkerFailure(result, expected, payload, artifact, mode);

  if (result.status !== "ok") {
    issues.push("Worker exited with a non-zero status.");
  }

  if (!output) {
    issues.push("Worker returned empty stdout.");
  }

  if (expected === "schema" && !isStructuredPayload(payload, mode)) {
    issues.push("Worker result is missing a valid JSON payload.");
  }

  if (expected === "artifact" && !payload && !artifact) {
    issues.push("Worker result is missing a valid JSON payload.");
  }

  if (
    expected === "artifact" &&
    /(need more context|need clarification|what kind of artifact|what format|which format|please specify|follow-up question|let me check the project context first|\?$)/i.test(normalizedOutput)
  ) {
    issues.push("Worker asked for clarification instead of producing the requested artifact.");
  }

  if (
    expected === "artifact" &&
    /(let me (retry|handle|check|complete|update|verify|run)\b|workflow cli|batch file|workflow state|pending artifacts already exist on disk|delegated task|retry the failed tasks|run the tests?\b)/i.test(normalizedOutput)
  ) {
    issues.push("Worker returned process narration or workflow operations instead of the requested artifact.");
  }

  if (
    expected === "artifact" &&
    /("type"\s*:\s*"(?:step_start|step_finish|tool_use)"|"tool"\s*:\s*"(?:read|list|grep|edit|write|bash)"|"sessionid"\s*:|"callid"\s*:|<path>.*<\/path>|<entries>|<content>)/i.test(output)
  ) {
    issues.push("Worker returned an event stream or tool trace instead of the requested artifact.");
  }

  if (
    expected === "artifact" &&
    /(here is (the|your|this) (project'?s )?`?package\.json`?|i inspected|i reviewed the repository|based on the repository|from the codebase|from package\.json)/i.test(normalizedOutput)
  ) {
    issues.push("Worker claimed repository context that was not provided in the task.");
  }

  if (
    expected === "artifact" &&
    /(\bdone\.\b|created|saved|updated|wrote)\s+`?[^`\n]+`?/i.test(normalizedOutput)
  ) {
    issues.push("Worker claimed to have written or updated files without file access.");
  }

  if (expected === "artifact" && !issues.length && !hasExpectedArtifactStructure(output)) {
    issues.push("Worker result is missing the expected artifact structure or labeled sections.");
  }

  return {
    decision: issues.length === 0 ? "accept" : "retry",
    summary: issues.length === 0
      ? "Worker result accepted for manual follow-up or next workflow step."
      : "Worker result requires retry or a different executor.",
    issues,
    reviewedAt: new Date().toISOString(),
  };
}
