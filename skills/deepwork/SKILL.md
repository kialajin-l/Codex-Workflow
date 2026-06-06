---
name: deepwork
description: Enter Codex Workflow guided mode. Use when the user types /deepwork, asks to start DeepWork, or wants a structured workflow with mode selection, task routing, delegation, and review gates.
---

# DeepWork

Enter Codex Workflow guided workflow mode.

## Entry Behavior

Start with chat-first onboarding. Do not modify files, create project config, or run a batch until the user confirms the plan.

Ask for the minimal preference set:

- `Codex-first`: stay mostly inside Codex and use Codex-managed delegation.
- `CLI-first`: prefer configured external CLI workers when available.
- `Hybrid`: route by task type, role, or complexity.
- `Explicit goals`: wait for clear user goals before execution.
- `Proactive decomposition`: break a larger task into smaller tasks and propose the first batch.
- `Standard review`: faster progress with normal result checks.
- `Strict review`: slower but safer review gates before tasks count as done.

If preferences are already known, restate them and ask whether to continue or switch.

## After Onboarding

1. Restate the chosen mode, goal style, and review strictness.
2. Ask for the first real task or goal set if the user has not provided one.
3. Turn the task into a Codex Workflow plan.
4. Route work according to the chosen mode.
5. Report progress, blocked tasks, delegated tasks, and next action.

For ordinary users, keep the workflow in chat. Use the `cwf` wrapper only for runtime inspection, batch status, or delegated result writeback.

## Delegated Tasks

When the runtime returns a task with `phase: "delegated_to_codex"`:

1. Parse the delegated payload from `task.workerResult.stdout`.
2. Complete the task in Codex.
3. Write back one task id at a time with `complete-delegated`.
4. Continue review and summary after each writeback.
