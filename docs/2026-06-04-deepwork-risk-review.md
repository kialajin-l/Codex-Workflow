# Deepwork 风险审查与修复建议 - 2026-06-04

## 1. 背景

本次审查的目的不是评估 `codex-workflow` 是否可用，而是确认：

- 当前 `/deepwork` 在 `Codex CLI` 上是否已经能跑通
- 在“已可用”的前提下，还存在哪些会影响长期可靠性的风险
- 哪些问题应优先交给后续开发修复

本次审查基于真实运行结果，而不是只看代码结构。

## 2. 本次真实演练方式

执行命令：

```powershell
& 'C:\Users\kiala\.codex\codex-workflow\bin\cwf.ps1' deepwork --goal "smoke deepwork flow" --executor opencode-serve --temporary
```

运行环境中当前保存的 deepwork 默认偏好为：

- `executionMode = cli-first`
- `goalStyle = proactive-decomposition`
- `reviewMode = strict-review`

因此本次 `/deepwork` 自动将单个 goal 拆成两个并行子目标：

1. `smoke deepwork flow - produce a short implementation plan`
2. `smoke deepwork flow - execute the highest-value next step`

运行产物位置：

- batch 文件：
  - `C:\Users\kiala\.codex\codex-workflow\runtime\.workflow-state\batch.ead3cf89-7c76-4387-868a-388697bf3ef3.json`
- task 文件：
  - `C:\Users\kiala\.codex\codex-workflow\runtime\.workflow-state\43ffe7ba-90b0-4be8-a0ee-2590a1ae0e37.json`
  - `C:\Users\kiala\.codex\codex-workflow\runtime\.workflow-state\475c02fb-7269-449b-b6be-bd5b7408d0bb.json`
- 日志文件：
  - `C:\Users\kiala\.codex\codex-workflow\runtime\.workflow-state\logs\workflow-2026-06-04.log`

## 3. 本次演练确认的正面结论

这次演练证明以下事情已经成立：

1. `codex-workflow` 已能在 CLI 环境安装并正常运行
2. `/deepwork` 已能读取默认偏好并据此自动生成执行计划
3. 单个 goal 能被自动拆分为多子任务
4. 子任务能够并行下发给 `opencode-serve`
5. executor 输出能够被解析为结构化 JSON
6. review gate 会对每个子任务结果单独审查
7. batch / task / 日志均能落盘到 `.workflow-state`

因此，当前项目状态应定义为：

- **主功能已可用**
- 问题主要在**可信度、状态一致性、自动验证与体验质量**，而不是主路径缺失

## 4. 本次暴露出的关键问题

### 问题 1：worker 自报 `blocked`，最终 task 仍被记为 `completed`

这是本次最重要的问题。

在第二个子任务中，worker 返回的结构化结果为：

- `workerResult.status = ok`
- `workerResult.parsed.status = blocked`

对应 task 文件：

- `C:\Users\kiala\.codex\codex-workflow\runtime\.workflow-state\475c02fb-7269-449b-b6be-bd5b7408d0bb.json`

但最终 task 状态仍然是：

- `phase = completed`

而 batch 汇总里仍然显示：

- `completed = 2`
- `blocked = 0`
- `nextSteps = All tasks completed - proceed to integration or deployment`

对应 batch 文件：

- `C:\Users\kiala\.codex\codex-workflow\runtime\.workflow-state\batch.ead3cf89-7c76-4387-868a-388697bf3ef3.json`

#### 这说明什么

当前系统对“完成”的判定仍然过度依赖：

- executor 是否成功返回
- review 是否 `accept`

而没有把 worker 输出里的 `parsed.status` 作为硬约束纳入最终状态机。

也就是说，当前存在这种不一致：

- worker 明确说：`blocked`
- review 却接受了它
- workflow 最后把整个任务记成：`completed`

#### 风险

这会直接导致：

- 表面完成率偏高
- 阻塞任务被吞掉
- 上层用户看到的“已完成”与底层真实状态不一致
- 批处理结果不可信

#### 建议

必须收口任务完成判定逻辑：

- `review.accept` 不应自动等于 `task.completed`
- 若 `workerResult.parsed.status == blocked`，则 task 至少应进入：
  - `blocked`
  - 或 `waiting_verify`
- batch 汇总中的 `completed` / `blocked` 必须由最终 task 状态推导，而不是只看 review 决策

---

### 问题 2：review gate 当前更像“输出接受器”，不是“完成验证器”

本次两个子任务的 review 都是：

- `decision = accept`

但第二个子任务的实际内容明确写着：

- `no end-to-end execution yet`
- `MCP pool stalls block the entire pipeline`
- `status = blocked`

这说明当前 review gate 的判断逻辑更偏向：

- 输出格式是否合格
- 输出是否像一个可继续使用的报告

而不是：

- 任务是否真的完成
- 风险是否已经消除
- 所谓“next step”是否已经执行

#### 风险

如果 review gate 只接受“像样的回答”，而不承担完成验证责任，就会产生：

- 模型说得很清楚自己没做完
- 系统仍然把它当完成态

#### 建议

把 review 与 verify 分开：

- `review` 负责判断输出质量
- `verify` 负责判断任务是否完成

最小改法：

- 若 `parsed.status != ok`，即使 review 接受，也不能直接置 `completed`
- review 之后增加一层 task status resolver

---

### 问题 3：`/deepwork` 的“执行下一步”子目标容易产生语义漂移

本次第二个自动拆分子目标是：

- `smoke deepwork flow - execute the highest-value next step`

这个表述很容易让 executor 自己理解成：

- 给出一个“最值得做的下一步”分析
- 而不是“真的动手执行下一步”

本次结果中，它输出的是：

- 原型当前有哪些风险
- 没有 end-to-end execution
- 当前系统阻塞在哪里

从分析质量看，这段输出是有价值的。

但从目标语义上看，它没有真正执行“下一步”，而是退回成了“状态说明”。

#### 风险

这类目标如果不够硬，容易让 workflow 产生假阳性：

- 系统以为在执行
- 实际上在描述

#### 建议

对于 `/deepwork` 自动拆分出来的第二步，不应只生成自然语言 goal。

至少应该在 prompt 或任务 contract 里显式要求：

- 必须执行一个可观察动作
- 不能只做状态总结
- 如果无法执行，必须返回 `blocked`

这也说明：

- 当前 proactive decomposition 虽然能拆任务
- 但拆出来的子任务契约还不够硬

---

### 问题 4：summary 层对风险有保留，但 `nextSteps` 仍过度乐观

当前 batch summary 里的：

- `consensus = partial`
- `risks` 列表里明确写了 MCP 池阻塞与缺少真实验证

这些其实都说明系统知道这次执行并不完美。

但最终 `nextSteps` 却仍然写成：

- `All tasks completed - proceed to integration or deployment`

这和 `consensus = partial`、`parsed.status = blocked` 本身是冲突的。

#### 风险

下游如果只看 `nextSteps`，会被错误地引导到：

- 继续集成
- 甚至部署

而不是先修正阻塞项。

#### 建议

`nextSteps` 的生成规则要绑定更严格的状态条件。

例如：

- 只要任何 task 为 `blocked`
  - `nextSteps` 必须优先提示“review and unblock”
- 只要 `consensus != success`
  - 不能出现“proceed to integration or deployment”这类完成态语句

---

### 问题 5：真实 smoke 仍然不够产品化

当前系统已经有：

- `.workflow-state/*.json`
- `.workflow-state/logs/*.log`
- `probe`
- `review`

但本次问题仍然需要人工读：

- task 文件
- batch 文件
- review 输出

才能发现“表面 completed，实际 blocked”的不一致。

#### 风险

这说明：

- 系统能记录问题
- 但还不能自动把这些问题收敛成明确失败

#### 建议

补一个“结果一致性 smoke”或 verifier：

最小规则：

- 如果任一 task 的 `workerResult.parsed.status == blocked`
- 但 batch summary 里 `blocked == 0`
- 则整个 batch 状态应视为失败

这类检查可以直接做成自动化回归用例。

## 5. 本次问题的本质归纳

这次暴露的问题不是 executor 单纯输出差，而是：

- executor 输出的语义
- review 的接收逻辑
- 最终 task / batch 状态

三者之间还没有被硬性约束住。

也就是：

- 系统已经有状态
- 但这些状态之间的约束还不够硬

换句话说：

当前 `codex-workflow` 已经有 workflow，但还没有完全形成“可信完成判定”。

## 6. 建议的修复优先级

### 优先级 1：修最终状态收口

直接修：

- task 最终 phase 的决定逻辑
- batch summary 的 completed / blocked 统计逻辑
- `nextSteps` 的生成条件

这是当前最需要修的。

### 优先级 2：把 review 和 verify 分层

当前 review 不能再兼任完成判定器。

建议增加：

- `review`：评审输出质量
- `verify`：评审任务完成性

### 优先级 3：硬化 `/deepwork` 自动拆分的子任务契约

当前 `execute the highest-value next step` 太容易退化成分析文本。

建议对子任务增加：

- 必须执行
- 必须给出可观察副作用
- 无法执行必须显式 `blocked`

### 优先级 4：增加一致性回归测试

把这次暴露的问题固化为测试：

- worker 返回 `parsed.status=blocked`
- review 返回 `accept`
- 断言 task 不能被标记成 `completed`
- 断言 batch summary 的 `blocked` 数和 `nextSteps` 正确

## 7. 给后续修复者的简要说明

如果后续继续修这个问题，重点不要先去改：

- UI
- 日志展示
- 文案
- executor prompt 风格

应该优先改：

- `src/workflow.ts` 中 task / batch 最终状态收口逻辑
- `src/summarize.ts` 中 summary / nextSteps 生成逻辑
- 必要时增加 verifier 层

## 8. 结论

`codex-workflow` 当前已经可用，但这次 `/deepwork` 真实演练说明：

- 它仍会把部分“未真正完成但解释得很清楚”的任务错误收口成 `completed`
- 这个问题在 `Codex` 上都会发生
- 那么放到更弱的宿主或更不稳定的 executor 上，只会更严重

因此，这不是一个“边缘小 bug”，而是当前 workflow 可信度层面的核心风险，应优先修复。