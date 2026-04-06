/**
 * mission-commit.ts — 集中式变更提交层
 *
 * 所有 mission.json 写入经过 commitMissionUpdate()，
 * 在写入前自动检测状态变更并触发通知（fire-and-forget）。
 */

import { appendEvent, safeWriteFile, writeMission } from './fs-utils.ts';
import { resolveMentions } from './mission-notification-mentions.ts';
import { resolveMissionNotificationAdapter } from './mission-notification.ts';
import type { TransitionInfo } from './mission-notification-templates.ts';
import { buildTransitionPayload } from './mission-notification-templates.ts';
import type { Mission, TaskStatus } from './types.ts';
import { isTransitionAllowed } from './types.ts';

export interface CommitOptions {
  missionsDir: string;
  oldMission: Mission;
  newMission: Mission;
  dryRun: boolean;
  source: string;           // 调用来源标识，如 'dispatch', 'verify'
  skipNotification?: boolean;
  /** 额外的事件字段，合并到 event log */
  eventExtras?: Record<string, unknown>;
  /** 额外的文件写入 */
  artifactWrites?: Array<{ path: string; content: string }>;
}

/**
 * 检测 old → new 之间的所有状态变更，返回需要推送的通知列表。
 */
export function detectTransitions(oldMission: Mission, newMission: Mission): TransitionInfo[] {
  const transitions: TransitionInfo[] = [];

  // 1) mission 级状态变更
  if (oldMission.status !== newMission.status) {
    transitions.push({
      kind: 'status_transition',
      transitionFrom: oldMission.status,
      transitionTo: newMission.status,
    });
  }

  // 2) task 级变更
  const oldTasks = new Map((oldMission.tasks ?? []).map((t) => [t.taskId, t]));
  for (const newTask of newMission.tasks ?? []) {
    const oldTask = oldTasks.get(newTask.taskId);
    const oldStatus: TaskStatus | undefined = oldTask?.status;
    const newStatus = newTask.status;

    if (oldStatus === newStatus) continue;

    // task 分发：READY/PENDING → RUNNING 或 WAITING_BACKGROUND
    if (isDispatchTransition(oldStatus, newStatus)) {
      transitions.push({
        kind: 'task_dispatched',
        taskId: newTask.taskId,
        taskTitle: newTask.title,
        taskType: newTask.type,
        agentMentionTag: newTask.config?.agentMentionTag as string | undefined,
        agentName: newTask.config?.agentName as string | undefined,
      });
    }

    // task 完成
    if (newStatus === 'COMPLETED' && oldStatus !== 'COMPLETED') {
      transitions.push({
        kind: 'task_completed',
        taskId: newTask.taskId,
        taskTitle: newTask.title,
        taskType: newTask.type,
        artifacts: (newTask.artifacts ?? []).map((a) => a.path),
      });
    }

    // task 失败
    if (newStatus === 'FAILED' && oldStatus !== 'FAILED') {
      transitions.push({
        kind: 'task_failed',
        taskId: newTask.taskId,
        taskTitle: newTask.title,
        taskType: newTask.type,
        lastError: newTask.lastError,
      });
    }
  }

  return transitions;
}

function isDispatchTransition(oldStatus: TaskStatus | undefined, newStatus: TaskStatus): boolean {
  const dispatchTargets: TaskStatus[] = ['RUNNING', 'WAITING_BACKGROUND'];
  if (!dispatchTargets.includes(newStatus)) return false;
  // 从 READY/PENDING/undefined 到 RUNNING/WAITING_BACKGROUND 视为分发
  return oldStatus === undefined || oldStatus === 'READY' || oldStatus === 'PENDING';
}

/**
 * 生成幂等 key，用于 notifiedTransitions 去重。
 * 包含 iteration 信息以区分不同迭代中的相同状态变更。
 */
function transitionKey(t: TransitionInfo, mission?: Mission): string {
  const iterSuffix = mission?.currentIteration != null ? `:iter=${mission.currentIteration}` : '';
  if (t.taskId) {
    return `task:${t.taskId}:${t.kind}${iterSuffix}`;
  }
  return `${t.transitionFrom ?? '?'}->${t.transitionTo ?? '?'}${iterSuffix}`;
}

/**
 * 集中式变更提交：写入 mission.json + 检测变更 + 发送通知。
 *
 * 通知失败不阻塞 mission 推进（fire-and-forget）。
 */
export function commitMissionUpdate(options: CommitOptions): boolean {
  const { missionsDir, oldMission, newMission, dryRun, source, skipNotification } = options;

  // 将幂等标记写入 newMission
  const missionToWrite = { ...newMission };

  // 收集需要发送的通知（写入成功后才发送）
  type PendingNotification = { key: string; transition: TransitionInfo };
  const pendingNotifications: PendingNotification[] = [];

  if (!dryRun && !skipNotification) {
    const transitions = detectTransitions(oldMission, newMission);
    const existingFlags = missionToWrite.flags?.notifiedTransitions ?? {};
    const newFlags = { ...existingFlags };

    for (const t of transitions) {
      const key = transitionKey(t, newMission);
      if (existingFlags[key]) continue; // 已通知过，幂等跳过

      // 1. 先标记幂等 key
      newFlags[key] = true;
      pendingNotifications.push({ key, transition: t });
    }

    missionToWrite.flags = { ...(missionToWrite.flags ?? {}), notifiedTransitions: newFlags };
  }

  // 2. 校验状态迁移合法性（写入前）
  if (oldMission.status !== newMission.status) {
    if (!isTransitionAllowed(oldMission.status, newMission.status)) {
      const msg = `Illegal transition: ${oldMission.status} → ${newMission.status} (source: ${source})`;
      console.error(`[mission-commit] ${msg}`);
      appendEvent(missionsDir, oldMission.missionId, {
        type: 'illegal_transition_blocked',
        from: oldMission.status,
        to: newMission.status,
        source,
      });
      return false;
    }
  }

  // 3. 写入 mission.json（含幂等标记）
  const writeOk = writeMission(missionsDir, missionToWrite);
  if (!writeOk) return false;

  // 4. 写入成功后 fire-and-forget 发送通知
  if (pendingNotifications.length > 0) {
    const adapter = resolveMissionNotificationAdapter();
    for (const { key, transition } of pendingNotifications) {
      try {
        const mentions = resolveMentions(transition, missionToWrite);
        const payload = buildTransitionPayload(transition, missionToWrite, mentions, source);
        adapter.send(payload, { mission: missionToWrite, dryRun });
      } catch (err) {
        console.error(`[mission-commit] notification failed for ${key}: ${(err as Error).message}`);
      }
    }
  }

  // 写入事件日志
  const event: Record<string, unknown> = {
    type: `mission_${source}`,
    statusFrom: oldMission.status,
    statusTo: missionToWrite.status,
    source,
    ...(options.eventExtras ?? {}),
  };
  appendEvent(missionsDir, missionToWrite.missionId, event);

  // 写入额外文件
  if (options.artifactWrites) {
    for (const artifact of options.artifactWrites) {
      safeWriteFile(artifact.path, artifact.content);
    }
  }

  return true;
}
