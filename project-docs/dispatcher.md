# 派发器

## 功能概述
将 READY 状态的 task 派发给合适的 Agent 执行。支持三级回退派发策略（L1 直接创建 session → L2 消息派发 → L3 磁盘队列）。

## 核心能力
- **任务就绪检查**: `isReady()` 判断 task 是否可派发
- **Agent 映射**: `DEFAULT_AGENT_MAP` 将 task type 映射到 agent
- **三级回退派发**: L1 OpenClaw session → L2 Discord @mention → L3 磁盘队列
- **指数退避重试**: dispatch 失败时自动重试，带最大次数限制
- **派发消息构建**: `buildDispatchMessage()` 生成含 task-update 回报命令的派发消息
- **后台进程记录**: 派发成功后记录 `backgroundProcesses` 信息

## 使用方式
```bash
npm run mission-dispatch -- --missions-dir ./missions --mission-id <id>
```

## 当前限制
- L1/L2 依赖 `openclaw` CLI，在测试环境不可用
- `dispatch-messenger.ts` 硬编码了 `--account discord-rd-lead`
- `buildDispatchMessage()` 中硬编码了项目路径 `/home/ubuntu/public-deliverables/mission-runner`

## 相关模块
- 依赖: state-machine, file-system, external-integration（agent-session, discord-id-resolver）
- 被依赖: orchestrator
