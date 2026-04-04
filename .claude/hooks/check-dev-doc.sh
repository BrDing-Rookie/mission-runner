#!/bin/bash
# Pre-tool hook: 编辑 scripts/ 下的 .ts 源文件时，
# 检查 dev-docs/BACKLOG.md 中是否有「进行中」的开发任务。

# 从 stdin 读取 tool input JSON
INPUT=$(cat)

# 提取被编辑的文件路径
FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // empty')

# 只检查 scripts/lib/ 或 scripts/ 下的 .ts 文件（排除测试文件和类型声明）
if [[ "$FILE_PATH" == */scripts/*.ts ]] && [[ "$FILE_PATH" != *.test.ts ]] && [[ "$FILE_PATH" != *.d.ts ]]; then
  # 排除非代码文件的编辑（如 dev-docs、project-docs、docs 下的文件）
  if [[ "$FILE_PATH" == */dev-docs/* ]] || [[ "$FILE_PATH" == */project-docs/* ]] || [[ "$FILE_PATH" == */docs/* ]]; then
    exit 0
  fi

  if [ ! -f "dev-docs/BACKLOG.md" ]; then
    echo "BLOCKED: dev-docs/BACKLOG.md 不存在。请先按照 CLAUDE.md 中的 Development Doc Workflow 创建开发文档。"
    exit 1
  fi

  # 检查 BACKLOG 中是否有「进行中」的条目
  if ! grep -q "进行中" dev-docs/BACKLOG.md 2>/dev/null; then
    echo "BLOCKED: dev-docs/BACKLOG.md 中没有「进行中」的开发任务。"
    echo "请先在 dev-docs/<module>/ 下创建开发文档并在 BACKLOG.md 中将状态设为「进行中」。"
    echo "详见 CLAUDE.md \"Development Doc Workflow\" 章节。"
    exit 1
  fi
fi

exit 0
