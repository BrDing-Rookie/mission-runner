/**
 * shell-utils.ts — Shell 相关工具函数
 */

/**
 * 转义 shell 参数，防止注入
 */
export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
