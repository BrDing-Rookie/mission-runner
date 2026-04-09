#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { deriveMissionStatus, parseMissionCliArgs, requireMission } from './lib/mission-helpers.ts';
import {
  buildDispatchSummary,
  DEFAULT_AGENT_MAP,
  dispatchReadyTasks,
  isReady,
} from './lib/mission-dispatcher.ts';
import type { Mission } from './lib/types.ts';

// ── CLI Args ───────────────────────────────────────────────────────────────────

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
      try { args.agentMap = { ...DEFAULT_AGENT_MAP, ...JSON.parse(next) }; } catch (e) { console.warn('[mission-dispatch] agent map parse failed:', e instanceof Error ? e.message : e); }
      i += 1;
    } else if (arg === '--timeout-seconds' && next) {
      const value = Number(next);
      if (Number.isFinite(value) && value >= 1) { args.timeoutSeconds = value; }
      i += 1;
    }
  }
  return args;
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseDispatchCliArgs(argv);
    const mission = requireMission(args);

    const readyTasks = (mission.tasks ?? []).filter(isReady);
    if (readyTasks.length === 0) {
      console.log(`[mission-dispatch] noop | missionId=${mission.missionId} | started=none | running=none | background=none | status=${mission.status} | reason=no READY tasks${args.dryRun ? ' | dry-run' : ''}`);
      return 0;
    }

    const dispatchResult = await dispatchReadyTasks(mission, {
      missionsDir: args.missionsDir,
      autoSpawn: args.autoSpawn,
      agentMap: args.agentMap,
    });

    const updatedMission: Mission = {
      ...mission,
      status: deriveMissionStatus(mission.status, dispatchResult.updatedTasks),
      updatedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
      nextWakeAt: new Date(Date.now() + 30_000).toISOString(),
      tasks: dispatchResult.updatedTasks,
      backgroundProcesses: dispatchResult.backgroundProcesses,
    };

    const summary = buildDispatchSummary(dispatchResult.dispatchResults);
    const eventExtras: Record<string, unknown> = {
      startedTaskIds: dispatchResult.startedTaskIds,
      runningTaskIds: dispatchResult.runningTaskIds,
      backgroundTaskIds: dispatchResult.backgroundTaskIds,
      backgroundProcessCount: dispatchResult.backgroundProcesses.length,
      dispatchSummary: summary,
      dispatchLevelBreakdown: {
        level1: summary.level1Success,
        level2: summary.level2Success,
        level3: summary.level3Fallback,
        failed: summary.failed,
      },
    };

    if (args.autoSpawn && dispatchResult.spawnInstructions.length > 0) {
      eventExtras.spawnInstructions = dispatchResult.spawnInstructions.map((s) => ({
        taskId: s.taskId, agentId: s.agentId, taskType: s.taskType,
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

    console.log(`[mission-dispatch] dispatched | missionId=${mission.missionId} | started=${dispatchResult.startedTaskIds.join(',') || 'none'} | running=${dispatchResult.runningTaskIds.join(',') || 'none'} | background=${dispatchResult.backgroundTaskIds.join(',') || 'none'} | dispatch=L1:${summary.level1Success}/L2:${summary.level2Success}/L3:${summary.level3Fallback}/fail:${summary.failed} | status=${updatedMission.status}`);

    if (args.autoSpawn && dispatchResult.spawnInstructions.length > 0) {
      console.log('');
      console.log('📋 Dispatch 指令：');
      for (const si of dispatchResult.spawnInstructions) {
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
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(`[mission-dispatch] error | ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
