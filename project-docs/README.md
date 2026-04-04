# Mission Runner 项目说明

Mission Runner 是一个基于 OpenClaw 的插件级自治任务编排层。它将聊天式 Agent 提升为能持续推进长期任务的系统——mission 工件落盘、状态机驱动、watchdog 保守判断、verify 完成判定。

## 核心流程

```
create -> plan -> dispatch -> execute -> verify -> complete
```

## 模块索引

| 模块 | 说明 | 文档 |
|------|------|------|
| 状态机 | 状态定义与迁移规则 | [state-machine.md](./state-machine.md) |
| 文件系统 | mission 工件读写 | [file-system.md](./file-system.md) |
| 计划器 | 任务拆解与计划生成 | [planner.md](./planner.md) |
| 派发器 | 任务分配与 Agent 派发 | [dispatcher.md](./dispatcher.md) |
| 看门狗 | 状态巡检与动作建议 | [watchdog.md](./watchdog.md) |
| 验证器 | 完成标准验收 | [verifier.md](./verifier.md) |
| 回收器 | 后台进程结果回收 | [reconciler.md](./reconciler.md) |
| 通知 | 状态变更通知推送 | [notification.md](./notification.md) |
| 编排器 | 多步自动推进 | [orchestrator.md](./orchestrator.md) |
| 外部集成 | OpenClaw/Discord 集成 | [external-integration.md](./external-integration.md) |
| 仪表盘 | 状态面板格式化 | [dashboard.md](./dashboard.md) |
