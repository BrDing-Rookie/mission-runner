# 派发器 开发文档

## 模块范围
- `scripts/lib/mission-dispatcher.ts` — 任务就绪检查、派发结果应用、摘要构建
- `scripts/lib/mission-dispatch-agent.ts` — 三级回退 Agent 派发（L1→L2→L3）
- `scripts/lib/dispatch-queue.ts` — L3 回退：将派发条目写入磁盘队列
- `scripts/lib/dispatch-messenger.ts` — 在群聊中 @mention Agent 发送任务派发消息

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
