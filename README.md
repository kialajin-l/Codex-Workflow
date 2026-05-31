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

## 使用方式

普通用户的公开入口是：

- `/deepwork`

安装完成后，用户应该在 Codex 对话框里输入 `/deepwork` 来激活这套 workflow。  
CLI 命令保留给高级玩家、调试和插件开发者使用，不是普通用户的主入口。

对话入口的行为说明见：

- [Chat-First Workflow](./docs/chat-first-workflow.md)

CLI 命令和调试入口见：

- [Advanced CLI](./docs/advanced-cli.md)

---

## 安装方式

这里要区分两件事：

1. **获取仓库源码**
2. **把当前仓库内容安装到本地 Codex 目录**

当前的 `npm run install-plugin` 属于第 2 种，也就是“基于本地源码仓库的安装”。  
如果用户不想先 clone，也可以直接使用下面的远程安装脚本。

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

### 安装后怎么执行

如果你是通过远程安装脚本安装的，建议直接使用 wrapper：

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

## 快速开始

### 1. 安装

任选一种方式：

- clone 仓库后本地安装
- 直接使用远程安装脚本

### 2. 在 Codex 对话中输入

```text
/deepwork
```

### 3. 完成首次引导

首次进入后，workflow 应询问你：

- 更偏向 `Codex-first`、`CLI-first` 还是 `Hybrid`
- 希望显式 goal 驱动，还是让 workflow 更自主拆分
- 是否启用更严格的 review gate

每个选项都会带一句简短说明，例如：

- `Codex-first`：尽量留在 Codex 内推进
- `CLI-first`：优先调用外部 CLI worker
- `Hybrid`：按任务类型自动分流
- `显式 goal 驱动`：先给清晰目标再执行
- `更自主拆分`：由 workflow 先拆任务再推进
- `普通 review`：更快
- `严格 review`：更稳

### 4. 提交真实任务

完成引导后，直接给出你的真实目标，让 workflow 开始拆分和推进。

---

## 高级命令

CLI 命令已经单独整理到：

- [Advanced CLI](./docs/advanced-cli.md)

这些命令适合：

- 调试 runtime
- 手动探测 executor
- 保存或切换 preset
- 查看 batch / task 状态
- 开发这个插件本身

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
- [Chat-First Workflow](./docs/chat-first-workflow.md)
- [Advanced CLI](./docs/advanced-cli.md)
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
