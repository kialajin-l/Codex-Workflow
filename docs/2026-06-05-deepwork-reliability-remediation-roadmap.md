# Deepwork 可信度修复路线图

> 交接用途：本文件用于把 `codex-workflow` 当前 `/deepwork` 真实使用中暴露出的可信度问题，拆分为可并行分派、可边界控制、可验收的下阶段修改任务。

## 1. 目标

本轮修改不做新功能扩张，不重做产品交互，不调整插件入口形态。

只聚焦以下目标：

1. 修正 task / batch 的最终状态收口逻辑，避免“实际 blocked，表面 completed”。
2. 将 review 与 completion verification 从职责上拆开，避免把“格式合格”误判为“任务完成”。
3. 硬化 `/deepwork` 的 proactive decomposition 契约，减少“执行型任务退化成描述型回答”。
4. 增加一致性回归测试与 smoke 验证，确保后续修改不会回退。

非目标：

1. 不改 UI 展示层。
2. 不重写 executor 架构。
3. 不新增复杂调度系统。
4. 不处理与本轮可信度问题无关的 README、营销文案、安装文档。

## 2. 当前问题归纳

本轮已经确认成立的问题如下：

1. `workerResult.parsed.status = blocked` 时，task 仍可能因为 `review.decision = accept` 被标记为 `completed`。
2. `review` 当前主要在做输出质量审查，不承担“是否真的完成”的验证责任。
3. `/deepwork` 自动拆出的 `execute the highest-value next step` 语义过软，容易退化成分析报告。
4. `summary.nextSteps` 依赖被污染的 task 状态，可能错误提示“可继续集成或部署”。
5. 缺少结果一致性 smoke，导致这类问题需要人工翻状态文件才能发现。

## 3. 修改总原则

1. 先修状态机，再修提示词，再补测试。
2. 先保证“不会误报完成”，再追求“更聪明地完成”。
3. 尽量做小而硬的规则，不引入新的大抽象。
4. 所有汇总结果必须从可信 task 状态推导，不能绕过状态机直接拼文案。

## 4. 阶段划分

### Phase A：状态收口修复

这是最高优先级，也是后续所有工作的前置。

目标：

1. 建立 task 最终 phase 的统一决策规则。
2. 让 `review.accept` 不再直接等于 `task.completed`。
3. 让 `parsed.status` 成为状态收口硬约束。

主要文件：

1. `E:\code\codex-workflow\src\workflow.ts`
2. `E:\code\codex-workflow\src\types.ts`
3. 如有必要：`E:\code\codex-workflow\src\review.ts`

建议修改点：

1. 在 `workflow.ts` 中抽出统一的 task completion resolver。
2. resolver 至少同时读取：
   - executor 结果是否成功
   - review 是否 accept
   - `workerResult.parsed.status` 是否为 `ok`
   - 是否存在 delegated / fallback-synthesized 等特殊来源
3. 对 structured payload 中的 `blocked` 明确落到：
   - `blocked`
   - 或未来可扩展的 `waiting_verify`

边界：

1. 本阶段不改 deepwork 目标文案。
2. 本阶段不新增复杂 verifier 子系统。
3. 本阶段只修“最终状态如何落地”。

验收标准：

1. 任一 task 若 `parsed.status = blocked`，最终 phase 不能是 `completed`。
2. fallback 路径与正常路径必须共享同一套状态收口规则。
3. 现有通过测试不应因本阶段出现无关行为回退。

---

### Phase B：batch summary 与 nextSteps 修复

目标：

1. 让 batch 汇总只依赖可信 task 状态。
2. 避免 `nextSteps` 在存在 blocked 风险时仍给出完成态建议。

主要文件：

1. `E:\code\codex-workflow\src\summarize.ts`
2. 如有需要：`E:\code\codex-workflow\src\workflow.ts`
3. 对应测试文件

建议修改点：

1. 重新定义 `completed / blocked / delegated / consensus` 的推导顺序。
2. `nextSteps` 生成规则至少满足：
   - 有 blocked 时，优先提示 review / unblock
   - 有 delegated 时，优先提示 complete delegated tasks
   - 只有全部任务真实完成且无 blocked / delegated / partial 风险时，才能出现“proceed to integration or deployment”
3. 若存在 `parsed.status != ok` 的完成态 task，应使 summary 至少进入 `partial`，不能给出纯完成态文案。

边界：

1. 本阶段不重做日志体系。
2. 本阶段不做 dashboard 或可视化。
3. 只修汇总规则与输出文案收口条件。

验收标准：

1. 存在 blocked task 时，summary.blocked 必须正确计数。
2. 存在 blocked 或 partial 风险时，`nextSteps` 不能出现部署导向语句。
3. batch.phase、summary.consensus、summary.nextSteps 三者不能互相冲突。

---

### Phase C：review / verify 职责拆分

目标：

1. 明确 review 只负责输出质量，verify 负责完成性判断。
2. 即使短期不引入独立模块，也要在职责上分层。

主要文件：

1. `E:\code\codex-workflow\src\review.ts`
2. `E:\code\codex-workflow\src\workflow.ts`
3. 如有必要新增轻量文件：
   - `E:\code\codex-workflow\src\verify.ts`

建议修改点：

1. 保留当前 review 对垃圾输出、trace、伪成功文本的过滤。
2. 增加 verify 判定层，最小可以是一个函数，不要求一开始就做成复杂子系统。
3. verify 至少要检查：
   - structured payload status
   - 是否属于“明确承认未执行”的结果
   - deepwork implementer 输出是否包含可观察 deliverable / next step

边界：

1. 本阶段不需要引入外部测试框架或全新 pipeline。
2. 只做职责拆分，不做产品层新入口。

验收标准：

1. review.accept 不再单独决定 task.completed。
2. verify 结果必须进入最终状态收口链路。
3. 对“格式合格但自报 blocked”的输出必须稳定落到 blocked。

---

### Phase D：`/deepwork` 子任务契约硬化

目标：

1. 降低“执行下一步”退化成“解释下一步”的概率。
2. 让 proactive decomposition 生成的 implementer 子任务更可验证。

主要文件：

1. `E:\code\codex-workflow\src\deepwork.ts`
2. `E:\code\codex-workflow\src\workflow.ts`
3. `E:\code\codex-workflow\src\review.ts`
4. `E:\code\codex-workflow\src\deepwork.test.ts`
5. 如相关：`E:\code\codex-workflow\src\workflow.test.ts`

建议修改点：

1. 替换或强化第二个子目标文案，不再只写自然语言的 `execute the highest-value next step`。
2. 在 implementer 任务 contract 或 prompt 中加入硬要求：
   - 必须执行一个可观察动作
   - 不能只输出状态总结
   - 无法执行必须显式返回 `blocked`
3. 必要时为 deepwork implementer 单独增加更严格的校验规则。

边界：

1. 不在本阶段扩展多种 deepwork 模式。
2. 不做新的对话式 onboarding。
3. 只修当前 proactive decomposition 的任务契约强度。

验收标准：

1. 新生成的第二子任务具备清晰执行义务。
2. 单纯“分析现状”的结果不能再轻易通过 implementer 完成链路。
3. deepwork 相关测试覆盖 planner / implementer 两条路径。

---

### Phase E：一致性回归测试与真实 smoke

目标：

1. 将这次暴露的问题固化为自动测试。
2. 用最小真实 smoke 覆盖安装后常见执行路径。

主要文件：

1. `E:\code\codex-workflow\src\workflow.test.ts`
2. `E:\code\codex-workflow\src\deepwork.test.ts`
3. `E:\code\codex-workflow\src\router.test.ts`
4. 如需要新增：
   - `E:\code\codex-workflow\docs\smoke\...`
   - 或一个轻量 smoke script

必须新增的测试场景：

1. `parsed.status = blocked` 且 `review.accept` 时，task 不得 `completed`。
2. batch 中存在 blocked task 时，summary.blocked 与 nextSteps 必须正确。
3. proactive decomposition 的 implementer 子任务如果只产出分析文本，应被拒绝或落为 blocked。
4. fallback executor 成功但 payload 为 blocked 时，仍不得标记 completed。

建议补充的真实 smoke：

1. 安装态 `/deepwork --goal ... --temporary`
2. 单一 goal 自动拆分为 planner + implementer
3. 至少一次真实 executor fallback
4. 最终检查 `.workflow-state` 中 task / batch / summary 是否一致

边界：

1. 本阶段不追求完整 e2e 测试平台。
2. 只覆盖当前高风险路径。

验收标准：

1. 上述四类回归测试全部存在并通过。
2. 至少一条真实 smoke 能稳定复现并验证修复后的状态收口。

## 5. 推荐执行顺序

推荐按以下顺序分派，不建议并行乱拆：

1. Phase A
2. Phase B
3. Phase C
4. Phase D
5. Phase E

说明：

1. Phase B 依赖 Phase A 的可信 task 状态。
2. Phase C 可以与 Phase B 有少量交叠，但最好在 A 完成后推进。
3. Phase D 不应先做，否则只是改善 prompt，不能解决状态机误判。
4. Phase E 应贯穿补充，但最终完成要在 A-D 稳定后统一跑。

## 6. 可并行拆分建议

如果要交给多人做，建议按以下方式拆：

1. 工作者 1：状态机线
   - 负责 Phase A + Phase B
   - 产出可信 task / batch 状态收口

2. 工作者 2：验证线
   - 负责 Phase C
   - 产出 review / verify 分层实现

3. 工作者 3：deepwork 契约线
   - 负责 Phase D
   - 产出更硬的 proactive decomposition 契约

4. 工作者 4：测试线
   - 跟随 A-D 同步补 Phase E
   - 负责回归测试和 smoke 记录

并行边界要求：

1. `workflow.ts` 是冲突高发区，必须指定一人做主整合。
2. `review.ts` 与 `verify.ts` 的职责边界要先约定清楚，再并行改。
3. `deepwork.ts` 的目标文案调整不能绕过 A/C 的状态收口逻辑。

## 7. 审核重点

后续你审核时，建议重点看这几件事：

1. 有没有任何路径仍然以 `review.accept` 直接等于 `completed`。
2. fallback、recovery、delegated completion 三条支线是否全部走统一状态收口。
3. summary 是否仍然可能在 partial / blocked 情况下给出完成态 nextSteps。
4. deepwork implementer 任务是否仍可只输出“分析报告”而过关。
5. 测试是否只测 happy path，没有覆盖“格式正确但实际 blocked”的反例。

## 8. 测试交付要求

要求执行者在交付时同时提交：

1. 修改说明
2. 影响文件清单
3. 新增测试清单
4. 测试命令与结果
5. 一次真实 smoke 的状态文件样本或摘要

建议最少验证命令：

```powershell
npm run build
node --test dist/executor.test.js dist/workflow.test.js dist/summarize.test.js dist/deepwork.test.js dist/router.test.js dist/routes/hello.test.js
```

如有安装态 smoke，再补：

```powershell
& $HOME\.codex\codex-workflow\bin\cwf.ps1 deepwork --goal "smoke deepwork flow" --executor opencode-serve --temporary
```

## 9. 完成定义

只有同时满足以下条件，才算这轮可信度修复完成：

1. task 最终状态不再误报 completed。
2. batch 汇总与 task 状态完全一致。
3. `nextSteps` 不再在 blocked / partial 情况下给出完成态建议。
4. deepwork 的 implementer 子任务具备明确执行义务。
5. 自动回归测试与至少一条真实 smoke 通过。

如果只修了提示词、只加强了 review 文案、或只补了日志展示，都不能算完成本轮目标。
