/**
 * mission-agent-discovery.ts — 群聊内 Agent 发现
 *
 * 通过 OpenClaw CLI 获取群聊内可用的 Agent 列表，
 * 供 mission-plan.ts 为 task 分配 Agent。
 */

import { execFileSync } from 'child_process';
import type { Task } from './types.ts';

/** 群聊内可用的 Agent 信息 */
export interface AvailableAgent {
  agentId: string;            // OpenClaw agent ID
  name: string;               // 显示名称
  mentionTag: string;         // 渠道内 @mention 标记（如 Discord 的 <@botUserId>）
  skills: string[];           // Agent 具备的 skill 列表
  taskTypes: string[];        // Agent 擅长的任务类型
}

/**
 * 从 OpenClaw 配置获取群聊内可用 Agent。
 *
 * 尝试调用 `openclaw agents list --channel <channel> --chat-id <chatId> --json`。
 * 如果 CLI 不可用或无结果，返回空数组（降级：orchestrator 自己执行所有 task）。
 */
export function discoverAgents(options: {
  channel: string;
  chatId: string;
}): AvailableAgent[] {
  if (!options.channel || !options.chatId) {
    return [];
  }

  // 校验 channel 和 chatId 格式，防止注入
  const MAX_LEN = 256;
  const INVALID_CHARS = /[\n\r\0]/;
  if (
    options.channel.length > MAX_LEN || options.chatId.length > MAX_LEN ||
    INVALID_CHARS.test(options.channel) || INVALID_CHARS.test(options.chatId)
  ) {
    console.error('[mission-agent-discovery] invalid channel or chatId format, returning empty list');
    return [];
  }

  try {
    const stdout = execFileSync(
      'openclaw',
      ['agents', 'list', '--channel', options.channel, '--chat-id', options.chatId, '--json'],
      { timeout: 10_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((entry: Record<string, unknown>): AvailableAgent => ({
      agentId: String(entry.agentId ?? entry.id ?? ''),
      name: String(entry.name ?? ''),
      mentionTag: String(entry.mentionTag ?? ''),
      skills: Array.isArray(entry.skills) ? entry.skills.map(String) : [],
      taskTypes: Array.isArray(entry.taskTypes) ? entry.taskTypes.map(String) : [],
    })).filter((a) => a.agentId && a.name);
  } catch {
    // CLI 不可用或解析失败，降级：返回空列表
    console.error('[mission-agent-discovery] discoverAgents failed, returning empty list');
    return [];
  }
}

/**
 * 默认的 agent → task type 映射。
 * 当 CLI 不提供 taskTypes/skills 时，用此静态映射做兜底匹配。
 */
const DEFAULT_AGENT_TASK_MAP: Record<string, string[]> = {
  'codex': ['research', 'code', 'test'],
  'claude-code': ['analysis', 'code', 'document'],
  'rd-review': ['review', 'verification'],
};

/**
 * 根据 task type 匹配最佳 Agent。
 *
 * 匹配优先级：
 * 1. taskTypes 精确匹配（CLI 提供时）
 * 2. skills 模糊匹配（CLI 提供时）
 * 3. agentId 静态映射兜底（DEFAULT_AGENT_TASK_MAP）
 * 
 * 无匹配则返回 null（由 orchestrator 自己执行）。
 */
export function matchAgentForTask(
  task: Task,
  agents: AvailableAgent[],
): AvailableAgent | null {
  if (agents.length === 0) return null;

  // 优先：taskTypes 精确匹配
  const byTaskType = agents.find((a) => a.taskTypes.length > 0 && a.taskTypes.includes(task.type));
  if (byTaskType) return byTaskType;

  // 其次：skills 模糊匹配
  const bySkill = agents.find((a) => a.skills.length > 0 && a.skills.includes(task.type));
  if (bySkill) return bySkill;

  // 兜底：agentId 静态映射
  const byStaticMap = agents.find((a) => {
    const mappedTypes = DEFAULT_AGENT_TASK_MAP[a.agentId];
    return mappedTypes !== undefined && mappedTypes.includes(task.type);
  });
  if (byStaticMap) return byStaticMap;

  return null;
}

