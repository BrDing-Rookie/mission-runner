import type { Mission } from './types.ts';

export type MissionNotificationKind = 'complete' | 'escalation';

export interface MissionNotificationPayload {
  kind: MissionNotificationKind;
  missionId: string;
  title: string;
  status: Mission['status'];
  content: string;
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

export interface MissionNotificationSenderOptions {
  adapter?: string;
  discordChannel?: string;
  discordUsername?: string;
}

export function resolveMissionNotificationAdapter(options: MissionNotificationSenderOptions = {}): MissionNotificationAdapter {
  const adapterName = (options.adapter ?? process.env.MISSION_NOTIFICATION_ADAPTER ?? 'console').trim().toLowerCase();

  if (adapterName === 'fake') return new FakeMissionNotificationAdapter();
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
