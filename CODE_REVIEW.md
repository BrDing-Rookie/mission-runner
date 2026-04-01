# Mission Runner Code Review — 2026-04-01

**Reviewer**: 研发-总控（rd-coordinator）
**范围**: public-deliverables/mission-runner（合并 dispatch-agent 后）
**Commit**: `22ce186` feat: merge dispatch-agent module from extensions branch

---

## Executive Summary

合并后的 mission-runner 功能完整（79/79 测试通过），但存在 **1 个 P0 安全问题** 和若干 P1/P2 问题需要修复。

---

## Findings

### P0 — 必须修复

#### F1: dispatch-agent.ts 使用 execSync 存在 shell 注入风险

**文件**: `scripts/lib/mission-dispatch-agent.ts`

- Line 57: `execSync(\`sleep ${Math.max(0, Math.round(ms / 1000))}\`)` — sleep 参数为数字，风险低但不规范
- Line 65: `execSync(command, ...)` — command 是拼接的 shell 命令，如果 agentId/mentionTag 包含特殊字符可被注入
- Line 246: `execSync(\`mkdir -p '${queueDir}'\`)` — queueDir 来自常量，风险可控但违反 index.ts 已确立的 `execFileSync` 安全规范

**影响**: 与 index.ts 的安全策略不一致。index.ts 明确使用 `execFileSync` 避免 shell 注入，dispatch-agent 引入了绕行路径。

**修复建议**:
1. `sleep` 改用 `setTimeout` 或 `Atomics.wait`
2. `openclaw message send` 改用 `execFileSync('openclaw', [...args])` 
3. `mkdir -p` 改用 `mkdirSync(queueDir, { recursive: true })`

---

### P1 — 应该修复

#### F2: dispatch-agent 写文件到 extensions 目录而非 mission 目录

**文件**: `scripts/lib/mission-dispatch-agent.ts`, Line 35

```typescript
const DISPATCH_QUEUE_DIR = join(__dirname, '..', '..', 'dispatch-queue');
```

**问题**: L3 dispatch queue 文件写入到 `extensions/mission-runner/dispatch-queue/`，而非 mission 数据目录。如果 orchestrator 从不同路径运行，可能找不到这些文件。

**修复建议**: queue 目录应该基于 missionsDir 或统一配置路径。

#### F3: mission-dispatch.ts 中双模式可能产生重复派发

**文件**: `scripts/mission-dispatch.ts`

代码同时支持：
1. dispatch-agent 三级派发（`needsAgentDispatch(task)` 为 true 时）
2. autoSpawn 模式（`args.autoSpawn` 为 true 时生成 SpawnInstruction）

当任务同时有 agent 分配且启用了 autoSpawn，两个路径都会执行：
- dispatch-agent 路径：实际派发
- autoSpawn 路径：生成 SpawnInstruction（只是打印，不实际派发）

虽然不会导致重复派发（SpawnInstruction 只是打印），但逻辑冗余，增加维护负担。

**修复建议**: 明确优先级——有 agent 的任务走 dispatch-agent，无 agent 的走 autoSpawn 建议。

#### F4: dispatch-agent 的 mentionInDiscord 使用了 channel 名称而非 ID

**文件**: `scripts/lib/mission-dispatch-agent.ts`, Line 77-80

```typescript
const target = mission.owner?.chatId || mission.owner?.channel || 'general';
```

**问题**: 如果 `chatId` 是 Discord channel 名称而非 ID，`openclaw message send` 会报 "Unknown target" 错误（测试中已观察到此现象）。

**修复建议**: 确保 `chatId` 始终为 channel ID，或在 dispatch 前做 ID 解析。

---

### P2 — 建议优化

#### F5: buildDispatchSummary 与 dispatch-agent 模块的 DispatchSummary 类型重复定义

**文件**: `scripts/mission-dispatch.ts`, Line 108-127

`mission-dispatch.ts` 中的 `buildDispatchSummary()` 函数手动实现了与 `DispatchSummary` 接口相同的逻辑，而 `mission-dispatch-agent.ts` 已经定义了 `DispatchSummary` 类型。

**修复建议**: 可以保留当前实现（函数在 dispatch.ts 中更方便），但需要确认两边的接口定义一致。

#### F6: types.ts 中 PLANNED 状态机缺少 WAITING_BACKGROUND 转换

**文件**: `scripts/lib/types.ts`, Line 287

```typescript
PLANNED: ['RUNNING', 'FAILED'],  // 缺少 WAITING_BACKGROUND
```

dispatch 代码中，READY 任务可直接进入 WAITING_BACKGROUND（background task），但状态机定义中 PLANNED → WAITING_BACKGROUND 的转换路径不可用。

**影响**: 实际运行中 tasks 从 READY（非 PLANNED）出发，所以目前不影响。但如果某处将 task 状态从 PLANNED 直接 dispatch，可能触发状态机校验失败。

#### F7: 缺少 error 类型的 task 处理

dispatch-agent 在所有 L1/L2/L3 都失败时将 task 保留在 READY 状态，但没有设置重试计数或冷却时间。如果 watchog 频繁扫描，可能导致无限重试循环。

**修复建议**: 添加 `retryCount++` 和 `nextRetryAt` 时间戳。

---

## 架构总评

| 维度 | 评分 | 说明 |
|------|------|------|
| 功能完整性 | ⭐⭐⭐⭐ | create → plan → dispatch → watchdog → verify 全链路覆盖 |
| 合并质量 | ⭐⭐⭐ | 核心功能正确合入，但安全策略不一致（execSync vs execFileSync） |
| 类型安全 | ⭐⭐⭐⭐ | types.ts 定义清晰，dispatch-agent 接口明确 |
| 错误处理 | ⭐⭐⭐ | 有基础错误处理，但缺少重试冷却机制 |
| 测试覆盖 | ⭐⭐⭐⭐ | 79 个测试覆盖核心路径 |
| 安全性 | ⭐⭐⭐ | P0 execSync 问题需修复 |

---

## 建议后续行动

1. **立即修复 P0**: dispatch-agent.ts 的 execSync → execFileSync / fs API
2. **本轮修复 P1**: queue 目录路径、双模式清理、channel ID 解析
3. **下轮修复 P2**: 状态机完善、重试冷却机制

---

*Review 时间: 2026-04-01 18:00 GMT+8*
