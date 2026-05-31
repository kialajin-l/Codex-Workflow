# Preference Persistence

## 目标

这份文档定义 `/deepwork` 的用户偏好如何保存、读取、覆盖和回退。

它解决的问题是：

- 首次进入时问了什么
- 下次进入时如何复用
- 临时切换和长期默认如何区分
- 未来真正实现落盘时，应该把数据放在哪里

---

## 保存范围

偏好属于**用户级 workflow 配置**，而不是 task state 或 batch state。

建议保存目录：

- `~/.codex/codex-workflow/`

建议单独存放为用户偏好文件，不和下面这些混写：

- `hooks/`
- `skills/`
- `workflows/`
- `.workflow-state/`

建议文件名：

- `preferences.json`

完整建议路径：

- `~/.codex/codex-workflow/preferences.json`

---

## 数据模型

建议长期保存这 3 个字段：

```json
{
  "executionMode": "hybrid",
  "goalStyle": "proactive-decomposition",
  "reviewMode": "standard-review"
}
```

字段含义：

- `executionMode`
  - `codex-first`
  - `cli-first`
  - `hybrid`
- `goalStyle`
  - `explicit-goals`
  - `proactive-decomposition`
- `reviewMode`
  - `standard-review`
  - `strict-review`

可选元数据：

```json
{
  "executionMode": "hybrid",
  "goalStyle": "proactive-decomposition",
  "reviewMode": "standard-review",
  "updatedAt": "2026-06-01T12:34:56.000Z",
  "source": "chat-confirmed"
}
```

---

## 默认值

如果用户还没有任何保存的偏好，应使用：

```json
{
  "executionMode": "hybrid",
  "goalStyle": "explicit-goals",
  "reviewMode": "standard-review"
}
```

理由：

- `hybrid` 对大多数用户最稳
- `explicit-goals` 更安全，避免第一次进入就过度自主
- `standard-review` 保持推进速度

---

## 首次进入规则

当 `/deepwork` 第一次被使用，且偏好文件不存在时：

1. 用简短说明给出 3 组选项
2. 等用户确认
3. 将确认结果保存为默认偏好
4. 复述当前默认并开始请求真实任务

---

## 再次进入规则

当偏好文件已经存在时：

1. 先读取当前默认偏好
2. 在对话中复述
3. 询问“继续沿用还是切换”

推荐话术：

```text
当前默认是：Hybrid + 更自主地自动拆分 + 普通 review。
要继续沿用，还是这次切换？
```

如果用户选择继续：

- 直接进入任务输入阶段

如果用户选择切换：

- 重新展示 3 组选项
- 只更新用户明确修改的字段

---

## 局部更新规则

如果用户只改一个维度，只更新那个维度，不重置其他字段。

示例：

原默认：

```json
{
  "executionMode": "hybrid",
  "goalStyle": "proactive-decomposition",
  "reviewMode": "standard-review"
}
```

用户只说：

- “这次切到 CLI-first”

则更新后：

```json
{
  "executionMode": "cli-first",
  "goalStyle": "proactive-decomposition",
  "reviewMode": "standard-review"
}
```

---

## 会话级临时覆盖

以下表达应视为**只对当前会话生效**：

- “这次先用 CLI-first”
- “只在这个任务里严格一点”
- “临时改成显式 goal”
- “这次先别自动拆分”
- “就这一次”

处理规则：

1. 当前会话使用新的偏好
2. 不改写 `preferences.json`
3. 回应中明确说明这是临时覆盖

推荐话术：

```text
这次我会按 CLI-first + 严格 review 执行，但不会改写你的默认设置。
```

---

## 明确改写默认

只有当用户表达了“记住”或“设为默认”的意思时，才应改写长期默认。

应视为长期更新的表达：

- “以后都按这个来”
- “记住这个偏好”
- “把这个设成默认”
- “后面都用 CLI-first”

处理规则：

1. 更新内存中的默认偏好
2. 写回 `preferences.json`
3. 回应中明确说明默认已更新

推荐话术：

```text
已更新默认：CLI-first + 显式 goal 驱动 + 严格 review。
后续进入 /deepwork 时我会先按这套偏好来。
```

---

## 读取优先级

运行时建议按以下优先级决定当前会话偏好：

1. 当前会话的临时覆盖
2. 用户最近确认的长期默认
3. 系统默认值

也就是说：

- 有 session override 时，先用 override
- 没有 override 时，用 `preferences.json`
- 没有偏好文件时，用内建默认

---

## 错误与回退

如果偏好文件损坏、缺字段或无法读取：

1. 不阻塞 `/deepwork`
2. 回退到内建默认
3. 在对话里使用首次进入流程重新确认

必要时可以给出简短提示：

```text
我没有读到可用的 deepwork 默认偏好，这次先按默认设置重新开始。
```

---

## 与其他配置的边界

偏好文件只描述“用户如何想使用 workflow”，不应该直接承担这些职责：

- task routing 规则本体
- executor registry
- hook 详细逻辑
- workflow preset 内容

这些仍应保留在原来的配置里：

- `workflow.config.json`
- `hooks/*.json`
- `workflows/*.json`

如果未来要把用户偏好映射成 hook 或 preset，应通过转换逻辑完成，而不是把所有逻辑直接塞进偏好文件。

---

## 相关文档

- [Chat-First Workflow](./chat-first-workflow.md)
- [Advanced CLI](./advanced-cli.md)
- [Plugin Structure](./plugin-structure.md)
