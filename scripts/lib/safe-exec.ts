/**
 * safe-exec.ts — Safe CLI command execution wrapper
 *
 * Wraps execFileSync with error handling, returning a structured result
 * instead of throwing on failure.
 */

import { execFileSync } from 'child_process';

export interface SafeExecResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * 安全执行 CLI 命令，返回 { success, output, error }。
 *
 * Uses execFileSync to avoid shell injection; the first element of argv
 * is the executable, the rest are arguments.
 */
export function safeExec(argv: string[], timeoutMs: number = 10_000): SafeExecResult {
  try {
    const output = execFileSync(argv[0], argv.slice(1), {
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { success: true, output };
  } catch (err) {
    const e = err as { message?: string; stderr?: string; stdout?: string };
    return { success: false, output: (e.stdout ?? '').trim(), error: e.message ?? String(err) };
  }
}
