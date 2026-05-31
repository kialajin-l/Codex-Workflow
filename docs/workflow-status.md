# Workflow Status

## Goal

Build a minimal local orchestrator that can:

- dispatch a task to an external CLI worker
- capture the worker output
- review the output before accepting it
- keep the worker choice replaceable

The current objective is not full autonomous multi-agent routing. The current objective is to find one worker line that is stable enough to use as the first production path.

## Current Architecture

- `src/index.ts`: CLI entrypoint with `init`, `run`, `status`, `probe`
- `src/workflow.ts`: task prompt construction and workflow transitions
- `src/executor.ts`: external CLI invocation and stdout normalization
- `src/review.ts`: payload parsing and accept/retry review
- `src/store.ts`: persisted task state under `.workflow-state`
- `workflow.config.json`: executor registry

The host workflow is intentionally small. Most instability is currently outside the host and inside the worker CLIs.

## What Works

- The project can create workflow tasks and persist state.
- The project can run configurable external executors.
- The project can normalize some event-stream outputs.
- The project can probe an executor before trusting it for a real task.
- The review stage can reject malformed worker output instead of silently accepting it.

## What Does Not Work Reliably Yet

### `claude`

Problems seen:

- long startup and occasional timeout in non-interactive mode
- noisy event output
- response format drift even when the prompt is explicit

Assessment:

- useful as a fallback or later comparison target
- not a good first worker line for this MVP

### `opencode + deepseek/deepseek-v4-flash`

Problems seen:

- sometimes returns only `step_start`
- sometimes returns `{}` or otherwise empty useful content

Assessment:

- fast and cheap enough to keep testing
- current behavior is too unstable for direct workflow use

### `opencode + openrouter/xiaomi/mimo-v2.5`

Problems seen:

- can return valid-looking content
- often ignores the requested schema
- sometimes returns only partial event output

Assessment:

- currently the closest line to usable
- still needs adapter-level hardening before it can be trusted

## Design Decisions So Far

### 1. Keep the host simple

The orchestrator is not the current bottleneck. The worker adapters are.

That means:

- avoid major abstraction work in the host
- do not build multi-subagent routing yet
- first prove one stable worker path

### 2. Probe before dispatch

The host now has `probe` because executor instability is the main failure mode.

That means:

- check the worker in isolation first
- avoid mixing "worker is bad" with "workflow logic is bad"

### 3. Review remains strict

The system can repair small formatting defects, but it should not silently invent good outputs from bad ones.

That means:

- tolerate fences and minor JSON damage
- do not accept chatty or empty outputs as success

## Likely Next Paths

### Path A: Harden `opencode`

This is the shortest path if we want to preserve the current shape.

Work items:

- add executor-specific retry rules
- detect `step_start`-only responses as empty runs
- prefer the last useful text event rather than raw stdout
- measure stability across repeated probes instead of one probe

### Path B: Introduce a dedicated worker wrapper

Instead of calling each CLI directly from the host, place a thin adapter script in front of them.

Benefits:

- one normalized contract back to the host
- easier per-model prompt templates
- easier retries and timeouts

Cost:

- one more moving piece

### Path C: Change the acceptance contract

Instead of forcing every worker to emit the final workflow schema, allow a looser worker response and let the host map it into the workflow schema.

Example:

- worker returns free text or a simple status blob
- host summarizes it into `{summary, changes, risks, status}`

This is less strict but may be more realistic for cheap external models.

## Recommended Direction

Current recommendation:

1. keep the host architecture
2. harden `opencode` execution behavior
3. if that still fails, move to a dedicated wrapper layer

The current evidence does not justify building multi-subagent orchestration yet. The first unresolved problem is still single-worker reliability.
