# Mission Runner 开发交接说明

## 一、交接目标
请研发团队基于 OpenClaw 现有 Agent / hooks / cron / process / session / message 能力，实现一个插件级 Mission Runner MVP。

目标不是一次做成通用工作流引擎，而是先实现一个可稳定闭环的自治任务系统原型。

## 二、开发原则
1. 不优先改 OpenClaw 内核
2. 优先用插件、hooks、脚本、workspace 工件实现
3. 先支持调研/文档/受限代码三类任务
4. 先做可靠闭环，再做通用化和体验优化

## 三、MVP 范围
### 必做
- mission 创建与目录初始化
- mission.json 状态持久化
- planner：生成 plan、completion criteria、tasks
- dispatch：根据任务类型派发执行路径
- background process 跟踪
- watchdog：定时扫描、恢复、重试、触发 verify
- verifier：判断是否完成/补缺/升级
- notify：完成与升级主动通知

### 可延后
- 用户补充消息自动挂接 mission
- gateway 启动自动恢复
- 更精细的 nextWakeAt 定向调度
- 可观测性增强

### 第一版不做
- UI
- 全通用 DAG
- 任务级授权内核化
- 原生 mission CLI
- 复杂 browser 真账号自动化

## 四、建议实施阶段
### Phase 1：状态与工件
产出：
- missions/<id>/ 目录规范
- mission.json schema
- 状态迁移函数
- 事件日志机制

### Phase 2：planner / dispatch
产出：
- planner prompt/template
- task 数据结构
- dispatch 路由逻辑

### Phase 3：watchdog / process
产出：
- recurring watchdog
- background process 结果回收
- stuck 检测与 retry

### Phase 4：verifier / notify
产出：
- verification 结构
- gap → iteration 闭环
- 完成/升级通知

### Phase 5：recover / enhance
产出：
- startup recover
- message observer
- 更好的观测与调试信息

## 五、研发判断标准
如果 MVP 成功，应至少满足：
1. 一个明确任务可从创建走到完成，不需要用户中途 push
2. 长任务结束后能自动续跑
3. 失败后能自动重试或明确升级
4. verifier 能阻止“伪完成”
5. 用户只在完成或高风险阻塞时被通知

## 六、后续可能的内核化方向
若 MVP 跑通，建议后续评估是否把以下能力内核化：
- Mission 一等公民数据模型
- continuation event bus
- 任务级授权
- mission 统一可观测性

## 七、建议下一步
研发团队拿到本目录后，建议先补两份工件：
1. `schemas/mission.schema.json`
2. `scripts/mission-watchdog.ts` 的最小实现

这是最能尽快验证方案价值的切入点。
