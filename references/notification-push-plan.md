# Mission Runner 状态变更全量通知推送方案

## Context

当前 Mission Runner 的通知机制只覆盖两个终态（`NOTIFY_COMPLETE` / `NOTIFY_ESCALATION`），且仅在 `mission-run-action.ts` 中显式触发。用户需要：**每次状态切换或任务分发时，都自动推送 human-readable 消息到对应渠道**，使用 OpenClaw 内置 message 分发逻辑。

核心挑战：状态变更分散在 10+ 个脚本中，需要一个合理的集中拦截机制。

**OpenClaw message 能力调研结果**：
- OpenClaw 提供 CLI 命令 `openclaw message send --channel <channel> --to <target> --message "..."`
- 底层通过 Channel Plugin 体系的 `ChannelOutboundAdapter`（`sendText/sendPayload`）投递到 Discord/Slack 等 20+ 渠道
- 路由解析通过 `src/routing/resolve-route.ts` 的 bindings 配置，按 peer/guild/account/channel 维度匹配
- 每个会话有唯一 `sessionKey`（agentId + channel + accountId + peer），Mission Runner 的 `mission.owner.sessionKey` 即对应 OpenClaw session

---

## 架构设计：集中式提交层 + 变更检测

### 核心思路

所有 mission.json 写入最终经过 `writeMission()`。新增一个上层函数 `commitMissionUpdate(old, new)`，在写入前自动检测状态变更并触发通知。

```
各脚本 → commitMissionUpdate(oldMission, newMission)
              │
              ├── writeMission()         // 原有落盘
              ├── detectTransitions()    // 比对 old/new，识别变更类型
              └── emitNotifications()    // 构建消息 → 适配器发送
```

通知失败不阻塞 mission 推进（fire-and-forget + 日志记录）。

---

## 新增文件

### 1. `scripts/lib/mission-commit.ts` — 集中式变更提交层

```typescript
export interface CommitOptions {
  missionsDir: string;
  oldMission: Mission;
  newMission: Mission;
  dryRun: boolean;
  source: string;           // 调用来源标识，如 'dispatch', 'verify'
  skipNotification?: boolean;
}

export function commitMissionUpdate(options: CommitOptions): boolean {
  const writeOk = writeMission(options.missionsDir, options.newMission);
  if (!writeOk) return false;
  if (!options.dryRun && !options.skipNotification) {
    const transitions = detectTransitions(options.oldMission, options.newMission);
    for (const t of transitions) {
      emitNotification(t, options);  // fire-and-forget
    }
  }
  return true;
}
```

**`detectTransitions(old, new)`** 返回需要推送的通知列表：
- 比对 `old.status !== new.status` → mission 级状态变更通知
- 比对 tasks: READY → RUNNING/WAITING_BACKGROUND → task 分发通知

### 2. `scripts/lib/mission-notification-templates.ts` — 消息模板

为每种状态变更生成 human-readable 消息：

| 状态变更 | 消息示例 |
|---------|---------|
| `→ CREATED` | `📋 新任务已创建「{title}」目标：{goal}` |
| `→ PLANNED` | `📝 任务「{title}」计划已生成，共 {n} 个子任务待执行` |
| `→ RUNNING` | `🚀 任务「{title}」开始执行` |
| `→ WAITING_BACKGROUND` | `⏳ 任务「{title}」等待后台进程完成` |
| `→ WAITING_EXTERNAL` | `⏳ 任务「{title}」等待外部条件` |
| `→ VERIFYING` | `🔍 任务「{title}」已进入验证阶段，{m}/{n} 子任务完成` |
| `→ ITERATING` | `🔄 任务「{title}」验证发现 {n} 个缺口，进入第 {i} 轮迭代` |
| `→ COMPLETED` | `✅ 任务「{title}」已完成` |
| `→ FAILED` | `❌ 任务「{title}」已失败：{reason}` |
| `→ ESCALATED` | `⚠️ 任务「{title}」需要人工介入：{reason}` |
| task 分发 | `📤 子任务 [{taskId}]「{taskTitle}」已分配，类型：{type}` |

每条消息包含：
- **状态流转**：`PLANNED → RUNNING`
- **Mission 标识**：`{title} ({missionId})`
- **上下文信息**：根据场景附带任务数量、失败原因、迭代轮次等

---

## 修改现有文件

### `scripts/lib/mission-notification.ts`

1. **扩展 `MissionNotificationKind`**：
   ```typescript
   export type MissionNotificationKind =
     | 'complete' | 'escalation'   // 保留向后兼容
     | 'status_transition'         // 通用状态变更
     | 'task_dispatched';          // 任务分发
   ```

2. **扩展 `MissionNotificationPayload`**：
   ```typescript
   // 新增可选字段
   transitionFrom?: MissionStatus;
   transitionTo?: MissionStatus;
   dispatchedTasks?: Array<{ taskId: string; title: string; type: string; agent?: string }>;
   source?: string;
   ```

3. **新增 `OpenClawMissionNotificationAdapter`**：
   通过 `child_process.execSync` 调用 `openclaw message send` CLI 命令发送消息。

   ```typescript
   export class OpenClawMissionNotificationAdapter implements MissionNotificationAdapter {
     readonly name = 'openclaw';

     send(payload: MissionNotificationPayload, context: { mission: Mission; dryRun: boolean }): MissionNotificationResult {
       const owner = context.mission.owner;
       if (!owner?.channel || !owner?.chatId) {
         // 无渠道信息，降级到 console
         return new ConsoleMissionNotificationAdapter().send(payload, context);
       }

       if (context.dryRun) {
         return { delivered: false, metadata: { adapter: this.name, deliveredAt: nowIso(), dryRun: true } };
       }

       try {
         // 调用 OpenClaw CLI 发送消息
         execSync(`openclaw message send --channel ${owner.channel} --to ${owner.chatId} --message ${escapeShellArg(payload.content)}`, {
           timeout: 10_000,
           stdio: 'pipe',
         });
         return {
           delivered: true,
           metadata: {
             adapter: this.name,
             target: `${owner.channel}:${owner.chatId}`,
             deliveredAt: nowIso(),
           },
         };
       } catch (err) {
         console.error(`[mission-notify:openclaw] failed to send: ${err}`);
         return {
           delivered: false,
           metadata: { adapter: this.name, deliveredAt: nowIso(), error: String(err) },
         };
       }
     }
   }
   ```

   **降级策略**：
   - `openclaw` CLI 不可用 → 降级到 `console` 适配器
   - `mission.owner` 无渠道信息 → 降级到 `console`
   - 发送超时（10s） → 记录错误，不阻塞

4. **更新 `resolveMissionNotificationAdapter()`**：增加 `'openclaw'` 选项

### `scripts/lib/mission-helpers.ts`

- `persistMissionUpdate()` 增加 `oldMission` 参数，内部改用 `commitMissionUpdate()`

### `scripts/lib/types.ts`

- `MissionFlags` 增加 `notifiedTransitions?: Record<string, boolean>` 用于幂等去重
  - key 格式：`"PLANNED->RUNNING"`, `"task:T1:READY->RUNNING"`

### 需要迁移的脚本（将 `writeMission()` 替换为 `commitMissionUpdate()`）

| 脚本 | 状态变更 | 优先级 |
|------|---------|--------|
| `mission-dispatch.ts` | PLANNED → RUNNING/WAITING_BACKGROUND + task 分发 | P0 |
| `mission-plan.ts` | CREATED → PLANNED | P0 |
| `mission-verify.ts`（via persistMissionUpdate） | VERIFYING → COMPLETED/ITERATING/FAILED | P0 |
| `mission-resume.ts` | ITERATING → RUNNING | P1 |
| `mission-reconcile-background.ts` | WAITING_BACKGROUND → RUNNING/VERIFYING | P1 |
| `mission-run-action.ts` (retryFailedTasks/setEscalationState) | → RUNNING/ESCALATED | P1 |
| `mission-create.ts` | → CREATED（特殊：无 oldMission，用空壳比对） | P1 |
| `task-update.ts` | task 状态变更触发 mission 状态推导 | P2 |

---

## OpenClaw Message 对接

### 适配器选择

通过环境变量 `MISSION_NOTIFICATION_ADAPTER` 选择：

| 值 | 行为 | 场景 |
|----|------|------|
| `console`（默认） | 输出到 stderr | 本地开发/调试 |
| `fake` | 静默，不输出 | 测试 |
| `discord` | 记录 Discord 元数据 | 保留兼容 |
| `openclaw` | 调用 `openclaw message send` CLI | **生产环境** |

### 渠道路由

从 `mission.owner` 自动路由：
- `owner.channel === 'discord'` + `owner.chatId` → `openclaw message send --channel discord --to <chatId>`
- `owner.channel === 'slack'` + `owner.chatId` → `openclaw message send --channel slack --to <chatId>`
- `owner.channel === 'cli'` 或未设置 → 降级到 console 输出

### 消息发送时机

Mission Runner 脚本是短命进程（非长驻），每次状态变更时同步调用 `openclaw message send`：
- 同步调用，超时 10s
- 发送失败只记录日志，不影响 mission 推进
- 幂等：同一状态转换不重复发送

---

## Agent 间通信（混合模式）

### 双通道设计

通知推送分为两个通道，由 `emitNotifications()` 统一调度：

```
commitMissionUpdate()
    │
    ├── 通道 A：用户通知（所有状态变更）
    │   └── openclaw message send → 用户所在渠道（Discord/Slack/...）
    │
    └── 通道 B：Agent 间触发（关键节点）
        └── openclaw message send → 下游 Agent 的 sessionKey
```

### 通道 B 触发规则

不是所有状态变更都需要通知下游 Agent，只在以下关键节点触发：

| 触发条件 | 通知目标 | 消息内容 |
|---------|---------|---------|
| 任务完成（task → COMPLETED） | Orchestrator Agent | `任务 {taskId} 已完成，可触发下一步` |
| 任务失败（task → FAILED） | Recovery Agent（如有） | `任务 {taskId} 失败：{lastError}` |
| 全部任务完成（→ VERIFYING） | Verifier Agent（如有） | `Mission {missionId} 所有任务完成，请验证` |
| 验证发现 gap（→ ITERATING） | Planner Agent | `验证发现 {n} 个缺口，需补充任务` |
| 升级（→ ESCALATED） | Owner Agent | `Mission 需要人工介入：{reason}` |

### Agent 路由

每个 task 已有 `agent` 和 `sessionKey` 字段（定义在 `types.ts` Task 接口中）。Agent 间通信通过这些字段路由：

```typescript
// 在 detectTransitions() 中，识别需要触发下游 Agent 的场景
interface AgentNotification {
  targetSessionKey: string;    // 下游 Agent 的 sessionKey
  content: string;             // human-readable 消息
  missionId: string;
  taskId?: string;
}
```

发送方式同样使用 `openclaw message send`，但 `--to` 参数指向 Agent 的 sessionKey 而非用户的 chatId：

```bash
# 通知用户
openclaw message send --channel discord --to <user-chatId> --message "..."

# 触发下游 Agent
openclaw message send --channel internal --to <agent-sessionKey> --message "..."
```

### 降级保障

Agent 间通信失败时，不影响 mission 推进——watchdog 的定期扫描机制作为兜底：
- 即使 Agent 间消息丢失，watchdog 下一轮扫描仍会检测到状态变更并推进
- Agent 间消息是"加速器"，共享工件 + watchdog 扫描是"保底线"

---

## 幂等性

- `commitMissionUpdate()` 在发通知前检查 `mission.flags.notifiedTransitions["PLANNED->RUNNING"]`
- 同一状态转换只通知一次
- 通知标记随 mission.json 一起原子写入

---

## 实现步骤

1. **Phase 1 - 基础设施**：新增 `mission-commit.ts` + `mission-notification-templates.ts`，扩展 notification 类型，新增 `OpenClawMissionNotificationAdapter`
2. **Phase 2 - P0 脚本迁移**：dispatch / plan / verify 三个核心脚本接入 `commitMissionUpdate`
3. **Phase 3 - P1 脚本迁移**：resume / reconcile / run-action / create
4. **Phase 4 - P2 脚本迁移**：task-update

## 验证方式

1. `npm run typecheck` — 类型检查通过
2. `npm test` — 现有测试不回归
3. 手动验证：设置 `MISSION_NOTIFICATION_ADAPTER=console`，运行 `npm run mission-start` 观察 stderr 是否输出 `mission_created` 和 `mission_planned` 的 human-readable 消息
4. 手动验证：运行 `npm run mission-dispatch` 观察 `status_transition` 和 `task_dispatched` 消息
5. 集成验证：设置 `MISSION_NOTIFICATION_ADAPTER=openclaw`，确认 `openclaw message send` 被正确调用
