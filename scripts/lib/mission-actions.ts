/**
 * mission-actions.ts — Action handlers for mission-run-action
 *
 * Extracted from mission-run-action.ts: retry, escalation,
 * notification flag logic, and automatic result collection.
 */

import { execFileSync } from 'child_process';
import { join } from 'path';
import { commitMissionUpdate } from './mission-commit.ts';
import { deriveMissionStatus, nowIso, requireMission } from './mission-helpers.ts';
import { buildMissionNotificationPayload, resolveMissionNotificationAdapter } from './mission-notification.ts';
import { TERMINAL_TASK_STATUSES } from './types.ts';
import type { Mission, Task, TaskStatus } from './types.ts';

// ── Retry ──────────────────────────────────────────────────────────────────────

export interface RetryResult {
  missionId: string;
  missionStatus: string;
  retriedTaskIds: string[];
  changed: boolean;
  success: boolean;
  dryRun: boolean;
}

export function retryFailedTasks(missionsDir: string, missionId: string, dryRun: boolean): RetryResult {
  const mission = requireMission({ missionsDir, missionId, dryRun });
  const timestamp = nowIso();
  const retriedTaskIds: string[] = [];
  const tasks = (mission.tasks ?? []).map((task) => {
    if (task.status !== 'FAILED') return task;
    const retryCount = task.retryCount ?? 0;
    const maxRetries = task.maxRetries ?? 0;
    if (retryCount >= maxRetries) return task;
    retriedTaskIds.push(task.taskId);
    return { ...task, status: 'READY' as const, retryCount: retryCount + 1, lastError: null, startedAt: null, endedAt: null, backgroundProcessId: null };
  });
  const changed = retriedTaskIds.length > 0;
  const updatedMission = changed ? { ...mission, status: 'RUNNING' as const, tasks, updatedAt: timestamp, lastProgressAt: timestamp, nextWakeAt: timestamp } : mission;
  if (!dryRun && changed) {
    const commitOk = commitMissionUpdate({
      missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun,
      source: 'retried',
      eventExtras: { retriedTaskIds },
    });
    if (!commitOk) throw new Error(`Failed to persist retry action for missionId=${missionId}`);
  }
  return { missionId, missionStatus: updatedMission.status, retriedTaskIds, changed, success: true, dryRun };
}

// ── Escalation ─────────────────────────────────────────────────────────────────

export interface EscalationResult {
  missionId: string;
  missionStatus: string;
  changed: boolean;
  success: boolean;
  dryRun: boolean;
  escalationReason: string;
}

export function setEscalationState(
  missionsDir: string,
  missionId: string,
  dryRun: boolean,
  level: 'WARNING' | 'CRITICAL',
  reason: string,
): EscalationResult {
  const mission = requireMission({ missionsDir, missionId, dryRun });
  const timestamp = nowIso();
  const alreadySame = mission.status === 'ESCALATED' && mission.escalation?.reason === reason && mission.escalation?.level === level;
  const changed = !alreadySame;
  const updatedMission = changed ? { ...mission, status: 'ESCALATED' as const, escalation: { level, reason, escalatedAt: timestamp }, updatedAt: timestamp, lastProgressAt: timestamp, nextWakeAt: null } : mission;
  if (!dryRun && changed) {
    const commitOk = commitMissionUpdate({
      missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun,
      source: 'escalated',
      eventExtras: { level, reason },
    });
    if (!commitOk) throw new Error(`Failed to persist escalation for missionId=${missionId}`);
  }
  return { missionId, missionStatus: updatedMission.status, changed, success: true, dryRun, escalationReason: reason };
}

// ── Notification ───────────────────────────────────────────────────────────────

export interface NotificationResult {
  missionId: string;
  missionStatus: string;
  changed: boolean;
  success: boolean;
  dryRun: boolean;
  flag: string;
  delivery?: Record<string, unknown>;
}

export function markNotificationFlag(
  missionsDir: string,
  missionId: string,
  dryRun: boolean,
  flag: 'notifiedComplete' | 'notifiedEscalation',
  eventType: 'mission_notified_complete' | 'mission_notified_escalation',
  kind: 'complete' | 'escalation',
  options?: { adapter?: string; discordChannel?: string; discordUsername?: string },
): NotificationResult {
  const mission = requireMission({ missionsDir, missionId, dryRun });
  const adapter = resolveMissionNotificationAdapter(options);
  const payload = buildMissionNotificationPayload(mission, kind);
  const delivery = adapter.send(payload, { mission, dryRun });
  const timestamp = nowIso();
  const changed = !(mission.flags?.[flag] === true);
  const existingMetadata = mission.metadata ?? {};
  const existingDelivery = (existingMetadata.notificationDelivery as Record<string, unknown> | undefined) ?? {};
  const updatedMission = changed
    ? {
        ...mission,
        flags: { ...(mission.flags ?? {}), [flag]: true },
        metadata: {
          ...existingMetadata,
          notificationDelivery: { ...existingDelivery, [kind]: delivery.metadata },
        },
        updatedAt: timestamp,
        lastProgressAt: timestamp,
      }
    : mission;
  if (!dryRun && changed) {
    const commitOk = commitMissionUpdate({
      missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun,
      source: 'notification',
      skipNotification: true,
      eventExtras: { type: eventType, status: mission.status, flag, dryRun, delivery: delivery.metadata },
    });
    if (!commitOk) throw new Error(`Failed to persist notification mark for missionId=${missionId}`);
  }
  return { missionId, missionStatus: updatedMission.status, changed, success: delivery.delivered, dryRun, flag, delivery: delivery.metadata };
}

// ── Collect Results ────────────────────────────────────────────────────────────

export interface CollectResultsResult {
  missionId: string;
  missionStatus: string;
  collectedTaskIds: string[];
  noResultTaskIds: string[];
  changed: boolean;
  success: boolean;
  dryRun: boolean;
}

/**
 * 检查 git log 中是否有自 task.startedAt 以来的相关 commit。
 * 返回匹配的 commit oneline 列表。
 */
function findGitCommitsSince(startedAt: string, projectDir: string): string[] {
  try {
    const output = execFileSync('git', [
      '-C', projectDir,
      'log',
      `--since=${startedAt}`,
      '--oneline',
      '--no-merges',
    ], {
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return [];
    return output.split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * 从 mission metadata 或 mission 目录推断项目目录。
 */
function resolveProjectDir(mission: Mission, missionsDir: string): string {
  // 优先从 metadata.workdir 获取
  const workdir = mission.metadata?.workdir;
  if (typeof workdir === 'string' && workdir.trim()) return workdir.trim();

  // 回退：missions 目录的父级通常是项目根目录
  return join(missionsDir, '..');
}

/**
 * COLLECT_RESULTS handler — 自动结果回收。
 *
 * 对每个 stalledTaskId：
 * 1. 检查 git log --since=<task.startedAt> 是否有相关 commit
 * 2. 如果有 commit，自动标记 task COMPLETED 并写入 resultSummary
 * 3. 如果没有 commit，保持原状（后续由 ESCALATE_STUCK 处理）
 *
 * 最后联动推导 mission 整体状态。
 */
export function collectResults(
  missionsDir: string,
  missionId: string,
  stalledTaskIds: string[],
  dryRun: boolean,
): CollectResultsResult {
  const mission = requireMission({ missionsDir, missionId, dryRun });
  const timestamp = nowIso();
  const projectDir = resolveProjectDir(mission, missionsDir);

  const collectedTaskIds: string[] = [];
  const noResultTaskIds: string[] = [];

  const TERMINAL_STATUSES: Set<TaskStatus> = new Set(TERMINAL_TASK_STATUSES);
  const DEPENDENCY_DONE_STATUSES: Set<TaskStatus> = new Set(['COMPLETED', 'SKIPPED']);

  const updatedTasks: Task[] = (mission.tasks ?? []).map((task): Task => {
    // 只处理 stalledTaskIds 中指定的、且仍在运行中的 task
    if (!stalledTaskIds.includes(task.taskId)) return task;
    if (TERMINAL_STATUSES.has(task.status)) return task;

    const startedAt = task.startedAt ?? mission.lastProgressAt ?? mission.createdAt;
    const commits = findGitCommitsSince(startedAt, projectDir);

    if (commits.length > 0) {
      collectedTaskIds.push(task.taskId);
      const summary = `Auto-collected: ${commits.length} commit(s) found since ${startedAt}. Latest: ${commits[0]}`;
      console.log(`[collect-results] auto-completing | taskId=${task.taskId} | commits=${commits.length} | latest=${commits[0]}`);
      return {
        ...task,
        status: 'COMPLETED',
        endedAt: timestamp,
        resultSummary: summary,
      };
    }

    noResultTaskIds.push(task.taskId);
    console.log(`[collect-results] no commits found | taskId=${task.taskId} | since=${startedAt}`);
    return task;
  });

  // 联动解锁下游 PENDING tasks
  const unlockedTaskIds: string[] = [];
  if (collectedTaskIds.length > 0) {
    const taskMap = new Map(updatedTasks.map((t) => [t.taskId, t]));
    for (let i = 0; i < updatedTasks.length; i++) {
      const t = updatedTasks[i];
      if (t.status !== 'PENDING') continue;
      const deps = t.dependsOn ?? [];
      const allSatisfied = deps.every((depId) => {
        const dep = taskMap.get(depId);
        return dep && DEPENDENCY_DONE_STATUSES.has(dep.status);
      });
      if (allSatisfied) {
        updatedTasks[i] = { ...t, status: 'READY' as TaskStatus };
        taskMap.set(t.taskId, updatedTasks[i]);
        unlockedTaskIds.push(t.taskId);
      }
    }
  }

  const changed = collectedTaskIds.length > 0;
  const newMissionStatus = changed ? deriveMissionStatus(mission.status, updatedTasks) : mission.status;

  const updatedMission: Mission = changed
    ? {
        ...mission,
        status: newMissionStatus,
        tasks: updatedTasks,
        updatedAt: timestamp,
        lastProgressAt: timestamp,
      }
    : mission;

  if (!dryRun && changed) {
    const commitOk = commitMissionUpdate({
      missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun,
      source: 'results_collected',
      eventExtras: {
        collectedTaskIds,
        noResultTaskIds,
        unlockedTaskIds,
        projectDir,
      },
    });
    if (!commitOk) throw new Error(`Failed to persist result collection for missionId=${missionId}`);
  }

  return {
    missionId,
    missionStatus: updatedMission.status,
    collectedTaskIds,
    noResultTaskIds,
    changed,
    success: true,
    dryRun,
  };
}
