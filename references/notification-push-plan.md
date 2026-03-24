# Mission Runner 状态变更全量通知推送方案

## Context

当前 Mission Runner 的通知机制只覆盖两个终态（`NOTIFY_COMPLETE` / `NOTIFY_ESCALATION`），且仅在 `mission-run-action.ts` 中显式触发。用户需要：**每次状态切换或任务分发时，都自动推送 human-readable 消息到对应渠道**，使用 OpenClaw 内置 message 分发逻辑。

核心挑战：状态变更分散在 10+ 个脚本中，需要一个合理的集中拦截机制。

### 交互模型

所有交互发生在**群聊**（Discord/Slack 等）中：

1. 用户在群聊中和 Agent 对话，Agent 接收消息后决定创建 mission
2. 创建 mission 后，发现群聊内的其他 Agent，创建计划，通过群聊 **@mention** 通知指定 Agent
3. Agent 接收消息后发生状态变更，在群聊内发送变更详情

**群聊本身就是 Agent 间的通信总线**，不需要额外的 internal channel 或 session-to-session 通信。

### OpenClaw message 能力

- CLI 命令：`openclaw message send --channel <channel> --to <chatId> --message "..."`
- 底层通过 Channel Plugin 体系的 `ChannelOutboundAdapter` 投递到 Discord/Slack 等 20+ 渠道
- `mission.owner.chatId` 对应**群聊 ID**，所有通知统一发到群聊
- OpenClaw inbound routing 会自动将群聊中 @某 Agent 的消息路由到该 Agent 的 session

---

## 架构设计：集中式提交层 + 变更检测 + 群聊 @mention

### 核心思路

所有 mission.json 写入最终经过 `writeMission()`。新增一个上层函数 `commitMissionUpdate(old, new)`，在写入前自动检测状态变更并触发通知。

```
各脚本 → commitMissionUpdate(oldMission, newMission)
              │
              ├── writeMission()              // 原有落盘
              ├── detectTransitions()         // 比对 old/new，识别变更类型
              ├── resolveMentions()           // 根据变更类型确定 @mention 目标
              └── emitNotifications()         // 构建消息（含 @mention）→ 发到群聊
```

单通道设计：所有消息都发到群聊，用 @mention 区分目标（用户或 Agent），用户和 Agent 都能看到所有状态变更。

通知失败不阻塞 mission 推进（fire-and-forget + 日志记录）。

---

## Agent 发现

### 群聊内 Agent 发现机制

Mission Runner 作为 OpenClaw 插件，通过 OpenClaw 配置发现群聊内可用的 Agent：

```typescript
// scripts/lib/mission-agent-discovery.ts（新增）

import type { Task } from './types.ts';

/** 群聊内可用的 Agent 信息 */
export interface AvailableAgent {
  agentId: string;            // OpenClaw agent ID
  name: string;               // 显示名称
  mentionTag: string;         // 渠道内 @mention 标记（如 Discord 的 <@botUserId>）
  skills: string[];           // Agent 具备的 skill 列表
  taskTypes: string[];        // Agent 擅长的任务类型
}

/** 从 OpenClaw 配置获取群聊内可用 Agent */
export function discoverAgents(options: {
  channel: string;
  chatId: string;
}): AvailableAgent[] {
  // 通过 OpenClaw 的 listAgentEntries(cfg) 获取配置的 agent 列表
  // 通过 routing/bindings 过滤出绑定到当前群聊（channel + chatId）的 agent
  // 返回可用 Agent 列表（含 mentionTag）
}

/** 根据 task type 匹配最佳 Agent */
export function matchAgentForTask(
  task: Task,
  agents: AvailableAgent[]
): AvailableAgent | null {
  // 优先匹配 taskTypes 包含 task.type 的 Agent
  // 其次匹配 skills 相关的 Agent
  // 无匹配则返回 null（由 orchestrator 自己执行）
}
```

### Plan 阶段消费 Agent 信息

`mission-plan.ts` 改造：

```typescript
// plan 阶段
const agents = discoverAgents({
  channel: mission.owner?.channel ?? '',
  chatId: mission.owner?.chatId ?? '',
});

const tasks = buildTasks(mission);

// 为每个 task 分配 agent
for (const task of tasks) {
  const matched = matchAgentForTask(task, agents);
  if (matched) {
    task.agent = matched.agentId;
    // 新增字段：存储 mention 标记，供消息模板使用
    task.config = { ...task.config, agentMentionTag: matched.mentionTag, agentName: matched.name };
  }
}
```

---

## @mention 机制

### 渠道格式

不同渠道的 @mention 格式不同：

| 渠道 | @mention 格式 | 示例 |
|------|--------------|------|
| Discord | `<@botUserId>` | `<@1234567890>` |
| Slack | `<@memberId>` | `<@U01ABC123>` |
| CLI | `@agentName` | `@Researcher` |

### mention 解析

```typescript
// scripts/lib/mission-notification-mentions.ts（新增）

/** 根据状态变更确定 @mention 目标 */
export function resolveMentions(
  transition: TransitionInfo,
  mission: Mission
): string[] {
  const mentions: string[] = [];

  switch (transition.kind) {
    case 'task_dispatched':
      // @被分配的 Agent
      const task = mission.tasks?.find(t => t.taskId === transition.taskId);
      const tag = task?.config?.agentMentionTag as string | undefined;
      if (tag) mentions.push(tag);
      break;

    case 'task_completed':
    case 'task_failed':
      // @Orchestrator（通知编排者继续推进）
      // orchestrator 的 mentionTag 从 mission.metadata 中获取
      const orchTag = mission.metadata?.orchestratorMentionTag as string | undefined;
      if (orchTag) mentions.push(orchTag);
      break;

    case 'mission_completed':
    case 'mission_escalated':
      // @用户（通知 mission 发起者）
      // 用户的 mention 信息从 mission.owner 获取
      const userMention = mission.owner?.requestMessageId; // 或专门的 mention 字段
      if (userMention) mentions.push(userMention);
      break;
  }

  return mentions;
}
```

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
      const mentions = resolveMentions(t, options.newMission);
      emitNotification(t, mentions, options);  // fire-and-forget
    }
  }
  return true;
}
```

**`detectTransitions(old, new)`** 返回需要推送的通知列表：
- 比对 `old.status !== new.status` → mission 级状态变更通知
- 比对 tasks: READY → RUNNING/WAITING_BACKGROUND → task 分发通知
- 比对 tasks: RUNNING → COMPLETED/FAILED → task 完成/失败通知

### 2. `scripts/lib/mission-notification-templates.ts` — 消息模板（含 @mention）

为每种状态变更生成 human-readable 消息，消息末尾附加 @mention：

| 状态变更 | 消息示例 |
|---------|---------|
| `→ CREATED` | `📋 新任务已创建「{title}」目标：{goal}` |
| `→ PLANNED` | `📝 任务「{title}」计划已生成，共 {n} 个子任务：\n- T1: {title} → @Researcher\n- T2: {title} → @Analyst\n@Researcher 请开始执行 T1` |
| `→ RUNNING` | `🚀 任务「{title}」开始执行 @{agentName}` |
| `→ WAITING_BACKGROUND` | `⏳ 任务「{title}」等待后台进程完成` |
| `→ WAITING_EXTERNAL` | `⏳ 任务「{title}」等待外部条件` |
| `→ VERIFYING` | `🔍 任务「{title}」已进入验证阶段，{m}/{n} 子任务完成` |
| `→ ITERATING` | `🔄 任务「{title}」验证发现 {n} 个缺口，进入第 {i} 轮迭代` |
| `→ COMPLETED` | `✅ 任务「{title}」已完成 @{user}` |
| `→ FAILED` | `❌ 任务「{title}」已失败：{reason} @{orchestrator}` |
| `→ ESCALATED` | `⚠️ 任务「{title}」需要人工介入：{reason} @{user}` |
| task 分发 | `📤 子任务 [{taskId}]「{taskTitle}」已分配 @{agentName}，类型：{type}` |
| task 完成 | `✅ 子任务 [{taskId}]「{taskTitle}」已完成，产物：{artifacts} @{orchestrator}` |
| task 失败 | `❌ 子任务 [{taskId}]「{taskTitle}」失败：{lastError} @{orchestrator}` |

### 3. `scripts/lib/mission-agent-discovery.ts` — Agent 发现

见上方"Agent 发现"章节。

### 4. `scripts/lib/mission-notification-mentions.ts` — @mention 解析

见上方"@mention 机制"章节。

---

## 修改现有文件

### `scripts/lib/types.ts`

1. `MissionOwner.chatId` 语义明确为**群聊 ID**：

   ```typescript
   export interface MissionOwner {
     sessionKey: string;
     channel?: 'discord' | 'slack' | 'cli' | 'web' | 'api';
     chatId?: string;               // 群聊 ID（Discord guild/channel, Slack channel 等）
     requestMessageId?: string;
     userMentionTag?: string;        // 新增：用户在渠道内的 @mention 标记
   }
   ```

2. `MissionFlags` 增加幂等标记：

   ```typescript
   export interface MissionFlags {
     notifiedStart?: boolean;
     notifiedComplete?: boolean;
     notifiedEscalation?: boolean;
     userUpdated?: boolean;
     notifiedTransitions?: Record<string, boolean>;  // 新增：幂等去重
   }
   ```

3. `Mission.metadata` 约定存储 orchestrator 信息：

   ```typescript
   // metadata 中约定字段
   metadata?: {
     orchestratorAgentId?: string;
     orchestratorMentionTag?: string;
     [key: string]: unknown;
   };
   ```

### `scripts/lib/mission-notification.ts`

1. **扩展 `MissionNotificationKind`**：

   ```typescript
   export type MissionNotificationKind =
     | 'complete' | 'escalation'       // 保留向后兼容
     | 'status_transition'             // mission 级状态变更
     | 'task_dispatched'               // 任务分发
     | 'task_completed'                // 任务完成
     | 'task_failed';                  // 任务失败
   ```

2. **扩展 `MissionNotificationPayload`**：

   ```typescript
   export interface MissionNotificationPayload {
     kind: MissionNotificationKind;
     missionId: string;
     title: string;
     status: Mission['status'];
     content: string;
     mentions?: string[];              // 新增：@mention 标记列表
     transitionFrom?: MissionStatus;   // 新增
     transitionTo?: MissionStatus;     // 新增
     taskId?: string;                  // 新增：关联的 task
     source?: string;                  // 新增：触发来源
     metadata?: Record<string, unknown>;
   }
   ```

3. **`OpenClawMissionNotificationAdapter` 发送到群聊**：

   ```typescript
   export class OpenClawMissionNotificationAdapter implements MissionNotificationAdapter {
     readonly name = 'openclaw';

     send(payload: MissionNotificationPayload, context: { mission: Mission; dryRun: boolean }): MissionNotificationResult {
       const owner = context.mission.owner;
       if (!owner?.channel || !owner?.chatId) {
         return new ConsoleMissionNotificationAdapter().send(payload, context);
       }

       if (context.dryRun) {
         return { delivered: false, metadata: { adapter: this.name, deliveredAt: nowIso(), dryRun: true } };
       }

       // 消息内容 + @mention 拼接
       const mentionSuffix = (payload.mentions ?? []).length > 0
         ? '\n' + payload.mentions!.join(' ')
         : '';
       const fullContent = payload.content + mentionSuffix;

       try {
         execSync(
           `openclaw message send --channel ${owner.channel} --to ${owner.chatId} --message ${escapeShellArg(fullContent)}`,
           { timeout: 10_000, stdio: 'pipe' }
         );
         return {
           delivered: true,
           metadata: {
             adapter: this.name,
             target: `${owner.channel}:${owner.chatId}`,
             mentions: payload.mentions,
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

### `scripts/mission-plan.ts`

核心改造：plan 阶段引入 Agent 发现和分配：

1. 调用 `discoverAgents()` 获取群聊内可用 Agent
2. 为每个 task 调用 `matchAgentForTask()` 分配 agent
3. 写入 `task.agent`（agentId）和 `task.config.agentMentionTag`（@mention 标记）
4. 在 mission.metadata 中记录 orchestrator 的 agentId 和 mentionTag

### `scripts/mission-create.ts`

确保从 OpenClaw 上下文获取群聊信息写入 `owner`：

- `owner.channel` — 渠道类型
- `owner.chatId` — 群聊 ID
- `owner.userMentionTag` — 用户的 @mention 标记
- `metadata.orchestratorAgentId` — 创建者 Agent 的 ID
- `metadata.orchestratorMentionTag` — 创建者 Agent 的 @mention 标记

### 需要迁移的脚本（将 `writeMission()` 替换为 `commitMissionUpdate()`）

| 脚本 | 状态变更 | 优先级 |
|------|---------|--------|
| `mission-dispatch.ts` | PLANNED → RUNNING/WAITING_BACKGROUND + task 分发 | P0 |
| `mission-plan.ts` | CREATED → PLANNED + Agent 分配 | P0 |
| `mission-verify.ts`（via persistMissionUpdate） | VERIFYING → COMPLETED/ITERATING/FAILED | P0 |
| `mission-resume.ts` | ITERATING → RUNNING | P1 |
| `mission-reconcile-background.ts` | WAITING_BACKGROUND → RUNNING/VERIFYING | P1 |
| `mission-run-action.ts` (retryFailedTasks/setEscalationState) | → RUNNING/ESCALATED | P1 |
| `mission-create.ts` | → CREATED（写入群聊信息和 orchestrator 信息） | P1 |
| `task-update.ts` | task 状态变更 → 群聊通知 + @orchestrator | P2 |

---

## OpenClaw Message 对接

### 适配器选择

通过环境变量 `MISSION_NOTIFICATION_ADAPTER` 选择：

| 值 | 行为 | 场景 |
|----|------|------|
| `console`（默认） | 输出到 stderr | 本地开发/调试 |
| `fake` | 静默，不输出 | 测试 |
| `discord` | 记录 Discord 元数据 | 保留兼容 |
| `openclaw` | 调用 `openclaw message send` CLI → 群聊 | **生产环境** |

### 消息发送时机

Mission Runner 脚本是短命进程（非长驻），每次状态变更时同步调用 `openclaw message send`：
- 同步调用，超时 10s
- 发送失败只记录日志，不影响 mission 推进
- 幂等：同一状态转换不重复发送

---

## 完整交互流程示例

```
群聊（Discord #project-channel）
 │
 │  用户: "帮我调研 Claude API 最新功能并输出报告"
 │
 ├─ 🤖 Orchestrator（mission-create + mission-plan）
 │     群聊发送：
 │     "📋 新任务已创建「Claude API 调研」
 │      目标：调研 Claude API 最新功能并输出报告
 │
 │      📝 计划已生成，共 2 个子任务：
 │      - T1: 搜索最新功能 → @Researcher
 │      - T2: 整理报告 → @Analyst
 │
 │      📤 T1「搜索最新功能」已分配 @Researcher"
 │
 ├─ 🤖 Researcher（被 @ 触发，执行 T1）
 │     群聊发送：
 │     "🚀 T1「搜索最新功能」READY → RUNNING"
 │     ...执行...
 │     "✅ T1「搜索最新功能」RUNNING → COMPLETED
 │      已收集 5 个来源，产物: artifacts/T1-sources.json
 │      @Orchestrator"
 │
 ├─ 🤖 Orchestrator（收到 T1 完成，dispatch T2）
 │     群聊发送：
 │     "📤 T2「整理报告」已就绪 @Analyst"
 │
 ├─ 🤖 Analyst（被 @ 触发，执行 T2）
 │     群聊发送：
 │     "🚀 T2「整理报告」READY → RUNNING"
 │     ...执行...
 │     "✅ T2「整理报告」RUNNING → COMPLETED
 │      产物: artifacts/final-report.md
 │      @Orchestrator"
 │
 └─ 🤖 Orchestrator（verify → 完成）
       群聊发送：
       "🔍 任务「Claude API 调研」进入验证阶段
       ✅ 任务「Claude API 调研」已完成
        报告: artifacts/final-report.md
        @用户"
```

---

## 幂等性

- `commitMissionUpdate()` 在发通知前检查 `mission.flags.notifiedTransitions["PLANNED->RUNNING"]`
- 同一状态转换只通知一次
- task 分发通知通过 `"task:T1:READY->RUNNING"` key 去重
- 通知标记随 mission.json 一起原子写入

---

## 降级保障

- 通知发送失败不阻塞 mission 推进（fire-and-forget）
- Agent @mention 失败不影响 watchdog 定期扫描机制——watchdog 作为兜底仍会检测状态变更并推进
- @mention 是"加速器"，watchdog 扫描是"保底线"

---

## 实现步骤

1. **Phase 1 - 基础设施**：
   - 新增 `mission-commit.ts`（集中提交层）
   - 新增 `mission-notification-templates.ts`（含 @mention 的消息模板）
   - 新增 `mission-agent-discovery.ts`（Agent 发现）
   - 新增 `mission-notification-mentions.ts`（@mention 解析）
   - 扩展 `mission-notification.ts`（新 Kind、Payload.mentions、OpenClawAdapter）
   - 扩展 `types.ts`（MissionOwner.userMentionTag、MissionFlags.notifiedTransitions）

2. **Phase 2 - P0 脚本迁移**：
   - `mission-plan.ts` — Agent 发现 + 分配 + commitMissionUpdate
   - `mission-dispatch.ts` — commitMissionUpdate + task 分发 @mention
   - `mission-verify.ts` — commitMissionUpdate

3. **Phase 3 - P1 脚本迁移**：
   - `mission-create.ts` — 写入群聊信息和 orchestrator 信息
   - `mission-resume.ts` / `mission-reconcile-background.ts` / `mission-run-action.ts`

4. **Phase 4 - P2 脚本迁移**：
   - `task-update.ts` — Agent 汇报完成/失败 + @orchestrator

## 验证方式

1. `npm run typecheck` — 类型检查通过
2. `npm test` — 现有测试不回归
3. 手动验证（console adapter）：`MISSION_NOTIFICATION_ADAPTER=console npm run mission-start` 观察 stderr 输出是否包含状态变更消息和 @mention 标记
4. 手动验证（console adapter）：`npm run mission-dispatch` 观察 task 分发消息是否 @指定 Agent
5. 集成验证：`MISSION_NOTIFICATION_ADAPTER=openclaw` 确认消息发送到群聊且 @mention 格式正确
