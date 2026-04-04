# 文档管理体系设计方案

> 创建日期: 2026-04-03
> 状态: 已实施

---

## 一、设计目标

建立两棵独立的文档树，实现「开发过程可追溯」与「功能说明常更新」的分离管理：

- **开发文档树** (`dev-docs/`) — 追踪「要开发什么、正在开发什么、开发完了什么」
- **项目说明树** (`project-docs/`) — 描述「系统当前能做什么」，面向使用者和维护者

两棵树通过工作流规则联动：开发完成后，自动更新项目说明树。

---

## 二、目录结构设计

### 2.1 开发文档树

```
dev-docs/
├── README.md                          # 总文档（开发目标 + 索引文件指引）
├── BACKLOG.md                         # 正在开发 & 待开发索引（独立文件）
├── DONE.md                            # 已完成索引（独立文件，可无限增长）
│
├── state-machine/                     # 模块：状态机
│   ├── README.md                      # 模块开发概述
│   ├── 2026-04-03-transition-guard.md # 按日期命名的开发文档
│   └── 2026-04-05-escalated-recovery.md
│
├── file-system/                       # 模块：文件系统
│   ├── README.md
│   └── 2026-04-04-atomic-write.md
│
├── planner/                           # 模块：计划器
│   ├── README.md
│   └── 2026-04-10-llm-planner.md
│
├── dispatcher/                        # 模块：派发器
│   ├── README.md
│   └── ...
│
├── watchdog/                          # 模块：看门狗
├── verifier/                          # 模块：验证器
├── reconciler/                        # 模块：回收器
├── notification/                      # 模块：通知
├── orchestrator/                      # 模块：编排器
├── external-integration/              # 模块：外部集成
└── dashboard/                         # 模块：仪表盘
```

### 2.2 总文档 (`dev-docs/README.md`)

总文档保持精简，只放开发目标和指向两个索引文件的链接：

```markdown
# Mission Runner 开发文档

## 项目开发目标
<当前阶段的整体目标描述>

## 索引

- **[BACKLOG.md](./BACKLOG.md)** — 正在开发 & 待开发任务索引
- **[DONE.md](./DONE.md)** — 已完成任务索引
```

### 2.2.1 待开发索引 (`dev-docs/BACKLOG.md`)

```markdown
# 正在开发 & 待开发

| 模块 | 文档 | 状态 | 创建日期 |
|------|------|------|----------|
| state-machine | [状态迁移强制校验](state-machine/2026-04-03-transition-guard.md) | 进行中 | 2026-04-03 |
| file-system | [原子写入+文件锁](file-system/2026-04-04-atomic-write.md) | 待开发 | 2026-04-04 |
```

### 2.2.2 已完成索引 (`dev-docs/DONE.md`)

```markdown
# 已完成

| 模块 | 文档 | 完成日期 |
|------|------|----------|
| state-machine | [VERIFYING 状态 task-add 修复](state-machine/2026-04-01-verifying-task-add.md) | 2026-04-03 |
```

> DONE.md 独立存放，可无限增长，不影响 README.md 和 BACKLOG.md 的可读性。

### 2.3 模块开发概述 (`dev-docs/<module>/README.md`)

```markdown
# <模块名> 开发文档

## 模块范围
<涉及的源文件、职责边界>

## 开发历史
| 文档 | 状态 | 日期 |
|------|------|------|
| [xxx](./2026-04-03-xxx.md) | 已完成 | 2026-04-03 |
```

### 2.4 每日开发文档 (`dev-docs/<module>/YYYY-MM-DD-<slug>.md`)

```markdown
# <开发任务标题>

> 模块: <module>
> 创建日期: YYYY-MM-DD
> 状态: 待开发 | 进行中 | 已完成
> 关联 Phase: P1/P2/P3
> 关联差距编号: #N（对应 system-completeness-assessment.md）

## 目标
<本次开发要解决什么问题>

## 涉及文件
- `scripts/lib/xxx.ts` — 修改点说明
- `scripts/xxx.test.ts` — 需要新增/修改的测试

## 方案
<技术方案描述>

## 验收标准
- [ ] 标准 1
- [ ] 标准 2

## 开发记录
### YYYY-MM-DD
- 实际做了什么
- 遇到的问题和决策
```

---

### 2.5 项目说明树

```
project-docs/
├── README.md                    # 项目总览（功能概要 + 模块索引）
│
├── state-machine.md             # 状态机功能说明
├── file-system.md               # 文件系统功能说明
├── planner.md                   # 计划器功能说明
├── dispatcher.md                # 派发器功能说明
├── watchdog.md                  # 看门狗功能说明
├── verifier.md                  # 验证器功能说明
├── reconciler.md                # 回收器功能说明
├── notification.md              # 通知系统功能说明
├── orchestrator.md              # 编排器功能说明
├── external-integration.md      # 外部集成功能说明
└── dashboard.md                 # 仪表盘功能说明
```

### 2.6 模块说明文档结构 (`project-docs/<module>.md`)

```markdown
# <模块名>

## 功能概述
<这个模块做什么，解决什么问题>

## 核心能力
- 能力 1: 描述
- 能力 2: 描述

## 使用方式
<命令行用法 / API 调用方式>

## 当前限制
<已知的功能边界和限制>

## 相关模块
<与哪些模块有交互关系>
```

---

## 三、工作流规则

### 3.1 开发前（必须）

```
1. 确定要开发的模块
2. 在 dev-docs/<module>/ 下创建开发文档：
   格式: YYYY-MM-DD-<slug>.md
   填写: 目标、涉及文件、方案、验收标准
3. 在 dev-docs/BACKLOG.md 表格中添加索引
4. 更新 dev-docs/<module>/README.md 的开发历史表
```

**强制规则**: 不创建开发文档，不允许开始编码。

### 3.2 开发中

```
1. 将文档状态改为「进行中」
2. 在「开发记录」章节追加当日进展
3. 如果跨天开发，每天追加一个日期段落
```

### 3.3 开发完成后

```
1. 将文档状态改为「已完成」
2. 从 dev-docs/BACKLOG.md 中移除该条目
3. 将该条目添加到 dev-docs/DONE.md 中
4. 更新 dev-docs/<module>/README.md 中对应条目的状态
5. 根据实际开发内容，更新 project-docs/<module>.md：
   - 新增能力 → 添加到「核心能力」
   - 修复限制 → 从「当前限制」中移除
   - 行为变更 → 更新「使用方式」
```

### 流程图

```
            ┌─────────────┐
            │  确定开发任务  │
            └──────┬──────┘
                   ▼
     ┌──────────────────────────┐
     │ 创建 dev-docs 开发文档     │
     │ + 添加到 BACKLOG.md 索引  │
     └────────────┬─────────────┘
                  ▼
         ┌────────────────┐
         │  状态 → 进行中   │
         │  开始编码        │
         └───────┬────────┘
                 ▼
          ┌─────────────┐
          │  编码 & 测试   │
          │  记录开发日志   │
          └──────┬──────┘
                 ▼
     ┌───────────────────────────────┐
     │ 状态 → 已完成                  │
     │ BACKLOG.md 移除 → DONE.md 添加 │
     │ 更新 project-docs 说明文档      │
     └───────────────────────────────┘
```

---

## 四、与现有文档的关系

| 现有文档 | 定位 | 处理方式 |
|---------|------|---------|
| `docs/architecture.md` | 架构设计 | 保留，作为 project-docs 的补充参考 |
| `docs/api.md` | API 参考 | 保留，作为 project-docs 的补充参考 |
| `docs/development.md` | 开发指南 | 保留，描述开发环境和规范 |
| `docs/plan-system-completion.md` | 推进计划 | 保留，作为 dev-docs 开发任务的来源 |
| `docs/system-completeness-assessment.md` | 评估报告 | 保留，作为 dev-docs 开发文档的差距引用源 |
| `CLAUDE.md` | Agent 工作指引 | 保留不动，开发文档体系建立后补充工作流规则 |

新增的 `dev-docs/` 和 `project-docs/` 与 `docs/` 平级放置在项目根目录下。

---

## 五、模块划分

基于当前代码结构和评估报告，初始模块划分如下：

| 模块 ID | 模块名称 | 涉及源文件 |
|---------|---------|-----------|
| `state-machine` | 状态机 | types.ts, mission-helpers.ts |
| `file-system` | 文件系统 | fs-utils.ts |
| `planner` | 计划器 | mission-planner.ts |
| `dispatcher` | 派发器 | mission-dispatcher.ts, mission-dispatch-agent.ts, dispatch-queue.ts, dispatch-messenger.ts |
| `watchdog` | 看门狗 | mission-watchdog-evaluator.ts |
| `verifier` | 验证器 | mission-verifier.ts |
| `reconciler` | 回收器 | mission-reconcile-background.ts |
| `notification` | 通知 | mission-notification.ts, mission-notification-templates.ts, mission-notification-mentions.ts |
| `orchestrator` | 编排器 | mission-orchestrate.ts, mission-start.ts |
| `external-integration` | 外部集成 | agent-session.ts, discord-id-resolver.ts, mission-agent-discovery.ts, safe-exec.ts |
| `dashboard` | 仪表盘 | dashboard-formatter.ts |

---

## 六、强制执行机制

要让 Claude Code (CC) 和 OpenClaw Agent 严格遵守此工作流，需要在三个层面建立约束：

### 层级 1: CLAUDE.md 指令（最核心）

CLAUDE.md 是 Claude Code 每次会话启动时必读的指令文件。在其中写入的规则，CC 和所有基于 CC 的 OpenClaw Agent 都会遵守。

在 CLAUDE.md 中添加：

```markdown
## Development Doc Workflow (MANDATORY)

### 编码前 — 必须先创建开发文档

在对 `scripts/` 下的任何源文件进行功能开发、Bug 修复、重构之前，必须：

1. 确定变更所属模块（见 dev-docs/ 下的模块目录）
2. 在 `dev-docs/<module>/` 下创建开发文档，命名格式 `YYYY-MM-DD-<slug>.md`
3. 在 `dev-docs/BACKLOG.md` 中添加该文档的索引条目
4. 开发文档必须包含：目标、涉及文件、方案、验收标准

**违反此规则直接开始编码是不允许的。** 如果收到开发指令但没有对应的开发文档，
第一步永远是创建开发文档，而不是开始写代码。

### 编码后 — 必须更新文档索引

开发完成（代码 + 测试通过）后，必须：

1. 将开发文档状态改为「已完成」
2. 从 `dev-docs/BACKLOG.md` 移除该条目，添加到 `dev-docs/DONE.md`
3. 根据实际变更更新 `project-docs/<module>.md` 的功能说明

### 不适用的场景

以下操作无需创建开发文档：
- 纯文档修改（不涉及代码变更）
- 格式化、typo 修复等微小改动
- 配置文件调整（如 tsconfig.json、package.json）
```

**为什么这一层最有效**: CC 和 OpenClaw Agent 在每次对话开始时都会读取 CLAUDE.md，这些指令会作为系统级约束影响所有后续行为。只要规则写得明确（用 MUST/MANDATORY 等强约束词），Agent 会严格遵守。

### 层级 2: Claude Code Hooks（自动化校验）

通过 Claude Code 的 `settings.json` 配置 hooks，在关键操作前自动检查开发文档是否存在。

在项目级 `.claude/settings.json` 中添加 hook：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hook": "bash .claude/hooks/check-dev-doc.sh \"$TOOL_INPUT\""
      }
    ]
  }
}
```

Hook 脚本 `.claude/hooks/check-dev-doc.sh` 的逻辑：

```bash
#!/bin/bash
# 检查：当编辑 scripts/ 下的 .ts 文件时，
# 确认 dev-docs/BACKLOG.md 中有对应的进行中条目

INPUT="$1"
# 提取被编辑的文件路径
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // empty')

# 只检查 scripts/ 下的 .ts 文件（排除 .test.ts）
if [[ "$FILE_PATH" == */scripts/lib/*.ts ]] && [[ "$FILE_PATH" != *.test.ts ]]; then
  if [ ! -f "dev-docs/BACKLOG.md" ]; then
    echo "BLOCKED: dev-docs/BACKLOG.md 不存在。请先创建开发文档。"
    exit 1
  fi
  # 检查 BACKLOG 中是否有「进行中」的条目
  if ! grep -q "进行中" dev-docs/BACKLOG.md; then
    echo "BLOCKED: dev-docs/BACKLOG.md 中没有「进行中」的开发任务。"
    echo "请先在 dev-docs/<module>/ 下创建开发文档并在 BACKLOG.md 中登记。"
    exit 1
  fi
fi
exit 0
```

**效果**: 当 Agent 试图直接编辑代码而没有先创建开发文档时，hook 会阻止操作并提示 Agent 先走文档流程。

### 层级 3: OpenClaw 任务派发约束

在 Mission Runner 派发任务给 OpenClaw Agent 时，在 dispatch message 中嵌入文档工作流要求：

在 `dispatch-messenger.ts` 的 `buildDispatchMessage()` 中，为每条派发消息附加固定后缀：

```
⚠️ 开发文档规则：编码前必须先在 dev-docs/<module>/ 下创建当日开发文档，
并在 BACKLOG.md 中登记。完成后更新 DONE.md 和 project-docs。
详见 CLAUDE.md "Development Doc Workflow" 章节。
```

这样即使 Agent 通过 OpenClaw 间接启动（而非直接在本仓库运行 CC），也会在任务描述中看到文档规则。

### 三层防线总结

```
┌─────────────────────────────────────────────┐
│ 层级 1: CLAUDE.md 指令                       │
│ → Agent 在会话启动时读取，作为行为准则        │
│ → 覆盖: CC 直接使用 + OpenClaw Agent          │
├─────────────────────────────────────────────┤
│ 层级 2: Claude Code Hooks                    │
│ → 编辑 scripts/*.ts 时自动校验               │
│ → 阻止: 没有开发文档就直接改代码              │
│ → 覆盖: CC 直接使用                          │
├─────────────────────────────────────────────┤
│ 层级 3: Dispatch Message 嵌入                │
│ → 派发消息中带文档规则提醒                    │
│ → 覆盖: OpenClaw Agent 接收任务时             │
└─────────────────────────────────────────────┘
```

层级 1 是基础（无需额外代码），层级 2 是自动化门禁（需配置 hook），层级 3 是远程 Agent 的补充提醒。

---

## 七、实施步骤

1. **创建目录结构** — 创建 `dev-docs/` 和 `project-docs/` 及其子目录和 README
2. **编写索引文件** — `dev-docs/BACKLOG.md` 和 `dev-docs/DONE.md`
3. **初始化模块说明** — 基于现有代码为每个模块生成 `project-docs/<module>.md`
4. **更新 CLAUDE.md** — 添加 Development Doc Workflow 规则（层级 1）
5. **配置 Hook** — 创建 `.claude/hooks/check-dev-doc.sh` + 更新 `.claude/settings.json`（层级 2）
6. **更新 dispatch message** — 在派发消息模板中嵌入文档规则提醒（层级 3）
7. **首次实践验证** — 用 Phase 2 第一个任务走一遍完整流程

> 待 Owner 审批后启动实施。
