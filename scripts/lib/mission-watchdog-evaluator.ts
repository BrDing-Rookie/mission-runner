/**
 * mission-watchdog-evaluator.ts — Core watchdog evaluation logic
 *
 * Extracted from mission-watchdog.ts: evaluateMission, helper utilities,
 * and auto-verify trigger logic.
 */

import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  type BackgroundProcess,
  type Mission,
  type MissionAction,
  type Task,
  type WatchdogCheckResult,
  type WatchdogConfig,
} from './types.ts';

/** Default task stall threshold: 30 minutes */
const TASK_STALL_THRESHOLD_MS = 30 * 60 * 1000;

// ── Helpers ────────────────────────────────────────────────────────────────────

export function safeDateMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isoAt(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function isTaskTerminal(task: Task): boolean {
  return ['COMPLETED', 'FAILED', 'SKIPPED'].includes(task.status);
}

function hasRemainingRetry(task: Task): boolean {
  const retryCount = task.retryCount ?? 0;
  const maxRetries = task.maxRetries ?? 0;
  return retryCount < maxRetries;
}

function summarizeTasks(tasks: Task[]): string {
  return tasks.map((task) => `${task.taskId}:${task.status}`).join(', ');
}

function summarizeBackgroundProcesses(processes: BackgroundProcess[]): string {
  return processes.map((proc) => `${proc.processId}:${proc.status}`).join(', ');
}

function buildResult(
  mission: Mission,
  action: MissionAction,
  reason: string,
  suggestedNextWakeAt?: string,
  relatedTaskIds?: string[],
  context?: Record<string, unknown>
): WatchdogCheckResult {
  return {
    missionId: mission.missionId,
    currentStatus: mission.status,
    action,
    reason,
    suggestedNextWakeAt,
    relatedTaskIds,
    context,
  };
}

// ── Core Evaluation ────────────────────────────────────────────────────────────

export function evaluateMission(mission: Mission, config: WatchdogConfig, nowMs: number): WatchdogCheckResult {
  const tasks = mission.tasks ?? [];
  const backgroundProcesses = mission.backgroundProcesses ?? [];
  const nextWakeAtMs = safeDateMs(mission.nextWakeAt);
  const lastProgressAtMs = safeDateMs(mission.lastProgressAt) ?? safeDateMs(mission.updatedAt) ?? nowMs;
  const idleMs = Math.max(0, nowMs - lastProgressAtMs);

  const runningTasks = tasks.filter((task) => ['RUNNING', 'WAITING_BACKGROUND'].includes(task.status));
  const retryableTasks = tasks.filter((task) => task.status === 'FAILED' && hasRemainingRetry(task));
  const pendingTasks = tasks.filter((task) => ['PENDING', 'READY'].includes(task.status));
  const nonTerminalTasks = tasks.filter((task) => !isTaskTerminal(task));

  const runningBackground = backgroundProcesses.filter((proc) => proc.status === 'RUNNING');
  const finishedBackground = backgroundProcesses.filter((proc) => ['COMPLETED', 'FAILED', 'TIMEOUT'].includes(proc.status));

  if (mission.status === 'VERIFYING') {
    return buildResult(
      mission, 'TRIGGER_VERIFY',
      'Mission already in VERIFYING state; verifier should run.',
      isoAt(nowMs + config.backgroundCheckIntervalMs),
      undefined, { tasks: summarizeTasks(tasks) }
    );
  }

  if (mission.status === 'WAITING_BACKGROUND') {
    if (backgroundProcesses.length === 0) {
      return buildResult(mission, 'ESCALATE_STUCK',
        'Mission is WAITING_BACKGROUND but backgroundProcesses is empty.',
        undefined, runningTasks.map((task) => task.taskId), { tasks: summarizeTasks(tasks) });
    }
    if (finishedBackground.length > 0) {
      return buildResult(mission, 'CHECK_BACKGROUND',
        'Detected finished background process records; collect outputs and reconcile task states.',
        isoAt(nowMs + config.backgroundCheckIntervalMs),
        finishedBackground.map((proc) => proc.taskId),
        { backgroundProcesses: summarizeBackgroundProcesses(backgroundProcesses) });
    }
    const due = nextWakeAtMs === null || nextWakeAtMs <= nowMs;
    return buildResult(mission, 'NONE',
      due ? 'Background tasks still marked RUNNING; wait for next collection window.'
        : 'Waiting for nextWakeAt before checking background tasks again.',
      isoAt(nowMs + config.backgroundCheckIntervalMs),
      runningBackground.map((proc) => proc.taskId),
      { backgroundProcesses: summarizeBackgroundProcesses(backgroundProcesses) });
  }

  if (mission.status === 'ITERATING' || mission.status === 'WAITING_EXTERNAL') {
    if (nextWakeAtMs !== null && nextWakeAtMs > nowMs) {
      return buildResult(mission, 'NONE',
        'Mission is waiting for scheduled wake time.',
        mission.nextWakeAt ?? undefined, undefined, { nextWakeAt: mission.nextWakeAt });
    }
    return buildResult(mission, 'RESUME_TASK',
      'Mission reached wake time and can resume the next iteration/external follow-up.',
      isoAt(nowMs + config.backgroundCheckIntervalMs),
      pendingTasks.map((task) => task.taskId), { tasks: summarizeTasks(tasks) });
  }

  if (mission.status === 'CREATED' || mission.status === 'PLANNED') {
    return buildResult(mission, 'NONE',
      `Mission is ${mission.status}; waiting for planner/dispatcher to advance it.`,
      mission.nextWakeAt ?? undefined, undefined,
      { activeStatus: ACTIVE_STATUSES.includes(mission.status) });
  }

  if (mission.status === 'BLOCKED_HIGH_RISK') {
    return buildResult(mission, 'NOTIFY_ESCALATION',
      'Mission is blocked on high-risk decision and should notify/request human input.',
      mission.nextWakeAt ?? undefined, undefined,
      { escalation: mission.escalation?.reason ?? null });
  }

  if (mission.status === 'RUNNING') {
    if (runningBackground.length > 0 || tasks.some((task) => task.status === 'WAITING_BACKGROUND')) {
      return buildResult(mission, 'CHECK_BACKGROUND',
        'Mission has running background work that should be tracked.',
        isoAt(nowMs + config.backgroundCheckIntervalMs),
        runningBackground.map((proc) => proc.taskId),
        { backgroundProcesses: summarizeBackgroundProcesses(backgroundProcesses) });
    }
    if (tasks.length > 0 && nonTerminalTasks.length === 0) {
      return buildResult(mission, 'TRIGGER_VERIFY',
        'All tasks are terminal; mission is ready for verification.',
        isoAt(nowMs + config.backgroundCheckIntervalMs),
        tasks.map((task) => task.taskId), { tasks: summarizeTasks(tasks) });
    }

    if (idleMs >= config.maxIdleTimeMs) {
      if (retryableTasks.length > 0) {
        return buildResult(mission, 'RETRY_TASK',
          `Mission has been idle for ${idleMs}ms and has retryable failed tasks.`,
          isoAt(nowMs + config.backgroundCheckIntervalMs),
          retryableTasks.map((task) => task.taskId),
          { tasks: summarizeTasks(tasks), idleMs });
      }
      return buildResult(mission, 'ESCALATE_STUCK',
        `Mission has been idle for ${idleMs}ms with no retryable tasks.`,
        undefined, runningTasks.map((task) => task.taskId),
        { tasks: summarizeTasks(tasks), idleMs });
    }

    // ── Task-level stall detection → auto result collection ────────────────
    // When individual RUNNING/WAITING_BACKGROUND tasks have been stalled over
    // taskStallThresholdMs, emit COLLECT_RESULTS so the handler can check git
    // commits and auto-complete tasks whose agents forgot to call task-update.
    const taskStallThresholdMs = config.taskStallThresholdMs ?? TASK_STALL_THRESHOLD_MS;
    if (runningTasks.length > 0) {
      const stalledTasks = runningTasks.filter((task) => {
        const taskStartMs = safeDateMs(task.startedAt);
        if (taskStartMs === null) return false;
        return (nowMs - taskStartMs) >= taskStallThresholdMs;
      });
      if (stalledTasks.length > 0) {
        const stalledIds = stalledTasks.map((t) => t.taskId);
        const stalledAgents = stalledTasks.map((t) => t.agent ?? t.config?.agentId ?? 'unknown');
        const stallMinutes = Math.round(taskStallThresholdMs / 60_000);
        return buildResult(mission, 'COLLECT_RESULTS',
          `${stalledTasks.length} task(s) stalled for over ${stallMinutes} minutes: ${stalledIds.join(', ')}. Attempting automatic result collection via git log.`,
          isoAt(nowMs + config.backgroundCheckIntervalMs),
          stalledIds,
          { tasks: summarizeTasks(tasks), stalledTaskIds: stalledIds, stalledAgents, stallMinutes, idleMs });
      }
    }

    return buildResult(mission, 'NONE',
      'Mission is still running within idle budget.',
      nextWakeAtMs !== null ? mission.nextWakeAt ?? undefined : isoAt(nowMs + config.backgroundCheckIntervalMs),
      runningTasks.map((task) => task.taskId),
      { tasks: summarizeTasks(tasks), idleMs });
  }

  if (retryableTasks.length > 0) {
    return buildResult(mission, 'RETRY_TASK',
      'Detected retryable failed tasks outside RUNNING state.',
      isoAt(nowMs + config.backgroundCheckIntervalMs),
      retryableTasks.map((task) => task.taskId),
      { tasks: summarizeTasks(tasks) });
  }

  const exhaustedFailedTasks = tasks.filter((task) => task.status === 'FAILED' && !hasRemainingRetry(task));
  if (exhaustedFailedTasks.length > 0) {
    return buildResult(mission, 'ESCALATE_MAX_RETRY',
      'One or more tasks failed and exhausted retry budget.',
      undefined, exhaustedFailedTasks.map((task) => task.taskId),
      { tasks: summarizeTasks(tasks) });
  }

  return buildResult(mission, 'NONE',
    'No watchdog action required.',
    mission.nextWakeAt ?? undefined, undefined,
    { tasks: summarizeTasks(tasks) });
}

// ── Result Application ─────────────────────────────────────────────────────────

export function applyResultToMission(
  mission: Mission,
  result: WatchdogCheckResult,
  nowIso: string
): Mission {
  return {
    ...mission,
    updatedAt: nowIso,
    nextWakeAt: result.suggestedNextWakeAt ?? mission.nextWakeAt ?? null,
  };
}

// ── Auto-Verify ────────────────────────────────────────────────────────────────

export interface ExtendedWatchdogConfig extends WatchdogConfig {
  autoVerify: boolean;
}

/**
 * Auto-verify: if mission is RUNNING with all tasks terminal and no active background,
 * run verification immediately. Idempotent: skips if mission already in terminal state.
 */
export function shouldAutoVerify(config: ExtendedWatchdogConfig, mission: Mission): boolean {
  if (!config.autoVerify) return false;
  if (TERMINAL_STATUSES.includes(mission.status)) return false;
  if (mission.status !== 'RUNNING' && mission.status !== 'VERIFYING') return false;

  const tasks = mission.tasks ?? [];
  if (tasks.length === 0) return false;
  const nonTerminal = tasks.filter((t) => !['COMPLETED', 'FAILED', 'SKIPPED'].includes(t.status));
  if (nonTerminal.length > 0) return false;

  const bgProcesses = mission.backgroundProcesses ?? [];
  const runningBg = bgProcesses.filter((p) => p.status === 'RUNNING');
  if (runningBg.length > 0) return false;

  return true;
}

// ── Logging ────────────────────────────────────────────────────────────────────

export function logMissionResult(result: WatchdogCheckResult): void {
  const parts = [
    `[${result.action}]`,
    result.missionId,
    `status=${result.currentStatus}`,
    `reason=${result.reason}`,
  ];

  if (result.relatedTaskIds && result.relatedTaskIds.length > 0) {
    parts.push(`tasks=${result.relatedTaskIds.join(',')}`);
  }

  if (result.suggestedNextWakeAt) {
    parts.push(`nextWakeAt=${result.suggestedNextWakeAt}`);
  }

  console.log(parts.join(' | '));
}
