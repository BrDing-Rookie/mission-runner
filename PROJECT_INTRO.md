# Mission Runner 项目介绍

## 一、项目是什么

Mission Runner 是一个基于 OpenClaw 现有能力构建的**插件级自治任务编排层**。

它的目标，不是把 OpenClaw 直接改造成一个庞大的内核工作流系统，而是在现有 primitives（如 session、process、message、cron、文件工件、脚本调度）之上，先搭出一个**最小可运行、可恢复、可验证、可持续推进任务**的 MVP 骨架。

一句话理解：

**Mission Runner 想解决的是：让 Agent 不只是“收到消息就执行一下”，而是能围绕一个长期任务持续推进、自动恢复、自动校验、必要时再升级给人。**

---

## 二、项目为什么要做

传统聊天式 Agent 的问题在于：
- 善于响应一次请求
- 不擅长长期任务编排
- 遇到后台任务、超时、失败、等待外部条件时容易断链
- 很难形成“任务对象”级别的持续推进能力

Mission Runner 想补的就是这层能力：

- 给一个明确任务后，先把任务落成 mission 工件
- 自动拆计划、生成任务、记录完成标准
- 能派发执行
- 能等待后台过程
- 能在后台结果回来后继续推进
- 能在必要时恢复、重试、补缺
- 能在完成或高风险阻塞时通知用户

所以它更像是：

**OpenClaw 的自治任务控制层 / 编排层 / mission 生命周期管理层。**

---

## 三、项目定位

Mission Runner 的定位非常明确：

### 它不是
- 不是通用 DAG 工作流引擎
- 不是图形化编排平台
- 不是 OpenClaw 内核的大改版
- 不是一开始就覆盖所有任务类型的通用系统

### 它是
- 一个**插件级**实现
- 一个**MVP 骨架优先**的自治任务系统
- 一个基于 mission 工件的状态推进框架
- 一个先验证价值、再决定是否内核化的实验性但可运行方案

也就是说，这个项目的策略是：

**先把闭环跑通，再考虑抽象与通用化。**

---

## 四、核心设计思想

Mission Runner 当前的设计围绕四个关键词：

### 1. 工件落盘
任务不是只存在于对话上下文，而是落到文件系统中，形成可恢复的 mission 工件。

典型目录结构：

```text
missions/<mission-id>/
├── mission.json
├── plan.md
├── verification.md
├── events.jsonl
└── artifacts/
```

这样做的意义是：
- 任务状态可追踪
- 中断后可恢复
- watchdog 可以扫描
- 后续可测试、可审查、可调试

### 2. 状态机驱动
Mission Runner 不是靠“提示词感觉”推进，而是靠 mission/task/background process 状态推进。

当前 mission 级状态包括：
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

这些状态是整个编排逻辑的核心语义基础。

### 3. watchdog 保守判断
当前 watchdog 只负责：
- 扫描 mission
- 判断下一步动作应该是什么
- 给出 `CHECK_BACKGROUND / RESUME_TASK / TRIGGER_VERIFY / RETRY_TASK` 等建议

它的设计原则是：

**先做保守判断，不抢复杂控制权。**

### 4. verify 才是完成判定入口
Mission Runner 的设计里，watchdog 不是“完成判定者”，真正决定任务是否完成的是 verifier。

这能避免一个常见问题：
- 任务“看起来结束了”
- 但实际上只是没有继续推进

因此 verify 是防止“伪完成”的关键环节。

---

## 五、当前已经实现了什么

目前项目已经完成了第一阶段 MVP 骨架，核心脚本包括：

### 1. mission 创建
- `scripts/mission-create.ts`

负责：
- 创建 mission 目录
- 初始化 `mission.json`
- 初始化基础工件与事件流

### 2. mission 规划
- `scripts/mission-plan.ts`

负责：
- 生成任务拆解
- 生成 completion criteria
- 写入 `plan.md`
- 将 mission 推进到 `PLANNED`

### 3. mission 派发
- `scripts/mission-dispatch.ts`

负责：
- 消费 `READY` task
- 将任务推进到 `RUNNING` 或 `WAITING_BACKGROUND`
- 写入 background process 记录

### 4. mission 恢复
- `scripts/mission-resume.ts`

负责：
- 恢复失败但可重试的任务
- 解锁依赖完成后的 `PENDING` 任务
- 将 mission 拉回可执行状态

### 5. watchdog 判断
- `scripts/mission-watchdog.ts`

负责：
- 扫描 mission 状态
- 给出下一步建议动作
- 判断是否该：
  - 检查后台任务
  - 触发 verify
  - 恢复任务
  - 重试
  - 升级

### 6. 后台结果回收
- `scripts/mission-reconcile-background.ts`

负责：
- 根据终态 background process 回写 task 状态
- 推导 mission 状态收敛
- 将后台任务结果折算回 mission 流程

### 7. action 执行层
- `scripts/mission-run-action.ts`

负责：
- 执行 watchdog 提议的 action
- 当前已支持：`CHECK_BACKGROUND`
- 将“可判断的动作”推进为“可执行的动作”

### 8. 基础 verify
- `scripts/mission-verify.ts`

负责：
- 做最小验证
- 推进 mission 到 `COMPLETED / ITERATING` 等状态

---

## 六、当前已经成立的主路径

目前可以认为已经成立的最小主路径是：

```text
create
  -> plan
  -> dispatch
  -> WAITING_BACKGROUND
  -> reconcile-background
  -> run-action(CHECK_BACKGROUND)
  -> VERIFYING
```

另外还有一条恢复侧链：

```text
ITERATING / WAITING_EXTERNAL
  -> resume
  -> READY / RUNNING
```

这说明项目已经不是停留在方案文档层，而是已经具备：
- 创建
- 规划
- 派发
- 等待后台
- 回收后台
- 执行动作
- 向验证推进

这套骨架已经可运行、可测试、可审查。

---

## 七、这个项目当前最有价值的地方

### 1. 它把任务从“对话状态”变成了“mission 对象”
这是从聊天 Agent 走向自治任务系统的关键一步。

### 2. 它开始具备长期任务推进能力
尤其是：
- 后台等待
- 回收
- 恢复
- 重试
- 继续推进

### 3. 它在做“可恢复”而不是“一次性调用”
这让系统更适合真实生产环境中的中断、失败、延迟与异步任务。

### 4. 它已经开始重视幂等性和 no-op 语义
后期修复的重点不是“功能越多越好”，而是：
- 重复执行不能制造假进展
- no-op 不能污染审计和进度判断

这一点非常关键，因为这是自治系统是否可靠的基础。

---

## 八、当前还没有完成什么

虽然骨架已经成立，但项目还不是“完整自动闭环系统”。

当前仍然缺少或尚未完全收口的部分包括：

### 1. 完整的 watchdog -> action -> verify 自动编排 E2E
现在有局部链路，但还需要更完整的整链验证。

### 2. 全链统一的 no-op 审计策略
目前 `run-action/reconcile-background` 这条链路已经收得比较干净，
但其他脚本如 `resume` 仍可能存在 no-op 也写事件/刷新时间戳的情况。

### 3. 更标准化的测试入口
目前主要依赖：
- typecheck
- 定向测试

未来应进一步统一到：
- `npm test`
- `npm run lint`
- CI

### 4. 更完整的 verifier / notify / recover 组合
当前是 MVP 骨架，不是完整产品化版本。

---

## 九、当前阶段结论

当前最合适的阶段结论是：

# Mission Runner MVP 骨架已成立

它意味着：
- 核心 mission 工件模型已存在
- 主状态流已存在
- 背景任务路径已存在
- 一个 watchdog action 已经可以真正执行
- 基础幂等性与 no-op 去噪已经开始成立
- 项目已经具备继续进入“最小自动编排闭环”阶段的条件

这是一个非常适合作为阶段里程碑的状态。

---

## 十、下一阶段建议

如果继续推进，下一阶段优先级建议如下：

### P1：补完整编排 E2E
覆盖：
- watchdog 输出 action
- action executor 执行
- reconcile/verify 推进
- mission 状态流闭环

### P2：统一 no-op 审计策略
将“只有真实推进才写关键事件/刷新 progress”的原则推广到：
- `resume`
- `dispatch`
- `verify`
- 未来 `notify/recover`

### P3：补标准质量入口
建立：
- `npm test`
- `npm run lint`
- CI job

### P4：显式化状态机约束
让状态迁移更可验证、更不容易被后续新增脚本破坏。

---

## 十一、适合向外怎么介绍它

如果要用一句比较容易理解的话介绍该项目，可以这样说：

**Mission Runner 是一个运行在 OpenClaw 之上的任务自治编排层，用 mission 工件、状态机、watchdog 与 action executor，把聊天式 Agent 提升为能持续推进长期任务的系统。**

如果要更偏产品一点，可以说：

**它是 OpenClaw 的“任务操作系统雏形”——让任务能被创建、拆解、执行、等待、恢复、验证，而不是只在一次对话里被动响应。**
