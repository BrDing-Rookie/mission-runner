# Mission Runner 架构文档

> 版本：2026-04-02 | 合并自 references/architecture.md + docs/mission-runner-architecture.md

## 1. 概述

Mission Runner 是基于 OpenClaw 的插件级自治任务编排层。将聊天式 Agent 提升为能持续推进长期任务的系统——mission 工件落盘、状态机驱动、watchdog 保守判断、verify 完成判定、群聊 @mention 协作。

### 核心流程

```
用户指令 → mission-create → mission-plan → mission-dispatch → Agent 执行 → task-update → mission-verify → COMPLETED
```

---

## 2. 模块概览

```
scripts/
├── lib/                        # 核心库
│   ├── types.ts               # 类型定义 — 状态枚举、状态迁移规则
│   ├── fs-utils.ts            # 文件系统工具 — mission.json 读写、events.jsonl
│   ├── mission-helpers.ts     # Mission 辅助函数
│   ├── mission-commit.ts      # 状态提交 + 通知触发
│   ├── mission-dispatch-agent.ts # Agent 派发 L1/L2/L3
│   ├── mission-notification.ts     # 通知系统核心
│   ├── mission-notification-templates.ts # 消息模板
│   ├── mission-notification-mentions.ts  # Mention 解析
│   ├── mission-agent-discovery.ts  # Agent 发现
│   └── shell-utils.ts         # Shell 安全工具
├── mission-*.ts               # CLI 入口脚本
├── task-*.ts                  # 任务操作脚本
```

### 模块职责

| 模块 | 职责 |
|------|------|
| `types.ts` | 全局类型定义：Mission、Task、状态枚举、迁移规则 |
| `fs-utils.ts` | mission 工件目录的文件 I/O（带文件锁、原子写入） |
| `mission-helpers.ts` | mission 加载/校验、CLI 参数解析、状态推导 |
| `mission-commit.ts` | 集中式状态提交 + 变更检测 + 通知触发 |
| `mission-dispatch-agent.ts` | 三级回退 Agent 派发（L1→L2→L3） |
| `mission-notification.ts` | 通知适配器（console/fake/discord/openclaw） |
| `mission-notification-templates.ts` | 各状态变更的消息模板 |
| `mission-notification-mentions.ts` | @mention 目标解析 |
| `mission-agent-discovery.ts` | 群聊内可用 Agent 发现与匹配 |
| `shell-utils.ts` | `escapeShellArg()` 防命令注入 |

---

## 3. 状态机

### 3.1 状态集合

**活跃态**：`CREATED`、`PLANNED`、`RUNNING`、`WAITING_BACKGROUND`、`WAITING_EXTERNAL`、`VERIFYING`、`ITERATING`、`BLOCKED_HIGH_RISK`

**终态**：`COMPLETED`、`FAILED`、`ESCALATED`

### 3.2 主链路

```
CREATED → PLANNED → RUNNING → VERIFYING → COMPLETED
                  → WAITING_BACKGROUND → RUNNING
```

### 3.3 补缺闭环

```
VERIFYING → ITERATING → RUNNING（resume/dispatch 下一轮）
```

### 3.4 升级/失败链路

```
RUNNING / WAITING_BACKGROUND / VERIFYING / ITERATING
  → BLOCKED_HIGH_RISK → ESCALATED → FAILED
```

### 3.5 状态迁移规则

状态迁移必须通过 `isTransitionAllowed()` 校验，合法迁移定义在 `ALLOWED_TRANSITIONS`（`scripts/lib/types.ts`）。

---

## 4. 派发模块

### 三级回退机制 (mission-dispatch-agent.ts)

| 级别 | 机制 | CLI 命令 |
|------|------|----------|
| L1 | 检查活跃 session + @mention | `openclaw sessions --agent <id>` |
| L2 | 创建新 session + @mention | `openclaw agent --agent <id> --message` |
| L3 | 写 dispatch queue 文件 | 文件 I/O 兜底 |

---

## 5. 通知系统

### 5.1 架构

所有 mission.json 写入经过集中提交层 `commitMissionUpdate()`，自动检测状态变更并触发通知：

```
各脚本 → commitMissionUpdate(oldMission, newMission)
              ├── writeMission()           // 落盘
              ├── detectTransitions()      // 变更检测
              ├── resolveMentions()        // @mention 目标
              └── emitNotifications()      // 发到群聊
```

### 5.2 通知适配器

| 适配器 | 行为 | 场景 |
|--------|------|------|
| `console`（默认） | 输出到 stderr | 本地开发/调试 |
| `fake` | 静默 | 测试 |
| `discord` | 记录 Discord 元数据 | 保留兼容 |
| `openclaw` | `openclaw message send` → 群聊 | **生产环境** |

通过环境变量 `MISSION_NOTIFICATION_ADAPTER` 选择。

### 5.3 通知消息类型

| 状态变更 | 消息 | @mention 目标 |
|---------|------|---------------|
| → PLANNED | 📝 计划已生成，共 N 个子任务 | — |
| → RUNNING | 🚀 任务开始执行 | — |
| task 分发 | 📤 子任务已分配 | @被分配的 Agent |
| task 完成 | ✅ 子任务已完成 | @Orchestrator |
| task 失败 | ❌ 子任务失败 | @Orchestrator |
| → VERIFYING | 🔍 进入验证阶段 | — |
| → COMPLETED | ✅ 任务已完成 | @用户 |
| → FAILED | ❌ 任务已失败 | @用户 |
| → ESCALATED | ⚠️ 需要人工介入 | @用户 |

### 5.4 幂等性

同一状态转换只通知一次，通过 `mission.flags.notifiedTransitions` 去重。

---

## 6. Watchdog

### 6.1 职责

周期扫描 missions 目录，基于状态产出下一步建议（不直接执行复杂副作用）。

### 6.2 动作类型

`NONE` | `CHECK_BACKGROUND` | `RESUME_TASK` | `TRIGGER_VERIFY` | `RETRY_TASK` | `ITERATE` | `ESCALATE_STUCK` | `ESCALATE_MAX_RETRY` | `NOTIFY_COMPLETE` | `NOTIFY_ESCALATION`

### 6.3 决策边界

**可自动决策**：到达 `nextWakeAt`、mission 处于 `VERIFYING`、所有 task 终态、background process 已结束、idle 超时

**不应自动决策**：需要外部 session 状态但本地工件不足、涉及高风险动作、completion criteria 不明确、状态不一致

---

## 7. 依赖自动解锁

当 task 完成（COMPLETED/SKIPPED）时，自动扫描下游 PENDING tasks，依赖全部满足则提升为 READY。

---

## 8. Mission 工件目录

```
missions/<mission-id>/
├── mission.json      # 核心状态（必须存在）
├── plan.md           # 任务计划
├── verification.md   # 验证结果
├── events.jsonl      # 审计事件流
└── artifacts/        # 产物目录
```

---

## 9. 关键字段语义

### mission 级

| 字段 | 语义 |
|------|------|
| `status` | 当前阶段，watchdog 主决策入口 |
| `lastProgressAt` | 最近真实进展时间（stuck 判断） |
| `updatedAt` | 最近任意写回时间 |
| `nextWakeAt` | 下次定向唤醒时间 |
| `currentIteration` / `maxIterations` | 迭代预算 |

### task 级

| 字段 | 语义 |
|------|------|
| `status` | 单任务状态 |
| `retryCount` / `maxRetries` | 重试预算 |
| `backgroundProcessId` | 关联后台进程 |
| `lastError` | 最近错误 |

---

## 10. 数据流

```
用户指令
  → mission_start (create+plan+dispatch)
    → mission.json + plan.md 创建
    → 任务派发
      → L1: openclaw sessions → Discord mention
      → L2: openclaw agent → Discord mention
      → L3: 写 dispatch-queue 文件
    → commitMissionUpdate()
      → buildTransitionPayload()
      → resolveMentions()
      → NotificationAdapter.send()
        → openclaw message send
```

---

## 11. 设计原则

1. **状态与 schema 一致性**：`schemas/*.schema.json` 的状态枚举必须与 `types.ts` 中的 `MissionStatus` 保持同步
2. **watchdog 保守**：只输出建议，不直接执行复杂副作用或调用外部 API
3. **幂等与 no-op**：重复执行不产生假进展，no-op 不污染审计事件和 progress 时间戳
4. **工件落盘可恢复**：所有状态持久化到文件系统，中断后可恢复
5. **verify 是完成判定入口**：watchdog 负责推进到 verify，verify 才真正判定完成
