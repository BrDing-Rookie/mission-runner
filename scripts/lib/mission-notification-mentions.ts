/**
 * mission-notification-mentions.ts — @mention 解析
 *
 * 根据状态变更类型确定需要 @mention 的目标。
 */

import type { TransitionInfo } from './mission-notification-templates.ts';
import type { Mission } from './types.ts';

/**
 * 根据状态变更确定 @mention 目标列表。
 *
 * - task_dispatched → @被分配的 Agent
 * - task_completed / task_failed → @Orchestrator
 * - mission 完成/升级 → @用户
 */
export function resolveMentions(
  transition: TransitionInfo,
  mission: Mission,
): string[] {
  const mentions: string[] = [];

  switch (transition.kind) {
    case 'task_dispatched': {
      // @被分配的 Agent
      const tag = transition.agentMentionTag;
      if (tag) mentions.push(tag);
      break;
    }

    case 'task_completed':
    case 'task_failed': {
      // @Orchestrator（通知编排者继续推进）
      const orchTag = mission.metadata?.orchestratorMentionTag as string | undefined;
      if (orchTag) mentions.push(orchTag);
      break;
    }

    case 'status_transition': {
      // mission 终态通知用户
      if (transition.transitionTo === 'COMPLETED' || transition.transitionTo === 'ESCALATED' || transition.transitionTo === 'FAILED') {
        const userMention = mission.owner?.userMentionTag;
        if (userMention) mentions.push(userMention);
      }
      break;
    }

    default:
      break;
  }

  return mentions;
}
