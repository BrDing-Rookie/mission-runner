# 看门狗

## 功能概述
定期扫描所有活跃 mission 的状态，评估每个 mission 的健康状况，输出推荐的下一步动作（不直接执行）。

## 核心能力
- **全量扫描**: 遍历所有非终态 mission
- **Task stall 检测**: 检测运行中任务是否超过阈值（默认 30 分钟）无进展
- **动作建议**: 输出 10 种动作类型（NONE/CHECK_BACKGROUND/RESUME_TASK/TRIGGER_VERIFY/RETRY_TASK/ITERATE/ESCALATE_STUCK/ESCALATE_MAX_RETRY/NOTIFY_COMPLETE/NOTIFY_ESCALATION）
- **Auto-verify 触发**: 当所有 task 到达终态时，自动建议 TRIGGER_VERIFY
- **Auto-collect**: stalled task 自动通过 git log 检测是否有新 commit

## 使用方式
```bash
npm run watchdog                    # 扫描并执行建议动作
npm run watchdog:dry-run            # 仅输出建议，不执行
npm run mission-run-action -- --missions-dir ./missions --mission-id <id> --action <ACTION>
```

## 当前限制
- 一次性命令行运行，非 daemon 模式，无内置定时循环
- 无 systemd timer 或 cron job 配置
- 保守策略：只建议不执行，需要 run-action 或 orchestrate 来执行

## 相关模块
- 依赖: state-machine, file-system
- 被依赖: orchestrator（循环调用 watchdog evaluate）
- 协作: mission-actions.ts 执行 watchdog 建议的动作
