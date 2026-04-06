# 状态迁移强制校验

> 模块: state-machine
> 创建日期: 2026-04-06
> 状态: 进行中
> 关联 Phase: P2

## 目标

在 `commitMissionUpdate()` 集中写入入口处强制校验状态迁移合法性，非法迁移直接阻止写入并记录审计事件，防止因调用方错误导致状态机进入非法状态。

## 涉及文件

- `scripts/lib/mission-commit.ts` — 在写入前调用 `isTransitionAllowed()`，非法时 `return false` 并记录 `illegal_transition_blocked` 事件
- `scripts/enforce-transition.test.ts` — 新增测试覆盖合法/非法/同状态/终态场景

## 方案

在 `commitMissionUpdate()` 的 `writeMission()` 调用之前插入校验块：

- 仅当 `oldMission.status !== newMission.status` 时触发校验
- 调用 `isTransitionAllowed(from, to)`（来自 `types.ts`），若返回 false：
  - 打印 `console.error` 日志
  - 追加 `illegal_transition_blocked` 审计事件（含 from/to/source 字段）
  - 立即 `return false` 阻止写入
- dryRun 模式下同样执行校验（校验是逻辑检查，不是副作用）
- 同状态写入（status 未变）不受影响，直接通过

## 验收标准

- [x] `commitMissionUpdate` 在状态变更时强制调用 `isTransitionAllowed`
- [x] 非法迁移返回 `false` 且不写入 `mission.json`
- [x] 非法迁移记录 `illegal_transition_blocked` 事件到 `events.jsonl`
- [x] 同状态写入正常通过（不被拦截）
- [x] 合法迁移正常通过
- [x] 终态（COMPLETED/FAILED）不允许迁移到任何状态
- [x] `npm test` 全量通过

## 开发记录

### 2026-04-06
- 在 `commitMissionUpdate` 写入前插入状态迁移校验块
- 新增 `scripts/enforce-transition.test.ts`，覆盖 5 类场景
- 全量测试通过
