import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preferExplicitExecutor, routeGoals } from "./router.js";
import type { WorkflowConfig } from "./types.js";

describe("deepwork planner routing", () => {
  it("prefers opencode-pro for structured planner goals", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-router-"));
    const config: WorkflowConfig = {
      defaultExecutor: "opencode",
      executors: {
        opencode: { command: "opencode", args: [] },
        "opencode-serve": { command: "opencode", args: [] },
        "opencode-pro": { command: "opencode", args: [] },
        mimo: { command: "opencode", args: [] },
      },
    };

    const routes = await routeGoals(rootDir, [
      "Ship a health endpoint - produce a short implementation plan",
    ], config, {
      modelProfiles: {
        "deepseek/deepseek-v4-flash": {
          executor: "opencode",
          tags: ["fast"],
          maxComplexity: "medium",
          preferredRoles: ["implementer"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-chat-serve": {
          executor: "opencode-serve",
          tags: ["serve"],
          maxComplexity: "medium",
          preferredRoles: ["implementer", "debugger"],
          costRank: 2,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-v4-pro": {
          executor: "opencode-pro",
          tags: ["reasoning"],
          maxComplexity: "high",
          preferredRoles: ["architect"],
          costRank: 2,
        },
        "xiaomi/mimo-v2.5": {
          executor: "mimo",
          tags: ["product"],
          maxComplexity: "medium",
          preferredRoles: ["planner"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
      },
    });

    assert.equal(routes[0].executor, "opencode-pro");
    assert.equal(routes[0].role, "planner");
    assert.deepEqual(routes[0].fallbackExecutors, ["mimo"]);
  });

  it("prefers mimo-free as the structured planner fallback when available", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-router-"));
    const config: WorkflowConfig = {
      defaultExecutor: "opencode",
      executors: {
        opencode: { command: "opencode", args: [] },
        "opencode-pro": { command: "opencode", args: [] },
        mimo: { command: "opencode", args: [] },
        "mimo-free": { command: "opencode", args: [] },
      },
    };

    const routes = await routeGoals(rootDir, [
      "Ship a health endpoint - produce a short implementation plan",
    ], config, {
      modelProfiles: {
        "deepseek/deepseek-v4-pro": {
          executor: "opencode-pro",
          tags: ["reasoning"],
          maxComplexity: "high",
          preferredRoles: ["architect"],
          costRank: 2,
        },
        "xiaomi/mimo-v2.5": {
          executor: "mimo",
          tags: ["product"],
          maxComplexity: "medium",
          preferredRoles: ["planner"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
        "xiaomi/mimo-v2.5-free": {
          executor: "mimo-free",
          tags: ["free", "product"],
          maxComplexity: "medium",
          preferredRoles: ["planner"],
          costRank: 1,
          fallbackExecutors: ["mimo", "opencode-pro"],
        },
      },
    });

    assert.equal(routes[0].executor, "opencode-pro");
    assert.equal(routes[0].role, "planner");
    assert.deepEqual(routes[0].fallbackExecutors, ["mimo-free"]);
  });

  it("keeps low-risk implementer goals on opencode", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-router-"));
    const config: WorkflowConfig = {
      defaultExecutor: "opencode",
      executors: {
        opencode: { command: "opencode", args: [] },
        "opencode-serve": { command: "opencode", args: [] },
        "opencode-pro": { command: "opencode", args: [] },
        mimo: { command: "opencode", args: [] },
      },
    };

    const routes = await routeGoals(rootDir, [
      "Implement a helper validation utility",
    ], config, {
      modelProfiles: {
        "deepseek/deepseek-v4-flash": {
          executor: "opencode",
          tags: ["fast"],
          maxComplexity: "medium",
          preferredRoles: ["implementer", "debugger"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-chat-serve": {
          executor: "opencode-serve",
          tags: ["serve"],
          maxComplexity: "medium",
          preferredRoles: ["implementer", "debugger"],
          costRank: 2,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-v4-pro": {
          executor: "opencode-pro",
          tags: ["reasoning"],
          maxComplexity: "high",
          preferredRoles: ["architect", "debugger", "reviewer"],
          costRank: 2,
        },
        "xiaomi/mimo-v2.5": {
          executor: "mimo",
          tags: ["product"],
          maxComplexity: "medium",
          preferredRoles: ["planner", "copywriter"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
      },
    });

    assert.equal(routes[0].executor, "opencode");
    assert.equal(routes[0].role, "implementer");
    assert.deepEqual(routes[0].fallbackExecutors, ["opencode-serve", "mimo", "opencode-pro"]);
  });

  it("routes reviewer goals away from opencode when opencode-pro is available", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-router-"));
    const config: WorkflowConfig = {
      defaultExecutor: "opencode",
      executors: {
        opencode: { command: "opencode", args: [] },
        "opencode-serve": { command: "opencode", args: [] },
        "opencode-pro": { command: "opencode", args: [] },
        mimo: { command: "opencode", args: [] },
      },
    };

    const routes = await routeGoals(rootDir, [
      "Review the auth migration architecture and list risks",
    ], config, {
      modelProfiles: {
        "deepseek/deepseek-v4-flash": {
          executor: "opencode",
          tags: ["fast"],
          maxComplexity: "medium",
          preferredRoles: ["implementer", "debugger"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-chat-serve": {
          executor: "opencode-serve",
          tags: ["serve"],
          maxComplexity: "medium",
          preferredRoles: ["implementer", "debugger"],
          costRank: 2,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-v4-pro": {
          executor: "opencode-pro",
          tags: ["reasoning"],
          maxComplexity: "high",
          preferredRoles: ["architect", "debugger", "reviewer"],
          costRank: 2,
        },
        "xiaomi/mimo-v2.5": {
          executor: "mimo",
          tags: ["product"],
          maxComplexity: "medium",
          preferredRoles: ["planner", "copywriter"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
      },
    });

    assert.equal(routes[0].executor, "opencode-pro");
    assert.equal(routes[0].role, "reviewer");
  });

  it("routes copywriter goals to mimo instead of opencode", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-router-"));
    const config: WorkflowConfig = {
      defaultExecutor: "opencode",
      executors: {
        opencode: { command: "opencode", args: [] },
        "opencode-serve": { command: "opencode", args: [] },
        "opencode-pro": { command: "opencode", args: [] },
        mimo: { command: "opencode", args: [] },
      },
    };

    const routes = await routeGoals(rootDir, [
      "Write Chinese UX copy for a frontend validation flow",
    ], config, {
      modelProfiles: {
        "deepseek/deepseek-v4-flash": {
          executor: "opencode",
          tags: ["fast"],
          maxComplexity: "medium",
          preferredRoles: ["implementer", "debugger"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-chat-serve": {
          executor: "opencode-serve",
          tags: ["serve"],
          maxComplexity: "medium",
          preferredRoles: ["implementer", "debugger"],
          costRank: 2,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-v4-pro": {
          executor: "opencode-pro",
          tags: ["reasoning"],
          maxComplexity: "high",
          preferredRoles: ["architect", "debugger", "reviewer"],
          costRank: 2,
        },
        "xiaomi/mimo-v2.5": {
          executor: "mimo",
          tags: ["product"],
          maxComplexity: "medium",
          preferredRoles: ["planner", "copywriter"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
      },
    });

    assert.equal(routes[0].executor, "mimo");
    assert.equal(routes[0].role, "copywriter");
  });

  it("keeps an explicit executor first but preserves routed fallbacks", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-router-"));
    const config: WorkflowConfig = {
      defaultExecutor: "opencode",
      executors: {
        opencode: { command: "opencode", args: [] },
        "opencode-serve": { command: "opencode", args: [] },
        "opencode-pro": { command: "opencode", args: [] },
        mimo: { command: "opencode", args: [] },
      },
    };

    const [route] = await routeGoals(rootDir, [
      "Implement a helper validation utility",
    ], config, {
      modelProfiles: {
        "deepseek/deepseek-v4-flash": {
          executor: "opencode",
          tags: ["fast"],
          maxComplexity: "medium",
          preferredRoles: ["implementer", "debugger"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-chat-serve": {
          executor: "opencode-serve",
          tags: ["serve"],
          maxComplexity: "medium",
          preferredRoles: ["implementer", "debugger"],
          costRank: 2,
          fallbackExecutors: ["opencode-pro"],
        },
        "deepseek/deepseek-v4-pro": {
          executor: "opencode-pro",
          tags: ["reasoning"],
          maxComplexity: "high",
          preferredRoles: ["architect", "debugger", "reviewer"],
          costRank: 2,
        },
        "xiaomi/mimo-v2.5": {
          executor: "mimo",
          tags: ["product"],
          maxComplexity: "medium",
          preferredRoles: ["planner", "copywriter"],
          costRank: 1,
          fallbackExecutors: ["opencode-pro"],
        },
      },
    });

    const explicit = preferExplicitExecutor(route, "opencode");
    assert.equal(explicit.executor, "opencode");
    assert.deepEqual(explicit.fallbackExecutors, ["opencode-serve", "mimo", "opencode-pro"]);
  });
});
