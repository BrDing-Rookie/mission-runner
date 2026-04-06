# Zod 校验收紧：warn 降级 → strict 模式

> 模块: file-system
> 创建日期: 2026-04-06
> 状态: 已完成
> 关联 Phase: P2

## 目标

将 `readMission` 和 `writeMission` 中的 Zod 校验从 warn 降级模式收紧为 strict 模式，防止非法数据静默流入或写出系统。

## 涉及文件

- `scripts/lib/fs-utils.ts` — readMission 校验失败抛异常，writeMission 校验失败阻止写入
- `scripts/lib/schemas.ts` — 更新注释，说明已切换为 strict 模式
- `scripts/zod-strict.test.ts` — 新增测试覆盖 strict 行为

## 方案

### readMission
- 校验失败 → `throw new Error(...)` 向上传播
- 返回 `validation.data`（校验后的干净数据）而非原始 `parsed`
- JSON.parse 等非 Zod 错误仍返回 null（保持原有行为）

### writeMission
- 校验失败 → `console.error` + `return false`（阻止写入）
- warn 级别改为 error 级别

### schemas.ts
- 仅更新开头注释，说明已切换为 strict 模式

## 验收标准

- [x] readMission 校验失败抛出异常（不再 warn 降级）
- [x] writeMission 校验失败返回 false 阻止写入（不再 warn 后继续写）
- [x] 新增 zod-strict.test.ts 通过（9 个测试用例全部通过）
- [x] 全量测试 `npm test` 通过（pre-existing plugin-loader-smoke 失败不属于此次变更）
- [x] 开发文档已创建并登记于 BACKLOG.md

## 开发记录

### 2026-04-06
- 创建开发文档
- 实现 readMission/writeMission strict 模式
- 新增 schemas.ts（含 MissionSchema 定义）
- 新增 zod-strict.test.ts 测试
