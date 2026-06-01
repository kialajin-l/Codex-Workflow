import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { routeGoals } from "./router.js";
import type { WorkflowConfig } from "./types.js";

describe("deepwork planner routing", () => {
  it("prefers opencode-pro for structured planner goals", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-workflow-router-"));
    const config: WorkflowConfig = {
      defaultExecutor: "opencode",
      executors: {
        opencode: { command: "opencode", args: [] },
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
});
