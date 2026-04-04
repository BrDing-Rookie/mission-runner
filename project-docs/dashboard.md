# 仪表盘

## 功能概述
将 mission 状态数据格式化为 Discord embed 格式，用于在 Discord 频道中展示 mission 进度面板。

## 核心能力
- **Embed 格式化**: 将 mission + tasks 数据转换为 Discord embed 结构
- **进度条**: 可视化任务完成百分比
- **状态 Emoji**: 为每种 task 状态分配对应 emoji
- **阶段分组**: 按 task phase 分组展示

## 使用方式
```typescript
import { formatDashboardEmbed } from './dashboard-formatter.ts'
const embed = formatDashboardEmbed(mission)
```

## 当前限制
- 无独立测试
- 仅支持 Discord embed 格式，不支持其他输出格式

## 相关模块
- 依赖: state-machine（类型定义）
