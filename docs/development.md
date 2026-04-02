# Mission Runner 开发指南

> 版本：2026-04-02

## 环境要求

- Node.js >= 18
- TypeScript（ES2022, ESM）
- tsx（直接运行 .ts 脚本，无需构建）

## 快速开始

```bash
cd /home/ubuntu/public-deliverables/mission-runner
npm install
npm run typecheck    # TypeScript 类型检查
npm test             # 运行所有测试
```

## 项目结构

```
mission-runner/
├── README.md              # 项目简介 + 快速开始
├── CLAUDE.md              # Claude Code 工作指引
├── CODE_REVIEW.md         # 代码审查 TODO
├── docs/
│   ├── architecture.md    # 架构文档
│   ├── api.md             # 脚本接口文档
│   ├── development.md     # 本文件
│   └── archive/           # 历史文档
├── schemas/               # JSON Schema 契约
│   ├── mission.schema.json
│   ├── task.schema.json
│   └── verification.schema.json
├── scripts/
│   ├── lib/               # 核心库
│   └── *.ts               # CLI 入口脚本 + 测试
├── skills/
│   └── mission-controller/ # OpenClaw Skill
├── missions/              # Mission 数据目录
├── index.ts               # 插件入口
├── openclaw.plugin.json   # 插件配置
├── package.json
└── tsconfig.json
```

## 常用命令

```bash
# 类型检查
npm run typecheck

# 运行所有测试
npm test

# 创建并启动 mission
npm run mission-start -- --missions-dir ./missions \
  --title "标题" --goal "目标"

# 有限步推进
npm run mission-orchestrate -- --missions-dir ./missions \
  --mission-id <id> --max-steps 5

# Watchdog 扫描（dry-run）
npm run watchdog:dry-run

# 执行动作
npm run mission-run-action -- --missions-dir ./missions \
  --mission-id <id> --action CHECK_BACKGROUND
```

## 技术栈

| 技术 | 用途 |
|------|------|
| TypeScript (ES2022, ESM) | 源代码 |
| tsx | 运行 .ts 脚本（无需编译） |
| node:test | 内置测试框架 |
| Zod | 运行时校验（部分接入） |
| JSON Schema | mission/task/verification 契约 |

## 开发规范

### 状态与 Schema 一致性

以下内容必须保持同步：
- `schemas/*.schema.json` 的状态枚举
- `scripts/lib/types.ts` 中的 `MissionStatus`
- `TERMINAL_STATUSES` / `ACTIVE_STATUSES`

### 幂等与 no-op

- 重复执行不能产生假进展
- no-op 不能污染 `lastProgressAt` 和审计事件
- 同一状态转换只通知一次（`notifiedTransitions` 去重）

### 文件写入

- 使用 `fs-utils.ts` 提供的 `writeMission()` / `commitMissionUpdate()`
- 保持同步写入优先
- 支持原子写入防并发

### 状态迁移

- 所有迁移必须通过 `isTransitionAllowed()` 校验
- 合法迁移定义在 `types.ts` 的 `ALLOWED_TRANSITIONS`

### 通知

- 通知发送失败不阻塞 mission 推进（fire-and-forget）
- 通过环境变量 `MISSION_NOTIFICATION_ADAPTER` 选择适配器
- 测试时使用 `fake` 适配器

## 测试

```bash
# 运行全量测试
npm test

# 运行单个测试文件
node --import tsx --test scripts/mission-watchdog.test.ts
```

测试使用 Node.js 内置 `node:test` 框架，测试文件与源文件同目录，命名为 `*.test.ts`。

## Git 工作流

项目使用 Git 版本控制。

```bash
# 远端仓库
git remote -v
# origin  git@codeup.aliyun.com:6933e024f3eec50950f6ce30/openclaw_workspace/mission-runner.git
```

## 相关文档

- [架构文档](./architecture.md) — 模块职责、状态机、数据流
- [API 文档](./api.md) — 脚本接口、参数、数据结构
- [历史文档](./archive/) — 项目介绍、迭代计划、交接说明等
