# Agent 回收增强

> 模块: reconciler
> 创建日期: 2026-04-06
> 状态: 进行中
> 关联 Phase: P2 批次 C

## 目标
增强 mission-reconcile-background.ts 的后台进程回收能力：自动检测超时/失联进程，标记为 TIMEOUT，兜底回收。

## 涉及文件
- `scripts/mission-reconcile-background.ts` — 增强回收逻辑
- `scripts/lib/types.ts` — 可能调整 BackgroundProcess 类型

## 方案

### 1. 超时自动检测
- 新增 `--process-timeout-ms <ms>` CLI 参数（默认 3600000 = 1 小时）
- 对 RUNNING 状态的 backgroundProcess，检查 startedAt 是否超过阈值
- 超过阈值的进程自动标记为 TIMEOUT

### 2. 失联检测
- RUNNING 但无对应 task（taskId 不匹配）的进程，标记为 orphan
- 输出 warning 日志，可选自动清理

### 3. 增强回收摘要
- 输出中新增 `timedOutProcessIds` 和 `orphanProcessIds` 字段
- 事件日志中记录超时和失联的详细信息

### 4. Force 模式
- 新增 `--force` 参数：强制回收所有非 RUNNING 状态的进程结果
- 跳过正常的状态检查，直接标记为 TIMEOUT 并回收

## 验收标准
- [ ] 超时进程自动标记为 TIMEOUT
- [ ] 失联进程检测并输出 warning
- [ ] 回收结果包含新增字段
- [ ] --force 模式可用
- [ ] 原有回收逻辑行为不变
- [ ] npm run typecheck 通过
- [ ] 新增测试

## 开发记录
### 2026-04-06
- 开发启动
