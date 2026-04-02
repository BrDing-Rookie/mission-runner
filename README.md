# Mission Runner

基于 OpenClaw 的插件级自治任务编排层。将聊天式 Agent 提升为能持续推进长期任务的系统——mission 工件落盘、状态机驱动、watchdog 保守判断、verify 完成判定、群聊 @mention 协作。

## 快速开始

```bash
npm install
npm run typecheck
npm test
```

## 核心用法

```bash
# 创建并启动 mission（create + plan + dispatch 一步到位）
npm run mission-start -- --missions-dir ./missions \
  --title "Claude API 调研" --goal "调研最新功能并输出报告"

# 有限步推进（watchdog 判断 + 自动执行）
npm run mission-orchestrate -- --missions-dir ./missions \
  --mission-id <id> --max-steps 5

# 更新 task 状态
npm run task-update -- --missions-dir ./missions \
  --mission-id <id> --task-id <taskId> \
  --status COMPLETED --summary "完成摘要" --artifact artifacts/report.md

# 动态追加 task
npm run task-add -- --missions-dir ./missions \
  --mission-id <id> --task-id T5 \
  --title "深入调研 Tool Use" --type research --depends-on T1

# Watchdog 扫描（dry-run）
npm run watchdog:dry-run
```

## 架构

```
create → plan → dispatch → RUNNING → VERIFYING → COMPLETED
                              ↓
              WAITING_BACKGROUND → reconcile → VERIFYING
```

恢复侧链：`ITERATING / WAITING_EXTERNAL → resume → RUNNING`

### Mission 工件目录

```
missions/<mission-id>/
├── mission.json      # 核心状态
├── plan.md           # 任务计划
├── verification.md   # 验证结果
├── events.jsonl      # 审计事件流
└── artifacts/        # 产物目录
```

### 核心脚本

| 脚本 | 职责 |
|------|------|
| `mission-start.ts` | 创建并启动（create + plan + dispatch） |
| `mission-plan.ts` | 生成任务计划（含 Agent 发现和分配） |
| `mission-dispatch.ts` | 消费 READY task 并派发 |
| `task-update.ts` | 更新 task 状态 + 自动解锁下游依赖 |
| `mission-verify.ts` | 按完成标准验收 |
| `mission-orchestrate.ts` | 有限步自动推进 |
| `mission-watchdog.ts` | 扫描状态并输出下一步建议 |

## 通知推送

通过环境变量 `MISSION_NOTIFICATION_ADAPTER` 选择适配器：

| 适配器 | 场景 |
|--------|------|
| `console`（默认） | 本地开发/调试 |
| `fake` | 测试 |
| `openclaw` | **生产环境**（发到群聊） |

## OpenClaw 集成

```bash
# 工作区自动加载（零配置）
ln -s /path/to/mission-runner/skills/mission-controller \
      <agent-workspace>/skills/mission-controller
```

## 文档

| 文档 | 内容 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 架构设计、状态机、模块职责、数据流 |
| [docs/api.md](docs/api.md) | 脚本接口、参数详解、数据结构 |
| [docs/development.md](docs/development.md) | 开发指南、技术栈、规范 |
| [docs/archive/](docs/archive/) | 历史文档（项目介绍、迭代计划、交接说明等） |
