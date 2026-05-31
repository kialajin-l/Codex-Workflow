# Chat-First Workflow

## 目标

`/deepwork` 是普通用户的主入口。

它的目标不是把用户带到一组终端命令里，而是让用户在 Codex 对话中完成：

- 进入 workflow
- 选择运行模式
- 提供目标
- 自动拆分任务
- 自动路由执行
- 审查结果并继续推进

---

## 首次激活

当用户输入：

- `/deepwork`

插件应优先进入简短引导，而不是先给命令。

建议询问的内容：

1. `Codex-first / CLI-first / Hybrid`
2. `显式 goal 驱动 / 更自主地自动拆分`
3. `普通 review / 严格 review`

---

## 推荐对话形态

示例：

1. 用户：`/deepwork`
2. 插件：说明当前将进入结构化 workflow
3. 插件：询问偏好模式
4. 用户：选择模式
5. 插件：复述模式和行为
6. 插件：请求第一个任务
7. 插件：开始自动推进

---

## 普通用户与高级用户边界

普通用户：

- 使用 `/deepwork`
- 在对话中完成偏好选择
- 只关心目标、进度和结果

高级用户：

- 使用 CLI 调试 runtime
- 修改 hook / preset / routing config
- 手动查看 batch / task 状态

CLI 相关内容见：

- [Advanced CLI](./advanced-cli.md)
