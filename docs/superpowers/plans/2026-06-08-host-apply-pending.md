# Host Apply Pending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve useful CLI worker deliverables that cannot write files by routing them into a host-apply pending state.

**Architecture:** Add a terminal-but-actionable task phase for DeepWork implementer outputs that self-report blocked while still providing a concrete deliverable and next step. Batch summaries must expose this state separately from hard blocked tasks so the main Codex host can apply the artifact and verify it.

**Tech Stack:** TypeScript, Node.js test runner, existing Codex Workflow runtime.

---

### Task 1: Host-Apply Phase Semantics

**Files:**
- Modify: `src/types.ts`
- Modify: `src/workflow.ts`
- Test: `src/workflow.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving a DeepWork implementer result with `status:"blocked"`, non-empty `deliverable`, and non-empty `nextStep` resolves to `host_apply_pending` instead of `blocked`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test dist/workflow.test.js`
Expected: FAIL because `host_apply_pending` does not exist yet.

- [ ] **Step 3: Implement minimal phase support**

Add `host_apply_pending` to `WorkflowPhase`, add a helper in `workflow.ts`, and return that phase before the generic blocked-status veto.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test dist/workflow.test.js`
Expected: PASS.

### Task 2: Batch Summary Visibility

**Files:**
- Modify: `src/types.ts`
- Modify: `src/summarize.ts`
- Modify: `src/workflow.ts`
- Test: `src/workflow.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving summaries count host-apply tasks separately and include a next step telling the host to apply artifacts.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test dist/workflow.test.js dist/summarize.test.js`
Expected: FAIL because summaries do not expose host-apply pending counts.

- [ ] **Step 3: Implement minimal summary support**

Add `hostApplyPending` to `BatchSummary`, count `phase === "host_apply_pending"`, and treat batches containing this phase as `partial`.

- [ ] **Step 4: Run all tests**

Run: `npm run build && node --test dist/executor.test.js dist/workflow.test.js dist/summarize.test.js dist/deepwork.test.js dist/router.test.js dist/routes/hello.test.js`
Expected: PASS.
