import { execFileSync } from 'child_process';
import type { Mission, MissionStatus } from './types.ts';

export type MissionNotificationKind =
  | 'complete'
  | 'escalation'
  | 'status_transition'
  | 'task_dispatched'
  | 'task_completed'
  | 'task_failed';

export interface MissionNotificationPayload {
  kind: MissionNotificationKind;
  missionId: string;
  title: string;
  status: Mission['status'];
  content: string;
  mentions?: string[];              // @mention 标记列表
  transitionFrom?: MissionStatus;   // mission 级状态变更：来源状态
  transitionTo?: MissionStatus;     // mission 级状态变更：目标状态
  taskId?: string;                  // 关联的 task
  source?: string;                  // 触发来源标识
  metadata?: Record<string, unknown>;
}

export interface MissionNotificationDeliveryMetadata {
  adapter: string;
  target?: string;
  externalMessageId?: string;
  provider?: string;
  deliveredAt: string;
  dryRun?: boolean;
  [key: string]: unknown;
}

export interface MissionNotificationResult {
  delivered: boolean;
  metadata: MissionNotificationDeliveryMetadata;
}

export interface MissionNotificationAdapter {
  readonly name: string;
  send(payload: MissionNotificationPayload, context: { mission: Mission; dryRun: boolean }): MissionNotificationResult;
}

export class ConsoleMissionNotificationAdapter implements MissionNotificationAdapter {
  readonly name = 'console';

  send(payload: MissionNotificationPayload, context: { mission: Mission; dryRun: boolean }): MissionNotificationResult {
    console.error(`[mission-notify:${this.name}] ${payload.content}`);
    return {
      delivered: true,
      metadata: {
        adapter: this.name,
        deliveredAt: new Date().toISOString(),
        dryRun: context.dryRun,
      },
    };
  }
}

export class FakeMissionNotificationAdapter implements MissionNotificationAdapter {
  readonly name = 'fake';

  send(_payload: MissionNotificationPayload, context: { mission: Mission; dryRun: boolean }): MissionNotificationResult {
    return {
      delivered: true,
      metadata: {
        adapter: this.name,
        deliveredAt: new Date().toISOString(),
        dryRun: context.dryRun,
      },
    };
  }
}

export interface DiscordMissionNotificationConfig {
  channel: string;
  username?: string;
}

export class DiscordMissionNotificationAdapter implements MissionNotificationAdapter {
  readonly name = 'discord';
  private readonly config: DiscordMissionNotificationConfig;

  constructor(config: DiscordMissionNotificationConfig) {
    this.config = config;
  }

  send(payload: MissionNotificationPayload, context: { mission: Mission; dryRun: boolean }): MissionNotificationResult {
    return {
      delivered: true,
      metadata: {
        adapter: this.name,
        provider: 'openclaw-message',
        target: this.config.channel,
        deliveredAt: new Date().toISOString(),
        dryRun: context.dryRun,
        username: this.config.username,
        content: payload.content,
      },
    };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export class OpenClawMissionNotificationAdapter implements MissionNotificationAdapter {
  readonly name = 'openclaw';

  send(payload: MissionNotificationPayload, context: { mission: Mission; dryRun: boolean }): MissionNotificationResult {
    const owner = context.mission.owner;
    if (!owner?.channel || !owner?.chatId) {
      return new ConsoleMissionNotificationAdapter().send(payload, context);
    }

    if (context.dryRun) {
      return { delivered: false, metadata: { adapter: this.name, deliveredAt: nowIso(), dryRun: true } };
    }

    // 消息内容 + @mention 拼接
    const mentionSuffix = (payload.mentions ?? []).length > 0
      ? '\n' + payload.mentions!.join(' ')
      : '';
    const fullContent = payload.content + mentionSuffix;

    try {
      execFileSync(
        'openclaw',
        ['message', 'send', '--channel', owner.channel, '--to', owner.chatId, '--message', fullContent],
        { timeout: 10_000, stdio: 'pipe' }
      );
      return {
        delivered: true,
        metadata: {
          adapter: this.name,
          target: `${owner.channel}:${owner.chatId}`,
          mentions: payload.mentions,
          deliveredAt: nowIso(),
        },
      };
    } catch (err) {
      console.error(`[mission-notify:openclaw] failed to send: ${(err as Error).message}`);
      return {
        delivered: false,
        metadata: { adapter: this.name, deliveredAt: nowIso(), error: (err as Error).message },
      };
    }
  }
}

export interface MissionNotificationSenderOptions {
  adapter?: string;
  discordChannel?: string;
  discordUsername?: string;
}

export function resolveMissionNotificationAdapter(options: MissionNotificationSenderOptions = {}): MissionNotificationAdapter {
  const adapterName = (options.adapter ?? process.env.MISSION_NOTIFICATION_ADAPTER ?? 'console').trim().toLowerCase();

  if (adapterName === 'fake') return new FakeMissionNotificationAdapter();
  if (adapterName === 'openclaw') return new OpenClawMissionNotificationAdapter();
  if (adapterName === 'discord') {
    const channel = options.discordChannel ?? process.env.MISSION_NOTIFICATION_DISCORD_CHANNEL;
    if (!channel) {
      throw new Error('Discord notification adapter requires --discord-channel or MISSION_NOTIFICATION_DISCORD_CHANNEL');
    }
    return new DiscordMissionNotificationAdapter({
      channel,
      username: options.discordUsername ?? process.env.MISSION_NOTIFICATION_DISCORD_USERNAME,
    });
  }
  return new ConsoleMissionNotificationAdapter();
}

export function buildMissionNotificationPayload(mission: Mission, kind: MissionNotificationKind): MissionNotificationPayload {
  if (kind === 'complete') {
    return {
      kind,
      missionId: mission.missionId,
      title: mission.title,
      status: mission.status,
      content: `✅ Mission completed: ${mission.title} (${mission.missionId})`,
      metadata: {
        goal: mission.goal,
      },
    };
  }

  return {
    kind,
    missionId: mission.missionId,
    title: mission.title,
    status: mission.status,
    content: `⚠️ Mission escalated: ${mission.title} (${mission.missionId})${mission.escalation?.reason ? ` | ${mission.escalation.reason}` : ''}`,
    metadata: {
      goal: mission.goal,
      escalationLevel: mission.escalation?.level ?? null,
      escalationReason: mission.escalation?.reason ?? null,
    },
  };
}
