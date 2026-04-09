/**
 * discord-id-resolver.ts — Discord bot user ID resolution
 *
 * Resolves Discord bot user IDs from:
 * 1. Static mapping file (discord-agent-ids.json)
 * 2. OpenClaw config token parsing (base64 userId extraction)
 *
 * Also provides agent → account name mapping for fallback resolution.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** Agent ID → OpenClaw account name 静态映射 */
export const AGENT_ACCOUNT_MAP: Record<string, string> = {
  'codex': 'discord-rd-arch',
  'claude-code': 'discord-rd-dev-1',
  'rd-review': 'discord-rd-reviewer',
  'rd-coordinator': 'discord-rd-lead',
  'rd-liaison': 'discord-rd-dev-2',
};

/**
 * 自动从 OpenClaw 配置中解析 Discord bot user IDs。
 * Discord token 格式: base64(userId).timestamp.hmac
 * 解析第一段即可得到 bot 的 user ID。
 *
 * @param discordIdsPath - discord-agent-ids.json 路径（可选）
 * @param openclawConfigPath - openclaw.json 配置路径（可选）
 */
export function resolveDiscordUserIds(
  discordIdsPath?: string,
  openclawConfigPath?: string,
): Record<string, string> {
  // 自动检测路径（兜底）
  const home = process.env.HOME ?? '';
  const idsPath = discordIdsPath
    || process.env.DISCORD_AGENT_IDS_PATH
    || autoDetectFile([
      home ? join(home, '.openclaw/discord-agent-ids.json') : '',
      home ? join(home, 'openclaw-workspaces/teams/rd/lead/projects/discord-agent-ids.json') : '',
    ]);
  const configPath = openclawConfigPath
    || (home ? join(home, '.openclaw/openclaw.json') : '');

  // 1. 优先尝试读取静态映射文件
  if (idsPath) {
    try {
      if (existsSync(idsPath)) {
        return JSON.parse(readFileSync(idsPath, 'utf-8')) as Record<string, string>;
      }
    } catch { /* fall through */ }
  }

  // 2. 从 OpenClaw config 中解析
  if (configPath) {
    try {
      if (!existsSync(configPath)) return {};
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const accounts = config?.channels?.discord?.accounts ?? {};
      const result: Record<string, string> = {};

      for (const [accName, acc] of Object.entries(accounts)) {
        const token = (acc as Record<string, unknown>)?.token;
        if (typeof token !== 'string' || !token) continue;
        try {
          const parts = token.split('.');
          let b64 = parts[0];
          const padding = 4 - (b64.length % 4);
          if (padding !== 4) b64 += '='.repeat(padding);
          const userId = Buffer.from(b64, 'base64').toString('utf-8');
          if (/^\d+$/.test(userId)) {
            result[accName] = userId;
          }
        } catch (e) { console.warn(`[discord-id-resolver] skipping account ${accName}: token parse failed:`, e instanceof Error ? e.message : e); }
      }

      return result;
    } catch {
      return {};
    }
  }

  return {};
}

/** 从候选路径列表中找到第一个存在的文件 */
function autoDetectFile(candidates: string[]): string {
  for (const p of candidates) {
    if (!p) continue;
    try { if (existsSync(p)) return p; } catch { /* skip */ }
  }
  return '';
}

/**
 * 解析 agentId 对应的 Discord mention tag。
 *
 * 优先使用 task config 中的 agentMentionTag，
 * 其次通过 Discord user ID 映射生成 `<@userId>`，
 * 最后回退到 `@agentId` 纯文本。
 */
export function resolveAgentMentionTag(
  agentId: string,
  configMentionTag?: string,
): string {
  if (configMentionTag?.trim()) {
    return configMentionTag.trim();
  }

  const accountDiscordIds = resolveDiscordUserIds();

  // 直接查找 agentId
  let discordUserId = accountDiscordIds[agentId];
  if (!discordUserId) {
    // 通过 agent→account 映射查找
    const accountName = AGENT_ACCOUNT_MAP[agentId];
    if (accountName) {
      discordUserId = accountDiscordIds[accountName];
    }
  }

  return discordUserId ? `<@${discordUserId}>` : `@${agentId}`;
}
