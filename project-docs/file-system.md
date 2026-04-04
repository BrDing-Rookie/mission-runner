# 文件系统

## 功能概述
提供 mission 工件目录的文件 I/O 操作，包括 mission.json 的读写（含 Zod 运行时校验）和 events.jsonl 审计日志追加。

## 核心能力
- **mission.json 读写**: `readMission()` / `writeMission()`，接入 Zod schema 校验
- **事件日志**: `appendEvent()` 追加 JSONL 格式审计事件
- **目录管理**: `ensureDir()` 创建目录、`listMissionIds()` 列出所有 mission
- **Zod 校验**: 读写时通过 `MissionSchema.safeParse()` 进行运行时校验

## 使用方式
```typescript
import { readMission, writeMission, appendEvent, listMissionIds } from './fs-utils.ts'
const mission = readMission(missionsDir, missionId)
writeMission(missionsDir, missionId, mission)
appendEvent(missionsDir, missionId, { type: 'status_change', ... })
```

## 当前限制
- Zod 校验为 warn 降级模式（safeParse 失败时仅 console.warn，不阻止操作）
- 无文件锁机制，并发写入可能产生数据竞争
- 无原子写入（非 write-temp-then-rename 模式）

## 相关模块
- 被所有需要读写 mission 数据的模块依赖
- schemas.ts 提供 Zod schema 定义
