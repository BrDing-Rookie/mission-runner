# Critical Bug Fix: ESCALATE_MAX_RETRY handler + COLLECT_RESULTS task-ids + orchestrate readMission

> 模块: orchestrator
> 创建日期: 2026-04-09
> 状态: 已完成
> 关联 Phase: P4

## 目标
修复 2 个导致 mission 卡死的关键 Bug 和 1 个性能问题：

1. **Bug 1**: `ESCALATE_MAX_RETRY` action 在 watchdog evaluator 中可以被推荐，但 `mission-run-action.ts` 的 `SUPPORTED_ACTIONS` 不包含它，导致抛异常、mission 永久卡死。
2. **Bug 2**: `orchestration-service.ts` 和 `mission-orchestrate.ts` 调用 `runActionMain` 执行 `COLLECT_RESULTS` 时，未传递 `--task-ids` 参数，导致 `collectResults` 变成空操作。
3. **性能**: `mission-orchestrate.ts` 的 `orchestrateSingleMission` 循环结束后多一次不必要的 `readMission` 调用。

## 涉及文件
- `scripts/mission-run-action.ts` — 添加 ESCALATE_MAX_RETRY 到 SUPPORTED_ACTIONS + handler
- `scripts/lib/orchestration-service.ts` — 传递 --task-ids 给 COLLECT_RESULTS action
- `scripts/mission-orchestrate.ts` — 传递 --task-ids + 减少 readMission 调用

## 方案

### Bug 1: ESCALATE_MAX_RETRY handler
- 在 `SUPPORTED_ACTIONS` 数组中加入 `'ESCALATE_MAX_RETRY'`
- 在 ESCALATE_STUCK handler 块后新增 ESCALATE_MAX_RETRY handler，复用 `setEscalationState()`，level 为 `'CRITICAL'`，reason 为 `'Mission has exhausted all retry attempts.'`

### Bug 2: COLLECT_RESULTS task-ids 传递
- `orchestration-service.ts`: 当 `decision.relatedTaskIds` 存在且非空时，追加 `'--task-ids', decision.relatedTaskIds.join(',')` 到 argv
- `mission-orchestrate.ts`: 同样追加 `--task-ids`

### 性能: 减少 readMission
- 引入 `lastMission` 变量在循环中持续更新
- 循环结束后复用 `lastMission` 而非再次调用 `readMission`

## 验收标准
- [x] `npm test` 所有现有测试通过
- [x] ESCALATE_MAX_RETRY 在 SUPPORTED_ACTIONS 中且有对应 handler
- [x] orchestration-service 和 mission-orchestrate 在 COLLECT_RESULTS 时传递 task-ids
- [x] orchestrate 循环中减少至少 1 次不必要的 readMission 调用

## 开发记录
### 2026-04-09
- 分析三个问题的根因
- 实施修复
