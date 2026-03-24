# Mission Runner

基于 OpenClaw 的插件级自治任务编排层。将聊天式 Agent 提升为能持续推进长期任务的系统——mission 工件落盘、状态机驱动、watchdog 保守判断、verify 完成判定、群聊 @mention 协作。

## 快速开始

```bash
npm install
npm run typecheck
npm test               # 15 个测试全部通过
```

## 常用命令

```bash
# 创建并启动 mission（create + plan + dispatch 一步到位）
npm run mission-start -- --missions-dir ./missions \
  --title “Claude API 调研” --goal “调研最新功能并输出报告”

# 有限步推进（watchdog 判断 + 自动执行）
npm run mission-orchestrate -- --missions-dir ./missions \
  --mission-id <id> --max-steps 5

# 更新 task 状态（Agent 完成任务后汇报）
npm run task-update -- --missions-dir ./missions \
  --mission-id <id> --task-id <taskId> \
  --status COMPLETED --summary “完成摘要” --artifact artifacts/report.md

# 动态追加 task（运行中发现新问题）
npm run task-add -- --missions-dir ./missions \
  --mission-id <id> --task-id T5-deep-dive \
  --title “深入调研 Tool Use” --type research --depends-on T1

# 写入产物
npm run mission-write-artifact -- --missions-dir ./missions \
  --mission-id <id> --task-id <taskId> \
  --path artifacts/output.md --content “...”

# Watchdog 扫描（dry-run）
npm run watchdog:dry-run

# 单独执行动作
npm run mission-run-action -- --missions-dir ./missions \
  --mission-id <id> --action CHECK_BACKGROUND
```

## 完整使用示例

### 示例 1：串行任务流程

```bash
# 1. 创建并启动（自动 create → plan → dispatch T1）
MISSION_NOTIFICATION_ADAPTER=console \
npm run mission-start -- --missions-dir ./missions \
  --title “Claude API 调研” --goal “调研最新功能并输出报告”
# 输出: 📝 计划已生成 → 🚀 开始执行 → 📤 T1 已分发

# 2. T1 完成（自动解锁 T2 为 READY）
npm run task-update -- --missions-dir ./missions \
  --mission-id mission-20260324-001 --task-id task-context \
  --status COMPLETED --summary “已收集文档和 changelog”
# 输出: ✅ T1 完成

# 3. 分发 T2
npm run mission-dispatch -- --missions-dir ./missions \
  --mission-id mission-20260324-001

# 4. T2 完成（自动解锁 T3）
npm run task-update -- --mission-id mission-20260324-001 \
  --task-id task-execute --status COMPLETED --summary “整理完成” \
  --artifact artifacts/report.md

# 5. 分发 T3 → 完成 T3 → 自动进入 VERIFYING
# ...

# 6. 验证
npm run mission-verify -- --missions-dir ./missions \
  --mission-id mission-20260324-001
# 输出: ✅ 任务已完成 (COMPLETED)
```

### 示例 2：并发任务 + 动态追加

```bash
# 假设 mission 有 3 个并行 task（T1/T2/T3 无互相依赖）
# + 1 个汇总 task（T4 依赖 T1+T2+T3）

# 1. dispatch 一次性分发 T1/T2/T3
npm run mission-dispatch -- --mission-id <id>
# 输出: 📤 T1 已分发 + 📤 T2 已分发 + 📤 T3 已分发

# 2. T1 完成（T4 仍 PENDING，因为 T2/T3 未完成）
npm run task-update -- --task-id T1 --status COMPLETED --summary “...”

# 3. 运行中追加 T5（依赖 T1，自动变为 READY）
npm run task-add -- --mission-id <id> \
  --task-id T5 --title “深入调研” --depends-on T1

# 4. T2/T3 完成 → T4 自动解锁为 READY
npm run task-update -- --task-id T2 --status COMPLETED --summary “...”
npm run task-update -- --task-id T3 --status COMPLETED --summary “...”

# 5. dispatch T4 + T5 并行执行
npm run mission-dispatch -- --mission-id <id>
```

### 示例 3：在 OpenClaw 群聊中使用

```bash
# Orchestrator Agent 创建 mission（写入群聊信息和 @mention 标记）
MISSION_NOTIFICATION_ADAPTER=openclaw \
npm run mission-start -- --missions-dir ./missions \
  --title “Claude API 调研” --goal “调研最新功能” \
  --channel discord --chat-id 1234567890 \
  --user-mention-tag “<@user123>” \
  --orchestrator-agent-id orch-001 \
  --orchestrator-mention-tag “<@bot-orch>”

# 所有状态变更自动推送到群聊：
# 📝 计划已生成，T1 → @Researcher, T2 → @Analyst
# 📤 T1 已分发 @Researcher
# ✅ T1 完成 @Orchestrator
# ✅ 任务完成 @用户
```

## OpenClaw 集成配置

### 方式一：工作区自动加载（零配置）

```bash
# 将 mission-controller skill 链接到 Agent 工作区
ln -s /path/to/mission-runner/skills/mission-controller \
      <agent-workspace>/skills/mission-controller
```

OpenClaw 自动扫描 `workspace/skills/` 目录，无需修改 openclaw.json。

### 方式二：openclaw.json 显式配置

```json
{
  “agents”: {
    “list”: [
      {
        “id”: “orchestrator”,
        “name”: “任务总控”,
        “workspace”: “/path/to/workspace”,
        “skills”: [“mission-controller”],
        “subagents”: { “allowAgents”: [“researcher”, “analyst”] },
        “tools”: { “allow”: [“exec”, “read”, “process”, “message”, “subagents”] }
      },
      {
        “id”: “researcher”,
        “name”: “调研员”,
        “tools”: { “allow”: [“exec”, “read”, “process”, “message”] }
      }
    ]
  },
  “bindings”: [
    { “agentId”: “orchestrator”, “match”: { “channel”: “discord”, “accountId”: “discord-project” } }
  ]
}
```

### Agent System Prompt 配置

**Orchestrator** 的 CLAUDE.md 需包含：
- 如何调用 `mission-start` 创建任务
- 收到 @mention 后如何 `mission-dispatch` / `task-add` / `mission-orchestrate`
- 环境变量 `MISSION_NOTIFICATION_ADAPTER=openclaw`

**Worker Agent** 的 CLAUDE.md 需包含：
- 如何调用 `task-update` 汇报完成/失败
- 如何调用 `mission-write-artifact` 写入产物
- 发现新问题时 @Orchestrator 说明

## 通知推送

每次状态变更自动推送 human-readable 消息到群聊，通过 @mention 路由到目标 Agent/用户。

### 通知适配器

通过环境变量 `MISSION_NOTIFICATION_ADAPTER` 选择：

| 适配器 | 行为 | 场景 |
|--------|------|------|
| `console`（默认） | 输出到 stderr | 本地开发/调试 |
| `fake` | 静默 | 测试 |
| `discord` | 记录 Discord 元数据 | 保留兼容 |
| `openclaw` | 调用 `openclaw message send` → 群聊 | **生产环境** |

### 通知消息格式

| 状态变更 | 消息 | @mention |
|---------|------|----------|
| → PLANNED | 📝 计划已生成，共 N 个子任务 | — |
| → RUNNING | 🚀 任务开始执行 | — |
| task 分发 | 📤 子任务已分配 @Agent | @被分配的 Agent |
| task 完成 | ✅ 子任务已完成 | @Orchestrator |
| task 失败 | ❌ 子任务失败 | @Orchestrator |
| → VERIFYING | 🔍 进入验证阶段 | — |
| → COMPLETED | ✅ 任务已完成 | @用户 |
| → FAILED | ❌ 任务已失败 | @用户 |
| → ESCALATED | ⚠️ 需要人工介入 | @用户 |

### 幂等性

同一状态转换只通知一次，通过 `mission.flags.notifiedTransitions` 去重。迭代轮次通过 key 中的 `iter=N` 区分。

## 架构

### 状态机

```
create → plan → dispatch → RUNNING
                              ↓
              WAITING_BACKGROUND → reconcile → VERIFYING
                                                  ↓
                                        COMPLETED / ITERATING / FAILED
```

恢复侧链：`ITERATING / WAITING_EXTERNAL → resume → RUNNING`

### 依赖自动解锁

当 task 完成（COMPLETED/SKIPPED）时，自动扫描下游 PENDING tasks，依赖全部满足则提升为 READY。

### Mission 工件目录

```
missions/<mission-id>/
├── mission.json      # 核心状态
├── plan.md           # 任务计划
├── verification.md   # 验证结果
├── events.jsonl      # 审计事件流
└── artifacts/        # 产物目录
```

## 核心脚本

| 脚本 | 职责 |
|------|------|
| `mission-start.ts` | 创建并启动（create + plan + dispatch） |
| `mission-create.ts` | 创建 mission 目录和初始状态 |
| `mission-plan.ts` | 生成任务计划（含 Agent 发现和分配） |
| `mission-dispatch.ts` | 消费 READY task 并派发 |
| `task-update.ts` | 更新 task 状态 + 自动解锁下游依赖 |
| `task-add.ts` | 运行中动态追加 task |
| `mission-resume.ts` | 恢复失败/等待中的任务 |
| `mission-verify.ts` | 按完成标准验收 |
| `mission-orchestrate.ts` | 有限步自动推进 |
| `mission-run-action.ts` | 执行 watchdog 建议的动作 |
| `mission-watchdog.ts` | 扫描状态并输出下一步建议 |
| `mission-reconcile-background.ts` | 回收后台任务结果 |
| `mission-write-artifact.ts` | 写入产物文件 |
