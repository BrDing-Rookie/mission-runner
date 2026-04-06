#!/usr/bin/env node

/**
 * task-update.ts — 执行者主动汇报任务状态
 *
 * 供子 Agent 在完成/失败时调用，更新 mission.json 中自己的 task 状态，
 * 写入 resultSummary、endedAt、artifacts，并联动推导 mission 整体状态。
 *
 * 用法：
 *   npm run task-update -- --mission-id <id> --task-id <taskId> --status COMPLETED --summary "结论"
 *   npm run task-update -- --mission-id <id> --task-id <taskId> --status FAILED --summary "原因"
 *   npm run task-update -- --mission-id <id> --task-id <taskId> --status COMPLETED --summary "结论" --artifact path/to/file.md
 */

import { pathToFileURL } from 'url';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { aggregateUsage, deriveMissionStatus, nowIso, requireMission } from './lib/mission-helpers.ts';
import type { Mission, Task, TaskStatus } from './lib/types.ts';

// ==================== CLI Arg Parsing ====================

interface TaskUpdateCliArgs {
  missionsDir: string;
  missionId: string;
  taskId: string;
  status: TaskStatus;
  summary: string;
  artifacts: string[];
  dryRun: boolean;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  approve?: boolean;
  reject?: boolean;
  approvalNote?: string;
}

const ALLOWED_REPORT_STATUSES = new Set<TaskStatus>(['COMPLETED', 'FAILED']);
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(['COMPLETED', 'FAILED', 'SKIPPED']);

function parseTaskUpdateArgs(argv: string[]): TaskUpdateCliArgs {
  const args: TaskUpdateCliArgs = {
    missionsDir: './missions',
    missionId: '',
    taskId: '',
    status: 'COMPLETED',
    summary: '',
    artifacts: [],
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--missions-dir' && next) { args.missionsDir = next; i += 1; }
    else if (arg === '--mission-id' && next) { args.missionId = next; i += 1; }
    else if (arg === '--task-id' && next) { args.taskId = next; i += 1; }
    else if (arg === '--status' && next) { args.status = next as TaskStatus; i += 1; }
    else if (arg === '--summary' && next) { args.summary = next; i += 1; }
    else if (arg === '--artifact' && next) { args.artifacts.push(next); i += 1; }
    else if (arg === '--dry-run') { args.dryRun = true; }
    else if (arg === '--input-tokens' && next) { const n = parseInt(next, 10); if (Number.isNaN(n)) throw new Error(`--input-tokens must be a number, got "${next}"`); args.inputTokens = n; i += 1; }
    else if (arg === '--output-tokens' && next) { const n = parseInt(next, 10); if (Number.isNaN(n)) throw new Error(`--output-tokens must be a number, got "${next}"`); args.outputTokens = n; i += 1; }
    else if (arg === '--model' && next) { args.model = next; i += 1; }
    else if (arg === '--approve') { args.approve = true; }
    else if (arg === '--reject') { args.reject = true; }
    else if (arg === '--approval-note' && next) { args.approvalNote = next; i += 1; }
  }

  return args;
}

function validateArgs(args: TaskUpdateCliArgs): void {
  if (!args.missionId.trim()) throw new Error('Missing required --mission-id');
  if (!args.taskId.trim()) throw new Error('Missing required --task-id');
  if (args.approve && args.reject) {
    throw new Error('Cannot specify both --approve and --reject');
  }
  if (!args.approve && !args.reject) {
    if (!ALLOWED_REPORT_STATUSES.has(args.status)) {
      throw new Error(`Invalid --status "${args.status}": must be one of ${[...ALLOWED_REPORT_STATUSES].join(', ')}`);
    }
  }
}

// ==================== Core Logic ====================

export interface TaskUpdateResult {
  missionId: string;
  taskId: string;
  taskStatusFrom: TaskStatus;
  taskStatusTo: TaskStatus;
  missionStatusFrom: Mission['status'];
  missionStatusTo: Mission['status'];
  changed: boolean;
  dryRun: boolean;
}

export function updateTask(args: TaskUpdateCliArgs): TaskUpdateResult {
  const mission = requireMission(args);
  const tasks = mission.tasks ?? [];
  const taskIndex = tasks.findIndex((t) => t.taskId === args.taskId);

  if (taskIndex === -1) {
    throw new Error(`Task not found: ${args.taskId} in mission ${args.missionId}`);
  }

  const task = tasks[taskIndex];

  // Approval path: --approve or --reject (before terminal/idempotency checks for status)
  if (args.approve || args.reject) {
    // Idempotency: already approved/rejected → noop
    if (args.approve && task.approvalStatus === 'APPROVED') {
      console.log(`[task-update] noop | missionId=${args.missionId} | taskId=${args.taskId} | reason=already APPROVED`);
      return {
        missionId: args.missionId,
        taskId: args.taskId,
        taskStatusFrom: task.status,
        taskStatusTo: task.status,
        missionStatusFrom: mission.status,
        missionStatusTo: mission.status,
        changed: false,
        dryRun: args.dryRun,
      };
    }
    if (args.reject && task.approvalStatus === 'REJECTED') {
      console.log(`[task-update] noop | missionId=${args.missionId} | taskId=${args.taskId} | reason=already REJECTED`);
      return {
        missionId: args.missionId,
        taskId: args.taskId,
        taskStatusFrom: task.status,
        taskStatusTo: task.status,
        missionStatusFrom: mission.status,
        missionStatusTo: mission.status,
        changed: false,
        dryRun: args.dryRun,
      };
    }

    const timestamp = nowIso();
    const approved = args.approve === true;
    const updatedTask: Task = {
      ...task,
      approvalStatus: approved ? 'APPROVED' : 'REJECTED',
      approvalNote: args.approvalNote ?? null,
      ...(approved ? {} : { status: 'SKIPPED' as TaskStatus }),
    };

    const updatedTasks = [...tasks];
    updatedTasks[taskIndex] = updatedTask;

    const newMissionStatus = deriveMissionStatus(mission.status, updatedTasks);

    const updatedMission: Mission = {
      ...mission,
      status: newMissionStatus,
      tasks: updatedTasks,
      updatedAt: timestamp,
      lastProgressAt: timestamp,
    };

    if (!args.dryRun) {
      const commitOk = commitMissionUpdate({
        missionsDir: args.missionsDir,
        oldMission: mission,
        newMission: updatedMission,
        dryRun: args.dryRun,
        source: 'task_approval_updated',
        eventExtras: {
          taskId: args.taskId,
          approvalStatus: updatedTask.approvalStatus,
          approvalNote: updatedTask.approvalNote ?? null,
          statusFrom: task.status,
          statusTo: updatedTask.status,
          missionStatusFrom: mission.status,
          missionStatusTo: newMissionStatus,
          reporter: 'human',
        },
      });

      if (!commitOk) {
        throw new Error(`Failed to persist approval update for missionId=${args.missionId}`);
      }
    }

    return {
      missionId: args.missionId,
      taskId: args.taskId,
      taskStatusFrom: task.status,
      taskStatusTo: updatedTask.status,
      missionStatusFrom: mission.status,
      missionStatusTo: newMissionStatus,
      changed: true,
      dryRun: args.dryRun,
    };
  }

  // Normal status update path: idempotency + terminal checks
  if (task.status === args.status) {
    console.log(`[task-update] noop | missionId=${args.missionId} | taskId=${args.taskId} | reason=already ${args.status}`);
    return {
      missionId: args.missionId,
      taskId: args.taskId,
      taskStatusFrom: task.status,
      taskStatusTo: args.status,
      missionStatusFrom: mission.status,
      missionStatusTo: mission.status,
      changed: false,
      dryRun: args.dryRun,
    };
  }

  // Don't allow updating terminal tasks
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    console.log(`[task-update] noop | missionId=${args.missionId} | taskId=${args.taskId} | reason=task already terminal (${task.status})`);
    return {
      missionId: args.missionId,
      taskId: args.taskId,
      taskStatusFrom: task.status,
      taskStatusTo: task.status,
      missionStatusFrom: mission.status,
      missionStatusTo: mission.status,
      changed: false,
      dryRun: args.dryRun,
    };
  }

  const timestamp = nowIso();

  // Update task
  const updatedTask: Task = {
    ...task,
    status: args.status,
    endedAt: timestamp,
    resultSummary: args.summary || task.resultSummary,
    artifacts: [
      ...(task.artifacts ?? []),
      ...args.artifacts.map((path) => ({ path, type: 'document', description: 'Agent-reported artifact' })),
    ],
  };

  if (args.inputTokens !== undefined || args.outputTokens !== undefined || args.model !== undefined) {
    const inputTokens = args.inputTokens;
    const outputTokens = args.outputTokens;
    updatedTask.usage = {
      inputTokens,
      outputTokens,
      totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      model: args.model,
      calls: 1,
    };
  }

  const updatedTasks = [...tasks];
  updatedTasks[taskIndex] = updatedTask;

  // 联动解锁：当 task 完成时，检查下游 PENDING tasks 的依赖是否满足
  const DEPENDENCY_DONE_STATUSES: Set<TaskStatus> = new Set(['COMPLETED', 'SKIPPED']);
  const unlockedTaskIds: string[] = [];

  if (DEPENDENCY_DONE_STATUSES.has(args.status)) {
    const taskMap = new Map(updatedTasks.map(t => [t.taskId, t]));
    for (let i = 0; i < updatedTasks.length; i++) {
      const t = updatedTasks[i];
      if (t.status !== 'PENDING') continue;
      const deps = t.dependsOn ?? [];
      const allSatisfied = deps.every(depId => {
        const dep = taskMap.get(depId);
        return dep && DEPENDENCY_DONE_STATUSES.has(dep.status);
      });
      if (allSatisfied) {
        updatedTasks[i] = { ...t, status: 'READY' as TaskStatus };
        taskMap.set(t.taskId, updatedTasks[i]);
        unlockedTaskIds.push(t.taskId);
      }
    }
  }

  // Derive mission status
  const newMissionStatus = deriveMissionStatus(mission.status, updatedTasks);

  const missionWithTasks: Mission = {
    ...mission,
    status: newMissionStatus,
    tasks: updatedTasks,
    updatedAt: timestamp,
    lastProgressAt: timestamp,
  };

  const aggregated = aggregateUsage(missionWithTasks);

  const updatedMission: Mission = {
    ...missionWithTasks,
    ...(aggregated !== undefined ? { totalUsage: aggregated } : {}),
  };

  if (!args.dryRun) {
    const commitOk = commitMissionUpdate({
      missionsDir: args.missionsDir,
      oldMission: mission,
      newMission: updatedMission,
      dryRun: args.dryRun,
      source: 'task_status_updated',
      eventExtras: {
        taskId: args.taskId,
        statusFrom: task.status,
        statusTo: args.status,
        missionStatusFrom: mission.status,
        missionStatusTo: newMissionStatus,
        summary: args.summary || null,
        artifacts: args.artifacts,
        unlockedTaskIds,
        reporter: 'agent',
      },
    });

    if (!commitOk) {
      throw new Error(`Failed to persist task update for missionId=${args.missionId}`);
    }
  }

  return {
    missionId: args.missionId,
    taskId: args.taskId,
    taskStatusFrom: task.status,
    taskStatusTo: args.status,
    missionStatusFrom: mission.status,
    missionStatusTo: newMissionStatus,
    changed: true,
    dryRun: args.dryRun,
  };
}

// ==================== Main ====================

function main(): number {
  try {
    const args = parseTaskUpdateArgs(process.argv.slice(2));
    validateArgs(args);
    const result = updateTask(args);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[task-update] error |', msg);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}
