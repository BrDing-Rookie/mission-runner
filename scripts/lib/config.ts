/**
 * config.ts — 集中配置解析模块
 *
 * 将所有可配置路径和参数统一管理，消除硬编码路径。
 * 优先级：pluginConfig > 环境变量 > 默认值
 */

import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

// ── 项目根目录自动检测 ──────────────────────────────────────────────────────────

const __config_dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 项目根目录（mission-runner 仓库根）。
 * 从当前文件位置 (scripts/lib/) 上溯两级。
 */
export const PROJECT_ROOT = resolve(__config_dirname, '..', '..');

// ── 配置接口 ──────────────────────────────────────────────────────────────────

export interface MissionRunnerConfig {
  /** Missions 存储目录（绝对路径） */
  missionsDir: string;
  /** Dispatch queue 目录（绝对路径） */
  dispatchQueueDir: string;
  /** Discord agent ID 映射文件路径 */
  discordAgentIdsPath: string;
  /** OpenClaw 配置文件路径 */
  openclawConfigPath: string;
  /** 通知适配器类型 */
  notificationAdapter: string;
  /** Discord 默认发送账号 */
  discordDefaultAccount: string;
  /** 插件项目根目录 */
  projectDir: string;
  /** Agent 工作区目录 */
  workspaceDir: string;
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function resolveDir(base: string, dir: string): string {
  return resolve(base, dir);
}

/**
 * 自动检测 discord-agent-ids.json 路径。
 * 按顺序检查常见位置，返回第一个存在的路径。
 */
function autoDetectDiscordIdsPath(): string {
  const home = process.env.HOME;
  if (!home) return '';
  const candidates = [
    join(home, '.openclaw/discord-agent-ids.json'),
    join(home, 'openclaw-workspaces/teams/rd/lead/projects/discord-agent-ids.json'),
  ];
  for (const p of candidates) {
    try { if (existsSync(p)) return p; } catch (e) { console.warn(`[config] autoDetectDiscordIdsPath: skipping ${p}:`, e instanceof Error ? e.message : e); }
  }
  return '';
}

/**
 * 自动检测 openclaw.json 配置路径。
 */
function autoDetectOpenClawConfig(): string {
  const home = process.env.HOME;
  if (!home) return '';
  const candidate = join(home, '.openclaw/openclaw.json');
  try { if (existsSync(candidate)) return candidate; } catch (e) { console.warn(`[config] autoDetectOpenClawConfig: skipping ${candidate}:`, e instanceof Error ? e.message : e); }
  return '';
}

// ── 配置解析 ──────────────────────────────────────────────────────────────────

/**
 * 从 pluginConfig + 环境变量 + 默认值构建完整配置。
 *
 * 优先级：pluginConfig > 环境变量 > 默认值
 */
export function resolveConfig(opts?: {
  pluginConfig?: Record<string, unknown>;
  agentWorkspaceDir?: string;
  pluginDir?: string;
}): MissionRunnerConfig {
  const workspace = opts?.agentWorkspaceDir ?? process.cwd();
  const pluginDir = opts?.pluginDir ?? PROJECT_ROOT;
  const pc = opts?.pluginConfig ?? {};

  const missionsDir = resolveDir(workspace,
    str(pc.missionsDir) ?? process.env.MISSIONS_DIR ?? 'missions');

  return {
    missionsDir,
    dispatchQueueDir: resolveDir(workspace,
      str(pc.dispatchQueueDir) || join(missionsDir, '.dispatch-queue')),
    discordAgentIdsPath: str(pc.discordAgentIdsPath)
      ? resolve(workspace, str(pc.discordAgentIdsPath)!)
      : (process.env.DISCORD_AGENT_IDS_PATH || autoDetectDiscordIdsPath()),
    openclawConfigPath: str(pc.openclawConfigPath)
      ? resolve(workspace, str(pc.openclawConfigPath)!)
      : autoDetectOpenClawConfig(),
    notificationAdapter: str(pc.notificationAdapter)
      ?? process.env.MISSION_NOTIFICATION_ADAPTER ?? 'console',
    discordDefaultAccount: str(pc.discordDefaultAccount) ?? 'discord-rd-lead',
    projectDir: pluginDir,
    workspaceDir: workspace,
  };
}
