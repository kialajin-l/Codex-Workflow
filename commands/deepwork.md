# /deepwork

Enter Codex Workflow guided workflow mode.

## Arguments

- `task`: optional task or goal to start from
- `mode`: optional execution mode hint: `codex-first`, `cli-first`, or `hybrid`

## Workflow

1. Start with chat-first onboarding when preferences are missing or unclear.
2. Help the user choose execution mode, goal style, and review strictness.
3. Include a short explanation for each option before asking for a choice.
4. If the user provides a task, turn it into a Codex Workflow plan and begin execution.
5. Prefer Codex-managed delegation for `codex-first`; prefer configured CLI workers for `cli-first`; route by task type for `hybrid`.
6. Track delegated tasks by task id, and write results back one task at a time.
7. Summarize progress, blocked tasks, delegated tasks, and the next action.

## Runtime

The installed runtime lives under `~/.codex/codex-workflow/`.
Use the `cwf` wrapper only when terminal-level runtime inspection, batch status, or delegated result writeback is needed.

For ordinary users, keep the interaction in chat and avoid starting with raw terminal commands.
