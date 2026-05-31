# Phase 7 — 生产加固

> **项目位置**：E:\code\codex-workflow  
> **前置状态**：Phase 6 完成（全部 5 个 Hook 事件 + delegated 闭环 + 汇总报告）  
> **预计耗时**：10-14 小时  
> **目标**：从「能跑」到「敢在生产环境连续用」

---

## 阶段目标

| #   | 能力     | 当前状态                         | 目标状态                          |
| --- | ------ | ---------------------------- | ----------------------------- |
| 1   | 错误恢复   | serve 崩溃 → batch 丢失；无断点续传    | serve 崩溃 → 重启后可从断点恢复          |
| 2   | 成本追踪   | 无 token/费用统计                 | 每次 batch 输出 token 消耗 + 费用估算   |
| 3   | 并发控制   | 无上限，可能打满 CPU                 | `maxParallel` 配置，超出排队         |
| 4   | 执行超时   | 仅 serve executor 有 timeoutMs | 所有 executor 统一超时 + 超时后自动 kill |
| 5   | 结构化日志  | 仅 console.error 打点           | 每次 batch 写结构化日志文件             |
| 6   | CLI 体验 | 纯 JSON 输出                    | 实时进度 + 彩色状态 + 耗时统计            |

---

## 7.0 前置准备

```powershell
cd E:\code\codex-workflow
git checkout -b phase7-production

# 确认 Phase 6 完整
npm run build
node dist/index.js run-batch --goals "smoke" --mode serial --auto-route
node dist/index.js probe --executor opencode-serve --auto
```

**理解本轮改动范围**：

| 文件                     | 改动类型                              |
| ---------------------- | --------------------------------- |
| `src/workflow.ts`      | 加超时 + 并发控制 + 错误恢复                 |
| `src/executor.ts`      | 加超时 kill + serve 健康检查             |
| `src/cost.ts`          | **新建**：token 统计与费用估算              |
| `src/logger.ts`        | **新建**：结构化日志                      |
| `src/index.ts`         | 加 `run-batch --resume` + 新 CLI 参数 |
| `workflow.config.json` | 加全局 `maxParallel` 配置              |
| `model-profiles.json`  | 加每个模型的 `costPer1K` 定价             |

---

## 7.1 — 成本追踪

**预计耗时**：3-4 小时  
**优先级**：P0

### 步骤 1：在 model-profiles.json 中补充定价

在每个 model profile 中新增 `costPer1K` 字段（单位：美元 / 1000 token）：

```json
{
  "modelProfiles": {
    "deepseek/deepseek-v4-flash": {
      "executor": "opencode",
      "tags": ["fast", "cheap", "code"],
      "maxComplexity": "medium",
      "preferredRoles": ["implementer", "debugger"],
      "costRank": 1,
      "costPer1K": { "input": 0.00014, "output": 0.00028 },
      "fallbackExecutors": ["opencode-pro"]
    },
    "deepseek/deepseek-v4-pro": {
      "executor": "opencode-pro",
      "tags": ["reasoning", "architecture", "code"],
      "maxComplexity": "high",
      "preferredRoles": ["architect", "debugger", "reviewer"],
      "costRank": 2,
      "costPer1K": { "input": 0.00055, "output": 0.00219 }
    },
    "xiaomi/mimo-v2.5": {
      "executor": "mimo",
      "tags": ["product", "chinese", "ux"],
      "maxComplexity": "medium",
      "preferredRoles": ["planner", "copywriter"],
      "costRank": 1,
      "costPer1K": { "input": 0.0004, "output": 0.0008 },
      "fallbackExecutors": ["opencode-pro"]
    }
  }
}
```

同步更新 zod schema（`src/schema.ts`）和 TypeScript 类型（`src/types.ts`）里的 `ModelProfile`。

### 步骤 2：创建 src/cost.ts

```typescript
import type { ModelProfilesConfig, WorkflowTask } from "./types.js";

export interface TaskCost {
  taskId: string;
  goal: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUSD: number;
}

export interface BatchCost {
  batchId: string;
  tasks: TaskCost[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
}

/**
 * 估算单个 task 的 token 消耗。
 * 当前实现：基于 prompt 长度估算输入，基于 stdout 长度估算输出。
 * 后续可接入真实 API 返回的 usage 字段。
 */
export function estimateTaskCost(
  task: WorkflowTask,
  profiles: ModelProfilesConfig,
): TaskCost | null {
  const profileName = task.route?.profile;
  if (!profileName) return null;

  const profile = profiles.modelProfiles[profileName];
  if (!profile?.costPer1K) return null;

  // 粗估：1 token ≈ 4 字符（英文）/ 1.5 字符（中文）
  const promptChars = (task.workerPrompt ?? "").length;
  const resultChars = (task.workerResult?.stdout ?? "").length;
  const estimatedInput = Math.ceil(promptChars / 4);
  const estimatedOutput = Math.ceil(resultChars / 4);

  const costUSD =
    (estimatedInput / 1000) * profile.costPer1K.input +
    (estimatedOutput / 1000) * profile.costPer1K.output;

  return {
    taskId: task.id,
    goal: task.goal,
    model: profileName,
    estimatedInputTokens: estimatedInput,
    estimatedOutputTokens: estimatedOutput,
    estimatedCostUSD: Math.round(costUSD * 1000000) / 1000000, // 6 位小数
  };
}

export function summarizeBatchCost(
  tasks: WorkflowTask[],
  profiles: ModelProfilesConfig,
): BatchCost | null {
  const taskCosts = tasks
    .map((task) => estimateTaskCost(task, profiles))
    .filter((tc): tc is TaskCost => tc !== null);

  if (taskCosts.length === 0) return null;

  return {
    batchId: "",
    tasks: taskCosts,
    totalInputTokens: taskCosts.reduce((sum, tc) => sum + tc.estimatedInputTokens, 0),
    totalOutputTokens: taskCosts.reduce((sum, tc) => sum + tc.estimatedOutputTokens, 0),
    totalCostUSD: Math.round(taskCosts.reduce((sum, tc) => sum + tc.estimatedCostUSD, 0) * 1000000) / 1000000,
  };
}
```

### 步骤 3：在 runTaskBatch 中接入成本统计

在 `workflow.ts` 的 `runTaskBatch` 末尾，生成 summary 之后、saveBatch 之前：

```typescript
const profiles = await loadModelProfiles(rootDir).catch(() => undefined);
const cost = profiles ? summarizeBatchCost(finalTasks, profiles) : undefined;
```

将 `cost` 写入 `WorkflowBatchResult`（先在 `types.ts` 里加 `cost?: BatchCost` 字段）。

### 步骤 4：验证

```powershell
npm run build

node dist/index.js run-batch --goals "Implement hello,Review login" --mode parallel --auto-route
# 预期：batch JSON 中含 cost 字段，totalCostUSD > 0

# 检查成本合理性
# DeepSeek Flash 的 short task 应该在 $0.0001 量级
```

**常见失败**：

| 症状            | 原因                              | 解决                                    |
| ------------- | ------------------------------- | ------------------------------------- |
| cost 字段为 null | route.profile 为空（没用 auto-route） | auto-route 是 cost 统计的前置条件             |
| costPer1K 读不到 | zod schema 未更新                  | `modelProfileSchema` 加 `costPer1K` 定义 |

✅ **7.1 完成标志**：`--auto-route` 的 batch 含完整 cost 字段。

---

## 7.2 — 并发上限控制

**预计耗时**：2-3 小时  
**优先级**：P0

### 步骤 1：在 workflow.config.json 中加全局配置

```json
{
  "defaultExecutor": "opencode",
  "maxParallel": 4,
  "executors": { ... }
}
```

`maxParallel`：`--mode parallel` 时最多同时跑的 task 数。不设或设 0 = 不限制。

### 步骤 2：在 workflow.ts 中实现分批并发

修改 `runTaskBatch` 的并行执行段。将 `Promise.all(tasks.map(...))` 替换为**分批 Promise.all**：

```typescript
async function runParallelWithLimit(
  tasks: WorkflowTask[],
  limit: number,
  runner: (task: WorkflowTask) => Promise<WorkflowTask>,
): Promise<WorkflowTask[]> {
  if (limit <= 0 || limit >= tasks.length) {
    return Promise.all(tasks.map(runner));
  }

  const results: WorkflowTask[] = [];
  const queue = [...tasks];

  while (queue.length > 0) {
    const batch = queue.splice(0, limit);
    const batchResults = await Promise.all(batch.map(runner));
    results.push(...batchResults);

    if (queue.length > 0) {
      console.error(`[workflow] Batch progress: ${results.length}/${tasks.length} tasks completed`);
    }
  }

  return results;
}
```

在 `runTaskBatch` 中使用：

```typescript
const completedTasks = mode === "parallel"
  ? await runParallelWithLimit(
      tasks,
      config.maxParallel ?? 0,
      runDispatchedTask,
    )
  : await tasks.reduce<Promise<WorkflowTask[]>>(...);  // 串行不变
```

### 步骤 3：验证

```powershell
npm run build

# 设 maxParallel = 2，跑 5 个 task
node dist/index.js run-batch --goals "a,b,c,d,e" --mode parallel --auto-route
# 预期：
#   - stderr 出现 "[workflow] Batch progress: 2/5 tasks completed"
#   - "[workflow] Batch progress: 4/5 tasks completed"
#   - 5 个 task 最终全部 completed

# 设 maxParallel = 0，跑 5 个 task
# 预期：一次性全部并行（行为不变）
```

✅ **7.2 完成标志**：`maxParallel: 2` 时 5 个 task 分 3 批执行。

---

## 7.3 — 执行超时与强制终止

**预计耗时**：2-3 小时  
**优先级**：P0

### 步骤 1：在 spawn executor 中加超时 kill

当前 spawn executor（`runExecutorOnce` 的 spawn 分支）没有超时机制。加上：

```typescript
const timeoutMs = executor.timeoutMs ?? 300000; // 默认 5 分钟
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  // 5 秒后如果还没死，强制 SIGKILL
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 5000);
}, timeoutMs);

child.on("close", (code) => {
  clearTimeout(timer);
  // ... 已有逻辑 ...
});
```

### 步骤 2：在 serve executor 中加超时

当前 serve executor 的轮询循环已有 `maxAttempts = timeoutMs / 500`。确保超时后的 WorkerResult 标注清楚：

```typescript
return {
  status: "failed",
  stdout: `[serve executor timed out after ${timeoutMs}ms]`,
  stderr: `timeout: ${timeoutMs}ms`,
  // ...
};
```

已有的代码在 Phase 3 已做了这个处理。本轮只需确认 `timeoutMs` 在所有 executor 上都有合理的默认值。

### 步骤 3：在 workflow.config.json 中给每个 executor 加 timeoutMs

```json
{
  "executors": {
    "opencode": { "timeoutMs": 180000 },
    "opencode-pro": { "timeoutMs": 300000 },
    "opencode-serve": { "timeoutMs": 120000 },
    "mimo": { "timeoutMs": 180000 }
  }
}
```

### 步骤 4：验证

```powershell
npm run build

# 临时设 opencode-serve timeoutMs = 1000（1 秒）
# 派一个大概率超时的 task
node dist/index.js run-batch --goals "Implement complete auth system with database" --mode serial
# 预期：task 状态为 failed，stderr 含 "timeout: 1000ms"

# 恢复 timeoutMs 为合理值
```

✅ **7.3 完成标志**：超时 task 不挂住进程，返回失败状态。

---

## 7.4 — 错误恢复与断点续传

**预计耗时**：3-4 小时  
**优先级**：P1

### 步骤 1：serve 崩溃后自动重连

在 `executor.ts` 的 `runServeExecutor` 中，当前 `try/catch` 在 status 异常时直接返回 failed。升级为**重试重连**：

```typescript
} catch (error) {
  // 尝试重连
  try {
    await sleep(2000);
    const { client: reconnected } = await acquireServeClient(executor);
    // 用新 client 再试一次 status + messages
    const retryStatus = await reconnected.session.status();
    // ...
  } catch {
    // 重连也失败 → 才报 failed
    return { status: "failed", stdout: "[serve lost and reconnect failed]", ... };
  }
}
```

### 步骤 2：batch 断点续传

在 `index.ts` 中添加 `run-batch --resume <batch-id>` 命令：

```typescript
case "run-batch":
  if (args.resume) {
    await resumeBatch(rootDir, args);
    return;
  }
  await runBatch(rootDir, args);
  return;
```

`resumeBatch` 的逻辑：

```typescript
async function resumeBatch(rootDir: string, args: Record<string, string>): Promise<void> {
  const batch = await loadBatch(rootDir, args.resume);
  const config = await loadConfig(rootDir);

  // 找到未完成的 task
  const pendingTasks = batch.tasks.filter(
    (task) => task.phase !== "completed" && task.phase !== "blocked"
  );

  if (pendingTasks.length === 0) {
    console.log(JSON.stringify({ message: "All tasks already completed or blocked", batch }));
    return;
  }

  console.error(`[workflow] Resuming ${pendingTasks.length} pending tasks from batch ${batch.id}`);

  // 重新执行未完成的 task
  const retried = await Promise.all(
    pendingTasks.map((task) => runTaskWithFallbacks(rootDir, task, config))
  );

  // 合并结果
  const allTasks = batch.tasks.map((task) => {
    const updated = retried.find((t) => t.id === task.id);
    return updated ?? task;
  });

  // 更新 batch
  const updatedBatch: WorkflowBatchResult = {
    ...batch,
    tasks: allTasks,
    phase: allTasks.some(t => t.phase === "blocked") ? "partial" : "completed",
    finishedAt: new Date().toISOString(),
    summary: summarizeBatch(allTasks),
  };

  await saveBatch(rootDir, updatedBatch);
  console.log(JSON.stringify(updatedBatch, null, 2));
}
```

### 步骤 3：验证

```powershell
npm run build

# 跑一个 batch
node dist/index.js run-batch --goals "a,b,c" --mode parallel
# 记下 batch id

# 模拟中断：手工把其中一个 task 的 phase 改为 "dispatched"
# （编辑 .workflow-state/{taskId}.json）

# 恢复执行
node dist/index.js run-batch --resume <batch-id>
# 预期：只重跑 phase != completed 的 task，已完成的跳过

# 最终 batch phase 正确更新
```

✅ **7.4 完成标志**：断点续传跳过已完成 task，只重跑未完成的。

---

## 7.5 — 结构化日志

**预计耗时**：2-3 小时  
**优先级**：P1

### 步骤 1：创建 src/logger.ts

```typescript
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const LOG_DIR = ".workflow-state/logs";

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
  batchId?: string;
  taskId?: string;
  message: string;
  data?: Record<string, unknown>;
}

async function ensureLogDir(rootDir: string): Promise<string> {
  const dir = path.join(rootDir, LOG_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function log(rootDir: string, entry: LogEntry): Promise<void> {
  const dir = await ensureLogDir(rootDir);
  const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
  const logPath = path.join(dir, `workflow-${date}.log`);

  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf8");
}

export function logBatchStart(rootDir: string, batchId: string, goals: string[]): void {
  log(rootDir, {
    timestamp: new Date().toISOString(),
    level: "info",
    event: "batch.start",
    batchId,
    message: `Batch started with ${goals.length} goals`,
    data: { goalCount: goals.length, goals },
  }).catch(() => {});
}

export function logTaskComplete(rootDir: string, batchId: string, taskId: string, phase: string): void {
  log(rootDir, {
    timestamp: new Date().toISOString(),
    level: phase === "completed" ? "info" : "warn",
    event: "task.complete",
    batchId,
    taskId,
    message: `Task ${taskId} ${phase}`,
  }).catch(() => {});
}

export function logBatchEnd(rootDir: string, batchId: string, phase: string, durationMs: number): void {
  log(rootDir, {
    timestamp: new Date().toISOString(),
    level: phase === "completed" ? "info" : "warn",
    event: "batch.end",
    batchId,
    message: `Batch ${batchId} ${phase} in ${durationMs}ms`,
    data: { phase, durationMs },
  }).catch(() => {});
}
```

### 步骤 2：在 workflow.ts 中接入日志

在 `runTaskBatch` 的关键节点：

```typescript
// 开始时
logBatchStart(rootDir, "pending", goals);

// 每个 task 完成时
logTaskComplete(rootDir, batchId, task.id, task.phase);

// 结束时
const durationMs = Date.now() - new Date(startedAt).getTime();
logBatchEnd(rootDir, batch.id, batch.phase, durationMs);
```

### 步骤 3：验证

```powershell
npm run build

node dist/index.js run-batch --goals "a,b,c" --mode parallel --auto-route

# 检查日志文件
Get-Content .workflow-state\logs\workflow-$(Get-Date -Format 'yyyy-MM-dd').log
# 预期：每行一个 JSON，含 batch.start / task.complete × 3 / batch.end
```

✅ **7.5 完成标志**：日志文件存在，内容可被 `jq` 或脚本解析。

---

## 7.6 — CLI 体验优化

**预计耗时**：2-3 小时  
**优先级**：P2

### 步骤 1：实时进度输出

在 `runBatch` 中（`index.ts`），batch 执行时输出进度信息到 stderr：

```typescript
// 在 runTaskBatch 返回后
console.error(`[workflow] Batch ${batch.id}: ${batch.phase}`);
console.error(`[workflow]   Completed: ${batch.summary?.completed ?? 0}/${batch.tasks.length}`);
console.error(`[workflow]   Blocked:   ${batch.summary?.blocked ?? 0}`);
console.error(`[workflow]   Delegated: ${batch.summary?.delegated ?? 0}`);
if (batch.summary?.nextSteps?.length) {
  for (const step of batch.summary.nextSteps) {
    console.error(`[workflow]   → ${step}`);
  }
}

const durationMs = Date.now() - new Date(batch.startedAt).getTime();
console.error(`[workflow]   Duration: ${(durationMs / 1000).toFixed(1)}s`);
if (batch.cost) {
  console.error(`[workflow]   Est. cost: $${batch.cost.totalCostUSD.toFixed(6)}`);
}
```

### 步骤 2：执行耗时

`WorkflowBatchResult` 上已有 `startedAt` 和 `finishedAt`。在汇总输出中自动计算并展示。

### 步骤 3：验证

```powershell
npm run build

node dist/index.js run-batch --goals "Implement hello,Review login,Plan homepage" --mode parallel --auto-route
# 预期：stderr 显示 clear summary（几 completed / 几 blocked / duration / cost）

# stdout 仍然是完整 batch JSON（不受影响）
```

✅ **7.6 完成标志**：stderr 有人类可读的 batch 摘要。

---

## Phase 7 整体验收

```powershell
cd E:\code\codex-workflow

# 1. 构建
npm run build

# 2. 成本追踪
node dist/index.js run-batch --goals "Implement hello,Review login" --mode parallel --auto-route
# 预期：batch.cost.totalCostUSD > 0

# 3. 并发控制
node dist/index.js run-batch --goals "a,b,c,d,e" --mode parallel --auto-route
# 预期：maxParallel=4 时，stderr 显示分批进度

# 4. 超时
# 临时改 config → 验证超时 task 不 hang

# 5. 断点续传
node dist/index.js run-batch --goals "x,y,z" --mode serial
# 手工改 phase → run-batch --resume <id>
# 预期：只重试未完成的

# 6. 结构化日志
# 检查 .workflow-state/logs/ 下有当日日志文件

# 7. CLI 摘要
# stderr 含 human-readable summary + duration + cost

# 8. 全功能回归
node dist/index.js run-batch --goals "Implement hello,Review login,Plan homepage,Debug auth,Design migration" --mode parallel --auto-route
# 预期：5 个 task 正常完成，batch JSON 含 cost + summary + routes
node dist/index.js probe --executor opencode-serve --auto
# 预期：3/3 schema
```

---

## 依赖图

```
7.1 (成本)  ──→ 7.5 (日志)
7.2 (并发)  ──┐
7.3 (超时)  ──┤  三者互不依赖，可并行
              │
7.4 (续传)  ──┘
              │
              └──→ 7.6 (CLI优化，依赖前四项稳定)
```
