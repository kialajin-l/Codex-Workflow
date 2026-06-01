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

function parseDeepworkPayload(
  stdout: string,
  mode?: WorkflowTask["structuredMode"],
): WorkerPayload | null {
  const jsonBlock = extractJsonObject(stdout);
  if (!jsonBlock) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonBlock) as Record<string, unknown>;
    if (mode === "deepwork-planner") {
      const planner = deepworkPlannerPayloadSchema.safeParse(parsed);
      return planner.success ? planner.data : null;
    }

    if (mode === "deepwork-implementer") {
      const implementer = deepworkImplementerPayloadSchema.safeParse(parsed);
      return implementer.success ? implementer.data : null;
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
    return null;
  }

  return null;
}

export function parseWorkerPayload(stdout: string, mode?: WorkflowTask["structuredMode"]): WorkerPayload | null {
  const deepworkPayload = parseDeepworkPayload(stdout, mode);
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
    ? parseWorkerPayload(result.stdout, mode)
    : (result.parsed ?? parseWorkerPayload(result.stdout, mode));
  const artifact = result.artifact ?? extractWorkerArtifact(result.stdout);
  const normalizedOutput = output.toLowerCase();

  if (result.status !== "ok") {
    issues.push("Worker exited with a non-zero status.");
  }

  if (!output) {
    issues.push("Worker returned empty stdout.");
  }

  if (expected === "schema" && !payload) {
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

  const decision = issues.length === 0 ? "accept" : "retry";

  return {
    decision,
    summary: decision === "accept"
      ? "Worker result accepted for manual follow-up or next workflow step."
      : "Worker result requires retry or a different executor.",
    issues,
    reviewedAt: new Date().toISOString(),
  };
}
