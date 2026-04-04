# 文档管理体系 — 实施计划

> 创建日期: 2026-04-03
> 设计方案: docs/proposal-doc-management.md
> 状态: 待执行

本计划包含完整的文件内容和操作步骤，可由新的 Claude Code 会话直接执行，无需额外上下文。

---

## 执行概览

共 7 步，预计创建 ~30 个文件：

| 步骤 | 内容 | 创建文件数 |
|------|------|-----------|
| 1 | 创建 dev-docs 目录结构 + 总文档 + 索引 | 14 |
| 2 | 创建 project-docs 目录结构 + 模块说明 | 12 |
| 3 | 更新 CLAUDE.md 添加工作流规则 | 0（编辑） |
| 4 | 创建 Hook 脚本 + 更新 settings.json | 2 |
| 5 | 更新 dispatch-messenger.ts 嵌入规则提醒 | 0（编辑） |
| 6 | 更新方案文档状态 | 0（编辑） |
| 7 | 提交 git commit | 0 |

---

## 步骤 1: 创建 dev-docs 开发文档树

### 1.1 创建目录

```bash
mkdir -p dev-docs/{state-machine,file-system,planner,dispatcher,watchdog,verifier,reconciler,notification,orchestrator,external-integration,dashboard}
```

### 1.2 创建 `dev-docs/README.md`

```markdown
# Mission Runner 开发文档

## 项目开发目标

将 Mission Runner 从「手动挡 MVP」推进为「自动闭环的完整编排系统」。

当前阶段: **Phase 2 — 闭环可靠性**

核心目标：
- 并发安全（原子写入 + 文件锁）
- Zod 校验收紧
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
```

### 1.3 创建 `dev-docs/BACKLOG.md`

```markdown
# 正在开发 & 待开发

> 开发前必须在此登记，开发完成后移至 [DONE.md](./DONE.md)

| 模块 | 文档 | 状态 | 创建日期 |
|------|------|------|----------|
| _(暂无)_ | | | |
```

### 1.4 创建 `dev-docs/DONE.md`

```markdown
# 已完成

> 开发完成的任务从 [BACKLOG.md](./BACKLOG.md) 移至此处

| 模块 | 文档 | 完成日期 |
|------|------|----------|
| _(暂无)_ | | |
```

### 1.5 创建 11 个模块 README

每个 `dev-docs/<module>/README.md` 按以下模板创建，替换具体内容：

#### `dev-docs/state-machine/README.md`

```markdown
# 状态机 开发文档

## 模块范围
- `scripts/lib/types.ts` — 核心类型定义、状态枚举、状态迁移规则（ALLOWED_TRANSITIONS）
- `scripts/lib/mission-helpers.ts` — mission 操作辅助函数、状态设置

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

#### `dev-docs/file-system/README.md`

```markdown
# 文件系统 开发文档

## 模块范围
- `scripts/lib/fs-utils.ts` — mission 工件目录的文件 I/O（mission.json 读写、events.jsonl 追加）

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

#### `dev-docs/planner/README.md`

```markdown
# 计划器 开发文档

## 模块范围
- `scripts/lib/mission-planner.ts` — 计划生成逻辑（模板解析、任务规范化、完成标准构建）

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

#### `dev-docs/dispatcher/README.md`

```markdown
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
```

#### `dev-docs/watchdog/README.md`

```markdown
# 看门狗 开发文档

## 模块范围
- `scripts/lib/mission-watchdog-evaluator.ts` — watchdog 核心评估逻辑（状态扫描、stall 检测、动作建议）

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

#### `dev-docs/verifier/README.md`

```markdown
# 验证器 开发文档

## 模块范围
- `scripts/lib/mission-verifier.ts` — 验收逻辑（标准评估、结构验证、测试执行）

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

#### `dev-docs/reconciler/README.md`

```markdown
# 回收器 开发文档

## 模块范围
- `scripts/mission-reconcile-background.ts` — 回收后台进程结果，回写 task 状态

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

#### `dev-docs/notification/README.md`

```markdown
# 通知 开发文档

## 模块范围
- `scripts/lib/mission-notification.ts` — 通知 sender/adapter 结构（console/fake/discord/openclaw）
- `scripts/lib/mission-notification-templates.ts` — 通知内容模板
- `scripts/lib/mission-notification-mentions.ts` — @mention 解析

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

#### `dev-docs/orchestrator/README.md`

```markdown
# 编排器 开发文档

## 模块范围
- `scripts/mission-orchestrate.ts` — 有限步 runner，连续推进多个动作
- `scripts/mission-start.ts` — 创建并启动 mission 的组合入口

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

#### `dev-docs/external-integration/README.md`

```markdown
# 外部集成 开发文档

## 模块范围
- `scripts/lib/agent-session.ts` — Agent session 检查与创建（依赖 OpenClaw CLI）
- `scripts/lib/discord-id-resolver.ts` — Discord bot 用户 ID 解析
- `scripts/lib/mission-agent-discovery.ts` — Agent 发现与列表
- `scripts/lib/safe-exec.ts` — 安全 CLI 命令执行封装

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

#### `dev-docs/dashboard/README.md`

```markdown
# 仪表盘 开发文档

## 模块范围
- `scripts/lib/dashboard-formatter.ts` — Dashboard Discord embed 格式化

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| _(暂无)_ | | |
```

---

## 步骤 2: 创建 project-docs 项目说明树

### 2.1 创建目录

```bash
mkdir -p project-docs
```

### 2.2 创建 `project-docs/README.md`

```markdown
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
```

### 2.3 创建 11 个模块说明文档

#### `project-docs/state-machine.md`

```markdown
# 状态机

## 功能概述
定义 Mission 和 Task 的全部状态枚举、状态迁移规则，以及状态操作辅助函数。是整个系统状态语义的单一事实源。

## 核心能力
- **Mission 状态管理**: 11 个状态（CREATED → COMPLETED/FAILED/ESCALATED），含活跃态和终态分类
- **Task 状态管理**: 8 个状态（PENDING → COMPLETED/FAILED/SKIPPED）
- **状态迁移规则**: `ALLOWED_TRANSITIONS` 迁移表，`isTransitionAllowed()` 校验函数
- **辅助函数**: `setMissionStatus()`、`deriveMissionStatus()`、`buildDefaultPlan()` 等

## 使用方式
状态机不直接调用，而是被其他模块引用：
- `import { MissionStatus, ALLOWED_TRANSITIONS, isTransitionAllowed } from './types.ts'`
- `import { setMissionStatus, deriveMissionStatus } from './mission-helpers.ts'`

## 当前限制
- `isTransitionAllowed()` 仅在 `task-add.ts` 中有 1 处显式调用，其他状态变更路径未强制校验
- `deriveMissionStatus()` 直接设置状态，不经过迁移校验

## 相关模块
- 所有模块都依赖状态机的类型定义
- watchdog、verifier、orchestrator 是主要的状态迁移触发方
```

#### `project-docs/file-system.md`

```markdown
# 文件系统

## 功能概述
提供 mission 工件目录的文件 I/O 操作，包括 mission.json 的读写（含 Zod 运行时校验）和 events.jsonl 审计日志追加。

## 核心能力
- **mission.json 读写**: `readMission()` / `writeMission()`，接入 Zod schema 校验
- **事件日志**: `appendEvent()` 追加 JSONL 格式审计事件
- **目录管理**: `ensureDir()` 创建目录、`listMissionIds()` 列出所有 mission
- **Zod 校验**: 读写时通过 `MissionSchema.safeParse()` 进行运行时校验

## 使用方式
```typescript
import { readMission, writeMission, appendEvent, listMissionIds } from './fs-utils.ts'
const mission = readMission(missionsDir, missionId)
writeMission(missionsDir, missionId, mission)
appendEvent(missionsDir, missionId, { type: 'status_change', ... })
```

## 当前限制
- Zod 校验为 warn 降级模式（safeParse 失败时仅 console.warn，不阻止操作）
- 无文件锁机制，并发写入可能产生数据竞争
- 无原子写入（非 write-temp-then-rename 模式）

## 相关模块
- 被所有需要读写 mission 数据的模块依赖
- schemas.ts 提供 Zod schema 定义
```

#### `project-docs/planner.md`

```markdown
# 计划器

## 功能概述
根据 mission 的 goal 生成任务拆解（tasks）和完成标准（completionCriteria），输出结构化计划。

## 核心能力
- **工作流类型推断**: `inferWorkstreamType()` 通过关键字匹配判断任务类型（serial/parallel-research/parallel-build）
- **任务生成**: 3 个内置模板，每个生成 3 个任务（context/execute/verify）
- **完成标准生成**: 自动为每个 mission 生成验收标准列表
- **计划文档输出**: 生成 plan.md 格式的可读计划文档
- **自定义任务支持**: 支持通过 `--tasks-json` 传入自定义任务列表

## 使用方式
```bash
npm run mission-plan -- --missions-dir ./missions --mission-id <id>
# 或传入自定义任务
npm run mission-plan -- --missions-dir ./missions --mission-id <id> --tasks-json '[...]'
```

## 当前限制
- 硬编码规则型实现，非 LLM 驱动
- 仅 3 个模板，无法根据 goal 语义智能拆解
- `inferWorkstreamType()` 基于正则匹配，覆盖面有限

## 相关模块
- 依赖: state-machine（类型定义）
- 被依赖: orchestrator（mission-start 调用 plan）
```

#### `project-docs/dispatcher.md`

```markdown
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
```

#### `project-docs/watchdog.md`

```markdown
# 看门狗

## 功能概述
定期扫描所有活跃 mission 的状态，评估每个 mission 的健康状况，输出推荐的下一步动作（不直接执行）。

## 核心能力
- **全量扫描**: 遍历所有非终态 mission
- **Task stall 检测**: 检测运行中任务是否超过阈值（默认 30 分钟）无进展
- **动作建议**: 输出 10 种动作类型（NONE/CHECK_BACKGROUND/RESUME_TASK/TRIGGER_VERIFY/RETRY_TASK/ITERATE/ESCALATE_STUCK/ESCALATE_MAX_RETRY/NOTIFY_COMPLETE/NOTIFY_ESCALATION）
- **Auto-verify 触发**: 当所有 task 到达终态时，自动建议 TRIGGER_VERIFY
- **Auto-collect**: stalled task 自动通过 git log 检测是否有新 commit

## 使用方式
```bash
npm run watchdog                    # 扫描并执行建议动作
npm run watchdog:dry-run            # 仅输出建议，不执行
npm run mission-run-action -- --missions-dir ./missions --mission-id <id> --action <ACTION>
```

## 当前限制
- 一次性命令行运行，非 daemon 模式，无内置定时循环
- 无 systemd timer 或 cron job 配置
- 保守策略：只建议不执行，需要 run-action 或 orchestrate 来执行

## 相关模块
- 依赖: state-machine, file-system
- 被依赖: orchestrator（循环调用 watchdog evaluate）
- 协作: mission-actions.ts 执行 watchdog 建议的动作
```

#### `project-docs/verifier.md`

```markdown
# 验证器

## 功能概述
根据 mission 的 completionCriteria 和结构化检查（测试命令、artifact 存在性）验收 mission 是否完成。

## 核心能力
- **完成标准评估**: 逐项检查 `completionCriteria` 中定义的验收条件
- **结构验证**: 检查 artifact 文件是否存在、测试命令是否通过
- **验证状态判定**: PASS（全部通过→COMPLETED）/ RETRYABLE_GAP（部分失败→ITERATING）/ CRITICAL_FAIL（关键失败→FAILED）
- **Plan 标准提取**: 从 plan.md 中解析自定义完成标准
- **验证报告生成**: 输出 verification.md 格式的验收报告

## 使用方式
```bash
npm run mission-verify -- --missions-dir ./missions --mission-id <id>
# dry-run 模式
npm run mission-verify -- --missions-dir ./missions --mission-id <id> --dry-run
```

## 当前限制
- 无 LLM 辅助判定，完全依赖规则匹配
- `test-command.txt` 通过 `bash -c` 执行用户输入的命令，存在安全风险
- 对"部分完成"的判定较为粗糙

## 相关模块
- 依赖: state-machine, file-system
- 被依赖: orchestrator, watchdog（TRIGGER_VERIFY 动作）
```

#### `project-docs/reconciler.md`

```markdown
# 回收器

## 功能概述
回收后台进程（backgroundProcesses）的执行结果，将已完成/失败/超时的进程结果回写到对应 task 的状态中。

## 核心能力
- **进程状态匹配**: 找到已到达终态（COMPLETED/FAILED/TIMEOUT）的 backgroundProcess
- **Task 状态回写**: 根据进程结果更新对应 task 的 status 和 resultSummary
- **Mission 状态推导**: 回收完成后重新计算 mission 整体状态

## 使用方式
```bash
npx tsx scripts/mission-reconcile-background.ts --missions-dir ./missions --mission-id <id>
```

## 当前限制
- `backgroundProcesses` 的 status 字段需要外部调用方更新，系统无法自动检测进程是否真正结束
- 只处理已标记为终态的进程，对仍在运行的进程不做处理

## 相关模块
- 依赖: state-machine, file-system
- 被依赖: orchestrator（CHECK_BACKGROUND 动作触发）
- 协作: dispatcher（派发时创建 backgroundProcesses 记录）
```

#### `project-docs/notification.md`

```markdown
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
```

#### `project-docs/orchestrator.md`

```markdown
# 编排器

## 功能概述
有限步自动推进器，循环执行「watchdog 评估 → 执行动作 → 派发新任务」直到到达终态或步数上限。

## 核心能力
- **多步推进**: `mission-orchestrate` 最多执行 `--max-steps` 步
- **组合启动**: `mission-start` 一键完成 create + plan + dispatch
- **Watchdog 循环**: 每步先调用 watchdog evaluate 获取建议动作，再执行
- **Auto-dispatch**: 检查并派发新解锁的 READY tasks

## 使用方式
```bash
# 组合启动
npm run mission-start -- --missions-dir ./missions --title "Title" --goal "Goal"

# 持续推进
npm run mission-orchestrate -- --missions-dir ./missions --mission-id <id> --max-steps 5
```

## 当前限制
- 非 daemon 模式，执行完 max-steps 步后退出
- 不支持 `--watch` 持续推进模式
- 外部 Agent 调用 task-update 触发的依赖解锁，要等下一次 watchdog 扫描才会被发现

## 相关模块
- 依赖: watchdog, dispatcher, verifier, file-system
- 被依赖: 用户/cron 直接调用
```

#### `project-docs/external-integration.md`

```markdown
# 外部集成

## 功能概述
封装与外部系统（OpenClaw CLI、Discord）的交互，包括 Agent session 管理、Discord 用户 ID 解析、Agent 发现。

## 核心能力
- **Agent session 管理**: `checkAgentSession()` / `createAgentSession()` 通过 OpenClaw CLI 管理 Agent 会话
- **Discord ID 解析**: `resolveDiscordId()` 查找 Agent 对应的 Discord 用户 ID
- **Agent 发现**: `discoverAgents()` 通过 OpenClaw CLI 获取可用 Agent 列表
- **安全命令执行**: `safeExec()` 防注入封装，返回结构化结果

## 使用方式
这些是内部 API，不直接调用：
```typescript
import { checkAgentSession } from './agent-session.ts'
import { resolveDiscordId } from './discord-id-resolver.ts'
import { safeExec } from './safe-exec.ts'
```

## 当前限制
- 所有 OpenClaw CLI 调用在测试环境不可用（openclaw 是外部二进制文件）
- `discord-id-resolver.ts` 硬编码了文件路径和 Agent 映射
- `discoverAgents()` 失败时降级为空列表，依赖静态 `DEFAULT_AGENT_TASK_MAP`

## 相关模块
- 被依赖: dispatcher, notification
```

#### `project-docs/dashboard.md`

```markdown
# 仪表盘

## 功能概述
将 mission 状态数据格式化为 Discord embed 格式，用于在 Discord 频道中展示 mission 进度面板。

## 核心能力
- **Embed 格式化**: 将 mission + tasks 数据转换为 Discord embed 结构
- **进度条**: 可视化任务完成百分比
- **状态 Emoji**: 为每种 task 状态分配对应 emoji
- **阶段分组**: 按 task phase 分组展示

## 使用方式
```typescript
import { formatDashboardEmbed } from './dashboard-formatter.ts'
const embed = formatDashboardEmbed(mission)
```

## 当前限制
- 无独立测试
- 仅支持 Discord embed 格式，不支持其他输出格式

## 相关模块
- 依赖: state-machine（类型定义）
```

---

## 步骤 3: 更新 CLAUDE.md

在 `CLAUDE.md` 文件末尾（`## Tech Stack` 段落之后）添加以下内容：

```markdown

## Development Doc Workflow (MANDATORY)

### 编码前 — 必须先创建开发文档

在对 `scripts/` 下的任何源文件进行功能开发、Bug 修复、重构之前，必须：

1. 确定变更所属模块（见 `dev-docs/` 下的模块目录）
2. 在 `dev-docs/<module>/` 下创建开发文档，命名格式 `YYYY-MM-DD-<slug>.md`
3. 在 `dev-docs/BACKLOG.md` 中添加该文档的索引条目
4. 开发文档必须包含：目标、涉及文件、方案、验收标准

**违反此规则直接开始编码是不允许的。** 如果收到开发指令但没有对应的开发文档，第一步永远是创建开发文档，而不是开始写代码。

### 编码后 — 必须更新文档索引

开发完成（代码 + 测试通过）后，必须：

1. 将开发文档状态改为「已完成」
2. 从 `dev-docs/BACKLOG.md` 移除该条目，添加到 `dev-docs/DONE.md`
3. 根据实际变更更新 `project-docs/<module>.md` 的功能说明

### 开发文档模板

```
# <开发任务标题>

> 模块: <module>
> 创建日期: YYYY-MM-DD
> 状态: 待开发 | 进行中 | 已完成
> 关联 Phase: P1/P2/P3

## 目标
<本次开发要解决什么问题>

## 涉及文件
- `scripts/lib/xxx.ts` — 修改点说明

## 方案
<技术方案描述>

## 验收标准
- [ ] 标准 1
- [ ] 标准 2

## 开发记录
### YYYY-MM-DD
- 实际做了什么
```

### 不适用的场景

以下操作无需创建开发文档：
- 纯文档修改（不涉及代码变更）
- 格式化、typo 修复等微小改动
- 配置文件调整（如 tsconfig.json、package.json）
```

---

## 步骤 4: 创建 Hook 脚本

### 4.1 创建 `.claude/hooks/check-dev-doc.sh`

```bash
#!/bin/bash
# Pre-tool hook: 编辑 scripts/ 下的 .ts 源文件时，
# 检查 dev-docs/BACKLOG.md 中是否有「进行中」的开发任务。

# 从 stdin 读取 tool input JSON
INPUT=$(cat)

# 提取被编辑的文件路径
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // empty')

# 只检查 scripts/lib/ 或 scripts/ 下的 .ts 文件（排除测试文件和类型声明）
if [[ "$FILE_PATH" == */scripts/*.ts ]] && [[ "$FILE_PATH" != *.test.ts ]] && [[ "$FILE_PATH" != *.d.ts ]]; then
  # 排除非代码文件的编辑（如 dev-docs、project-docs、docs 下的文件）
  if [[ "$FILE_PATH" == */dev-docs/* ]] || [[ "$FILE_PATH" == */project-docs/* ]] || [[ "$FILE_PATH" == */docs/* ]]; then
    exit 0
  fi

  if [ ! -f "dev-docs/BACKLOG.md" ]; then
    echo "BLOCKED: dev-docs/BACKLOG.md 不存在。请先按照 CLAUDE.md 中的 Development Doc Workflow 创建开发文档。"
    exit 1
  fi

  # 检查 BACKLOG 中是否有「进行中」的条目
  if ! grep -q "进行中" dev-docs/BACKLOG.md 2>/dev/null; then
    echo "BLOCKED: dev-docs/BACKLOG.md 中没有「进行中」的开发任务。"
    echo "请先在 dev-docs/<module>/ 下创建开发文档并在 BACKLOG.md 中将状态设为「进行中」。"
    echo "详见 CLAUDE.md \"Development Doc Workflow\" 章节。"
    exit 1
  fi
fi

exit 0
```

### 4.2 更新 `.claude/settings.local.json`

在现有内容中合并 hooks 配置。注意：当前文件仅有 `remote` 字段，需要添加 `hooks`：

```json
{
  "remote": {
    "defaultEnvironmentId": "env_011tN3uekvUMCB1bYECrMgbb"
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hook": "bash .claude/hooks/check-dev-doc.sh"
      }
    ]
  }
}
```

然后执行：
```bash
chmod +x .claude/hooks/check-dev-doc.sh
```

---

## 步骤 5: 更新 dispatch-messenger.ts

在 `scripts/lib/dispatch-messenger.ts` 的 `buildDispatchMessage()` 函数中，在 `return lines.join('\n')` 之前（约 L108-110 之间）添加文档规则提醒：

```typescript
  lines.push(
    '',
    '📋 **开发文档规则**：编码前必须先在 `dev-docs/<module>/` 下创建当日开发文档，',
    '并在 `BACKLOG.md` 中登记。完成后更新 `DONE.md` 和 `project-docs/`。',
    '详见 CLAUDE.md "Development Doc Workflow" 章节。',
  );
```

具体位置：在现有的 `如果任务失败...` 段落之后、`return lines.join('\n')` 之前。

---

## 步骤 6: 更新方案文档状态

将 `docs/proposal-doc-management.md` 的状态从「待审批」改为「已实施」：

```
> 状态: 已实施
```

---

## 步骤 7: Git Commit

```bash
git add dev-docs/ project-docs/ CLAUDE.md .claude/hooks/ .claude/settings.local.json \
        scripts/lib/dispatch-messenger.ts docs/proposal-doc-management.md \
        docs/plan-doc-management-implementation.md
git commit -m "feat: 文档管理体系 — dev-docs + project-docs + 三层强制执行

建立开发文档树（dev-docs/）和项目说明树（project-docs/），
实施三层强制执行机制：CLAUDE.md 指令、CC Hook 门禁、dispatch 消息嵌入。

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## 验证清单

实施完成后，检查以下项目：

- [ ] `dev-docs/README.md` 存在且包含模块目录表
- [ ] `dev-docs/BACKLOG.md` 和 `dev-docs/DONE.md` 存在
- [ ] 11 个模块目录各有 `README.md`
- [ ] `project-docs/README.md` 存在且包含模块索引
- [ ] 11 个模块说明文档 `project-docs/<module>.md` 存在
- [ ] `CLAUDE.md` 包含 "Development Doc Workflow (MANDATORY)" 段落
- [ ] `.claude/hooks/check-dev-doc.sh` 存在且可执行
- [ ] `.claude/settings.local.json` 包含 PreToolUse hook 配置
- [ ] `dispatch-messenger.ts` 包含开发文档规则提醒
- [ ] `npm test` 通过
- [ ] `npm run typecheck` 无新增错误
