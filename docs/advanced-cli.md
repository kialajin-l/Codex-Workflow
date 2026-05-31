# Advanced CLI

## 适用对象

这份文档面向高级玩家、维护者和插件开发者。

如果你只是普通使用者，建议优先走对话入口：

- `/deepwork`

CLI 主要用于：

- 调试 runtime
- 手动验证 executor
- 保存或加载 preset
- 检查 batch / task 状态
- 开发和维护插件

---

## 两种运行方式

### 从源码仓库运行

```bash
node dist/index.js init
node dist/index.js probe
node dist/index.js run-batch --goals "task1,task2" --mode parallel --auto-route
```

### 从远程安装后的 wrapper 运行

```bash
cwf init
cwf probe
cwf run-batch --goals "task1,task2" --mode parallel --auto-route
```

如果是 Windows，也可以直接指定 wrapper：

```powershell
& $HOME\.codex\codex-workflow\bin\cwf.ps1 init
```

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `node dist/index.js init` | 创建 `.workflow-state` |
| `node dist/index.js run --goal "..."` | 执行单个任务 |
| `node dist/index.js run-batch --goals "a,b,c"` | 执行 batch |
| `node dist/index.js run-batch --goals "..." --auto-route` | 启用 profile 路由 |
| `node dist/index.js run-batch --resume <batch-id>` | 续跑未完成 batch |
| `node dist/index.js status --id <task-id>` | 查看 task 状态 |
| `node dist/index.js status --batch <batch-id>` | 查看 batch 状态 |
| `node dist/index.js probe --executor <name>` | 探测 executor |
| `node dist/index.js workflow-save --name <name>` | 保存当前 workflow preset |
| `node dist/index.js workflow-load --name <name>` | 加载 workflow preset |
| `node dist/index.js workflow-list` | 查看 preset 列表 |

安装了 wrapper 后，上面这些命令都可以把 `node dist/index.js` 替换成 `cwf`。

---

## 典型场景

### 初始化状态目录

```bash
node dist/index.js init
```

### 探测 executor

```bash
node dist/index.js probe
node dist/index.js probe --executor opencode-serve --auto
```

### 跑一个 batch

```bash
node dist/index.js run-batch --goals "Implement hello,Review login" --mode parallel --auto-route
```

### 续跑 batch

```bash
node dist/index.js run-batch --resume <batch-id>
```

### 保存或切换 preset

```bash
node dist/index.js workflow-save --name my-workflow
node dist/index.js workflow-load --name lint-gate
node dist/index.js workflow-list
```

---

## 相关文档

- [Getting Started](./getting-started.md)
- [Customizing Workflows](./customizing-workflows.md)
- [Plugin Structure](./plugin-structure.md)
