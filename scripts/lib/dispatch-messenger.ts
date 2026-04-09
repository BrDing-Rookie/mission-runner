/**
 * dispatch-messenger.ts — Task dispatch messaging
 *
 * Sends dispatch messages to agents via Discord mention and builds
 * the dispatch message content with task details and callback instructions.
 */

import type { RuntimeAdapter } from './runtime-adapter.ts';
import type { ChannelAdapter } from './channel.ts';
import type { Mission, Task } from './types.ts';
import { PROJECT_ROOT } from './config.ts';

/** 发送重试配置 */
export const MENTION_MAX_RETRIES = 2;
export const MENTION_BASE_DELAY_MS = 1_000;

/**
 * 在群聊中 @ 目标 Agent，发送派发消息。
 *
 * 当提供 channel 时，通过 channel.send() 发送（带 mentions）；
 * 否则通过 RuntimeAdapter.sendMessage 在指定 channel 中发送包含 @mention 的消息。
 *
 * @param agentMentionTag - Agent 的 @mention 标记（如 Discord 的 `<@botUserId>`）
 * @param channelId - 群聊 channel ID
 * @param message - 派发消息内容
 * @param runtime - RuntimeAdapter 实例
 * @param channelType - 渠道类型（默认 "discord"）
 * @param channel - 可选的 ChannelAdapter（提供时优先使用）
 * @returns 是否发送成功
 */
export async function mentionInDiscord(
  agentMentionTag: string,
  channelId: string,
  message: string,
  runtime: RuntimeAdapter,
  channelType: string = 'discord',
  channel?: ChannelAdapter,
): Promise<boolean> {
  if (!agentMentionTag || !channelId || !message) {
    console.error('[dispatch-messenger] mentionInDiscord: missing required params');
    return false;
  }

  // 校验 Discord snowflake ID 格式（纯数字，17-20 位）
  if (!/^\d{17,20}$/.test(channelId)) {
    console.warn(`[dispatch-messenger] mentionInDiscord: channelId is not a valid Discord snowflake ID (expected 17-20 digit number), got: "${channelId}"`);
    return false;
  }

  // 校验输入防注入
  if (channelId.length > 256 || /[\n\r\0]/.test(channelId)) {
    console.error('[dispatch-messenger] mentionInDiscord: invalid channelId');
    return false;
  }

  // 通过 ChannelAdapter 发送（当提供时）
  if (channel) {
    const result = await channel.send(
      { channel: channelType, targetId: channelId },
      { content: message, mentions: [agentMentionTag] },
    );
    if (result.success) {
      console.log(`[dispatch-messenger] sent via channel | channel=${channelId} | agent=${agentMentionTag}`);
    } else {
      console.warn(`[dispatch-messenger] mentionInDiscord via channel failed: ${result.error ?? 'unknown'}`);
    }
    return result.success;
  }

  const fullMessage = `${message}\n${agentMentionTag}`;

  for (let attempt = 0; attempt <= MENTION_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = MENTION_BASE_DELAY_MS * attempt;
      console.log(`[dispatch-messenger] Retry ${attempt}/${MENTION_MAX_RETRIES} after ${delay}ms`);
      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }

    const success = await runtime.sendMessage({
      channel: channelType,
      target: channelId,
      message: fullMessage,
      account: 'discord-rd-lead',
    });

    if (success) {
      if (attempt > 0) {
        console.log(`[dispatch-messenger] mentionInDiscord succeeded on retry ${attempt}`);
      }
      console.log(`[dispatch-messenger] sent | channel=${channelId} | agent=${agentMentionTag} | attempts=${attempt + 1}`);
      return true;
    }

    console.warn(`[dispatch-messenger] mentionInDiscord attempt ${attempt + 1} failed`);
  }

  console.error(`[dispatch-messenger] mentionInDiscord failed after ${MENTION_MAX_RETRIES + 1} attempts`);
  return false;
}

/**
 * 构建派发消息（含闭环回报指令）。
 *
 * 派发消息中自动注入 task-update 命令，Agent 完成后必须调用此命令
 * 汇报结果，触发 mission 状态推进和下一步派发。
 */
export function buildDispatchMessage(task: Task, mission: Mission, missionsDir: string): string {
  const desc = task.description ? `\n详情: ${task.description}` : '';
  const agentId = task.agent ?? (task.config?.agentId as string | undefined) ?? 'unknown';

  // Build the absolute task-update command so the agent can copy-paste & execute
  const projectDir = PROJECT_ROOT;
  const taskUpdateCmd = [
    `cd ${projectDir} && npx tsx scripts/task-update.ts`,
    `--missions-dir ${missionsDir}`,
    `--mission-id ${mission.missionId}`,
    `--task-id ${task.taskId}`,
    `--status COMPLETED`,
    `--summary "你的完成摘要"`,
  ].join(' \\\n  ');

  const lines = [
    `📤 新任务派发 [${task.taskId}]「${task.title}」`,
    `类型: ${task.type} | Mission: ${mission.missionId}${desc}`,
    `[SubAgent-${agentId}] 请开始执行。`,
  ];

  // File boundary — restrict agent modifications to specific paths
  const fileBoundary = task.fileBoundary ?? (task.config?.fileBoundary as string[] | undefined);
  if (fileBoundary && fileBoundary.length > 0) {
    lines.push('');
    lines.push('⚠️ **文件修改范围**（只允许修改以下文件/目录）：');
    for (const path of fileBoundary) {
      lines.push(`- \`${path}\``);
    }
  }

  lines.push(
    '',
    '⚠️ **完成后请执行以下命令汇报结果**（将 summary 替换为实际摘要）：',
    '```bash',
    taskUpdateCmd,
    '```',
    '',
    '如果任务失败，将 `--status COMPLETED` 改为 `--status FAILED`，并在 `--summary` 中说明原因。',
  );

  lines.push(
    '',
    '📋 **开发文档规则**：编码前必须先在 `dev-docs/<module>/` 下创建当日开发文档，',
    '并在 `BACKLOG.md` 中登记。完成后更新 `DONE.md` 和 `project-docs/`。',
    '详见 CLAUDE.md "Development Doc Workflow" 章节。',
  );

  return lines.join('\n');
}
