#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { deriveMissionStatus, nowIso, parseMissionCliArgs, requireMission } from './lib/mission-helpers.ts';
import type { BackgroundProcess, Mission, Task } from './lib/types.ts';

function isReady(task: Task): boolean {
  return task.status === 'READY';
}

function isBackgroundCandidate(task: Task): boolean {
  return ['code', 'test', 'deploy', 'external_wait'].includes(task.type);
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseMissionCliArgs(argv);
    const mission = requireMission(args);

    const readyTasks = (mission.tasks ?? []).filter(isReady);
    if (readyTasks.length === 0) {
      console.log(`[mission-dispatch] noop | missionId=${mission.missionId} | started=none | running=none | background=none | status=${mission.status} | reason=no READY tasks${args.dryRun ? ' | dry-run' : ''}`);
      return 0;
    }

    const timestamp = nowIso();
    const startedTaskIds = readyTasks.map((task) => task.taskId);
    const runningTaskIds: string[] = [];
    const backgroundTaskIds: string[] = [];
    const backgroundProcesses: BackgroundProcess[] = [...(mission.backgroundProcesses ?? [])];

    const updatedTasks: Task[] = (mission.tasks ?? []).map((task): Task => {
      if (!isReady(task)) {
        return task;
      }

      if (isBackgroundCandidate(task)) {
        const processId = `bg-${mission.missionId}-${task.taskId}`;
        backgroundTaskIds.push(task.taskId);
        backgroundProcesses.push({
          processId,
          taskId: task.taskId,
          status: 'RUNNING',
          startedAt: timestamp,
          outputPath: `artifacts/${task.taskId}.log`,
        });

        return {
          ...task,
          status: 'WAITING_BACKGROUND',
          startedAt: timestamp,
          backgroundProcessId: processId,
        };
      }

      runningTaskIds.push(task.taskId);
      return {
        ...task,
        status: 'RUNNING',
        startedAt: timestamp,
      };
    });

    const updatedMission: Mission = {
      ...mission,
      status: deriveMissionStatus(mission.status, updatedTasks),
      updatedAt: timestamp,
      lastProgressAt: timestamp,
      nextWakeAt: new Date(Date.now() + 30_000).toISOString(),
      tasks: updatedTasks,
      backgroundProcesses,
    };

    // statusFrom, statusTo, dryRun are already set by commitMissionUpdate internally;
    // only include dispatch-specific fields in eventExtras to avoid duplication.
    const eventExtras = {
      startedTaskIds,
      runningTaskIds,
      backgroundTaskIds,
      backgroundProcessCount: backgroundProcesses.length,
    };

    if (!args.dryRun) {
      const commitOk = commitMissionUpdate({
        missionsDir: args.missionsDir,
        oldMission: mission,
        newMission: updatedMission,
        dryRun: args.dryRun,
        source: 'dispatched',
        eventExtras,
      });
      if (!commitOk) {
        console.error(`[mission-dispatch] failed | missionId=${mission.missionId}`);
        return 1;
      }
    }

    if (args.dryRun) {
      console.log(JSON.stringify({ missionId: mission.missionId, eventExtras, updatedMission }, null, 2));
      return 0;
    }

    console.log(`[mission-dispatch] dispatched | missionId=${mission.missionId} | started=${startedTaskIds.join(',') || 'none'} | running=${runningTaskIds.join(',') || 'none'} | background=${backgroundTaskIds.join(',') || 'none'} | status=${updatedMission.status}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mission-dispatch] error | ${message}`);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}
