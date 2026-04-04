# 通知

## 功能概述
在 mission 状态变更时发送通知，支持多种适配器（console/fake/discord/openclaw）。

## 核心能力
- **多适配器**: console（控制台输出）、fake（测试用）、discord（元数据记录）、openclaw（通过 CLI 发送）
- **通知类型**: complete/escalation/status_transition/task_dispatched/task_completed/task_failed
- **幂等去重**: 通过 `notifiedTransitions` 记录已通知的状态迁移，避免重复通知
- **@mention 支持**: 根据任务和角色解析需要 @mention 的用户
- **通知模板**: 预定义的通知内容模板

## 使用方式
通过环境变量选择适配器：
```bash
MISSION_NOTIFICATION_ADAPTER=console|fake|discord|openclaw
```

## 当前限制
- Discord 适配器（`DiscordMissionNotificationAdapter`）实际不发送消息，只返回元数据
- 真正发送通过 OpenClaw 适配器走 `openclaw message send` CLI
- 命名容易造成混淆

## 相关模块
- 依赖: state-machine, external-integration（openclaw CLI）
- 被依赖: mission-commit.ts（状态提交时触发通知）
