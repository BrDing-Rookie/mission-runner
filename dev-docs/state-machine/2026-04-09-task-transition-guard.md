# Task 级状态迁移守卫 + 跨模块函数去重

> 模块: state-machine
> 创建日期: 2026-04-09
> 状态: 已完成
> 关联 Phase: P3

## 目标

1. 为 TaskStatus 添加状态迁移守卫（类似 Mission 级的 `isTransitionAllowed`），在 mission-commit 层对非法 task 状态变更发出 warn。
2. 整合跨模块重复定义的工具函数：`slugify`、`nowIso`、`TERMINAL_TASK_STATUSES`，消除 4 处重复，确保单一事实源。

## 涉及文件

- `scripts/lib/types.ts` — 添加 `ALLOWED_TASK_TRANSITIONS`、`TERMINAL_TASK_STATUSES`、`isTaskTransitionAllowed`
- `scripts/lib/mission-commit.ts` — 在 task 状态变更时调用 `isTaskTransitionAllowed()` 并 warn 非法迁移
- `scripts/lib/mission-helpers.ts` — 将 `slugify` 改为 export
- `scripts/lib/mission-planner.ts` — 删除本地 `slugify`，改为 import from `mission-helpers.ts`
- `scripts/lib/mission-notification.ts` — 删除本地 `nowIso`，改为 import from `mission-helpers.ts`
- `scripts/lib/mission-watchdog-evaluator.ts` — import `TERMINAL_TASK_STATUSES` from types
- `scripts/lib/mission-actions.ts` — import `TERMINAL_TASK_STATUSES` from types
- `scripts/task-update.ts` — import `TERMINAL_TASK_STATUSES` from types
- `scripts/mission-reconcile-background.ts` — import `TERMINAL_TASK_STATUSES` from types

## 方案

### Task 1: Task 级状态迁移守卫
在 `types.ts` 中添加 `ALLOWED_TASK_TRANSITIONS`（Record<TaskStatus, TaskStatus[]>）、`TERMINAL_TASK_STATUSES`（TaskStatus[]）和 `isTaskTransitionAllowed(from, to)`。在 `mission-commit.ts` 的 `detectTransitions` 或 `commitMissionUpdate` 中，当检测到 task 状态变更时，调用 `isTaskTransitionAllowed`，若非法则 `console.warn`（不阻断写入）。

### Task 2: 跨模块函数去重
- `slugify`: `mission-helpers.ts` 改为 export，`mission-planner.ts` 改为 import。
- `nowIso`: `mission-notification.ts` 删除本地定义，改为 import from `mission-helpers.ts`。
- `TERMINAL_TASK_STATUSES`: 4 处内联 Set 改为从 `types.ts` import，需要 Set 时本地构造 `new Set(TERMINAL_TASK_STATUSES)`。

## 验收标准

- [ ] `types.ts` 有 `ALLOWED_TASK_TRANSITIONS`、`TERMINAL_TASK_STATUSES`、`isTaskTransitionAllowed`
- [ ] `mission-commit.ts` 在 task 非法状态迁移时 `console.warn`
- [ ] `slugify` 只有一处定义（mission-helpers.ts），其余 import
- [ ] `nowIso` 只有一处定义（mission-helpers.ts），其余 import
- [ ] `TERMINAL_TASK_STATUSES` 从 `types.ts` 集中导出，4 处消费方改为 import
- [ ] `npm test` 所有测试通过

## 开发记录

### 2026-04-09
- 创建开发文档
- 实施 Task 1 + Task 2 全部变更
