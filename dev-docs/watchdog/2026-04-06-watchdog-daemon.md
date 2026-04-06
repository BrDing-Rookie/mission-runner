# Watchdog Daemon 化

> 模块: watchdog
> 创建日期: 2026-04-06
> 状态: 进行中
> 关联 Phase: P2 批次 C

## 目标
将 mission-watchdog.ts 从单次扫描 CLI 工具改造为可持续运行的守护进程模式，支持周期性扫描 + 优雅退出。

## 涉及文件
- `scripts/mission-watchdog.ts` — 新增 daemon 模式入口
- `scripts/lib/types.ts` — 可能新增 daemon 配置类型

## 方案

### 新增 CLI 参数
- `--daemon` — 启用守护进程模式（默认仍为单次扫描）
- `--interval-ms <ms>` — 扫描间隔（默认 30000ms = 30秒）
- `--health-file <path>` — 健康检查文件路径（每次扫描后写入时间戳）

### 核心实现
1. daemon 模式下进入 `setInterval` 循环，每 interval-ms 执行一次完整扫描
2. 注册 SIGINT / SIGTERM 信号处理，收到后优雅退出（完成当前扫描后停止）
3. 每次扫描后写入 health file（JSON: `{pid, lastScanAt, scanned, skipped}`）
4. 异常处理：单次扫描异常不退出 daemon，记录 error 后继续下次扫描
5. 新增 `npm run watchdog:daemon` 脚本

### 不做的事
- 不引入进程管理器（systemd/pm2），仅提供 daemon 循环
- 不修改 evaluateMission 核心逻辑
- 不新增外部依赖

## 验收标准
- [ ] `--daemon` 模式可持续运行，ctrl+c 优雅退出
- [ ] `--interval-ms` 控制扫描频率
- [ ] health file 每次扫描后更新
- [ ] 单次扫描模式（无 --daemon）行为不变
- [ ] 新增测试覆盖 daemon 信号处理和参数解析
- [ ] npm run typecheck 通过

## 开发记录
### 2026-04-06
- 开发启动
