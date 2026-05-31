# Getting Started

## 适用对象

这份文档面向第一次使用 **Codex Workflow** 的用户。

如果你只想知道：

- 怎么安装
- 怎么在对话中激活 workflow
- 怎么看状态和日志
- 中断以后怎么恢复

从这里开始就够了。

---

## 1. 安装方式

你可以用两种方式开始：

### 方式 A：从源码仓库运行

在项目根目录执行：

```bash
npm install
npm run build
```

如果你准备把它作为本地 Codex plugin 使用，再执行：

```bash
npm run install-plugin
```

### 方式 B：远程安装后直接运行

PowerShell：

```powershell
irm https://raw.githubusercontent.com/kialajin-l/Codex-Workflow/main/install.ps1 | iex
```

安装完成后，Windows 建议直接用：

```powershell
& $HOME\.codex\codex-workflow\bin\cwf.ps1 init
```

macOS / Linux 建议直接用：

```bash
~/.codex/codex-workflow/bin/cwf init
```

---

## 2. 在 Codex 对话中激活

```text
/deepwork
```

这是普通用户的主入口。

进入后，workflow 应先问你几件事：

- 偏向 `Codex-first`、`CLI-first` 还是 `Hybrid`
- 希望显式 goal 驱动，还是更自主地自动拆分
- 是否启用严格 review gate

完成这些选择后，再开始真正的任务。

---

## 3. 提供你的真实任务

引导完成后，直接输入你的目标。

例如：

- “帮我拆解并推进这个登录模块重构”
- “进入 deepwork，帮我把这个需求拆成可执行任务并开始推进”

---

## 4. 什么时候看 CLI

大多数普通用户不需要直接看 CLI。

CLI 更适合：

- 调试 runtime
- 手动探测 executor
- 保存和切换 preset
- 查看 batch / task 状态

CLI 参考：

- [advanced-cli.md](./advanced-cli.md)

---

## 5. 查看 task / batch 状态

```bash
node dist/index.js status --id <task-id>
node dist/index.js status --batch <batch-id>
```

常见 phase：

- `planned`
- `dispatched`
- `review`
- `completed`
- `blocked`
- `delegated_to_codex`

如果你走的是远程安装路线，对应命令是：

```bash
cwf status --id <task-id>
cwf status --batch <batch-id>
```

---

## 6. 查看日志

日志位于：

- `.workflow-state/logs/`

文件名按日期生成，例如：

- `.workflow-state/logs/workflow-2026-05-31.log`

日志格式是 **NDJSON**，每行一个 JSON，适合脚本处理。

常见事件：

- `batch.start`
- `task.complete`
- `batch.end`

---

## 7. 中断后恢复

如果 batch 中断，或者你手动把某个 task 改回未完成状态，可以执行：

```bash
node dist/index.js run-batch --resume <batch-id>
```

恢复规则：

- 已经 `completed` 的 task 会跳过
- 已经 `blocked` 的 task 会跳过
- 只有未完成 task 会重跑

如果你走的是远程安装路线，对应命令是：

```bash
cwf run-batch --resume <batch-id>
```

---

## 8. 常用参数

| 参数 | 说明 |
|------|------|
| `--goals "a,b,c"` | 逗号分隔的目标列表 |
| `--goals-file file.txt` | 从文件读取 goals |
| `--mode serial` | 串行执行 |
| `--mode parallel` | 并行执行 |
| `--auto-route` | 启用 profile 路由 |
| `--executor <name>` | 指定默认 executor |
| `--resume <batch-id>` | 恢复 batch |

---

## 9. 常见问题

### 为什么没有 cost 字段？

通常是因为没有启用 `--auto-route`。  
当前 cost 估算依赖 `task.route.profile`。

### 为什么 batch 很慢？

先检查：

- `workflow.config.json` 中 executor 的 `timeoutMs`
- 当前是否命中 `opencode-pro` 或 `serve`
- 是否启用了需要额外检查的 workflow preset

### 为什么某个 task 被 block？

先看：

- task 的 `review`
- `task.after_result` hook
- 是否命中了 `lint-gate` 这样的质量门

---

## 下一步

如果你只是使用插件，到这里就可以开始用了。  
如果你想自己改流程，继续读：

- [chat-first-workflow.md](./chat-first-workflow.md)
- [advanced-cli.md](./advanced-cli.md)
- [customizing-workflows.md](./customizing-workflows.md)
- [hooks-reference.md](./hooks-reference.md)
