# Codex Workflow

> 面向 Codex 的 Hook 驱动工作流编排插件，支持并行 batch、CLI worker、review gate 和断点续跑。

![License](https://img.shields.io/badge/License-MIT-yellow.svg)
![Version](https://img.shields.io/badge/Version-v0.1.0-blue.svg)
![Node](https://img.shields.io/badge/Node-%3E%3D18-green.svg)

<p align="center"><a href="README.en.md"><b>English</b></a> | <b>中文</b></p>

<p align="center">
  <img src="./docs/assets/banner.svg" alt="Codex Workflow Banner" width="100%">
</p>

**Codex Workflow** 把一次性的 prompt 执行，整理成一条可配置、可复用、可审查、可恢复的工作流。
它适合把不同类型任务路由到不同 executor，在执行前后插入 hook 和 skill，在结果进入完成态之前加 review gate，并把 task / batch 状态和日志沉淀下来。

---

## 为什么需要它

Codex 很适合做单点执行，但持续性的项目任务通常还需要额外结构：

- 不同任务应该走不同 executor
- 某些任务需要 review 通过后才算完成
- 批处理任务需要日志、摘要和可恢复能力
- workflow 规则应该能复用，而不是每次重新 prompt

Codex Workflow 提供的就是这一层，不依赖额外的独立编排服务。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| 并行 batch 执行 | 用 `run-batch` 以串行或并行方式跑多个 goal，并由 `maxParallel` 控制并发上限 |
| 自动路由 | 基于 `model-profiles.json` 给任务分配 executor、role、complexity |
| Hook 管线 | 支持 `task:before_dispatch`、`task:after_result`、`review:after` |
| 断点续跑 | 通过 `run-batch --resume <batch-id>` 只重跑未完成任务 |
| Review 闭环 | worker 输出先 review，再 accept / reject / retry / block |
| 结构化日志 | 把 NDJSON 日志写入 `.workflow-state/logs/` |
| 成本估算 | 基于路由 profile 汇总估算 token 和成本 |
| 混合执行模式 | 在外部 CLI worker 与 Codex 处理路径之间切换 |

---

## 运行模型

<p align="center">
  <img src="./docs/assets/architecture.svg" alt="Codex Workflow Architecture" width="100%">
</p>

执行链路：

1. 接收单个 goal 或一组 goals
2. 可选地对每个任务做自动路由
3. 应用 dispatch hook 并注入 skill
4. 调用 executor
5. 审查执行结果
6. 应用 after-result 和 review-after hook
7. 保存 task 状态、batch 摘要、日志和成本估算
8. 中断后可继续 resume

---

## 安装方式

这里要区分两件事：

1. **获取仓库源码**
2. **把当前仓库内容安装到本地 Codex 目录**

当前的 `npm run install-plugin` 属于第 2 种，不是远程一键安装器。  
也就是说，用户第一次在 GitHub 页面看到这个项目时，**不能直接跳过 clone 就运行它**。

### 标准本地安装流程

```bash
git clone https://github.com/kialajin-l/codex-workflow.git
cd codex-workflow
npm install
npm run build
npm run install-plugin
```

`install.js` 会把当前仓库中的资源同步到本地 `~/.codex/`：

- `SKILL.md` -> `~/.codex/skills/codex-workflow/`
- `agents/`
- `hooks/`
- `skills/`
- `workflows/`

同时确保存在：

- `~/.codex/codex-workflow/workflows/pdca-default.json`
- `~/.codex/codex-workflow/runtime/`
- `~/.codex/codex-workflow/bin/`

### 现阶段的边界

当前仓库提供的是：

- 本地源码安装
- 本地构建
- 本地同步到 Codex 目录

### 远程安装

现在仓库已经提供远程安装脚本。

PowerShell:

```powershell
irm https://raw.githubusercontent.com/kialajin-l/Codex-Workflow/main/install.ps1 | iex
```

Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/kialajin-l/Codex-Workflow/main/install.sh | bash
```

远程安装脚本会自动：

1. 从 GitHub 下载源码
2. 运行 `npm install`
3. 运行 `npm run build`
4. 裁掉 dev 依赖
5. 调用 `install.js` 安装到本地 `~/.codex/`

### 安装后的 CLI 位置

安装完成后，runtime 和 wrapper 会位于：

- `~/.codex/codex-workflow/runtime/`
- `~/.codex/codex-workflow/bin/`

Windows:

- `~/.codex/codex-workflow/bin/cwf.cmd`
- `~/.codex/codex-workflow/bin/cwf.ps1`

macOS / Linux:

- `~/.codex/codex-workflow/bin/cwf`

---

## 快速开始

### 1. 初始化运行时状态

```bash
node dist/index.js init
```

这会创建 `.workflow-state/`，用于保存 task、batch、probe 和日志文件。

### 2. 探测 executor

```bash
node dist/index.js probe
node dist/index.js probe --executor opencode-serve --auto
```

建议先 probe，再进行真实 batch 执行。

### 3. 跑一个 batch

```bash
node dist/index.js run-batch --goals "Implement hello,Review login" --mode parallel --auto-route
```

输出：

- `stdout`：完整 batch JSON
- `stderr`：人类可读摘要，包括完成数、阻塞数、耗时和估算成本

### 4. 恢复未完成 batch

```bash
node dist/index.js run-batch --resume <batch-id>
```

只有既不是 `completed` 也不是 `blocked` 的任务会被重跑。

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `node dist/index.js init` | 创建 `.workflow-state` |
| `node dist/index.js run --goal "..."` | 执行单个任务 |
| `node dist/index.js run-batch --goals "a,b,c"` | 执行 batch |
| `node dist/index.js run-batch --goals "..." --auto-route` | 启用 profile 路由执行 |
| `node dist/index.js run-batch --resume <batch-id>` | 续跑 batch |
| `node dist/index.js status --id <task-id>` | 查看 task 状态 |
| `node dist/index.js status --batch <batch-id>` | 查看 batch 状态 |
| `node dist/index.js probe --executor <name>` | 探测 executor |
| `node dist/index.js workflow-save --name <name>` | 保存当前 workflow preset |
| `node dist/index.js workflow-load --name <name>` | 加载 workflow preset |
| `node dist/index.js workflow-list` | 列出 preset |

---

## Plugin 入口

当前标准入口：

- [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json)
- [`.mcp.json`](./.mcp.json)

展示资源：

- [`assets/`](./assets/)
- [`docs/assets/`](./docs/assets/)

---

## 项目结构

```text
codex-workflow/
├── .codex-plugin/              # Codex plugin manifest
├── .mcp.json                   # MCP server config
├── assets/                     # plugin icon, logo, screenshots
├── docs/                       # 用户和维护文档
├── agents/                     # 内置 agent 资产
├── hooks/                      # 默认 hook 配置
├── skills/                     # 可注入 skill 片段
├── workflows/                  # workflow preset
├── src/                        # CLI 与运行时实现
├── workflow.config.json        # executor 与并发配置
├── model-profiles.json         # 路由与成本 profile
└── install.js                  # 本地安装脚本
```

---

## 自定义入口

大多数情况下，先改配置，再改运行时代码。

推荐顺序：

1. `workflow.config.json`
2. `hooks/*.json`
3. `workflows/*.json`

从这里开始读：

- [Getting Started](./docs/getting-started.md)
- [Customizing Workflows](./docs/customizing-workflows.md)
- [Hooks Reference](./docs/hooks-reference.md)
- [Plugin Structure](./docs/plugin-structure.md)

---

## 当前范围

已实现：

- spawn executor 流程
- serve executor 流程
- batch、probe、polling、summary
- hook 驱动的路由和阶段作用域
- delegated Codex 处理路径
- 成本跟踪、超时统一、resume 和 NDJSON 日志

还值得继续补强：

- `resume`、hook pipeline、logger、cost summary 的自动化测试
- 更适合 marketplace 展示的截图和文案
- 面向首次用户的远程安装器

---

## 贡献

```bash
git clone https://github.com/kialajin-l/codex-workflow.git
cd codex-workflow
npm install
npm run build
```

如果你要改 workflow 行为，建议先读文档，优先改配置，再改 runtime。

---

## 许可证

[MIT](./LICENSE)
