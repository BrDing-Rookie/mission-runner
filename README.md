# Mission Runner 交付说明

这是面向研发团队的交付目录，用于实现一个基于 OpenClaw 现有能力的插件级自治任务编排层。

## 目标
Mission Runner 的目标是让 OpenClaw 从“会执行的聊天体”演进为“可持续完成任务的自治体”：
- 给定任务后自动规划
- 自动派发与执行
- 长任务后台化
- 自动恢复与重试
- 自动验证是否达成完成条件
- 未完成则继续迭代
- 完成后主动通知用户
- 仅在高风险边界升级给人

## 当前交付物
- `mission-runner-plugin-implementation-draft.md`：实施草案主文档
- `handoff.md`：给研发团队的开发范围、建议优先级与里程碑

## 建议研发阅读顺序
1. 先读 `mission-runner-plugin-implementation-draft.md`
2. 再读 `handoff.md`
3. 按 MVP 范围做第一阶段实现

## 推荐实现范围（MVP）
- 显式触发创建 mission
- mission.json 工件落盘
- planner 生成子任务与完成标准
- dispatch 启动执行与后台任务
- watchdog 负责恢复/重试/验证触发
- verifier 判断 PASS / GAP / ESCALATE
- notify 在完成或阻塞时主动通知

## 非目标（第一版不做）
- 原生 DAG 工作流引擎
- 图形化 UI
- 全任务类型通用化
- 复杂权限代理与任务级授权内核化
- 跨所有工具的统一 continuation bus

## 交付定位
这不是 OpenClaw 内核改造方案，而是：

**基于 OpenClaw 现有 primitives 搭建的插件级自治任务编排层。**

先验证闭环与价值，再决定哪些能力值得内核化。
