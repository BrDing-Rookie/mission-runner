# 验证智能化 — verify 阶段接入 LLM 评估完成标准

> 模块: verifier
> 创建日期: 2026-04-07
> 状态: 进行中
> 关联 Phase: P3 Batch C

## 目标
将 mission-verifier.ts 的启发式 criterion 评估升级为 LLM 驱动。当 ANTHROPIC_API_KEY 存在时用 Claude 评估每个 completionCriterion 是否满足，否则回退到现有启发式规则。

## 涉及文件
- `scripts/lib/llm-client.ts` — 共享 LLM 客户端（Lead 预创建）
- `scripts/lib/mission-verifier.ts` — 新增 `evaluateCriterionWithLlm()` 函数
- `scripts/mission-verify.ts` — 新增 `--use-llm` flag，接入 LLM 客户端
- `scripts/llm-verifier.test.ts` — 新增测试（mock LLM client）

## 方案
1. 复用共享 `LlmClient` 接口
2. Prompt 模板：输入 criterion + mission context + task results，输出 pass/fail + reasoning
3. LLM 评估结果补充（非替代）结构化检查
4. `--use-llm` flag 或 `MISSION_USE_LLM=1` 环境变量控制

## 验收标准
- [ ] `--use-llm` 模式下 LLM 评估结果正确写入 verification
- [ ] 无 API key 时自动回退启发式验证
- [ ] LLM 返回异常时 graceful fallback
- [ ] 测试覆盖：LLM 成功、LLM 失败回退、无 API key 回退
