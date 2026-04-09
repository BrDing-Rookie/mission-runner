#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { commitMissionUpdate as commitUpdate } from './lib/mission-commit.ts';
import { nowIso, parseMissionCliArgs, requireMission } from './lib/mission-helpers.ts';
import { TERMINAL_TASK_STATUSES } from './lib/types.ts';
import type { BackgroundProcess, Mission, Task } from './lib/types.ts';

const TERMINAL_TASK_STATUSES_SET = new Set(TERMINAL_TASK_STATUSES);
const RECONCILABLE_PROCESS_STATUSES = new Set<BackgroundProcess['status']>(['COMPLETED', 'FAILED', 'TIMEOUT']);

const DEFAULT_PROCESS_TIMEOUT_MS = 3_600_000; // 1 hour

function summarizeProcessResult(process: BackgroundProcess): string {
  switch (process.status) {
    case 'COMPLETED':
      return `Background process ${process.processId} completed.`;
    case 'FAILED':
      return `Background process ${process.processId} failed.`;
    case 'TIMEOUT':
      return `Background process ${process.processId} timed out.`;
    default:
      return `Background process ${process.processId} finished.`;
  }
}

function deriveMissionStatus(mission: Mission, tasks: Task[], backgroundProcesses: BackgroundProcess[]): Mission['status'] {
  const waitingOnRunningBackground = tasks.some((task) => {
    if (task.status !== 'WAITING_BACKGROUND' || !task.backgroundProcessId) {
      return false;
    }

    return backgroundProcesses.some(
      (process) => process.processId === task.backgroundProcessId && process.status === 'RUNNING'
    );
  });

  if (waitingOnRunningBackground) {
    return 'WAITING_BACKGROUND';
  }

  if (tasks.some((task) => task.status === 'READY' || task.status === 'RUNNING')) {
    return 'RUNNING';
  }

  if (tasks.length > 0 && tasks.every((task) => TERMINAL_TASK_STATUSES_SET.has(task.status))) {
    return 'VERIFYING';
  }

  return mission.status;
}

export interface ReconcileBackgroundArgs {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
  processTimeoutMs?: number;
  force?: boolean;
}

export interface ReconcileBackgroundResult {
  missionId: string;
  statusFrom: Mission['status'];
  finalStatus: Mission['status'];
  success: boolean;
  changed: boolean;
  progressed: boolean;
  dryRun: boolean;
  reconciledTaskIds: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  timedOutProcessIds: string[];
  orphanProcessIds: string[];
}

export function reconcileBackgroundMission(args: ReconcileBackgroundArgs): ReconcileBackgroundResult {
  const mission = requireMission(args);
  const timestamp = nowIso();
  const processTimeoutMs = args.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const force = args.force ?? false;
  const now = Date.now();

  const taskIds = new Set((mission.tasks ?? []).map((t) => t.taskId));

  // --- Step 1: orphan detection ---
  const orphanProcessIds: string[] = [];
  for (const process of mission.backgroundProcesses ?? []) {
    if (!taskIds.has(process.taskId)) {
      orphanProcessIds.push(process.processId);
      console.warn(
        `[reconcile-background] orphan process detected | processId=${process.processId} | taskId=${process.taskId}`
      );
    }
  }

  // --- Step 2: timeout detection (mutates a working copy of backgroundProcesses) ---
  const timedOutProcessIds: string[] = [];
  const updatedProcesses: BackgroundProcess[] = (mission.backgroundProcesses ?? []).map((process) => {
    if (process.status !== 'RUNNING') return process;

    const startedAtMs = new Date(process.startedAt).getTime();
    const elapsedMs = now - startedAtMs;

    if (elapsedMs > processTimeoutMs || force) {
      timedOutProcessIds.push(process.processId);
      return { ...process, status: 'TIMEOUT' as const, endedAt: process.endedAt ?? timestamp };
    }

    return process;
  });

  // --- Step 3: existing reconcile logic (now operates on updatedProcesses) ---
  const processesById = new Map(updatedProcesses.map((process) => [process.processId, process]));
  const completedTaskIds: string[] = [];
  const failedTaskIds: string[] = [];
  const reconciledTaskIds: string[] = [];

  const updatedTasks = (mission.tasks ?? []).map((task) => {
    const processId = task.backgroundProcessId ?? null;
    const process = processId ? processesById.get(processId) : undefined;

    if (task.status !== 'WAITING_BACKGROUND' || !process || !RECONCILABLE_PROCESS_STATUSES.has(process.status)) {
      return task;
    }

    const nextStatus = process.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
    reconciledTaskIds.push(task.taskId);
    if (nextStatus === 'COMPLETED') {
      completedTaskIds.push(task.taskId);
    } else {
      failedTaskIds.push(task.taskId);
    }

    return {
      ...task,
      status: nextStatus,
      endedAt: process.endedAt ?? timestamp,
      resultSummary: summarizeProcessResult(process),
    } satisfies Task;
  });

  const finalStatus = deriveMissionStatus(mission, updatedTasks, updatedProcesses);
  const statusChanged = finalStatus !== mission.status;
  const tasksReconciled = reconciledTaskIds.length > 0;
  const processesTimedOut = timedOutProcessIds.length > 0;
  const changed = tasksReconciled || statusChanged || processesTimedOut;
  const progressed = changed;

  const updatedMission: Mission = changed
    ? {
      ...mission,
      status: finalStatus,
      tasks: updatedTasks,
      backgroundProcesses: updatedProcesses,
      updatedAt: timestamp,
      lastProgressAt: progressed ? timestamp : mission.lastProgressAt,
    }
    : mission;

  if (!args.dryRun && changed) {
    const commitOk = commitUpdate({
      missionsDir: args.missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun: args.dryRun,
      source: 'background_reconciled',
      eventExtras: {
        changed,
        progressed,
        reconciledTaskIds,
        completedTaskIds,
        failedTaskIds,
        timedOutProcessIds,
        orphanProcessIds,
      },
    });
    if (!commitOk) {
      throw new Error(`Failed to persist reconcile result for missionId=${mission.missionId}`);
    }
  }

  return {
    missionId: mission.missionId,
    statusFrom: mission.status,
    finalStatus: updatedMission.status,
    success: true,
    changed,
    progressed,
    dryRun: args.dryRun,
    reconciledTaskIds,
    completedTaskIds,
    failedTaskIds,
    timedOutProcessIds,
    orphanProcessIds,
  };
}

function main(): number {
  try {
    const argv = process.argv.slice(2);
    const baseArgs = parseMissionCliArgs(argv);

    let processTimeoutMs: number | undefined;
    let force = false;

    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      const next = argv[i + 1];
      if (arg === '--process-timeout-ms' && next) {
        const parsed = Number(next);
        if (!Number.isNaN(parsed) && parsed > 0) {
          processTimeoutMs = parsed;
        }
        i += 1;
      } else if (arg === '--force') {
        force = true;
      }
    }

    const args: ReconcileBackgroundArgs = {
      ...baseArgs,
      processTimeoutMs,
      force,
    };

    const result = reconcileBackgroundMission(args);
    console.log(JSON.stringify({
      missionId: result.missionId,
      statusFrom: result.statusFrom,
      status: result.finalStatus,
      success: result.success,
      changed: result.changed,
      progressed: result.progressed,
      dryRun: result.dryRun,
      reconciledTaskIds: result.reconciledTaskIds,
      completedTaskIds: result.completedTaskIds,
      failedTaskIds: result.failedTaskIds,
      timedOutProcessIds: result.timedOutProcessIds,
      orphanProcessIds: result.orphanProcessIds,
    }, null, 2));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-reconcile-background] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}
