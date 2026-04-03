# Mission Runner 系统完善推进计划

> 创建日期: 2026-04-03
> 目标: 将 Mission Runner 从「手动挡 MVP」推进为「自动闭环的完整编排系统」

---

## 一、项目背景

Mission Runner 核心编排引擎已基本完备（39 源文件 / ~6600 行 / 122 测试通过），但在 OpenClaw 真实使用中暴露了 6 个问题（详见 review-issues.md），反映出三类系统性缺陷：

1. **状态机覆盖不完整** — 非线性流程（如 VERIFYING 下追加任务）未支持
2. **闭环自动化不足** — Agent 结果回收、任务推进仍依赖人工介入
3. **运行时健壮性不够** — 缺 Zod 校验、缺集成测试、错误恢复策略有限

---

## 二、团队组织

### 角色定义

| 角色 | 职责 | 说明 |
|------|------|------|
| **Owner (br.ding)** | 决策、优先级排序、验收 | 最终决定权 |
| **Coordinator (协调者)** | 任务拆解、分配、进度跟踪、技术决策 | 统筹全局，协调各开发者 |
| **Developer × N** | 具体编码、测试、PR 提交 | 按模块分工并行开发 |

### 协作模式

```
Owner (br.ding)
    ↕  对话通道（本 Agent 转达）
Coordinator (协调者)
    ↕  直接指挥
Developer A / B / C ...
```

- Owner 通过本对话通道向 Coordinator 传达方向和反馈
- Coordinator 拥有技术决策权，负责拆解任务、分配给 Developer、跟踪进度
- Developer 完成开发后向 Coordinator 汇报，Coordinator 汇总后向 Owner 报告

---

## 三、推进阶段

### Phase 1 — 补齐短板（基础修复）

> 目标: 修复已知 Bug，夯实基础，让现有功能可靠运行

| 任务 ID | 任务 | 类型 | 依赖 | 建议分配 |
|---------|------|------|------|----------|
| P1-T1 | 修复 Issue 2: VERIFYING 状态允许 task-add + 自动回退到 RUNNING | Bug Fix | 无 | Developer A |
| P1-T2 | 接入 Zod 运行时校验：mission.json / task 对象读写时验证 | 增强 | 无 | Developer B |
| P1-T3 | 提交 scripts/service/ + skills/cc-session/（systemd + session 管理） | 运维 | 无 | Developer A |
| P1-T4 | 补充集成测试：模拟完整 create→plan→dispatch→update→verify 流程 | 测试 | P1-T1 | Developer B |

**交付标准:**
- VERIFYING 状态下 task-add 成功，mission 自动回退到 RUNNING
- mission.json 读写经过 Zod 校验，畸形数据抛明确错误
- 全部测试通过，新增测试 ≥ 8 个

---

### Phase 2 — 闭环自动化

> 目标: 减少人工介入，Agent 完成任务后系统自动推进

| 任务 ID | 任务 | 类型 | 依赖 | 建议分配 |
|---------|------|------|------|----------|
| P2-T1 | Agent 结果兜底回收：watchdog 扫描 artifacts 目录变化 + 超时 escalate | 核心 | P1-T1 | Developer A |
| P2-T2 | orchestrate 增强：连续推进直到终态或需人工介入，支持 --auto 模式 | 核心 | P2-T1 | Developer A |
| P2-T3 | Dispatch L1 可靠性：完善 agent→Discord 映射配置，添加健康检查 | 增强 | 无 | Developer B |
| P2-T4 | 错误恢复策略：watchdog 对常见失败模式的自动恢复（重试/回退/escalate 决策树） | 增强 | P2-T1 | Developer B |

**交付标准:**
- 端到端场景：Agent 完成任务后，系统自动回收结果、派发下一任务、直到验证完成
- orchestrate --auto 可无人值守推进 ≥ 3 个连续任务
- watchdog 能自动恢复 ≥ 2 种常见失败模式

---

### Phase 3 — 智能化

> 目标: LLM 驱动的计划和验证，提升编排质量

| 任务 ID | 任务 | 类型 | 依赖 | 建议分配 |
|---------|------|------|------|----------|
| P3-T1 | LLM-Powered Planner：根据 goal 语义生成任务拆解 | 核心 | P2-T2 | Developer A |
| P3-T2 | 验证智能化：结构化自动验证 + LLM 辅助判定不确定项 | 核心 | P2-T2 | Developer B |
| P3-T3 | Mission 模板库：常见场景（调研/开发/修复/文档）的预定义模板 | 增强 | P3-T1 | Developer C |
| P3-T4 | Dashboard 增强：实时状态面板 + 历史数据统计 | 增强 | 无 | Developer C |

**交付标准:**
- 给出 goal 后，planner 自动生成合理的任务拆解（人工评审通过率 ≥ 80%）
- 验证环节：可自动判定的标准无需人工介入
- ≥ 3 套 mission 模板可用

---

## 四、推进节奏

```
Phase 1 (补齐短板)     ████████░░░░░░░░░░░░  ← 优先启动
Phase 2 (闭环自动化)   ░░░░░░██████████░░░░  ← Phase 1 完成后启动
Phase 3 (智能化)       ░░░░░░░░░░░░████████  ← Phase 2 核心完成后启动
```

Phase 之间允许重叠：Phase 1 剩余任务可与 Phase 2 并行。

---

## 五、风险与约束

| 风险 | 影响 | 应对 |
|------|------|------|
| Zod 校验改动范围大 | 所有读写 mission.json 的代码都要改 | 分批接入，先核心路径后边缘 |
| LLM Planner 质量不稳定 | 生成的任务可能不合理 | 保留 --tasks-json 手动覆盖能力 |
| 集成测试需真实 Discord 环境 | CI 中无法完全模拟 | Mock adapter + 定期手动集成验证 |

---

## 六、下一步行动

1. **Owner 确认**: 优先级排序和阶段划分是否合理
2. **组建团队**: Coordinator 就位后，开始 Phase 1 任务拆解和分配
3. **启动 Phase 1**: 从 P1-T1（VERIFYING 修复）和 P1-T2（Zod 校验）并行开始
