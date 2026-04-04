# 编排器

## 功能概述
有限步自动推进器，循环执行「watchdog 评估 → 执行动作 → 派发新任务」直到到达终态或步数上限。

## 核心能力
- **多步推进**: `mission-orchestrate` 最多执行 `--max-steps` 步
- **组合启动**: `mission-start` 一键完成 create + plan + dispatch
- **Watchdog 循环**: 每步先调用 watchdog evaluate 获取建议动作，再执行
- **Auto-dispatch**: 检查并派发新解锁的 READY tasks

## 使用方式
```bash
# 组合启动
npm run mission-start -- --missions-dir ./missions --title "Title" --goal "Goal"

# 持续推进
npm run mission-orchestrate -- --missions-dir ./missions --mission-id <id> --max-steps 5
```

## 当前限制
- 非 daemon 模式，执行完 max-steps 步后退出
- 不支持 `--watch` 持续推进模式
- 外部 Agent 调用 task-update 触发的依赖解锁，要等下一次 watchdog 扫描才会被发现

## 相关模块
- 依赖: watchdog, dispatcher, verifier, file-system
- 被依赖: 用户/cron 直接调用
