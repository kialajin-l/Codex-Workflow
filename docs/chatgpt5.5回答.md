我看完后，先给一个比较明确的判断：

**我认为你们现在遇到的问题，表面上是 Executor 不稳定，实际上是 Workflow Contract 定义错位。**

换句话说：

你们现在的架构默认假设：

```text
Host
  ↓
Worker(Claude/Opencode/Mimo/DS)
  ↓
严格Schema
  ↓
Review
```

但现实情况是：

```text
Host
  ↓
Worker(不同CLI)
  ↓
各种乱七八糟格式
  ↓
Review
```

而你们试图靠：

- Retry

- Probe

- Output Repair

去修复这个差距。

---

# 我觉得最值得重新思考的一点

其实是：

## Claude Code 的 Dynamic Workflow 为什么能成立？

很多人以为：

```text
Claude Code
    =
多Agent
```

实际上不是。

Claude Code 最新版真正厉害的地方是：

```text
Workflow Runtime
```

而不是：

```text
SubAgent Count
```

---

它的核心特点是：

### Agent之间不交换最终结果

而是交换：

```text
Work Item
```

例如：

```text
Task
Observation
Diff
Issue
Patch
Verification
```

---

也就是说：

Claude Code内部实际上不是：

```json
{
  "summary":"",
  "status":"",
  "risk":""
}
```

这种最终Schema。

而更像：

```json
{
  "type":"patch"
}
```

或者：

```json
{
  "type":"finding"
}
```

---

# 这会导致一个巨大差异

你们现在的设计：

实际上是：

## 强结构化Worker

```text
Host
 ↓
Worker
 ↓
必须输出Workflow Schema
```

---

Claude Code路线：

## 弱结构化Worker

```text
Host
 ↓
Worker
 ↓
产生Artifact
 ↓
Host解释Artifact
```

---

这两个系统复杂度完全不同。

---

# 所以我最怀疑的地方

不是 opencode。

不是 mimo。

甚至不是 deepseek。

而是：

## Worker Contract太重。

---

从文档看：

你们已经观察到：

- Mimo输出内容是有价值的

- 但不遵守Schema

- 经常格式漂移

---

这里其实暴露出一个信号：

```text
推理成功
≠
协议成功
```

---

很多模型：

任务完成了。

但：

```json
{
 "summary":"",
 "changes":""
}
```

没按要求写。

于是：

Review Fail。

---

实际上：

任务可能已经完成了。

---

# 如果是我

我会把 Contract 降一级。

---

不要：

```json
{
 "summary":"",
 "changes":"",
 "risks":"",
 "status":""
}
```

---

改成：

```json
{
 "artifact_type":"text"
}
```

---

甚至：

```json
{
 "artifact_type":"patch"
}
```

---

Host自己做：

```text
Summarize
Risk
Review
State Update
```

---

# 为什么这特别重要

因为你后面想做：

```text
SubAgent
```

---

如果SubAgent是：

```json
{
 "summary":"",
 "risk":"",
 "status":""
}
```

交换数据。

系统会非常脆。

---

如果SubAgent交换：

```text
Patch
Observation
Plan
Test Result
```

系统会稳定很多。

---

# 第二个我觉得存在的问题

文档里面有一句：

> first prove one stable worker path

这个在 MVP 阶段没问题。

但放到你未来目标：

```text
Codex Workflow Plugin
```

上。

我觉得可能方向错了。

---

因为：

## CLI天然不是稳定接口

例如：

Claude CLI

升级一次：

stdout变了。

---

OpenCode

升级一次：

event变了。

---

Gemini CLI

升级一次：

json变了。

---

你会永远在追：

```text
适配器地狱
```

---

# 我更推荐

增加一层：

```text
Worker Runtime Adapter
```

不是简单Wrapper。

而是：

```text
Claude CLI
OpenCode
Gemini
Aider
Codex
     ↓
Adapter Runtime
     ↓
Canonical Event
```

---

例如统一：

```typescript
TaskStarted
TaskFinished
ArtifactCreated
ErrorRaised
PatchProduced
```

---

Host永远只认识这些。

---

这样未来：

```text
SubAgent
```

其实只是：

```text
另一个Adapter实例
```

---

# 第三个问题

我觉得你们现在还缺一个东西。

---

文档里：

```text
Probe
→ Run
→ Review
```

---

但 Claude Code 里面其实还有：

```text
Capability Discovery
```

---

即：

```text
这个Worker擅长什么
```

---

不是：

```text
能不能执行
```

---

而是：

```text
Code Review
Code Writing
Refactor
Search
Planning
```

---

你未来如果想：

```text
SubAgent = 不同CLI
```

那么：

### Routing不应该基于模型名

错误：

```text
Mimo Agent
DS Agent
Claude Agent
```

---

正确：

```text
Planner
Reviewer
Implementer
Researcher
```

---

然后：

```text
Planner
 ↓
Mimo today

Planner
 ↓
Claude tomorrow
```

---

角色与模型解耦。

---

# 最后给一个我认为最值得验证的新方向

不是：

```text
多SubAgent
```

---

也不是：

```text
更复杂Workflow
```

---

而是：

## Artifact-Centric Workflow

即：

系统里面流动的不是Agent回复。

而是：

```text
Plan
Patch
Finding
Issue
Verification
```

---

你会发现：

当 Workflow 以 Artifact 为中心时：

- 模型变得可替换

- CLI变得可替换

- SubAgent变得可替换

- Schema漂移影响大幅降低

而这其实比继续增强 Probe、Retry、Review 更接近 Claude Code Dynamic Workflow 的真实设计思想。

如果把你未来的 Synapse / Nexus 思路也考虑进去，我甚至会把这条路线总结成一句话：

```text
不要让 Agent 交换答案，
要让 Agent 交换认知产物（Artifact）。
```

我认为这可能是你们当前设计里最值得重新审视的基础假设。
