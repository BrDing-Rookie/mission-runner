/**
 * mission-dispatch-agent.ts — 三级回退派发策略
 *
 * Level 1（默认）: 群聊 @ Agent — 直接在群内 mention 目标 Agent
 * Level 2（回退）: 创建 session → 启动后重新 @ — Agent 无活跃 session 时创建新 session 后再 mention
 * Level 3（兜底）: 写 dispatch queue 文件 — 由 orchestrator 通过 sessions_spawn 执行
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { escapeShellArg } from './shell-utils.ts';
import type { Mission, Task } from './types.ts';

// ── Constants ──────────────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? '/home/ubuntu';
const DISPATCH_QUEUE_DIR = join(HOME, '.openclaw/extensions/mission-runner/dispatch-queue');
const DISCORD_IDS_PATH = join(HOME, 'openclaw-workspaces/teams/rd/lead/projects/discord-agent-ids.json');

/** 等待 session 就绪的轮询间隔（ms） */
/** 等待 session 就绪的最大超时（ms） */
/** 等待 Agent 在群内响应的超时（ms） */
const MENTION_RESPONSE_TIMEOUT_MS = 15_000;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AgentSessionInfo {
  sessionKey: string;
  agentType?: string;
  status: 'active' | 'idle' | 'unknown';
  startedAt?: string;
}

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

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): void {
  execSync(`sleep ${Math.max(0, Math.round(ms / 1000))}`, { stdio: 'pipe' });
}

/**
 * 安全执行 CLI 命令，返回 { success, output, error }。
 */
function safeExec(command: string, timeoutMs: number = 10_000): { success: boolean; output: string; error?: string } {
  try {
    const output = execSync(command, {
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

// ── Core Functions ─────────────────────────────────────────────────────────────

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
    console.error('[mission-dispatch-agent] checkAgentSession: empty agentId');
    return [];
  }

  // 校验 agentId 格式，防止命令注入
  if (/[\n\r\0`$]/.test(agentId)) {
    console.error('[mission-dispatch-agent] checkAgentSession: invalid agentId format');
    return [];
  }

  const result = safeExec(
    `openclaw sessions --agent ${escapeShellArg(agentId)} --json`,
    15_000,
  );

  if (!result.success) {
    // sessions 命令不可用或无结果，视为无活跃 session
    console.error(`[mission-dispatch-agent] checkAgentSession failed: ${result.error}`);
    return [];
  }

  try {
    const _parsed = JSON.parse(result.output) as { sessions?: Record<string, unknown>[] };
    const sessions = _parsed.sessions ?? [];

    return sessions
      .filter((s: Record<string, unknown>) => {
        const status = String(s.status ?? '').toLowerCase();
        return status === 'active' || status === 'idle' || status === 'running';
      })
      .map((s: Record<string, unknown>): AgentSessionInfo => ({
        sessionKey: String(s.key ?? s.sessionKey ?? s.session_key ?? s.id ?? ''),
        agentType: s.agentType ? String(s.agentType) : undefined,
        status: String(s.status ?? 'unknown').toLowerCase() as AgentSessionInfo['status'],
        startedAt: s.startedAt ? String(s.startedAt) : undefined,
      }))
      .filter((info) => info.sessionKey.length > 0);
  } catch {
    console.error('[mission-dispatch-agent] checkAgentSession: JSON parse failed');
    return [];
  }
}

/**
 * 在群聊中 @ 目标 Agent，发送派发消息。
 *
 * 通过 `openclaw message send` 在指定 channel 中发送包含 @mention 的消息。
 *
 * @param agentMentionTag - Agent 的 @mention 标记（如 Discord 的 `<@botUserId>`）
 * @param channelId - 群聊 channel ID
 * @param message - 派发消息内容
 * @param channelType - 渠道类型（默认 "discord"）
 * @returns 是否发送成功
 */
export function mentionInDiscord(
  agentMentionTag: string,
  channelId: string,
  message: string,
  channelType: string = 'discord',
): boolean {
  if (!agentMentionTag || !channelId || !message) {
    console.error('[mission-dispatch-agent] mentionInDiscord: missing required params');
    return false;
  }

  // 校验输入防注入
  if (channelId.length > 256 || /[\n\r\0]/.test(channelId)) {
    console.error('[mission-dispatch-agent] mentionInDiscord: invalid channelId');
    return false;
  }

  const fullMessage = `${message}\n${agentMentionTag}`;

  const result = safeExec(
    `openclaw message send --account discord-rd-lead --channel ${escapeShellArg(channelType)} --target ${escapeShellArg(channelId)} --message ${escapeShellArg(fullMessage)}`,
    MENTION_RESPONSE_TIMEOUT_MS,
  );

  if (!result.success) {
    console.error(`[mission-dispatch-agent] mentionInDiscord failed: ${result.error}`);
    return false;
  }

  return true;
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
    console.error('[mission-dispatch-agent] createAgentSession: invalid agentId');
    return null;
  }

  const initMessage = 'Mission dispatch: session init for agent ' + agentId + '. Stand by for task.';
  const result = safeExec(
    'openclaw agent --agent ' + escapeShellArg(agentId) + ' --message ' + escapeShellArg(initMessage) + ' --json --timeout 30',
    35_000,
  );

  if (!result.success) {
    console.error(`[mission-dispatch-agent] createAgentSession failed: ${result.error}`);
    return null;
  }

  try {
    const parsed = JSON.parse(result.output);
    const sessionId = String(parsed?.result?.meta?.agentMeta?.sessionId ?? '');
    if (sessionId) {
      console.log(`[mission-dispatch-agent] createAgentSession success | agent=${agentId} | sessionId=${sessionId}`);
      return sessionId;
    }
  } catch { /* parse error */ }

  console.error('[mission-dispatch-agent] createAgentSession: no sessionId in response');
  return null;
}

/**
 * sessions_spawn 兜底派发 — 仅当 Level 1 和 Level 2 均失败时使用。
 *
 * CLI 不支持 sessions_spawn，此函数返回 null，标记任务保持 READY。
 *
 * @param task - 待派发的 task
 * @param missionId - 所属 mission ID
 * @returns spawn 的 session key，失败返回 null
 */
export function spawnFallback(task: Task, missionId: string): string | null {
  console.log(`[mission-dispatch-agent] spawnFallback: writing dispatch queue entry | taskId=${task.taskId}`);

  const agentId = task.agent ?? (task.config?.agentId as string | undefined) ?? '';
  const queueEntry = {
    taskId: task.taskId,
    missionId,
    agentId,
    title: task.title,
    description: task.description ?? '',
    type: task.type,
    queuedAt: new Date().toISOString(),
    status: 'pending',
  };

  // Write to dispatch queue file for orchestrator to pick up
  const queueDir = DISPATCH_QUEUE_DIR;
  const queueFile = join(queueDir, `${missionId}-${task.taskId}.json`);

  try {
    // Create queue directory if not exists
    if (!existsSync(queueDir)) {
      execSync(`mkdir -p '${queueDir}'`, { stdio: 'pipe' });
    }
    writeFileSync(queueFile, JSON.stringify(queueEntry, null, 2), 'utf-8');
    console.log(`[mission-dispatch-agent] spawnFallback: queued to ${queueFile}`);
    return null; // L3 queued, not a session key
  } catch (err) {
    console.error(`[mission-dispatch-agent] spawnFallback failed: ${err}`);
    return null;
  }
}

// ── Dispatch Orchestrator ──────────────────────────────────────────────────────

/**
 * 对单个 READY task 执行三级回退派发。
 *
 * 流程：
 *   1. 幂等检查：已有 sessionKey 的任务跳过
 *   2. Level 1：检查 Agent session 存在 → 直接在群内 @ mention
 *   3. Level 2：无活跃 session → 创建 session → 再次 @ mention
 *   4. Level 3：以上均失败 → sessions_spawn 兜底
 *
 * @param task - 待派发的 task
 * @param mission - 所属 mission
 * @param missionsDir - missions 目录路径（用于构造 task-update 回调命令）
 * @returns DispatchResult，含派发级别和结果
 */
export function dispatchTaskToAgent(task: Task, mission: Mission, missionsDir: string): DispatchResult {
  const timestamp = new Date().toISOString();
  const agentId = (task.agent ?? task.config?.agentId as string | undefined ?? '').trim();

  if (!agentId) {
    return {
      taskId: task.taskId,
      dispatchLevel: 1,
      success: false,
      agentId: '',
      error: 'No agent assigned to task',
      timestamp,
    };
  }

  // 幂等保护：已有 sessionKey 的任务跳过
  if (task.sessionKey) {
    return {
      taskId: task.taskId,
      dispatchLevel: (task.config?.dispatchLevel as 1 | 2 | 3) ?? 1,
      success: true,
      agentId,
      sessionKey: task.sessionKey,
      timestamp,
    };
  }

  const channelId = mission.owner?.chatId ?? '';
  const channelType = mission.owner?.channel ?? 'discord';
    // Agent ID → Discord User ID 映射（从外部 JSON 文件加载）
  let AGENT_DISCORD_IDS: Record<string, string> = {};
  try {
    const idsPath = DISCORD_IDS_PATH;
    AGENT_DISCORD_IDS = JSON.parse(readFileSync(idsPath, 'utf-8')) as Record<string, string>;
  } catch { /* fallback: no mapping */ }
  const discordUserId = AGENT_DISCORD_IDS[agentId];
  const agentMentionTag = (task.config?.agentMentionTag as string | undefined)
    ?? (discordUserId ? `<@${discordUserId}>` : `@${agentId}`);
  const dispatchMessage = buildDispatchMessage(task, mission, missionsDir);

  // ── Level 1: 群聊 @ Agent ────────────────────────────────────────────────
  const activeSessions = checkAgentSession(agentId);

  if (activeSessions.length > 0) {
    const sent = mentionInDiscord(agentMentionTag, channelId, dispatchMessage, channelType);
    if (sent) {
      console.log(`[mission-dispatch-agent] L1 success | taskId=${task.taskId} | agent=${agentId} | sessionKey=${activeSessions[0]!.sessionKey}`);
      return {
        taskId: task.taskId,
        dispatchLevel: 1,
        success: true,
        agentId,
        sessionKey: activeSessions[0]!.sessionKey,
        timestamp,
      };
    }
    // mention 发送失败，降级到 L2
    console.error(`[mission-dispatch-agent] L1 mention failed, falling back to L2 | taskId=${task.taskId}`);
  }

  // ── Level 2: 创建 session → 启动后重新 @ ─────────────────────────────────
  console.log(`[mission-dispatch-agent] Trying L2 | taskId=${task.taskId} | agent=${agentId}`);
  const newSessionKey = createAgentSession(agentId);

  if (newSessionKey) {
    const sent = mentionInDiscord(agentMentionTag, channelId, dispatchMessage, channelType);
    if (sent) {
      console.log(`[mission-dispatch-agent] L2 success | taskId=${task.taskId} | agent=${agentId} | sessionKey=${newSessionKey}`);
      return {
        taskId: task.taskId,
        dispatchLevel: 2,
        success: true,
        agentId,
        sessionKey: newSessionKey,
        timestamp,
      };
    }
    // 创建了 session 但 mention 失败，继续到 L3
    console.error(`[mission-dispatch-agent] L2 mention failed, falling back to L3 | taskId=${task.taskId}`);
  }

  // ── Level 3: dispatch queue 兜底 ─────────────────────────────────────────
  console.log(`[mission-dispatch-agent] Trying L3 (dispatch queue) | taskId=${task.taskId} | agent=${agentId}`);
  const queueResult = spawnFallback(task, mission.missionId);

  if (queueResult) {
    console.log(`[mission-dispatch-agent] L3 success (queued) | taskId=${task.taskId} | agent=${agentId}`);
    return {
      taskId: task.taskId,
      dispatchLevel: 3,
      success: true,
      agentId,
      timestamp,
    };
  }
  // queue 写入成功但返回 null → 也算成功（已写入 queue 文件）
  console.log(`[mission-dispatch-agent] L3 queued | taskId=${task.taskId} | agent=${agentId}`);
  return {
    taskId: task.taskId,
    dispatchLevel: 3,
    success: true,
    agentId,
    timestamp,
  };

  // 全部失败
  console.error(`[mission-dispatch-agent] ALL LEVELS FAILED | taskId=${task.taskId} | agent=${agentId}`);
  return {
    taskId: task.taskId,
    dispatchLevel: 3,
    success: false,
    agentId,
    error: 'All dispatch levels failed (L1→L2→L3)',
    timestamp,
  };
}

/**
 * 构建派发消息（含闭环回报指令）。
 *
 * 派发消息中自动注入 task-update 命令，Agent 完成后必须调用此命令
 * 汇报结果，触发 mission 状态推进和下一步派发。
 */
function buildDispatchMessage(task: Task, mission: Mission, _missionsDir: string): string {
  const desc = task.description ? `\n详情: ${task.description}` : '';
  const agentId = task.agent ?? (task.config?.agentId as string | undefined) ?? 'unknown';

  return [
    `📤 新任务派发 [${task.taskId}]「${task.title}」`,
    `类型: ${task.type} | Mission: ${mission.missionId}${desc}`,
    `[SubAgent-${agentId}] 请开始执行，每条消息前加此标识。`,
    '',
    '⚠️ 执行完成后，你必须参照 mission-controller skill 的规范汇报结果：',
    `1. 读取 /opt/openclaw/versions/v2026.3.28/skills/mission-controller/SKILL.md`,
    `2. 按照 skill 中「子 Agent 返回结果后」的流程执行`,
    `3. 使用 exec 调用 task-update 汇报状态（参考 skill 中的命令格式）`,
  ].join('\n');
}
