# Mission Runner MVP 首轮审查记录

## 审查范围
当前已落地文件：
- `skills/mission-controller/SKILL.md`
- `skills/mission-controller/templates/planner.md`

当前未见关键工件：
- `schemas/mission.schema.json`
- `schemas/task.schema.json`
- `schemas/verification.schema.json`
- `references/architecture.md`
- `scripts/mission-watchdog.ts`
- 其余模板与脚本占位

## 当前结论
**VERDICT: FAIL（首轮骨架包未达最小可审标准）**

原因不是已落地文件本身明显错误，而是**关键工件缺失过多**，导致无法验证：
- 状态机是否真正闭环
- schema / 文档 / 模板 / 脚本职责是否一致
- watchdog / verifier 是否具备最小可靠性

## 已落地文件观察
### `skills/mission-controller/SKILL.md`
- 方向上应服务于 Mission Runner 的显式创建、规划、派发、恢复、校验与通知主链路。
- 审查重点是：不能把 skill 写成“大而全自治代理”，必须持续收敛在插件级 MVP 范围内。

### `skills/mission-controller/templates/planner.md`
- 该模板应约束 planner 输出可验证、可落盘、可交接的任务计划。
- 审查重点是：完成标准不能泛化成模糊自然语言，必须为 verifier 留出可判定依据。

## 当前 blocker
1. **schema 缺失**
   - 影响：无法确认 mission / task / verification 三层状态与字段边界。
2. **architecture 缺失**
   - 影响：无法确认模块职责切分与状态流转是否自洽。
3. **watchdog 缺失**
   - 影响：无法确认恢复策略、节流、去重、重复通知防护是否存在。
4. **其余模板 / 脚本占位缺失**
   - 影响：无法验证 skill / template / script 之间的输入输出契约。

## 风险判断
如果当前阶段直接推进到“可开工”结论，存在高风险：
- 后续接 dispatch / verify / notify 时发生职责漂移
- 状态字段与迁移规则返工
- watchdog 写成高噪声扫描器
- verifier 无法拦住伪完成

## 审查建议
- 先补齐 `schemas/*.json`、`references/architecture.md`、`scripts/mission-watchdog.ts` 最小草案。
- 再补 `templates/verifier.md`、`templates/recovery.md` 及核心脚本占位，至少把输入/输出/职责边界写清。
- 工件补齐后，再进入正式收口审查并给出 `PASS / PASS_WITH_RISK / FAIL` 最终结论。
