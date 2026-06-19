/**
 * RuleForge Fence gate smoke test.
 *
 * This is an INTEGRATION smoke that requires a real ruleforge-fence CLI.
 * Set RULEFORGE_FENCE_BIN to a working fence binary before running:
 *
 *   $env:RULEFORGE_FENCE_BIN = "node E:/code/ruleforge-fence-install-smoke/node_modules/@ruleforge/fence/dist/cli.js"
 *   npx tsx src/fence-gate.smoke.ts
 *
 * For unit tests, see src/workflow.test.ts (uses mock fence, no npm dependency).
 */
import { fenceGate } from "../src/fence-gate.js";
import type { WorkflowTask } from "../src/types.js";

function makeTask(overrides: Partial<WorkflowTask>): WorkflowTask {
  return {
    id: crypto.randomUUID(),
    goal: "test",
    executor: "mock",
    phase: "planned",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workerPrompt: "test",
    ...overrides,
  };
}

async function testAllow() {
  const task = makeTask({
    goal: "Add a tiny utility function in src/utils/slug.ts",
  });
  const result = await fenceGate(task);
  console.log("=== allow case ===");
  console.log("allowed:", result?.allowed);
  console.log("action:", result?.decision.action);
  console.log("rule_id:", result?.decision.rule_id);
  console.log("pass:", result?.allowed === true && result?.decision.action === "allow");
  console.log();
  return result;
}

async function testDeny() {
  const task = makeTask({
    goal: "Modify dist/bundle.js to fix a build error",
  });
  const result = await fenceGate(task);
  console.log("=== deny case ===");
  console.log("allowed:", result?.allowed);
  console.log("action:", result?.decision.action);
  console.log("rule_id:", result?.decision.rule_id);
  console.log("pass:", result?.allowed === false && result?.decision.action === "deny");
  console.log();
  return result;
}

async function testSplit() {
  const filePaths = Array.from({ length: 25 }, (_, i) => `src/file${String(i + 1).padStart(2, "0")}.ts`);
  const task = makeTask({
    goal: "Modify many files across the project",
    filePaths,
  });
  const result = await fenceGate(task);
  console.log("=== split case ===");
  console.log("allowed:", result?.allowed);
  console.log("action:", result?.decision.action);
  console.log("rule_id:", result?.decision.rule_id);
  console.log("scale_tier:", result?.decision.scale_tier);
  console.log("pass:", result?.allowed === false && result?.decision.action === "require_split");
  console.log();
  return result;
}

async function main() {
  if (!process.env.RULEFORGE_FENCE_BIN) {
    console.error("Skipping integration smoke: RULEFORGE_FENCE_BIN not set.");
    console.error("Set it to a working fence binary to run this smoke.");
    console.error("Example: $env:RULEFORGE_FENCE_BIN = 'node E:/code/ruleforge-fence-install-smoke/node_modules/@ruleforge/fence/dist/cli.js'");
    process.exit(0);
  }

  const results = await Promise.all([testAllow(), testDeny(), testSplit()]);
  const allPass = results.every((r, i) => {
    if (i === 0) return r?.allowed === true && r?.decision.action === "allow";
    if (i === 1) return r?.allowed === false && r?.decision.action === "deny";
    if (i === 2) return r?.allowed === false && r?.decision.action === "require_split";
    return false;
  });
  console.log("=== summary ===");
  console.log("all pass:", allPass);
  process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
