# Mission Runner API / 脚本接口文档

> 版本：2026-04-02

## CLI 脚本一览

所有脚本通过 `npm run <script-name>` 或 `node --import tsx scripts/<script>.ts` 调用。

| 脚本 | npm 命令 | 职责 |
|------|----------|------|
| `mission-start.ts` | `mission-start` | 创建并启动（create + plan + dispatch） |
| `mission-create.ts` | `create-mission` | 创建 mission 目录和初始状态 |
| `mission-plan.ts` | `mission-plan` | 生成任务计划（含 Agent 发现和分配） |
| `mission-dispatch.ts` | `mission-dispatch` | 消费 READY task 并派发 |
| `task-update.ts` | `task-update` | 更新 task 状态 + 自动解锁下游依赖 |
| `task-add.ts` | `task-add` | 运行中动态追加 task |
| `mission-resume.ts` | — | 恢复失败/等待中的任务 |
| `mission-verify.ts` | `verify-mission` | 按完成标准验收 |
| `mission-orchestrate.ts` | `mission-orchestrate` | 有限步自动推进 |
| `mission-run-action.ts` | `mission-run-action` | 执行 watchdog 建议的动作 |
| `mission-watchdog.ts` | `watchdog` / `watchdog:dry-run` | 扫描状态并输出下一步建议 |
| `mission-reconcile-background.ts` | — | 回收后台任务结果 |
| `mission-write-artifact.ts` | `mission-write-artifact` | 写入产物文件 |
| `mission-list.ts` | — | 列表展示（Dashboard） |

---

## 脚本详细参数

### mission-start

一键完成 create → plan → dispatch。

```bash
npm run mission-start -- --missions-dir ./missions \
  --title "任务标题" --goal "任务目标" \
  [--channel discord] [--chat-id <id>] \
  [--user-mention-tag "<@user>"] \
  [--orchestrator-agent-id <id>] \
  [--orchestrator-mention-tag "<@bot>"]
```

### mission-create

```bash
npm run create-mission -- --title "标题" --goal "目标" [--owner <json>]
```

### mission-plan

```bash
npm run mission-plan -- --mission-id <id> [--missions-dir ./missions]
```

### mission-dispatch

```bash
npm run mission-dispatch -- --mission-id <id> [--missions-dir ./missions] [--auto-spawn]
```

### task-update

```bash
npm run task-update -- --missions-dir ./missions \
  --mission-id <id> --task-id <taskId> \
  --status COMPLETED --summary "完成摘要" \
  [--artifact artifacts/report.md]
```

### task-add

```bash
npm run task-add -- --missions-dir ./missions \
  --mission-id <id> --task-id <taskId> \
  --title "任务标题" --type research \
  [--depends-on T1]
```

### mission-verify

```bash
npm run verify-mission -- --missions-dir ./missions --mission-id <id>
```

### mission-orchestrate

```bash
npm run mission-orchestrate -- --missions-dir ./missions \
  --mission-id <id> --max-steps 5
```

### mission-run-action

```bash
npm run mission-run-action -- --missions-dir ./missions \
  --mission-id <id> --action CHECK_BACKGROUND
```

### mission-watchdog

```bash
npm run watchdog              # 正常模式
npm run watchdog:dry-run      # 只输出建议，不写回状态
```

CLI 参数：
- `--missions-dir <path>`
- `--dry-run`
- `--verbose`
- `--task-timeout-ms <n>`
- `--background-check-interval-ms <n>`
- `--max-idle-ms <n>`

### mission-write-artifact

```bash
npm run mission-write-artifact -- --missions-dir ./missions \
  --mission-id <id> --task-id <taskId> \
  --path artifacts/output.md --content "..."
```

---

## 通知适配器

通过环境变量 `MISSION_NOTIFICATION_ADAPTER` 选择：

| 值 | 行为 | 场景 |
|----|------|------|
| `console`（默认） | 输出到 stderr | 本地开发/调试 |
| `fake` | 静默 | 测试 |
| `discord` | 记录 Discord 元数据 | 保留兼容 |
| `openclaw` | `openclaw message send` → 群聊 | **生产环境** |

---

## 插件配置

### openclaw.plugin.json

```json
{
  "name": "mission-runner",
  "version": "0.1.0",
  "missionsDir": "./missions"
}
```

### OpenClaw 集成

**方式一：工作区自动加载**

```bash
ln -s /path/to/mission-runner/skills/mission-controller \
      <agent-workspace>/skills/mission-controller
```

**方式二：openclaw.json 显式配置**

```json
{
  "agents": {
    "list": [
      {
        "id": "orchestrator",
        "skills": ["mission-controller"],
        "subagents": { "allowAgents": ["researcher", "analyst"] }
      }
    ]
  }
}
```

---

## Mission 数据结构

### mission.json 核心字段

```typescript
interface Mission {
  missionId: string;
  title: string;
  goal: string;
  status: MissionStatus;
  owner: MissionOwner;
  createdAt: string;
  updatedAt: string;
  lastProgressAt: string;
  nextWakeAt: string | null;
  currentIteration: number;
  maxIterations: number;
  completionCriteria: string[];
  tasks: Task[];
  artifacts: string[];
  backgroundProcesses: BackgroundProcess[];
  verification: VerificationState;
  flags: MissionFlags;
  metadata?: Record<string, unknown>;
}
```

### Task 结构

```typescript
interface Task {
  taskId: string;
  title: string;
  type: string;
  status: TaskStatus;
  agent?: string;
  dependsOn: string[];
  config?: Record<string, unknown>;
  artifacts: string[];
  retryCount: number;
  maxRetries: number;
  lastError?: string;
}
```

---

## Watchdog 动作类型

| 动作 | 触发条件 | 说明 |
|------|---------|------|
| `NONE` | 无需操作 | 延后 nextWakeAt |
| `CHECK_BACKGROUND` | 后台进程待检查 | 调用 reconcile-background |
| `RESUME_TASK` | 到达 nextWakeAt | 恢复执行 |
| `TRIGGER_VERIFY` | 所有 task 终态 | 触发验证 |
| `RETRY_TASK` | idle 超时 + 重试预算未耗尽 | 重试 |
| `ITERATE` | 验证有 gap | 补缺迭代 |
| `ESCALATE_STUCK` | 长时间无进展 | 升级 |
| `ESCALATE_MAX_RETRY` | 重试耗尽 | 升级 |
| `NOTIFY_COMPLETE` | 验证通过 | 通知完成 |
| `NOTIFY_ESCALATION` | 需人工介入 | 通知升级 |
