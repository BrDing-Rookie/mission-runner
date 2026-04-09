# Verifier Security Fix + Code Deduplication Refactor

> 模块: verifier
> 创建日期: 2026-04-09
> 状态: 已完成
> 关联 Phase: P3

## 目标

1. **安全修复（High）**: `structuralVerify` 中的 `test-command.txt` 内容直接传给 `execFileSync('bash', ['-c', ...])` 存在 shell 注入漏洞。需在执行前做白名单校验 + shell 元字符拦截。
2. **代码去重（Medium）**: `computeVerification` 与 `computeVerificationWithLlm` 有 90%+ 重复逻辑，通过策略模式重构提取共享逻辑。

## 涉及文件

- `scripts/lib/mission-verifier.ts` — 主要修改文件

## 方案

### 安全修复

在 `structuralVerify` 的 test-command.txt 执行路径前插入两层校验：

1. **Shell 元字符拦截**: 检测 `;|&$\`><` 等字符，如命中则拒绝执行并记录 reason。
2. **白名单模式校验**: 只允许 `npm test/run`, `npx`, `node` 开头的命令。

### 代码去重（策略模式）

提取两个私有辅助函数：

- `buildVerifyContext(args, mission)` — 返回两个函数共同需要的准备数据（tasks 状态、planText、planCriteria、artifactFiles、completionCriteria、gaps 基础列表、criterion context 等）
- `finalizeVerification(args, mission, criterionResults, ctx)` — 处理后续共享逻辑（gaps 追加、verificationStatus 计算、summary 生成、structuralVerify、markdown 生成、updatedMission 构造）

`computeVerification` 和 `computeVerificationWithLlm` 只保留各自的 criterion 评估策略（同步 / LLM），其余委托给上述两个函数。

## 验收标准

- [ ] structuralVerify 中 test-command.txt 内容经过 shell 元字符 + 白名单双重校验
- [ ] 拦截时记录 `passed: false` 和清晰的 reason
- [ ] `computeVerification` 和 `computeVerificationWithLlm` 共享逻辑提取到私有函数
- [ ] 文件总行数从 786 行减少到 ~650 行以下
- [ ] 两个公开函数输入输出签名不变
- [ ] `npm test` 所有测试通过

## 开发记录

### 2026-04-09
- 创建开发文档
- 实现安全修复 + 策略模式重构
