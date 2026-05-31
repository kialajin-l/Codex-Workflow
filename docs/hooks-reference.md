# Hooks Reference

## 当前支持的 hook 事件

Codex Workflow 当前围绕 3 个主要 hook 事件工作：

| 事件 | 文件 | 作用 |
|------|------|------|
| `task:before_dispatch` | `task.before_dispatch.json` | 在任务下发前改执行模式、切 executor、注入 skill |
| `task:after_result` | `task.after_result.json` | 在 executor 返回后做质量门、lint、block |
| `review:after` | `review.after.json` | 在 review 完成后做通知或停止 |

类型定义中还保留了：

- `workflow:plan:before`
- `workflow:end`

但当前主流程没有把它们接入执行链。

---

## 1. task:before_dispatch

目标：在任务真正运行前改写 task。

常用场景：

- 指定某个 role 必须走特定 executor
- 指定某类任务必须由 Codex 自己接管
- 注入额外 skill
- 限定可用 MCP

### 可用 when 字段

当前匹配逻辑支持：

- `goalIncludes`
- 任意 task 路径字段，例如：
  - `executor`
  - `route.role`
  - `route.complexity`

### 可用 then 字段

当前实现支持：

- `exec_mode`
- `executor`
- `inject_skill`
- `enable_mcp`
- `disable_mcp`

---

## 2. task:after_result

目标：在 worker 返回后追加规则判断。

当前支持的动作：

- `retry`
- `block`
- `lint`

### 行为说明

`lint`

- 读取 `stdout + stderr`
- 如果 exitCode 非 0，或者输出像 lint 错误，就 block

`block`

- 直接把 task 置为 `blocked`
- reason 会写入 review 结果

---

## 3. review:after

目标：在 review 决策之后追加流程动作。

当前实现支持：

- `notify`
- `stop`

### notify

会在 stderr 打印：

```text
[workflow] <message>
```

### stop

当前只返回 `shouldContinue = false` 语义，但主流程没有进一步扩展停止链式 batch 的复杂逻辑。

---

## 4. 规则匹配机制

匹配逻辑由 `matchesWhen()` 实现。

规则：

- `goalIncludes`：大小写不敏感包含匹配
- 其他字段：严格相等匹配

这意味着：

- 适合做明确的 role / complexity / executor 规则
- 不适合写复杂表达式

如果以后要支持范围判断或正则，需要扩展源码。

---

## 5. skill 注入机制

当 `then.inject_skill` 命中时：

1. 从 skills 目录读取 markdown
2. 包装为 `## Additional Instructions`
3. 拼接到 `workerPrompt` 前面

这是当前最安全、最简单的行为定制入口。

---

## 6. 推荐实践

### 普通使用场景

- `task:before_dispatch`：决定 executor / skill
- `task:after_result`：加质量门
- `review:after`：打印通知

### 不建议放在 hook 里做的事

- 大量业务逻辑分支
- 复杂状态机
- 依赖外部网络回调的控制逻辑

这些更适合直接改源码层。

