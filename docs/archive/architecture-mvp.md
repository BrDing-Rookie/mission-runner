# Mission Runner MVP Architecture

## 1. Scope

本文件定义 Mission Runner MVP 的最小闭环边界，目标是让以下链路在插件层可落地并可审查：

`mission.json 持久化 -> planner 产出任务 -> dispatch 执行 -> watchdog 扫描恢复/推进 -> verify 验收 -> notify 通知`

本版重点不是“全自动通用编排”，而是建立**状态一致、职责收敛、可恢复、可继续演进**的骨架。

---

## 2. 模块职责

### 2.1 `schemas/*.json`
职责：
- 定义 `mission / task / verification` 的静态数据边界
- 为 TypeScript 类型与后续运行时校验提供基础契约
- 限制 MVP 状态机与字段集合，避免脚本各自发明字段

MVP 要求：
- mission / task / verification 三层字段命名一致
- mission status 与 scripts/lib/types.ts 对齐
- watchdog 仅依赖 schema 中已声明字段做决策

### 2.2 `scripts/lib/types.ts`
职责：
- 提供脚本间共享的 TypeScript 类型
- 定义状态枚举、终态集合、watchdog 输出结构
- 约束状态迁移与后续实现的公共语义

### 2.3 `scripts/lib/fs-utils.ts`
职责：
- 提供 mission 工件目录的基础文件 I/O
- 统一 mission.json / events.jsonl 的读写行为
- 屏蔽脚本层重复实现文件系统细节

约束：
- 保持同步实现优先，先求可靠易恢复
- 避免在 MVP 中引入复杂锁和异步写入模型

### 2.4 `scripts/mission-create.ts`（后续实现）
职责：
- 创建 mission 目录
- 初始化 `mission.json`
- 初始化 artifacts/ 与 events.jsonl
- 触发后续 planning

输入：
- 用户 goal、owner、标题等初始化参数

输出：
- `missions/<missionId>/mission.json`
- `missions/<missionId>/events.jsonl`

### 2.5 `scripts/mission-plan.ts`（后续实现）
职责：
- 调用 mission-controller/planner 生成计划
- 写入 `plan.md`、`completionCriteria`、`tasks[]`
- 将 mission 从 `CREATED` 推进到 `PLANNED`

输入：
- 当前 mission.json
- goal、owner、上下文能力

输出：
- 更新后的 mission.json
- `plan.md`

### 2.6 `scripts/mission-dispatch.ts`（后续实现）
职责：
- 根据 task type 启动执行路径
- 写回 task 状态、sessionKey、backgroundProcessId
- 决定 mission 进入 `RUNNING` / `WAITING_BACKGROUND`

输入：
- mission.json 中 `tasks[]`

输出：
- 更新后的 mission.json
- 可选日志/产物/后台进程跟踪记录

### 2.7 `scripts/mission-watchdog.ts`
职责：
- 周期扫描 missions 根目录
- 跳过终态 mission
- 基于 `status / nextWakeAt / lastProgressAt / tasks / backgroundProcesses` 生成检查结论
- 决定是否需要：
  - 继续等待
  - 检查后台任务
  - 触发 verify
  - 恢复/续跑
  - 按 retry / stuck 条件升级

MVP 明确边界：
- **只产出检查结论与可读日志，尽量少做复杂副作用**
- 当前版本可在非 `--dry-run` 下写回 `nextWakeAt` / `updatedAt` / 事件日志，但**不直接调用外部 agent / process API**
- 真正的 resume / verify / notify 调用保留给后续脚本接入

### 2.8 `scripts/mission-verify.ts`（后续实现）
职责：
- 根据 completion criteria 与产物判定 PASS / GAP / FAIL / ESCALATE
- 写回 verification 结构
- 推进到 `COMPLETED / ITERATING / FAILED / ESCALATED`

### 2.9 `scripts/mission-resume.ts`（后续实现）
职责：
- 接收 watchdog 的恢复建议
- 触发 dispatch 或局部 retry
- 管理 `ITERATING -> RUNNING`、`WAITING_* -> RUNNING` 等迁移

### 2.10 `scripts/mission-notify.ts`（后续实现）
职责：
- 在 `COMPLETED / ESCALATED / BLOCKED_HIGH_RISK` 时发送通知
- 去重通知，更新 flags

---

## 3. 状态流转

MVP 状态集合：

- `CREATED`
- `PLANNED`
- `RUNNING`
- `WAITING_BACKGROUND`
- `WAITING_EXTERNAL`
- `VERIFYING`
- `ITERATING`
- `BLOCKED_HIGH_RISK`
- `ESCALATED`
- `FAILED`
- `COMPLETED`

### 3.1 主链路

```text
CREATED
  -> PLANNED
  -> RUNNING
  -> WAITING_BACKGROUND   (若存在后台任务)
  -> VERIFYING            (任务完成后)
  -> COMPLETED            (验证通过)
```

### 3.2 补缺闭环

```text
VERIFYING
  -> ITERATING            (存在可自动补缺 gap)
  -> RUNNING              (resume/dispatch 下一轮)
```

### 3.3 升级/失败链路

```text
RUNNING / WAITING_BACKGROUND / VERIFYING / ITERATING
  -> BLOCKED_HIGH_RISK    (需要人工确认高风险操作)
  -> ESCALATED            (超时、重试耗尽、不可判定)
  -> FAILED               (不可恢复)
```

### 3.4 watchdog 视角的可操作状态

- `CREATED` / `PLANNED`：通常只做提醒型结论，不擅自推进
- `RUNNING`：检测是否无进展过久、是否所有任务已完成
- `WAITING_BACKGROUND`：检测后台进程是否仍在运行/已结束/缺失
- `WAITING_EXTERNAL`：仅按 `nextWakeAt` 到期后触发恢复建议
- `VERIFYING`：建议触发 verify
- `ITERATING`：按 `nextWakeAt` 或任务 readiness 触发 resume
- `BLOCKED_HIGH_RISK`：保持阻塞，必要时提示升级

---

## 4. 关键字段语义

### 4.1 mission 级字段

- `status`: mission 当前阶段，watchdog 的主决策入口
- `lastProgressAt`: 最近一次“任务确有推进”的时间，用于 stuck 判断
- `updatedAt`: 最近一次任意写回时间，不等于真实进展
- `nextWakeAt`: 下次定向唤醒时间；未到则尽量不打扰
- `currentIteration` / `maxIterations`: 控制 verifier gap 闭环与恢复预算

### 4.2 task 级字段

- `status`: 单任务状态，watchdog 用于判断是否还有在跑任务、是否可进入 verify
- `retryCount` / `maxRetries`: 单任务重试预算
- `backgroundProcessId`: 子任务与 backgroundProcesses 的关联键
- `lastError`: 最近错误上下文

### 4.3 background process 级字段

- `processId`: 外部 process/session 标识
- `taskId`: 关联 task
- `status`: `RUNNING / COMPLETED / FAILED / TIMEOUT`
- `startedAt / endedAt`: 用于超时与回收判断
- `outputPath`: 后续读取日志/产物的入口

---

## 5. 脚本输入输出契约

## 5.1 `mission-watchdog.ts`

### 输入
- 文件系统中的 `missions/<id>/mission.json`
- CLI flags：
  - `--missions-dir <path>`
  - `--dry-run`
  - `--verbose`
  - `--task-timeout-ms <n>`
  - `--background-check-interval-ms <n>`
  - `--max-idle-ms <n>`

### 输出
- stdout 人类可读扫描日志
- 每个 mission 一条 `WatchdogCheckResult`
- 非 dry-run 时可写回：
  - `mission.updatedAt`
  - `mission.nextWakeAt`
  - `events.jsonl` 中的 watchdog decision event

### 不做的事
- 不直接执行真实 process poll API
- 不直接 spawn agent/session
- 不直接发送 notify 消息
- 不直接修改复杂 task 内容（除非未来显式扩展）

### 约定
watchdog 只输出“下一步建议/边界内可落盘结果”，例如：
- `CHECK_BACKGROUND`
- `TRIGGER_VERIFY`
- `RESUME_TASK`
- `RETRY_TASK`
- `ESCALATE_STUCK`
- `ESCALATE_MAX_RETRY`
- `NONE`

---

## 6. watchdog 决策边界

MVP watchdog 必须**保守**，避免把自己写成激进调度器。

### 6.1 可自动决策的情况

1. **到达 `nextWakeAt`**
   - 可建议 `RESUME_TASK` 或 `TRIGGER_VERIFY`
2. **mission 处于 `VERIFYING`**
   - 可建议 `TRIGGER_VERIFY`
3. **所有任务都处于终态，且无运行中的 background process**
   - 可建议 `TRIGGER_VERIFY`
4. **后台进程状态仍为 RUNNING，但检查间隔未到**
   - 建议 `NONE` 并延后 `nextWakeAt`
5. **后台进程已标记 COMPLETED/FAILED/TIMEOUT**
   - 可建议 `CHECK_BACKGROUND`，由后续 resume/verify 脚本接管
6. **lastProgressAt 超过最大空转阈值**
   - 若存在可重试任务且预算未耗尽，建议 `RETRY_TASK`
   - 否则建议 `ESCALATE_STUCK` 或 `ESCALATE_MAX_RETRY`

### 6.2 不应自动决策的情况

1. 需要真实读取外部 session/process 状态但本地工件不足
2. 涉及生产、敏感数据、权限提升等高风险动作
3. verifier 尚未定义明确 completion criteria
4. mission 当前状态与 tasks/backgroundProcesses 明显不一致，无法安全推断
5. 需要决定“任务路线切换”而非简单 retry/resume

这些情况应输出升级型结论，而不是自行继续执行。

---

## 7. 目录约定

```text
missions/<mission-id>/
├── mission.json
├── plan.md
├── run-log.md
├── verification.md
├── notes.md
├── events.jsonl
└── artifacts/
```

MVP 最低要求：
- `mission.json` 必须存在
- `events.jsonl` 可按需懒创建
- `artifacts/` 目录建议创建但可为空

---

## 8. 类型与 schema 一致性要求

以下内容必须保持一致：
- `schemas/mission.schema.json` 的 mission status 枚举
- `scripts/lib/types.ts` 中 `MissionStatus`
- `TERMINAL_STATUSES` / `ACTIVE_STATUSES`
- architecture 文档中的状态流转说明

若不一致，优先修正类型与文档，使 watchdog 逻辑只依赖一套状态语义。

---

## 9. MVP 之后的扩展点

后续可扩展但当前不纳入实现承诺：
- 真实 process/session 查询适配器
- schema 的 Zod/runtime validation
- `mission-resume.ts` / `mission-verify.ts` 接线
- file lock / atomic write
- watchdog 增量扫描与定向调度
- 去重通知与 startup recover

---

## 10. 结论

Mission Runner MVP 的最小可靠骨架建立在四个约束上：

1. **状态要少且明确**
2. **工件要落盘且可恢复**
3. **watchdog 先做保守判断，不抢复杂控制权**
4. **verify 才是完成判定入口，watchdog 只负责推进到 verify/resume/escalate**

这样可以先把骨架跑通，再逐步把 dispatch / verify / notify 接完整。
