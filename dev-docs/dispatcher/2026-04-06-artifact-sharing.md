# 多 Agent 结果共享

> 模块: dispatcher
> 创建日期: 2026-04-06
> 状态: 已完成
> 关联 Phase: P3 批次 A

## 目标
实现 Agent 间通过 artifacts 目录传递中间结果的机制，支持 producer/consumer 声明，让下游 task 可以引用上游 task 的产出。

## 涉及文件
- `scripts/lib/types.ts` — Task 接口新增 `produces` 和 `consumes` 字段
- `scripts/lib/schemas.ts` — Zod schema 同步更新（新建文件，含 TaskSchema produces/consumes）
- `scripts/lib/mission-helpers.ts` — 新增 `resolveConsumedArtifacts` 和 `buildTaskEnvelope` 函数

## 方案

### 1. Task 接口扩展
```typescript
interface Task {
  // ...existing fields
  produces?: string[];    // 该 task 承诺产出的 artifact key 列表
  consumes?: string[];    // 该 task 需要消费的 artifact key 列表
}
```

### 2. Artifact 解析
- 新增 `resolveConsumedArtifacts(mission, task)` 函数
- 根据 task.consumes 查找其他已完成 task 的 artifacts 中匹配的 key
- 匹配优先级: type === key > path === key > path.startsWith(key)
- 返回 { key, artifact, producerTaskId }[]

### 3. Dispatch 注入
- 新增 `buildTaskEnvelope(mission, task)` 函数
- dispatch 时如果 task 有 consumes，调用 resolveConsumedArtifacts
- 将结果注入 envelope.availableArtifacts，让 Agent 知道可用的上游产出

### 4. Soft dependency
- produces/consumes 为 soft dependency，不阻塞 dispatch
- 仅在 envelope 中提供信息，由 Agent 自行决策是否使用

## 验收标准
- [x] Task 支持 produces/consumes 声明
- [x] dispatch 消息包含 consumed artifact 信息
- [x] Zod schema 同步更新
- [x] npm run typecheck 通过（已知 OpenClaw 外部依赖错误除外）
- [x] 新增测试（14 个，全部通过）

## 开发记录
### 2026-04-06
- 开发启动
- 在 types.ts Task 接口添加 produces/consumes 可选字段
- 新建 scripts/lib/schemas.ts，含完整 Zod schema（TaskSchema 包含 produces/consumes）
- 在 mission-helpers.ts 新增 resolveConsumedArtifacts、buildTaskEnvelope 函数
- 新增 scripts/artifact-sharing.test.ts，14 个测试全部通过
- npm run typecheck 无新增错误（仅 OpenClaw 外部依赖已知错误）
