/**
 * mission-dispatcher.ts — Task dispatch helpers
 *
 * Extracted from mission-dispatch.ts: dispatch helpers, task readiness checks,
 * dispatch result application, summary building, and agent mapping defaults.
 */

import { dispatchTaskToAgent, type DispatchResult, type DispatchSummary } from './mission-dispatch-agent.ts';
import { buildTaskEnvelope, deriveMissionStatus } from './mission-helpers.ts';
import type { BackgroundProcess, Mission, Task } from './types.ts';

// ── Agent Map ──────────────────────────────────────────────────────────────────

export const DEFAULT_AGENT_MAP: Record<string, string> = {
  research: 'codex',
  analysis: 'claude-code',
  code: 'codex',
  document: 'claude-code',
  review: 'rd-review',
  test: 'codex',
  verification: 'rd-review',
};

// ── Spawn Instruction ──────────────────────────────────────────────────────────

export interface SpawnInstruction {
  taskId: string;
  agentId: string;
  taskType: string;
  envelope: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function isReady(task: Task): boolean {
  return task.status === 'READY';
}

export function isBackgroundCandidate(task: Task): boolean {
  return ['code', 'test', 'deploy', 'external_wait'].includes(task.type);
}

export function needsAgentDispatch(task: Task): boolean {
  return !!(task.agent ?? task.config?.agentId);
}

export function applyDispatchResult(task: Task, result: DispatchResult): Task {
  const updatedConfig: Record<string, unknown> = {
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

export function buildDispatchSummary(results: DispatchResult[]): DispatchSummary {
  const summary: DispatchSummary = {
    totalReady: results.length,
    level1Success: 0,
    level2Success: 0,
    level3Fallback: 0,
    failed: 0,
    results,
  };

  for (const r of results) {
    if (!r.success) { summary.failed++; continue; }
    switch (r.dispatchLevel) {
      case 1: summary.level1Success++; break;
      case 2: summary.level2Success++; break;
      case 3: summary.level3Fallback++; break;
    }
  }

  return summary;
}

// ── Core Dispatch Logic ────────────────────────────────────────────────────────

export interface DispatchOptions {
  missionsDir: string;
  autoSpawn: boolean;
  agentMap: Record<string, string>;
}

export interface DispatchTasksResult {
  updatedTasks: Task[];
  startedTaskIds: string[];
  runningTaskIds: string[];
  backgroundTaskIds: string[];
  failedDispatchTaskIds: string[];
  backgroundProcesses: BackgroundProcess[];
  dispatchResults: DispatchResult[];
  spawnInstructions: SpawnInstruction[];
}

export function dispatchReadyTasks(
  mission: Mission,
  options: DispatchOptions,
): DispatchTasksResult {
  const timestamp = new Date().toISOString();
  const runningTaskIds: string[] = [];
  const backgroundTaskIds: string[] = [];
  const startedTaskIds: string[] = [];
  const failedDispatchTaskIds: string[] = [];
  const backgroundProcesses: BackgroundProcess[] = [...(mission.backgroundProcesses ?? [])];
  const dispatchResults: DispatchResult[] = [];
  const spawnInstructions: SpawnInstruction[] = [];

  const updatedTasks: Task[] = (mission.tasks ?? []).map((task): Task => {
    if (!isReady(task)) return task;

    // Build spawn instruction for auto-spawn mode
    if (options.autoSpawn) {
      const agentId = options.agentMap[task.type] ?? task.agent ?? task.type;
      const envelope = buildTaskEnvelope(task, mission, agentId);
      spawnInstructions.push({ taskId: task.taskId, agentId, taskType: task.type, envelope });
    }

    // Agent dispatch path
    if (needsAgentDispatch(task)) {
      if (task.sessionKey) {
        runningTaskIds.push(task.taskId);
        startedTaskIds.push(task.taskId);
        return { ...task, status: 'RUNNING', startedAt: timestamp };
      }

      const result = dispatchTaskToAgent(task, mission, options.missionsDir);
      dispatchResults.push(result);
      const updatedTask = applyDispatchResult(task, result);

      if (result.success) {
        runningTaskIds.push(task.taskId);
        startedTaskIds.push(task.taskId);
        return { ...updatedTask, status: 'RUNNING', startedAt: timestamp };
      }

      failedDispatchTaskIds.push(task.taskId);
      console.error(`[mission-dispatch] dispatch failed, task remains READY | taskId=${task.taskId}`);
      return { ...updatedTask, lastError: result.error, status: 'READY' };
    }

    // Background candidate path
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
        agent: options.autoSpawn ? (options.agentMap[task.type] ?? task.agent) : task.agent,
        backgroundProcessId: processId,
      };
    }

    // Default: mark RUNNING
    runningTaskIds.push(task.taskId);
    startedTaskIds.push(task.taskId);
    return {
      ...task,
      status: 'RUNNING',
      startedAt: timestamp,
      agent: options.autoSpawn ? (options.agentMap[task.type] ?? task.agent) : task.agent,
    };
  });

  return {
    updatedTasks,
    startedTaskIds,
    runningTaskIds,
    backgroundTaskIds,
    failedDispatchTaskIds,
    backgroundProcesses,
    dispatchResults,
    spawnInstructions,
  };
}
