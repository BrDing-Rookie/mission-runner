#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { buildTaskEnvelope, deriveMissionStatus, nowIso, parseMissionCliArgs, requireMission } from './lib/mission-helpers.ts';
import type { BackgroundProcess, Mission, Task } from './lib/types.ts';

const DEFAULT_AGENT_MAP: Record<string, string> = {
  research: 'codex',
  analysis: 'claude-code',
  code: 'codex',
  document: 'claude-code',
  review: 'rd-review',
  test: 'codex',
  verification: 'rd-review',
};

interface DispatchCliArgs {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
  autoSpawn: boolean;
  agentMap: Record<string, string>;
  timeoutSeconds: number;
}

function parseDispatchCliArgs(argv: string[]): DispatchCliArgs {
  const base = parseMissionCliArgs(argv);
  const args: DispatchCliArgs = {
    ...base,
    autoSpawn: false,
    agentMap: { ...DEFAULT_AGENT_MAP },
    timeoutSeconds: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--auto-spawn') {
      args.autoSpawn = true;
    } else if (arg === '--agent-map' && next) {
      try { args.agentMap = { ...DEFAULT_AGENT_MAP, ...JSON.parse(next) }; } catch { /* ignore */ }
      i += 1;
    } else if (arg === '--timeout-seconds' && next) {
      const value = Number(next);
      if (Number.isFinite(value) && value >= 1) { args.timeoutSeconds = value; }
      i += 1;
    }
  }
  return args;
}

interface SpawnInstruction {
  taskId: string;
  agentId: string;
  taskType: string;
  envelope: string;
}

function isReady(task: Task): boolean {
  return task.status === 'READY';
}

function isBackgroundCandidate(task: Task): boolean {
  return ['code', 'test', 'deploy', 'external_wait'].includes(task.type);
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    const args = parseDispatchCliArgs(argv);
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

    const spawnInstructions: SpawnInstruction[] = [];

    const updatedTasks: Task[] = (mission.tasks ?? []).map((task): Task => {
      if (!isReady(task)) {
        return task;
      }

      // Build spawn instruction for auto-spawn mode
      if (args.autoSpawn) {
        const agentId = args.agentMap[task.type] ?? task.type;
        const envelope = buildTaskEnvelope(task, mission, agentId);
        spawnInstructions.push({ taskId: task.taskId, agentId, taskType: task.type, envelope });
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
          agent: args.autoSpawn ? (args.agentMap[task.type] ?? null) : task.agent,
          backgroundProcessId: processId,
        };
      }

      runningTaskIds.push(task.taskId);
      return {
        ...task,
        status: 'RUNNING',
        startedAt: timestamp,
        agent: args.autoSpawn ? (args.agentMap[task.type] ?? null) : task.agent,
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
    const eventExtras: Record<string, unknown> = {
      startedTaskIds,
      runningTaskIds,
      backgroundTaskIds,
      backgroundProcessCount: backgroundProcesses.length,
    };

    if (args.autoSpawn && spawnInstructions.length > 0) {
      eventExtras.spawnInstructions = spawnInstructions.map((s) => ({
        taskId: s.taskId,
        agentId: s.agentId,
        taskType: s.taskType,
      }));
    }

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

    if (args.autoSpawn && spawnInstructions.length > 0) {
      console.log('');
      console.log('📋 Dispatch 指令：');
      for (const si of spawnInstructions) {
        console.log(`- ${si.taskId}-${si.taskType} → ${si.agentId}: sessions_spawn(agentId="${si.agentId}", task="${si.envelope.replace(/\n/g, '\\n')}")`);
      }
    }

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
