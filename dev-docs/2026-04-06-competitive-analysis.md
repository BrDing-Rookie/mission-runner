# Mission Runner 竞品对比分析报告

> 产出日期: 2026-04-06
> 角色: PM (Product Manager)
> 状态: 已完成

---

## 一、竞品概览

| 项目 | Stars | 定位 | 技术栈 | 许可证 |
|------|-------|------|--------|--------|
| **AutoGPT** | 173k | 自主 Agent 框架 | Python | MIT |
| **n8n** | 183k | 工作流自动化平台 | TypeScript | Fair-code |
| **Dify** | 136k | LLM 应用开发平台 | Python + React | Apache 2.0 |
| **Flowise** | 51.6k | 可视化 Agent 构建 | TypeScript + React | Apache 2.0 |
| **CrewAI** | 28k | 多 Agent 协作框架 | Python | MIT |
| **Temporal** | 19.4k | 持久化工作流引擎 | Go | MIT |
| **LangGraph** | ~10k | 图编排 Agent 框架 | Python | MIT |
| **OpenAI Agents SDK** | 新发布 | 多 Agent 编排 SDK | Python | MIT |
| **Mission Runner** | 内部 | 自治任务编排插件层 | TypeScript | — |

---

## 二、能力维度对比

### 2.1 状态管理与持久化

| 能力 | Mission Runner | AutoGPT | CrewAI | LangGraph | Temporal | Dify |
|------|---------------|---------|--------|-----------|----------|------|
| 状态机驱动 | **11 态 + 强制迁移校验** | 无正式状态机 | 无 | 图节点状态 | Workflow 状态 | 无 |
| 工件落盘 | **mission.json + events.jsonl** | Workspace 目录 | 无 | Checkpoint | Event Sourcing | 数据库 |
| 中断恢复 | **文件系统 + 文件锁** | Workspace 恢复 | 无 | Checkpoint 恢复 | **自动恢复** | 数据库恢复 |
| 审计追踪 | **events.jsonl** | 日志 | 无 | 无 | **Event History** | 日志 |
| 原子写入 | **write→tmp→rename** | 无 | 无 | 无 | **事务型** | 数据库事务 |

**分析:** Mission Runner 的文件系统持久化方案在轻量级方案中最为完备，但与 Temporal 的事务型持久化仍有差距。Temporal 的 Event Sourcing 是工业级方案，Mission Runner 的 events.jsonl 是轻量替代。

### 2.2 任务编排与调度

| 能力 | Mission Runner | AutoGPT | CrewAI | LangGraph | Temporal | n8n |
|------|---------------|---------|--------|-----------|----------|-----|
| 任务拆解 | 手动 plan | LLM 自主 | 角色定义 | 图定义 | Workflow 定义 | 可视化编排 |
| 多 Agent 派发 | **三级回退** | 单 Agent | **多角色协作** | 图路由 | Activity Worker | 节点触发 |
| 依赖管理 | 顺序执行 | 无 | 顺序/层级 | **DAG** | **DAG** | **DAG** |
| 并行执行 | 无 | 无 | 有限 | **原生支持** | **原生支持** | **原生支持** |
| 自动重试 | Watchdog 驱动 | 无 | 无 | 可配置 | **原生重试策略** | 可配置 |

**分析:** Mission Runner 的三级回退派发（L1 @mention → L2 create session → L3 queue）在竞品中独特，但缺乏 DAG 并行调度是明显短板。LangGraph 和 Temporal 的图/DAG 编排是行业方向。

### 2.3 验证与质量保证

| 能力 | Mission Runner | AutoGPT | CrewAI | LangGraph | OpenAI SDK |
|------|---------------|---------|--------|-----------|------------|
| 自动验收 | **completionCriteria + test command** | 无 | 无 | 无 | Guardrails |
| 验证分类 | **AUTO/MANUAL** | 无 | 无 | 无 | 无 |
| Artifact 检查 | **存在性 + 路径匹配** | Workspace 输出 | 无 | 无 | 无 |
| 人工审批 | 无 | 无 | 无 | **Human-in-the-loop** | **Human Involvement** |

**分析:** 自动验收是 Mission Runner 最大差异化优势，竞品几乎无此能力。但缺少人工审批节点（human-in-the-loop），LangGraph 和 OpenAI SDK 已支持。

### 2.4 监控与可观测性

| 能力 | Mission Runner | AutoGPT | Dify | n8n | Temporal | OpenAI SDK |
|------|---------------|---------|------|-----|----------|------------|
| 运行状态监控 | Watchdog 扫描 | 无 | **LLMOps 面板** | **执行历史** | **Temporal Web UI** | **Tracing UI** |
| 实时告警 | Discord 通知 | 无 | 应用监控 | Webhook | 无 | 无 |
| Dashboard | Discord embed | 无 | **Web UI** | **Web UI** | **Web UI** | **Trace Viewer** |
| 成本追踪 | 无 | 无 | **Token 消耗统计** | 无 | 无 | 无 |

**分析:** Mission Runner 通过 Discord 通知有基本监控，但缺乏结构化 Dashboard。Dify 的 LLMOps 面板和 Temporal 的 Web UI 是参考标杆。

---

## 三、Mission Runner 独特优势（护城河）

1. **结构化自动验收** — 竞品中唯一具备 completionCriteria + test command + AUTO/MANUAL 分类的系统
2. **Watchdog 保守策略** — 10 种 action 类型 + 任务级停滞检测，不盲目执行，只输出建议
3. **三级回退派发** — L1→L2→L3 渐进式降级，确保任务一定被接收
4. **轻量级持久化** — 纯文件系统方案（无需数据库），适合插件/CLI 场景
5. **集中式提交层** — commitMissionUpdate 统一校验 + 写入 + 通知，防止绕过

---

## 四、竞品启发的新功能点

基于竞品分析，以下功能值得 Mission Runner 借鉴：

### 高优先级（已纳入 Phase 2/3 路线图）

| # | 功能 | 启发来源 | 当前路线图 |
|---|------|---------|-----------|
| 1 | Watchdog daemon 化 | Temporal 持续调度 | Phase 2 #5 |
| 2 | 人工审批节点 | LangGraph/OpenAI SDK human-in-the-loop | Phase 3 #10 |
| 3 | 多 Agent 结果共享 | CrewAI 角色协作 | Phase 3 #9 |
| 4 | LLM 智能拆分 | AutoGPT 自主规划 | Phase 3 #11 |
| 5 | DAG 并行调度 | LangGraph/Temporal | Phase 4 #15 |

### 新发现（建议补充到路线图）

| # | 功能 | 启发来源 | 建议优先级 | 说明 |
|---|------|---------|-----------|------|
| N1 | **Token/成本追踪** | Dify LLMOps | P2 | 每个 task 记录 LLM 调用次数和 token 消耗，mission 汇总成本 |
| N2 | **Agent Guardrails** | OpenAI Agents SDK | P2 | 输入输出安全检查，防止 Agent 越权操作 |
| N3 | **Handoff 机制** | OpenAI Agents SDK | P3 | Agent 间无缝移交（当前只能通过 artifact），支持上下文传递 |
| N4 | **MCP 工具集成** | OpenAI Agents SDK | P3 | 支持 Model Context Protocol 标准工具，扩展 Agent 能力 |
| N5 | **Mission 模板 + 一键复用** | n8n 模板库 | Phase 4 #13（已有）| 确认优先级合理 |

---

## 五、总控建议

### 当前迭代（Phase 2）继续执行

批次 A/B 已完成（原子写入、文件锁、状态迁移校验、Zod strict、Dispatch L1 可靠性），批次 C（Watchdog daemon、orchestrate --auto、Agent 回收增强）按计划推进。

### Phase 3 路线图建议更新

在现有 Phase 3 基础上增加：
- **N1 Token/成本追踪** — 低工作量高价值，在 events.jsonl 中追加 token 字段即可
- **N2 Agent Guardrails** — 在 dispatch 层增加前置/后置检查

### 不建议追随的方向

- 可视化 UI（Dify/n8n/Flowise 的核心卖点，与 Mission Runner CLI 定位冲突）
- 通用 LLM 编排（LangGraph 的 chain 抽象，Mission Runner 用 mission 工件模型更适合）
- 插件市场（团队规模不支撑，OpenClaw 已有插件机制）

---

*本报告基于 PM Agent 收集的竞品数据（AutoGPT, CrewAI, LangGraph, Dify, n8n, OpenAI Agents SDK, Temporal, Flowise）编写。Coze 因 SPA 渲染限制未获取到详细数据，后续可补充。*
