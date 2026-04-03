# Mission Runner Code Review — TODO Checklist

> 基于 2026-04-01 代码审查 | Commit: `22ce186`
> Reviewer: 研发-总控（rd-coordinator）

---

## P0 — 必须修复

- [x] **F1: dispatch-agent.ts execSync → 安全替换** ✅ (commit `de2f4e3`, 2026-04-02)
  - [x] `execSync(\`sleep ...\`)` → `setTimeout` 或 `Atomics.wait`
  - [x] `execSync(command)` → `execFileSync('openclaw', [...args])`
  - [x] `execSync(\`mkdir -p ...\`)` → `mkdirSync(dir, {recursive: true})`

## P1 — 应该修复

- [x] **F2: dispatch queue 目录基于 missionsDir** ✅ (commit `1f2da8e`, 2026-04-02)
  - `getDispatchQueueDir(missionsDir?)` 已支持基于 missionsDir 的路径解析

- [x] **F3: 双模式派发逻辑明确优先级** ✅ (commit `1f2da8e`, 2026-04-02)
  - agent dispatch 优先于 autoSpawn，双模式派发优先级已明确

- [x] **F4: mentionInDiscord 确保 channel ID** ✅ (commit `1f2da8e`, 2026-04-02)
  - channelId 已添加 snowflake 格式校验，确保为有效 Discord ID

## P2 — 建议优化

- [x] **F5: DispatchSummary 类型去重** ✅ (commit `1f2da8e`, 2026-04-02)
  - DispatchSummary 已合并为单一定义

- [x] **F6: 状态机补充 PLANNED→WAITING_BACKGROUND** ✅ (commit `de2f4e3`, 2026-04-02)
  - `types.ts` 中 `PLANNED` 的合法转换已包含 `WAITING_BACKGROUND`

- [x] **F7: dispatch 失败添加重试冷却** ✅ (commit `1f2da8e`, 2026-04-02)
  - 已添加 MAX_DISPATCH_RETRIES + 指数退避，防止无限重试

---

## 架构评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 功能完整性 | ⭐⭐⭐⭐ | create → plan → dispatch → watchdog → verify 全链路覆盖 |
| 合并质量 | ⭐⭐⭐⭐ | 核心功能正确合入，安全策略统一（safe-exec） |
| 类型安全 | ⭐⭐⭐⭐ | types.ts 定义清晰，DispatchSummary 单一定义 |
| 错误处理 | ⭐⭐⭐⭐ | 完善的重试冷却（指数退避）+ channelId 校验 |
| 测试覆盖 | ⭐⭐⭐⭐ | 123 个测试覆盖核心路径 |
| 安全性 | ⭐⭐⭐⭐ | P0 execSync 已修复，safe-exec 封装 + snowflake 校验 |

---

*Review 时间: 2026-04-01 18:00 GMT+8*
*Update 时间: 2026-04-02 — 所有 P0/P1/P2 项已修复*
