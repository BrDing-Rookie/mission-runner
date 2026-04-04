# 状态机

## 功能概述
定义 Mission 和 Task 的全部状态枚举、状态迁移规则，以及状态操作辅助函数。是整个系统状态语义的单一事实源。

## 核心能力
- **Mission 状态管理**: 11 个状态（CREATED → COMPLETED/FAILED/ESCALATED），含活跃态和终态分类
- **Task 状态管理**: 8 个状态（PENDING → COMPLETED/FAILED/SKIPPED）
- **状态迁移规则**: `ALLOWED_TRANSITIONS` 迁移表，`isTransitionAllowed()` 校验函数
- **辅助函数**: `setMissionStatus()`、`deriveMissionStatus()`、`buildDefaultPlan()` 等

## 使用方式
状态机不直接调用，而是被其他模块引用：
- `import { MissionStatus, ALLOWED_TRANSITIONS, isTransitionAllowed } from './types.ts'`
- `import { setMissionStatus, deriveMissionStatus } from './mission-helpers.ts'`

## 当前限制
- `isTransitionAllowed()` 仅在 `task-add.ts` 中有 1 处显式调用，其他状态变更路径未强制校验
- `deriveMissionStatus()` 直接设置状态，不经过迁移校验

## 相关模块
- 所有模块都依赖状态机的类型定义
- watchdog、verifier、orchestrator 是主要的状态迁移触发方
