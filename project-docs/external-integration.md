# 外部集成

## 功能概述
封装与外部系统（OpenClaw CLI、Discord）的交互，包括 Agent session 管理、Discord 用户 ID 解析、Agent 发现。

## 核心能力
- **Agent session 管理**: `checkAgentSession()` / `createAgentSession()` 通过 OpenClaw CLI 管理 Agent 会话
- **Discord ID 解析**: `resolveDiscordId()` 查找 Agent 对应的 Discord 用户 ID
- **Agent 发现**: `discoverAgents()` 通过 OpenClaw CLI 获取可用 Agent 列表
- **安全命令执行**: `safeExec()` 防注入封装，返回结构化结果

## 使用方式
这些是内部 API，不直接调用：
```typescript
import { checkAgentSession } from './agent-session.ts'
import { resolveDiscordId } from './discord-id-resolver.ts'
import { safeExec } from './safe-exec.ts'
```

## 当前限制
- 所有 OpenClaw CLI 调用在测试环境不可用（openclaw 是外部二进制文件）
- `discord-id-resolver.ts` 硬编码了文件路径和 Agent 映射
- `discoverAgents()` 失败时降级为空列表，依赖静态 `DEFAULT_AGENT_TASK_MAP`

## 相关模块
- 被依赖: dispatcher, notification
