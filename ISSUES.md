# Mission Runner 问题追踪

> 基于 2026-03-20 研究团队首次实际使用 mission-runner 的观察记录。
> Mission ID: mission-20260320-002（国产大模型调研）

---

## P0 — 阻塞核心流程

### ISSUE-001: plan 不支持自定义任务拆解，导致多路并行任务共享同一 taskId

**现象**：总控派发 3 路并行研究员，但 mission-plan 默认只生成 3 个串行 task（task-context / task-execute / task-verify），总控将 3 个研究员都指向了 taskId: task-execute。

**影响**：
- 只有第一个调用 task-update 的研究员能成功更新状态，其余命中幂等保护
- mission 状态推导不准确（3 个实际任务只对应 1 个 task 对象）
- events.jsonl 中只记录了 1 次 task_status_updated

**根因**：buildDefaultPlan() 在 mission-helpers.ts 中硬编码了 3 步串行模板，不支持传入自定义 task 列表。

**建议修复**：
1. mission-plan.ts 支持 --tasks JSON 参数或 --tasks-file 从文件读取自定义任务列表
2. 或支持 --parallel N 参数自动生成 N 路并行 task（dependsOn 为空）
3. 总控在 AGENTS.md 中应指引：先规划并行 task 列表，再通过 plan 落盘

---

### ISSUE-002: dispatch 与 sessions_spawn 脱节

**现象**：总控跳过了 mission-dispatch，直接手动 sessions_spawn 研究员。dispatch 脚本只改 task 状态（READY -> RUNNING），不触发实际的 Agent 派发。

**影响**：
- mission.json 中 task 状态未经过 dispatch 流程（直接从 PLANNED 到被子 Agent 标记 COMPLETED）
- backgroundProcesses 为空，reconcile-background 无法回收
- 状态机跳步：PLANNED -> (跳过 RUNNING) -> COMPLETED

**根因**：dispatch 设计为纯状态更新，不包含 Agent 调度逻辑。总控的 AGENTS.md 也未指引在 spawn 前先 dispatch。

**建议修复**：
1. 短期：在总控 AGENTS.md 中明确要求先 dispatch 再 spawn
2. 中期：dispatch 支持 --agent 参数，自动通过 OpenClaw sessions_spawn 派发
3. 或新增 mission-start.ts 一键完成 plan -> dispatch -> spawn

---

## P1 — 影响可靠性

### ISSUE-003: 子 Agent 写入 artifact 被网关审批拦截

**现象**：researcher-1 执行 heredoc 写文件时被网关拒绝，错误：Exec denied (approval-timeout, obfuscation-detected)。

**影响**：
- artifact 未落盘，研究产出丢失（仅存在于子 Agent 返回的文本中）
- 子 Agent 随后将 task-update 标记为 FAILED

**根因**：
1. heredoc 写文件方式被网关识别为 obfuscation，触发安全审批
2. 子 Agent 的 exec 审批超时（无人确认）

**建议修复**：
1. 新增 task-artifact.ts 脚本，接收 --content 或 stdin 写入 artifact，避免 heredoc
2. 或在研究员 AGENTS.md 中指引使用 write 工具（如果子 Agent 有该工具权限）
3. 或在网关 approvals 中为 mission artifacts 目录的写入操作添加 allowlist

---

### ISSUE-004: 总控未在结果回收后执行 watchdog / verify 闭环

**现象**：三路研究员结果全部回流后，总控直接汇总输出给用户，未运行 watchdog 或 verify-mission。mission 最终状态停留在 RUNNING。

**影响**：
- mission 状态未收敛到 VERIFYING -> COMPLETED
- completionCriteria 未被校验
- mission 生命周期不完整，watchdog 后续扫描会将其识别为 stuck

**根因**：总控 AGENTS.md 中的 mission-controller skill 使用指引只列出了各脚本命令，但没有明确要求结果回收后必须执行 watchdog + verify 的闭环流程。

**建议修复**：
1. 在总控 AGENTS.md 中补充闭环流程：结果回收 -> watchdog -> verify -> 标记完成
2. 中期：watchdog 支持自动触发 verify（当所有 task 终态时）
3. 长期：通过 cron 定期运行 watchdog，自动推进 mission 状态

---

## P2 — 体验优化

### ISSUE-005: plan 不支持并行任务依赖图

**现象**：默认 plan 只生成线性依赖（T1 -> T2 -> T3），但实际场景中并行调研是最常见的模式。

**影响**：plan.md 生成的任务结构与实际执行方式不一致，dispatch 按依赖顺序只释放一个 READY task。

**建议修复**：
- 支持 dependsOn: []（空依赖）的并行 task 组
- 支持 --template parallel-research 等预设模板
- plan 生成时根据 goal 关键词自动选择串行/并行模板

---

### ISSUE-006: task-update 的 --artifact 参数文档不完善

**现象**：子 Agent 可能产出多个文件，但文档未说明 --artifact 可多次传入。

**影响**：多产物需多次调用或只记录一个。

**建议修复**：补充文档说明 --artifact 支持多次传入（当前实现已支持）。

---

### ISSUE-007: mission-plan 生成的 completionCriteria 过于通用

**现象**：当前生成的 3 条 criteria 是固定模板（有 plan、有交付物、有验证标准），与具体任务目标无关。

**影响**：verify 阶段无法做有意义的验收判断。

**建议修复**：
- plan 支持传入自定义 completionCriteria
- 或由总控在 TASK-ENVELOPE 中定义，plan 脚本接收并持久化

---

## P3 — 未来增强

### ISSUE-008: 缺少 mission-start 一键入口

**现象**：当前需要手动依次调用 create -> plan -> dispatch，总控容易跳步。

**建议**：新增 mission-start.ts，一键完成 create -> plan -> dispatch，支持 --goal、--tasks、--parallel 参数。

---

### ISSUE-009: watchdog 不支持自动触发 verify

**现象**：watchdog 能检测到所有 task 完成并建议 TRIGGER_VERIFY，但不自动执行。

**建议**：mission-run-action 支持 TRIGGER_VERIFY action，自动调用 mission-verify.ts。

---

## 附录：首次使用的正面收获

尽管存在上述问题，首次实际使用验证了以下能力已成立：

- mission-controller skill 被总控识别并读取
- create-mission + mission-plan 正常执行
- 子 Agent 收到了 missionId/taskId 上下文
- 子 Agent 成功调用 task-update 更新状态（researcher-3）
- 子 Agent 以各自 Discord 身份（accountId）在群聊回复
- artifacts 目录落盘成功（2/3 研究员）
- events.jsonl 正确记录了 mission_created -> mission_planned -> task_status_updated
- thread: false 生效，结果回到主频道

---

*记录时间：2026-03-20*
*记录者：运维助手（基于 session log 分析）*
