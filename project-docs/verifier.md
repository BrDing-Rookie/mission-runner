# 验证器

## 功能概述
根据 mission 的 completionCriteria 和结构化检查（测试命令、artifact 存在性）验收 mission 是否完成。

## 核心能力
- **完成标准评估**: 逐项检查 `completionCriteria` 中定义的验收条件
- **结构验证**: 检查 artifact 文件是否存在、测试命令是否通过
- **验证状态判定**: PASS（全部通过→COMPLETED）/ RETRYABLE_GAP（部分失败→ITERATING）/ CRITICAL_FAIL（关键失败→FAILED）
- **Plan 标准提取**: 从 plan.md 中解析自定义完成标准
- **验证报告生成**: 输出 verification.md 格式的验收报告

## 使用方式
```bash
npm run mission-verify -- --missions-dir ./missions --mission-id <id>
# dry-run 模式
npm run mission-verify -- --missions-dir ./missions --mission-id <id> --dry-run
```

## 当前限制
- 无 LLM 辅助判定，完全依赖规则匹配
- `test-command.txt` 通过 `bash -c` 执行用户输入的命令，存在安全风险
- 对"部分完成"的判定较为粗糙

## 相关模块
- 依赖: state-machine, file-system
- 被依赖: orchestrator, watchdog（TRIGGER_VERIFY 动作）
