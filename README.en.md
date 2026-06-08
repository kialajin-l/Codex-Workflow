# Codex Workflow

> Hook-driven workflow orchestration for Codex with parallel batches, CLI workers, review gates, and resumable runs.

![License](https://img.shields.io/badge/License-MIT-yellow.svg)
![Version](https://img.shields.io/badge/Version-v0.1.0-blue.svg)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green.svg)

<p align="center"><b>English</b> | <a href="README.md"><b>中文</b></a></p>

<p align="center">
  <img src="./docs/assets/banner.svg" alt="Codex Workflow Banner" width="100%">
</p>

**Codex Workflow** turns one-off prompting into a reusable execution pipeline.
It is designed for routing different task types to different executors, inserting hooks and skills around dispatch, gating completion with review, and preserving task / batch state for repeatable work.

---

## Why It Exists

Codex is strong at focused execution, but recurring project work usually needs more structure around it:

- different tasks should go to different executors
- some outputs need review gates before they count as done
- batch runs need logs, summaries, and restartability
- workflow rules should be reusable instead of re-prompted every time

Codex Workflow provides that layer without requiring a separate orchestration service.

---

## Core Capabilities

| Capability | What it does |
|------|------|
| Parallel batch execution | Run multiple goals in serial or parallel with `maxParallel` control |
| Auto routing | Assign executor, role, and complexity from `model-profiles.json` |
| Hook pipeline | Apply `task:before_dispatch`, `task:after_result`, and `review:after` |
| Resumable runs | Retry only unfinished tasks with `run-batch --resume <batch-id>` |
| Review loop | Accept, reject, retry, or block worker output before finalizing |
| Structured logs | Write NDJSON logs into the target project's `.workflow-state/logs/` |
| Cost estimation | Summarize estimated token and cost usage from routed task profiles |
| Mixed execution modes | Switch between external CLI workers and Codex-managed handling |

---

## Runtime Model

<p align="center">
  <img src="./docs/assets/architecture.svg" alt="Codex Workflow Architecture" width="100%">
</p>

Execution flow:

1. Accept one goal or a batch of goals
2. Optionally auto-route each task
3. Apply dispatch hooks and inject skills
4. Run the executor
5. Review the result
6. Apply after-result and review-after hooks
7. Save task state, batch summary, logs, and estimated cost
8. Resume later if the batch was interrupted

---

## How To Use It

The public chat entrypoint for ordinary users is:

- `/deepwork`

After installation, users should activate the workflow inside the Codex chat UI with `/deepwork`.  
CLI commands remain available for advanced users, debugging, and plugin development, but they are not the primary user path.

Chat-first behavior is documented here:

- [Chat-First Workflow](./docs/chat-first-workflow.md)
- [Preference Persistence](./docs/preference-persistence.md)

Advanced terminal usage is documented here:

- [Advanced CLI](./docs/advanced-cli.md)

---

## Installation

There are two separate steps:

1. **Get the repository locally**
2. **Install the current repository contents into your local Codex home**

The current `npm run install-plugin` only covers step 2, meaning installation from a local checked-out repository.  
If users do not want to clone first, they can use the remote installer below.

### Standard local install flow

```bash
git clone https://github.com/kialajin-l/codex-workflow.git
cd codex-workflow
npm install
npm run build
npm run install-plugin
```

`install.js` syncs repository assets into local `~/.codex/`:

- `SKILL.md` -> `~/.codex/skills/codex-workflow/`
- `agents/`
- `hooks/`
- `skills/`
- `workflows/`

It also registers the Codex App plugin:

- copies the plugin bundle to `~/plugins/codex-workflow/`
- adds `codex-workflow` to the local marketplace at `~/.agents/plugins/marketplace.json`
- runs `codex plugin add codex-workflow@<local-marketplace>`
- installs the slash command from `commands/deepwork.md`

It also ensures:

- `~/.codex/codex-workflow/workflows/pdca-default.json`
- `~/.codex/codex-workflow/runtime/`
- `~/.codex/codex-workflow/bin/`

If `codex plugin add` fails with a Windows access-denied error, the runtime install may still be usable through the wrapper scripts. Close or restart the Codex App, then retry:

```powershell
codex plugin add codex-workflow@kiala-local-plugins
```

This refreshes the App-side plugin cache so `/deepwork` can appear in the composer.

### What this repo supports today

- local source install
- local build
- local sync into Codex directories
- Codex App plugin registration
- `/deepwork` slash-command installation

### Remote install

The repository now includes remote install scripts.

PowerShell:

```powershell
irm https://raw.githubusercontent.com/kialajin-l/Codex-Workflow/main/install.ps1 | iex
```

Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/kialajin-l/Codex-Workflow/main/install.sh | bash
```

The remote installer will:

1. download the source from GitHub
2. run `npm install`
3. run `npm run build`
4. prune dev dependencies
5. call `install.js` to sync into local `~/.codex/`
6. register and install the local Codex plugin

After installing or updating, open a new Codex thread or restart / refresh the Codex App so the composer can reload slash commands.

### Installed CLI locations

After installation, the runtime and wrappers are placed at:

- `~/.codex/codex-workflow/runtime/`
- `~/.codex/codex-workflow/bin/`

Windows:

- `~/.codex/codex-workflow/bin/cwf.cmd`
- `~/.codex/codex-workflow/bin/cwf.ps1`

macOS / Linux:

- `~/.codex/codex-workflow/bin/cwf`

### Primary app entrypoint

After installation, use the Codex chat composer:

```text
/deepwork
```

Typing `/` should show `/deepwork` after the app has reloaded the installed plugin.

### Advanced CLI smoke test

The terminal wrapper is for runtime inspection, debugging, and advanced users:

Windows PowerShell:

```powershell
& $HOME\.codex\codex-workflow\bin\cwf.ps1 init
```

Windows CMD:

```bat
%USERPROFILE%\.codex\codex-workflow\bin\cwf.cmd init
```

macOS / Linux:

```bash
~/.codex/codex-workflow/bin/cwf init
```

---

## Quick Start

### 1. Install it

Choose one:

- local repository install
- remote install script

### 2. Enter this in Codex chat

```text
/deepwork
```

### 3. Complete the first-run onboarding

On first entry, the workflow should ask about:

- `Codex-first`, `CLI-first`, or `Hybrid`
- explicit goal-driven mode vs more autonomous decomposition
- normal review vs stricter review gates

Each option should include a short explanation, for example:

- `Codex-first`: stay mostly inside Codex
- `CLI-first`: prefer external CLI workers
- `Hybrid`: route by task type automatically
- `explicit goals`: wait for clear user goals before execution
- `autonomous decomposition`: break tasks down and start pushing forward
- `standard review`: faster
- `strict review`: safer

By default, the workflow should remember the most recently confirmed preference set. If the user says "just for this task" or "only this time", treat it as a session-only override instead of replacing the long-term default.

### 4. Give it a real task

After onboarding, provide the real task and let the workflow start routing and progressing it.

---

## Advanced Commands

CLI commands are documented separately here:

- [Advanced CLI](./docs/advanced-cli.md)

They are intended for:

- runtime debugging
- executor probing
- preset save/load workflows
- batch and task inspection
- plugin development and maintenance

---

## Plugin Entrypoints

Current standard entrypoints:

- [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json)
- [`.mcp.json`](./.mcp.json)
- [`commands/deepwork.md`](./commands/deepwork.md)

Presentation assets:

- [`assets/`](./assets/)
- [`docs/assets/`](./docs/assets/)

---

## Project Structure

```text
codex-workflow/
├── .codex-plugin/              # Codex plugin manifest
├── .mcp.json                   # MCP server config
├── commands/                   # Codex App slash commands
├── assets/                     # plugin icon, logo, screenshots
├── docs/                       # user and maintainer docs
├── agents/                     # bundled agent assets
├── hooks/                      # default hook configs
├── skills/                     # injectable skill fragments
├── workflows/                  # workflow presets
├── src/                        # CLI and runtime implementation
├── workflow.config.json        # executor and concurrency config
├── model-profiles.json         # routing and cost profiles
└── install.js                  # local installer
```

---

## Customization

In most cases, change configuration before changing runtime code.

Recommended order:

1. `workflow.config.json`
2. `hooks/*.json`
3. `workflows/*.json`

Start here:

- [Getting Started](./docs/getting-started.md)
- [Chat-First Workflow](./docs/chat-first-workflow.md)
- [Preference Persistence](./docs/preference-persistence.md)
- [Advanced CLI](./docs/advanced-cli.md)
- [Customizing Workflows](./docs/customizing-workflows.md)
- [Hooks Reference](./docs/hooks-reference.md)
- [Plugin Structure](./docs/plugin-structure.md)

---

## Contributing

```bash
git clone https://github.com/kialajin-l/codex-workflow.git
cd codex-workflow
npm install
npm run build
```

If you want to evolve workflow behavior, read the docs first and change config before runtime internals.

---

## License

[MIT](./LICENSE)
