# Phase 6 — 汇总审查 + MCP 作用域 + 质量门

> **项目位置**：E:\code\codex-workflow  
> **前置状态**：Phase 5 完成（Hook 引擎 + exec_mode 分流 + Plugin 骨架）  
> **预计耗时**：8-12 小时  
> **目标**：让剩余 Hook 事件生效、MCP 按阶段作用域化、多 Worker 结果可被汇总审查

---

## 阶段目标

| #   | 能力                | 当前状态                        | 目标状态                                      |
| --- | ----------------- | --------------------------- | ----------------------------------------- |
| 1   | Hook 事件覆盖         | 仅 `task:before_dispatch` 生效 | 5 个事件全部可加载、可匹配、可执行                        |
| 2   | Skill 注入          | Skill 文件存在但未被 hook 引用       | Hook 规则可指定 `inject_skill`，执行时注入到 prompt   |
| 3   | MCP 作用域           | `mcp.json` 为空占位             | `task:before_dispatch` hook 可按阶段启用/禁用 MCP |
| 4   | 预设 `lint-gate`    | 仅在文档中声明                     | 实际可运行：执行后自动 lint → 失败则 block              |
| 5   | delegated task 闭环 | task 标记为 delegated 后无后续     | Codex 可完成 delegated task → 结果回填 → review  |
| 6   | 多 Worker 结果合成     | 各 task 结果独立                 | batch 完成后生成统一汇总报告                         |

---

## 6.0 前置准备

```powershell
cd E:\code\codex-workflow
git checkout -b phase6-review-gates

# 确认 Phase 5 完整
npm run build
node dist/index.js run-batch --goals "smoke" --mode serial --auto-route
node dist/index.js probe --executor opencode-serve --auto
```

**理解关键新增文件**：

| 文件                | 作用             | 状态                                                              |
| ----------------- | -------------- | --------------------------------------------------------------- |
| `src/hooks.ts`    | Hook 加载 + 规则匹配 | 需扩展：`applyTaskAfterResultHook`、`applyReviewAfterHook`           |
| `src/workflow.ts` | 任务编排           | 需扩展：在 task 完成后调 after_result hook、在 review 后调 review:after hook |
| `src/review.ts`   | Worker 结果审查    | 需扩展：支持 hook 规则驱动的审查逻辑                                           |
| `mcp.json`        | MCP 依赖声明       | 需从占位升级为实际 MCP 配置                                                |
| `skills/`         | Skill 模板       | 需新增 `lint-gate.md`                                              |

---

## 6.1 — 剩余 Hook 事件实现

**预计耗时**：3-4 小时  
**优先级**：P0

### 步骤 1：扩展 `hooks.ts` — 新增 `applyTaskAfterResultHook` 和 `applyReviewAfterHook`

在现有 `applyTaskDispatchHook` 函数下方追加：

```typescript
/**
 * 对已完成执行的 task 应用 task:after_result hook。
 * 返回 { action, reason } —— action 为 "proceed" | "retry" | "block"。
 */
export function applyTaskAfterResultHook(
  hook: HookConfig,
  task: WorkflowTask,
): { action: "proceed" | "retry" | "block"; reason: string } {
  if (hook.event !== "task:after_result") {
    return { action: "proceed", reason: "no hook" };
  }

  for (const rule of hook.rules) {
    if (!matchesWhen(rule, task)) continue;

    if (rule.then.action === "retry") {
      return { action: "retry", reason: rule.then.reason as string ?? "hook rule matched retry" };
    }
    if (rule.then.action === "block") {
      return { action: "block", reason: rule.then.reason as string ?? "hook rule matched block" };
    }
    if (rule.then.action === "lint" && task.workerResult) {
      const hasError = /error|FAIL|fail/i.test(task.workerResult.stdout + task.workerResult.stderr);
      if (hasError) {
        return { action: "block", reason: "lint check failed" };
      }
    }
  }

  return { action: "proceed", reason: "no matching rule or rule passed" };
}

/**
 * 对 review 完成后的 task 应用 review:after hook。
 * 返回 { continue, notification }。
 */
export function applyReviewAfterHook(
  hook: HookConfig,
  task: WorkflowTask,
): { shouldContinue: boolean; notification?: string } {
  if (hook.event !== "review:after") {
    return { shouldContinue: true };
  }

  for (const rule of hook.rules) {
    if (!matchesWhen(rule, task)) continue;

    if (rule.then.action === "notify") {
      return {
        shouldContinue: true,
        notification: rule.then.message as string ?? "Review completed",
      };
    }
    if (rule.then.action === "stop") {
      return { shouldContinue: false };
    }
  }

  return { shouldContinue: true };
}
```

### 步骤 2：在 `workflow.ts` 中接入两个新 hook

在 `runDispatchedTask` 的 CLI 路径（`runTaskWithFallbacks` 返回后）中，插入 `task:after_result` hook 调用：

```typescript
// 在 runTaskWithFallbacks 返回后、保存 task 前：
const afterResultHook = hooks.find(h => h.event === "task:after_result");
if (afterResultHook && task.phase === "completed") {
  const afterResult = applyTaskAfterResultHook(afterResultHook, task);
  if (afterResult.action === "block") {
    task.phase = "blocked";
    task.review = {
      decision: "reject",
      summary: afterResult.reason,
      issues: [afterResult.reason],
      reviewedAt: new Date().toISOString(),
    };
  } else if (afterResult.action === "retry") {
    // 不做额外处理，已有 runTaskWithFallbacks 的降级链
  }
}
await saveTask(rootDir, task);
```

在 `runTaskBatch` 的 phase 计算完成后、保存 batch 前，对所有 task 调 `review:after` hook：

```typescript
const reviewAfterHook = hooks.find(h => h.event === "review:after");
if (reviewAfterHook) {
  for (const task of finalTasks) {
    const result = applyReviewAfterHook(reviewAfterHook, task);
    if (result.notification) {
      console.error(`[workflow] ${result.notification}`);
    }
  }
}
```

### 步骤 3：创建 `hooks/review.after.json` 和 `hooks/task.after_result.json` 的默认规则示例

`hooks/task.after_result.json`（默认空规则，需手动编辑激活）：

```json
{
  "event": "task:after_result",
  "rules": []
}
```

`hooks/review.after.json`（默认空规则）：

```json
{
  "event": "review:after",
  "rules": []
}
```

### 步骤 4：验证

```powershell
npm run build

# 测试 after_result hook
# 编辑 hooks/task.after_result.json，加一条：
# { "when": { "route.role": "implementer" }, "then": { "action": "lint", "reason": "auto lint gate" } }
node dist/index.js run-batch --goals "Implement hello" --mode serial --auto-route
# 预期：task 执行后触发 lint 检查（如果 stdout 含 error/fail 则 block）

# 测试 review:after hook
# 编辑 hooks/review.after.json，加一条：
# { "when": { "route.role": "architect" }, "then": { "action": "notify", "message": "Architecture review passed" } }
node dist/index.js run-batch --goals "Design migration" --mode serial --auto-route
# 预期：stderr 中出现 "Architecture review passed"
```

**常见失败**：

| 症状                                               | 原因                       | 解决                                              |
| ------------------------------------------------ | ------------------------ | ----------------------------------------------- |
| after_result hook 不触发                            | hook 文件未被 `loadHooks` 加载 | 确认文件名在 `eventFiles` 数组中（task.after_result.json） |
| lint 检查把正常输出当 error                              | `/error/i` 正则太宽          | 只匹配 `^\s*error[: ]` 或 exitCode != 0             |
| review:after 的 notification 打印到 stdout 而非 stderr | 用错 console               | 用 `console.error` 确保不与 batch JSON 混在一起          |

✅ **6.1 完成标志**：两个新 hook 事件均可独立验证生效。

---

## 6.2 — Skill 注入机制

**预计耗时**：2-3 小时  
**优先级**：P0

### 步骤 1：扩展 `HookRule.then` 支持 `inject_skill`

在 `applyTaskDispatchHook` 中增加 skill 注入逻辑。当 `rule.then.inject_skill` 存在时，将 skill 文件内容附加到 worker prompt 之前：

```typescript
// hooks.ts 新增
import { readFile } from "node:fs/promises";

export async function resolveInjectSkill(
  then: Record<string, unknown>,
  skillsDir: string,
): Promise<string | undefined> {
  const skillName = then.inject_skill as string | undefined;
  if (!skillName) return undefined;

  try {
    const skillPath = path.join(skillsDir, skillName);
    const content = await readFile(skillPath, "utf8");
    return `\n\n## Additional Instructions\n${content}`;
  } catch {
    return undefined;
  }
}
```

在 `workflow.ts` 的 hook 应用段中，注入 skill 内容到 prompt：

```typescript
// 在 applyTaskDispatchHook 之后
if (dispatchHook) {
  for (const task of tasks) {
    const updated = applyTaskDispatchHook(dispatchHook, task);
    // skill 注入
    for (const rule of dispatchHook.rules) {
      if (matchesWhen(rule, task) && rule.then.inject_skill) {
        const skillContent = await resolveInjectSkill(
          rule.then,
          path.join(os.homedir(), ".codex", "codex-workflow", "skills")
        );
        if (skillContent) {
          task.workerPrompt = skillContent + "\n\n" + task.workerPrompt;
        }
      }
    }
  }
}
```

### 步骤 2：验证

```powershell
npm run build

# 编辑 hooks/task.before_dispatch.json：
# { "when": { "route.role": "architect" },
#   "then": { "exec_mode": "codex", "inject_skill": "architecture-review-template.md" } }

node dist/index.js run-batch --goals "Design migration" --mode serial --auto-route
# 验证：task 的 workerPrompt 中应包含 architecture-review-template.md 的内容
```

**常见失败**：

| 症状          | 原因                                     | 解决                                           |
| ----------- | -------------------------------------- | -------------------------------------------- |
| skill 文件读不到 | `skillsDir` 路径错误                       | 确认路径是 `~/.codex/codex-workflow/skills/`       |
| prompt 未被注入 | `inject_skill` 在 `then` 中被 `refine` 拒绝 | 更新 `hookRuleThenSchema`，放行 `inject_skill` 字段 |

✅ **6.2 完成标志**：hook 规则中的 `inject_skill` 生效，prompt 被正确注入。

---

## 6.3 — MCP 作用域

**预计耗时**：2-3 小时  
**优先级**：P1

### 步骤 1：升级 `mcp.json`

将占位 `mcp.json` 替换为：

```json
{
  "name": "codex-workflow-mcp",
  "description": "MCP servers scoped by workflow stage",
  "servers": {
    "websearch": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-exa"],
      "env": { "EXA_API_KEY": "${EXA_API_KEY}" }
    }
  },
  "stageScopes": {
    "plan": ["websearch"],
    "execute": [],
    "review": ["websearch"]
  }
}
```

### 步骤 2：在 `task:before_dispatch` hook 中支持 MCP 启用/禁用

修改 `applyTaskDispatchHook`，当 `then` 包含 `enable_mcp` 或 `disable_mcp` 时，将 MCP 配置写入 task 的扩展字段：

```typescript
// types.ts WorkflowTask 新增字段
mcpEnabled?: string[];
mcpDisabled?: string[];

// hooks.ts applyTaskDispatchHook 中新增
if (Array.isArray(rule.then.enable_mcp)) {
  updated.mcpEnabled = rule.then.enable_mcp as string[];
}
if (Array.isArray(rule.then.disable_mcp)) {
  updated.mcpDisabled = rule.then.disable_mcp as string[];
}
```

### 步骤 3：在 [SKILL.md](http://SKILL.md) 中追加 MCP 处理指令

```markdown
## MCP Scoping

Each task may carry `mcpEnabled` and `mcpDisabled` lists.
- Before executing a CLI task, ensure only `mcpEnabled` MCP servers are active.
- Before executing a Codex task, read `mcpEnabled`/`mcpDisabled` and adjust available tools.
- Default: no MCP restrictions (all servers available).
```

### 步骤 4：验证

```powershell
npm run build

# 编辑 hooks/task.before_dispatch.json：
# { "when": { "route.role": "planner" },
#   "then": { "enable_mcp": ["websearch"] } }

node dist/index.js run-batch --goals "Plan landing page" --mode serial --auto-route
# 验证：task JSON 中应有 mcpEnabled: ["websearch"]
```

**常见失败**：

| 症状                       | 原因              | 解决                                               |
| ------------------------ | --------------- | ------------------------------------------------ |
| mcpEnabled 未出现在 task 上   | `types.ts` 未加字段 | 确认 WorkflowTask 有 `mcpEnabled?` 和 `mcpDisabled?` |
| plan 阶段的 websearch 实际不可用 | MCP server 未安装  | `npx -y @anthropic/mcp-server-exa` 预装            |

✅ **6.3 完成标志**：task 携带 MCP 作用域信息，[SKILL.md](http://SKILL.md) 有对应处理指令。

---

## 6.4 — 预设 `lint-gate` 可运行

**预计耗时**：1-2 小时  
**优先级**：P0

### 步骤 1：创建 `skills/lint-gate.md`

```markdown
# Lint Gate Skill

Before returning your result, ensure:
1. All modified files pass the project's linter.
2. If linting fails, report the errors in the `risks` field.
3. Mark `status: "blocked"` if lint errors exist and cannot be auto-fixed.
```

### 步骤 2：创建 hook 规则文件 `workflows/lint-gate.json`

```json
{
  "name": "lint-gate",
  "hooks": {
    "task.before_dispatch.json": {
      "event": "task:before_dispatch",
      "default_exec_mode": "cli",
      "rules": [
        {
          "when": { "route.role": "implementer" },
          "then": { "inject_skill": "lint-gate.md", "executor": "opencode-serve" }
        }
      ]
    },
    "task.after_result.json": {
      "event": "task:after_result",
      "rules": [
        {
          "when": { "route.role": "implementer" },
          "then": { "action": "lint" }
        }
      ]
    }
  }
}
```

### 步骤 3：验证

```powershell
npm run build

# 加载 lint-gate 预设
node dist/index.js workflow-load --name lint-gate

# 派一个 implementer task（输出含 error 关键词 → 应被 block）
node dist/index.js run-batch --goals "Implement hello endpoint with lint error" --mode serial --auto-route
# 预期：task.phase = "blocked"，reason = "lint check failed"

# 派一个 implementer task（正常输出 → 通过）
node dist/index.js run-batch --goals "Implement hello endpoint clean" --mode serial --auto-route
# 预期：正常 completed
```

✅ **6.4 完成标志**：lint-gate 预设可加载、执行、正确拦截/放行。

---

## 6.5 — Delegated Task 闭环

**预计耗时**：2-3 小时  
**优先级**：P1

### 步骤 1：完善 [SKILL.md](http://SKILL.md) 中 delegated task 处理流程

在 [SKILL.md](http://SKILL.md) 的「Handling delegated_to_codex Tasks」段中，细化 Codex 的具体操作步骤：

```markdown
## Handling delegated_to_codex Tasks (Complete Flow)

When `run-batch` returns tasks with `phase: "delegated_to_codex"`:

1. For each delegated task:
   a. Parse `task.workerResult.stdout` as JSON:
      { action, goal, role, complexity, taskId }
   b. Execute the goal using a Codex subagent in the project directory.
   c. Format the subagent result as a WorkerResult:
      {
        status: "ok" | "failed",
        stdout: "<subagent output>",
        stderr: "",
        exitCode: 0,
        startedAt: "<ISO timestamp>",
        finishedAt: "<ISO timestamp>",
        attempts: 1
      }
   d. Write the result back to:
      .workflow-state/{taskId}.json
      (overwrite the existing file with task.workerResult updated)

2. After all delegated tasks are processed:
   a. Re-run review for each delegated task using reviewWorkerResultForMode.
   b. Update task.phase to "completed" or "blocked".
   c. Update the batch JSON with final task states.

3. Report summary: X tasks completed, Y tasks blocked.
```

### 步骤 2：实战验证

在 Codex 中运行：

```
用户: /workflows
用户: /goal "实现用户登录功能"
用户: 架构设计用 codex subagent，代码实现用 CLI

Codex: [拆分 task]
  task1: Design auth architecture (architect) → exec_mode=codex
  task2: Implement login endpoint (implementer) → CLI
  task3: Implement token refresh (implementer) → CLI

  [执行 task2, task3 后]
  [处理 task1: spawn subagent → 结果回填 → review → completed]
```

**验证点**：

-  delegated task 的 result 被正确回填到 `.workflow-state/{taskId}.json`
-  回填后 batch phase 从 partial 变为 completed
-  Codex 能连续完成 3 个 task（2 个 CLI + 1 个 codex）

✅ **6.5 完成标志**：Codex 完成完整的 mixed CLI+codex batch，delegated task 被正确处理。

---

## 6.6 — 多 Worker 汇总报告

**预计耗时**：2-3 小时  
**优先级**：P2

### 步骤 1：创建 `src/summarize.ts`

```typescript
import type { WorkflowTask, WorkerPayload } from "./types.js";

export interface BatchSummary {
  totalTasks: number;
  completed: number;
  blocked: number;
  delegated: number;
  consensus: "high" | "partial" | "none";
  risks: string[];
  nextSteps: string[];
}

export function summarizeBatch(tasks: WorkflowTask[]): BatchSummary {
  const summary: BatchSummary = {
    totalTasks: tasks.length,
    completed: tasks.filter(t => t.phase === "completed").length,
    blocked: tasks.filter(t => t.phase === "blocked").length,
    delegated: tasks.filter(t => t.phase === "delegated_to_codex").length,
    consensus: "none",
    risks: [],
    nextSteps: [],
  };

  // 共识检测：所有 completed task 的 status 是否一致
  const completedTasks = tasks.filter(t => t.phase === "completed" && t.workerResult?.parsed);
  const allOk = completedTasks.every(t => t.workerResult?.parsed?.status === "ok");
  summary.consensus = completedTasks.length === 0
    ? "none"
    : allOk
      ? "high"
      : "partial";

  // 聚合风险
  for (const task of tasks) {
    const risk = task.workerResult?.parsed?.risks;
    if (risk && risk !== "none" && risk !== "None") {
      summary.risks.push(`[${task.goal}]: ${risk}`);
    }
  }

  // 生成下一步
  if (summary.blocked > 0) {
    summary.nextSteps.push(`${summary.blocked} task(s) blocked — review and retry`);
  }
  if (summary.delegated > 0) {
    summary.nextSteps.push(`${summary.delegated} task(s) delegated to Codex — complete them first`);
  }
  if (summary.completed === summary.totalTasks) {
    summary.nextSteps.push("All tasks completed — proceed to integration or deployment");
  }

  return summary;
}
```

### 步骤 2：在 `runTaskBatch` 末尾生成汇总

```typescript
const summary = summarizeBatch(finalTasks);

const batch: WorkflowBatchResult = {
  // ... 已有字段 ...
  summary,   // ← 新增
};
```

在 `WorkflowBatchResult` 类型中新增 `summary?: BatchSummary`。

### 步骤 3：验证

```powershell
npm run build

node dist/index.js run-batch --goals "Implement hello,Review login,Plan homepage" --mode parallel --auto-route
# 预期：batch JSON 中包含 summary 字段，consensus、risks、nextSteps 有值

# 制造一个 blocked task：
# 用 mock executor + 特殊 goal → 看 risks 和 nextSteps 是否正确反映
```

✅ **6.6 完成标志**：batch JSON 含完整 summary。

---

## Phase 6 整体验收

全部子阶段完成后：

```powershell
cd E:\code\codex-workflow

# 1. 构建
npm run build

# 2. 所有 5 个 hook 事件可加载
node -e "
  const { loadHooks } = require('./dist/hooks.js');
  loadHooks(require('os').homedir() + '/.codex/codex-workflow').then(h => {
    const events = h.map(x => x.event).sort();
    console.log('Loaded events:', events);
    const expected = ['review:after','task:after_result','task:before_dispatch'];
    console.log('All expected?', expected.every(e => events.includes(e)));
  });
"

# 3. lint-gate 预设可运行
node dist/index.js workflow-load --name lint-gate
node dist/index.js run-batch --goals "Implement hello with lint error" --mode serial --auto-route
# 预期：blocked
node dist/index.js workflow-load --name pdca-default

# 4. Skill 注入生效
# 编辑 hook 规则 → inject_skill → 验证 workerPrompt 被注入

# 5. MCP 作用域信息出现在 task 上
# 编辑 hook 规则 → enable_mcp → 验证 task JSON 含 mcpEnabled

# 6. 多 Worker 汇总
node dist/index.js run-batch --goals "a,b,c" --mode parallel --auto-route
# 预期：batch.summary 存在且有内容

# 7. Phase 5 回归
node dist/index.js run-batch --goals "Implement hello,Review login" --mode parallel --auto-route
# 预期：行为不变

# 8. Phase 4 回归
node dist/index.js probe --executor opencode-serve --auto
# 预期：3/3 schema 成功
```

**全部 8 项通过 = Phase 6 验收完成。**

---

## 依赖图

```
6.1 (剩余Hook) ──┬──→ 6.2 (Skill注入)
                 │
                 ├──→ 6.4 (lint-gate预设)
                 │
                 └──→ 6.3 (MCP作用域，可与6.2/6.4并行)
                        │
                        └──→ 6.5 (Delegated闭环) ──→ 6.6 (汇总报告)
```
