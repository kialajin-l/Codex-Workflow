---
name: codex-workflow
description: |
  Multi-agent dynamic workflow orchestration for Codex.
  Provides PDCA pipeline with parallel subagents, CLI worker
  delegation, and hook-based workflow customization.
---

# Codex Workflow Plugin

## Trigger
- Explicit: `/workflows` or `$codex-workflow`
- Implicit: parallel multi-step task execution with review

## Default Behavior
All tasks execute through CLI workers unless hooks set `exec_mode` to `codex`.

- `cli`: external CLI worker
- `codex`: delegated placeholder for a Codex-managed subagent

## Handling delegated_to_codex Tasks
When `run-batch` returns a task with `phase: "delegated_to_codex"`:
1. Read `task.workerResult.stdout`
2. Parse the JSON payload
3. Execute the delegated task in Codex
4. Write the result back into task state
5. Continue review flow

## Workflow Presets
- `pdca-default`
- `lint-gate`
- `multi-review`
- `fast-prototype`

## Commands
- `/workflow save <name>`
- `/workflow load <name>`
- `/workflow list`
- `/workflow preset list`
- `/workflow preset apply <name>`

## Hook Rule Generation
Conversation preferences can be written to:

`~/.codex/codex-workflow/hooks/task.before_dispatch.json`

Use rules to switch tasks between `cli` and `codex` based on role, complexity, goal text, or executor.

## Generating Hook Rules from Conversation
When the user describes their desired workflow:
1. Parse which tasks should use Codex and which should use CLI.
2. Map the request to `task:before_dispatch` when/then rules.
3. Show the proposed rules in readable form before writing.
4. After confirmation, write the JSON to `~/.codex/codex-workflow/hooks/task.before_dispatch.json`.
5. Remind the user they can persist it with `/workflow save <name>`.

Available `when` keys:
- `route.role`
- `route.complexity`
- `executor`

Available `then` keys:
- `exec_mode`
- `executor`

Example:
- `route.role = architect` -> `exec_mode = codex`
- `route.role = implementer` -> `exec_mode = cli`, `executor = opencode`

## MCP Scoping
Each task may carry `mcpEnabled` and `mcpDisabled` lists.
- Before executing a CLI task, ensure only `mcpEnabled` MCP servers are active.
- Before executing a Codex task, read `mcpEnabled` and `mcpDisabled` and adjust available tools.
- Default: no MCP restrictions.

## Handling delegated_to_codex Tasks (Complete Flow)
When `run-batch` returns tasks with `phase: "delegated_to_codex"`:
1. Parse `task.workerResult.stdout` as JSON.
2. Execute the goal with a Codex subagent in the project directory.
3. Write the subagent result back into `.workflow-state/{taskId}.json`.
4. Re-run review for the delegated task and update `task.phase` to `completed` or `blocked`.
5. Update the batch JSON and report how many tasks completed or blocked.
