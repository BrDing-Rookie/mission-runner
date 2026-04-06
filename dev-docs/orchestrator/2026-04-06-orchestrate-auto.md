# orchestrate --auto 自动推进模式

> 模块: orchestrator
> 创建日期: 2026-04-06
> 状态: 待开发
> 关联 Phase: P2 批次 C

## 目标
为 mission-orchestrate.ts 新增 --auto 模式，自动扫描所有活跃 mission 并逐一推进，支持持续运行。

## 涉及文件
- `scripts/mission-orchestrate.ts` — 新增 auto 模式

## 方案

### 新增 CLI 参数
- `--auto` — 自动模式：扫描所有活跃 mission 并逐一 orchestrate
- `--interval-ms <ms>` — 循环间隔（默认 60000ms = 60秒）
- `--once` — 配合 --auto 使用：扫描一轮后退出（不循环）

### 核心实现
1. --auto 模式下，调用 listMissionIds 获取所有 mission
2. 过滤出活跃状态的 mission（排除终态）
3. 对每个活跃 mission 执行现有的 orchestrate 逻辑
4. 循环模式：完成一轮后等待 interval-ms，再次扫描
5. 信号处理：SIGINT/SIGTERM 优雅退出
6. --once 模式：扫描一轮后退出，适合 cron 场景

### 输出格式
每轮输出 JSON 汇总：各 mission 的 decisions 和最终状态

## 验收标准
- [ ] `--auto` 模式可扫描所有活跃 mission
- [ ] `--auto --once` 模式扫描一轮后退出
- [ ] 循环模式可持续运行，信号优雅退出
- [ ] 原有单 mission 模式行为不变
- [ ] npm run typecheck 通过
- [ ] 新增测试

## 开发记录
### 2026-04-06
- 待 C1 完成后启动
