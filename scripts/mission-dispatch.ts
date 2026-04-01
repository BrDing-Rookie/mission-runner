#!/usr/bin/env node

import { pathToFileURL } from 'url';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { buildTaskEnvelope, deriveMissionStatus, nowIso, parseMissionCliArgs, requireMission } from './lib/mission-helpers.ts';
import { dispatchTaskToAgent, type DispatchResult, type DispatchSummary } from './lib/mission-dispatch-agent.ts';
import type { BackgroundProcess, Mission, Task } from './lib/types.ts';

// --- Agent Map (task type → default agent) ---

const DEFAULT_AGENT_MAP: Record<string, string> = {
  research: 'codex',
  analysis: 'claude-code',
  code: 'codex',
  document: 'claude-code',
  review: 'rd-review',
  test: 'codex',
  verification: 'rd-review',
};

// --- CLI Args ---

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

// --- Spawn instruction (for autoSpawn mode) ---

interface SpawnInstruction {
  taskId: string;
  agentId: string;
  taskType: string;
  envelope: string;
}

// --- Helpers ---

function isReady(task: Task): boolean {
  return task.status === 'READY';
}

function isBackgroundCandidate(task: Task): boolean {
  return ['code', 'test', 'deploy', 'external_wait'].includes(task.type);
}

/**
 * 检查任务是否需要走 agent 派发路径。
 * 有 agent 分配的任务走三级回退派发，无 agent 的任务走原有的 background/running 逻辑。
 */
function needsAgentDispatch(task: Task): boolean {
  return !!(task.agent ?? task.config?.agentId);
}

/**
 * 将 DispatchResult 应用到 Task 上，更新 config 和 sessionKey。
 */
function applyDispatchResult(task: Task, result: DispatchResult): Task {
  const updatedConfig = {
    ...(task.config ?? {}),
    dispatchLevel: result.dispatchLevel,
    dispatchedAt: result.timestamp,
    dispatchSuccess: result.success,
  };
  if (result.error) {
    updatedConfig.dispatchError = result.error;
  }

  return {
    ...task,
    sessionKey: result.sessionKey ?? task.sessionKey,
    config: updatedConfig,
  };
}

/**
 * 从派发结果列表构建摘要。
 */
function buildDispatchSummary(results: DispatchResult[]): DispatchSummary {
  const summary: DispatchSummary = {
    totalReady: results.length,
    level1Success: 0,
    level2Success: 0,
    level3Fallback: 0,
    failed: 0,
    results,
  };

  for (const r of results) {
    if (!r.success) {
      summary.failed++;
      continue;
    }
    switch (r.dispatchLevel) {
      case 1: summary.level1Success++; break;
      case 2: summary.level2Success++; break;
      case 3: summary.level3Fallback++; break;
    }
  }

  return summary;
}

// --- Main ---

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
    const runningTaskIds: string[] = [];
    const backgroundTaskIds: string[] = [];
    const startedTaskIds: string[] = [];
    const failedDispatchTaskIds: string[] = [];
    const backgroundProcesses: BackgroundProcess[] = [...(mission.backgroundProcesses ?? [])];

    // 派发结果收集
    const dispatchResults: DispatchResult[] = [];
    const spawnInstructions: SpawnInstruction[] = [];

    const updatedTasks: Task[] = (mission.tasks ?? []).map((task): Task => {
      if (!isReady(task)) {
        return task;
      }

      // Build spawn instruction for auto-spawn mode (public-deliverables feature)
      if (args.autoSpawn) {
        const agentId = args.agentMap[task.type] ?? task.agent ?? task.type;
        const envelope = buildTaskEnvelope(task, mission, agentId);
        spawnInstructions.push({ taskId: task.taskId, agentId, taskType: task.type, envelope });
      }

      // 有 agent 分配的任务 → 走三级回退派发策略 (extensions feature)
      if (needsAgentDispatch(task)) {
        // 幂等保护：已有 sessionKey 的任务直接标记 RUNNING
        if (task.sessionKey) {
          runningTaskIds.push(task.taskId);
          startedTaskIds.push(task.taskId);
          return {
            ...task,
            status: 'RUNNING',
            startedAt: timestamp,
          };
        }

        const result = dispatchTaskToAgent(task, mission, args.missionsDir);
        dispatchResults.push(result);

        const updatedTask = applyDispatchResult(task, result);

        if (result.success) {
          runningTaskIds.push(task.taskId);
          startedTaskIds.push(task.taskId);
          return {
            ...updatedTask,
            status: 'RUNNING',
            startedAt: timestamp,
          };
        }

        // 派发全部失败，任务保持 READY 等待重试
        failedDispatchTaskIds.push(task.taskId);
        console.error(`[mission-dispatch] dispatch failed, task remains READY | taskId=${task.taskId}`);
        return {
          ...updatedTask,
          lastError: result.error,
          status: 'READY',
        };
      }

      // 无 agent 分配的任务 → 走原有的 background/running 逻辑
      if (isBackgroundCandidate(task)) {
        const processId = `bg-${mission.missionId}-${task.taskId}`;
        backgroundTaskIds.push(task.taskId);
        startedTaskIds.push(task.taskId);
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
          agent: args.autoSpawn ? (args.agentMap[task.type] ?? task.agent) : task.agent,
          backgroundProcessId: processId,
        };
      }

      runningTaskIds.push(task.taskId);
      startedTaskIds.push(task.taskId);
      return {
        ...task,
        status: 'RUNNING',
        startedAt: timestamp,
        agent: args.autoSpawn ? (args.agentMap[task.type] ?? task.agent) : task.agent,
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

    // 构建派发摘要
    const summary = buildDispatchSummary(dispatchResults);

    const eventExtras: Record<string, unknown> = {
      startedTaskIds,
      runningTaskIds,
      backgroundTaskIds,
      backgroundProcessCount: backgroundProcesses.length,
      dispatchSummary: summary,
      dispatchLevelBreakdown: {
        level1: summary.level1Success,
        level2: summary.level2Success,
        level3: summary.level3Fallback,
        failed: summary.failed,
      },
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

    console.log(`[mission-dispatch] dispatched | missionId=${mission.missionId} | started=${startedTaskIds.join(',') || 'none'} | running=${runningTaskIds.join(',') || 'none'} | background=${backgroundTaskIds.join(',') || 'none'} | dispatch=L1:${summary.level1Success}/L2:${summary.level2Success}/L3:${summary.level3Fallback}/fail:${summary.failed} | status=${updatedMission.status}`);

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
