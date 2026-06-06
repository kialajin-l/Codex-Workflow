---
name: codex-workflow
description: |
  Chat-first workflow orchestration for Codex.
  Activate with /deepwork to enter a guided workflow mode that can
  route work to Codex-managed execution or external CLI workers.
---

# Codex Workflow Plugin

## Public Entry

- Explicit: `/deepwork`
- Implicit: when the user asks to enter a structured multi-step workflow with planning, routing, execution, and review

`/deepwork` is the public chat entrypoint.  
The bundled CLI exists as backend runtime and advanced tooling, not as the primary user interface.

## Expected User Experience

When the user enters `/deepwork`, guide them through a short onboarding instead of asking them to run terminal commands.

The first interaction should help decide:

1. execution style
2. routing style
3. review strictness
4. whether to use Codex-only, CLI-only, or hybrid execution

Use natural chat prompts such as:

- "Choose a workflow mode: Codex-first (stay mostly inside Codex), CLI-first (prefer external coding tools), or Hybrid (route by task type)."
- "How should I start work: explicit goals first (you give clear targets before execution) or proactive decomposition (I break the task down and start pushing it forward)?"
- "How strict should review be: standard review (faster progress) or strict review gate (more checks before tasks count as done)?"

## Operating Modes

- `codex-first`: prefer Codex-managed execution and subagent handling
- `cli-first`: prefer external CLI workers when available
- `hybrid`: route by task type, role, or complexity

## Default Behavior

If the user has not chosen a mode yet:

- default to `hybrid`
- keep review enabled
- prefer explicit goals for safety

## Preference Persistence

`/deepwork` should remember the user's most recent confirmed defaults.

Store these preference fields as the workflow default set:

- `execution_mode`: `codex-first` | `cli-first` | `hybrid`
- `goal_style`: `explicit-goals` | `proactive-decomposition`
- `review_mode`: `standard-review` | `strict-review`

Expected behavior:

1. first-time user: ask all three
2. returning user: restate saved defaults first
3. if the user says "continue" or equivalent, reuse saved defaults
4. if the user says "switch" or changes one item, update only the changed field unless they clearly want a full reset

Use this style of recap:

- "Current default is Hybrid + proactive decomposition + standard review. Continue or switch?"

## Session Override Rules

Not every change should overwrite the long-term default.

Treat changes as **session-only overrides** when the user says things like:

- "for this task"
- "just this time"
- "only for this session"
- "temporarily"

In those cases:

- apply the override for the current `/deepwork` run
- do not replace the saved default set
- mention that the change is temporary

If the user explicitly says to remember it, update the saved defaults.

## Where Preferences Belong

Preference memory should conceptually live in the workflow user config area:

- `~/.codex/codex-workflow/`

If a future implementation persists them to disk, keep them in that scope rather than mixing them into README-only behavior.

## What `/deepwork` Should Do

After onboarding:

1. restate the chosen workflow mode
2. summarize how tasks will be routed
3. ask for the first real task or goal set
4. begin the workflow in chat

When presenting choices, always include a one-line explanation for each option so the user can decide quickly without reading long docs.

For ordinary users, keep the workflow chat-first.

Do not start by telling them to run `node dist/index.js` or `cwf` unless they explicitly ask for advanced or terminal usage.

## Advanced Mode Boundary

Only introduce CLI commands when the user is:

- debugging the workflow runtime
- editing presets, hooks, or routing config manually
- running maintenance or verification tasks
- developing the plugin itself

When that happens, point them to:

- `docs/advanced-cli.md`

## Hook Rule Generation

Conversation preferences can be persisted to:

`~/.codex/codex-workflow/hooks/task.before_dispatch.json`

Use rules to switch tasks between `cli` and `codex` based on role, complexity, goal text, or executor.

## Generating Rules from Conversation

When the user describes their desired workflow behavior:

1. infer which tasks should stay in Codex
2. infer which tasks should go to external CLI workers
3. propose the routing logic in readable form
4. after confirmation, write the corresponding hook JSON
5. mention that advanced users can manage presets through the CLI reference doc

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

- Before executing a CLI task, ensure only `mcpEnabled` MCP servers are active
- Before executing a Codex task, read `mcpEnabled` and `mcpDisabled` and adjust available tools
- Default: no MCP restrictions

## Handling delegated_to_codex Tasks

When the runtime returns a task with `phase: "delegated_to_codex"`:

1. read `task.workerResult.stdout`
2. parse the JSON payload
3. execute the delegated task in Codex
4. write the result back into task state with `complete-delegated --batch <batch-id> --task-id <task-id> --stdout-file <result.json>`
5. continue the review flow

For batches with multiple delegated tasks, complete one task id at a time. Do not reuse one delegated result for the whole batch unless the user explicitly wants the same result applied to every pending delegated task.
