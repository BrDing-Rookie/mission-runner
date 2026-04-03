/**
 * mission-dispatcher.ts — Task dispatch helpers
 *
 * Extracted from mission-dispatch.ts: dispatch helpers, task readiness checks,
 * dispatch result application, summary building, and agent mapping defaults.
 */

import { dispatchTaskToAgent, type DispatchResult, type DispatchSummary } from './mission-dispatch-agent.ts';
import { buildTaskEnvelope } from './mission-helpers.ts';
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

// ── Dispatch Retry Helpers ─────────────────────────────────────────────────────

export const MAX_DISPATCH_RETRIES = 3;
const BASE_BACKOFF_MS = 30_000; // 30s base, doubled each retry

function getDispatchRetryCount(task: Task): number {
  return (task.config?.dispatchRetryCount as number | undefined) ?? 0;
}

function isDispatchCoolingDown(task: Task, nowMs: number): boolean {
  const retryCount = getDispatchRetryCount(task);
  if (retryCount === 0) return false;
  const lastAttempt = task.config?.lastDispatchAttempt;
  if (typeof lastAttempt !== 'string') return false;
  const lastAttemptMs = Date.parse(lastAttempt);
  if (Number.isNaN(lastAttemptMs)) return false;
  const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount - 1);
  return (nowMs - lastAttemptMs) < backoffMs;
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

    // Agent dispatch path takes priority — no spawnInstruction when agent dispatch is used
    if (needsAgentDispatch(task)) {
      if (task.sessionKey) {
        runningTaskIds.push(task.taskId);
        startedTaskIds.push(task.taskId);
        return { ...task, status: 'RUNNING', startedAt: timestamp };
      }

      const nowMs = Date.now();
      const dispatchRetryCount = getDispatchRetryCount(task);

      // Max retries exceeded → fail the task permanently
      if (dispatchRetryCount >= MAX_DISPATCH_RETRIES) {
        failedDispatchTaskIds.push(task.taskId);
        console.error(`[mission-dispatch] max dispatch retries (${MAX_DISPATCH_RETRIES}) exceeded, marking FAILED | taskId=${task.taskId}`);
        return {
          ...task,
          status: 'FAILED',
          lastError: `Dispatch failed after ${MAX_DISPATCH_RETRIES} attempts: ${task.lastError ?? 'no error details'}`,
        };
      }

      // Cooldown check → skip this watchdog cycle
      if (isDispatchCoolingDown(task, nowMs)) {
        const backoffMs = BASE_BACKOFF_MS * Math.pow(2, dispatchRetryCount - 1);
        console.log(`[mission-dispatch] task in dispatch cooldown, skipping | taskId=${task.taskId} retryCount=${dispatchRetryCount} backoffMs=${backoffMs}`);
        return task;
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
      console.error(`[mission-dispatch] dispatch failed, task remains READY | taskId=${task.taskId} retryCount=${dispatchRetryCount + 1}`);
      return {
        ...updatedTask,
        lastError: result.error,
        status: 'READY',
        config: {
          ...(updatedTask.config ?? {}),
          dispatchRetryCount: dispatchRetryCount + 1,
          lastDispatchAttempt: timestamp,
        },
      };
    }

    // Build spawn instruction for auto-spawn mode (only when not agent-dispatched)
    if (options.autoSpawn) {
      const agentId = options.agentMap[task.type] ?? task.agent ?? task.type;
      const envelope = buildTaskEnvelope(task, mission, agentId);
      spawnInstructions.push({ taskId: task.taskId, agentId, taskType: task.type, envelope });
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
