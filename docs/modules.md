# Mission Runner 各模块功能文档

> 生成时间：2026-03-31 | 版本：commit 57a2522

## 一、核心库 (`scripts/lib/`)

### types.ts (294 行)
**职责**：全局类型定义
- `Mission`：mission 完整结构（状态、任务列表、验证、升级）
- `Task`：单个任务（状态、agent、依赖、产物）
- `MissionStatus` / `TaskStatus`：状态枚举
- `MissionOwner`：任务归属（channel、chatId、userMentionTag）
- `VerificationState`：验证结果

### fs-utils.ts (206 行)
**职责**：文件系统操作工具
- `listMissionIds()`：扫描 missions 目录
- `readMission()` / `writeMission()`：读写 mission.json（带文件锁）
- `ensureDir()`：创建目录
- `writeArtifactFile()`：写入产物文件
- 支持原子写入防并发

### mission-helpers.ts (88 行)
**职责**：Mission 辅助函数
- `requireMission()`：加载并校验 mission
- `parseMissionCliArgs()`：CLI 参数解析
- `deriveMissionStatus()`：从任务状态推导 mission 状态
- `nowIso()`：ISO 时间戳

### mission-commit.ts (191 行)
**职责**：状态提交 + 通知触发
- `commitMissionUpdate()`：核心状态提交函数
- 检测 mission/task 状态变更
- 调用通知模板生成消息
- 触发 Discord 通知
- 幂等保护（notifiedTransitions）

### mission-dispatch-agent.ts (392 行)
**职责**：三级回退 Agent 派发
- `checkAgentSession()`：检查 agent 活跃 session
- `createAgentSession()`：通过 `openclaw agent` 创建 session
- `mentionInDiscord()`：发送 Discord @mention
- `spawnFallback()`：L3 写 dispatch queue 文件
- `dispatchTaskToAgent()`：三级回退编排（L1→L2→L3）
- 常量：`DISPATCH_QUEUE_DIR`, `DISCORD_IDS_PATH`

### mission-notification.ts (204 行)
**职责**：通知适配器
- `OpenClawConsoleNotificationAdapter`：控制台输出
- `OpenClawMissionNotificationAdapter`：Discord 消息发送
- 支持 edit（更新已有消息）和 send（新消息）
- `--account discord-rd-lead` + `--target` CLI 参数

### mission-notification-templates.ts (123 行)
**职责**：消息模板
- `buildTransitionMessage()`：mission 状态变更消息
- `buildTaskMessage()`：task 事件消息
- `buildTransitionPayload()`：完整 payload 构建
- 支持：CREATED/PLANNED/RUNNING/COMPLETED/FAILED/ESCALATED

### mission-notification-mentions.ts (53 行)
**职责**：@mention 解析
- `resolveMentions()`：根据事件类型确定 @mention 目标
- task_dispatched → @被分配的 Agent
- task_completed/failed → @Orchestrator
- mission 终态 → @用户

### mission-agent-discovery.ts (92 行)
**职责**：Agent 发现
- 扫描 workspace 和配置中的可用 agent
- 支持 agent 类型匹配

### shell-utils.ts (10 行)
**职责**：Shell 安全
- `escapeShellArg()`：防命令注入

## 二、CLI 入口脚本 (`scripts/`)

| 脚本 | 职责 | 关键参数 |
|------|------|----------|
| mission-create.ts | 创建 mission | `--title`, `--goal`, `--owner` |
| mission-plan.ts | 任务规划 | `--mission-id` |
| mission-dispatch.ts | 派发任务 | `--mission-id` |
| mission-orchestrate.ts | 编排循环 | `--mission-id`, `--max-steps` |
| mission-watchdog.ts | 状态监控 | `--missions-dir`, `--dry-run` |
| mission-verify.ts | 完成验证 | `--mission-id` |
| mission-resume.ts | 恢复任务 | `--mission-id` |
| mission-run-action.ts | Action 执行 | `--action` |
| mission-list.ts | 列表（Dashboard） | `--json` |
| mission-start.ts | 一键启动 | `--title`, `--goal` |
| task-add.ts | 动态添加任务 | `--agent`, `--title`, `--type` |
| task-update.ts | 状态汇报 | `--status`, `--summary` |
| mission-write-artifact.ts | 产物写入 | `--path`, `--content` |

## 三、数据流

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

## 四、配置

| 配置项 | 位置 | 说明 |
|--------|------|------|
| Missions 目录 | `./missions/` | 相对 workspace |
| Dashboard ID | `missions/.dashboard.json` | Dashboard 消息追踪 |
| Discord IDs | `projects/discord-agent-ids.json` | Agent→Discord ID 映射 |
| Plugin 配置 | `openclaw.plugin.json` | missionsDir 等 |
| Dispatch Queue | `dispatch-queue/` | L3 派发队列 |
