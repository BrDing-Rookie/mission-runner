# Mission Runner 架构文档

> 版本：2026-03-31 | 代码规模：25 源文件 / ~6200 行

## 模块概览

```
scripts/
├── lib/                        # 核心库
│   ├── types.ts               # 类型定义 (294 行)
│   ├── fs-utils.ts            # 文件系统工具 (206 行)
│   ├── mission-helpers.ts     # Mission 辅助函数 (88 行)
│   ├── mission-commit.ts      # 状态提交 + 通知触发 (191 行)
│   ├── mission-dispatch-agent.ts # Agent 派发 L1/L2/L3 (383 行)
│   ├── mission-notification.ts     # 通知系统核心 (204 行)
│   ├── mission-notification-templates.ts # 消息模板 (123 行)
│   ├── mission-notification-mentions.ts  # Mention 解析 (53 行)
│   ├── mission-agent-discovery.ts  # Agent 发现 (92 行)
│   └── shell-utils.ts         # Shell 安全工具 (10 行)
├── mission-*.ts               # CLI 入口脚本
├── task-*.ts                  # 任务操作脚本
```

## 核心流程

用户指令 → mission-create → mission-plan → mission-dispatch → Agent 执行 → task-update → mission-verify → COMPLETED

## 派发模块 (mission-dispatch-agent.ts)

| 级别 | 机制 | CLI 命令 |
|------|------|----------|
| L1 | 检查 session + @mention | `openclaw sessions --agent <id>` |
| L2 | 创建 session + @mention | `openclaw agent --agent <id> --message` |
| L3 | 写 dispatch queue | 文件 I/O |

## 状态机

CREATED → PLANNED → RUNNING → VERIFYING → COMPLETED
                → WAITING_BACKGROUND → RUNNING
                → ITERATING → RUNNING
                → FAILED / ESCALATED
