# Plugin Structure

## 概览

这个仓库现在同时包含两层东西：

1. **Codex plugin 壳**
2. **本地 workflow runner 实现**

它们是同一个项目，但职责不同。

---

## 目录说明

### Plugin 层

- [`.codex-plugin/plugin.json`](../.codex-plugin/plugin.json)
- [`.mcp.json`](../.mcp.json)
- [`SKILL.md`](../SKILL.md)
- [`assets/`](../assets/)

作用：

- 向 Codex 描述插件身份
- 描述插件入口与展示信息
- 描述阶段化 MCP 配置
- 提供图标、logo 和截图等展示资源

### 配置资产层

- [`hooks/`](../hooks/)
- [`skills/`](../skills/)
- [`workflows/`](../workflows/)
- [`agents/`](../agents/)

作用：

- 提供默认 hook 配置
- 提供默认 skill 片段
- 提供 workflow preset
- 提供配套 agent 资产

用户级偏好如果后续实现落盘，建议放在：

- `~/.codex/codex-workflow/preferences.json`

### Runtime 层

- [`src/`](../src/)
- [`workflow.config.json`](../workflow.config.json)
- [`model-profiles.json`](../model-profiles.json)

作用：

- 提供 CLI 和 runtime
- 定义 executor、profile、timeout、并发、resume、成本估算

---

## 安装关系

安装脚本：

- [`install.js`](../install.js)

执行：

```bash
npm run install-plugin
```

它会把仓库中的资源同步到用户目录：

- `~/.codex/skills/codex-workflow/`
- `~/.codex/codex-workflow/hooks/`
- `~/.codex/codex-workflow/skills/`
- `~/.codex/codex-workflow/workflows/`
- `~/.codex/codex-workflow/runtime/`
- `~/.codex/codex-workflow/bin/`

如果你希望第一次看到 GitHub 仓库的用户直接安装，可使用：

- [`install.ps1`](../install.ps1)
- [`install.sh`](../install.sh)

---

## 当前标准入口

这个仓库已经收敛到一套标准入口：

- `.codex-plugin/plugin.json`
- `.mcp.json`

如果后续继续扩展插件展示信息、截图、分类或默认 prompt，应优先修改 `plugin.json`。
如果后续继续扩展 MCP 能力，应优先修改 `.mcp.json`。

截图的设计源文件保留在：

- [`docs/assets/showcase-runtime.html`](./assets/showcase-runtime.html)
- [`docs/assets/showcase-customization.html`](./assets/showcase-customization.html)

生成后的公开展示图位于：

- [`assets/plugin-shot-01.png`](../assets/plugin-shot-01.png)
- [`assets/plugin-shot-02.png`](../assets/plugin-shot-02.png)

---

## 维护建议

如果你要继续维护这个项目，建议遵循下面的边界：

### 改展示和插件身份

改：

- `.codex-plugin/plugin.json`
- `docs/assets/`
- `README.md`

### 改用户可配流程

改：

- `hooks/`
- `skills/`
- `workflows/`
- `workflow.config.json`
- `model-profiles.json`

### 改运行时机制

改：

- `src/index.ts`
- `src/workflow.ts`
- `src/executor.ts`
- `src/cost.ts`
- `src/logger.ts`

---

## 当前建议的后续整理

这个仓库现在已经具备可上传的标准 plugin 壳。

后续更值得继续投入的方向是：

1. 补自动化测试，覆盖 `resume`、`hook pipeline`、`cost`、`logger`
2. 持续打磨截图与展示文案，提高插件页可理解性
