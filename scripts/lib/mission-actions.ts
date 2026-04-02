/**
 * mission-actions.ts — Action handlers for mission-run-action
 *
 * Extracted from mission-run-action.ts: retry, escalation, and
 * notification flag logic.
 */

import { commitMissionUpdate } from './mission-commit.ts';
import { nowIso, requireMission } from './mission-helpers.ts';
import { buildMissionNotificationPayload, resolveMissionNotificationAdapter } from './mission-notification.ts';
import type { Mission } from './types.ts';

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
