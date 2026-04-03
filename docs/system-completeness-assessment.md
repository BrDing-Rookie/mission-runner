# Mission Runner 系统完整度评估

> 评估日期: 2026-04-03
> 评估人: 系统评估 Agent
> 代码快照: commit 1bbffb1 (master)
> 代码规模: ~10,750 行 TypeScript / 22 个 lib 模块 / 17 个脚本入口 / 17 个测试文件 / 170 tests (169 pass, 1 skip)

## 总体评分: 58/100

系统在"状态机骨架 + 模块拆分 + 基础测试"层面已经成型，但距离"真正完整落地可用"还有明显差距。核心瓶颈是：**闭环自动化依赖外部 CLI（openclaw）且无法在测试中验证、Zod 校验仍为 warn 降级模式、planner 是硬编码规则而非 LLM 驱动、缺乏文件锁和并发保护**。

---

## 各维度评分

### 1. 功能完整性 -- 65/100

**当前状态**

核心流程 `create -> plan -> dispatch -> execute -> verify -> complete` 的每个环节都有对应脚本和 lib 实现，端到端可跑通（有 E2E 测试证明）。状态机定义清晰（11 个状态、`ALLOWED_TRANSITIONS` 迁移表、`isTransitionAllowed()` 校验函数），覆盖了主链路、补缺迭代链路、升级/失败链路。

各模块完整度：

| 模块 | 完整度 | 说明 |
|------|--------|------|
| 状态机 (types.ts) | 90% | 迁移表完整，但 `isTransitionAllowed()` 仅在 `task-add.ts` 中有 1 处调用，其他状态变更路径未强制校验 |
| Planner (mission-planner.ts) | 40% | 硬编码规则型实现，3 个模板（serial-3/parallel-research/parallel-build），无 LLM 驱动 |
| Dispatcher (mission-dispatcher.ts + dispatch-agent.ts) | 75% | 三级回退完整，dispatch retry 有指数退避和最大次数限制，但 L1/L2 依赖 `openclaw` CLI |
| Watchdog (mission-watchdog-evaluator.ts) | 80% | 覆盖所有活跃状态的评估逻辑，支持 task-level stall detection + auto-collect + auto-verify |
| Verifier (mission-verifier.ts) | 70% | 支持 completionCriteria 评估 + 结构验证（测试命令 / artifact 存在性），但缺 LLM 辅助判定 |
| Notification (mission-notification.ts) | 60% | 4 种适配器，幂等去重（notifiedTransitions），但 Discord 适配器只记录元数据不实际发送 |
| Reconcile (mission-reconcile-background.ts) | 70% | 能回收后台进程结果，但 backgroundProcesses 状态需外部更新（无自动检测进程是否结束） |
| Actions (mission-actions.ts) | 75% | retry/escalate/notify/collect-results 都有实现，collect-results 通过 git log 自动回收 |

**差距**

1. **`isTransitionAllowed()` 未在所有状态变更路径强制使用** -- `mission-helpers.ts` 的 `setMissionStatus()` 和 `deriveMissionStatus()` 直接设置状态，不校验迁移合法性。仅 `task-add.ts` 在 VERIFYING->RUNNING 时显式调用了一次。这意味着代码 bug 可能产生非法状态迁移而不被检测到。
   - 涉及文件: `scripts/lib/mission-helpers.ts:102-103`, `scripts/lib/mission-helpers.ts:94-101`
   - 工作量: 1 个工作日

2. **Planner 是硬编码模板** -- `mission-planner.ts` 用 `inferWorkstreamType()` 做关键字正则匹配决定任务类型，固定生成 3 个任务（context/execute/verify）。无法根据 goal 语义智能拆解任务。
   - 涉及文件: `scripts/lib/mission-planner.ts:305-329`, `scripts/lib/mission-planner.ts:351-425`
   - 工作量: 5-8 个工作日（接入 LLM API + 输出格式校验 + 回退策略）

3. **Background process 状态无自动检测** -- `backgroundProcesses` 的 status 字段需要外部调用方更新（如 Agent 调用 task-update），系统本身无法检测进程是否真正结束。`reconcile-background.ts` 只处理已标记为终态的进程。
   - 涉及文件: `scripts/mission-reconcile-background.ts:82-84`
   - 工作量: 2-3 个工作日

4. **ESCALATED 状态恢复路径未实现** -- `ALLOWED_TRANSITIONS` 允许 `ESCALATED -> RUNNING`，但没有脚本或 action handler 实现这个恢复路径。人工介入后如何恢复 mission 没有工具支持。
   - 工作量: 1 个工作日

**优先建议**: P0 强制所有状态变更经过 `isTransitionAllowed()` 校验；P1 实现 LLM-powered planner；P2 补充 ESCALATED 恢复路径。

---

### 2. 闭环自动化 -- 45/100

**当前状态**

`mission-orchestrate.ts` 实现了有限步推进循环（watchdog evaluate -> run-action -> dispatch），最多执行 `--max-steps` 步。watchdog 支持 auto-verify（`--auto-verify` flag）和 auto-collect（stalled task 自动通过 git log 回收结果）。

闭环依赖链分析：

```
create (手动) -> plan (手动) -> dispatch (自动/orchestrate) 
    -> Agent 执行 (外部) -> task-update (Agent 主动调用) 
    -> watchdog 检测全 terminal -> verify (自动/orchestrate) 
    -> COMPLETED
```

**差距**

1. **Agent 结果回收仍高度依赖 Agent 主动调用 `task-update`** -- 这是最大的闭环缺口。如果 Agent 完成了工作但忘记调用 `task-update`（很常见），mission 会一直停在 RUNNING 状态。`collectResults()` 通过 `git log --since` 做兜底，但这只能检测到有 commit 的情况，且无法提取 resultSummary 的具体内容。
   - 涉及文件: `scripts/lib/mission-actions.ts:163-305`
   - 工作量: 3-5 个工作日（需要设计 Agent 输出检测机制，如检查 artifacts 目录变化、解析 Agent session 输出）

2. **`mission-start` 是唯一的组合入口，但不支持无人值守** -- `mission-start.ts` 调用 create + plan + dispatch 后就退出了，后续推进依赖用户手动运行 `mission-orchestrate` 或 `watchdog`。没有 daemon 模式或 cron job 自动轮询。
   - 涉及文件: `scripts/mission-start.ts`
   - 工作量: 2 个工作日（实现 `--watch` 模式或 watchdog 定时器）

3. **orchestrate 没有自动 dispatch 新解锁的 READY tasks** -- `mission-orchestrate.ts:80-95` 确实检查了 READY tasks 并调用 dispatch，但仅在 orchestrate 循环内。如果 task-update 由外部 Agent 调用（触发依赖解锁），新的 READY tasks 要等下一次 watchdog 扫描才会被 dispatch。
   - 工作量: 1 个工作日

4. **无 systemd watchdog timer** -- `scripts/service/mission-runner.service` 是 Claude Code session 的 systemd unit，不是 watchdog 定时扫描器。没有 cron/timer 定期运行 `mission-watchdog.ts`。
   - 涉及文件: `scripts/service/mission-runner.service`
   - 工作量: 0.5 个工作日

5. **ITERATING -> RUNNING 恢复后的自动 re-plan 未实现** -- verify 发现 RETRYABLE_GAP 后 mission 进入 ITERATING，但如何决定"补什么"依赖人工介入或 LLM planner。当前 `resume` 只是把 FAILED tasks 重置为 READY。
   - 工作量: 3-5 个工作日（需要 LLM 驱动的 gap -> task 生成）

**优先建议**: P0 设计 Agent 结果自动回收机制（不依赖 Agent 调用 task-update）；P1 添加 watchdog cron timer；P1 实现 orchestrate --watch 持续推进模式。

---

### 3. 外部集成 -- 40/100

**当前状态**

系统对外部的依赖集中在两个方面：
- **OpenClaw CLI** (`openclaw sessions`, `openclaw agent`, `openclaw message send`, `openclaw agents list`) -- 所有 Agent session 管理和消息发送都通过这些命令
- **Discord** -- 通知推送、Agent @mention 派发

**差距**

1. **OpenClaw CLI 集成完全不可测试** -- 所有对 `openclaw` CLI 的调用（`agent-session.ts`, `dispatch-messenger.ts`, `mission-agent-discovery.ts`, `mission-notification.ts` OpenClaw adapter）在测试中无法运行，因为 `openclaw` 是一个外部二进制文件。测试通过的原因是测试用例避开了这些路径（使用 `fake` notification adapter、不测试 L1/L2 dispatch）。
   - 涉及文件: `scripts/lib/agent-session.ts`, `scripts/lib/dispatch-messenger.ts`, `scripts/lib/mission-agent-discovery.ts`
   - 工作量: 3 个工作日（引入可注入的 CLI executor 接口 + mock 实现）

2. **Discord 通知适配器 (`DiscordMissionNotificationAdapter`) 实际不发送消息** -- `mission-notification.ts:90-104` 的 Discord 适配器只返回元数据，不执行实际发送。真正发送通过 `OpenClawMissionNotificationAdapter` 走 `openclaw message send`。命名容易造成混淆。
   - 涉及文件: `scripts/lib/mission-notification.ts:82-104`
   - 工作量: 0.5 个工作日（要么实现真正的 Discord webhook 发送，要么明确标记为 dry-run/legacy）

3. **Agent 发现 (`discoverAgents`) 降级为空列表** -- `mission-agent-discovery.ts:26-67` 尝试调用 `openclaw agents list`，失败时返回空数组。在测试环境和大多数部署环境中，这个函数总是返回空列表，意味着 plan 阶段的 Agent 分配总是依赖静态映射 `DEFAULT_AGENT_TASK_MAP`。
   - 涉及文件: `scripts/lib/mission-agent-discovery.ts:26-67`
   - 工作量: 2 个工作日（添加配置文件读取 fallback + 测试 mock）

4. **dispatch-messenger.ts 硬编码了 `--account discord-rd-lead`** -- `mentionInDiscord()` 在 L51 固定使用 `discord-rd-lead` 账号发送消息，无法通过配置切换。
   - 涉及文件: `scripts/lib/dispatch-messenger.ts:51`
   - 工作量: 0.5 个工作日

5. **discord-id-resolver.ts 硬编码路径和映射** -- `DISCORD_IDS_PATH` 指向 `/home/ubuntu/openclaw-workspaces/teams/rd/lead/projects/discord-agent-ids.json`，`AGENT_ACCOUNT_MAP` 硬编码了 5 个 Agent。这些都应该通过配置文件注入。
   - 涉及文件: `scripts/lib/discord-id-resolver.ts:15-24`
   - 工作量: 1 个工作日

6. **dispatch-messenger.ts 硬编码项目路径** -- `buildDispatchMessage()` 中 `const projectDir = '/home/ubuntu/public-deliverables/mission-runner'` 在 L74 硬编码，生成的 task-update 命令只在这台机器上可用。
   - 涉及文件: `scripts/lib/dispatch-messenger.ts:74`
   - 工作量: 0.5 个工作日

**优先建议**: P0 将硬编码路径和账号抽取为配置；P1 引入 CLI executor 接口使外部集成可测试；P2 实现真正的 Discord webhook 适配器。

---

### 4. 代码质量与健壮性 -- 68/100

**当前状态**

- **TypeScript strict 模式已启用** -- `tsconfig.json` 配置了 `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- **类型检查不通过** -- `npm run typecheck` 报错，因为 `index.ts` import 了 `openclaw/plugin-sdk/core` 导致 rootDir 冲突。这不是代码本身的类型错误，而是构建配置问题。
- **`any` 使用极少** -- 在 22 个 lib 模块中只有 1 处显式 `any`（`mission-helpers.ts:58` 的压缩行中），整体类型安全良好
- **错误处理覆盖充分** -- 22 个 try/catch 对应 13 个 catch handler，比例合理。所有 CLI 入口脚本都有顶层 try-catch

**差距**

1. **Zod 校验仍为 warn 降级模式** -- `fs-utils.ts:54-60` 和 `fs-utils.ts:79-85` 中 `readMission`/`writeMission` 使用 `safeParse()`，校验失败时仅 `console.warn` 然后继续处理原始数据 (`return parsed as Mission`)。这意味着无效数据可以悄无声息地流过整个系统。
   - 涉及文件: `scripts/lib/fs-utils.ts:52-65`, `scripts/lib/fs-utils.ts:74-93`
   - 工作量: 2 个工作日（分阶段收紧：先核心路径 strict parse，保留边缘路径 warn 降级）

2. **无文件锁 / 无原子写入** -- `fs-utils.ts` 头部有明确的 `TODO(Phase 2)` 标注。多个进程同时写入同一个 `mission.json` 时会产生数据竞争。在 watchdog 和 task-update 并发运行时尤其危险。
   - 涉及文件: `scripts/lib/fs-utils.ts:5-7`, `scripts/lib/fs-utils.ts:108`
   - 工作量: 2 个工作日（使用 `write-temp-then-rename` 原子写入 + advisory file lock）

3. **测试覆盖盲区**:
   - **无测试的模块**: `mission-notification-templates.ts`, `mission-notification-mentions.ts`, `dashboard-formatter.ts` (虽然有函数但无独立测试文件), `discord-id-resolver.ts`, `agent-session.ts`, `dispatch-messenger.ts`, `dispatch-queue.ts`, `mission-agent-discovery.ts`, `shell-utils.ts`
   - **L1/L2 dispatch 路径完全未测试** -- `mission-dispatch-agent.test.ts` 通过 mock 跳过了所有 openclaw CLI 调用
   - **OpenClaw notification adapter 未测试** -- 只有 fake/console adapter 被测试覆盖
   - 工作量: 3-5 个工作日

4. **`mission-helpers.ts` 中的压缩代码** -- `buildDefaultPlan()` 等函数在单行内堆叠了大量逻辑（L57-58），可读性差。虽然功能正确但维护困难。
   - 涉及文件: `scripts/lib/mission-helpers.ts:55-62`
   - 工作量: 1 个工作日（格式化展开）

5. **`execFileSync` 在 verifier 中执行用户定义的命令** -- `structuralVerify()` 读取 `test-command.txt` 并通过 `execFileSync('bash', ['-c', testCommand])` 执行。虽然用了 `execFileSync` 而非 shell，但仍然通过 `bash -c` 间接执行了用户输入的命令内容，存在安全风险。
   - 涉及文件: `scripts/lib/mission-verifier.ts:277-289`
   - 工作量: 1 个工作日（添加命令白名单或沙箱执行）

**优先建议**: P0 实现原子写入防并发；P0 评估 Zod 校验收紧路径（至少 writeMission 时 strict）；P1 补充 notification/dispatch 测试；P2 格式化 mission-helpers.ts。

---

### 5. 运维与可观测性 -- 35/100

**当前状态**

- **日志**: 使用 `console.log` / `console.error` / `console.warn` 输出非结构化日志。格式为 `[module-name] message | key=value` 风格，有一定可搜索性但不是标准化结构日志
- **审计事件**: `events.jsonl` 每行一个 JSON 对象，包含 `_timestamp`、`type`、变更上下文。覆盖了所有关键操作
- **systemd unit**: 有 `mission-runner.service` 但实际是 Claude Code session 的 tmux 启动器，不是 mission-runner watchdog daemon

**差距**

1. **无结构化日志** -- 日志输出到 stdout/stderr，没有日志级别（INFO/WARN/ERROR），没有结构化 JSON 格式，无法被日志收集工具（如 fluentd/filebeat）消费。
   - 工作量: 2 个工作日（引入简易 logger 封装，支持 JSON 输出 + 日志级别）

2. **无监控/告警机制** -- 没有健康检查端点、没有 metrics 导出、没有 dead letter queue。如果 watchdog 自身崩溃，无人知晓。
   - 工作量: 3-5 个工作日（基础健康检查 + 简单 metrics 文件 + 告警通知）

3. **无 watchdog daemon** -- watchdog 是一次性命令行运行（`npm run watchdog`），不是持续运行的服务。没有 cron job、没有 systemd timer、没有内置轮询循环。
   - 工作量: 1 个工作日

4. **events.jsonl 无清理/轮转机制** -- 事件日志文件会无限增长，无 rotation、无 archival 策略。
   - 工作量: 0.5 个工作日

5. **无部署脚本/容器化** -- 没有 Dockerfile、没有 CI/CD pipeline 定义。`mission-runner.service` 硬编码了用户名和路径。
   - 涉及文件: `scripts/service/mission-runner.service`
   - 工作量: 2-3 个工作日

6. **错误追踪困难** -- 当 mission 进入 ESCALATED/FAILED 状态时，需要人工翻阅 `events.jsonl` 和 console 日志来定位问题。没有集中的错误摘要视图。
   - 工作量: 1 个工作日（添加 mission-debug 命令，汇总关键事件链）

**优先建议**: P1 添加 watchdog cron/timer；P1 引入结构化日志；P2 添加健康检查和简单监控。

---

### 6. 文档 -- 72/100

**当前状态**

文档体系相对完整：
- `CLAUDE.md` -- Claude Code 工作指引（详细且准确）
- `docs/architecture.md` -- 架构文档（模块职责、状态机、数据流、通知系统、watchdog）
- `docs/api.md` -- 完整的 CLI 脚本参数文档 + 数据结构定义
- `docs/development.md` -- 开发指南（环境搭建、常用命令、开发规范）
- `docs/plan-system-completion.md` -- 系统完善推进计划
- `skills/mission-controller/SKILL.md` -- Skill 接口文档（含使用示例）
- `schemas/*.schema.json` -- 3 个 JSON Schema 契约

**差距**

1. **无运维手册** -- 没有部署指南、没有故障排除手册、没有生产环境配置说明。如何部署到新机器、如何配置 Discord 集成、如何设置 watchdog 定时运行都没有文档。
   - 工作量: 1-2 个工作日

2. **架构文档声称有原子写入但实际未实现** -- `docs/architecture.md:56` 描述 `fs-utils.ts` 职责为"文件系统工具（带文件锁、原子写入）"，但代码中有明确的 `TODO(Phase 2)` 和 `TODO(Phase 3)` 标注，这些功能尚未实现。文档描述与代码不一致。
   - 涉及文件: `docs/architecture.md:56`
   - 工作量: 0.5 个工作日

3. **SKILL.md 中的 mission-controller 模板体系未实现** -- `skills/mission-controller/SKILL.md` 描述了 `planner.md`、`verifier.md`、`recovery.md` 三个模板，但 `templates/` 目录下只有 `planner.md`。verifier 和 recovery 模板未创建。且实际代码中 planner 并未调用 skill/template，而是用硬编码逻辑。
   - 涉及文件: `skills/mission-controller/SKILL.md`, `skills/mission-controller/templates/`
   - 工作量: 2 个工作日

4. **无 ADR（架构决策记录）** -- 一些关键设计决策（如为什么 watchdog 只建议不执行、为什么 Zod 用 warn 降级、为什么 dispatch 用三级回退）散落在代码注释中，没有集中记录。
   - 工作量: 1 个工作日

5. **CHANGELOG 缺失** -- 没有版本变更日志。`package.json` 显示 version `0.1.0`，但已经有大量功能迭代。
   - 工作量: 0.5 个工作日

**优先建议**: P1 添加运维手册；P1 修正文档与代码不一致处；P2 补充 ADR。

---

## 关键差距清单（按优先级排序）

| # | 差距 | 影响 | 优先级 | 建议工作量 |
|---|------|------|--------|-----------|
| 1 | Agent 结果回收依赖 Agent 主动调用 task-update，无可靠的自动回收 | 闭环断裂：Agent 完成工作但 mission 卡在 RUNNING | P0 | 3-5 天 |
| 2 | 无文件锁/原子写入，并发 watchdog + task-update 可能数据竞争 | 数据损坏：mission.json 被覆盖丢失更新 | P0 | 2 天 |
| 3 | Zod 校验为 warn 降级，无效数据可以流过系统 | 静默故障：畸形数据导致下游不可预测行为 | P0 | 2 天 |
| 4 | `isTransitionAllowed()` 未在所有状态变更路径强制使用 | 状态机保障形同虚设：代码 bug 可产生非法迁移 | P0 | 1 天 |
| 5 | 外部 CLI 调用（openclaw）不可 mock/测试 | 核心集成路径零测试覆盖 | P1 | 3 天 |
| 6 | Planner 是硬编码规则，不支持 LLM 驱动 | 任务拆解质量低，无法适应多样化 goal | P1 | 5-8 天 |
| 7 | 硬编码路径和账号（discord-rd-lead、/home/ubuntu/...） | 不可移植：换机器或团队即失效 | P1 | 1.5 天 |
| 8 | 无 watchdog daemon/cron timer | 需人工定期运行 watchdog | P1 | 1 天 |
| 9 | 无结构化日志 | 生产环境难以排查问题 | P1 | 2 天 |
| 10 | 无运维手册和部署指南 | 新用户无法部署 | P1 | 1-2 天 |
| 11 | notification/dispatch 模块无测试 | 通知和派发路径无质量保障 | P1 | 3-5 天 |
| 12 | Background process 状态无自动检测 | 后台任务完成后系统不知道 | P2 | 2-3 天 |
| 13 | ITERATING 后无自动 re-plan（补缺任务生成） | 迭代修复依赖人工介入 | P2 | 3-5 天 |
| 14 | Discord 适配器命名混淆（不实际发送） | 开发者误解行为 | P2 | 0.5 天 |
| 15 | ESCALATED -> RUNNING 恢复路径无工具支持 | 人工介入后无法自动恢复 | P2 | 1 天 |
| 16 | TypeScript 类型检查不通过（rootDir 冲突） | CI 无法使用 typecheck 做门禁 | P2 | 0.5 天 |
| 17 | verifier 的 `test-command.txt` 执行存在安全风险 | 潜在命令注入 | P2 | 1 天 |
| 18 | 无监控/告警/健康检查 | watchdog 崩溃无人知晓 | P2 | 3-5 天 |
| 19 | events.jsonl 无轮转/清理 | 磁盘空间耗尽 | P3 | 0.5 天 |
| 20 | 文档与代码不一致（声称有原子写入/文件锁但实际无） | 误导开发者 | P3 | 0.5 天 |

---

## 推进路线建议

### Phase 2 应聚焦: 闭环可靠性（预计 15-20 个工作日）

目标：让系统在"Agent 完成工作后能自动推进到下一步"这条链路上真正可靠。

1. **原子写入 + 文件锁**（P0, 2 天） -- `write-temp-then-rename` + `flock` advisory lock。这是并发安全的基础。

2. **Zod 校验收紧**（P0, 2 天） -- `writeMission` 改为 strict parse（写入无效数据直接拒绝）；`readMission` 保持 warn 降级但记录到 events.jsonl 便于追踪。

3. **状态迁移强制校验**（P0, 1 天） -- 修改 `setMissionStatus()` 和 `deriveMissionStatus()` 在变更前调用 `isTransitionAllowed()`，不合法迁移抛异常。

4. **Agent 结果自动回收**（P0, 3-5 天） -- 设计多源回收机制：(a) git log 检测（已有）, (b) artifacts 目录变化检测, (c) Agent session 输出解析, (d) 配置化超时阈值后自动 escalate。

5. **CLI executor 可注入化**（P1, 3 天） -- 抽取 `openclaw` CLI 调用为接口，测试中用 mock 替换，生产用真实 CLI。

6. **去除硬编码**（P1, 1.5 天） -- 将路径、账号、Agent 映射抽取到 `config.json` 或环境变量。

7. **watchdog daemon**（P1, 1 天） -- 添加 `--watch` 模式（内置定时器循环）或 systemd timer unit。

8. **结构化日志**（P1, 2 天） -- 引入简易 logger，支持 JSON 输出和日志级别。

### Phase 3 应聚焦: 智能化 + 生产化（预计 15-25 个工作日）

目标：从"能用"到"好用"。

1. **LLM-powered planner**（5-8 天） -- 接入 Claude/GPT API，根据 goal 语义生成任务拆解和完成标准。保留硬编码模板作为 fallback。

2. **ITERATING 自动 re-plan**（3-5 天） -- verify 发现 gap 后，自动调用 planner 生成补缺任务。

3. **监控与告警**（3-5 天） -- 健康检查端点、简单 metrics（active missions, stuck missions, success rate）、告警通知。

4. **运维文档 + 部署脚本**（2-3 天） -- Dockerfile、部署指南、故障排除手册。

5. **Dashboard 增强**（2 天） -- 实时状态面板、历史数据统计。

### 预期里程碑

| 里程碑 | 预期时间 | 标志 |
|--------|----------|------|
| Phase 2 基础完成 | +3 周 | 并发安全 + Agent 结果自动回收 + watchdog daemon |
| Phase 2 全面完成 | +5 周 | CLI 可测试 + 结构化日志 + 去硬编码 |
| Phase 3 核心完成 | +8 周 | LLM planner + 自动 re-plan + 生产部署 |
| Phase 3 全面完成 | +12 周 | 监控告警 + 运维文档 + Dashboard |

---

## 附录: 模块代码量与测试覆盖

| 模块 | 代码行数(约) | 有独立测试 | 测试充分度 |
|------|------------|-----------|-----------|
| types.ts | 313 | Yes (schemas.test.ts) | 高 |
| fs-utils.ts | 164 | 间接 (通过 E2E) | 中 |
| mission-helpers.ts | 274 | 间接 (通过多个 test) | 中 |
| mission-commit.ts | 178 | 间接 (通过 E2E) | 中 |
| mission-dispatcher.ts | 244 | Yes (dispatch-agent.test.ts) | 中 |
| mission-dispatch-agent.ts | 120 | Yes (dispatch-agent.test.ts) | 低 (mock 跳过 CLI) |
| dispatch-queue.ts | 63 | No | 无 |
| dispatch-messenger.ts | 112 | No | 无 |
| agent-session.ts | 111 | No | 无 |
| safe-exec.ts | 35 | 间接 | 低 |
| discord-id-resolver.ts | 96 | No | 无 |
| mission-planner.ts | 426 | Yes (plan.test.ts) | 高 |
| mission-verifier.ts | 516 | Yes (verify-watchdog.test.ts) | 高 |
| mission-actions.ts | 307 | Yes (run-action.test.ts) | 中 |
| mission-watchdog-evaluator.ts | 287 | Yes (verify-watchdog.test.ts) | 高 |
| mission-notification.ts | 205 | 间接 (通过 E2E fake adapter) | 低 |
| mission-notification-templates.ts | 122 | No | 无 |
| mission-notification-mentions.ts | 54 | No | 无 |
| mission-agent-discovery.ts | 112 | No | 无 |
| dashboard-formatter.ts | 223 | No | 无 |
| schemas.ts | 221 | Yes (schemas.test.ts) | 高 |
| shell-utils.ts | 10 | No | 无 |
