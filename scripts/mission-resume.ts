#!/usr/bin/env node

import { appendEvent, writeMission } from './lib/fs-utils.ts';
import { nowIso, parseMissionCliArgs, requireMission } from './lib/mission-helpers.ts';
import type { Mission, Task, TaskStatus } from './lib/types.ts';

const DEPENDENCY_DONE_STATUSES: TaskStatus[] = ['COMPLETED', 'SKIPPED'];
const TERMINAL_TASK_STATUSES: TaskStatus[] = ['COMPLETED', 'FAILED', 'SKIPPED'];
const ACTIVE_DISPATCHABLE_STATUSES: TaskStatus[] = ['READY', 'RUNNING', 'WAITING_BACKGROUND'];
const RESUMABLE_MISSION_STATUSES = new Set<Mission['status']>(['ITERATING', 'WAITING_EXTERNAL']);

function dependenciesSatisfied(task: Task, taskMap: Map<string, Task>): boolean {
  const dependsOn = task.dependsOn ?? [];
  return dependsOn.every((dependencyId) => {
    const dependency = taskMap.get(dependencyId);
    return dependency ? DEPENDENCY_DONE_STATUSES.includes(dependency.status) : false;
  });
}

function deriveMissionStatus(originalStatus: Mission['status'], tasks: Task[]): Mission['status'] {
  if (tasks.some((task) => ACTIVE_DISPATCHABLE_STATUSES.includes(task.status))) {
    return 'RUNNING';
  }

  if (tasks.length > 0 && tasks.every((task) => TERMINAL_TASK_STATUSES.includes(task.status))) {
    return 'VERIFYING';
  }

  return originalStatus;
}

function main(): number {
  try {
    const args = parseMissionCliArgs(process.argv.slice(2));
    const mission = requireMission(args);
    const timestamp = nowIso();
    const shouldResumeTasks = RESUMABLE_MISSION_STATUSES.has(mission.status);
    const restoredTaskIds: string[] = [];
    const unlockedTaskIds: string[] = [];

    const taskMap = new Map((mission.tasks ?? []).map((task) => [task.taskId, task]));
    const updatedTasks = (mission.tasks ?? []).map((task) => {
      if (!shouldResumeTasks) {
        return task;
      }

      if (task.status === 'FAILED' && (task.retryCount ?? 0) < (task.maxRetries ?? 0)) {
        const nextStatus: TaskStatus = dependenciesSatisfied(task, taskMap) ? 'READY' : 'PENDING';
        restoredTaskIds.push(task.taskId);
        const updatedTask: Task = {
          ...task,
          status: nextStatus,
          lastError: null,
          startedAt: null,
          endedAt: null,
          backgroundProcessId: null,
        };
        taskMap.set(task.taskId, updatedTask);
        return updatedTask;
      }

      if (task.status === 'PENDING' && dependenciesSatisfied(task, taskMap)) {
        unlockedTaskIds.push(task.taskId);
        const updatedTask: Task = {
          ...task,
          status: 'READY',
        };
        taskMap.set(task.taskId, updatedTask);
        return updatedTask;
      }

      return task;
    });

    const nextStatus = deriveMissionStatus(mission.status, updatedTasks);
    const updatedMission: Mission = {
      ...mission,
      status: nextStatus,
      tasks: updatedTasks,
      updatedAt: timestamp,
      lastProgressAt: timestamp,
    };

    const event = {
      type: 'mission_resumed',
      statusFrom: mission.status,
      statusTo: updatedMission.status,
      resumedTaskIds: restoredTaskIds,
      unlockedTaskIds,
      dryRun: args.dryRun,
    };

    if (!args.dryRun) {
      const writeOk = writeMission(args.missionsDir, updatedMission);
      const eventOk = appendEvent(args.missionsDir, mission.missionId, event);
      if (!writeOk || !eventOk) {
        console.error(`[mission-resume] failed | missionId=${mission.missionId} | write=${writeOk} | event=${eventOk}`);
        return 1;
      }
    }

    console.log(`[mission-resume] missionId=${mission.missionId} | resumed=${restoredTaskIds.join(',') || 'none'} | unlocked=${unlockedTaskIds.join(',') || 'none'} | status=${updatedMission.status}${args.dryRun ? ' | dry-run' : ''}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-resume] error | ${message}`);
    return 1;
  }
}

process.exitCode = main();
