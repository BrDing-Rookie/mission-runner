/**
 * agent-session.ts — Agent session management
 *
 * Check for active agent sessions and create new ones via OpenClaw CLI.
 */

import { safeExec } from './safe-exec.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentSessionInfo {
  sessionKey: string;
  agentType?: string;
  status: 'active' | 'idle' | 'unknown';
  startedAt?: string;
}

// ── Functions ──────────────────────────────────────────────────────────────────

/**
 * 检查指定 Agent 是否有活跃 session。
 *
 * 调用 `openclaw sessions --agent <id> --json` 获取 session 列表，
 * 筛选包含 agentId 的活跃 session。
 *
 * @param agentId - Agent 标识符（如 "codex", "claude"）
 * @returns 活跃 session 信息列表；空数组表示无活跃 session
 */
export function checkAgentSession(agentId: string): AgentSessionInfo[] {
  if (!agentId || agentId.trim().length === 0) {
    console.error('[agent-session] checkAgentSession: empty agentId');
    return [];
  }

  // 校验 agentId 格式，防止命令注入
  if (/[\n\r\0`$]/.test(agentId)) {
    console.error('[agent-session] checkAgentSession: invalid agentId format');
    return [];
  }

  const result = safeExec(
    ['openclaw', 'sessions', '--agent', agentId, '--json'],
    15_000,
  );

  if (!result.success) {
    console.error(`[agent-session] checkAgentSession failed: ${result.error}`);
    return [];
  }

  try {
    const _parsed = JSON.parse(result.output) as { sessions?: Record<string, unknown>[] };
    const sessions = _parsed.sessions ?? [];

    return sessions
      .filter((s: Record<string, unknown>) => {
        const status = String(s.status ?? '').toLowerCase();
        return !status || status === 'active' || status === 'idle' || status === 'running' || status === 'unknown';
      })
      .map((s: Record<string, unknown>): AgentSessionInfo => ({
        sessionKey: String(s.key ?? s.sessionKey ?? s.session_key ?? s.id ?? ''),
        agentType: s.agentType ? String(s.agentType) : undefined,
        status: String(s.status ?? 'unknown').toLowerCase() as AgentSessionInfo['status'],
        startedAt: s.startedAt ? String(s.startedAt) : undefined,
      }))
      .filter((info) => info.sessionKey.length > 0);
  } catch {
    console.error('[agent-session] checkAgentSession: JSON parse failed');
    return [];
  }
}

/**
 * 为指定 Agent 创建新的 session。
 *
 * 通过 `openclaw agent --agent <id> --message` 触发 agent turn 创建 session，
 * 然后轮询等待 session 就绪。
 *
 * @param agentId - Agent 标识符
 * @returns 创建的 session key，失败返回 null
 */
export function createAgentSession(agentId: string): string | null {
  if (!agentId || agentId.trim().length === 0) {
    console.error('[agent-session] createAgentSession: invalid agentId');
    return null;
  }

  const initMessage = 'Mission dispatch: session init for agent ' + agentId + '. Stand by for task.';
  const result = safeExec(
    ['openclaw', 'agent', '--agent', agentId, '--message', initMessage, '--json', '--timeout', '30'],
    35_000,
  );

  if (!result.success) {
    console.error(`[agent-session] createAgentSession failed: ${result.error}`);
    return null;
  }

  try {
    const parsed = JSON.parse(result.output);
    const sessionId = String(parsed?.result?.meta?.agentMeta?.sessionId ?? '');
    if (sessionId) {
      console.log(`[agent-session] createAgentSession success | agent=${agentId} | sessionId=${sessionId}`);
      return sessionId;
    }
  } catch { /* parse error */ }

  console.error('[agent-session] createAgentSession: no sessionId in response');
  return null;
}
