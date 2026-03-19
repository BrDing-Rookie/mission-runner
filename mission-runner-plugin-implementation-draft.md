# Mission Runner 插件实施草案

## 1. 目标

### 1.1 要解决的问题
当前 OpenClaw 在复杂任务执行中，常见问题包括：
- Agent 做到一半停住
- 长任务或外部等待缺少自动恢复
- 失败后没有自动重试或降级续跑
- 完成标准不清，导致“自以为完成”
- 用户需要不断手动发消息推进，例如“继续”“看下进展”“再推一下”

Mission Runner 的目标是建立一套闭环：

**任务创建 → 规划 → 执行 → 验证 → 迭代 → 完成通知**

目标效果是：用户给一个任务后，系统能够在尽量少人工干预的前提下持续推进，直到达到完成条件，或在确实需要决策时才升级给用户。

### 1.2 设计原则
1. 先插件化，后内核化
2. 工件优先，不靠会话记忆硬撑
3. 长任务一律后台化
4. 系统自己恢复，不依赖用户催
5. 高风险动作明确升级，低风险动作默认推进
6. 先支持 2~3 类高价值任务，再扩展通用性

---

## 2. 整体结构

建议插件目录结构如下：

```text
mission-runner/
├── PLUGIN.md
├── package.json
├── hooks/
│   ├── mission-intake/
│   │   ├── HOOK.md
│   │   └── handler.ts
│   ├── mission-startup-recover/
│   │   ├── HOOK.md
│   │   └── handler.ts
│   ├── mission-message-observer/
│   │   ├── HOOK.md
│   │   └── handler.ts
│   └── mission-completion-notify/
│       ├── HOOK.md
│       └── handler.ts
├── skills/
│   └── mission-controller/
│       ├── SKILL.md
│       └── templates/
│           ├── planner.md
│           ├── verifier.md
│           └── recovery.md
├── scripts/
│   ├── mission-create.ts
│   ├── mission-plan.ts
│   ├── mission-dispatch.ts
│   ├── mission-watchdog.ts
│   ├── mission-verify.ts
│   ├── mission-resume.ts
│   └── mission-notify.ts
├── schemas/
│   ├── mission.schema.json
│   ├── task.schema.json
│   └── verification.schema.json
└── references/
    └── architecture.md
```

---

## 3. 插件功能切分

### 3.1 mission-intake Hook
**作用**：监听新任务输入，判断是否应创建 mission。

**触发事件**：
- `message:preprocessed`
- 或使用明确命令前缀，例如：
  - “开始任务：”
  - “帮我完成：”
  - “自治执行：”

**职责**：
- 识别用户输入是否适合进入 mission 模式
- 生成 `missionId`
- 创建目录与 `mission.json`
- 写入原始 goal、sessionKey、发起时间
- 触发 controller 开始 planning

**建议**：第一版不要自动把所有消息转为 mission，建议采用显式触发词降低误触发风险。

### 3.2 mission-startup-recover Hook
**作用**：在 gateway 启动时恢复未完成任务。

**触发事件**：
- `gateway:startup`

**职责**：
- 扫描 `missions/`
- 找出状态为以下之一的任务：
  - `RUNNING`
  - `WAITING_BACKGROUND`
  - `WAITING_EXTERNAL`
  - `ITERATING`
- 为这些任务重新安排 watchdog / wakeup
- 避免 gateway 重启导致任务悬空

### 3.3 mission-message-observer Hook
**作用**：监听用户后续补充输入，把它们挂接到已有 mission。

**触发事件**：
- `message:preprocessed`

**职责**：
- 如果当前 chat/session 有活跃 mission
- 将补充信息写入 `mission.json` 或 `notes.md`
- 标记 `updatedByUser`
- 允许 controller 在下一轮迭代时读取这些补充

**目的**：用户补一条信息时，不需要重新开始整个任务。

### 3.4 mission-completion-notify Hook
**作用**：在任务完成或升级时主动通知用户。

**触发来源**：
- 由脚本更新 mission 状态后调用
- 第一版建议脚本直接调用，不建议做复杂文件监听

**职责**：
- 在 `COMPLETED` 时发送结果摘要
- 在 `ESCALATED` / `BLOCKED_HIGH_RISK` 时发送明确告警
- 防止重复通知

---

## 4. Mission 数据设计

建议所有任务都落盘到 workspace：

```text
missions/<mission-id>/
```

### 4.1 目录结构

```text
missions/mission-20260318-001/
├── mission.json
├── plan.md
├── run-log.md
├── verification.md
├── notes.md
├── events.jsonl
└── artifacts/
    ├── output-1.md
    ├── result.json
    └── screenshots/
```

### 4.2 mission.json 字段草案

```json
{
  "missionId": "mission-20260318-001",
  "title": "用户任务标题",
  "goal": "用户原始任务",
  "status": "CREATED",
  "owner": {
    "sessionKey": "agent:research-coordinator:discord:group:1480473840642555926",
    "channel": "discord",
    "chatId": "channel:1480473840642555926",
    "requestMessageId": "1483719023253520464"
  },
  "createdAt": "2026-03-18T14:50:00+08:00",
  "updatedAt": "2026-03-18T14:50:00+08:00",
  "lastProgressAt": "2026-03-18T14:50:00+08:00",
  "nextWakeAt": null,
  "currentIteration": 0,
  "maxIterations": 6,
  "completionCriteria": [],
  "riskPolicy": {
    "autoAllowed": [],
    "askOnce": [],
    "mustConfirm": []
  },
  "tasks": [],
  "artifacts": [],
  "backgroundProcesses": [],
  "activeSessions": [],
  "verification": {
    "status": "PENDING",
    "lastCheckedAt": null,
    "gaps": []
  },
  "escalation": {
    "level": null,
    "reason": null
  },
  "flags": {
    "notifiedStart": false,
    "notifiedComplete": false,
    "notifiedEscalation": false
  }
}
```

### 4.3 tasks[] 子任务结构建议

```json
{
  "taskId": "T1",
  "title": "收集资料并输出摘要",
  "type": "research",
  "status": "PENDING",
  "agent": "researcher-1",
  "sessionKey": null,
  "dependsOn": [],
  "createdAt": "2026-03-18T14:50:00+08:00",
  "startedAt": null,
  "endedAt": null,
  "resultSummary": null,
  "artifacts": [],
  "retryCount": 0,
  "maxRetries": 2,
  "lastError": null
}
```

---

## 5. 运行流程设计

### 5.1 阶段 1：任务创建
**触发**：用户使用明确语义发起任务。

**执行**：
`mission-intake`：
1. 生成 mission id
2. 创建目录
3. 初始化 `mission.json`
4. 写 `events.jsonl`
5. 调用 `mission-plan.ts`

### 5.2 阶段 2：规划
**由 `mission-plan.ts` 负责**

**输入**：
- 用户 goal
- 当前上下文
- 可用 agent/tool 能力

**输出**：
- `plan.md`
- `completionCriteria`
- `riskPolicy`
- `tasks[]`

**规划产物建议包含**：
- 任务目标
- 子任务拆解
- 需要的工具
- 哪些同步做
- 哪些异步做
- 哪些需要验证
- 完成标准
- 升级条件

### 5.3 阶段 3：派发
**由 `mission-dispatch.ts` 负责**

根据 `tasks[]` 决定：
- 简单任务：直接在当前控制 session 中完成
- 多方向任务：派发不同 agent/session
- 长任务：走 `exec background`
- 延迟检查任务：走 cron

**关键要求**：每个任务的执行结果必须回写 mission 工件。

### 5.4 阶段 4：等待与恢复
**由 `mission-watchdog.ts` 负责**

它是整个系统的核心恢复器。

检查内容：
- 是否存在未完成任务
- 是否存在超时无进展
- 是否 background process 已结束
- 是否到 `nextWakeAt`
- 是否该进入验证
- 是否该自动重试

**推荐运行方式**：
通过 cron 周期执行：
- 活跃任务：每 1~3 分钟检查一次
- 重任务：按 `nextWakeAt` 定向唤醒

### 5.5 阶段 5：验证
**由 `mission-verify.ts` 负责**

读取：
- `completionCriteria`
- 当前任务结果
- 产物
- run log

输出：
- `PASS`
- `RETRYABLE_GAP`
- `NONRETRYABLE_FAILURE`
- `NEEDS_HUMAN_DECISION`

并写入：
- `verification.md`
- `mission.json.verification`

### 5.6 阶段 6：迭代
若 verifier 结果不是 PASS：

**情况 A：可补缺**
- 新增下一轮任务
- `currentIteration + 1`
- 重新派发

**情况 B：可重试**
- 对失败任务 retry
- 更新 retryCount
- 设置 `nextWakeAt`

**情况 C：必须升级**
- 状态改为 `BLOCKED_HIGH_RISK` 或 `ESCALATED`
- 主动通知用户

### 5.7 阶段 7：完成通知
**由 `mission-notify.ts` 负责**

在状态变为 `COMPLETED` 时：
- 整理最终摘要
- 说明产物路径
- 说明执行过程简表
- 主动发送消息给任务发起会话

---

## 6. 核心脚本职责说明

### 6.1 mission-create.ts
职责：
- 初始化 mission
- 创建目录
- 写默认 json
- 记录初始事件

### 6.2 mission-plan.ts
职责：
- 生成执行计划
- 补全 completion criteria
- 生成 `tasks[]`
- 判断风险分级

### 6.3 mission-dispatch.ts
职责：
- 根据任务类型挑选执行路径
- 启动子 session / background process / cron wake
- 写回 task 状态与 session/process id

### 6.4 mission-watchdog.ts
职责：
- 扫描所有活跃 mission
- 检查 stuck
- 拉 process 状态
- 决定 resume / retry / verify / escalate

**第一版重点**：它不需要很聪明，但必须可靠。

### 6.5 mission-verify.ts
职责：
- 按 completion criteria 验收
- 识别伪完成
- 给出 gap list

### 6.6 mission-resume.ts
职责：
- 在 watchdog 决定继续后恢复任务
- 重新调用 dispatch / verify
- 管理状态转换

### 6.7 mission-notify.ts
职责：
- 发启动通知（可选）
- 发完成通知
- 发升级通知
- 防止重复发

---

## 7. 状态机实施草案

建议第一版只实现以下状态：

```text
CREATED
PLANNED
RUNNING
WAITING_BACKGROUND
VERIFYING
ITERATING
BLOCKED_HIGH_RISK
ESCALATED
FAILED
COMPLETED
```

### 状态迁移规则

**CREATED -> PLANNED**
- `mission-plan.ts` 成功后进入。

**PLANNED -> RUNNING**
- `mission-dispatch.ts` 开始执行时进入。

**RUNNING -> WAITING_BACKGROUND**
- 存在后台 process 未结束。

**RUNNING -> VERIFYING**
- 全部可见子任务已完成，进入验收。

**VERIFYING -> COMPLETED**
- 通过验收。

**VERIFYING -> ITERATING**
- 未通过但可继续补缺。

**ITERATING -> RUNNING**
- 下一轮任务已派发。

**ANY -> BLOCKED_HIGH_RISK**
- 遇到必须人工拍板的高风险动作。

**ANY -> ESCALATED**
- 达到重试上限或长时间 stuck。

**ANY -> FAILED**
- 确定不可恢复。

---

## 8. 任务类型建议

第一版建议只支持少数任务类型，避免过早通用化。

### 推荐优先支持
1. **调研与报告类**
   - 风险低
   - 工具链清晰
   - 完成标准相对可定义
   - 适合多轮迭代补充

2. **文档整理类**
   - 汇总多来源信息
   - 生成 briefing
   - 维护知识库

3. **受限代码任务**
   - 在限定目录做分析、生成 patch 建议
   - 运行后台测试并等待结果
   - 自动复查日志

### 暂不建议第一版支持
- 高风险线上变更
- 大规模浏览器真账号操作
- 重度提权类任务
- 高主观性的创意任务

---

## 9. Watchdog 设计草案

### 9.1 扫描规则
每次 watchdog 执行时：
- 扫描所有非终态 mission
- 跳过已完成或已失败任务
- 关注 `updatedAt`、`lastProgressAt`、`nextWakeAt`

### 9.2 处理逻辑

**Case 1：状态为 `WAITING_BACKGROUND`**
- 读取 `backgroundProcesses`
- 检查对应 process 是否结束
- 若结束：
  - 收集输出
  - 更新 task 状态
  - 进入 `VERIFYING` 或 `RUNNING`

**Case 2：状态为 `RUNNING` 但 `lastProgressAt` 超时**
- 若任务可 retry：进入重试
- 若无可恢复路径：进入 `ESCALATED`

**Case 3：状态为 `ITERATING` 且已到 `nextWakeAt`**
- 调用 `mission-resume.ts`

**Case 4：状态为 `VERIFYING`**
- 调用 `mission-verify.ts`

### 9.3 推荐策略
- 不做高频 poll
- 尽量按 `nextWakeAt` 定向唤醒
- process 检查间隔至少 30~60 秒以上
- 任务超时阈值按类型设置

---

## 10. 验证器设计草案

Verifier 是整个插件的核心组件之一。

### 10.1 输入
- `mission.json`
- `plan.md`
- 产物列表
- 各 task 结果
- 运行日志

### 10.2 输出建议

```json
{
  "status": "RETRYABLE_GAP",
  "summary": "主结果已生成，但缺少来源校验与最终交付摘要",
  "gaps": [
    "未提供来源列表",
    "未生成面向用户的最终摘要"
  ],
  "recommendedNextTasks": [
    {
      "title": "补充来源校验",
      "type": "verification"
    },
    {
      "title": "生成最终交付摘要",
      "type": "delivery"
    }
  ]
}
```

### 10.3 判定逻辑
**PASS**
- 所有 completion criteria 满足
- 无关键 gap
- 产物存在且可引用

**RETRYABLE_GAP**
- 主任务接近完成
- 缺少可自动补齐的步骤

**NONRETRYABLE_FAILURE**
- 核心前提失败
- 继续无意义

**NEEDS_HUMAN_DECISION**
- 需要路线选择
- 需要高风险确认
- 需要缺失且不可推断的关键输入

---

## 11. 通知策略草案

### 11.1 启动通知
第一版可选。
建议只在任务较长时发送：
- “任务已接收，进入自治执行”
- “我会在完成或需要决策时再提醒你”

### 11.2 完成通知
建议格式：
1. 一句话完成结论
2. 关键产物
3. 执行摘要
4. 如有必要，给出下一步建议

### 11.3 升级通知
必须说清：
- 为什么升级
- 系统已尝试了什么
- 需要用户做什么决策/批准
- 用户不介入的话任务会停在哪

---

## 12. Cron 配置建议

建议创建 recurring watchdog job。

### 方案 A：统一 watchdog
- 每 2 分钟扫描一次所有活跃 mission

**优点**：
- 简单
- 易实现

**缺点**：
- 有空扫成本

### 方案 B：统一 watchdog + 定向 wake
- 统一 watchdog 做兜底
- 每个 mission 还设置 one-shot `nextWakeAt`

**优点**：
- 更精准
- 更省扫描

**建议第一版**：先 A，后 B。

---

## 13. 最小可行版本（MVP）范围

建议 MVP 只做：
- 显式触发创建 mission
- 写 `mission.json`
- 自动生成计划
- 支持 1~3 个子任务
- 支持 background process 跟踪
- 支持 verifier
- 支持 watchdog 恢复
- 支持完成/升级通知

### MVP 不做
- 通用 DAG
- 图形化 UI
- 复杂权限代理
- 全任务类型泛化
- 自动跨所有插件/工具的 continuation bus

---

## 14. 实施顺序建议

### Phase 1：工件与状态机
先完成：
- mission schema
- mission create / update
- 状态迁移函数
- 事件日志

### Phase 2：规划与派发
完成：
- planner 模板
- dispatch 逻辑
- task 写回

### Phase 3：watchdog 与 background process
完成：
- process 跟踪
- stuck 检测
- retry / resume

### Phase 4：verifier 与通知
完成：
- gap 判定
- 迭代闭环
- 完成汇报

### Phase 5：恢复与增强
完成：
- startup recover
- 用户补充输入挂接
- 优化可观测性

---

## 15. 风险与注意事项

### 15.1 最大风险：过早追求“全自动通用”
建议先聚焦少数任务类型。
先跑通闭环，比追求“什么都能做”重要。

### 15.2 第二大风险：completion criteria 太弱
如果规划阶段不写清完成条件，后面就一定会出现“做一半以为完成”。

### 15.3 第三大风险：watchdog 太激进
不要高频轮询，不要疯狂 resume。
要有：
- debounce
- timeout
- retry budget
- escalation threshold

### 15.4 第四大风险：状态更新不一致
必须保证：
- 所有关键动作先写状态再执行
- 或执行后立刻回写状态
否则恢复时会混乱。

---

## 16. 最终结论

Mission Runner 插件实施草案，本质上是在 OpenClaw 现有能力上搭建一层：

**自治任务编排层**

它不要求先改内核，但能显著改善：
- 任务中途卡住
- 长任务没人接续
- 失败后不重试
- 完成标准不清
- 用户不断手动 push

它的核心闭环是：

**Mission 工件 + Controller + Watchdog + Verifier + Notify**

只要这五件事立住，就能把 OpenClaw 从“会执行的聊天体”往“可持续完成任务的自治体”推进一大步。
