# Token/成本追踪

> 模块: orchestrator
> 创建日期: 2026-04-06
> 状态: 已完成
> 关联 Phase: P3 批次 A

## 目标
为每个 task 和 mission 记录 LLM 调用的 token 消耗，支持成本审计和优化决策。

## 涉及文件
- `scripts/lib/types.ts` — Task 和 Mission 接口新增 usage / totalUsage 字段，新增 TokenUsage 接口
- `scripts/lib/schemas.ts` — 新建文件，包含 TokenUsageSchema / TaskSchema / MissionSchema Zod 校验
- `scripts/task-update.ts` — 支持 --input-tokens / --output-tokens / --model 参数，写入 usage 并汇总 totalUsage
- `scripts/lib/mission-helpers.ts` — 新增 aggregateUsage() 汇总函数
- `scripts/token-tracking.test.ts` — 新建测试文件，21 个测试用例

## 方案

### 1. 类型扩展
```typescript
interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  calls?: number;           // LLM 调用次数
  estimatedCostUsd?: number; // 可选的估算成本
}

interface Task {
  // ...existing fields
  usage?: TokenUsage;
}

interface Mission {
  // ...existing fields
  totalUsage?: TokenUsage;  // 汇总所有 task 的 usage
}
```

### 2. task-update 支持
- task-update CLI 新增 `--input-tokens`, `--output-tokens`, `--model` 参数
- Agent 完成 task 后通过 task-update 上报 usage
- 自动调用 aggregateUsage 更新 mission.totalUsage

### 3. Mission 汇总
- 新增 `aggregateUsage(mission): TokenUsage | undefined` 函数
- 汇总所有 task 的 usage 到 mission.totalUsage
- model 字段取出现次数最多的

### 4. Zod Schema
- TokenUsageSchema: 全字段可选，.passthrough() 保持向前兼容
- TaskSchema / MissionSchema 引用 TokenUsageSchema

## 验收标准
- [x] Task 和 Mission 支持 usage 字段
- [x] task-update 可上报 token 消耗
- [x] mission 自动汇总 totalUsage
- [x] Zod schema 同步更新
- [x] npm run typecheck 通过（已知 OpenClaw 外部依赖错误除外）
- [x] 新增测试（21 个测试全部通过）

## 开发记录
### 2026-04-06
- 开发启动
- 实现 TokenUsage 接口 + Task/Mission 扩展
- 创建 scripts/lib/schemas.ts（Zod 校验）
- 实现 aggregateUsage() 汇总函数
- 扩展 task-update CLI 参数
- 创建 scripts/token-tracking.test.ts，21 个测试全部通过
