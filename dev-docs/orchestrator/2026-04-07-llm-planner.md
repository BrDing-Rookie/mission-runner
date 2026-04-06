# LLM Planner — plan 阶段接入 LLM 生成任务拆解

> 模块: orchestrator (planner)
> 创建日期: 2026-04-07
> 状态: 进行中
> 关联 Phase: P3 Batch C

## 目标
将 mission-planner.ts 的规则型任务拆解升级为 LLM 驱动。当 ANTHROPIC_API_KEY 存在时用 Claude 生成任务分解和完成标准，否则回退到现有规则模板。

## 涉及文件
- `scripts/lib/llm-client.ts` — 新增共享 LLM 客户端抽象（Lead 预创建）
- `scripts/lib/mission-planner.ts` — 新增 `buildPlannedOutputWithLlm()` 函数
- `scripts/mission-plan.ts` — 新增 `--use-llm` flag，接入 LLM 客户端
- `scripts/llm-planner.test.ts` — 新增测试（mock LLM client）

## 方案
1. 共享 `LlmClient` 接口 + `AnthropicLlmClient` (native fetch) + `MockLlmClient`
2. Prompt 模板：输入 mission goal/title，输出 JSON 格式的 tasks[] + completionCriteria[]
3. LLM 输出用 Zod 校验，失败则回退规则型
4. `--use-llm` flag 或 `MISSION_USE_LLM=1` 环境变量控制

## 验收标准
- [ ] `--use-llm` 模式下 LLM 生成的 tasks 通过 TaskSchema 校验
- [ ] 无 API key 时自动回退规则型 planner
- [ ] LLM 返回无效 JSON 时 graceful fallback
- [ ] 测试覆盖：LLM 成功、LLM 失败回退、无 API key 回退
