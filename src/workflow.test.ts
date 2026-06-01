import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reviewWorkerResultForMode } from "./review.js";
import { buildRetryPrompt, buildWorkerPrompt } from "./workflow.js";

describe("workflow prompts", () => {
  it("builds planner artifact prompts with concrete output instructions", () => {
    const prompt = buildWorkerPrompt(
      "Ship a health endpoint - produce a short implementation plan",
      "artifact",
      "planner",
    );

    assert.match(prompt, /Do not ask follow-up questions/i);
    assert.match(prompt, /Do not say you need more context/i);
    assert.match(prompt, /do not claim to have inspected package\.json/i);
    assert.match(prompt, /1\. Goal/i);
    assert.match(prompt, /4\. Risks/i);
  });

  it("builds implementer retry prompts with concrete output instructions", () => {
    const prompt = buildRetryPrompt(
      "Add a hello endpoint",
      "artifact",
      "implementer",
    );

    assert.match(prompt, /^Retry\./i);
    assert.match(prompt, /1\. Deliverable/i);
    assert.match(prompt, /3\. Next step/i);
  });
});

describe("artifact review", () => {
  it("rejects clarification responses for artifact tasks", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "What kind of artifact? HTML page, code file, markdown doc, or something else?",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /asked for clarification/i);
  });

  it("rejects invented repository context for artifact tasks", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "Here is the project's package.json with the dependencies I found in the repository.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /repository context/i);
  });

  it("rejects clarification phrased without a question mark", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "I need clarification. Please specify the content or purpose of the artifact you want.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /asked for clarification/i);
  });

  it("rejects claims about first checking project context", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "Let me check the project context first. Here is one concrete artifact - a sample workflow configuration file.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /asked for clarification/i);
  });

  it("rejects claims of file creation without file access", () => {
    const review = reviewWorkerResultForMode({
      status: "ok",
      stdout: "Done. `workflows/fullstack-router.json` updated with the requested preset.",
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
    }, "artifact");

    assert.equal(review.decision, "retry");
    assert.match(review.issues.join("\n"), /written or updated files/i);
  });
});
