# Customizing Workflows

## 适用对象

这份文档面向想要自己修改流程的高级用户。

你会在这里看到：

- 怎么切换 workflow preset
- 怎么写 hook 规则
- 怎么按角色切换 executor
- 怎么注入 skill
- 怎么控制 CLI / Codex 混合执行

---

## 1. 三层配置模型

Codex Workflow 的流程定制，主要由三层组成：

1. `workflow.config.json`
2. `hooks/*.json`
3. `workflows/*.json`

它们分别负责：

| 层 | 作用 |
|----|------|
| `workflow.config.json` | executor、默认执行器、超时、并发上限 |
| `hooks/*.json` | 单个事件上的规则逻辑 |
| `workflows/*.json` | 一组 hook 规则与 skill 的组合预设 |

---

## 2. 修改 executor 与并发

主配置文件：

- [workflow.config.json](../workflow.config.json)

你通常会改这些字段：

| 字段 | 作用 |
|------|------|
| `defaultExecutor` | 默认执行器 |
| `maxParallel` | 并发上限 |
| `executors.<name>.command` | CLI 命令 |
| `executors.<name>.args` | CLI 参数 |
| `executors.<name>.timeoutMs` | 超时时间 |
| `executors.<name>.artifactMode` | `schema` 或 `text` |

示例：

```json
{
  "defaultExecutor": "opencode",
  "maxParallel": 4
}
```

---

## 3. 修改 workflow preset

当前预设位于：

- [workflows/lint-gate.json](../workflows/lint-gate.json)

运行时用户目录会同步到：

- `~/.codex/codex-workflow/workflows/`

常用命令：

```bash
node dist/index.js workflow-list
node dist/index.js workflow-load --name lint-gate
node dist/index.js workflow-save --name my-workflow
```

推荐流程：

1. 先 `workflow-load` 某个预设
2. 修改用户目录里的 hook
3. 验证运行
4. `workflow-save --name <new-name>` 固化成新预设

---

## 4. 修改 dispatch 规则

dispatch 前规则文件：

- [hooks/task.before_dispatch.json](../hooks/task.before_dispatch.json)

可做的事：

- 改 `exec_mode`
- 改 `executor`
- 注入 `skill`
- 开启 / 关闭 MCP

示例：

```json
{
  "event": "task:before_dispatch",
  "default_exec_mode": "cli",
  "rules": [
    {
      "when": { "route.role": "architect" },
      "then": { "exec_mode": "codex" }
    },
    {
      "when": { "route.role": "implementer" },
      "then": { "executor": "opencode" }
    }
  ]
}
```

---

## 5. 注入 skill

可注入的 skill 文件位于：

- [skills/](../skills/)

例如：

- `lint-gate.md`
- `pdca-default.md`
- `chinese-ux-guidelines.md`

规则写法：

```json
{
  "when": { "route.role": "implementer" },
  "then": { "inject_skill": "lint-gate.md" }
}
```

运行时行为：

- skill 内容会被拼到 `workerPrompt` 前面
- 适合加入风格约束、质量门、语言要求、输出模板

---

## 6. 修改 after-result 质量门

文件：

- [hooks/task.after_result.json](../hooks/task.after_result.json)

常见动作：

| action | 作用 |
|--------|------|
| `lint` | 如果输出含 lint 失败特征则 block |
| `block` | 直接阻断并写 reason |

示例：

```json
{
  "when": { "goalIncludes": "lint error" },
  "then": { "action": "block", "reason": "lint check failed" }
}
```

---

## 7. 修改 review-after 行为

文件：

- [hooks/review.after.json](../hooks/review.after.json)

当前支持的思路：

- `notify`
- `stop`

它适合做：

- 在 review 后打印提醒
- 告诉用户下一步动作
- 对特定类型结果做人工接管提示

---

## 8. CLI 与 Codex 混合执行

`exec_mode` 有两个值：

- `cli`
- `codex`

含义：

| 模式 | 说明 |
|------|------|
| `cli` | 交给外部 CLI worker 运行 |
| `codex` | 标记为 `delegated_to_codex`，等待 Codex 侧继续处理 |

推荐策略：

- `implementer / debugger` → CLI
- `architect / reviewer` → 视情况切 Codex

---

## 9. 推荐改法

如果你想稳定扩展，不建议一上来改源码。

推荐顺序：

1. 先改 `workflow.config.json`
2. 再改 `hooks/*.json`
3. 最后把规则固化为 `workflows/*.json`

只有当你要改这些行为时，再动源码：

- resume 合并逻辑
- review 接受策略
- cost 估算策略
- serve reconnect 策略
