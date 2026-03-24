#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { commitMissionUpdate as commitUpdate } from './lib/mission-commit.ts';
import { nowIso, parseMissionCliArgs, requireMission } from './lib/mission-helpers.ts';
import type { BackgroundProcess, Mission, Task } from './lib/types.ts';

const TERMINAL_TASK_STATUSES = new Set(['COMPLETED', 'FAILED', 'SKIPPED']);
const RECONCILABLE_PROCESS_STATUSES = new Set<BackgroundProcess['status']>(['COMPLETED', 'FAILED', 'TIMEOUT']);

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

  if (tasks.length > 0 && tasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status))) {
    return 'VERIFYING';
  }

  return mission.status;
}

export interface ReconcileBackgroundArgs {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
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
}

export function reconcileBackgroundMission(args: ReconcileBackgroundArgs): ReconcileBackgroundResult {
  const mission = requireMission(args);
  const timestamp = nowIso();

  const processesById = new Map((mission.backgroundProcesses ?? []).map((process) => [process.processId, process]));
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

  const finalStatus = deriveMissionStatus(mission, updatedTasks, mission.backgroundProcesses ?? []);
  const statusChanged = finalStatus !== mission.status;
  const tasksReconciled = reconciledTaskIds.length > 0;
  const changed = tasksReconciled || statusChanged;
  const progressed = changed;

  const updatedMission: Mission = changed
    ? {
      ...mission,
      status: finalStatus,
      tasks: updatedTasks,
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
  };
}

function main(): number {
  try {
    const args = parseMissionCliArgs(process.argv.slice(2));
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
