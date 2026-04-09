import { safeExec } from './safe-exec.ts';
import type { RuntimeAdapter } from './runtime-adapter.ts';
import type { ChannelAdapter } from './channel.ts';
import type { Mission, MissionStatus } from './types.ts';
import { nowIso } from './mission-helpers.ts';

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

/**
 * OpenClawMissionNotificationAdapter — 通过 RuntimeAdapter 或 ChannelAdapter 发送任务通知。
 *
 * 接受可选的 RuntimeAdapter 和 ChannelAdapter 注入。
 * - 当 channel 提供时，通过 channel.send() 发送（异步路径）
 * - 当 channel 未提供时，降级为直接 safeExec 调用（兼容模式）
 */
export class OpenClawMissionNotificationAdapter implements MissionNotificationAdapter {
  readonly name = 'openclaw';
  private readonly runtime: RuntimeAdapter | undefined;
  private readonly channel: ChannelAdapter | undefined;

  constructor(runtime?: RuntimeAdapter, channel?: ChannelAdapter) {
    this.runtime = runtime;
    this.channel = channel;
  }

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

    // 通过 ChannelAdapter 发送（当提供时）
    if (this.channel) {
      // channel.send 是异步的，但 MissionNotificationAdapter.send 是同步接口
      // 使用 fire-and-forget 模式，并乐观地返回 delivered=true
      void this.channel.send(
        { channel: owner.channel, targetId: owner.chatId },
        { content: payload.content, mentions: payload.mentions },
      ).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[mission-notify:openclaw] channel.send failed: ${msg}`);
      });
      return {
        delivered: true,
        metadata: {
          adapter: this.name,
          target: `${owner.channel}:${owner.chatId}`,
          mentions: payload.mentions,
          deliveredAt: nowIso(),
          channelAdapter: this.channel.name,
        },
      };
    }

    // 通过 safeExec 发送（同步路径，兼容 withMissionLock 等同步调用链）
    // RuntimeAdapter 已注入供未来迁移到完整异步 SDK 路径使用
    const result = safeExec(
      ['openclaw', 'message', 'send', '--channel', owner.channel, '--to', owner.chatId, '--message', fullContent],
      10_000,
    );

    if (result.success) {
      return {
        delivered: true,
        metadata: {
          adapter: this.name,
          target: `${owner.channel}:${owner.chatId}`,
          mentions: payload.mentions,
          deliveredAt: nowIso(),
          runtimeAdapter: this.runtime ? this.runtime.constructor.name : 'none',
        },
      };
    }

    console.error(`[mission-notify:openclaw] failed to send: ${result.error}`);
    return {
      delivered: false,
      metadata: { adapter: this.name, deliveredAt: nowIso(), error: result.error },
    };
  }
}

export interface MissionNotificationSenderOptions {
  adapter?: string;
  discordChannel?: string;
  discordUsername?: string;
  runtime?: RuntimeAdapter;
  channel?: ChannelAdapter;
}

export function resolveMissionNotificationAdapter(options: MissionNotificationSenderOptions = {}): MissionNotificationAdapter {
  const adapterName = (options.adapter ?? process.env.MISSION_NOTIFICATION_ADAPTER ?? 'console').trim().toLowerCase();

  if (adapterName === 'fake') return new FakeMissionNotificationAdapter();
  if (adapterName === 'openclaw') return new OpenClawMissionNotificationAdapter(options.runtime, options.channel);
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
