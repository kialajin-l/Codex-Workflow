import { readFile } from "node:fs/promises";
import path from "node:path";
import { modelProfilesConfigSchema, workflowConfigSchema } from "./schema.js";
import type { ModelProfilesConfig, WorkflowConfig } from "./types.js";

function parseJsonFile(raw: string): unknown {
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

export async function loadConfig(rootDir: string): Promise<WorkflowConfig> {
  const filePath = path.join(rootDir, "workflow.config.json");
  const raw = await readFile(filePath, "utf8");
  const parsed = parseJsonFile(raw);
  return workflowConfigSchema.parse(parsed);
}

export async function loadModelProfiles(rootDir: string): Promise<ModelProfilesConfig> {
  const filePath = path.join(rootDir, "model-profiles.json");
  const raw = await readFile(filePath, "utf8");
  const parsed = parseJsonFile(raw);
  return modelProfilesConfigSchema.parse(parsed);
}
