# 原子文件写入

> 模块: file-system
> 创建日期: 2026-04-06
> 状态: 进行中
> 关联 Phase: P2

## 目标

将 `safeWriteFile()` 和 `writeMission()` 中的直接 `writeFileSync` 替换为原子写入模式（write-tmp-then-rename），防止系统崩溃或进程中断时产生半写文件，保证 mission.json 读到的内容始终是完整的上一次提交或最新提交，从不是中间状态。

## 涉及文件

- `scripts/lib/fs-utils.ts` — 新增 `atomicWriteFileSync` 内部函数，替换 `safeWriteFile` 和 `writeMission` 中的 `writeFileSync`，移除相关 TODO 注释
- `scripts/atomic-write.test.ts` — 新增测试覆盖原子写入行为

## 方案

在 `fs-utils.ts` 中提取私有辅助函数 `atomicWriteFileSync`：

1. 构造临时路径 `${filePath}.tmp.${process.pid}`（同目录，避免跨文件系统问题）
2. 用 `writeFileSync` 写入临时文件
3. 用 `renameSync` 原子替换目标文件（在同一文件系统上，rename 是 POSIX 原子操作）

`appendEvent()` 使用 `appendFileSync` 追加，无需修改（append 本身不会产生部分读问题）。

## 验收标准

- [x] `safeWriteFile` 使用 write-tmp-then-rename 模式
- [x] `writeMission` 使用 write-tmp-then-rename 模式
- [x] 相关 TODO 注释已移除
- [x] 新增测试：写入后内容正确
- [x] 新增测试：成功写入后临时文件不残留
- [x] 新增测试：目录不存在时自动创建
- [x] 全量测试 `npm test` 通过

## 开发记录

### 2026-04-06
- 创建开发文档
- 修改 `scripts/lib/fs-utils.ts`：提取 `atomicWriteFileSync`，替换两处 `writeFileSync`，导入 `renameSync`，移除相关 TODO 注释
- 新增 `scripts/atomic-write.test.ts` 覆盖四个验收场景
- 全量测试通过
