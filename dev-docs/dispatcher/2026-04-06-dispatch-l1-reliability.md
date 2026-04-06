# Dispatch L1 可靠性 — mentionInDiscord 重试机制

> 模块: dispatcher
> 创建日期: 2026-04-06
> 状态: 进行中
> 关联 Phase: P2

## 目标

L1 发送失败可能是临时网络抖动，不应立即回退到 L2。在 `mentionInDiscord` 内部添加最多 2 次重试（共 3 次执行），每次重试间隔递增（1s、2s），确认持续失败后再返回 false 触发 L2 回退。

## 涉及文件

- `scripts/lib/dispatch-messenger.ts` — 添加重试循环 + 结构化确认日志
- `scripts/lib/mission-dispatch-agent.ts` — L1 失败日志增强，明确说明 "after retries"
- `scripts/dispatch-l1-reliability.test.ts` — 新增参数校验及配置常量测试

## 方案

### dispatch-messenger.ts

新增两个导出常量：

```typescript
export const MENTION_MAX_RETRIES = 2;
export const MENTION_BASE_DELAY_MS = 1_000;
```

`mentionInDiscord` 内部用 `for` 循环执行最多 `MENTION_MAX_RETRIES + 1` 次，使用 `Atomics.wait` 实现同步等待（`delay = MENTION_BASE_DELAY_MS * attempt`）。成功时记录结构化日志 `sent | channel=... | agent=... | attempts=...`。

### mission-dispatch-agent.ts

L1 失败时日志文案改为 `L1 mention failed after retries`，明确区分是 mentionInDiscord 内部重试全部耗尽后才回退。

### 测试

由于 `safeExec` 调用外部命令无法在单测中 mock，测试覆盖：
1. 参数校验（空值、无效 channelId）
2. 导出常量合理性（MENTION_MAX_RETRIES >= 1，MENTION_BASE_DELAY_MS > 0，超时 > 基础延迟）

## 验收标准

- [ ] `mentionInDiscord` 内置最多 2 次重试，递增延迟（1s、2s）
- [ ] 成功发送有结构化日志：`sent | channel=... | agent=... | attempts=...`
- [ ] L1 失败日志包含 "after retries"
- [ ] 参数校验测试全部通过
- [ ] `npm test` 全量通过
- [ ] 不引入新的 npm 依赖

## 开发记录

### 2026-04-06

- 创建开发文档
- 修改 dispatch-messenger.ts：添加重试常量和重试循环
- 修改 mission-dispatch-agent.ts：L1 失败日志增强
- 新增 dispatch-l1-reliability.test.ts：参数校验 + 常量测试
