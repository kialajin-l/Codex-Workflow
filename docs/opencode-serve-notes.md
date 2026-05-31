# OpenCode Serve Notes

## Why this path exists

The current `spawn + stdout scraping` path is enough for experiments, but it is not the right long-term channel for reliable subagent execution.

`opencode serve` gives us a local long-running server on `http://127.0.0.1:4096`.

Confirmed observations:

- the server starts locally
- the root endpoint serves a web client
- the bundled frontend references structured clients such as:
  - `client.session.*`
  - `client.vcs.*`
  - `client.project.*`

This is strong evidence that the stable path is API-first, not stdout-first.

## Current implementation status

The workflow MVP now supports two executor modes:

- `spawn`
- `serve`

`serve` is currently a host-side placeholder path. It does not yet call the real OpenCode HTTP API. It exists so the workflow can already model:

- task dispatch to a long-running service executor
- artifact-first fallback
- review and state transition on the host side

## Why the placeholder matters

We need to prove one full subagent loop before building parallel orchestration.

The current placeholder lets us test the workflow shape:

1. host dispatches to a subagent executor
2. worker returns a text artifact
3. host converts artifact into workflow payload
4. review accepts the result
5. task reaches `completed`

That gives us a stable control path even before the final OpenCode API integration is finished.

## Next integration target

Replace the `serve` placeholder in `src/executor.ts` with real OpenCode HTTP calls.

Expected direction:

- create or reuse a session on the local OpenCode server
- send the task prompt through the structured client/API
- collect session output or artifact data
- map that data into workflow artifact form

## Current protocol findings

Confirmed:

- `opencode serve --pure --hostname 127.0.0.1 --port 4096` starts a local server
- `http://127.0.0.1:4096/` responds with a web app
- the web app references structured clients such as:
  - `client.session.*`
  - `client.vcs.*`
  - `client.project.*`
- the desktop install includes `app.asar` and renderer assets such as:
  - `out/renderer/assets/session-*.js`

Not yet confirmed:

- the exact public HTTP paths for session creation and task submission
- whether the server uses plain REST, RPC, or another transport behind the frontend client

Observed extraction constraints on this machine:

- direct HTTP probing of guessed paths such as `/session` and `/api/session` timed out
- `npx asar` and `npx @electron/asar` were unreliable in the current Windows/npm cache environment
- direct filesystem reads inside `app.asar` are not available through plain Node `fs`

Because of that, the current code keeps the `serve` executor as a workflow-valid placeholder while the real protocol is still being recovered.

## Design rule

Do not require cheap workers to emit the final workflow schema directly.

Preferred path:

- worker returns artifact
- host summarizes artifact into workflow payload

That keeps the executor contract lighter and makes future parallel subagents easier to add.
