# Mission Runner 下一阶段迭代方案

## 一、背景

基于 `ISSUES.md` 的首次真实使用记录，Mission Runner 当前已经完成 MVP 骨架阶段，具备：

- mission 工件落盘
- mission-plan / mission-dispatch / mission-resume / mission-watchdog / mission-reconcile-background / mission-run-action / mission-verify 脚本骨架
- background task 回收路径
- `CHECK_BACKGROUND` 动作执行层
- 基础幂等性与 no-op 去噪

当前项目的主要矛盾已从“有没有骨架”切换为：

**这套骨架能否在真实多人协作、并行任务、子 Agent 产物回流和总控收口中稳定工作。**

因此下一阶段的目标不再是横向加更多脚本，而是进入：

# 从 MVP 骨架走向真实任务编排可用性

---

## 二、问题归纳

根据 `ISSUES.md`，当前关键问题可以归纳为四类：

### 1. 任务建模不足
- 默认 plan 仍是固定三步串行模板
- 无法表达真实并行任务
- 多路执行者共享同一 taskId
- completionCriteria 过于通用，缺乏任务针对性

### 2. 执行接线不足
- `mission-dispatch` 只改状态，不触发真实 Agent 派发
- 总控绕过 dispatch，直接 `sessions_spawn`
- mission 状态和真实执行过程脱节

### 3. 工件沉淀不稳
- 子 Agent 产物写入依赖 heredoc 等方式，易被网关审批拦截
- artifact 不能稳定进入 mission 目录
- verify 缺乏稳定依据

### 4. 闭环使用流程不稳
- 结果回收后总控可能直接汇总，而不执行 watchdog / verify
- mission 生命周期停留在 RUNNING
- 审计和状态收口不完整

---

## 三、下一阶段总目标

下一阶段总目标定义为：

# Mission Runner 真实任务编排可用性迭代

具体目标：
1. 能正确表达真实并行任务结构
2. 能通过 Mission Runner 自身入口完成任务派发，而不是依赖总控绕行
3. 能稳定沉淀多 Agent 产物
4. 能把回收结果推进到 verify / completed 的闭环路径
5. 能通过一条真实整链 E2E 验证主流程

---

## 四、优先级与迭代项

## P0：真实任务建模

### 目标
让 mission-plan 能表达真实协作任务，而不是固定串行模板。

### 迭代项

#### P0-1 增强 `mission-plan.ts`
支持以下输入方式之一或组合：
- `--tasks-json <json>`
- `--tasks-file <path>`
- `--parallel <N>`
- `--template <name>`（例如 `parallel-research`）

#### P0-2 支持并行任务结构
- 支持 `dependsOn: []` 的并行任务组
- 允许多任务同时处于 READY
- 使 `plan.md` 与 `mission.json` 中的任务结构一致

#### P0-3 支持自定义 completionCriteria
- `--criteria-json`
- `--criteria-file`
- 或允许总控预先定义后由 plan 落盘

### 验收标准
- 并行研究/开发场景下不再共享 taskId
- `mission.json` 中的任务列表能真实表达多路任务
- `plan.md` 与真实执行结构一致
- verify 能基于更具体的 completionCriteria 工作

---

## P1：真实执行接线

### 目标
让 Mission Runner 真正承担任务派发，不再只是状态更新器。

### 迭代项

#### P1-1 新增统一入口 `mission-start.ts`
建议优先实现一个统一入口：

```text
create -> plan -> dispatch -> spawn
```

输入建议支持：
- `--goal`
- `--title`
- `--tasks-file`
- `--parallel`
- `--agent` / `--task-agent-map-file`

#### P1-2 增强 `mission-dispatch.ts`
支持最小真实派发：
- 根据 task 配置触发 `sessions_spawn`
- 写回 `sessionKey`
- 写回 `agent`
- 维护 task 执行态

#### P1-3 补充总控接入规范
在总控侧协议中明确：
- 先 `mission-start` 或 `plan + dispatch`
- 不再绕过 Mission Runner 直接 spawn

### 验收标准
- 总控不再需要跳过 dispatch 自己派发
- mission 状态流和真实执行流一致
- 子 Agent 拿到唯一 taskId 与 missionId 上下文

---

## P1：稳定 artifact 落盘路径

### 目标
让子 Agent 产物沉淀成为稳定、可审计、低审批风险的官方路径。

### 迭代项

#### P1-4 新增 `mission-write-artifact.ts`
建议支持：
- `--mission-id`
- `--task-id`
- `--path`
- `--content` 或 stdin
- 可多次写入多产物

#### P1-5 文档补充与总控/子 Agent 规范
明确要求：
- 不使用 heredoc 作为默认 artifact 写法
- 统一使用 mission-write-artifact 路径

### 验收标准
- artifact 不再依赖 heredoc
- 多 Agent 产物能稳定写入 `artifacts/`
- verify 能基于 artifacts 做判断

---

## P1：闭环收口流程

### 目标
将“结果回流后直接汇总”改为“经过 watchdog / verify 收口后再完成”。

### 迭代项

#### P1-6 增强 action 层
在现有 `mission-run-action.ts` 基础上，下一步优先补：
- `TRIGGER_VERIFY`
- 之后再考虑 `RESUME_TASK`

#### P1-7 总控流程规范补齐
明确流程：

```text
结果回收 -> watchdog -> verify -> 标记完成 -> 汇总输出
```

#### P1-8 最小闭环 E2E
补一条真实整链：

```text
create -> plan -> dispatch -> 子任务更新 -> watchdog -> verify -> completed
```

### 验收标准
- mission 最终状态能正确收敛到 `VERIFYING -> COMPLETED`
- 不再大量停留在 RUNNING 而结束流程

---

## P2：体验与质量入口优化

### 目标
降低使用门槛，提高持续开发效率。

### 迭代项
- 建立 `npm test`
- 建立 `npm run lint`
- 建立最小 CI
- 为 plan 增加更多预设模板
- 补 task-update / artifact 参数说明

### 验收标准
- 研发可通过统一入口运行测试
- 关键主路径变更有 CI 防回归

---

## 五、推荐实施顺序

建议按以下顺序推进：

### 阶段 2A：任务建模
1. `mission-plan.ts` 支持 `--tasks-file/--tasks-json`
2. 支持 `--parallel`
3. 支持自定义 completionCriteria

### 阶段 2B：执行接线
4. `mission-start.ts`
5. `mission-dispatch.ts` 最小 `sessions_spawn` 接线

### 阶段 2C：工件沉淀
6. `mission-write-artifact.ts`
7. 子 Agent / 总控使用规范补齐

### 阶段 2D：闭环收口
8. `mission-run-action.ts` 增加 `TRIGGER_VERIFY`
9. 整链 E2E

### 阶段 2E：标准质量入口
10. `npm test`
11. lint / CI

---

## 六、团队执行建议

### 总控职责
- 不再绕过 Mission Runner 直接组织任务
- 优先使用本阶段新增统一入口（如 `mission-start.ts`）
- 在结果回收后强制走 watchdog / verify 闭环

### 执行 Agent 职责
- 严格使用唯一 taskId
- 严格通过官方 artifact 路径写入产物
- 避免通过对话文本代替工件落盘

### 审查 Agent 职责
- 检查状态流是否与真实执行一致
- 检查 no-op 语义是否被破坏
- 检查 artifacts 是否可作为 verify 依据

---

## 七、建议下一阶段验收标准

如果下一阶段完成，至少应满足：

1. 并行任务场景可被正确建模
2. 总控不再需要绕过 dispatch / start 自行派发
3. 多 Agent 产物能稳定写入 artifacts
4. mission 能从 create 走到 verify/completed
5. 有至少 1 条真实整链 E2E
6. 有统一测试入口

---

## 八、一句话收口

Mission Runner 下一步应从“脚本骨架建设”进入“真实任务编排可用性建设”。

优先补：
- 真实任务建模
- 真实执行接线
- 稳定 artifact 落盘
- 闭环收口流程

在这些问题解决之前，不建议优先扩更多 action、做 UI、或推进内核化。
