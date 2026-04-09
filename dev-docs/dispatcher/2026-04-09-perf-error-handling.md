# 性能修复 + Silent Error 处理改进

> 模块: dispatcher / file-system / config
> 创建日期: 2026-04-09
> 状态: 已完成
> 关联 Phase: P3

## 目标

1. 修复 `dispatch-messenger.ts` 中 `Atomics.wait` 同步阻塞事件循环的问题（#8 Medium）
2. 评估 `fs-utils.ts` 中 `Atomics.wait` 的改造可行性，视情况替换或保留并加注释
3. 修复 3 处 `silent catch {}` 吞错误问题（#9 Low），改为 `console.warn` 输出

## 涉及文件

- `scripts/lib/dispatch-messenger.ts` — Atomics.wait → await setTimeout
- `scripts/lib/fs-utils.ts` — acquireMissionLock 中的 Atomics.wait：评估后保留并加注释
- `scripts/lib/config.ts` — L65/L77 silent catch → console.warn
- `scripts/lib/discord-id-resolver.ts` — L75 silent catch → console.warn
- `scripts/mission-dispatch.ts` — L39 silent catch → console.warn

## 方案

### 问题 1: dispatch-messenger.ts Atomics.wait
`mentionInDiscord` 是 async 函数，可直接将重试等待改为：
```typescript
await new Promise<void>(resolve => setTimeout(resolve, delay));
```
不影响任何调用方，风险极低。

### 问题 2: fs-utils.ts Atomics.wait
`acquireMissionLock` 是同步函数，被 `withMissionLock` 同步调用，`withMissionLock` 又被 `mission-commit.ts` 的同步上下文调用。将其改为 async 会产生链式改动，影响面过大（涉及禁止修改的文件）。
决策：**保留 Atomics.wait**，添加注释说明为何需要同步阻塞。

### 问题 3: silent catch 改为 console.warn
只增加日志输出，不改变控制流（fallback 行为不变）。

## 验收标准

- [ ] dispatch-messenger.ts 中 Atomics.wait 替换为 await setTimeout
- [ ] fs-utils.ts 中 Atomics.wait 保留，添加解释注释
- [ ] mission-dispatch.ts catch 改为 console.warn（保留 ignore 语义）
- [ ] config.ts 两处 silent catch 改为 console.warn
- [ ] discord-id-resolver.ts skip account 失败时输出 console.warn
- [ ] npm test 所有测试通过

## 开发记录
### 2026-04-09
- 阅读所有涉及文件，评估影响范围
- 确认 fs-utils.ts 中 Atomics.wait 无法无代价改为 async（调用链全为同步）
- 执行所有修复
