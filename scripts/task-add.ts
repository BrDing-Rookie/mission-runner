#!/usr/bin/env node

/**
 * task-add.ts — 动态追加 task 到运行中的 mission
 *
 * 在 mission 运行过程中（RUNNING/ITERATING/WAITING_* 等非终态），
 * 允许动态追加新的 task 到 tasks 数组中。
 *
 * 用法：
 *   npm run task-add -- --mission-id <id> --task-id <taskId> --title "任务标题"
 *   npm run task-add -- --mission-id <id> --task-id <taskId> --title "标题" --type research --depends-on T1-api,T2-sdk
 *   npm run task-add -- --mission-id <id> --task-id <taskId> --title "标题" --agent agent-1 --agent-mention-tag "@Agent1"
 */

import { pathToFileURL } from 'url';
import { commitMissionUpdate } from './lib/mission-commit.ts';
import { nowIso, requireMission } from './lib/mission-helpers.ts';
import { isTransitionAllowed } from './lib/types.ts';
import type { Mission, MissionStatus, Task, TaskStatus, TaskType } from './lib/types.ts';

// ==================== CLI Arg Parsing ====================

interface TaskAddCliArgs {
  missionsDir: string;
  missionId: string;
  taskId: string;
  title: string;
  type: TaskType;
  dependsOn: string[];
  agent: string | null;
  agentMentionTag: string | null;
  agentName: string | null;
  dryRun: boolean;
}

const ALLOWED_MISSION_STATUSES = new Set<MissionStatus>([
  'RUNNING',
  'ITERATING',
  'WAITING_BACKGROUND',
  'WAITING_EXTERNAL',
  'PLANNED',
  'VERIFYING',
]);

function parseTaskAddArgs(argv: string[]): TaskAddCliArgs {
  const args: TaskAddCliArgs = {
    missionsDir: './missions',
    missionId: '',
    taskId: '',
    title: '',
    type: 'analysis',
    dependsOn: [],
    agent: null,
    agentMentionTag: null,
    agentName: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--missions-dir' && next) { args.missionsDir = next; i += 1; }
    else if (arg === '--mission-id' && next) { args.missionId = next; i += 1; }
    else if (arg === '--task-id' && next) { args.taskId = next; i += 1; }
    else if (arg === '--title' && next) { args.title = next; i += 1; }
    else if (arg === '--type' && next) { args.type = next as TaskType; i += 1; }
    else if (arg === '--depends-on' && next) { args.dependsOn = next.split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (arg === '--agent' && next) { args.agent = next; i += 1; }
    else if (arg === '--agent-mention-tag' && next) { args.agentMentionTag = next; i += 1; }
    else if (arg === '--agent-name' && next) { args.agentName = next; i += 1; }
    else if (arg === '--dry-run') { args.dryRun = true; }
  }

  return args;
}

function validateArgs(args: TaskAddCliArgs): void {
  if (!args.missionId.trim()) throw new Error('Missing required --mission-id');
  if (!args.taskId.trim()) throw new Error('Missing required --task-id');
  if (!args.title.trim()) throw new Error('Missing required --title');
}

// ==================== Core Logic ====================

export interface TaskAddResult {
  missionId: string;
  taskId: string;
  title: string;
  type: TaskType;
  dependsOn: string[];
  status: TaskStatus;
  missionStatus: MissionStatus;
  changed: boolean;
  dryRun: boolean;
}

export function addTask(args: TaskAddCliArgs): TaskAddResult {
  const mission = requireMission(args);
  const tasks = mission.tasks ?? [];

  // Validate mission status: must be in allowed active statuses
  if (!ALLOWED_MISSION_STATUSES.has(mission.status)) {
    throw new Error(
      `Cannot add task to mission in status "${mission.status}": ` +
      `must be one of ${[...ALLOWED_MISSION_STATUSES].join(', ')}`
    );
  }

  // Validate taskId uniqueness
  if (tasks.some((t) => t.taskId === args.taskId)) {
    throw new Error(`Task ID already exists: ${args.taskId} in mission ${args.missionId}`);
  }

  // Validate dependsOn references
  const existingTaskIds = new Set(tasks.map((t) => t.taskId));
  for (const depId of args.dependsOn) {
    if (!existingTaskIds.has(depId)) {
      throw new Error(`Dependency task not found: ${depId} (referenced in --depends-on)`);
    }
  }

  // Determine initial status based on dependencies
  const DEPENDENCY_DONE_STATUSES: Set<TaskStatus> = new Set(['COMPLETED', 'SKIPPED']);
  const taskMap = new Map(tasks.map((t) => [t.taskId, t]));

  let initialStatus: TaskStatus;
  if (args.dependsOn.length === 0) {
    initialStatus = 'READY';
  } else {
    const allDependenciesDone = args.dependsOn.every((depId) => {
      const dep = taskMap.get(depId);
      return dep && DEPENDENCY_DONE_STATUSES.has(dep.status);
    });
    initialStatus = allDependenciesDone ? 'READY' : 'PENDING';
  }

  const timestamp = nowIso();

  // Build new Task object
  const config: Record<string, unknown> = {};
  if (args.agentMentionTag) config.agentMentionTag = args.agentMentionTag;
  if (args.agentName) config.agentName = args.agentName;

  const newTask: Task = {
    taskId: args.taskId,
    title: args.title,
    type: args.type,
    status: initialStatus,
    agent: args.agent,
    dependsOn: args.dependsOn.length > 0 ? args.dependsOn : [],
    createdAt: timestamp,
    startedAt: null,
    endedAt: null,
    resultSummary: null,
    artifacts: [],
    retryCount: 0,
    maxRetries: 2,
    lastError: null,
    backgroundProcessId: null,
    config: Object.keys(config).length > 0 ? config : {},
  };

  const updatedTasks = [...tasks, newTask];

  // If mission is VERIFYING, auto-revert to RUNNING to allow the new task to be dispatched
  let newMissionStatus: MissionStatus = mission.status;
  if (mission.status === 'VERIFYING' && isTransitionAllowed('VERIFYING', 'RUNNING')) {
    newMissionStatus = 'RUNNING';
  }

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
      source: 'task_added',
      eventExtras: {
        taskId: args.taskId,
        title: args.title,
        taskType: args.type,
        dependsOn: args.dependsOn,
        status: initialStatus,
        missionStatusReverted: mission.status !== newMissionStatus ? `${mission.status}→${newMissionStatus}` : undefined,
      },
    });

    if (!commitOk) {
      throw new Error(`Failed to persist task addition for missionId=${args.missionId}`);
    }
  }

  return {
    missionId: args.missionId,
    taskId: args.taskId,
    title: args.title,
    type: args.type,
    dependsOn: args.dependsOn,
    status: initialStatus,
    missionStatus: newMissionStatus,
    changed: true,
    dryRun: args.dryRun,
  };
}

// ==================== Main ====================

export function main(): number {
  try {
    const args = parseTaskAddArgs(process.argv.slice(2));
    validateArgs(args);
    const result = addTask(args);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[task-add] error |', msg);
    return 1;
  }
}

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  process.exitCode = main();
}
