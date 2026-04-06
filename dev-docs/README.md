# Mission Runner 开发文档

## 项目开发目标

将 Mission Runner 从「手动挡 MVP」推进为「自动闭环的完整编排系统」。

当前阶段: **Phase 2 — 闭环可靠性**（Phase 1 已完成）

Phase 1 已完成:
- VERIFYING 状态 task-add 修复 + 状态回退
- Zod 运行时校验接入（warn 降级模式）
- E2E 集成测试补充（170 测试通过）
- P0 安全修复 + P1/P2 代码审查修复
- dispatch 消息回调 + watchdog 停滞检测
- verify 自动/手动模式拆分

Phase 2 核心目标：
- 并发安全（原子写入 + 文件锁）
- Zod 校验收紧（warn → strict）
- 状态迁移强制校验
- Agent 结果自动回收
- Watchdog daemon 化

## 索引

- **[BACKLOG.md](./BACKLOG.md)** — 正在开发 & 待开发任务索引
- **[DONE.md](./DONE.md)** — 已完成任务索引

## 模块目录

| 模块 | 目录 | 涉及源文件 |
|------|------|-----------|
| 状态机 | [state-machine/](./state-machine/) | types.ts, mission-helpers.ts |
| 文件系统 | [file-system/](./file-system/) | fs-utils.ts |
| 计划器 | [planner/](./planner/) | mission-planner.ts |
| 派发器 | [dispatcher/](./dispatcher/) | mission-dispatcher.ts, mission-dispatch-agent.ts, dispatch-queue.ts, dispatch-messenger.ts |
| 看门狗 | [watchdog/](./watchdog/) | mission-watchdog-evaluator.ts |
| 验证器 | [verifier/](./verifier/) | mission-verifier.ts |
| 回收器 | [reconciler/](./reconciler/) | mission-reconcile-background.ts |
| 通知 | [notification/](./notification/) | mission-notification.ts, mission-notification-templates.ts, mission-notification-mentions.ts |
| 编排器 | [orchestrator/](./orchestrator/) | mission-orchestrate.ts, mission-start.ts |
| 外部集成 | [external-integration/](./external-integration/) | agent-session.ts, discord-id-resolver.ts, mission-agent-discovery.ts, safe-exec.ts |
| 仪表盘 | [dashboard/](./dashboard/) | dashboard-formatter.ts |
