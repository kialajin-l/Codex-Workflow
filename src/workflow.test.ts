import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerPayload, reviewWorkerResultForMode } from "./review.js";
import { buildRetryPrompt, buildWorkerPrompt, synthesizeStructuredFallback } from "./workflow.js";

describe("workflow prompts", () => {
  it("builds planner schema prompts with concrete output instructions", () => {
    const prompt = buildWorkerPrompt(
      "Ship a health endpoint - produce a short implementation plan",
      "schema",
      "planner",
    );

    assert.match(prompt, /Return exactly one JSON object/i);
    assert.match(prompt, /No markdown\. No explanation\. No questions\./i);
    assert.match(prompt, /\"goal\":\"string\"/i);
    assert.match(prompt, /\"steps\":\[\s*\"string\"\s*\]/i);
  });

  it("builds implementer retry prompts with schema output instructions", () => {
    const prompt = buildRetryPrompt(
      "Ship a health endpoint - execute the highest-value next step",
      "schema",
      "implementer",
    );

    assert.match(prompt, /^Retry\./i);
    assert.match(prompt, /\"deliverable\":\"string\"/i);
    assert.match(prompt, /\"nextStep\":\"string\"/i);
  });
});

describe("structured payload parsing", () => {
  it("parses planner deepwork schema payload", () => {
    const payload = parseWorkerPayload(JSON.stringify({
      summary: "Created a plan",
      changes: "Outlined the next steps",
      risks: "Endpoint wiring may touch routing",
      status: "ok",
      goal: "Ship a health endpoint",
      assumptions: ["Express app already exists"],
      steps: ["Add route", "Add test"],
    }));

    assert.ok(payload);
    assert.equal(payload.status, "ok");
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
    assert.deepEqual(record.steps, ["Add route", "Add test"]);
  });

  it("parses implementer deepwork schema payload", () => {
    const payload = parseWorkerPayload(JSON.stringify({
      summary: "Proposed the next change",
      changes: "Specified the deliverable and next step",
      risks: "No file edits were made",
      status: "ok",
      deliverable: "Add GET /health returning 200",
      assumptions: ["Node service uses Express"],
      nextStep: "Implement the route in the API layer",
    }));

    assert.ok(payload);
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.deliverable, "Add GET /health returning 200");
    assert.equal(record.nextStep, "Implement the route in the API layer");
  });
});

describe("structured fallback", () => {
  it("synthesizes a planner fallback payload", () => {
    const payload = synthesizeStructuredFallback({
      goal: "Ship a health endpoint - produce a short implementation plan",
      role: "planner",
      structuredMode: "deepwork-planner",
    });

    assert.ok(payload);
    assert.equal(payload.status, "ok");
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(record.goal, "Ship a health endpoint");
    assert.ok(Array.isArray(record.steps));
  });

  it("synthesizes an implementer fallback payload", () => {
    const payload = synthesizeStructuredFallback({
      goal: "Ship a health endpoint - execute the highest-value next step",
      role: "implementer",
      structuredMode: "deepwork-implementer",
    });

    assert.ok(payload);
    assert.equal(payload.status, "ok");
    const record = payload as unknown as Record<string, unknown>;
    assert.equal(typeof record.deliverable, "string");
    assert.equal(typeof record.nextStep, "string");
  });
});

describe("worker result provenance", () => {
  it("marks synthesized fallback results explicitly", () => {
    const fallback = synthesizeStructuredFallback({
      goal: "Ship a health endpoint - produce a short implementation plan",
      role: "planner",
      structuredMode: "deepwork-planner",
    });

    assert.ok(fallback);
    const workerResult = {
      status: "ok" as const,
      source: "fallback-synthesized" as const,
      stdout: JSON.stringify(fallback),
      stderr: "",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempts: 1,
      parsed: fallback,
    };

    assert.equal(workerResult.source, "fallback-synthesized");
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
