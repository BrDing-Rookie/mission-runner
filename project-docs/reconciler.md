# 回收器

## 功能概述
回收后台进程（backgroundProcesses）的执行结果，将已完成/失败/超时的进程结果回写到对应 task 的状态中。

## 核心能力
- **进程状态匹配**: 找到已到达终态（COMPLETED/FAILED/TIMEOUT）的 backgroundProcess
- **Task 状态回写**: 根据进程结果更新对应 task 的 status 和 resultSummary
- **Mission 状态推导**: 回收完成后重新计算 mission 整体状态

## 使用方式
```bash
npx tsx scripts/mission-reconcile-background.ts --missions-dir ./missions --mission-id <id>
```

## 当前限制
- `backgroundProcesses` 的 status 字段需要外部调用方更新，系统无法自动检测进程是否真正结束
- 只处理已标记为终态的进程，对仍在运行的进程不做处理

## 相关模块
- 依赖: state-machine, file-system
- 被依赖: orchestrator（CHECK_BACKGROUND 动作触发）
- 协作: dispatcher（派发时创建 backgroundProcesses 记录）
