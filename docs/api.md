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
interface MissionOwner {
  sessionKey: string;
  channel?: 'discord' | 'slack' | 'cli' | 'web' | 'api';
  chatId?: string;
  requestMessageId?: string;
  userMentionTag?: string;
}

interface CompletionCriterion {
  id: string;
  description: string;
  required?: boolean;
  verified?: boolean;
}

interface MissionArtifact {
  path: string;
  type: 'document' | 'code' | 'data' | 'image' | 'log' | 'summary';
  description?: string;
  generatedAt?: string;
}

interface RiskPolicy {
  autoAllowed?: string[];    // 自动允许的工具/操作列表
  askOnce?: string[];        // 首次询问后续允许的操作列表
  mustConfirm?: string[];    // 每次必须确认的高风险操作列表
}

interface BackgroundProcess {
  processId: string;
  taskId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT';
  startedAt: string;
  endedAt?: string | null;
  outputPath?: string | null;
}

interface ActiveSession {
  sessionKey: string;
  agentType?: string;
  startedAt?: string;
  purpose?: string;
}

interface VerificationCriterionResult {
  criterionId: string;
  passed: boolean;
  reason?: string | null;
}

interface Verification {
  status: VerificationStatus;
  lastCheckedAt?: string | null;
  gaps?: string[];
  summary?: string | null;
  criteriaResults?: VerificationCriterionResult[];
}

interface Escalation {
  level?: 'INFO' | 'WARNING' | 'CRITICAL' | null;
  reason?: string | null;
  escalatedAt?: string | null;
}

interface MissionFlags {
  notifiedStart?: boolean;
  notifiedComplete?: boolean;
  notifiedEscalation?: boolean;
  userUpdated?: boolean;
  notifiedTransitions?: Record<string, boolean>;
}

interface Mission {
  missionId: string;
  title: string;
  goal: string;
  status: MissionStatus;
  owner?: MissionOwner;           // 可选
  createdAt: string;
  updatedAt: string;
  lastProgressAt?: string;
  nextWakeAt?: string | null;
  currentIteration?: number;
  maxIterations?: number;
  completionCriteria?: CompletionCriterion[];   // 对象数组，非字符串数组
  riskPolicy?: RiskPolicy;
  tasks?: Task[];
  artifacts?: MissionArtifact[];               // 对象数组，非字符串数组
  backgroundProcesses?: BackgroundProcess[];
  activeSessions?: ActiveSession[];
  verification?: Verification;
  escalation?: Escalation;
  flags?: MissionFlags;
  metadata?: Record<string, unknown>;
}
```

### Task 结构

```typescript
interface TaskArtifact {
  path: string;
  type: string;
  description?: string;
}

interface Task {
  taskId: string;
  title: string;
  description?: string;
  type: TaskType;
  status: TaskStatus;
  agent?: string | null;
  sessionKey?: string | null;
  dependsOn?: string[];
  priority?: number;
  createdAt?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  estimatedDuration?: number | null;
  timeout?: number | null;
  resultSummary?: string | null;
  artifacts?: TaskArtifact[];         // 对象数组，非字符串数组
  retryCount?: number;
  maxRetries?: number;
  lastError?: string | null;
  backgroundProcessId?: string | null;
  phase?: string;                     // 展示层分组标签
  fileBoundary?: string[];            // 允许修改的文件/目录范围
  config?: Record<string, unknown>;
}
```

---

## Watchdog 类型

### WatchdogCheckResult

```typescript
interface WatchdogCheckResult {
  missionId: string;
  currentStatus: MissionStatus;
  action: MissionAction;
  reason: string;
  suggestedNextWakeAt?: string;   // 建议的下次检查时间
  relatedTaskIds?: string[];       // 相关任务 IDs
  context?: Record<string, unknown>;
}
```

### WatchdogConfig

```typescript
interface WatchdogConfig {
  missionsDir: string;
  taskTimeoutMs: number;                // 任务超时阈值（毫秒），默认 5 分钟
  backgroundCheckIntervalMs: number;    // 后台进程检查间隔（毫秒），默认 30 秒
  maxIdleTimeMs: number;                // 最大允许空转时间（毫秒），默认 10 分钟
  taskStallThresholdMs?: number;        // 单 task 停滞超时（毫秒），默认 30 分钟
  dryRun: boolean;
  verbose: boolean;
}
```

### Watchdog 动作类型（MissionAction）

| 动作 | 触发条件 | 说明 |
|------|---------|------|
| `NONE` | 无需操作 | 延后 nextWakeAt |
| `CHECK_BACKGROUND` | 后台进程待检查 | 调用 reconcile-background |
| `COLLECT_RESULTS` | 后台结果可回收 | 回收后台进程结果 |
| `RESUME_TASK` | 到达 nextWakeAt | 恢复执行 |
| `TRIGGER_VERIFY` | 所有 task 终态 | 触发验证 |
| `RETRY_TASK` | idle 超时 + 重试预算未耗尽 | 重试 |
| `ITERATE` | 验证有 gap | 补缺迭代 |
| `ESCALATE_STUCK` | 长时间无进展 | 升级 |
| `ESCALATE_MAX_RETRY` | 重试耗尽 | 升级 |
| `NOTIFY_COMPLETE` | 验证通过 | 通知完成 |
| `NOTIFY_ESCALATION` | 需人工介入 | 通知升级 |
