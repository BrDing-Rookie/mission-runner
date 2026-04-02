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

- [ ] **F2: dispatch queue 目录基于 missionsDir**
  - 当前 `DISPATCH_QUEUE_DIR` 硬编码为 `extensions/mission-runner/dispatch-queue/`
  - 应基于 `missionsDir` 或统一配置路径 (`scripts/lib/mission-dispatch-agent.ts:35`)

- [ ] **F3: 双模式派发逻辑明确优先级**
  - dispatch-agent 路径和 autoSpawn 路径可能同时执行
  - 有 agent 的任务走 dispatch-agent，无 agent 的走 autoSpawn 建议 (`scripts/mission-dispatch.ts`)

- [ ] **F4: mentionInDiscord 确保 channel ID**
  - `chatId` 可能是 channel 名称而非 ID，导致 `openclaw message send` 报错
  - 确保 `chatId` 始终为 channel ID，或在 dispatch 前做 ID 解析 (`scripts/lib/mission-dispatch-agent.ts:77-80`)

## P2 — 建议优化

- [ ] **F5: DispatchSummary 类型去重**
  - `mission-dispatch.ts` 的 `buildDispatchSummary()` 与 `mission-dispatch-agent.ts` 的 `DispatchSummary` 定义重复
  - 确认两边接口一致或合并 (`scripts/mission-dispatch.ts:108-127`)

- [x] **F6: 状态机补充 PLANNED→WAITING_BACKGROUND** ✅ (commit `de2f4e3`, 2026-04-02)
  - `types.ts` 中 `PLANNED` 的合法转换已包含 `WAITING_BACKGROUND`

- [ ] **F7: dispatch 失败添加重试冷却**
  - dispatch-agent 全级别失败时 task 保留 READY 状态，无重试计数/冷却
  - 添加 `retryCount++` 和 `nextRetryAt` 时间戳防止无限重试

---

## 架构评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 功能完整性 | ⭐⭐⭐⭐ | create → plan → dispatch → watchdog → verify 全链路覆盖 |
| 合并质量 | ⭐⭐⭐ | 核心功能正确合入，安全策略不一致（execSync） |
| 类型安全 | ⭐⭐⭐⭐ | types.ts 定义清晰 |
| 错误处理 | ⭐⭐⭐ | 有基础处理，缺重试冷却 |
| 测试覆盖 | ⭐⭐⭐⭐ | 79 个测试覆盖核心路径 |
| 安全性 | ⭐⭐⭐ | P0 execSync 问题需修复 |

---

*Review 时间: 2026-04-01 18:00 GMT+8*
