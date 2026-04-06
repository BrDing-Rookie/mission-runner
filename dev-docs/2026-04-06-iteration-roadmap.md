# Mission Runner 迭代路线图

> 产出日期: 2026-04-06
> 角色: 总控 (Coordinator)
> 输入: PM 功能能力报告 + PM 竞品调研报告 + 代码现状审计

---

## 一、综合分析

### 应强化的已有优势（护城河）

1. **自动验证机制** — 竞品中唯一具备结构化自动验收的系统（test command + artifact 存在检查 + AUTO/MANUAL 分类）。这是核心差异化能力，应持续深化。
2. **Watchdog 保守评估** — 10 种 action 类型 + 任务级停滞检测，竞品中仅 Temporal 有类似能力。应加强自动恢复能力，向 daemon 化演进。
3. **工件落盘 + 审计流** — mission.json + events.jsonl + artifacts 目录的持久化体系，配合 Zod 校验，是长期任务可恢复性的基础。应收紧校验、加固原子写入。

### 应补齐的关键短板

1. **并发安全**（P0）— 无原子写入 + 无文件锁，崩溃时半写文件风险，多实例 TOCTOU 风险。这是阻塞生产使用的硬伤。
2. **Watchdog daemon 化**（P1）— 当前靠 cron 或手动触发，无法做到实时监控。对标 Temporal 的持续调度能力。
3. **状态迁移强制校验**（P1）— 当前 `isTransitionAllowed()` 存在但未在所有写入路径强制执行，需收口。
4. **多 Agent 协调增强**（P2）— 当前三级回退仅解决"派发"问题，缺乏 Agent 间的结果共享、依赖协调。对标 CrewAI/AutoGen。

### 应忽略的竞品功能

1. **可视化拖拽界面** — Dify/Coze/n8n 的核心卖点，但 Mission Runner 定位为 CLI 插件层，不是 low-code 平台。投入产出比极低。
2. **通用 LLM 编排框架** — LangGraph/AutoGen 的 chain/graph 抽象与 Mission Runner 的 mission 工件模型不兼容，不应追随。
3. **插件市场/生态系统** — 当前团队规模不支撑，且 OpenClaw 本身作为宿主已提供插件机制。

---

## 二、功能点优先级排序

| # | 功能名称 | 优先级 | 来源 | 工作量 | 价值 |
|---|----------|--------|------|--------|------|
| 1 | 原子文件写入 | P0 | Phase 2 规划 | S | 消除崩溃时半写文件风险，保障数据完整性 |
| 2 | 文件锁（并发安全） | P0 | Phase 2 规划 | M | 消除多实例 TOCTOU 风险，支持多 watchdog 并行 |
| 3 | 状态迁移强制校验 | P1 | Phase 2 规划 | S | 封堵非法状态跳转，防止数据腐化 |
| 4 | Zod 校验收紧（warn → strict） | P1 | Phase 2 规划 | S | 运行时数据契约从建议变为强制 |
| 5 | Watchdog daemon 化 | P1 | Phase 2 规划 + 竞品启发 | M | 实时监控替代手动/cron 触发 |
| 6 | orchestrate --auto 无人值守 | P1 | Phase 2 规划 | M | 端到端全自动推进，减少人工干预 |
| 7 | Agent 结果兜底回收增强 | P1 | Phase 2 规划 | S | 回收超时/失联 Agent 的结果 |
| 8 | Dispatch L1 可靠性 | P1 | Phase 2 规划 | S | @mention 派发失败时的检测与重试 |
| 9 | 多 Agent 结果共享 | P2 | 竞品启发 (CrewAI) | M | Agent 间可通过 artifact 传递中间结果 |
| 10 | 人工审批节点 | P2 | 竞品启发 (LangGraph/Temporal) | M | 高风险操作需人工确认后继续 |
| 11 | LLM Planner 智能拆分 | P2 | Phase 3 规划 | L | 用 LLM 自动生成任务拆解，替代手写 plan |
| 12 | 验证智能化 | P2 | Phase 3 规划 | M | LLM 辅助判定验收，支持模糊标准 |
| 13 | Mission 模板库 | P3 | Phase 3 规划 | S | 常见任务模式一键复用 |
| 14 | Dashboard 增强（Web UI） | P3 | 自身短板 + 竞品启发 | L | 只读 Web 仪表盘，替代 Discord embed |
| 15 | DAG 并行调度 | P3 | 竞品启发 (LangGraph/Temporal) | L | 无依赖任务自动并行派发 |

---

## 三、迭代路线图

### Phase 2 — 闭环可靠性（当前阶段）

**目标：** 消除数据腐化风险，实现无人值守自动推进。

**功能点：** #1 原子写入、#2 文件锁、#3 状态迁移强制校验、#4 Zod 收紧、#5 Watchdog daemon、#6 orchestrate --auto、#7 Agent 回收增强、#8 Dispatch L1 可靠性

**预期产出：**
- mission.json 读写全链路原子化 + 文件锁保护
- 所有写入路径强制状态迁移校验 + Zod strict 模式
- Watchdog 以 daemon 运行，自动拉起 orchestrate 循环
- 170+ 测试扩展至覆盖并发场景

### Phase 3 — 智能化 + 协调增强

**目标：** 引入 LLM 辅助决策，支持多 Agent 协作和人工审批。

**功能点：** #9 多 Agent 结果共享、#10 人工审批节点、#11 LLM Planner、#12 验证智能化

**预期产出：**
- Planner 支持 LLM 自动拆分（可回退到手动模式）
- Verifier 支持 LLM 模糊判定 + 结构化检查混合模式
- 任务支持 `requiresApproval` 标记，到达时暂停等待人工确认
- Agent 间通过 artifacts 目录传递中间结果，支持 consumer/producer 声明

### Phase 4 — 规模化 + 可观测性

**目标：** 支持大量并发 mission，提供可视化观测能力。

**功能点：** #13 Mission 模板库、#14 Dashboard Web UI、#15 DAG 并行调度

**预期产出：**
- 模板系统（YAML 定义，一键创建 mission）
- 只读 Web Dashboard（mission 列表 + 状态图 + 事件时间线）
- DAG 调度器识别无依赖任务并行派发

---

## 四、Phase 2 开发任务安排

### 并行分组

```
                 ┌─────────────────────┐
  批次 A（无依赖，可完全并行）：       │
  ├── A1: 原子文件写入 (#1)          │ ← fs-utils.ts 内部改造
  ├── A2: 状态迁移强制校验 (#3)      │ ← mission-commit.ts 写入守卫
  └── A3: Zod 校验收紧 (#4)          │ ← schemas.ts warn→strict
                 │                     │
                 ▼                     │
  批次 B（依赖 A1 完成）：             │
  ├── B1: 文件锁 (#2)               │ ← 基于原子写入之上加锁
  └── B2: Dispatch L1 可靠性 (#8)    │ ← 独立模块，可与 B1 并行
                 │                     │
                 ▼                     │
  批次 C（依赖 A+B 基础设施）：        │
  ├── C1: Watchdog daemon 化 (#5)    │ ← 需要文件锁保障并发安全
  ├── C2: orchestrate --auto (#6)    │ ← 需要 daemon 驱动
  └── C3: Agent 回收增强 (#7)        │ ← 独立，可与 C1 并行
                 └─────────────────────┘
```

### 具体任务分配

| 批次 | 任务 | 涉及文件 | 工作量 | 前置依赖 |
|------|------|----------|--------|----------|
| A1 | 原子写入：write→tmp→rename | fs-utils.ts | S | 无 |
| A2 | 状态迁移校验：commitMission 强制守卫 | mission-commit.ts, types.ts | S | 无 |
| A3 | Zod strict：移除 warn 降级逻辑 | schemas.ts, fs-utils.ts | S | 无 |
| B1 | 文件锁：基于 lockfile 的排他读写 | fs-utils.ts (新增 lock 层) | M | A1 |
| B2 | Dispatch L1 可靠性：发送确认 + 超时重试 | dispatch-messenger.ts, mission-dispatch-agent.ts | S | 无 |
| C1 | Watchdog daemon：循环 + 信号处理 + 健康检查 | mission-watchdog.ts (新增 daemon 入口) | M | B1 |
| C2 | orchestrate --auto：daemon 集成 + 退出策略 | mission-orchestrate.ts | M | C1 |
| C3 | Agent 回收增强：超时检测 + 失联兜底 | mission-reconcile-background.ts | S | 无 |

### 建议开发节奏

- **第 1 周：** 批次 A 全部并行启动（3 个 S 级任务），预计 2-3 天完成
- **第 2 周：** 批次 B 启动（B1 等 A1，B2 可立即开始），C3 可提前启动
- **第 3 周：** 批次 C 的 C1/C2 启动，补充集成测试
- **第 4 周：** 全量回归测试 + Phase 2 验收

---

*本文档为迭代行动指南，Phase 3/4 的详细任务分解在 Phase 2 收尾时再展开。*
