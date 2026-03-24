/**
 * mission-notification-templates.ts — 消息模板
 *
 * 为每种状态变更生成 human-readable 消息，供 commitMissionUpdate() 调用。
 */

import type { MissionNotificationKind, MissionNotificationPayload } from './mission-notification.ts';
import type { Mission, MissionStatus } from './types.ts';

/** 状态变更信息 */
export interface TransitionInfo {
  kind: MissionNotificationKind;
  transitionFrom?: MissionStatus;
  transitionTo?: MissionStatus;
  taskId?: string;
  taskTitle?: string;
  taskType?: string;
  agentMentionTag?: string;
  agentName?: string;
  artifacts?: string[];
  lastError?: string | null;
}

/** 为 mission 级状态变更生成 human-readable 消息 */
export function buildTransitionMessage(transition: TransitionInfo, mission: Mission): string {
  const title = mission.title;
  const taskCount = mission.tasks?.length ?? 0;

  switch (transition.transitionTo) {
    case 'CREATED':
      return `📋 新任务已创建「${title}」目标：${mission.goal}`;
    case 'PLANNED': {
      const taskLines = (mission.tasks ?? []).map((t) => {
        const agentName = t.config?.agentName as string | undefined;
        const agentSuffix = agentName ? ` → @${agentName}` : '';
        return `- ${t.taskId}: ${t.title}${agentSuffix}`;
      }).join('\n');
      return `📝 任务「${title}」计划已生成，共 ${taskCount} 个子任务：\n${taskLines}`;
    }
    case 'RUNNING':
      return `🚀 任务「${title}」开始执行`;
    case 'WAITING_BACKGROUND':
      return `⏳ 任务「${title}」等待后台进程完成`;
    case 'WAITING_EXTERNAL':
      return `⏳ 任务「${title}」等待外部条件`;
    case 'VERIFYING': {
      const completed = (mission.tasks ?? []).filter((t) => t.status === 'COMPLETED').length;
      return `🔍 任务「${title}」已进入验证阶段，${completed}/${taskCount} 子任务完成`;
    }
    case 'ITERATING': {
      const gaps = mission.verification?.gaps?.length ?? 0;
      const iteration = (mission.currentIteration ?? 0) + 1;
      return `🔄 任务「${title}」验证发现 ${gaps} 个缺口，进入第 ${iteration} 轮迭代`;
    }
    case 'COMPLETED':
      return `✅ 任务「${title}」已完成`;
    case 'FAILED': {
      const reason = mission.escalation?.reason ?? '未知原因';
      return `❌ 任务「${title}」已失败：${reason}`;
    }
    case 'ESCALATED': {
      const reason = mission.escalation?.reason ?? '未知原因';
      return `⚠️ 任务「${title}」需要人工介入：${reason}`;
    }
    default:
      return `📌 任务「${title}」状态变更：${transition.transitionFrom ?? '?'} → ${transition.transitionTo ?? '?'}`;
  }
}

/** 为 task 级事件生成消息 */
function buildTaskMessage(transition: TransitionInfo, _mission: Mission): string {
  const taskId = transition.taskId ?? '?';
  const taskTitle = transition.taskTitle ?? '';

  switch (transition.kind) {
    case 'task_dispatched': {
      const agentName = transition.agentName ?? '';
      const agentSuffix = agentName ? ` @${agentName}` : '';
      return `📤 子任务 [${taskId}]「${taskTitle}」已分配${agentSuffix}，类型：${transition.taskType ?? '?'}`;
    }
    case 'task_completed': {
      const artifactsText = (transition.artifacts ?? []).length > 0
        ? `，产物: ${transition.artifacts!.join(', ')}`
        : '';
      return `✅ 子任务 [${taskId}]「${taskTitle}」已完成${artifactsText}`;
    }
    case 'task_failed':
      return `❌ 子任务 [${taskId}]「${taskTitle}」失败：${transition.lastError ?? '未知原因'}`;
    default:
      return `📌 子任务 [${taskId}]「${taskTitle}」事件：${transition.kind}`;
  }
}

/** 构建完整 notification payload */
export function buildTransitionPayload(
  transition: TransitionInfo,
  mission: Mission,
  mentions: string[],
  source: string,
): MissionNotificationPayload {
  const isTaskLevel = transition.kind === 'task_dispatched'
    || transition.kind === 'task_completed'
    || transition.kind === 'task_failed';

  const content = isTaskLevel
    ? buildTaskMessage(transition, mission)
    : buildTransitionMessage(transition, mission);

  return {
    kind: transition.kind,
    missionId: mission.missionId,
    title: mission.title,
    status: mission.status,
    content,
    mentions: mentions.length > 0 ? mentions : undefined,
    transitionFrom: transition.transitionFrom,
    transitionTo: transition.transitionTo,
    taskId: transition.taskId,
    source,
  };
}
