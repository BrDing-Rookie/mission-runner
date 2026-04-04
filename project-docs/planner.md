# 计划器

## 功能概述
根据 mission 的 goal 生成任务拆解（tasks）和完成标准（completionCriteria），输出结构化计划。

## 核心能力
- **工作流类型推断**: `inferWorkstreamType()` 通过关键字匹配判断任务类型（serial/parallel-research/parallel-build）
- **任务生成**: 3 个内置模板，每个生成 3 个任务（context/execute/verify）
- **完成标准生成**: 自动为每个 mission 生成验收标准列表
- **计划文档输出**: 生成 plan.md 格式的可读计划文档
- **自定义任务支持**: 支持通过 `--tasks-json` 传入自定义任务列表

## 使用方式
```bash
npm run mission-plan -- --missions-dir ./missions --mission-id <id>
# 或传入自定义任务
npm run mission-plan -- --missions-dir ./missions --mission-id <id> --tasks-json '[...]'
```

## 当前限制
- 硬编码规则型实现，非 LLM 驱动
- 仅 3 个模板，无法根据 goal 语义智能拆解
- `inferWorkstreamType()` 基于正则匹配，覆盖面有限

## 相关模块
- 依赖: state-machine（类型定义）
- 被依赖: orchestrator（mission-start 调用 plan）
