---
name: mission-controller
description: '自治任务编排核心技能。协调 planner、verifier、recovery 形成 mission 生命周期闭环。用于创建、规划、派发、监控、验证和恢复长期任务。触发时机：需要自治任务编排、mission 管理、长期任务推进时使用。'
metadata:
  {
    "openclaw": { "emoji": "🎯", "requires": { "anyBins": ["node", "tsx"] } },
  }
---

# Skill: mission-controller

自治任务编排核心技能 —— 协调 planner、verifier、recovery 形成执行闭环。

---

## 概述

`mission-controller` 是 Mission Runner 插件的核心技能，负责：

1. **规划（Planning）**：将用户目标拆解为可执行子任务
2. **派发（Dispatch）**：三级回退策略派发（L1 群聊 @mention → L2 创建 session 后 @mention → L3 dispatch queue 兜底），无 agent 任务走 background/cron 路径
3. **看守（Watchdog）**：监控执行进度，处理 stuck/恢复/重试
4. **验证（Verification）**：按完成标准验收，识别伪完成
5. **恢复（Recovery）**：决策下一步行动（重试/迭代/升级）

---

## 触发方式

### 由脚本显式调用

此技能不直接响应用户消息，而是由以下脚本在适当时机调用：

| 调用方 | 触发时机 | 使用模板 |
|--------|----------|----------|
| `mission-plan.ts` | 创建 mission 后 | `planner.md` |
| `mission-verify.ts` | 子任务完成后 | `verifier.md` |
| `mission-watchdog.ts` | 检测到异常需决策 | `recovery.md` |

### 调用约定

```typescript
// 调用 controller 的通用接口
interface MissionControllerInput {
  phase: 'plan' | 'verify' | 'recover';
  missionId: string;
  mission: Mission;           // 当前 mission.json 内容
  context: {
    plan?: string;            // plan.md 内容
    runLog?: string;          // run-log.md 内容
    artifacts?: string[];     // 产物列表
    lastError?: string;       // 最近错误（recover 时）
  };
}

// Controller 输出
interface MissionControllerOutput {
  decision: string;           // 决策摘要
  actions: ControllerAction[];
  updatedMission?: Partial<Mission>;
}

type ControllerAction =
  | { type: 'create_tasks'; tasks: Task[] }
  | { type: 'update_status'; status: MissionStatus }
  | { type: 'request_artifact'; path: string }
  | { type: 'escalate'; reason: string }
  | { type: 'notify'; message: string };
```

---

## 模板体系

### 1. planner.md —— 任务规划

**用途**：生成初始执行计划

**输入**：
- 用户 goal（原始任务描述）
- 可用工具/Agent 能力列表
- 任务类型上下文

**输出**：
- 任务目标（一句话）
- 子任务列表（1~3 个，MVP 限制）
- 每个子任务的完成标准
- 风险分级建议
- 升级条件

**关键约束**：
- MVP 阶段限制子任务数量为 1~3 个
- 必须明确定义 `completionCriteria`
- 必须标注哪些任务需要后台执行

详见：`templates/planner.md`

---

### 2. verifier.md —— 完成验证

**用途**：判断任务是否真正完成

**输入**：
- 原始 goal 和 completionCriteria
- plan.md 和实际产物
- run-log.md 执行记录
- 各子任务结果

**输出判定**：
| 结果 | 含义 | 后续动作 |
|------|------|----------|
| `PASS` | 所有标准满足 | 进入 COMPLETED，发送通知 |
| `RETRYABLE_GAP` | 接近完成，可补缺 | 新增任务，进入 ITERATING |
| `NONRETRYABLE_FAILURE` | 核心前提失败 | 进入 FAILED |
| `NEEDS_HUMAN_DECISION` | 需路线选择或风险确认 | 进入 ESCALATED |

**伪完成检测清单**：
- [ ] 产物存在且可引用
- [ ] 所有 completion criteria 有对应证据
- [ ] 关键中间步骤有记录
- [ ] 无明显矛盾或遗漏

详见：`templates/verifier.md`

---

### 3. recovery.md —— 恢复决策

**用途**：异常情况下决策下一步

**触发场景**：
- Watchdog 检测到任务 stuck
- Background process 失败
- 子任务 retry 耗尽
- 外部依赖超时

**决策树**：

```
检测到异常
    │
    ├─> 有明确恢复路径？
    │       ├─> YES ──> 重试/续跑
    │       └─> NO
    │               │
    │               ├─> 可降级？──> 降级执行
    │               │
    │               ├─> 需人工决策？──> ESCALATED
    │               │
    │               └─> 不可恢复？──> FAILED
    │
    └─> 达到迭代上限？──> ESCALATED
```

**输出**：
- 决策类型（retry/resume/iterate/escalate/fail）
- 理由说明
- 建议的下一步动作
- 如需升级，说明需要用户决策的内容

详见：`templates/recovery.md`

---

## 闭环流程

```
┌─────────────────────────────────────────────────────────────┐
│                        USER GOAL                            │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  PLANNER  │  拆解任务、定义完成标准、识别风险               │
│           │  输出: plan.md, tasks[], completionCriteria    │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  DISPATCH │  三级回退派发（L1 @mention → L2 session+@ → L3 queue）│
│           │  无 agent 任务走 background/cron 路径                │
└───────────────────────────┬─────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
        [session]    [background]    [cron]
              │             │             │
              └─────────────┴─────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  WATCHDOG │  监控进度、检测 stuck、回收 background 结果    │
│           │  触发: verify / retry / resume / escalate      │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  VERIFIER │  按 completionCriteria 验收                    │
│           │  判定: PASS / RETRYABLE_GAP / FAIL / ESCALATE  │
└───────────────────────────┬─────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
        [PASS]                      [RETRYABLE_GAP]
              │                           │
              ▼                           ▼
        ┌─────────┐              ┌─────────────────┐
        │ COMPLETED│◄────────────│  RECOVERY       │
        │ NOTIFY   │             │  新增任务       │
        └─────────┘              │  ITERATING ─────┘
                                 │
                                 └─> ESCALATED / FAILED
```

---

## 使用示例

### 场景 1：规划阶段

```typescript
// 在 mission-plan.ts 中
const result = await skill('mission-controller', {
  phase: 'plan',
  missionId: 'mission-20260318-001',
  mission: { goal: '调研 Claude API 最新功能并输出摘要', ... },
  context: {
    availableTools: ['web_search', 'web_fetch', 'file_write'],
    availableAgents: ['researcher', 'analyst']
  }
});

// result.decision: "生成 3 个子任务"
// result.actions: [
//   { type: 'create_tasks', tasks: [...] },
//   { type: 'update_status', status: 'PLANNED' }
// ]
```

### 场景 2：验证阶段

```typescript
// 在 mission-verify.ts 中
const result = await skill('mission-controller', {
  phase: 'verify',
  missionId: 'mission-20260318-001',
  mission: currentMission,
  context: {
    plan: readFile('missions/xxx/plan.md'),
    runLog: readFile('missions/xxx/run-log.md'),
    artifacts: listArtifacts('missions/xxx/artifacts/')
  }
});

// result.decision: "RETRYABLE_GAP"
// result.actions: [
//   { type: 'create_tasks', tasks: [{
//     title: '补充来源校验',
//     type: 'verification'
//   }]}
// ]
```

### 场景 3：恢复决策

```typescript
// 在 mission-watchdog.ts 中检测到 stuck
const result = await skill('mission-controller', {
  phase: 'recover',
  missionId: 'mission-20260318-001',
  mission: currentMission,
  context: {
    lastError: 'Background process timeout after 300s',
    stuckDuration: 600
  }
});

// result.decision: "resume_with_retry"
// result.actions: [
//   { type: 'update_status', status: 'RUNNING' },
//   { type: 'notify', message: '任务恢复执行，第 2 次重试' }
// ]
```

---

## 约束与边界

### MVP 约束

1. **子任务数量**：单个 mission 最多 3 个子任务
2. **迭代次数**：最多 3 轮迭代（`maxIterations: 3`）
3. **Retry 次数**：单任务最多 2 次重试（`maxRetries: 2`）
4. **任务类型**：仅支持 research/analysis/background
5. **并发**：不处理 mission 间并发，依赖 watchdog 扫描间隔

### 升级条件（强制人工介入）

仅以下场景才触发 NEEDS_HUMAN_DECISION / ESCALATED，其他情况总控自主决策：
- 涉及生产环境的破坏性操作（升级、回滚、重启服务、删除数据）
- 达到迭代上限（maxIterations）仍未通过验证
- 达到重试上限（maxRetries）仍失败
- 用户明确要求暂停/干预

以下场景**不需要**升级，总控自行判断：
- 路线选择（用哪个 Agent、用什么组织模式）
- 非破坏性的技术方案选择
- 任务拆分和调度策略
- 子 Agent 失败后的重试/降级/换引擎

---

## 与其他组件的交互

| 组件 | 交互方式 | 说明 |
|------|----------|------|
| `mission-plan.ts` | 调用 | 生成初始计划 |
| `mission-dispatch.ts` | 读取产物 | 三级回退派发 + autoSpawn/agentMap |
| `mission-watchdog.ts` | 调用 | 异常时决策 |
| `mission-verify.ts` | 调用 | 验证完成标准 |
| `mission-notify.ts` | 被触发 | 通过 action 触发通知 |
| Workspace | 文件 I/O | 所有状态持久化到 `missions/<id>/` |

---

## 调试与观测

### 日志记录

Controller 每次被调用应在 `events.jsonl` 追加：

```json
{"ts":"2026-03-18T15:00:00Z","type":"controller_invoked","phase":"verify","missionId":"xxx"}
{"ts":"2026-03-18T15:00:05Z","type":"controller_decision","decision":"RETRYABLE_GAP","reason":"缺少来源列表"}
```

### 调试技巧

1. 检查 `plan.md` 是否明确定义了 `completionCriteria`
2. 检查 `verification.md` 的判定依据
3. 检查 `events.jsonl` 的决策链
4. 手动运行 controller 查看完整推理过程

---

*技能版本：0.1.0 (MVP)*
*最后更新：2026-03-18*
