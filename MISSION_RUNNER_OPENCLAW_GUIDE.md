# Mission Runner 接入 OpenClaw 操作手册

## 1. 文档目的

本文档用于说明：

- Mission Runner 是什么
- 它当前如何接入 OpenClaw
- 研发同学如何在本地或服务器上实际使用它
- 目前能跑到哪一步
- 已知限制与下一步接入建议

本文档面向：
- 研发工程师
- OpenClaw 集成开发者
- 后续接手该项目的维护者

---

## 2. 项目定位

Mission Runner 是一个运行在 OpenClaw 之上的**插件级任务编排层**。

它的目标不是替代 OpenClaw，而是补上一层“任务生命周期管理”能力，让 Agent 不只是响应一次消息，而是可以围绕一个 mission 持续推进。

### 它解决的问题

聊天式 Agent 常见问题：
- 收到任务后能执行一次
- 但不擅长长期任务
- 不擅长后台等待
- 不擅长失败恢复
- 不擅长在多轮之间保持任务对象级状态

Mission Runner 试图把这些能力补上：
- mission 创建
- 任务规划
- 任务派发
- 后台任务等待与回收
- 恢复与重试
- 验证与迭代
- 最终完成或升级

---

## 3. 与 OpenClaw 的关系

可以把二者关系理解为：

```text
OpenClaw = Agent 运行时 / 工具底座
Mission Runner = 任务编排与 mission 生命周期层
```

Mission Runner 当前依赖 OpenClaw 提供的能力包括：
- session / agent 能力
- process / background task 概念
- message 能力
- workspace 文件系统
- cron / watchdog 式调度思路
- 插件脚本式集成方式

### 当前接入定位

Mission Runner **不是 OpenClaw 内核原生内建模块**，而是：

- 以脚本 + mission 工件形式运行
- 由 OpenClaw 的 Agent、定时任务或人工命令去驱动
- 属于“插件级自治任务编排层”

---

## 4. 当前仓库位置

项目目录：

```bash
/home/ubuntu/public-deliverables/mission-runner
```

远端仓库：

```bash
git@codeup.aliyun.com:6933e024f3eec50950f6ce30/openclaw_workspace/mission-runner.git
```

---

## 5. 当前目录结构说明

核心目录结构如下：

```text
mission-runner/
├── README.md
├── handoff.md
├── mission-runner-plugin-implementation-draft.md
├── references/
│   └── architecture.md
├── schemas/
│   ├── mission.schema.json
│   ├── task.schema.json
│   └── verification.schema.json
├── scripts/
│   ├── mission-create.ts
│   ├── mission-plan.ts
│   ├── mission-dispatch.ts
│   ├── mission-resume.ts
│   ├── mission-watchdog.ts
│   ├── mission-reconcile-background.ts
│   ├── mission-run-action.ts
│   ├── mission-verify.ts
│   └── lib/
│       ├── fs-utils.ts
│       ├── mission-helpers.ts
│       └── types.ts
└── missions/
    └── <mission-id>/
```

典型 mission 工件目录：

```text
missions/<mission-id>/
├── mission.json
├── plan.md
├── verification.md
├── events.jsonl
└── artifacts/
```

---

## 6. 关键脚本说明

### `scripts/mission-create.ts`
用途：创建 mission。

职责：
- 创建 mission 目录
- 初始化 `mission.json`
- 初始化 `events.jsonl`
- 建立基础工件结构

---

### `scripts/mission-plan.ts`
用途：为 mission 生成初始计划。

职责：
- 写入任务列表 `tasks[]`
- 写入 `completionCriteria`
- 生成 `plan.md`
- 将 mission 推进到 `PLANNED`

---

### `scripts/mission-dispatch.ts`
用途：消费 READY 任务并派发。

职责：
- 将 `READY` 任务推进到 `RUNNING` 或 `WAITING_BACKGROUND`
- 为后台任务生成 `backgroundProcesses`
- 更新 mission 状态

---

### `scripts/mission-watchdog.ts`
用途：定期扫描 mission 并判断下一步动作。

职责：
- 扫描当前 mission 状态
- 判断是否应该：
  - `CHECK_BACKGROUND`
  - `RESUME_TASK`
  - `TRIGGER_VERIFY`
  - `RETRY_TASK`
  - `ESCALATE_*`

注意：
当前 watchdog 主要负责**判断**，不是完整动作执行器。

---

### `scripts/mission-reconcile-background.ts`
用途：回收后台任务结果。

职责：
- 读取终态 `backgroundProcesses`
- 将对应 task 收敛到：
  - `COMPLETED`
  - `FAILED`
- 推导 mission 进入：
  - `WAITING_BACKGROUND`
  - `RUNNING`
  - `VERIFYING`
- 已补基础幂等性

---

### `scripts/mission-run-action.ts`
用途：执行 watchdog 判断出的动作。

当前支持：
- `CHECK_BACKGROUND`

职责：
- 执行 `CHECK_BACKGROUND`
- 调用 `mission-reconcile-background`
- 输出 action 执行结果
- 在有真实推进时写 `mission_action_executed`

---

### `scripts/mission-resume.ts`
用途：恢复 mission 的可执行状态。

职责：
- 恢复失败但可重试的任务
- 解锁依赖完成的 pending 任务
- 将 mission 拉回 `RUNNING` 或继续可派发状态

---

### `scripts/mission-verify.ts`
用途：执行最小验证。

职责：
- 检查任务状态与基础产物
- 将 mission 推进到：
  - `COMPLETED`
  - `ITERATING`
  - 等下一轮状态

---

## 7. 当前已成立的主路径

当前最关键的最小主路径：

```text
mission-create
  -> mission-plan
  -> mission-dispatch
  -> WAITING_BACKGROUND
  -> mission-run-action --action CHECK_BACKGROUND
  -> mission-reconcile-background
  -> VERIFYING
```

恢复侧链：

```text
ITERATING / WAITING_EXTERNAL
  -> mission-resume
  -> READY / RUNNING
```

这代表项目当前已经具备：
- mission 创建
- 任务拆解
- 派发
- 后台等待
- 后台回收
- 动作执行
- 验证前推进

---

## 8. 当前推荐接入方式

### 方式 A：人工 / 总控 Agent 显式驱动（当前最推荐）

当前最稳妥的使用方式不是“全自动”，而是由：
- 总控 Agent
- 或研发手动
- 或 cron + 调度脚本

显式调用 Mission Runner 的脚本链路。

这是当前阶段最现实、最可靠的接法。

---

## 9. 实际操作步骤

以下步骤默认在项目目录执行：

```bash
cd /home/ubuntu/public-deliverables/mission-runner
```

### 9.1 安装依赖
若首次使用：

```bash
npm install
```

### 9.2 创建 mission

```bash
npm run create-mission -- --title "Demo mission" --goal "验证 mission runner 接入 openclaw"
```

执行后会在 `missions/` 下生成一个新的 mission 目录。

### 9.3 规划 mission

```bash
npm run mission-plan -- --mission-id <mission-id>
```

会生成：
- `plan.md`
- 初始 `tasks[]`
- `completionCriteria`

### 9.4 派发任务

```bash
npm run mission-dispatch -- --mission-id <mission-id>
```

此时任务会被推进到：
- `RUNNING`
- 或 `WAITING_BACKGROUND`

### 9.5 运行 watchdog 判断

```bash
npm run watchdog -- --missions-dir ./missions --dry-run
```

watchdog 会输出下一步建议动作，例如：
- `CHECK_BACKGROUND`
- `TRIGGER_VERIFY`
- `RESUME_TASK`

### 9.6 执行 background 检查动作

当 mission 需要检查后台任务时：

```bash
npm run mission-run-action -- --missions-dir ./missions --mission-id <mission-id> --action CHECK_BACKGROUND
```

它会：
- 调用 `mission-reconcile-background`
- 回写 task 与 mission 状态
- 在真实推进时记录 action 事件

### 9.7 恢复任务

如果 mission 进入：
- `ITERATING`
- `WAITING_EXTERNAL`
- 或存在可恢复任务

执行：

```bash
node --import tsx scripts/mission-resume.ts --missions-dir ./missions --mission-id <mission-id>
```

### 9.8 验证 mission

```bash
npm run verify-mission -- --missions-dir ./missions --mission-id <mission-id>
```

会将 mission 推进到：
- `COMPLETED`
- 或 `ITERATING`

---

## 10. 当前可以如何在 OpenClaw 中挂接

### 方案 1：由总控 Agent 驱动
这是当前最现实的方式。

例如：
- 总控 Agent 收到“持续推进某任务”的请求
- 调用 `mission-create`
- 调用 `mission-plan`
- 调用 `mission-dispatch`
- 后续周期性触发 watchdog
- 当 watchdog 输出 `CHECK_BACKGROUND` 时，再调用 `mission-run-action`

这种方式最适合当前阶段。

---

### 方案 2：由 cron / heartbeat 驱动 watchdog
可进一步接成：

```text
cron / heartbeat
  -> mission-watchdog
  -> 输出 action
  -> mission-run-action
```

这已经接近最小自动编排闭环，但当前仍建议先以“显式调度”为主。

---

### 方案 3：封装为高层 skill / controller
未来可以把 Mission Runner 再包一层，例如：
- 一个 OpenClaw skill
- 一个 controller
- 一个统一命令入口

例如未来做成：

```bash
npm run mission-start -- --goal "..."
```

内部自动完成：
- create
- plan
- dispatch
- watchdog 推进

---

## 11. 当前支持到什么程度

### 已支持
- mission 工件落盘
- mission 规划
- READY task 派发
- 后台任务等待与回收
- `CHECK_BACKGROUND` 动作执行
- 恢复与重试侧链
- 基础验证
- `reconcile-background` 基础幂等性
- no-op `CHECK_BACKGROUND` 审计去噪

### 尚未完全支持
- watchdog -> executor -> verify 全自动整链闭环
- 全链统一 no-op 审计策略
- 完整 notify / recover / verifier 深化
- 标准化 `npm test` / `npm run lint` / CI
- OpenClaw 内核级注册与一等公民化

---

## 12. 当前质量状态

本阶段结论可定义为：

# Mission Runner MVP 骨架已成立

其含义：
- 核心 mission 状态机骨架已存在
- 主链路可跑通
- 一个 watchdog action 已真正可执行
- 背景任务路径已建立
- 基础幂等性与 no-op 去噪已开始成立

这已经适合作为第一阶段收口点。

---

## 13. 当前已知限制

### 1. 还不是完整自动闭环
当前更适合：
- Agent 显式调用
- 或脚本链式驱动

而不是完全无人值守自动编排。

### 2. 其他脚本仍可能存在 no-op 审计噪音
这轮重点收敛的是：
- `mission-reconcile-background`
- `mission-run-action`

但像 `mission-resume` 等脚本，后续仍应统一 no-op 策略。

### 3. 缺统一测试入口
当前已有定向测试，但还应继续收敛到：
- `npm test`
- lint
- CI

---

## 14. 推荐的下一阶段接入方向

### P1：补 watchdog -> action -> verify 整链 E2E
将当前分段成立的能力补成整链自动编排验证。

### P2：统一全链 no-op 审计策略
确保只有真实推进才写关键事件/刷新 `lastProgressAt`。

### P3：补标准质量入口
建立：
- `npm test`
- `npm run lint`
- CI

### P4：显式化状态机约束
加强状态迁移校验，降低后续演进风险。

---

## 15. 适合对研发同学的一句话说明

**Mission Runner 是 OpenClaw 之上的任务编排层，通过 mission 工件、状态机、watchdog 和 action executor，把聊天式 Agent 提升为能持续推进长期任务的系统。**

---

## 16. 适合对外/对管理者的一句话说明

**Mission Runner 是 OpenClaw 的自治任务骨架，让任务能够被创建、拆解、执行、等待、恢复、验证，而不是只在一次对话中被动响应。**
