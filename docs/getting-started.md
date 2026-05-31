# Getting Started

## 适用对象

这份文档面向第一次使用 **Codex Workflow** 的用户。

如果你只想知道：

- 怎么安装
- 怎么跑第一个 batch
- 怎么看状态和日志
- 中断以后怎么恢复

从这里开始就够了。

---

## 1. 安装依赖

在项目根目录执行：

```bash
npm install
npm run build
```

如果你准备把它作为本地 Codex plugin 使用，再执行：

```bash
npm run install-plugin
```

---

## 2. 初始化状态目录

```bash
node dist/index.js init
```

初始化后会创建：

- `.workflow-state/`

后续 batch、task、probe、日志都会写在这里。

---

## 3. 检查 executor 是否可用

建议先跑探测命令：

```bash
node dist/index.js probe
node dist/index.js probe --executor opencode-serve --auto
```

说明：

- `probe`：检查某个 executor 能不能正常返回结果
- `probe --auto`：连续跑 3 次 schema 检测，并把推荐的 `artifactMode` 写回配置

---

## 4. 运行第一个 batch

```bash
node dist/index.js run-batch --goals "Implement hello,Review login" --mode parallel --auto-route
```

这个命令会做几件事：

1. 根据 `model-profiles.json` 自动分配任务角色和 executor
2. 创建 task 状态文件
3. 按 hook 和 preset 执行任务
4. 输出 batch JSON
5. 在 stderr 输出人类可读摘要

你会看到：

- `stdout`：完整 batch JSON
- `stderr`：完成数、阻塞数、耗时、估算成本

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

- [customizing-workflows.md](./customizing-workflows.md)
- [hooks-reference.md](./hooks-reference.md)
