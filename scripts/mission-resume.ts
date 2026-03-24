#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { deriveMissionStatus, nowIso, parseMissionCliArgs, requireMission } from './lib/mission-helpers.ts';
import type { Mission, Task, TaskStatus } from './lib/types.ts';

const DEPENDENCY_DONE_STATUSES: TaskStatus[] = ['COMPLETED', 'SKIPPED'];
const RESUMABLE_MISSION_STATUSES = new Set<Mission['status']>(['ITERATING', 'WAITING_EXTERNAL', 'WAITING_BACKGROUND']);

function dependenciesSatisfied(task: Task, taskMap: Map<string, Task>): boolean {
  const dependsOn = task.dependsOn ?? [];
  return dependsOn.every((dependencyId) => {
    const dependency = taskMap.get(dependencyId);
    return dependency ? DEPENDENCY_DONE_STATUSES.includes(dependency.status) : false;
  });
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseMissionCliArgs(argv);
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
          lastError: null,
        };
        taskMap.set(task.taskId, updatedTask);
        return updatedTask;
      }

      return task;
    });

    let nextStatus = deriveMissionStatus(mission.status, updatedTasks);
    if (unlockedTaskIds.length > 0 && nextStatus === 'ITERATING') {
      nextStatus = 'RUNNING';
    }
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
      const commitOk = commitMissionUpdate({
        missionsDir: args.missionsDir,
        oldMission: mission,
        newMission: updatedMission,
        dryRun: args.dryRun,
        source: 'resumed',
        eventExtras: event,
      });
      if (!commitOk) {
        console.error(`[mission-resume] failed | missionId=${mission.missionId}`);
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

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}
