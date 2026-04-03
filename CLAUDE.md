# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mission Runner 是一个基于 OpenClaw 的插件级自治任务编排层。它将聊天式 Agent 提升为能持续推进长期任务的系统——mission 工件落盘、状态机驱动、watchdog 保守判断、verify 完成判定。

## Common Commands

```bash
npm run typecheck          # TypeScript 类型检查
npm test                   # 运行所有测试 (node --test scripts/*.test.ts)
npm run mission-start -- --missions-dir ./missions --title "Title" --goal "Goal"
npm run mission-orchestrate -- --missions-dir ./missions --mission-id <id> --max-steps 5
npm run mission-run-action -- --missions-dir ./missions --mission-id <id> --action <ACTION>
npm run watchdog           # 扫描所有 mission
npm run watchdog:dry-run   # dry-run 模式，不写回状态
```

通知适配器通过环境变量选择：`MISSION_NOTIFICATION_ADAPTER=console|fake|discord`

## Architecture

### 核心流程

```
create -> plan -> dispatch -> WAITING_BACKGROUND -> reconcile-background -> run-action -> VERIFYING -> verify -> COMPLETED
```

恢复侧链：`ITERATING/WAITING_EXTERNAL -> resume -> READY/RUNNING`

### 模块结构

- **`scripts/lib/types.ts`** — 核心类型定义、状态枚举、状态迁移规则（`ALLOWED_TRANSITIONS`）。所有状态语义的单一事实源。
- **`scripts/lib/fs-utils.ts`** — mission 工件目录的文件 I/O（mission.json 读写、events.jsonl 追加）
- **`scripts/lib/mission-helpers.ts`** — mission 操作辅助函数
- **`scripts/lib/mission-commit.ts`** — 集中式状态提交 + 变更检测 + 通知触发
- **`scripts/lib/mission-dispatcher.ts`** — 任务就绪检查、派发结果应用、摘要构建
- **`scripts/lib/mission-dispatch-agent.ts`** — 三级回退 Agent 派发（L1→L2→L3）
- **`scripts/lib/dispatch-queue.ts`** — L3 回退：将派发条目写入磁盘队列
- **`scripts/lib/dispatch-messenger.ts`** — 在群聊中 @mention Agent 发送任务派发消息
- **`scripts/lib/agent-session.ts`** — Agent session 检查与创建
- **`scripts/lib/safe-exec.ts`** — 安全 CLI 命令执行封装（防注入，返回结构化结果）
- **`scripts/lib/discord-id-resolver.ts`** — Discord bot 用户 ID 解析
- **`scripts/lib/mission-planner.ts`** — 计划生成逻辑
- **`scripts/lib/mission-verifier.ts`** — 验收逻辑（标准评估、结构验证）
- **`scripts/lib/mission-actions.ts`** — run-action 的 action handler（重试、升级）
- **`scripts/lib/mission-watchdog-evaluator.ts`** — watchdog 核心评估逻辑
- **`scripts/lib/mission-notification.ts`** — 通知 sender/adapter 结构（console/fake/discord/openclaw）
- **`scripts/lib/dashboard-formatter.ts`** — Dashboard Discord embed 格式化
- **`schemas/*.schema.json`** — mission/task/verification 的 JSON Schema 契约

### 关键脚本

| 脚本 | 职责 |
|------|------|
| `mission-create.ts` | 创建 mission 目录，初始化 mission.json |
| `mission-plan.ts` | 调用 planner 生成任务拆解和完成标准 |
| `mission-dispatch.ts` | 消费 READY task，派发执行 |
| `mission-resume.ts` | 恢复失败/等待中的任务 |
| `mission-watchdog.ts` / `mission-watchdog-lib.ts` | 扫描 mission 状态，输出下一步动作建议 |
| `mission-reconcile-background.ts` | 回收后台进程结果，回写 task 状态 |
| `mission-run-action.ts` | 执行 watchdog 建议的 action |
| `mission-verify.ts` | 按 completionCriteria 验收 |
| `mission-orchestrate.ts` | 有限步 runner，连续推进多个动作 |
| `mission-start.ts` | 创建并启动 mission 的组合入口 |
| `mission-write-artifact.ts` | 写入 mission 产物 |
| `task-update.ts` | 更新单个 task 状态 |

### Mission 状态机

终态：`COMPLETED`, `FAILED`, `ESCALATED`（watchdog 跳过）

活跃态：`CREATED`, `PLANNED`, `RUNNING`, `WAITING_BACKGROUND`, `WAITING_EXTERNAL`, `VERIFYING`, `ITERATING`, `BLOCKED_HIGH_RISK`

状态迁移必须通过 `isTransitionAllowed()` 校验，合法迁移定义在 `ALLOWED_TRANSITIONS`。

### Watchdog 动作类型

`NONE | CHECK_BACKGROUND | RESUME_TASK | TRIGGER_VERIFY | RETRY_TASK | ITERATE | ESCALATE_STUCK | ESCALATE_MAX_RETRY | NOTIFY_COMPLETE | NOTIFY_ESCALATION`

### Mission 工件目录

```
missions/<mission-id>/
├── mission.json      # 核心状态（必须存在）
├── plan.md
├── run-log.md
├── verification.md
├── events.jsonl      # 审计事件流
└── artifacts/
```

## Design Principles

- **状态与 schema 一致性**：`schemas/*.schema.json` 的状态枚举必须与 `types.ts` 中的 `MissionStatus` 保持同步
- **watchdog 保守**：只输出建议，不直接执行复杂副作用或调用外部 API
- **幂等与 no-op**：重复执行不产生假进展，no-op 不污染审计事件和 progress 时间戳
- **工件落盘可恢复**：所有状态持久化到文件系统，中断后可恢复
- **verify 是完成判定入口**：watchdog 负责推进到 verify，verify 才真正判定完成

## Tech Stack

- TypeScript (ES2022, ESM)
- Node.js >= 18, tsx 运行 `.ts` 脚本
- node:test 内置测试框架
- Zod (运行时校验，尚未全面接入)
- 无构建即可运行（tsx 直接执行）
