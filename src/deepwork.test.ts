import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeepworkResponse, deepworkPreferencesPath, loadDeepworkPreferences, saveDeepworkPreferences } from "./deepwork.js";

describe("deepwork preferences", () => {
  const originalHome = process.env.CODEX_WORKFLOW_HOME;

  beforeEach(async () => {
    process.env.CODEX_WORKFLOW_HOME = path.join(os.tmpdir(), "codex-workflow-tests", `deepwork-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fs.rm(deepworkPreferencesPath(), { force: true });
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.CODEX_WORKFLOW_HOME;
      return;
    }
    process.env.CODEX_WORKFLOW_HOME = originalHome;
  });

  it("returns onboarding response when no preferences are saved", async () => {
    const response = await createDeepworkResponse({});
    assert.equal(response.entry, "/deepwork");
    assert.equal(response.status, "needs-onboarding");
    assert.equal(response.preferences.executionMode, "hybrid");
    assert.equal(response.preferences.goalStyle, "explicit-goals");
    assert.equal(response.preferences.reviewMode, "standard-review");
  });

  it("saves preferences when remember is true", async () => {
    await createDeepworkResponse({
      executionMode: "cli-first",
      goalStyle: "proactive-decomposition",
      reviewMode: "strict-review",
      remember: true,
    });

    const saved = await loadDeepworkPreferences();
    assert.ok(saved);
    assert.equal(saved.executionMode, "cli-first");
    assert.equal(saved.goalStyle, "proactive-decomposition");
    assert.equal(saved.reviewMode, "strict-review");
  });

  it("does not persist temporary overrides", async () => {
    await saveDeepworkPreferences({
      executionMode: "hybrid",
      goalStyle: "explicit-goals",
      reviewMode: "standard-review",
    });

    const response = await createDeepworkResponse({
      executionMode: "cli-first",
      temporary: true,
    });

    assert.equal(response.preferences.executionMode, "cli-first");
    assert.equal(response.preferences.temporaryOverride, true);

    const saved = await loadDeepworkPreferences();
    assert.ok(saved);
    assert.equal(saved.executionMode, "hybrid");
  });

  it("reuses saved defaults on returning entry", async () => {
    await saveDeepworkPreferences({
      executionMode: "codex-first",
      goalStyle: "proactive-decomposition",
      reviewMode: "strict-review",
    });

    const response = await createDeepworkResponse({});
    assert.equal(response.status, "ready");
    assert.match(response.message, /Current default is codex-first \+ proactive-decomposition \+ strict-review/i);
  });
});
