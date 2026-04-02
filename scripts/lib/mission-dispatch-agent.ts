/**
 * mission-dispatch-agent.ts — 三级回退派发策略（编排层）
 *
 * Level 1（默认）: 群聊 @ Agent — 直接在群内 mention 目标 Agent
 * Level 2（回退）: 创建 session → 启动后重新 @ — Agent 无活跃 session 时创建新 session 后再 mention
 * Level 3（兜底）: 写 dispatch queue 文件 — 由 orchestrator 通过 sessions_spawn 执行
 *
 * 各子模块：
 * - discord-id-resolver.ts — Discord user ID 解析 + agent→account 映射
 * - agent-session.ts — Agent session 检查与创建
 * - dispatch-messenger.ts — 消息发送 + 派发消息构建
 * - dispatch-queue.ts — Level 3 队列兜底
 * - safe-exec.ts — 安全 CLI 执行包装
 */

import { checkAgentSession, createAgentSession } from './agent-session.ts';
import { resolveAgentMentionTag } from './discord-id-resolver.ts';
import { buildDispatchMessage, mentionInDiscord } from './dispatch-messenger.ts';
import { spawnFallback } from './dispatch-queue.ts';
import type { Mission, Task } from './types.ts';

// Re-export types and functions used by consumers
export type { AgentSessionInfo } from './agent-session.ts';
export { checkAgentSession, createAgentSession } from './agent-session.ts';
export { mentionInDiscord } from './dispatch-messenger.ts';
export { spawnFallback } from './dispatch-queue.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DispatchResult {
  taskId: string;
  dispatchLevel: 1 | 2 | 3;
  success: boolean;
  agentId: string;
  sessionKey?: string;
  error?: string;
  timestamp: string;
}

export interface DispatchSummary {
  totalReady: number;
  level1Success: number;
  level2Success: number;
  level3Fallback: number;
  failed: number;
  results: DispatchResult[];
}

// ── Dispatch Orchestrator ──────────────────────────────────────────────────────

/**
 * 对单个 READY task 执行三级回退派发。
 *
 * 流程：
 *   1. 幂等检查：已有 sessionKey 的任务跳过
 *   2. Level 1：检查 Agent session 存在 → 直接在群内 @ mention
 *   3. Level 2：无活跃 session → 创建 session → 再次 @ mention
 *   4. Level 3：以上均失败 → dispatch queue 兜底
 */
export function dispatchTaskToAgent(task: Task, mission: Mission, missionsDir: string): DispatchResult {
  const timestamp = new Date().toISOString();
  const agentId = (task.agent ?? task.config?.agentId as string | undefined ?? '').trim();

  if (!agentId) {
    return { taskId: task.taskId, dispatchLevel: 1, success: false, agentId: '', error: 'No agent assigned to task', timestamp };
  }

  // 幂等保护：已有 sessionKey 的任务跳过
  if (task.sessionKey) {
    return {
      taskId: task.taskId,
      dispatchLevel: (task.config?.dispatchLevel as 1 | 2 | 3) ?? 1,
      success: true, agentId, sessionKey: task.sessionKey, timestamp,
    };
  }

  const channelId = mission.owner?.chatId ?? '';
  const channelType = mission.owner?.channel ?? 'discord';
  const configMentionTag = (task.config?.agentMentionTag as string | undefined) ?? '';
  const agentMentionTag = resolveAgentMentionTag(agentId, configMentionTag);
  const dispatchMessage = buildDispatchMessage(task, mission, missionsDir);

  // ── Level 1: 群聊 @ Agent ────────────────────────────────────────────────
  const activeSessions = checkAgentSession(agentId);

  if (activeSessions.length > 0) {
    const sent = mentionInDiscord(agentMentionTag, channelId, dispatchMessage, channelType);
    if (sent) {
      console.log(`[dispatch-agent] L1 success | taskId=${task.taskId} | agent=${agentId} | sessionKey=${activeSessions[0]!.sessionKey}`);
      return { taskId: task.taskId, dispatchLevel: 1, success: true, agentId, sessionKey: activeSessions[0]!.sessionKey, timestamp };
    }
    console.error(`[dispatch-agent] L1 mention failed, falling back to L2 | taskId=${task.taskId}`);
  }

  // ── Level 2: 创建 session → 启动后重新 @ ─────────────────────────────────
  console.log(`[dispatch-agent] Trying L2 | taskId=${task.taskId} | agent=${agentId}`);
  const newSessionKey = createAgentSession(agentId);

  if (newSessionKey) {
    const sent = mentionInDiscord(agentMentionTag, channelId, dispatchMessage, channelType);
    if (sent) {
      console.log(`[dispatch-agent] L2 success | taskId=${task.taskId} | agent=${agentId} | sessionKey=${newSessionKey}`);
      return { taskId: task.taskId, dispatchLevel: 2, success: true, agentId, sessionKey: newSessionKey, timestamp };
    }
    console.error(`[dispatch-agent] L2 mention failed, falling back to L3 | taskId=${task.taskId}`);
  }

  // ── Level 3: dispatch queue 兜底 ─────────────────────────────────────────
  console.log(`[dispatch-agent] Trying L3 (dispatch queue) | taskId=${task.taskId} | agent=${agentId}`);
  const queueResult = spawnFallback(task, mission.missionId, missionsDir);

  if (queueResult) {
    console.log(`[dispatch-agent] L3 success (queued) | taskId=${task.taskId} | agent=${agentId}`);
    return { taskId: task.taskId, dispatchLevel: 3, success: true, agentId, timestamp };
  }

  console.error(`[dispatch-agent] ALL LEVELS FAILED | taskId=${task.taskId} | agent=${agentId}`);
  return { taskId: task.taskId, dispatchLevel: 3, success: false, agentId, error: 'All dispatch levels failed (L1→L2→L3)', timestamp };
}
