# RuleForge Fence Before-Execute Gate Smoke — 2026-06-19

## 目标

验证 codex-workflow 中 RuleForge Fence before-execute gate 的最小接入实现。

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/fence-gate.ts` | 新增：构造 RuleContext、调用 fence CLI、解析 FenceDecision |
| `src/types.ts` | 扩展 `WorkflowTask`：新增 `filePaths?`、`allowedPaths?`、`deniedPaths?` |
| `src/workflow.ts` | 修改 `runTask()`：在 executor / codex delegation 前统一调用 fenceGate |
| `src/workflow.test.ts` | 新增 8 个 fence gate 回归测试 |
| `src/fence-gate.smoke.ts` | 新增真实 RuleForge Fence CLI integration smoke；未设置 bin 时跳过 |

## Before-Execute 插入点

`src/workflow.ts` → `runTask()` 函数内、**所有** executor/delegation 路径前。

```
task 进入
  → fenceGate(task)        ← 所有路径先过 fence
    → allowed = true?      → 继续
    → allowed = false?     → blocked，记录 rule_id/reason
  → execMode === "codex"? → 委托 codex
  → runTaskWithFallbacks()
```

`runTaskBatch()` / `resumeTaskBatch()` 通过 `createDispatchedTaskRunner()` 调用 `runTask()`，因此 batch、single、codex delegation 都共享同一个 fence 入口。

## 启用策略

| `RULEFORGE_FENCE_ENABLED` | `RULEFORGE_FENCE_BIN` | 行为 |
| --- | --- | --- |
| 未设置 | 未设置 | auto 模式跳过 fence，不阻塞任务 |
| 未设置 | 已设置 | auto 模式启用 fence，调用指定 bin |
| `true` / `1` | 未设置 | 强制启用，fail-closed，任务 blocked + `fence_unavailable` |
| `true` / `1` | 已设置 | 强制启用，调用指定 bin |
| `false` / `0` | 任意 | 禁用 fence，跳过 |

## RuleContext 构造

| 字段 | 来源 |
|------|------|
| `task_id` | `task.id` |
| `goal` | `task.goal` |
| `action` | 从 goal 关键词推断（read/write/execute） |
| `file_paths` | 优先 `task.filePaths`；否则从 goal 提取 `src/...` 等路径 |
| `file_count` | `file_paths.length` |
| `allowed_paths` | 优先 `task.allowedPaths`；默认 `["src/**", "tests/**"]` |
| `denied_paths` | 优先 `task.deniedPaths`；默认 `["dist/**", "node_modules/**", ".env"]` |

## Smoke 结果

| case | expected flow | fence action | rule_id | workflow decision | pass |
| --- | --- | --- | --- | --- | --- |
| allow | continue | allow | all_passed | allow | yes |
| deny | block | deny | denied_paths_block | blocked | yes |
| split | request split | require_split | scale_limit_split | blocked | yes |

## 验证命令

```bash
npm run check     # TypeScript 类型检查 — pass
npm run build     # 编译 — pass
npx tsx --test src/workflow.test.ts  # 67 tests, 0 fail
npx tsx --test src/workflow.test.ts  # 72 tests, 0 fail
npx tsx src/fence-gate.smoke.ts      # skips when RULEFORGE_FENCE_BIN is not set
```

## 返修记录（2026-06-19 P1/P2 fix）

### P1: 硬编码路径
- 修复：移除默认 `npx ruleforge-fence`，避免未发布 npm 包导致真实安装后全量 blocked
- 默认 auto 模式：未设置 `RULEFORGE_FENCE_BIN` 时跳过 fence；显式 `RULEFORGE_FENCE_ENABLED=true` 时仍 fail-closed
- 环境变量 `RULEFORGE_FENCE_BIN` 可显式启用并指定真实 fence CLI
- 验证：`Select-String` 确认无绝对路径残留

### P1: Codex delegation 绕过 fence
- 修复：`fenceGate(task)` 收敛到 `runTask()`，位于 `execMode === "codex"` 检查之前
- 所有路径（single、batch、resume、codex delegation + executor）均先过 fence

### P2: 缺少 workflow 层回归测试
- 新增 8 个测试在 `src/workflow.test.ts`：
  - `blocks task with denied path before executor runs`
  - `blocks task with require_split before executor runs`
  - `allows task with safe path to proceed to executor`
  - `blocks codex-delegated task with denied path before delegation`
  - `runTaskBatch goes through fence gate`
  - `skips fence when RULEFORGE_FENCE_ENABLED and RULEFORGE_FENCE_BIN are unset`
  - `fail-closed when RULEFORGE_FENCE_ENABLED=true but no bin`
  - `skips fence when RULEFORGE_FENCE_ENABLED=false even with deny mock`
- 全部通过（72/72）

## 真实 `/deepwork` 验证（2026-06-19）

测试目录：`E:\code\deepwork-smoke`

| case | 入口 | executor | fence 配置 | 结果 |
| --- | --- | --- | --- | --- |
| 默认 auto skip | `deepwork --executor mimo-free` | opencode serve / `mimo-free` | 未设置 enabled/bin | completed，review accept |
| forced no bin | `deepwork --executor mimo-free` | 未调用 | `RULEFORGE_FENCE_ENABLED=true`，无 bin | blocked，`fence_unavailable` |
| mock allow | `deepwork --executor mimo-free` | opencode serve / `mimo-free` | mock fence allow | completed，review accept |
| mock deny | `deepwork --executor mimo-free` | 未调用 | mock fence deny `dist/**` | blocked，`attempts: 0` |

## Limitations

| 问题 | 当前状态 | 长期建议 |
|------|----------|----------|
| `file_paths` 推断不准确 | 从 goal 文本启发式提取，可能遗漏 | 在 `WorkflowTask` 创建时要求提供 |
| `allowed_paths` 无 scope contract | 硬编码默认值 | 在 config 或 task 中声明 |
| `denied_paths` 硬编码 | 默认 `dist/**`, `node_modules/**`, `.env` | 可从 `workflow.config.json` 读取 |
| `action` 推断粗糙 | 关键词匹配 | 显式声明 |
| `RULEFORGE_FENCE_BIN` 带空格路径 | 当前按空白切分，Windows 路径可能失败 | 支持 command/args 分离或 JSON 数组 |

## 是否建议进入 Codex /deepwork 真实测试

**已完成第一轮。** 最小 gate 已验证通过，核心场景（allow/deny/require_split、auto skip、forced fail-closed、codex delegation 前阻断）均工作正常，72/72 测试通过，并完成 `mimo-free` 真实 executor 链路 smoke。
