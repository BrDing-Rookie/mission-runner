# Mission Planner Template

将用户目标拆解为可执行的子任务计划。

---

## 输入

```yaml
user_goal: "{{goal}}"
context:
  available_tools: ["web_search", "web_fetch", "file_read", "file_write", "exec_background", "agent_dispatch"]
  available_agents: ["researcher", "analyst", "coder"]
  mission_id: "{{missionId}}"
  created_at: "{{createdAt}}"
```

---

## 输出格式

```yaml
mission_overview:
  title: "任务标题（一句话）"
  summary: "任务目标概述"
  expected_outcome: "预期最终产出"

tasks:
  - task_id: "T1"
    title: "子任务标题"
    type: "research | analysis | background"
    description: "详细描述"
    agent: "researcher | analyst | coder | self"
    estimated_duration: "short | medium | long"
    completion_criteria:
      - "明确的完成标准 1"
      - "明确的完成标准 2"
    artifacts_expected:
      - path: "artifacts/T1-output.md"
        description: "预期产物说明"
    depends_on: []  # 依赖的任务 ID 列表

  - task_id: "T2"
    ...

  # MVP 限制：最多 3 个子任务

risk_assessment:
  level: "low | medium | high"
  auto_allowed: []      # 低风险，自动执行
  ask_once: []          # 中风险，问一次即可
  must_confirm: []      # 高风险，每次都要确认

escalation_conditions:
  - "达到迭代上限仍未完成"
  - "验证发现核心前提失败"
  - "遇到未预期的任务类型"

completion_criteria:
  - "所有子任务完成"
  - "产物符合预期格式"
  - "通过 verifier 验证"
```

---

## 规划原则

### 1. 任务拆解粒度

- **简单任务**（1 小时内）：不拆分子任务，直接执行
- **中等任务**（半天内）：2~3 个子任务
- **复杂任务**（超过半天）：MVP 阶段建议拆分为多个 mission

### 2. 任务类型定义

| 类型 | 适用场景 | 执行方式 |
|------|----------|----------|
| `research` | 信息收集、调研 | 子 Agent session |
| `analysis` | 分析、整理、汇总 | 当前 session / 子 Agent |
| `background` | 长时间运行（测试、数据处理）| `exec background` |

### 3. 依赖管理（MVP 简化）

- 优先串行执行，避免复杂 DAG
- 如必须并行，明确标注 `depends_on: []`
- 不处理循环依赖（检测到应报错）

### 4. 完成标准定义

每个子任务的 `completion_criteria` 必须满足 SMART 原则：

- **S**pecific：具体不模糊
- **M**easurable：可验证
- **A**chievable：可达成
- **R**elevant：与目标相关
- **T**ime-bound：有时限概念

**良好示例**：
- ✅ "收集至少 3 个可靠来源的信息"
- ✅ "生成包含数据来源的最终报告"
- ✅ "所有代码通过测试并输出测试报告到 artifacts/test-result.json"

**不良示例**：
- ❌ "做一些调研"
- ❌ "整理好文档"
- ❌ "完成代码"

### 5. 风险分级

根据任务类型和涉及资源自动分级：

| 级别 | 判定条件 | 处理方式 |
|------|----------|----------|
| **Low** | 纯信息查询、本地文件操作 | 自动执行 |
| **Medium** | 涉及外部 API、中等耗时操作 | 首次确认 |
| **High** | 涉及生产环境、敏感数据、不可逆操作 | 每次确认 |

---

## 示例

### 输入

```yaml
user_goal: "调研 Claude API 最新功能并输出一份摘要报告"
```

### 输出

```yaml
mission_overview:
  title: "Claude API 最新功能调研"
  summary: "收集 Claude API 的最新更新和功能，整理成摘要报告"
  expected_outcome: "一份包含最新功能列表、使用示例和参考来源的 Markdown 报告"

tasks:
  - task_id: "T1"
    title: "搜索 Claude API 最新更新"
    type: "research"
    description: "使用 web_search 和 web_fetch 收集 Claude API 最新功能和更新公告"
    agent: "researcher"
    estimated_duration: "medium"
    completion_criteria:
      - "收集至少 5 个关于 Claude API 最新功能的可靠来源"
      - "记录每个来源的关键信息到 artifacts/T1-sources.json"
      - "提取出主要功能更新列表"
    artifacts_expected:
      - path: "artifacts/T1-sources.json"
        description: "来源列表，包含 URL、标题、关键摘要"
    depends_on: []

  - task_id: "T2"
    title: "整理并生成调研报告"
    type: "analysis"
    description: "分析收集的信息，整理成结构化的调研报告"
    agent: "analyst"
    estimated_duration: "short"
    completion_criteria:
      - "生成 Markdown 格式报告"
      - "报告包含：功能概述、详细功能列表、使用示例、参考来源"
      - "报告保存到 artifacts/final-report.md"
    artifacts_expected:
      - path: "artifacts/final-report.md"
        description: "最终调研报告"
    depends_on: ["T1"]

risk_assessment:
  level: "low"
  auto_allowed: ["web_search", "web_fetch", "file_write"]
  ask_once: []
  must_confirm: []

escalation_conditions:
  - "搜索未找到足够信息（<3 个来源）"
  - "生成报告后发现关键信息矛盾"
  - "达到 3 次迭代仍未通过验证"

completion_criteria:
  - "T1 和 T2 都标记为完成"
  - "final-report.md 存在且非空"
  - "报告包含至少 3 个主要功能点"
  - "报告包含参考来源列表"
```

---

## 输出转换

LLM 输出的 YAML 将被转换为以下工件：

1. **plan.md** —— 人类可读的计划文档
2. **mission.json** 更新：
   - `tasks[]` —— 子任务列表
   - `completionCriteria[]` —— 完成标准
   - `riskPolicy` —— 风险策略
   - `status` —— 设为 "PLANNED"

---

## 注意事项

1. **子任务数量**：MVP 阶段限制最多 3 个，超出应建议拆分 mission
2. **依赖明确**：避免隐式依赖，所有依赖必须显式声明
3. **产物路径**：统一放在 `artifacts/` 目录下
4. **完成标准**：这是 verifier 的判断依据，务必具体清晰
