# Mission Runner

最小可用 CLI 闭环：create/plan/dispatch/orchestrate/verify/retry/escalate。

## 常用命令

```bash
npm run typecheck
npm test

# 创建并启动一条 mission
npm run mission-start -- --missions-dir ./missions --title "Demo" --goal "Ship a validated loop"

# 有限步推进 mission（默认 3 步，可改）
npm run mission-orchestrate -- --missions-dir ./missions --mission-id <mission-id> --max-steps 5

# 单独执行 watchdog 决策动作
npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action CHECK_BACKGROUND
npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action TRIGGER_VERIFY
npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action RESUME_TASK
npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action RETRY_TASK
npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action ESCALATE_STUCK
npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action NOTIFY_COMPLETE
npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action NOTIFY_ESCALATION
```

## 当前闭环能力

- `mission-orchestrate` 支持有限步 runner，能在一次调用里连续推进多个动作。
- 已覆盖自动推进：`CHECK_BACKGROUND -> TRIGGER_VERIFY`、`RESUME_TASK -> DISPATCH`。
- `mission-run-action` 提供最小可执行失败/升级/通知分支：`RETRY_TASK`、`ESCALATE_STUCK`、`NOTIFY_COMPLETE`、`NOTIFY_ESCALATION`。
- 所有状态推进都落 `mission.json` + `events.jsonl`，便于验收与回放。

## 已知边界

- 通知目前只落状态与事件，不直接发外部消息。
- 重试策略目前是 MVP：把可重试失败任务重置为 `READY`，由后续 dispatch 继续推进。
- 编排器是有限步循环，不是长期常驻调度器。

## 通知适配器（MVP）

当前 `mission-run-action` 的 `NOTIFY_COMPLETE` / `NOTIFY_ESCALATION` 已接入最小通知 sender/adapter 结构：

- `console`：默认，打印通知内容到控制台
- `fake`：测试用，不做真实输出
- `discord`：最小 Discord adapter，先固化 Discord/OpenClaw 外发载荷与 delivery metadata 回写

### 使用方式

```bash
# 默认 console adapter
npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action NOTIFY_COMPLETE

# fake adapter
MISSION_NOTIFICATION_ADAPTER=fake \
  npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action NOTIFY_ESCALATION

# discord adapter（MVP）
MISSION_NOTIFICATION_ADAPTER=discord \
MISSION_NOTIFICATION_DISCORD_CHANNEL=<discord-channel-id-or-name> \
  npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action NOTIFY_COMPLETE
```

### 当前 Discord adapter 边界

- 这一步优先保持“最小可用”：先把 adapter/sender 结构、Discord 专属 payload、delivery metadata 回写打通。
- `mission.json` 会在 `metadata.notificationDelivery.complete|escalation` 下记录最近一次投递元数据。
- `events.jsonl` 的 `mission_notified_complete` / `mission_notified_escalation` 事件也会附带 `delivery` 字段。
- 目前未直接调用外部 Discord API；后续可以把 `discord` adapter 内部实现替换为 OpenClaw `message` 能力，而不影响现有 console/fake adapter 或上层调用方式。
